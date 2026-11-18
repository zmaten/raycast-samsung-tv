import { showHUD, showToast, Toast } from "@raycast/api";
import { powerState, turnOff, turnOn } from "./tv";

export default async function Command() {
  try {
    if ((await powerState()) === "on") {
      await showToast({ style: Toast.Style.Animated, title: "Turning TV off…" });
      await showHUD((await turnOff()) ? "💤 TV is off" : "⚠️ Key sent, but the TV still reports on");
    } else {
      await showToast({ style: Toast.Style.Animated, title: "Waking TV…" });
      await showHUD((await turnOn()) ? "📺 TV is on" : "⚠️ TV did not wake");
    }
  } catch (e) {
    await showHUD(`⚠️ ${(e as Error).message}`);
  }
}
