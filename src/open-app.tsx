import {
  Action,
  ActionPanel,
  closeMainWindow,
  Color,
  Form,
  Icon,
  List,
  showHUD,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { connectDisplay, disconnectDisplay, isDisplayConnected } from "./display";
import {
  addCustomId,
  closeApp,
  getCustomIds,
  launchApp,
  listInstalledApps,
  powerState,
  probeApp,
  sendKeys,
  turnOff,
  turnOn,
  TvApp,
} from "./tv";

const SOURCES: { title: string; keys: string[]; icon: Icon }[] = [
  { title: "Live TV", keys: ["KEY_TV"], icon: Icon.Livestream },
  { title: "Next HDMI Input", keys: ["KEY_HDMI"], icon: Icon.Plug },
  { title: "Source Picker", keys: ["KEY_SOURCE"], icon: Icon.List },
  { title: "Home Screen", keys: ["KEY_HOME"], icon: Icon.House },
];

async function run(title: string, fn: () => Promise<unknown>, hud: string | ((r: unknown) => string)) {
  const toast = await showToast({ style: Toast.Style.Animated, title });
  try {
    const result = await fn();
    toast.hide();
    await showHUD(typeof hud === "function" ? hud(result) : hud);
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = (e as Error).message;
  }
}

async function ensureOn() {
  if ((await powerState()) !== "on" && !(await turnOn())) throw new Error("TV did not wake up");
}

export default function Command() {
  const power = useCachedPromise(powerState, [], { keepPreviousData: true });
  const apps = useCachedPromise(async () => listInstalledApps(await getCustomIds()), [], {
    keepPreviousData: true,
  });

  const display = useCachedPromise(isDisplayConnected, [], { keepPreviousData: true });

  const tvOn = power.data === "on";
  const refresh = () => {
    power.revalidate();
    apps.revalidate();
    display.revalidate();
  };

  // Control Center is driven by UI scripting, so Raycast's window must close first.
  const extend = async () => {
    await closeMainWindow();
    await run("Extending display to TV…", connectDisplay, (msg) => String(msg));
  };
  const disconnect = async () => {
    await closeMainWindow();
    await run("Disconnecting TV display…", disconnectDisplay, (msg) => String(msg));
  };

  const powerActions = (
    <ActionPanel.Section title="Power">
      <Action
        title="Turn TV On"
        icon={Icon.Power}
        shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
        onAction={() => run("Waking TV…", turnOn, "📺 TV is on").then(refresh)}
      />
      <Action
        title="Turn TV Off"
        icon={Icon.Moon}
        shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
        onAction={() => run("Turning TV off…", turnOff, "💤 TV is off").then(refresh)}
      />
      {display.data ? (
        <Action
          title="Disconnect TV Display"
          icon={Icon.Monitor}
          shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
          onAction={disconnect}
        />
      ) : (
        <Action
          title="Extend Mac Display to TV"
          icon={Icon.Monitor}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={extend}
        />
      )}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={refresh}
      />
      <Action.Push
        title="Add App by ID"
        icon={Icon.Plus}
        shortcut={{ modifiers: ["cmd"], key: "n" }}
        target={<AddAppForm onAdded={refresh} />}
      />
    </ActionPanel.Section>
  );

  const powerLabel =
    power.data === "on" ? "On" : power.data === "standby" ? "Going to standby" : power.data ? "Off" : "…";

  return (
    <List
      isLoading={power.isLoading || apps.isLoading}
      searchBarPlaceholder="Open an app on the TV…"
      navigationTitle={`Samsung TV — ${powerLabel}`}
    >
      {!tvOn && !power.isLoading && (
        <List.Section title="TV is off">
          <List.Item
            title="Turn TV On"
            icon={{ source: Icon.Power, tintColor: Color.Green }}
            subtitle="Wake-on-LAN — picking an app also wakes the TV"
            actions={
              <ActionPanel>
                <Action
                  title="Turn TV On"
                  icon={Icon.Power}
                  onAction={() => run("Waking TV…", turnOn, "📺 TV is on").then(refresh)}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      <List.Section title="Apps" subtitle={apps.data ? String(apps.data.length) : undefined}>
        {(apps.data ?? []).map((app: TvApp) => (
          <List.Item
            key={app.id}
            title={app.name}
            icon={app.visible ? { source: Icon.Play, tintColor: Color.Green } : Icon.AppWindow}
            keywords={[app.id]}
            accessories={[
              app.visible
                ? { tag: { value: "On screen", color: Color.Green } }
                : app.running
                  ? { tag: { value: "Running", color: Color.SecondaryText } }
                  : {},
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={`Open ${app.name}`}
                  icon={Icon.Play}
                  onAction={() => run(`Opening ${app.name}…`, () => launchApp(app.id), `📺 ${app.name}`).then(refresh)}
                />
                {app.running && (
                  <Action
                    title={`Close ${app.name}`}
                    icon={Icon.XMarkCircle}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => run(`Closing ${app.name}…`, () => closeApp(app.id), `Closed ${app.name}`).then(refresh)}
                  />
                )}
                <Action.CopyToClipboard title="Copy App ID" content={app.id} />
                {powerActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Mac Display">
        <List.Item
          title={display.data ? "Disconnect TV Display" : "Extend Mac Display to TV"}
          subtitle={display.data ? "TV is an extended display" : "AirPlay — turns the TV on if needed"}
          icon={{ source: Icon.Monitor, tintColor: display.data ? Color.Green : undefined }}
          keywords={["airplay", "screen", "mirroring", "extend", "display", "monitor"]}
          accessories={display.data ? [{ tag: { value: "Connected", color: Color.Green } }] : []}
          actions={
            <ActionPanel>
              {display.data ? (
                <Action title="Disconnect TV Display" icon={Icon.Monitor} onAction={disconnect} />
              ) : (
                <Action title="Extend Mac Display to TV" icon={Icon.Monitor} onAction={extend} />
              )}
              {powerActions}
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="Inputs">
        {SOURCES.map((s) => (
          <List.Item
            key={s.title}
            title={s.title}
            icon={s.icon}
            actions={
              <ActionPanel>
                <Action
                  title={`Switch to ${s.title}`}
                  icon={s.icon}
                  onAction={() =>
                    run(
                      `${s.title}…`,
                      async () => {
                        await ensureOn();
                        await sendKeys(s.keys);
                      },
                      `📺 ${s.title}`,
                    ).then(refresh)
                  }
                />
                {powerActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function AddAppForm({ onAdded }: { onAdded: () => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Add App"
            onSubmit={async ({ id }: { id: string }) => {
              const toast = await showToast({ style: Toast.Style.Animated, title: "Checking app on TV…" });
              const app = await probeApp(id.trim());
              if (!app) {
                toast.style = Toast.Style.Failure;
                toast.title = "Not installed on the TV (or TV is off)";
                return;
              }
              await addCustomId(app.id);
              toast.style = Toast.Style.Success;
              toast.title = `Added ${app.name}`;
              onAdded();
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="id" title="App ID" placeholder="e.g. 3201606009684" />
      <Form.Description text="Find IDs in the homebridge-samsung-tizen app list, or via Samsung's Smart Hub website (data-app-id attribute)." />
    </Form>
  );
}
