import { asset, hlModules, viewBody } from "../src/page";
import { encrypt } from "./crypto";
import { stripAnsi, toLines } from "../src/text";
import "./theme";
import { cookie, store, stored } from "./ui";

type Receipt = {
  ok: boolean;
  error?: string;
  id?: string;
  url?: string;
  delete?: string;
  lines?: number;
  bytes?: number;
  lang?: string | null;
  expires?: string | null;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const t = $<HTMLTextAreaElement>("t");
const title = $<HTMLInputElement>("title");
const lang = $<HTMLSelectElement>("lang");
const ttl = $<HTMLSelectElement>("ttl");
const lock = $<HTMLButtonElement>("lock");
const pw = $<HTMLInputElement>("pw");
const status = $<HTMLSpanElement>("status");
const saveBtn = $<HTMLButtonElement>("save");
const bar = document.querySelector<HTMLElement>(".bar")!;
const data = JSON.parse($("data").textContent!) as { mod: string; secrets: [string, string][] };
const secrets = data.secrets.map(([src, kind]) => [new RegExp(src), kind] as const);
const load = (path: string) => import(path);
const listening = new AbortController();
const opts = { signal: listening.signal };

let name = "";
let holdPaste = false;
let busy = false;
let warned = false;

const draft = stored("sessionStorage", "bin:draft");
if (draft) {
  store("sessionStorage", "bin:draft", null);
  try {
    const d = JSON.parse(draft) as { text: string; name?: string; lang?: string };
    t.value = d.text;
    name = d.name ?? "";
    if (name) title.placeholder = name;
    if (d.lang && [...lang.options].some((o) => o.value === d.lang)) lang.value = d.lang;
  } catch {}
}

const say = (msg: string, warn = false) => {
  status.textContent = msg;
  status.classList.toggle("warn", warn);
};
const locked = () => lock.getAttribute("aria-pressed") === "true";

lock.addEventListener("click", () => {
  const on = !locked();
  lock.setAttribute("aria-pressed", String(on));
  pw.hidden = !on;
  if (on) pw.focus();
});
pw.addEventListener("keydown", (e) => {
  if (e.key === "Enter") save();
});
t.addEventListener("input", () => {
  if (warned) say("");
  warned = false;
});

function copier(): (url: string | null) => Promise<unknown> {
  let settle!: (url: string | null) => void;
  const link = new Promise<string | null>((r) => (settle = r));
  const blob = link.then((u) => (u === null ? Promise.reject(new Error("not saved")) : new Blob([u], { type: "text/plain" })));
  blob.catch(() => {});
  let early: Promise<unknown> | null = null;
  try {
    early = navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    early.catch(() => {});
  } catch {}
  return (url) => {
    settle(url);
    if (url === null) return Promise.resolve();
    return (early ?? Promise.reject()).catch(() => navigator.clipboard.writeText(url));
  };
}

function preload(paths: string[]) {
  for (const href of paths) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = href;
    document.head.append(link);
  }
}

async function save(text = t.value) {
  if (busy) return;
  if (!text) return say("nothing to save");
  const enc = locked();
  if (enc && !pw.value) {
    say("enter a password");
    return pw.focus();
  }
  if (!enc && !warned) {
    const sample = text.slice(0, 256 * 1024);
    const hit = secrets.find(([re]) => re.test(sample));
    if (hit) {
      warned = true;
      if (t.value !== text) t.value = text;
      return say(`looks like a ${hit[1]} · save again to post anyway`, true);
    }
  }
  busy = true;
  bar.classList.add("busy");
  say(enc ? "encrypting…" : "saving…");
  const hint = t.placeholder;
  const held = t.value !== text;
  if (held) {
    t.placeholder = "";
    t.readOnly = true;
  }
  const copy = copier();
  if (!enc && (lang.value !== "auto" || !name)) preload(hlModules(lang.value === "auto" ? "" : lang.value, text) ?? []);
  let r: Receipt;
  try {
    const params = new URLSearchParams();
    if (title.value.trim()) params.set("title", title.value.trim());
    if (lang.value !== "auto") params.set("lang", lang.value);
    if (ttl.value !== "never") params.set("ttl", ttl.value);
    if (name) params.set("name", name);
    if (enc) params.set("enc", "1");
    const res = await fetch(`/?${params}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "text/plain; charset=utf-8" },
      body: enc ? await encrypt(text, pw.value) : text,
    });
    r = (await res.json().catch(() => ({ ok: false, error: `couldn't save (HTTP ${res.status})` }))) as Receipt;
    if (!r.ok || !r.url || !r.id) throw new Error(r.error || "couldn't save");
  } catch (err) {
    copy(null);
    if (held) {
      t.value = text;
      t.placeholder = hint;
      t.readOnly = false;
    }
    say(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "couldn't reach the server", true);
    bar.classList.remove("busy");
    busy = false;
    return;
  }
  const copied = copy(r.url);
  if (r.delete) store("localStorage", `bin:del:${r.id}`, r.delete);
  try {
    show(r, text, enc, copied);
  } catch {
    location.assign(r.url);
  }
}

function show(r: Receipt, text: string, enc: boolean, copied: Promise<unknown>) {
  const path = new URL(r.url!).pathname;
  const meta: Record<string, string> = { lines: String(r.lines ?? toLines(text).plain.length), bytes: String(r.bytes ?? 0) };
  if (r.lang) meta.lang = r.lang;
  if (r.expires) meta.exp = String(Date.parse(r.expires) / 1000);
  if (title.value.trim()) meta.t = title.value.trim();
  if (name) meta.name = name;
  if (enc) meta.enc = "1";
  const { cls, html } = viewBody({
    id: r.id!,
    ext: path.split(".")[1] ?? "",
    host: location.host,
    wrap: cookie("wrap") === "1",
    meta,
    text: stripAnsi(text),
    ansi: text.includes("\x1b") ? text : undefined,
  });
  listening.abort();
  document.body.className = cls;
  document.body.innerHTML = html;
  document.title = `${meta.t || meta.name || r.id} · bin`;
  history.pushState(null, "", path);
  scrollTo(0, 0);
  addEventListener("popstate", () => location.pathname !== path && location.reload());
  copied
    .then(
      () => toast("saved · link copied"),
      () => toast("saved"),
    )
    .then(() => requestAnimationFrame(() => setTimeout(() => load(asset("view.js")).catch(() => location.reload()))));
}

function toast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("on")));
  setTimeout(() => el.classList.remove("on"), 1800);
}

saveBtn.addEventListener("click", () => save(), opts);

document.addEventListener(
  "keydown",
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "v") holdPaste = true;
  },
  opts,
);

document.addEventListener(
  "paste",
  (e) => {
    const hold = holdPaste;
    holdPaste = false;
    if (hold || busy || t.value || title.value || locked()) return;
    if (e.target !== t && (e.target as HTMLElement).closest?.("input, select")) return;
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (!pasted) return;
    e.preventDefault();
    save(pasted.replace(/\r\n?/g, "\n"));
  },
  opts,
);

document.addEventListener("dragover", (e) => e.preventDefault(), opts);
document.addEventListener(
  "drop",
  async (e) => {
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    t.value = await file.text();
    name = file.name;
    warned = false;
    title.placeholder = file.name;
    say(`${file.name} · ${data.mod}S to save`);
  },
  opts,
);
