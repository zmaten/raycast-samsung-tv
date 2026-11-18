import { showHUD, showToast, Toast } from "@raycast/api";
import { turnOn } from "./tv";

export default async function Command() {
  await showToast({ style: Toast.Style.Animated, title: "Waking TV…" });
  try {
    await showHUD((await turnOn()) ? "📺 TV is on" : "⚠️ TV did not wake — is “Power On with Mobile” enabled?");
  } catch (e) {
    await showHUD(`⚠️ ${(e as Error).message}`);
  }
}
