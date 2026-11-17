import { Lexer, type Tokens } from "marked";

type T = Tokens.Generic;
type Hljs = { registerLanguage(name: string, lang: unknown): void; highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string } };
type Out = { html: string[]; lines: number[]; end: number };
type Assets = Record<string, string>;
type Parts = [string, string[], string];

const WORKER_MIN = 64 * 1024;
const CHUNK = 32 * 1024;
const ALIAS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", golang: "go", rb: "ruby", kt: "kotlin", "c++": "cpp", cc: "cpp", hpp: "cpp", h: "c", cs: "csharp", "c#": "csharp",
  sh: "bash", shell: "bash", zsh: "bash", jsonc: "json", yml: "yaml", toml: "ini", md: "markdown", html: "xml", htm: "xml", svg: "xml", vue: "xml",
  pl: "perl", gql: "graphql", docker: "dockerfile", make: "makefile", mk: "makefile",
};
const REL = ' rel="noopener noreferrer nofollow ugc"';
const IMG = ' loading="lazy" decoding="async" referrerpolicy="no-referrer"';
const TAGS = new Set("a b blockquote br code del details div em h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre s small span strong sub summary sup table tbody td tfoot th thead tr u ul".split(" "));
const DROP = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|noscript|iframe|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG = /<(\/?)([a-z][a-z\d]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

let ents: Record<string, string> = {};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const decode = (s: string) =>
  s.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|[a-z][a-z\d]{1,31});/gi, (m, d?: string, x?: string) => {
    if (!d && !x) return ents[m] ?? m;
    const n = d ? Number(d) : parseInt(x!, 16);
    return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
  });
const txt = (s: string) => esc(decode(s));
const shut = (open: string[]) => open.splice(0).reverse().map((n) => `</${n}>`).join("");

function entities(text: string): Record<string, string> {
  const names = [...new Set(text.match(/&[a-z][a-z\d]{1,31};/gi))];
  const t = document.createElement("textarea");
  t.innerHTML = names.join("\x01");
  const vals = t.value.split("\x01");
  const map: Record<string, string> = {};
  names.forEach((n, i) => vals[i] !== n && vals[i].length <= 2 && (map[n] = vals[i]));
  return map;
}

function url(href: string, img?: boolean): string | null {
  const s = decode(href).trim();
  if (!img && s[0] === "#") return `#md-${s.slice(1)}`;
  if (!(img ? /^https:/i : /^(?:https?|mailto):/i).test(s)) return null;
  try {
    const u = new URL(s);
    return /^(?:https?|mailto):$/.test(u.protocol) && (!img || u.protocol === "https:") ? u.href : null;
  } catch {
    return null;
  }
}

function attr(tag: string, k: string, v: string): string {
  if ((tag === "a" && k === "href") || (tag === "img" && k === "src")) {
    const u = url(v, tag === "img");
    return u ? ` ${k}="${esc(u)}"` : "";
  }
  v = v.trim();
  if (k === "alt" || k === "title") return ` ${k}="${txt(v)}"`;
  if (tag === "img" && (k === "width" || k === "height") && /^\d{1,4}%?$/.test(v)) return ` ${k}="${v}"`;
  if (k === "align" && /^(?:left|center|right)$/i.test(v)) return ` class="al-${v.toLowerCase()}"`;
  return tag === "details" && k === "open" ? " open" : "";
}

function tags(s: string, open: string[]): string {
  let o = "";
  let at = 0;
  s = s.replace(DROP, "");
  for (const m of s.matchAll(TAG)) {
    o += txt(s.slice(at, m.index));
    at = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (!TAGS.has(name)) continue;
    if (m[1]) {
      const i = open.lastIndexOf(name);
      if (i >= 0) o += shut(open.splice(i));
      continue;
    }
    const seen: Record<string, string> = {};
    for (const [, k, ...v] of m[3].matchAll(ATTR)) seen[k.toLowerCase()] ??= v.find((x) => x !== undefined) ?? "";
    const attrs = Object.entries(seen).map(([k, v]) => attr(name, k, v)).join("");
    if (name === "img") o += attrs.includes(' src="') ? `<img${attrs}${IMG}>` : "";
    else o += `<${name}${attrs}${name === "a" && attrs.includes(' href="') ? REL : ""}>`;
    if (!/^(?:br|hr|img)$/.test(name)) open.push(name);
  }
  return o + txt(s.slice(at));
}

const plain = (ts: T[] = []): string =>
  ts.map((t) => (t.tokens ? plain(t.tokens) : t.type === "text" ? decode(t.text) : t.type === "escape" || t.type === "codespan" ? t.text : "")).join("");
const fence = (info?: string) => {
  const l = decode(info ?? "").trim().split(/\s/)[0].toLowerCase();
  return Object.hasOwn(ALIAS, l) ? ALIAS[l] : l;
};

function inline(ts: T[] = []): string {
  const open: string[] = [];
  let o = "";
  for (const t of ts) {
    switch (t.type) {
      case "text":
        o += t.tokens ? inline(t.tokens) : txt(t.text);
        break;
      case "strong":
      case "em":
      case "del":
        o += `<${t.type}>${inline(t.tokens)}</${t.type}>`;
        break;
      case "codespan":
        o += `<code>${esc(t.text)}</code>`;
        break;
      case "br":
        o += "<br>";
        break;
      case "html":
        o += tags(t.text, open);
        break;
      case "checkbox":
        break;
      case "link": {
        const h = url(t.href);
        const inner = inline(t.tokens);
        o += h ? `<a href="${esc(h)}"${t.title ? ` title="${txt(t.title)}"` : ""}${REL}>${inner}</a>` : inner;
        break;
      }
      case "image": {
        const s = url(t.href, true);
        const alt = esc(t.tokens ? plain(t.tokens) : decode(t.text));
        o += s ? `<img src="${esc(s)}" alt="${alt}"${t.title ? ` title="${txt(t.title)}"` : ""}${IMG}>` : alt;
        break;
      }
      default:
        o += esc(typeof t.text === "string" ? t.text : t.raw);
    }
  }
  return o + shut(open);
}

function cut(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  for (let at = 0; at < html.length; ) {
    const end = html.indexOf("\n", at + CHUNK) + 1 || html.length;
    const s = html.slice(at, end);
    const pre = open.join("");
    for (const m of s.matchAll(/<(\/?)span[^>]*>/g)) m[1] ? open.pop() : open.push(m[0]);
    out.push(pre + s + "</span>".repeat(open.length));
    at = end;
  }
  return out;
}

function render(tokens: T[], hl: ((code: string, lang: string) => string | null) | null): Out {
  const used = new Set<string>();
  const seen = new Map<string, number>();
  const cell = (tag: string, c: T) => `<${tag}${c.align === "center" ? ' class="c"' : c.align === "right" ? ' class="r"' : ""}>${inline(c.tokens)}</${tag}>`;
  const each = (ts: T[]): string[] => {
    const out: string[] = [];
    const open: string[] = [];
    for (const t of ts) {
      const deep = open.length > 0;
      const h = block(t, open);
      if (deep) out[out.length - 1] += h;
      else if (h) out.push(h);
    }
    if (open.length) out[out.length - 1] += shut(open);
    return out;
  };
  const big = (t: T): Parts | null => {
    switch (t.type) {
      case "list": {
        const tag = t.ordered ? "ol" : "ul";
        const start = Number(t.start);
        const items = t.items.map((i: T) => {
          const body = each(i.tokens!).join("");
          return i.task ? `<li class="t"><span class="box${i.checked ? " x" : ""}"></span><div${i.checked ? ' class="done"' : ""}>${body}</div></li>` : `<li>${body}</li>`;
        });
        return [`<${tag}${t.ordered && Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ""}>`, items, `</${tag}>`];
      }
      case "table":
        return [
          `<div class="tw"><table><thead><tr>${t.header.map((c: T) => cell("th", c)).join("")}</tr></thead><tbody>`,
          t.rows.map((r: T[]) => `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`),
          "</tbody></table></div>",
        ];
      case "blockquote":
        return ["<blockquote>", each(t.tokens!), "</blockquote>"];
      case "code": {
        const lang = t.codeBlockStyle ? "" : fence(t.lang);
        const code = (lang && hl && hl(t.text, lang)) || esc(t.text);
        const open = `<code${lang && !hl ? ` data-hl="${esc(lang)}"` : ""}>`;
        return code.length > CHUNK ? ["<pre>", cut(code).map((c) => `<div>${open}${c}</code></div>`), "</pre>"] : [`<pre>${open}`, [code], "</code></pre>"];
      }
    }
    return null;
  };
  const block = (t: T, open: string[] = []): string => {
    const p = big(t);
    if (p) return p[0] + p[1].join("") + p[2];
    switch (t.type) {
      case "paragraph": {
        const h = inline(t.tokens);
        return h && `<p>${h}</p>`;
      }
      case "text":
        return t.tokens ? inline(t.tokens) : txt(t.text);
      case "heading": {
        const d = Math.min(6, Math.max(1, Number(t.depth) || 1));
        const base = plain(t.tokens).toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
        let n = seen.get(base) ?? 0;
        let id = base;
        while (used.has(id)) id = `${base}-${++n}`;
        seen.set(base, n);
        used.add(id);
        return `<h${d} id="md-${esc(id)}">${inline(t.tokens)}</h${d}>`;
      }
      case "html":
        return tags(t.text, open);
      case "hr":
        return "<hr>";
      case "space":
      case "def":
      case "checkbox":
        return "";
      default:
        return `<p>${esc(t.raw)}</p>`;
    }
  };
  const out: Out = { html: [], lines: [], end: 1 };
  const open: string[] = [];
  let line = 1;
  for (const t of tokens) {
    const at = line + (t.raw.match(/^\n*/)?.[0].length ?? 0);
    line += t.raw.split("\n").length - 1;
    const last = out.html.length - 1;
    if (open.length && out.html[last].length < 2 * CHUNK) {
      out.html[last] += block(t, open);
      continue;
    }
    if (open.length) out.html[last] += shut(open);
    const p = big(t);
    const html = p ? p[0] + p[1].join("") + p[2] : t.type === "text" ? `<p>${block(t)}</p>` : block(t, open);
    if (!html) continue;
    out.lines.push(at);
    if (!p || html.length <= CHUNK) out.html.push(html);
    else {
      out.html.push(`<div>${p[0]}${p[2]}</div>`);
      for (const k of p[1]) {
        out.html.push(k);
        out.lines.push(0);
      }
    }
  }
  if (open.length) out.html[out.html.length - 1] += shut(open);
  out.end = line + 1;
  return out;
}

function langsOf(ts: T[], assets: Assets, found = new Set<string>()): Set<string> {
  for (const t of ts) {
    if (t.type === "code" && !t.codeBlockStyle) {
      const l = fence(t.lang);
      if (/^[a-z]+$/.test(l) && l !== "core" && l !== "auto" && assets[`hl/${l}.js`]) found.add(l);
    }
    if (t.tokens) langsOf(t.tokens, assets, found);
    if (t.items) langsOf(t.items, assets, found);
  }
  return found;
}

async function hljs(langs: Set<string>, assets: Assets): Promise<Hljs | null> {
  if (!langs.size) return null;
  try {
    const core = (await import(assets["hl/core.js"])).default as Hljs;
    await Promise.all([...langs].map(async (l) => core.registerLanguage(l, (await import(assets[`hl/${l}.js`])).default)));
    return core;
  } catch {
    return null;
  }
}

const paint = (core: Hljs) => (code: string, language: string) => {
  try {
    return core.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
};

if (typeof document === "undefined") {
  addEventListener("message", async (e: MessageEvent<{ text: string; assets: Assets; ents: Record<string, string> }>) => {
    let out: Out | null = null;
    try {
      ents = e.data.ents;
      const tokens = Lexer.lex(e.data.text) as T[];
      const core = await hljs(langsOf(tokens, e.data.assets), e.data.assets);
      out = render(tokens, core && paint(core));
    } catch {}
    postMessage(out);
  });
}

function offThread(text: string, assets: Assets, src: string): Promise<Out | null | undefined> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(src, { type: "module" });
    } catch {
      return resolve(undefined);
    }
    const done = (out?: Out | null) => {
      clearTimeout(timer);
      w.terminate();
      resolve(out);
    };
    const timer = setTimeout(done, 3000 + text.length / 1000, null);
    w.onmessage = (e: MessageEvent<Out | null>) => done(e.data);
    w.onerror = () => done();
    w.postMessage({ text, assets, ents });
  });
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

let blocks: HTMLCollection | null = null;
let starts: number[] = [];
let end = 1;

export async function mount(after: HTMLElement, text: string, assets: Assets, at?: number): Promise<void> {
  const doc = document.createElement("article");
  doc.className = "md";
  after.after(doc);
  try {
    ents = entities(text);
    let out = text.length > WORKER_MIN ? await offThread(text, assets, assets["md.js"]) : undefined;
    if (out === null) throw new Error("md");
    let tokens: T[] | null = null;
    out ??= render((tokens = Lexer.lex(text) as T[]), null);
    blocks = doc.children;
    starts = out.lines.filter(Boolean);
    end = out.end;
    let box: Element = doc;
    for (let i = 0, size = 0; i < out.html.length; ) {
      const kid = !out.lines[i];
      let html = "";
      while (i < out.html.length && !out.lines[i] === kid && html.length < (kid ? CHUNK / 2 : CHUNK)) html += out.html[i++];
      if (kid && /^(?:UL|OL|TBODY)$/.test(box.tagName) && box.childElementCount) box = more(box as HTMLElement);
      (kid ? box : doc).insertAdjacentHTML("beforeend", html);
      if (!kid) for (box = doc.lastElementChild!; box.lastElementChild; ) box = box.lastElementChild;
      if (((size += html.length) >= CHUNK || kid) && i < out.html.length) {
        size = 0;
        await frame();
      }
    }
    if (!scrollY) {
      let h = location.hash.slice(1);
      try {
        h = decodeURIComponent(h);
      } catch {}
      if (at) scrollTo(0, y(at) ?? 0);
      else if (h.startsWith("md-")) document.getElementById(h)?.scrollIntoView();
    }
    if (tokens) colour(doc, langsOf(tokens, assets), assets);
  } catch (e) {
    doc.remove();
    blocks = null;
    throw e;
  }
}

function more(box: HTMLElement): Element {
  if (box.tagName !== "TBODY") {
    const n = box.cloneNode(false) as HTMLElement;
    if (n instanceof HTMLOListElement) n.start = (box as HTMLOListElement).start + box.childElementCount;
    box.style.marginBottom = "0";
    box.after(n);
    return n;
  }
  const t = box.parentElement as HTMLTableElement;
  if (!t.style.width) {
    const w = t.getBoundingClientRect().width;
    t.insertAdjacentHTML("afterbegin", `<colgroup>${[...t.rows[0].cells].map((c) => `<col style="width:${c.getBoundingClientRect().width}px">`).join("")}</colgroup>`);
    t.style.cssText = `table-layout:fixed;width:${w}px`;
  }
  const n = t.cloneNode(false) as HTMLTableElement;
  n.innerHTML = `${t.querySelector("colgroup")!.outerHTML}<tbody></tbody>`;
  t.after(n);
  return n.tBodies[0];
}

async function colour(doc: HTMLElement, langs: Set<string>, assets: Assets) {
  const core = await hljs(langs, assets);
  if (!core) return;
  let t = performance.now();
  for (const c of doc.querySelectorAll<HTMLElement>("code[data-hl]")) {
    const html = paint(core)(c.textContent ?? "", c.dataset.hl!);
    if (html !== null) c.innerHTML = html;
    if (performance.now() - t > 30) {
      await frame();
      t = performance.now();
    }
  }
}

const next = (i: number) => starts[i + 1] ?? end;

export function top(): number | null {
  if (!blocks) return null;
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom > 0) return starts[i] + Math.max(0, -r.top / r.height) * (next(i) - starts[i]);
  }
  return null;
}

export function y(line: number): number | null {
  if (!blocks?.length) return null;
  let i = 0;
  while (i + 1 < blocks.length && starts[i + 1] <= line) i++;
  const r = blocks[i].getBoundingClientRect();
  return r.top + scrollY + Math.max(0, Math.min(1, (line - starts[i]) / (next(i) - starts[i] || 1))) * r.height;
}
