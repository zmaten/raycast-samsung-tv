import { closeMainWindow, LaunchProps, showHUD, showToast, Toast } from "@raycast/api";
import { findYouTubeLink, playOnTv } from "./youtube";

export default async function Command(props: LaunchProps<{ arguments: Arguments.PlayYoutube }>) {
  try {
    const found = await findYouTubeLink(props.arguments.url);
    if (!found) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No YouTube link found",
        message: "Open the video in your browser, copy its link, or paste it as the argument",
      });
      return;
    }
    await closeMainWindow();
    await showToast({ style: Toast.Style.Animated, title: "Sending to TV…" });
    await playOnTv(found.video);
    const from = { argument: "", browser: " from browser", clipboard: " from clipboard" }[found.source];
    await showHUD(`▶️ Playing on TV${from}`);
  } catch (e) {
    await showHUD(`⚠️ ${(e as Error).message}`);
  }
}
