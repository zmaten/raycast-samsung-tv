import { closeMainWindow, showHUD } from "@raycast/api";
import { disconnectDisplay } from "./display";

export default async function Command() {
  await closeMainWindow();
  try {
    await showHUD(await disconnectDisplay());
  } catch (e) {
    await showHUD(`⚠️ ${(e as Error).message}`);
  }
}
