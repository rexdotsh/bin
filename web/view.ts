import { gutter, hlModules } from "../src/page";
import { decrypt } from "./crypto";
import { plainLine, segments, splitLines } from "./text";
import { toggleTheme } from "./theme";

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

type Hljs = {
  registerLanguage(name: string, lang: unknown): void;
  highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string };
  highlightAuto(code: string): { value: string; relevance: number };
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const data = JSON.parse($("data").textContent!) as Data;
const pre = $<HTMLPreElement>("text");
const BLOCK = 256;
const CV_MIN = 1000;
const HITS_MAX = 5000;

let plain: string[] = [];
let count = 0;
let sel: [number, number] | null = null;
let anchor = 0;

const esc = (s: string) => s.split("&").join("&amp;").split("<").join("&lt;");
const line = (n: number) => pre.children[(n - 1) >> 8]?.children[(n - 1) & (BLOCK - 1)] as HTMLElement | undefined;
const load = (path: string) => import(path);

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

function ansiLine(st: Style, text: string): string {
  const parts = segments(text);
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
  let cur = "";
  for (const m of htmlText.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else cur += m[4];
  }
  out.push(cur);
  return out;
}

async function highlighted(raw: string): Promise<string[] | null> {
  const mods = data.hl === undefined ? hlModules(data.lang, raw) : data.hl;
  if (!mods) return null;
  const text = plain.join("\n");
  try {
    const [core, grammar] = await Promise.all(mods.map(load));
    const hljs = core.default as Hljs;
    if (grammar) {
      hljs.registerLanguage(data.lang, grammar.default);
      return splitHtml(hljs.highlight(text, { language: data.lang, ignoreIllegals: true }).value);
    }
    const auto = hljs.highlightAuto(text);
    return auto.relevance < 10 ? null : splitHtml(auto.value);
  } catch {
    return null;
  }
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

const row = (stripped: string, inner: string) => `<span class="${rowClass(stripped)}">${inner}</span>`;
const block = (start: number, rows: string, size: number) =>
  `<div class="b" style="counter-reset:n ${start}${size < BLOCK ? `;contain-intrinsic-block-size:auto ${size * 24}px` : ""}">${rows}</div>`;

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

async function render(raw: string) {
  const lines = splitLines(raw);
  const ansi = raw.includes("\x1b");
  plain = lines.map(plainLine);
  const hl = ansi ? null : await highlighted(raw);
  const st = fresh();
  const out: string[] = [];
  let widest = 0;
  let t = performance.now();
  for (let i = 0; i < lines.length; i += BLOCK) {
    const end = Math.min(lines.length, i + BLOCK);
    let rows = "";
    for (let k = i; k < end; k++) {
      rows += row(plain[k], ansi ? ansiLine(st, lines[k]) : hl ? (hl[k] ?? esc(plain[k])) : esc(plain[k]));
      widest = Math.max(widest, columns(plain[k]));
    }
    out.push(block(i, rows, end - i));
    if (performance.now() - t > 30) {
      await tick();
      t = performance.now();
    }
  }
  if (lines.length > CV_MIN) {
    pre.style.setProperty("--cw", `${widest}ch`);
    pre.classList.add("cv");
  }
  pre.innerHTML = out.join("");
  count = lines.length;
  fromHash();
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
  select(Number(m[1]), Number(m[2] ?? m[1]));
  if (sel) line(sel[0])?.scrollIntoView({ block: "center" });
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

function toast(msg: string) {
  let t = document.querySelector<HTMLDivElement>(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => t!.classList.remove("on"), 1400));
}

const allText = (lines: string[]) => lines.join("\n") + (lines.length ? "\n" : "");

async function copy() {
  try {
    await navigator.clipboard.writeText(allText(sel ? plain.slice(sel[0] - 1, sel[1]) : plain));
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
      line(n)?.scrollIntoView({ block: "center" });
    }
    return closeBox();
  }
  if (!hits.length) return;
  hitAt = (hitAt + (e.shiftKey ? -1 : 1) + hits.length) % hits.length;
  line(hits[hitAt])?.scrollIntoView({ block: "center" });
  $("count").textContent = `${hitAt + 1}/${hits.length}`;
});

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.target as HTMLElement).closest("input, textarea, select")) return;
  const go = (href: string | null) => href && (location.href = href);
  const actions: Record<string, () => unknown> = {
    y: copy,
    r: () => go(data.raw),
    d: () => go(data.dl),
    w: () => setCookie("wrap", document.body.classList.toggle("wrap-on") ? "1" : "0"),
    t: toggleTheme,
    "/": () => openBox("find"),
    g: () => openBox("line"),
    e: () => {
      try {
        sessionStorage.setItem("bin:draft", JSON.stringify({ text: allText(plain), name: data.name, lang: data.lang }));
        location.href = "/";
      } catch {
        toast("too big to edit here");
      }
    },
    Escape: () => (findBox.hidden ? select(0, -1) : closeBox()),
  };
  const fn = actions[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});

// ---------------------------------------------------------------- start

if (data.enc) {
  const form = $<HTMLFormElement>("unlock");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $<HTMLInputElement>("pw");
    try {
      const text = await decrypt(data.enc!, pw.value);
      const n = splitLines(text).length;
      form.remove();
      document.querySelector(".meta")!.insertAdjacentHTML("beforeend", `<span>${n.toLocaleString("en")} lines</span>`);
      pre.style.setProperty("--gw", gutter(n));
      pre.textContent = `\n${splitLines(text).map(plainLine).join("\n")}`;
      pre.hidden = false;
      await render(text);
    } catch {
      $("pwerr").hidden = false;
      pw.select();
    }
  });
} else {
  const source = data.src
    ? fetch(data.src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    : Promise.resolve(document.querySelector<HTMLTemplateElement>("#ansi")?.content.textContent ?? pre.textContent ?? "");
  source.then(render, () => toast("couldn't load this paste"));
}
