import { Action, ActionPanel, Color, Icon, List, showToast, Toast, Keyboard } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { DiscoveredTv, discoverTvs } from "./discovery";
import { selectTv, storedTv } from "./tv";

export default function Command() {
  const current = usePromise(storedTv);
  const found = usePromise(() => discoverTvs());

  const choose = async (tv: DiscoveredTv) => {
    await selectTv(tv);
    current.revalidate();
    await showToast({ style: Toast.Style.Success, title: `Using ${tv.name.replace(/^\[TV\]\s*/, "")}` });
  };

  const tvs = found.data ?? [];
  const currentId = current.data?.id;
  const currentMissing = current.data && !tvs.some((t) => t.id === currentId);

  return (
    <List isLoading={found.isLoading} searchBarPlaceholder="Samsung TVs on this network">
      <List.EmptyView
        icon={Icon.Monitor}
        title={found.isLoading ? "Searching the network…" : "No Samsung TV found"}
        description="Switch the TV on and make sure it is on the same Wi-Fi as this Mac. TVs in standby cannot be discovered."
        actions={
          <ActionPanel>
            <Action title="Search Again" icon={Icon.ArrowClockwise} onAction={found.revalidate} />
          </ActionPanel>
        }
      />
      {tvs.map((tv) => {
        const isCurrent = tv.id === currentId;
        return (
          <List.Item
            key={tv.id}
            title={tv.name.replace(/^\[TV\]\s*/, "")}
            subtitle={tv.model}
            icon={{ source: Icon.Monitor, tintColor: isCurrent ? Color.Green : undefined }}
            accessories={[{ text: tv.ip }, ...(isCurrent ? [{ tag: { value: "Selected", color: Color.Green } }] : [])]}
            actions={
              <ActionPanel>
                <Action title="Use This TV" icon={Icon.CheckCircle} onAction={() => choose(tv)} />
                <Action
                  title="Search Again"
                  icon={Icon.ArrowClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={found.revalidate}
                />
                <Action.CopyToClipboard title="Copy IP Address" content={tv.ip} />
              </ActionPanel>
            }
          />
        );
      })}
      {currentMissing && !found.isLoading && (
        <List.Section title="Selected, not reachable now (probably in standby)">
          <List.Item
            title={current.data?.name?.replace(/^\[TV\]\s*/, "") ?? current.data?.ip ?? "TV"}
            subtitle={current.data?.model}
            icon={{ source: Icon.Monitor, tintColor: Color.Green }}
            accessories={[{ text: current.data?.ip }, { tag: { value: "Selected", color: Color.Green } }]}
          />
        </List.Section>
      )}
    </List>
  );
}
