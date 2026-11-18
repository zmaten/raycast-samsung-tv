import { getPreferenceValues, LocalStorage } from "@raycast/api";
import WebSocket from "ws";
import { storedTv, tvIp } from "./tv";

/**
 * A persistent remote-control connection (wss://<tv>:8002).
 *
 * Opening the channel takes 3–8 s on many Tizen TVs, so views keep one session open
 * and reuse it: after that, each key reaches the TV immediately. One-shot commands use
 * `withRemote`, which opens, sends and closes.
 */

const CLIENT_NAME = Buffer.from("Raycast").toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RemoteEvent =
  | { type: "keyboard-open"; text: string } // the TV shows its on-screen keyboard
  | { type: "keyboard-text"; text: string } // text in the TV's field changed
  | { type: "keyboard-close" }
  | { type: "disconnected" };

const tokenKey = async () => `token:${(await storedTv())?.id ?? "default"}`;

async function loadToken(): Promise<string | undefined> {
  const fromPrefs = getPreferenceValues<{ token?: string }>().token?.trim();
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

function decodeBase64(s: unknown): string {
  return typeof s === "string" ? Buffer.from(s, "base64").toString("utf8") : "";
}

export class RemoteSession {
  private ws?: WebSocket;
  private opening?: Promise<WebSocket>;
  private closed = false;
  private listeners = new Set<(e: RemoteEvent) => void>();

  onEvent(fn: (e: RemoteEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: RemoteEvent) {
    for (const fn of this.listeners) fn(e);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connects if needed; concurrent callers share one connection attempt. */
  connect(): Promise<WebSocket> {
    if (this.isOpen) return Promise.resolve(this.ws as WebSocket);
    if (!this.opening) {
      this.closed = false;
      this.opening = this.open().finally(() => (this.opening = undefined));
    }
    return this.opening;
  }

  private async open(): Promise<WebSocket> {
    const ip = await tvIp();
    const token = await loadToken();
    const key = await tokenKey();
    const url =
      `wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${CLIENT_NAME}` + (token ? `&token=${token}` : "");
    // The TV uses a self-signed certificate on the local network.
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10000 });

    return new Promise((resolve, reject) => {
      let connected = false;
      const timer = setTimeout(
        () => {
          ws.terminate();
          reject(new Error(token ? "TV did not respond" : "Select Allow on the TV, then try again"));
        },
        token ? 20000 : 45000,
      );

      ws.on("message", async (raw) => {
        let msg: { event?: string; data?: { token?: string } | string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        switch (msg.event) {
          case "ms.channel.connect": {
            clearTimeout(timer);
            connected = true;
            const newToken = typeof msg.data === "object" ? msg.data?.token : undefined;
            if (newToken && newToken !== token) await LocalStorage.setItem(key, newToken);
            this.ws = ws;
            resolve(ws);
            break;
          }
          case "ms.channel.unauthorized":
            clearTimeout(timer);
            ws.terminate();
            reject(
              new Error(
                "The TV refused the connection — on the TV open Settings → General → External Device Manager → Device Connection Manager and allow Raycast",
              ),
            );
            break;
          case "ms.remote.imeStart":
            this.emit({ type: "keyboard-open", text: decodeBase64(msg.data) });
            break;
          case "ms.remote.imeUpdate":
            this.emit({ type: "keyboard-text", text: decodeBase64(msg.data) });
            break;
          case "ms.remote.imeEnd":
            this.emit({ type: "keyboard-close" });
            break;
        }
      });
      // Tizen sends malformed close frames, which ws reports as errors; they only matter before connecting.
      ws.on("error", (err) => {
        if (!connected) {
          clearTimeout(timer);
          reject(err);
        }
      });
      ws.on("close", () => {
        if (this.ws === ws) this.ws = undefined;
        if (connected && !this.closed) this.emit({ type: "disconnected" });
      });
    });
  }

  private async send(payload: object) {
    const ws = await this.connect();
    ws.send(JSON.stringify(payload));
  }

  /** Presses one remote key, e.g. KEY_UP. Reconnects transparently if the TV dropped the socket. */
  async key(name: string) {
    await this.send({
      method: "ms.remote.control",
      params: { Cmd: "Click", DataOfCmd: name, Option: "false", TypeOfRemote: "SendRemoteKey" },
    });
  }

  async keys(names: string[], delayMs = 400) {
    for (const name of names) {
      await this.key(name);
      await sleep(delayMs);
    }
  }

  /** Types text into the text field that currently has focus on the TV. */
  async type(text: string) {
    await this.send({
      method: "ms.remote.control",
      params: {
        Cmd: Buffer.from(text, "utf8").toString("base64"),
        DataOfCmd: "base64",
        TypeOfRemote: "SendInputString",
      },
    });
    await sleep(150);
    await this.send({ method: "ms.remote.control", params: { TypeOfRemote: "SendInputEnd" } });
  }

  close() {
    this.closed = true;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners("error");
      ws.on("error", () => undefined);
      ws.terminate();
    }
  }
}

/** Opens a session, runs `fn`, and closes it again. For one-shot commands. */
export async function withRemote<T>(fn: (remote: RemoteSession) => Promise<T>): Promise<T> {
  const remote = new RemoteSession();
  try {
    await remote.connect();
    const result = await fn(remote);
    await sleep(300); // let the last frame leave before closing
    return result;
  } finally {
    remote.close();
  }
}
