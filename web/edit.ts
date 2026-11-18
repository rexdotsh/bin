import { gutter, LINE_PX, lineCount } from "../src/page";
import { toast } from "./ui";

type Saved = { ok?: boolean; error?: string; etag?: string; lines: number; warnings?: string[] };

const STYLE = `textarea.code{display:block;width:calc(100% + 24px);border:0;outline:0;resize:none;background:none;field-sizing:content}
.editing #text,.editing .acts{display:none}.editing .top{position:sticky;top:0;z-index:2;background:var(--bg);box-shadow:0 10px 0 12px var(--bg),0 11px 0 12px var(--line)}
#ebar{display:flex;align-items:center;gap:4px;flex:none}#ebar .gh{height:30px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--mute2);font-size:13px;cursor:pointer}
#ebar .gh:active{background:var(--soft);color:var(--fg)}@media (hover:hover){#ebar .gh:hover{background:var(--soft);color:var(--fg)}#ebar .ib:hover{color:var(--red)}}#es{margin-left:4px}
@media (pointer:coarse){textarea.code{font-size:16px}#ebar .gh{height:44px;font-size:16px;padding:0 12px}#ebar{margin-right:-6px}}`;

const $ = (id: string) => document.getElementById(id);

export function open(
  pre: HTMLElement,
  text: string,
  data: { raw: string | null; etag?: string; hl?: unknown },
  token: string,
  render: (text: string) => Promise<unknown>,
  done: false | (() => unknown),
) {
  if (document.body.classList.contains("editing")) return;
  if (!$("ecss")) document.head.insertAdjacentHTML("beforeend", `<style id="ecss">${STYLE}</style>`);
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";
  const top = document.querySelector<HTMLElement>(".top")!;
  top.querySelector(".acts")!.insertAdjacentHTML(
    "beforebegin",
    `<span id="ebar"><button class="ib" title="Delete">${$("del")!.innerHTML}</button><button class="gh" title="Esc">Cancel</button><button id="es" class="btn">Save <kbd>${mod}S</kbd></button></span>`,
  );
  const bar = $("ebar")!;
  const [del, x, btn] = bar.children as unknown as HTMLButtonElement[];
  const ta = document.createElement("textarea");
  ta.className = "code";
  ta.spellcheck = false;
  ta.autocapitalize = "off";
  ta.ariaLabel = "Edit";
  ta.value = text;
  ta.style.paddingLeft = getComputedStyle(pre).paddingLeft;
  pre.after(ta);
  document.body.classList.add("editing");

  const dirty = () => ta.value !== text;
  const guard = (e: BeforeUnloadEvent) => e.preventDefault();
  const fit = () => {
    if (!CSS.supports("field-sizing", "content")) ta.rows = ta.value.split("\n").length;
    ta.style.marginBottom = ta.value.endsWith("\n") ? `-${LINE_PX}px` : "";
    if (dirty()) addEventListener("beforeunload", guard);
    else removeEventListener("beforeunload", guard);
  };
  fit();
  ta.addEventListener("input", fit);
  let i = 0;
  for (let n = Math.ceil((Math.max(0, top.getBoundingClientRect().bottom) - ta.getBoundingClientRect().top) / LINE_PX), j = 0; n > 0 && (j = text.indexOf("\n", i)) >= 0; n--) i = j + 1;
  ta.setSelectionRange(i, i);
  ta.focus({ preventScroll: !matchMedia("(pointer: coarse)").matches });

  let busy = false;
  const close = () => {
    ta.remove();
    bar.remove();
    document.body.classList.remove("editing");
    removeEventListener("keydown", keys, true);
    removeEventListener("beforeunload", guard);
    if (done) done();
  };
  const cancel = () => !busy && (!dirty() || confirm("Discard your changes?")) && close();
  const save = async () => {
    if (busy) return;
    if (!dirty()) return close();
    busy = ta.readOnly = btn.disabled = true;
    const next = ta.value;
    const r: Saved = await fetch(data.raw!.slice(4), {
      method: "PUT",
      headers: { "x-delete": token, "if-match": data.etag!, accept: "application/json", "content-type": "text/plain; charset=utf-8" },
      body: next,
    }).then(
      (res) => res.json().catch(() => ({ error: `couldn't save (HTTP ${res.status})` })),
      () => ({ error: "couldn't reach the server" }),
    );
    if (!r.ok) {
      busy = ta.readOnly = btn.disabled = false;
      return toast(r.error ?? "couldn't save", 4000);
    }
    data.etag = r.etag;
    data.hl = undefined;
    history.replaceState({ ...history.state, etag: r.etag }, "");
    fetch(data.raw!, { cache: "reload" }).catch(() => {});
    pre.style.setProperty("--gw", gutter(r.lines));
    for (const el of document.querySelectorAll(".meta .ln")) el.outerHTML = lineCount(r.lines);
    document.querySelector(".md")?.remove();
    await render(next);
    close();
    const warn = r.warnings?.[0];
    toast(warn ? `saved, but ${warn}` : "saved", warn ? 4000 : 1400);
  };
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape" && !e.isComposing) cancel();
  };
  addEventListener("keydown", keys, true);
  del.onclick = () => $("del")!.click();
  btn.onclick = save;
  x.onclick = cancel;
}
