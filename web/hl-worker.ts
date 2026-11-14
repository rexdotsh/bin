import { highlight } from "./hl";

addEventListener("message", async (e: MessageEvent<{ mods: string[]; lang: string; text: string }>) => {
  postMessage(await highlight(e.data.mods, e.data.lang, e.data.text));
});
