import { asset, gutter, hlModules, lineCount } from "../src/page";
import { highlight } from "./hl";
import { decrypt } from "./crypto";
import { ANSI_RE, dropStray, SGR_RE, stripAnsi, toLines, visible } from "../src/text";
import { toggleTheme } from "./theme";
import { setCookie, store, stored, toast } from "./ui";

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
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const data = JSON.parse($("data").textContent!) as Data;
const pre = $<HTMLPreElement>("text");
const BLOCK = 256;
const CV_MIN = 1000;
const HITS_MAX = 5000;
const HL_INLINE = 50_000;
const MARGIN = 1500;

let plain: string[] = [];
let count = 0;
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
  for (const n of hits.slice(0, HITS_MAX)) if (n > lo && n <= hi) line(n)?.classList.add("hit");
}

function rewrap() {
  const on = document.body.classList.toggle("wrap-on");
  setCookie("wrap", on ? "1" : "0");
  if (!io) return;
  painted.forEach((done, i) => {
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
  ({ raw: lines, plain, eol } = toLines(raw));
  ansi = raw.includes("\x1b");
  count = lines.length;
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
  if (!m) return;
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

async function copy() {
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
if (delToken && !data.diff) {
  const del = $<HTMLButtonElement>("del");
  del.hidden = false;
  del.addEventListener("click", async () => {
    if (!confirm("Delete this paste for everyone?")) return;
    const res = await fetch(`/${data.id}`, { method: "DELETE", headers: { "x-delete": delToken } });
    if (res.ok || res.status === 404) {
      store("localStorage", delKey, null);
      location.href = "/";
    } else toast("couldn't delete");
  });
}

const findBox = $<HTMLDivElement>("find");
const q = $<HTMLInputElement>("q");
let mode: "find" | "line" = "find";
let hits: number[] = [];
let hitAt = -1;
let findTimer = 0;

function clearHits() {
  for (const n of hits.slice(0, HITS_MAX)) line(n)?.classList.remove("hit");
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

q.addEventListener("input", () => {
  if (mode !== "find") return;
  clearTimeout(findTimer);
  findTimer = setTimeout(() => {
    clearHits();
    const needle = q.value.toLowerCase();
    if (needle) plain.forEach((l, i) => l.toLowerCase().includes(needle) && hits.push(i + 1));
    for (const n of hits.slice(0, HITS_MAX)) line(n)?.classList.add("hit");
    $("count").textContent = needle ? `${hits.length}` : "";
  }, 150);
});

q.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closeBox();
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (mode === "line") {
    const n = Number(q.value);
    if (n >= 1 && n <= count) {
      anchor = n;
      select(n, n);
      reveal(n);
    }
    return closeBox();
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
    e: () => {
      if (store("sessionStorage", "bin:draft", JSON.stringify({ text: textOf(1, count), name: data.name, lang: data.lang }))) location.href = "/";
      else toast("couldn't open this in the editor");
    },
    Escape: () => (findBox.hidden ? select(0, -1) : closeBox()),
  };
  const fn = actions[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});

document.querySelector(".foot")!.addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-k]")?.dataset.k;
  if (key) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});
$("qx").addEventListener("click", closeBox);

// ---------------------------------------------------------------- start

if (data.enc) {
  const form = $<HTMLFormElement>("unlock");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $<HTMLInputElement>("pw");
    const btn = form.querySelector("button")!;
    if (btn.disabled) return;
    btn.disabled = true;
    $("pwerr").hidden = true;
    let text: string;
    try {
      text = await decrypt(data.enc!, pw.value);
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
    ? fetch(data.src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    : Promise.resolve(document.querySelector<HTMLTemplateElement>("#ansi")?.content.textContent ?? pre.textContent ?? "");
  source.then(render, () => toast("couldn't load this paste"));
}
