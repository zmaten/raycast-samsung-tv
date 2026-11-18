import { showHUD, showToast, Toast } from "@raycast/api";
import { turnOff } from "./tv";

export default async function Command() {
  await showToast({ style: Toast.Style.Animated, title: "Turning TV off…" });
  try {
    await showHUD((await turnOff()) ? "💤 TV is off" : "⚠️ Key sent, but the TV still reports on");
  } catch (e) {
    await showHUD(`⚠️ ${(e as Error).message}`);
  }
}
