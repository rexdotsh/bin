import { decrypt } from "./crypto";
import { toggleTheme } from "./theme";

type Data = {
  id: string;
  ext: string;
  name: string;
  lang: string;
  ansi?: string;
  enc?: string;
  live?: number;
  diff: boolean;
  raw: string | null;
  dl: string | null;
};

type Hljs = {
  getLanguage(name: string): unknown;
  highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string };
  highlightAuto(code: string): { value: string; relevance: number; language?: string };
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const data = JSON.parse($("data").textContent!) as Data;
const pre = $<HTMLPreElement>("text");
const code = $<HTMLDivElement>("code");
const NO_HL = new Set(["", "log", "text", "diff"]);
const HL_MAX = 300_000;
const BATCH = 3000;

let plain: string[] = [];
let sel: [number, number] | null = null;
let anchor = 0;
let rows: HTMLDivElement[] = [];

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
const strip = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
const lastSegment = (line: string) => {
  const parts = line.split("\r");
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
};

// ---------------------------------------------------------------- ANSI

function xterm(n: number): string {
  if (n < 232) {
    const i = n - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

type Style = { fg: number | string | null; bg: number | string | null; b: boolean; d: boolean; i: boolean; u: boolean };
const fresh = (): Style => ({ fg: null, bg: null, b: false, d: false, i: false, u: false });

function sgr(st: Style, params: string) {
  const p = params === "" ? [0] : params.split(/[;:]/).map((x) => Number(x) || 0);
  for (let k = 0; k < p.length; k++) {
    const n = p[k];
    if (n === 0) Object.assign(st, fresh());
    else if (n === 1) st.b = true;
    else if (n === 2) st.d = true;
    else if (n === 3) st.i = true;
    else if (n === 4) st.u = true;
    else if (n === 22) st.b = st.d = false;
    else if (n === 23) st.i = false;
    else if (n === 24) st.u = false;
    else if (n >= 30 && n <= 37) st.fg = n - 30;
    else if (n >= 90 && n <= 97) st.fg = n - 82;
    else if (n === 39) st.fg = null;
    else if (n >= 40 && n <= 47) st.bg = n - 40;
    else if (n >= 100 && n <= 107) st.bg = n - 92;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      let v: number | string | null = null;
      if (p[k + 1] === 5) {
        const c = p[k + 2];
        v = c < 16 ? c : xterm(c);
        k += 2;
      } else if (p[k + 1] === 2) {
        v = `rgb(${p[k + 2]},${p[k + 3]},${p[k + 4]})`;
        k += 4;
      }
      if (n === 38) st.fg = v;
      else st.bg = v;
    }
  }
}

function span(st: Style, s: string): string {
  if (!s) return "";
  const cls: string[] = [];
  const css: string[] = [];
  if (typeof st.fg === "number") cls.push(`f${st.fg}`);
  else if (st.fg) css.push(`color:${st.fg}`);
  if (typeof st.bg === "number") cls.push(`b${st.bg}`);
  else if (st.bg) css.push(`background:${st.bg}`);
  if (st.b) cls.push("ab");
  if (st.d) cls.push("ad");
  if (st.i) cls.push("ai");
  if (st.u) cls.push("au");
  if (!cls.length && !css.length) return esc(s);
  return `<span${cls.length ? ` class="${cls.join(" ")}"` : ""}${css.length ? ` style="${css.join(";")}"` : ""}>${esc(s)}</span>`;
}

const TOKEN = /\x1b\[([0-9;:?]*)([ -/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]?|([^\x1b]+)/g;

function ansiLine(st: Style, line: string): string {
  const parts = lastSegment(line);
  let out = "";
  parts.forEach((seg, idx) => {
    const keep = idx === parts.length - 1;
    for (const m of seg.matchAll(TOKEN)) {
      if (m[3] !== undefined) {
        if (keep) out += span(st, m[3]);
      } else if (m[2] === "m") sgr(st, m[1]);
    }
  });
  return out;
}

// ---------------------------------------------------------------- highlight.js

function splitHtml(htmlText: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const m of htmlText.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) {
      open.push(m[1]);
      line += m[1];
    } else if (m[2]) {
      open.pop();
      line += m[2];
    } else if (m[3]) {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else line += m[4];
  }
  out.push(line);
  return out;
}

async function highlighted(text: string): Promise<string[] | null> {
  if (data.ansi || data.live !== undefined || text.length > HL_MAX) return null;
  const lang = data.lang;
  if (NO_HL.has(lang) && !(lang === "" && text.length < 30_000)) return null;
  try {
    const path = "/hl.js";
    const hljs = ((await import(path)) as { default: Hljs }).default;
    let value: string;
    if (lang && hljs.getLanguage(lang)) value = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    else {
      const auto = hljs.highlightAuto(text);
      if (auto.relevance < 10) return null;
      value = auto.value;
    }
    return splitHtml(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rows

function rowClass(stripped: string): string {
  if (!(data.lang === "diff" || data.diff)) return "r";
  if (stripped.startsWith("+++") || stripped.startsWith("---") || /^(diff|index) /.test(stripped)) return "r dm";
  if (stripped.startsWith("@@")) return "r dh";
  if (stripped.startsWith("+")) return "r da";
  if (stripped.startsWith("-")) return "r dd";
  return "r";
}

function makeRow(n: number, inner: string, stripped: string): HTMLDivElement {
  const r = document.createElement("div");
  r.className = rowClass(stripped);
  r.id = `L${n}`;
  r.innerHTML = `<a class="n" href="#L${n}">${n}</a><span class="c">${inner}</span>`;
  return r;
}

const style = fresh();
let pending = "";
let pendingRow: HTMLDivElement | null = null;

function appendText(chunk: string) {
  const all = pending + chunk;
  const parts = all.replace(/\r\n/g, "\n").split("\n");
  pending = parts.pop()!;
  if (pendingRow) {
    pendingRow.remove();
    rows.pop();
    plain.pop();
    pendingRow = null;
  }
  const frag = document.createDocumentFragment();
  for (const line of parts) {
    const s = strip(lastSegment(line).pop() ?? "");
    plain.push(s);
    const r = makeRow(plain.length, ansiLine(style, line), s);
    rows.push(r);
    frag.append(r);
  }
  if (pending) {
    const copy = { ...style };
    const s = strip(lastSegment(pending).pop() ?? "");
    plain.push(s);
    pendingRow = makeRow(plain.length, ansiLine(copy, pending), s);
    rows.push(pendingRow);
    frag.append(pendingRow);
  }
  code.append(frag);
  gutter();
}

async function render(text: string) {
  const norm = text.replace(/\r\n/g, "\n");
  const hl = await highlighted(norm);
  code.textContent = "";
  rows = [];
  plain = [];
  if (!hl) {
    const lines = norm.split("\n");
    if (norm.endsWith("\n")) lines.pop();
    const st = fresh();
    let i = 0;
    const step = () => {
      const frag = document.createDocumentFragment();
      for (const end = Math.min(lines.length, i + BATCH); i < end; i++) {
        const s = strip(lastSegment(lines[i]).pop() ?? "");
        plain.push(s);
        const r = makeRow(i + 1, ansiLine(st, lines[i]), s);
        rows.push(r);
        frag.append(r);
      }
      code.append(frag);
      if (i < lines.length) setTimeout(step, 0);
      else done();
    };
    show();
    step();
    return;
  }
  const lines = norm.split("\n");
  if (norm.endsWith("\n")) {
    lines.pop();
    hl.pop();
  }
  const frag = document.createDocumentFragment();
  lines.forEach((l, i) => {
    plain.push(l);
    const r = makeRow(i + 1, hl[i] ?? esc(l), l);
    rows.push(r);
    frag.append(r);
  });
  code.append(frag);
  show();
  done();
}

function show() {
  pre.hidden = true;
  code.hidden = false;
  gutter();
}

function gutter() {
  code.style.setProperty("--gw", `${String(Math.max(rows.length, 1)).length + 1}ch`);
}

function done() {
  const m = location.hash.match(/^#L(\d+)(?:-L?(\d+))?$/);
  if (m) {
    select(Number(m[1]), Number(m[2] ?? m[1]));
    rows[sel![0] - 1]?.scrollIntoView({ block: "center" });
  }
}

// ---------------------------------------------------------------- selection

function select(a: number, b: number) {
  const lo = Math.max(1, Math.min(a, b));
  const hi = Math.min(rows.length, Math.max(a, b));
  if (sel) for (let i = sel[0]; i <= sel[1]; i++) rows[i - 1]?.classList.remove("sel");
  sel = lo <= hi ? [lo, hi] : null;
  if (sel) for (let i = sel[0]; i <= sel[1]; i++) rows[i - 1]?.classList.add("sel");
  const hash = sel ? (sel[0] === sel[1] ? `#L${sel[0]}` : `#L${sel[0]}-L${sel[1]}`) : "";
  history.replaceState(null, "", hash || location.pathname + location.search);
  $("hash").textContent = hash;
}

code.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a.n");
  if (!a) return;
  e.preventDefault();
  const n = Number(a.textContent);
  if (e.shiftKey && anchor) select(anchor, n);
  else if (sel && sel[0] === n && sel[1] === n) {
    select(0, -1);
    anchor = 0;
  } else {
    anchor = n;
    select(n, n);
  }
});

// ---------------------------------------------------------------- actions

function toast(msg: string) {
  let t = document.querySelector<HTMLDivElement>(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => t!.classList.remove("on"), 1400));
}

async function copy() {
  const lines = sel ? plain.slice(sel[0] - 1, sel[1]) : plain;
  const text = lines.join("\n") + (lines.length ? "\n" : "");
  try {
    await navigator.clipboard.writeText(text);
    toast(sel ? `copied lines ${sel[0]}–${sel[1]}` : "copied");
  } catch {
    toast("couldn't copy");
  }
}

$("copy").addEventListener("click", copy);

const delKey = `bin:del:${data.id}`;
const delToken = localStorage.getItem(delKey);
if (delToken && !data.diff) {
  const del = $<HTMLButtonElement>("del");
  del.hidden = false;
  del.addEventListener("click", async () => {
    if (!confirm("Delete this paste for everyone?")) return;
    const res = await fetch(`/${data.id}`, { method: "DELETE", headers: { "x-delete": delToken } });
    if (res.ok || res.status === 404) {
      localStorage.removeItem(delKey);
      location.href = "/";
    } else toast("couldn't delete");
  });
}

if (localStorage.getItem("bin:wrap") === "1") document.body.classList.add("wrap-on");

const findBox = $<HTMLDivElement>("find");
const q = $<HTMLInputElement>("q");
let mode: "find" | "line" = "find";
let hits: number[] = [];
let hitAt = -1;

function openBox(m: "find" | "line") {
  mode = m;
  q.value = "";
  q.placeholder = m === "find" ? "find" : "go to line";
  $("count").textContent = "";
  findBox.hidden = false;
  q.focus();
}

function closeBox() {
  findBox.hidden = true;
  for (const n of hits) rows[n - 1]?.classList.remove("hit");
  hits = [];
}

q.addEventListener("input", () => {
  if (mode !== "find") return;
  for (const n of hits) rows[n - 1]?.classList.remove("hit");
  hits = [];
  hitAt = -1;
  const needle = q.value.toLowerCase();
  if (needle) plain.forEach((l, i) => l.toLowerCase().includes(needle) && hits.push(i + 1));
  for (const n of hits) rows[n - 1]?.classList.add("hit");
  $("count").textContent = needle ? `${hits.length}` : "";
});

q.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closeBox();
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (mode === "line") {
    const n = Number(q.value);
    if (n >= 1 && n <= rows.length) {
      anchor = n;
      select(n, n);
      rows[n - 1].scrollIntoView({ block: "center" });
    }
    return closeBox();
  }
  if (!hits.length) return;
  hitAt = (hitAt + (e.shiftKey ? -1 : 1) + hits.length) % hits.length;
  rows[hits[hitAt] - 1].scrollIntoView({ block: "center" });
  $("count").textContent = `${hitAt + 1}/${hits.length}`;
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select")) return;
  const go = (href: string | null) => href && (location.href = href);
  const actions: Record<string, () => unknown> = {
    y: copy,
    r: () => go(data.raw),
    d: () => go(data.dl),
    w: () => {
      const on = document.body.classList.toggle("wrap-on");
      localStorage.setItem("bin:wrap", on ? "1" : "0");
    },
    t: toggleTheme,
    "/": () => openBox("find"),
    g: () => openBox("line"),
    e: () => {
      sessionStorage.setItem("bin:draft", JSON.stringify({ text: plain.join("\n") + (plain.length ? "\n" : ""), name: data.name, lang: data.lang }));
      location.href = "/";
    },
    Escape: () => (findBox.hidden ? select(0, -1) : closeBox()),
  };
  const fn = actions[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});

// ---------------------------------------------------------------- start

function startLive(from: number) {
  let tries = 0;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/${data.id}/_live?from=${from}`);
    ws.onopen = () => (tries = 0);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string) as { append?: string; n?: number; sealed?: boolean; gone?: boolean };
      if (msg.sealed) return location.reload();
      if (msg.gone) return (document.body.dataset.gone = "1");
      if (msg.append === undefined) return;
      const stick = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
      appendText(msg.append);
      from = msg.n ?? from;
      const n = document.getElementById("nlines");
      if (n) n.textContent = `${plain.length.toLocaleString("en")} lines`;
      if (stick) window.scrollTo(0, document.documentElement.scrollHeight);
    };
    ws.onclose = () => {
      if (document.body.dataset.gone) return;
      if (++tries > 5) return location.reload();
      setTimeout(connect, 1000 * tries);
    };
  };
  connect();
}

if (data.enc) {
  const form = $<HTMLFormElement>("unlock");
  pre.hidden = true;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $<HTMLInputElement>("pw");
    try {
      const text = await decrypt(data.enc!, pw.value);
      form.remove();
      const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const meta = document.querySelector(".meta");
      meta?.insertAdjacentHTML("afterbegin", `<span>${n.toLocaleString("en")} lines</span>`);
      await render(text);
    } catch {
      $("pwerr").hidden = false;
      pw.select();
    }
  });
} else if (data.live !== undefined) {
  show();
  appendText(data.ansi ?? pre.textContent ?? "");
  startLive(data.live);
} else {
  render(data.ansi ?? pre.textContent ?? "");
}
