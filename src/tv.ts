import { getPreferenceValues, LocalStorage } from "@raycast/api";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

type Prefs = { ip: string; mac?: string; token?: string };

const TOKEN_KEY = "tv-token";
const DEVICE_KEY = "tv-device"; // { mac, name } learned from the TV while it is on
const LEGACY_TOKEN_FILE = path.join(os.homedir(), ".samsung_tv_token");
const CLIENT_NAME = Buffer.from("Raycast").toString("base64");

export const prefs = () => getPreferenceValues<Prefs>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- state

/** True when the TV's control port answers, i.e. it is on (or briefly still awake after power-off). */
export function isReachable(timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: prefs().ip, port: 8001 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** "on" | "standby" | "off". Standby means the network is still up for a few seconds after power-off. */
export async function powerState(attempts = 2): Promise<"on" | "standby" | "off"> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://${prefs().ip}:8001/api/v2/`, { signal: AbortSignal.timeout(2000) });
      const json = (await res.json()) as { device?: { PowerState?: string; wifiMac?: string; name?: string } };
      await rememberDevice(json.device);
      return json.device?.PowerState === "on" ? "on" : "standby";
    } catch {
      // a busy TV can drop a single request; only call it off if the port is closed too
      if (!(await isReachable())) return "off";
    }
  }
  return "standby";
}

// ---------------------------------------------------------------- device identity

type DeviceInfo = { mac?: string; name?: string };

async function rememberDevice(device?: { wifiMac?: string; name?: string }) {
  if (!device?.wifiMac && !device?.name) return;
  const next: DeviceInfo = { mac: device.wifiMac, name: device.name };
  const prev = await LocalStorage.getItem<string>(DEVICE_KEY);
  if (prev !== JSON.stringify(next)) await LocalStorage.setItem(DEVICE_KEY, JSON.stringify(next));
}

async function learnedDevice(): Promise<DeviceInfo> {
  const raw = await LocalStorage.getItem<string>(DEVICE_KEY);
  return raw ? (JSON.parse(raw) as DeviceInfo) : {};
}

/** MAC for Wake-on-LAN: the preference if set, otherwise what the TV reported while it was on. */
async function tvMac(): Promise<string> {
  const mac = prefs().mac?.trim() || (await learnedDevice()).mac;
  if (!mac)
    throw new Error("MAC address unknown — turn the TV on once with its remote, or set it in the extension settings");
  return mac;
}

/** The TV's name as AirPlay shows it ("[TV] Living Room" → "Living Room"). */
export async function tvAirPlayName(): Promise<string | undefined> {
  const name = (await learnedDevice()).name;
  return name?.replace(/^\[TV\]\s*/, "").trim() || undefined;
}

// ---------------------------------------------------------------- power

export async function sendWakeOnLan(): Promise<void> {
  const mac = Buffer.from((await tvMac()).replace(/[:-]/g, ""), "hex");
  if (mac.length !== 6) throw new Error("Invalid MAC address in the extension settings");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
  const subnetBroadcast = prefs().ip.replace(/\.\d+$/, ".255");

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      const targets = ["255.255.255.255", subnetBroadcast];
      let pending = targets.length * 3;
      for (let i = 0; i < 3; i++)
        for (const t of targets)
          sock.send(packet, 9, t, () => {
            if (--pending === 0) {
              sock.close();
              resolve();
            }
          });
    });
  });
}

export async function turnOn(waitSeconds = 20): Promise<boolean> {
  const state = await powerState();
  if (state === "on") return true;
  // Just switched off: the network is still up for ~20 s and a remote key wakes it instantly.
  if (state === "standby") await sendKeys(["KEY_POWER"]).catch(() => undefined);
  await sendWakeOnLan();
  for (let i = 0; i < waitSeconds * 2; i++) {
    await sleep(500);
    if ((await powerState()) === "on") return true;
    if (i % 6 === 5) await sendWakeOnLan();
  }
  return false;
}

export async function turnOff(waitSeconds = 25): Promise<boolean> {
  if ((await powerState()) !== "on") return true;
  await sendKeys(["KEY_POWER"]);
  let notOn = 0;
  let retried = false;
  for (let i = 0; i < waitSeconds * 2; i++) {
    await sleep(500);
    if ((await powerState()) !== "on") {
      if (++notOn >= 2) return true; // two consecutive readings, so a glitch can't fake success
    } else {
      notOn = 0;
      // still fully on after ~6 s: the key was swallowed (e.g. by an overlay), send it once more
      if (i >= 12 && !retried) {
        retried = true;
        await sendKeys(["KEY_POWER"]);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- remote keys (wss:8002)

async function loadToken(): Promise<string | undefined> {
  const fromPrefs = prefs().token?.trim();
  if (fromPrefs) return fromPrefs;
  const stored = await LocalStorage.getItem<string>(TOKEN_KEY);
  if (stored) return stored;
  try {
    return fs.readFileSync(LEGACY_TOKEN_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens the authenticated remote-control channel. Without a token the TV shows an
 * "Allow" prompt on screen; the token it returns is saved for next time.
 */
async function openRemote(): Promise<WebSocket> {
  const token = await loadToken();
  const url =
    `wss://${prefs().ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}` +
    (token ? `&token=${token}` : "");
  const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 6000 });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        ws.terminate();
        reject(new Error(token ? "TV did not respond" : "Approve the connection on the TV and try again"));
      },
      token ? 8000 : 45000,
    );
    ws.on("message", async (raw) => {
      let msg: { event?: string; data?: { token?: string } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.event === "ms.channel.connect") {
        clearTimeout(timer);
        if (msg.data?.token && msg.data.token !== token) await LocalStorage.setItem(TOKEN_KEY, msg.data.token);
        resolve(ws);
      } else if (msg.event === "ms.channel.unauthorized") {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error("TV denied access — allow it under Device Connection Manager"));
      }
    });
    // Tizen sends malformed close frames; ws reports them as errors. Only fail before we're connected.
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function sendKeys(keys: string[], delayMs = 400): Promise<void> {
  const ws = await openRemote();
  try {
    for (const key of keys) {
      ws.send(
        JSON.stringify({
          method: "ms.remote.control",
          params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" },
        }),
      );
      await sleep(delayMs);
    }
    await sleep(300);
  } finally {
    ws.removeAllListeners("error");
    ws.on("error", () => undefined);
    ws.terminate();
  }
}

// ---------------------------------------------------------------- apps (REST :8001)

export type TvApp = { id: string; name: string; running: boolean; visible: boolean; version?: string };

/**
 * Samsung removed the "list installed apps" call on 2020+ firmware, so we probe known IDs.
 * Several apps have different IDs per Tizen year; whichever answers is installed.
 * Source: community lists (homebridge-samsung-tizen, samsung-tv-ws-api).
 */
export const KNOWN_APP_IDS: string[] = [
  // video
  "3201907018807", "11101200001", // Netflix
  "111299001912", "9Ur5IzDKqV.TizenYouTube", // YouTube
  "3201611010983", // YouTube Kids
  "3202301029760", "3201601007230", // HBO Max / Max
  "3201910019365", "3201512006785", "org.tizen.primevideo", // Prime Video
  "3202204027038", "3202009021709", "3201901017640", "MCmYXNxgcu.DisneyPlus", // Disney+
  "3202208028071", // SkyShowtime
  "3201807016597", "com.samsung.tv.ariavideo", // Apple TV
  "3201512006963", // Plex
  "3201511006428", // Rakuten TV
  "3201808016802", // Pluto TV
  "3201803015944", // Discovery+
  "3201602007756", // Red Bull TV
  "3201603008746", // NOW TV
  "3201707014489", // Samsung TV Plus / YouTube TV
  "3201702011851", // Steam Link
  "3201908018988", // RTL+
  "3201907018746", // MagentaTV
  "3201502001386", // Joyn
  "3202203026841", // Twitch
  // music
  "3201606009684", // Spotify
  "3201908019041", // Apple Music
  "3201710014874", // Amazon Music
  "3201805016367", // TIDAL
  "3201608010191", // Deezer
  "121299000101", // TuneIn
  // system
  "3201907018784", "3202010022079", "org.tizen.browser", // Internet
  "3201710015037", // Gallery
  "NRi6kdBYJ0.AirPlayWebApp", // Apple AirPlay
  "3201710015016", "3201910019378", // SmartThings
  "3201710015067", // Universal Guide
];

type Probe = { kind: "found"; app: TvApp } | { kind: "missing" } | { kind: "error" };

async function probeOnce(id: string): Promise<Probe> {
  try {
    const res = await fetch(`http://${prefs().ip}:8001/api/v2/applications/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "error" };
    const app = (await res.json()) as TvApp;
    return app?.name ? { kind: "found", app } : { kind: "missing" };
  } catch {
    return { kind: "error" };
  }
}

async function probe(id: string): Promise<Probe> {
  const first = await probeOnce(id);
  return first.kind === "error" ? probeOnce(id) : first;
}

async function probeApp(id: string): Promise<TvApp | undefined> {
  const r = await probe(id);
  return r.kind === "found" ? r.app : undefined;
}

const SEEN_KEY = "seen-apps";

/**
 * Probe known + custom IDs, de-duplicated by display name. Apps found earlier stay listed
 * when the TV is merely slow (timeout), and drop out only on a definite 404.
 */
export async function listInstalledApps(customIds: string[] = []): Promise<TvApp[]> {
  const seen: Record<string, string> = JSON.parse((await LocalStorage.getItem<string>(SEEN_KEY)) ?? "{}");
  const ids = [...new Set([...customIds, ...Object.keys(seen), ...KNOWN_APP_IDS])];

  // The TV's web server drops requests when flooded, so probe with limited concurrency.
  const results: Probe[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      results[i] = await probe(ids[i]);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const found: TvApp[] = [];
  ids.forEach((id, i) => {
    const r = results[i];
    if (r.kind === "found") {
      found.push(r.app);
      seen[id] = r.app.name;
    } else if (r.kind === "missing") {
      delete seen[id];
    } else if (seen[id]) {
      found.push({ id, name: seen[id], running: false, visible: false });
    }
  });
  await LocalStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  const byName = new Map<string, TvApp>();
  for (const app of found) {
    const prev = byName.get(app.name);
    // keep the entry that is running/visible, else the first (newest-ID-first ordering above)
    if (!prev || (app.visible && !prev.visible) || (app.running && !prev.running)) byName.set(app.name, app);
  }
  return [...byName.values()].sort((a, b) => Number(b.visible) - Number(a.visible) || a.name.localeCompare(b.name));
}

export async function launchApp(id: string): Promise<void> {
  if ((await powerState()) !== "on" && !(await turnOn())) throw new Error("TV did not wake up");
  const res = await fetch(`http://${prefs().ip}:8001/api/v2/applications/${encodeURIComponent(id)}`, {
    method: "POST",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Launch failed (HTTP ${res.status})`);
}

export async function closeApp(id: string): Promise<void> {
  const res = await fetch(`http://${prefs().ip}:8001/api/v2/applications/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Close failed (HTTP ${res.status})`);
}

// ---------------------------------------------------------------- custom app IDs

const CUSTOM_KEY = "custom-app-ids";

export async function getCustomIds(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(CUSTOM_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export async function addCustomId(id: string): Promise<void> {
  const ids = new Set(await getCustomIds());
  ids.add(id.trim());
  await LocalStorage.setItem(CUSTOM_KEY, JSON.stringify([...ids]));
}

export { probeApp };
