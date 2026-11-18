import { tvIp } from "./tv";

/**
 * Volume and mute via the TV's UPnP RenderingControl service (DLNA renderer on port 9197).
 * Unlike the remote's KEY_VOLUP/KEY_VOLDOWN this reads the current level and can set an exact one.
 */

const SERVICE = "urn:schemas-upnp-org:service:RenderingControl:1";
const DEFAULT_CONTROL_PATH = "/upnp/control/RenderingControl1";
let controlUrlCache: { ip: string; url: string } | undefined;

async function controlUrl(): Promise<string> {
  const ip = await tvIp();
  if (controlUrlCache?.ip === ip) return controlUrlCache.url;
  let path = DEFAULT_CONTROL_PATH;
  try {
    // the device description lists where each service lives; 2016+ Tizen TVs use /dmr on 9197
    const res = await fetch(`http://${ip}:9197/dmr`, { signal: AbortSignal.timeout(2500) });
    const xml = await res.text();
    const block = xml.split("<service>").find((s) => s.includes(SERVICE));
    path = block?.match(/<controlURL>([^<]+)<\/controlURL>/)?.[1] ?? path;
  } catch {
    // keep the default path
  }
  const url = `http://${ip}:9197${path.startsWith("/") ? "" : "/"}${path}`;
  controlUrlCache = { ip, url };
  return url;
}

async function soap(action: string, args = ""): Promise<string> {
  const res = await fetch(await controlUrl(), {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${SERVICE}#${action}"` },
    body:
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:${action} xmlns:u="${SERVICE}"><InstanceID>0</InstanceID><Channel>Master</Channel>${args}</u:${action}>` +
      `</s:Body></s:Envelope>`,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`TV volume service: HTTP ${res.status}`);
  return res.text();
}

export type VolumeState = { volume: number; muted: boolean };

export async function getVolumeState(): Promise<VolumeState | undefined> {
  try {
    const [v, m] = await Promise.all([soap("GetVolume"), soap("GetMute")]);
    const volume = Number(v.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/)?.[1]);
    const muted = m.match(/<CurrentMute>(\d)<\/CurrentMute>/)?.[1] === "1";
    return Number.isFinite(volume) ? { volume, muted } : undefined;
  } catch {
    return undefined; // TV off, or a model without the DLNA renderer
  }
}

export async function setVolume(level: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  await soap("SetVolume", `<DesiredVolume>${clamped}</DesiredVolume>`);
}

export async function setMute(muted: boolean): Promise<void> {
  await soap("SetMute", `<DesiredMute>${muted ? 1 : 0}</DesiredMute>`);
}
