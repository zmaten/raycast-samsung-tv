import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Form,
  Grid,
  Icon,
  Keyboard,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { RemoteSession } from "./remote";
import { turnOn } from "./tv";
import { getVolumeState, setMute, setVolume, VolumeState } from "./volume";

type Button = {
  id: string;
  title: string;
  label?: string; // shorter text for the grid cell
  icon: Icon;
  key?: string; // remote key sent on press
  special?: "type" | "power";
  shortcut?: Keyboard.Shortcut;
  tint?: Color;
};

// 5 columns × 3 rows so the whole remote fits without scrolling: the d-pad sits in the middle,
// playback above it, volume on its sides.
const BUTTONS: Button[] = [
  {
    id: "back",
    title: "Back",
    icon: Icon.ArrowCounterClockwise,
    key: "KEY_RETURN",
    shortcut: { modifiers: ["cmd"], key: "backspace" },
  },
  { id: "play", title: "Play", icon: Icon.Play, key: "KEY_PLAY", shortcut: { modifiers: ["cmd"], key: "p" } },
  { id: "up", title: "Up", icon: Icon.ArrowUp, key: "KEY_UP", shortcut: { modifiers: ["cmd"], key: "arrowUp" } },
  {
    id: "pause",
    title: "Pause",
    icon: Icon.Pause,
    key: "KEY_PAUSE",
    shortcut: { modifiers: ["cmd", "shift"], key: "p" },
  },
  { id: "home", title: "Home", icon: Icon.House, key: "KEY_HOME", shortcut: { modifiers: ["cmd", "shift"], key: "h" } },

  {
    id: "voldown",
    title: "Volume Down",
    label: "Vol −",
    icon: Icon.SpeakerDown,
    key: "KEY_VOLDOWN",
    shortcut: { modifiers: ["cmd"], key: "-" },
  },
  {
    id: "left",
    title: "Left",
    icon: Icon.ArrowLeft,
    key: "KEY_LEFT",
    shortcut: { modifiers: ["cmd"], key: "arrowLeft" },
  },
  { id: "ok", title: "OK", icon: Icon.CircleFilled, key: "KEY_ENTER", shortcut: { modifiers: ["cmd"], key: "return" } },
  {
    id: "right",
    title: "Right",
    icon: Icon.ArrowRight,
    key: "KEY_RIGHT",
    shortcut: { modifiers: ["cmd"], key: "arrowRight" },
  },
  {
    id: "volup",
    title: "Volume Up",
    label: "Vol +",
    icon: Icon.SpeakerUp,
    key: "KEY_VOLUP",
    shortcut: { modifiers: ["cmd"], key: "=" },
  },

  { id: "type", title: "Type…", icon: Icon.Keyboard, special: "type", shortcut: { modifiers: ["cmd"], key: "t" } },
  {
    id: "mute",
    title: "Mute",
    icon: Icon.SpeakerOff,
    key: "KEY_MUTE",
    shortcut: { modifiers: ["cmd", "shift"], key: "m" },
  },
  {
    id: "down",
    title: "Down",
    icon: Icon.ArrowDown,
    key: "KEY_DOWN",
    shortcut: { modifiers: ["cmd"], key: "arrowDown" },
  },
  {
    id: "source",
    title: "Source",
    icon: Icon.Plug,
    key: "KEY_SOURCE",
    shortcut: { modifiers: ["cmd", "shift"], key: "s" },
  },
  { id: "power", title: "Power", icon: Icon.Power, special: "power", tint: Color.Red },
];

const VOLUME_KEYS = new Set(["KEY_VOLUP", "KEY_VOLDOWN", "KEY_MUTE"]);

export default function Command() {
  const session = useRef(new RemoteSession());
  const [status, setStatus] = useState<"connecting" | "ready" | "offline">("connecting");
  const [volume, setVolumeState] = useState<VolumeState>();
  const [tvKeyboardOpen, setTvKeyboardOpen] = useState(false);
  const { push } = useNavigation();
  const volumeTimer = useRef<NodeJS.Timeout>(undefined);

  const refreshVolume = useCallback((delay = 0) => {
    clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(async () => setVolumeState(await getVolumeState()), delay);
  }, []);

  const connect = useCallback(async () => {
    setStatus("connecting");
    try {
      await session.current.connect();
      setStatus("ready");
      refreshVolume();
    } catch (e) {
      setStatus("offline");
      await showToast({ style: Toast.Style.Failure, title: "Can't reach the TV", message: (e as Error).message });
    }
  }, [refreshVolume]);

  useEffect(() => {
    const remote = session.current;
    const off = remote.onEvent((e) => {
      if (e.type === "keyboard-open") {
        setTvKeyboardOpen(true);
        showToast({
          style: Toast.Style.Success,
          title: "The TV is asking for text",
          message: "Press ⌘T to type it here",
        });
      } else if (e.type === "keyboard-close") setTvKeyboardOpen(false);
      else if (e.type === "disconnected") setStatus("connecting"); // next key press reconnects
    });
    connect();
    return () => {
      off();
      clearTimeout(volumeTimer.current);
      remote.close();
    };
  }, [connect]);

  const volumeRef = useRef<VolumeState>(undefined);
  volumeRef.current = volume;

  /** Volume via UPnP: exact ±1 steps the TV can't swallow (remote keys sometimes get lost while its overlay opens). */
  const changeVolume = useCallback(async (key: string): Promise<boolean> => {
    const current = volumeRef.current;
    if (!current) return false;
    try {
      if (key === "KEY_MUTE") {
        await setMute(!current.muted);
        setVolumeState({ ...current, muted: !current.muted });
      } else {
        const next = Math.max(0, Math.min(100, current.volume + (key === "KEY_VOLUP" ? 1 : -1)));
        await setVolume(next);
        setVolumeState({ volume: next, muted: false });
        volumeRef.current = { volume: next, muted: false }; // allow fast repeated presses
      }
      return true;
    } catch {
      return false; // fall back to remote keys
    }
  }, []);

  const press = useCallback(
    async (key: string) => {
      try {
        if (VOLUME_KEYS.has(key) && (await changeVolume(key))) return;
        await session.current.key(key);
        setStatus("ready");
        if (VOLUME_KEYS.has(key)) refreshVolume(500);
      } catch (e) {
        setStatus("offline");
        await showToast({ style: Toast.Style.Failure, title: "Key not sent", message: (e as Error).message });
      }
    },
    [refreshVolume, changeVolume],
  );

  const power = useCallback(async () => {
    if (status === "offline") {
      const toast = await showToast({ style: Toast.Style.Animated, title: "Waking TV…" });
      if (await turnOn()) {
        toast.hide();
        await connect();
      } else {
        toast.style = Toast.Style.Failure;
        toast.title = "TV did not wake up";
      }
    } else {
      await press("KEY_POWER");
      setStatus("offline");
    }
  }, [status, press, connect]);

  const openTyping = useCallback(() => push(<TypeForm session={session.current} />), [push]);

  const pasteClipboard = useCallback(async () => {
    const text = await Clipboard.readText();
    if (!text) return showToast({ style: Toast.Style.Failure, title: "Clipboard has no text" });
    await session.current.type(text);
    await showToast({ style: Toast.Style.Success, title: "Typed on TV", message: text.slice(0, 40) });
  }, []);

  const run = (b: Button) => (b.special === "type" ? openTyping() : b.special === "power" ? power() : press(b.key!));

  const statusText =
    status === "connecting"
      ? "Connecting…"
      : status === "offline"
        ? "TV off or unreachable"
        : volume
          ? volume.muted
            ? "Muted"
            : `Volume ${volume.volume}`
          : "Connected";

  // Every button carries every shortcut, so shortcuts work whichever cell is selected.
  const sharedActions = (except: string) => (
    <ActionPanel.Section title="Remote">
      {BUTTONS.filter((b) => b.id !== except && b.shortcut).map((b) => (
        <Action key={b.id} title={b.title} icon={b.icon} shortcut={b.shortcut} onAction={() => run(b)} />
      ))}
      <Action
        title="Paste Clipboard on TV"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
        onAction={pasteClipboard}
      />
      <Action.Push
        title="Set Volume…"
        icon={Icon.SpeakerOn}
        shortcut={{ modifiers: ["cmd", "shift"], key: "=" }}
        target={<VolumeForm current={volume?.volume} onDone={() => refreshVolume()} />}
      />
      <Action
        title="Reconnect"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={connect}
      />
    </ActionPanel.Section>
  );

  return (
    <Grid
      columns={5}
      aspectRatio="16/9"
      inset={Grid.Inset.Medium}
      isLoading={status === "connecting"}
      navigationTitle={`Remote — ${statusText}${tvKeyboardOpen ? " · TV keyboard open (⌘T)" : ""}`}
      searchBarPlaceholder={`${statusText} — ⌘ + arrows to navigate, ⌘↩ OK, ⌘T type`}
    >
      {BUTTONS.map((b) => (
        <Grid.Item
          key={b.id}
          title={b.shortcut ? `${b.label ?? b.title}   ${shortcutLabel(b.shortcut)}` : (b.label ?? b.title)}
          content={{
            source: b.icon,
            tintColor:
              b.tint ??
              (b.id === "mute" && volume?.muted
                ? Color.Orange
                : b.id === "type" && tvKeyboardOpen
                  ? Color.Green
                  : undefined),
          }}
          keywords={[b.key ?? b.id]}
          actions={
            <ActionPanel>
              <Action title={b.title} icon={b.icon} onAction={() => run(b)} />
              {sharedActions(b.id)}
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}

function shortcutLabel(s: Keyboard.Shortcut): string {
  if (!("modifiers" in s)) return "";
  const mods: Record<string, string> = { cmd: "⌘", shift: "⇧", opt: "⌥", ctrl: "⌃" };
  const keys: Record<string, string> = {
    arrowUp: "↑",
    arrowDown: "↓",
    arrowLeft: "←",
    arrowRight: "→",
    return: "↩",
    backspace: "⌫",
    "=": "+",
  };
  return s.modifiers.map((m) => mods[m]).join("") + (keys[s.key] ?? s.key.toUpperCase());
}

function TypeForm({ session }: { session: RemoteSession }) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="Type on TV"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send to TV"
            icon={Icon.Keyboard}
            onSubmit={async ({ text, submit }: { text: string; submit: boolean }) => {
              if (!text) return;
              try {
                await session.type(text);
                if (submit) await session.key("KEY_ENTER");
                await showToast({ style: Toast.Style.Success, title: "Typed on TV" });
                pop();
              } catch (e) {
                await showToast({ style: Toast.Style.Failure, title: "Not sent", message: (e as Error).message });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="text" title="Text" placeholder="Search, URL, password…" autoFocus />
      <Form.Checkbox id="submit" label="Press OK on the TV afterwards" defaultValue={false} />
      <Form.Description text="Open a text field on the TV first (e.g. YouTube search). The text replaces what is in it." />
    </Form>
  );
}

function VolumeForm({ current, onDone }: { current?: number; onDone: () => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="Set TV Volume"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Set Volume"
            icon={Icon.SpeakerOn}
            onSubmit={async ({ level }: { level: string }) => {
              const n = Number(level);
              if (!Number.isFinite(n) || n < 0 || n > 100) {
                await showToast({ style: Toast.Style.Failure, title: "Enter a number from 0 to 100" });
                return;
              }
              try {
                await setVolume(n);
                onDone();
                pop();
              } catch (e) {
                await showToast({ style: Toast.Style.Failure, title: "Volume not set", message: (e as Error).message });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="level"
        title="Volume"
        placeholder="0–100"
        defaultValue={current !== undefined ? String(current) : undefined}
        autoFocus
      />
    </Form>
  );
}
