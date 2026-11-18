import { getPreferenceValues, LocalStorage } from "@raycast/api";
import dgram from "node:dgram";
import net from "node:net";
import WebSocket from "ws";
import { DiscoveredTv, discoverTvs, identify } from "./discovery";

type Prefs = { ip?: string; mac?: string; token?: string };

/** The TV this extension controls. Learned by discovery, refreshed whenever the TV answers. */
export type Tv = { ip: string; id?: string; name?: string; mac?: string; model?: string };

const TV_KEY = "tv";
const CLIENT_NAME = Buffer.from("Raycast").toString("base64");

const prefs = () => getPreferenceValues<Prefs>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- which TV

export async function storedTv(): Promise<Tv | undefined> {
  const raw = await LocalStorage.getItem<string>(TV_KEY);
  return raw ? (JSON.parse(raw) as Tv) : undefined;
}

async function saveTv(tv: Tv) {
  await LocalStorage.setItem(TV_KEY, JSON.stringify(tv));
}

/** Make a discovered TV the active one. Switching to another TV resets per-TV caches. */
export async function selectTv(found: DiscoveredTv): Promise<void> {
  const prev = await storedTv();
  if (prev?.id && prev.id !== found.id) {
    await LocalStorage.removeItem("seen-apps");
  }
  await saveTv({ ip: found.ip, id: found.id, name: found.name, mac: found.mac, model: found.model });
}

export class TvSelectionError extends Error {}

/**
 * IP of the TV to talk to: the preference if set, else the remembered TV, else discovery.
 * One TV found is selected automatically; several require the Select TV command.
 */
export async function tvIp(): Promise<string> {
  const override = prefs().ip?.trim();
  if (override) return override;
  const tv = await storedTv();
  if (tv?.ip) return tv.ip;

  const found = await discoverTvs();
  if (found.length === 1) {
    await selectTv(found[0]);
    return found[0].ip;
  }
  if (found.length === 0)
    throw new TvSelectionError("No Samsung TV found — switch it on and check it is on the same Wi-Fi");
  throw new TvSelectionError(`Found ${found.length} TVs — choose one with the “Select TV” command`);
}

/**
 * The TV may have a new IP after a DHCP renewal. Find it again by its device id or MAC.
 * Returns the new IP, or undefined if it is not on the network (e.g. in deep standby).
 */
async function relocateTv(): Promise<string | undefined> {
  if (prefs().ip?.trim()) return undefined; // fixed by the user
  const tv = await storedTv();
  if (!tv) return undefined;
  const found = await discoverTvs({ scanFallback: true });
  const match = found.find(
    (f) => (tv.id && f.id === tv.id) || (tv.mac && f.mac?.toUpperCase() === tv.mac.toUpperCase()),
  );
  if (!match) return undefined;
  await selectTv(match);
  return match.ip;
}

// ---------------------------------------------------------------- state

/** True when the TV's control port answers, i.e. it is on (or briefly still awake after power-off). */
export async function isReachable(timeoutMs = 700): Promise<boolean> {
  const ip = await tvIp();
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port: 8001 });
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
  const ip = await tvIp();
  for (let i = 0; i < attempts; i++) {
    const info = await identify(ip, 2000);
    if (info) {
      await rememberDevice(info);
      return info.powerState === "on" ? "on" : "standby";
    }
    // a busy TV can drop a single request; only call it off if the port is closed too
    if (!(await isReachable())) return "off";
  }
  return "standby";
}

// ---------------------------------------------------------------- device identity

async function rememberDevice(info: DiscoveredTv) {
  const prev = await storedTv();
  if (prefs().ip?.trim() && prev && prev.ip !== info.ip) return; // don't overwrite a different selected TV
  const next: Tv = {
    ...prev,
    ip: info.ip,
    id: info.id,
    name: info.name,
    mac: info.mac ?? prev?.mac,
    model: info.model,
  };
  if (JSON.stringify(prev) !== JSON.stringify(next)) await saveTv(next);
}

/** MAC for Wake-on-LAN: the preference if set, otherwise what the TV reported while it was on. */
async function tvMac(): Promise<string> {
  const mac = prefs().mac?.trim() || (await storedTv())?.mac;
  if (!mac)
    throw new Error("MAC address unknown — turn the TV on once with its remote, or set it in the extension settings");
  return mac;
}

/** The TV's name as AirPlay shows it ("[TV] Living Room" → "Living Room"). */
export async function tvAirPlayName(): Promise<string | undefined> {
  const name = (await storedTv())?.name;
  return name?.replace(/^\[TV\]\s*/, "").trim() || undefined;
}

// ---------------------------------------------------------------- power

export async function sendWakeOnLan(): Promise<void> {
  const mac = Buffer.from((await tvMac()).replace(/[:-]/g, ""), "hex");
  if (mac.length !== 6) throw new Error("Invalid MAC address in the extension settings");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
  const subnetBroadcast = (await tvIp()).replace(/\.\d+$/, ".255");

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
  let relocated = false;
  for (let i = 0; i < waitSeconds * 2; i++) {
    await sleep(500);
    if ((await powerState()) === "on") return true;
    if (i % 6 === 5) await sendWakeOnLan();
    // woken but silent at the old address after ~10 s: it may have a new IP
    if (i === 20 && !relocated) {
      relocated = true;
      if (await relocateTv()) return (await powerState()) === "on";
    }
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

const tokenKey = async () => `token:${(await storedTv())?.id ?? "default"}`;

async function loadToken(): Promise<string | undefined> {
  const fromPrefs = prefs().token?.trim();
  if (fromPrefs) return fromPrefs;
  const key = await tokenKey();
  const token = await LocalStorage.getItem<string>(key);
  if (token) return token;
  // versions before multi-TV support stored a single token under "tv-token"
  const legacy = await LocalStorage.getItem<string>("tv-token");
  if (legacy) {
    await LocalStorage.setItem(key, legacy);
    await LocalStorage.removeItem("tv-token");
  }
  return legacy;
}

/**
 * Opens the authenticated remote-control channel. Without a token the TV shows an
 * "Allow" prompt on screen; the token it returns is saved for next time.
 */
async function openRemote(): Promise<WebSocket> {
  const ip = await tvIp();
  const token = await loadToken();
  const key = await tokenKey();
  const url =
    `wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}` + (token ? `&token=${token}` : "");
  // The TV uses a self-signed certificate on the local network.
  const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 6000 });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        ws.terminate();
        reject(new Error(token ? "TV did not respond" : "Select Allow on the TV, then try again"));
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
        if (msg.data?.token && msg.data.token !== token) await LocalStorage.setItem(key, msg.data.token);
        resolve(ws);
      } else if (msg.event === "ms.channel.unauthorized") {
        clearTimeout(timer);
        ws.terminate();
        reject(
          new Error(
            "The TV refused the connection — on the TV open Settings → General → External Device Manager → Device Connection Manager and allow Raycast",
          ),
        );
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
// prettier-ignore
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
    const res = await fetch(`http://${await tvIp()}:8001/api/v2/applications/${encodeURIComponent(id)}`, {
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
  const res = await fetch(`http://${await tvIp()}:8001/api/v2/applications/${encodeURIComponent(id)}`, {
    method: "POST",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Launch failed (HTTP ${res.status})`);
}

export async function closeApp(id: string): Promise<void> {
  const res = await fetch(`http://${await tvIp()}:8001/api/v2/applications/${encodeURIComponent(id)}`, {
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
