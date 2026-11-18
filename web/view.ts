import { asset, assets, gutter, hlModules, lineCount } from "../src/page";
import { highlight } from "./hl";
import { decrypt } from "./crypto";
import { ANSI_RE, dropStray, SGR_RE, stripAnsi, toLines, visible } from "../src/text";
import { toggleTheme } from "./theme";
import { setCookie, store, stored, toast } from "./ui";

declare const MD: boolean;

type Data = {
  id: string;
  ext: string;
  name: string;
  lang: string;
  enc?: string;
  src?: string;
  diff: boolean;
  hl?: string[] | null;
  raw: string | null;
  dl: string | null;
  etag?: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const data = JSON.parse($("data").textContent!) as Data;
const saved = history.state?.etag;
if (saved && saved !== data.etag) {
  history.replaceState(0, "");
  location.reload();
}
const pre = $<HTMLPreElement>("text");
const BLOCK = 256;
const CV_MIN = 1000;
const HL_INLINE = 50_000;
const MARGIN = 1500;

let plain: string[] = [];
let count = 0;
let ready = false;
let eol = true;
let sel: [number, number] | null = null;
let anchor = 0;

const esc = (s: string) => s.split("&").join("&amp;").split("<").join("&lt;");
const line = (n: number) => pre.children[(n - 1) >> 8]?.children[(n - 1) & (BLOCK - 1)] as HTMLElement | undefined;

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

function extended(n: number[]): number | string | null {
  const c = (v: number | undefined) => Math.min(255, Math.max(0, v ?? 0));
  if (n[0] === 5) return n[1] === undefined ? null : c(n[1]) < 16 ? c(n[1]) : xterm(c(n[1]));
  if (n[0] === 2) return `rgb(${c(n[1])},${c(n[2])},${c(n[3])})`;
  return null;
}

function sgr(st: Style, params: string) {
  const groups = params.split(";");
  for (let k = 0; k < groups.length; k++) {
    const sub = groups[k].split(":").map((x) => Number(x) || 0);
    const n = sub[0];
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
      let v: number | string | null;
      if (sub.length > 1) v = extended(sub[1] === 2 && sub.length > 5 ? [2, ...sub.slice(3)] : sub.slice(1));
      else {
        const rest = groups.slice(k + 1, k + 5).map((x) => Number(x) || 0);
        v = extended(rest);
        k += rest[0] === 5 ? 2 : rest[0] === 2 ? 4 : 0;
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

const TOKEN = new RegExp(`(${ANSI_RE.source})|([^\\x1b]+)`, "g");

function ansiLine(st: Style, raw: string, newline: boolean): string {
  const pieces: [Style, number, string][] = [];
  let text = "";
  for (const m of raw.matchAll(TOKEN)) {
    if (m[2] !== undefined) {
      pieces.push([{ ...st }, text.length, m[2]]);
      text += m[2];
    } else {
      const sg = SGR_RE.exec(m[1]);
      if (sg) sgr(st, sg[1]);
    }
  }
  const [from, to] = visible(text, newline);
  let out = "";
  for (const [style, at, piece] of pieces) {
    if (at + piece.length > from && at < to) out += span(style, dropStray(piece.slice(Math.max(0, from - at), to - at)));
  }
  return out;
}

// ---------------------------------------------------------------- highlight.js

function highlighted(mods: string[], text: string): Promise<string[] | null> {
  const inPage = () => highlight(mods, data.lang, text);
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(asset("hl-worker.js"), { type: "module" });
    } catch {
      return resolve(inPage());
    }
    w.onmessage = (e: MessageEvent<string[] | null>) => {
      w.terminate();
      resolve(e.data);
    };
    w.onerror = () => {
      w.terminate();
      resolve(inPage());
    };
    w.postMessage({ mods, lang: data.lang, text });
  });
}

// ---------------------------------------------------------------- rows

function rowClass(stripped: string): string {
  if (!(data.lang === "diff" || data.diff)) return "l";
  if (stripped.startsWith("+++") || stripped.startsWith("---") || /^(diff|index) /.test(stripped)) return "l dm";
  if (stripped.startsWith("@@")) return "l dh";
  if (stripped.startsWith("+")) return "l da";
  if (stripped.startsWith("-")) return "l dd";
  return "l";
}

const row = (stripped: string, inner: string) => `<span class="${rowClass(stripped)}">${inner || "\n"}</span>`;
const block = (start: number, rows: string, size: number) =>
  `<div class="b" style="--n:${start}${size < BLOCK ? `;contain-intrinsic-block-size:${size * 24}px` : ""}">${rows}</div>`;

function columns(s: string): number {
  if (!/[\t\u1100-\uffff]/.test(s)) return s.length;
  let c = 0;
  for (const ch of s) {
    if (ch === "\t") c += 8 - (c % 8);
    else c += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff]/.test(ch) ? 2 : 1;
  }
  return c;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let lines: string[] = [];
let ansi = false;
let hlRows: string[] | null = null;
let starts: Style[] = [];
let painted: boolean[] = [];
let io: IntersectionObserver | null = null;

function scan(st: Style, text: string) {
  for (const m of text.matchAll(ANSI_RE)) {
    const sg = SGR_RE.exec(m[0]);
    if (sg) sgr(st, sg[1]);
  }
}

function paint(i: number) {
  const b = pre.children[i] as HTMLElement | undefined;
  if (!b) return;
  const lo = i * BLOCK;
  const hi = Math.min(count, lo + BLOCK);
  const st = ansi ? { ...starts[i] } : fresh();
  let rows = "";
  for (let k = lo; k < hi; k++) rows += row(plain[k], ansi ? ansiLine(st, lines[k], k < count - 1 || eol) : hlRows ? (hlRows[k] ?? esc(plain[k])) : esc(plain[k]));
  b.innerHTML = rows;
  painted[i] = true;
  io?.unobserve(b);
  if (sel && sel[0] <= hi && sel[1] > lo) mark(Math.max(lo + 1, sel[0]), Math.min(hi, sel[1]), "sel", true);
  for (const n of hits) if (n > lo && n <= hi) line(n)?.classList.add("hit");
}

function topRow(): Element | undefined {
  for (const b of pre.children) {
    if (b.getBoundingClientRect().bottom <= 0) continue;
    return [...b.children].find((l) => l.getBoundingClientRect().bottom > 0) ?? b;
  }
}

function rewrap() {
  const top = topRow();
  const was = top?.getBoundingClientRect().top ?? 0;
  const on = document.body.classList.toggle("wrap-on");
  setCookie("wrap", on ? "1" : "0");
  if (top) scrollBy(0, top.getBoundingClientRect().top - was);
  if (io) painted.forEach((done, i) => {
    const b = pre.children[i] as HTMLElement;
    const r = b.getBoundingClientRect();
    if (!done || (r.bottom > -MARGIN && r.top < innerHeight + MARGIN)) return;
    b.textContent = plain.slice(i * BLOCK, (i + 1) * BLOCK).join("\n") + "\n";
    painted[i] = false;
    io!.observe(b);
  });
}

function reveal(n: number) {
  const i = (n - 1) >> 8;
  if (!painted[i]) paint(i);
  line(n)?.scrollIntoView({ block: "center" });
}

async function fill() {
  const st = fresh();
  const out: string[] = [];
  const lazy = count > CV_MIN;
  let widest = 0;
  let t = performance.now();
  starts = [];
  for (let i = 0; i < count; i += BLOCK) {
    const end = Math.min(count, i + BLOCK);
    if (ansi) {
      starts.push({ ...st });
      for (let k = i; k < end; k++) scan(st, lines[k]);
    }
    for (let k = i; k < end; k++) widest = Math.max(widest, columns(plain[k]));
    out.push(block(i, lazy ? esc(plain.slice(i, end).join("\n") + "\n") : "", end - i));
    if (performance.now() - t > 30) {
      await tick();
      t = performance.now();
    }
  }
  if (lazy) {
    pre.style.setProperty("--cw", `${widest}ch`);
    pre.classList.add("cv");
  }
  io?.disconnect();
  pre.innerHTML = out.join("");
  painted = [];
  if (!lazy) {
    for (let i = 0; i * BLOCK < count; i++) paint(i);
    return;
  }
  for (let i = 0; i * BLOCK < count && i * BLOCK * 24 < innerHeight + MARGIN; i++) paint(i);
  const blocks = [...pre.children];
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) paint(blocks.indexOf(e.target));
    },
    { rootMargin: `${MARGIN}px 0px` },
  );
  blocks.forEach((b, i) => painted[i] || io!.observe(b));
}

async function render(raw: string) {
  hlRows = null;
  ({ raw: lines, plain, eol } = toLines(raw));
  ansi = raw.includes("\x1b");
  count = lines.length;
  ready = true;
  if (MD) {
    source = raw;
    if (fmt()) return void (/^#L\d/.test(location.hash) ? show(false) : formatted(history.state?.md));
    built = true;
  }
  const mods = ansi ? null : data.hl === undefined ? hlModules(data.lang, raw) : data.hl;
  const text = mods ? plain.join("\n") : "";
  if (mods && mods.length > 1 && text.length < HL_INLINE) hlRows = await highlight(mods, data.lang, text);
  const colored = mods && !hlRows ? highlighted(mods, text) : null;
  await fill();
  fromHash();
  const hl = await colored;
  if (!hl) return;
  hlRows = hl;
  painted.forEach((on, i) => on && paint(i));
}

// ---------------------------------------------------------------- markdown

let source = "";
let built = false;
let md: Promise<typeof import("./md") | null> | null = null;
let mod: typeof import("./md") | null = null;
const fmt = () => MD && document.body.classList.contains("fmt");

function formatted(at?: number) {
  return (md ??= import(asset("md.js"))
    .then(async (m: typeof import("./md")) => {
      mod = m;
      const links = [...document.querySelectorAll<HTMLAnchorElement>(".tabs a")].map((a) => a.pathname);
      await m.mount(pre, source, { assets, base: location.pathname, links: links.length ? links : undefined }, at);
      return m;
    })
    .catch(() => {
      md = null;
      if (fmt()) show(false);
      toast("couldn't format this");
      return null;
    }));
}

function topLine(): number | null {
  const r = topRow();
  if (!r) return null;
  const b = r.classList.contains("b") ? r : r.parentElement!;
  const at = (p: Element, c: Element) => Array.prototype.indexOf.call(p.children, c) as number;
  const n = r === b ? Math.min(BLOCK, count - at(pre, b) * BLOCK) : 1;
  const box = r.getBoundingClientRect();
  return at(pre, b) * BLOCK + (r === b ? 0 : at(b, r)) + 1 + Math.max(0, -box.top / box.height) * n;
}

function lineY(at: number): number | null {
  const n = Math.min(count, Math.floor(at));
  if (n < 1) return null;
  if (!painted[(n - 1) >> 8]) paint((n - 1) >> 8);
  const r = line(n)?.getBoundingClientRect();
  return r ? r.top + scrollY + Math.min(1, at - n) * r.height : null;
}

async function show(on: boolean, keep = false) {
  if (!loaded()) return;
  const was = scrollY > 0 && (on || !/^#L\d/.test(location.hash)) ? (fmt() ? (mod?.top() ?? null) : built ? topLine() : null) : null;
  document.body.classList.toggle("fmt", on);
  $("mdv").title = `${on ? "Source" : "Formatted"} (m)`;
  if (keep) setCookie("md", on ? "1" : "0");
  if (on && sel) select(0, -1);
  let y: number | null = null;
  if (on) {
    const m = await formatted();
    if (!fmt()) return;
    y = was && m && m.y(was);
  } else {
    if (!built) await render(source);
    if (fmt()) return;
    y = was && lineY(was);
  }
  if (y !== null) scrollTo(0, y);
  remember();
}

function remember() {
  const at = fmt() && scrollY > 0 ? mod?.top() : null;
  history.replaceState({ ...history.state, md: at }, "");
  history.scrollRestoration = at ? "manual" : "auto";
}

if (MD) {
  let wait = 0;
  addEventListener("scroll", () => {
    clearTimeout(wait);
    wait = setTimeout(remember, 300);
  });
  addEventListener("pagehide", remember);
}

// ---------------------------------------------------------------- selection

function mark(a: number, b: number, cls: string, on: boolean) {
  for (let i = a; i <= b; i++) line(i)?.classList.toggle(cls, on);
}

function select(a: number, b: number) {
  const lo = Math.max(1, Math.min(a, b));
  const hi = Math.min(count, Math.max(a, b));
  if (sel) mark(sel[0], sel[1], "sel", false);
  sel = lo <= hi ? [lo, hi] : null;
  if (sel) mark(sel[0], sel[1], "sel", true);
  const hash = sel ? (sel[0] === sel[1] ? `#L${sel[0]}` : `#L${sel[0]}-L${sel[1]}`) : "";
  history.replaceState(history.state, "", hash || location.pathname + location.search);
  $("hash").textContent = hash;
}

function fromHash() {
  const m = location.hash.match(/^#L(\d+)(?:-L?(\d+))?$/);
  if (!m || !count) return;
  if (MD && fmt()) return void show(false).then(fromHash);
  anchor = Number(m[1]);
  select(anchor, Number(m[2] ?? m[1]));
  if (sel) reveal(sel[0]);
}

addEventListener("hashchange", fromHash);

pre.addEventListener("click", (e) => {
  const l = (e.target as HTMLElement).closest<HTMLElement>(".l");
  if (!l || e.clientX - l.getBoundingClientRect().left > parseFloat(getComputedStyle(l).paddingLeft)) return;
  const b = l.parentElement!;
  const n = Array.prototype.indexOf.call(pre.children, b) * BLOCK + Array.prototype.indexOf.call(b.children, l) + 1;
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

const textOf = (a: number, b: number) => plain.slice(a - 1, b).join("\n") + (b >= a && (b < count || eol) ? "\n" : "");

function loaded(): boolean {
  if (!ready) toast(document.getElementById("unlock") ? "unlock it first" : "still loading");
  return ready;
}

async function copy() {
  if (!loaded()) return;
  try {
    await navigator.clipboard.writeText(sel ? textOf(sel[0], sel[1]) : textOf(1, count));
    toast(sel ? `copied lines ${sel[0]}–${sel[1]}` : "copied");
  } catch {
    toast("couldn't copy");
  }
}

$("copy").addEventListener("click", copy);

const delKey = `bin:del:${data.id}`;
const delToken = stored("localStorage", delKey);
const canEdit = delToken && data.etag;
if (delToken && !data.diff) {
  const del = $<HTMLButtonElement>("del");
  $(canEdit ? "edit" : "del").hidden = false;
  del.addEventListener("click", async () => {
    if (!confirm("Delete this paste for everyone?")) return;
    const res = await fetch(`/${data.id}`, { method: "DELETE", headers: { "x-delete": delToken } });
    if (res.ok || res.status === 404) {
      store("localStorage", delKey, null);
      location.href = "/";
    } else toast("couldn't delete");
  });
}

async function edit() {
  if (!loaded()) return;
  const was = MD && fmt();
  if (MD && was) await show(false);
  const m: typeof import("./edit") = await import(asset("edit.js"));
  m.open(pre, textOf(1, count), data, delToken!, MD ? (text) => ((md = null), render(text)) : render, MD && was && (() => show(true)));
}

$("edit").onclick = edit;

const findBox = $<HTMLDivElement>("find");
const q = $<HTMLInputElement>("q");
let mode: "find" | "line" = "find";
let hits: number[] = [];
let hitAt = -1;
let findTimer = 0;

function clearHits() {
  for (const n of hits) line(n)?.classList.remove("hit");
  hits = [];
  hitAt = -1;
}

function openBox(m: "find" | "line") {
  mode = m;
  q.value = "";
  q.placeholder = m === "find" ? "find" : "go to line";
  q.enterKeyHint = m === "find" ? "next" : "go";
  $("count").textContent = "";
  findBox.hidden = false;
  q.focus();
}

function closeBox() {
  findBox.hidden = true;
  clearTimeout(findTimer);
  clearHits();
}

function runFind() {
  findTimer = 0;
  clearHits();
  const needle = q.value.toLowerCase();
  if (needle) plain.forEach((l, i) => l.toLowerCase().includes(needle) && hits.push(i + 1));
  for (const n of hits) line(n)?.classList.add("hit");
  $("count").textContent = needle ? `${hits.length}` : "";
}

q.addEventListener("input", () => {
  if (mode !== "find") return;
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 150);
});

q.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closeBox();
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (mode === "line") {
    const n = Number(q.value);
    if (Number.isSafeInteger(n) && n >= 1 && n <= count) {
      anchor = n;
      select(n, n);
      reveal(n);
    }
    return closeBox();
  }
  if (findTimer) {
    clearTimeout(findTimer);
    runFind();
  }
  if (!hits.length) return;
  hitAt = (hitAt + (e.shiftKey ? -1 : 1) + hits.length) % hits.length;
  reveal(hits[hitAt]);
  $("count").textContent = `${hitAt + 1}/${hits.length}`;
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement).closest("input, textarea, select")) return;
  const go = (href: string | null) => href && (location.href = href);
  const actions: Record<string, () => unknown> = {
    y: copy,
    r: () => go(data.raw),
    d: () => go(data.dl),
    w: rewrap,
    t: toggleTheme,
    "/": () => openBox("find"),
    g: () => openBox("line"),
    e: () => (canEdit ? edit() : actions.E()),
    E: () => {
      if (!loaded()) return;
      if (store("sessionStorage", "bin:draft", JSON.stringify({ text: textOf(1, count), name: data.name, lang: data.lang }))) location.href = "/";
      else toast("couldn't open this in the editor");
    },
    Escape: () => (findBox.hidden ? (!MD || sel) && select(0, -1) : closeBox()),
  };
  if (MD) actions.m = () => show(!fmt(), true);
  if (MD && fmt() && e.key === "w") return;
  const fn = actions[e.key];
  if (!fn) return;
  e.preventDefault();
  if (MD && fmt() && (e.key === "/" || e.key === "g")) show(false);
  fn();
});

document.querySelector(".foot")!.addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-k]")?.dataset.k;
  if (key) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});
$("qx").addEventListener("click", closeBox);
if (MD) $("mdv").addEventListener("click", () => show(!fmt(), true));

// ---------------------------------------------------------------- start

const load = (src: string) => fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
const form = document.querySelector<HTMLFormElement>("#unlock");

if (form) {
  const envelope = data.enc ?? load(data.src!).catch(() => null);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $<HTMLInputElement>("pw");
    const btn = form.querySelector("button")!;
    if (btn.disabled) return;
    btn.disabled = true;
    $("pwerr").hidden = true;
    const env = await envelope;
    if (env === null) {
      btn.disabled = false;
      return toast("couldn't load this paste");
    }
    let text: string;
    try {
      text = await decrypt(env, pw.value);
    } catch {
      btn.disabled = false;
      $("pwerr").hidden = false;
      return pw.select();
    }
    const n = toLines(text).plain.length;
    form.remove();
    document.querySelector(".meta")!.insertAdjacentHTML("beforeend", lineCount(n));
    pre.style.setProperty("--gw", gutter(n));
    pre.textContent = stripAnsi(text);
    pre.hidden = false;
    await render(text);
  });
} else {
  const source = data.src
    ? load(data.src)
    : Promise.resolve(document.querySelector<HTMLTemplateElement>("#ansi")?.content.textContent ?? pre.textContent ?? "");
  source.then(render, () => toast("couldn't load this paste"));
}
