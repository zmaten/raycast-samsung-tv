import { BrowserExtension, Clipboard, environment, getFrontmostApplication } from "@raycast/api";
import { execFile } from "node:child_process";
import { turnOn, tvIp } from "./tv";

export type YouTubeVideo = { id: string; start?: number; list?: string; url: string };

/** Parses watch, youtu.be, shorts, live, embed and music.youtube.com links. */
export function parseYouTubeUrl(input: string): YouTubeVideo | undefined {
  const match = input.match(/https?:\/\/[^\s"'<>]*(youtube\.com|youtu\.be)[^\s"'<>]*/i);
  if (!match) return undefined;
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com") {
    id = url.searchParams.get("v");
    const path = url.pathname.match(/^\/(shorts|live|embed|v)\/([^/?#]+)/);
    if (!id && path) id = path[2];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return undefined;
  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return { id, start, list: url.searchParams.get("list") ?? undefined, url: url.toString() };
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds */
function parseStart(t: string | null): number | undefined {
  if (!t) return undefined;
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !m[0]) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const CHROMIUM = ["Google Chrome", "Arc", "Brave Browser", "Microsoft Edge", "Vivaldi", "Opera", "Chromium", "Dia"];

function osascript(script: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout) => resolve(err ? undefined : stdout.trim())),
  );
}

/** URL of the active tab in the browser that was frontmost before Raycast opened. */
async function frontBrowserUrl(): Promise<string | undefined> {
  // Raycast browser extension: works for every browser it supports (Chrome, Arc, Safari, Firefox, Zen…)
  if (environment.canAccess(BrowserExtension)) {
    try {
      const tab = (await BrowserExtension.getTabs()).find((t) => t.active);
      if (tab?.url) return tab.url;
    } catch {
      // extension not installed in the current browser
    }
  }
  // AppleScript fallback for Safari and Chromium browsers
  try {
    const app = (await getFrontmostApplication()).name;
    if (app === "Safari" || app === "Safari Technology Preview")
      return await osascript(`tell application "${app}" to return URL of front document`);
    if (CHROMIUM.includes(app))
      return await osascript(`tell application "${app}" to return URL of active tab of front window`);
  } catch {
    // no frontmost app information
  }
  return undefined;
}

export type Found = { video: YouTubeVideo; source: "argument" | "browser" | "clipboard" };

/** Finds a YouTube link: typed argument first, then the front browser tab, then the clipboard. */
export async function findYouTubeLink(argument?: string): Promise<Found | undefined> {
  if (argument?.trim()) {
    const video = parseYouTubeUrl(argument.trim());
    if (!video) throw new Error("That is not a YouTube video link");
    return { video, source: "argument" };
  }
  const tab = await frontBrowserUrl();
  const fromTab = tab ? parseYouTubeUrl(tab) : undefined;
  if (fromTab) return { video: fromTab, source: "browser" };
  const clip = await Clipboard.readText();
  const fromClip = clip ? parseYouTubeUrl(clip) : undefined;
  if (fromClip) return { video: fromClip, source: "clipboard" };
  return undefined;
}

/**
 * Plays a video in the TV's YouTube app via DIAL (port 8080). Samsung only accepts DIAL
 * launches carrying a YouTube origin, as the YouTube phone app sends.
 */
export async function playOnTv(video: YouTubeVideo): Promise<void> {
  if (!(await turnOn())) throw new Error("TV did not wake up");
  const params = new URLSearchParams({ v: video.id });
  if (video.start) params.set("t", String(video.start));
  if (video.list) params.set("list", video.list);

  const endpoint = `http://${await tvIp()}:8080/ws/apps/YouTube`;
  let lastStatus = 0;
  // Right after waking, the DIAL server needs a few seconds before it accepts launches.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Origin: "https://www.youtube.com", "Content-Type": "text/plain; charset=utf-8" },
        body: params.toString(),
        signal: AbortSignal.timeout(8000),
      });
      lastStatus = res.status;
      if (res.status === 201 || res.status === 200) return;
    } catch {
      lastStatus = 0;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    lastStatus ? `The TV refused the video (HTTP ${lastStatus})` : "The TV's YouTube service did not answer",
  );
}
