import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { connectDisplay } from "./display";

export default async function Command() {
  await closeMainWindow(); // Control Center is driven via UI scripting, so Raycast must get out of the way
  await showToast({ style: Toast.Style.Animated, title: "Extending display to TV…" });
  try {
    await showHUD(await connectDisplay());
  } catch (e) {
    await showHUD(`⚠️ ${(e as Error).message}`);
  }
}
