import { viewBody } from "../src/page";
import { encrypt } from "./crypto";
import { plainLine, splitLines } from "./text";
import "./theme";

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

const draft = sessionStorage.getItem("bin:draft");
if (draft) {
  sessionStorage.removeItem("bin:draft");
  const d = JSON.parse(draft) as { text: string; name?: string; lang?: string };
  t.value = d.text;
  name = d.name ?? "";
  if (name) title.placeholder = name;
  if (d.lang && [...lang.options].some((o) => o.value === d.lang)) lang.value = d.lang;
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

async function save() {
  if (busy) return;
  const text = t.value;
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
      return say(`looks like a ${hit[1]} · save again to post anyway`, true);
    }
  }
  busy = true;
  bar.classList.add("busy");
  say(enc ? "encrypting…" : "saving…");
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
    say(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "couldn't reach the server", true);
    bar.classList.remove("busy");
    busy = false;
    return;
  }
  if (r.delete) localStorage.setItem(`bin:del:${r.id}`, r.delete);
  try {
    show(r, text, enc);
  } catch {
    location.assign(r.url);
  }
}

function show(r: Receipt, text: string, enc: boolean) {
  const path = new URL(r.url!).pathname;
  const lines = splitLines(text);
  const meta: Record<string, string> = { lines: String(lines.length), bytes: String(r.bytes ?? 0) };
  if (r.lines !== undefined) meta.lines = String(r.lines);
  if (r.lang) meta.lang = r.lang;
  if (r.expires) meta.exp = String(Date.parse(r.expires) / 1000);
  if (title.value.trim()) meta.t = title.value.trim();
  if (name) meta.name = name;
  if (enc) meta.enc = "1";
  const { cls, html } = viewBody({
    id: r.id!,
    ext: path.split(".")[1] ?? "",
    host: location.host,
    wrap: /(?:^|;\s*)wrap=1(?:;|$)/.test(document.cookie),
    meta,
    text: lines.map(plainLine).join("\n"),
    ansi: text.includes("\x1b") ? text : undefined,
  });
  listening.abort();
  document.body.className = cls;
  document.body.innerHTML = html;
  document.title = `${meta.t || meta.name || r.id} · bin`;
  history.pushState(null, "", path);
  scrollTo(0, 0);
  addEventListener("popstate", () => location.pathname !== path && location.reload());
  load("/view.js").catch(() => location.reload());
  navigator.clipboard.writeText(r.url!).then(
    () => toast("saved · link copied"),
    () => toast("saved"),
  );
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

saveBtn.addEventListener("click", save, opts);

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
    if (e.target !== t) {
      e.preventDefault();
      t.value = pasted;
    }
    setTimeout(() => t.value && save(), 0);
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
