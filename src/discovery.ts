import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";

export type DiscoveredTv = {
  ip: string;
  id: string; // device uuid, stable across IP changes
  name: string; // e.g. "[TV] Living Room"
  model?: string;
  mac?: string;
  powerState?: string;
};

type DeviceInfo = {
  device?: {
    id?: string;
    duid?: string;
    name?: string;
    modelName?: string;
    wifiMac?: string;
    PowerState?: string;
    type?: string;
    OS?: string;
  };
};

/** Asks a host for the Samsung TV REST info; undefined if it is not a Samsung TV. */
export async function identify(ip: string, timeoutMs = 2500): Promise<DiscoveredTv | undefined> {
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const d = ((await res.json()) as DeviceInfo).device;
    if (!d || !/samsung/i.test(d.type ?? "") || !(d.id || d.duid)) return undefined;
    return {
      ip,
      id: (d.duid || d.id) as string,
      name: d.name || "Samsung TV",
      model: d.modelName,
      mac: d.wifiMac,
      // 2019 and older TVs omit PowerState; their API only answers while the TV is on.
      powerState: d.PowerState ?? "on",
    };
  } catch {
    return undefined;
  }
}

function localSubnets(): { address: string; prefix: string }[] {
  const out: { address: string; prefix: string }[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      // only private IPv4 /24-or-smaller LANs; skip VPN tunnels with huge ranges
      if (a.family !== "IPv4" || a.internal || !a.netmask.startsWith("255.255.255")) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      out.push({ address: a.address, prefix: a.address.replace(/\.\d+$/, ".") });
    }
  }
  return out;
}

/** SSDP: every Samsung Tizen TV answers M-SEARCH for its remote-control receiver while it is on. */
function ssdpCandidates(timeoutMs: number): Promise<Set<string>> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const finish = () => {
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(found);
    };
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString();
      if (/samsung/i.test(text)) found.add(rinfo.address);
    });
    sock.bind(0, () => {
      const targets = [
        "urn:samsung.com:device:RemoteControlReceiver:1",
        "urn:dial-multiscreen-org:service:dial:1",
        "urn:schemas-upnp-org:device:MediaRenderer:1",
      ];
      const send = () => {
        for (const st of targets) {
          const req = Buffer.from(
            `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
          );
          sock.send(req, 1900, "239.255.255.250");
        }
      };
      send();
      setTimeout(send, 600); // UDP is lossy; ask twice
    });
    setTimeout(finish, timeoutMs);
  });
}

function portOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Fallback when multicast is blocked: try port 8001 on every host of the local /24 networks. */
async function scanCandidates(): Promise<Set<string>> {
  const ips = localSubnets().flatMap(({ prefix, address }) =>
    Array.from({ length: 254 }, (_, i) => `${prefix}${i + 1}`).filter((ip) => ip !== address),
  );
  const found = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < ips.length) {
      const ip = ips[next++];
      if (await portOpen(ip, 8001, 400)) found.add(ip);
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  return found;
}

/**
 * Finds Samsung TVs that are switched on in the local network.
 * TVs in deep standby are invisible to discovery; they can still be woken by MAC once known.
 */
export async function discoverTvs(options: { scanFallback?: boolean } = {}): Promise<DiscoveredTv[]> {
  let candidates = await ssdpCandidates(2500);
  if (candidates.size === 0 && options.scanFallback !== false) candidates = await scanCandidates();
  const tvs = (await Promise.all([...candidates].map((ip) => identify(ip)))).filter((t): t is DiscoveredTv => !!t);
  // one entry per device, even if it answered on several addresses
  return [...new Map(tvs.map((t) => [t.id, t])).values()].sort((a, b) => a.name.localeCompare(b.name));
}
