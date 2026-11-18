import { environment, getPreferenceValues, LocalStorage } from "@raycast/api";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { turnOn, tvAirPlayName } from "./tv";

type Prefs = { airplayName?: string };
type ScriptResult =
  "connected" | "disconnected" | "already-connected" | "already-disconnected" | "not-found" | `error: ${string}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Resolved once per operation by loadName(): the preference, else the name the TV reported.
let resolvedName = "";
const airplayName = () => resolvedName;

async function loadName(): Promise<void> {
  const name = getPreferenceValues<Prefs>().airplayName?.trim() || (await tvAirPlayName());
  if (!name) throw new Error("TV name unknown — turn the TV on once, or set “AirPlay Name” in the extension settings");
  resolvedName = name;
}

const ID_KEY = () => `airplay-id:${airplayName()}`;

/** Look up the TV's AirPlay device id ("deviceid" in its Bonjour TXT record). */
function resolveAirPlayId(timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn("dns-sd", ["-L", airplayName(), "_airplay._tcp", "local"]);
    let buf = "";
    const finish = (id?: string) => {
      clearTimeout(timer);
      proc.kill();
      resolve(id);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/deviceid=([0-9A-Fa-f:]{17})/);
      if (m) finish(m[1].toUpperCase());
    });
    proc.on("error", () => finish(undefined));
  });
}

async function airPlayId(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await LocalStorage.getItem<string>(ID_KEY());
    if (cached) return cached;
  }
  const id = await resolveAirPlayId();
  if (!id) throw new Error(`“${airplayName()}” is not advertising AirPlay — is the TV on and on the same Wi-Fi?`);
  await LocalStorage.setItem(ID_KEY(), id);
  return id;
}

function runScript(deviceId: string, mode: "connect" | "disconnect" | "status"): Promise<ScriptResult> {
  const script = path.join(environment.assetsPath, "airplay-display.applescript");
  return new Promise((resolve, reject) => {
    execFile("osascript", [script, deviceId, mode], { timeout: 45_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim();
        if (/-25211|-1719|-1728|assistive access|not allowed/i.test(msg))
          reject(new Error("Allow Raycast under Privacy & Security → Accessibility, then try again"));
        else reject(new Error(msg));
        return;
      }
      resolve(stdout.trim() as ScriptResult);
    });
  });
}

/** Runs the script; if the device is not offered, refresh the cached AirPlay id and retry. */
async function run(mode: "connect" | "disconnect" | "status", attempts = 1): Promise<ScriptResult> {
  let id = await airPlayId();
  let result: ScriptResult = "not-found";
  for (let i = 0; i < attempts; i++) {
    result = await runScript(id, mode);
    if (result !== "not-found") break;
    id = await airPlayId(true).catch(() => id);
    await sleep(1500);
  }
  if (result.startsWith("error: ")) throw new Error(result.slice(7));
  if (result === "not-found")
    throw new Error(`“${airplayName()}” is not in Screen Mirroring — is the TV on and on the same Wi-Fi?`);
  return result;
}

/** Mirror state of the AirPlay display as macOS reports it, or undefined if it is not attached. */
function airPlayDisplayMirrored(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        type Ndrv = { _name?: string; spdisplays_mirror?: string; spdisplays_connection_type?: string };
        const gpus = JSON.parse(stdout).SPDisplaysDataType as { spdisplays_ndrvs?: Ndrv[] }[];
        const tv = gpus
          .flatMap((g) => g.spdisplays_ndrvs ?? [])
          .find((d) => d._name === airplayName() || d.spdisplays_connection_type?.includes("airplay"));
        resolve(tv ? tv.spdisplays_mirror === "spdisplays_on" : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** Turn the TV on if needed, then extend the Mac's desktop to it over AirPlay. Returns a HUD message. */
export async function connectDisplay(): Promise<string> {
  if (!(await turnOn())) throw new Error("TV did not wake up");
  await loadName(); // after turnOn, so a first-ever run has learned the name from the TV
  // After booting, the TV needs a few seconds before Screen Mirroring lists it, hence the retries.
  const result = await run("connect", 4);
  if (result === "already-connected") return "🖥️ Already extended to the TV";

  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const mirrored = await airPlayDisplayMirrored();
    if (mirrored === false) return "🖥️ Mac extended to the TV";
    if (mirrored === true) return "🪞 Connected, but mirroring — switch to Extended in Displays settings once";
  }
  return "🖥️ Connected to the TV";
}

export async function disconnectDisplay(): Promise<string> {
  await loadName();
  const result = await run("disconnect");
  return result === "already-disconnected" ? "TV display was not connected" : "🖥️ TV display disconnected";
}

export async function isDisplayConnected(): Promise<boolean> {
  try {
    await loadName();
  } catch {
    return false;
  }
  return (await airPlayDisplayMirrored()) !== undefined;
}
