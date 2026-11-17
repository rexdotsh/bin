import { Lexer, type Tokens } from "marked";

type T = Tokens.Generic;
type Hljs = { registerLanguage(name: string, lang: unknown): void; highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string } };
type Out = { html: string[]; lines: number[] };
type Assets = Record<string, string>;

const WORKER_MIN = 64 * 1024;
const CHUNK = 32 * 1024;
const ALIAS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", golang: "go", rb: "ruby", kt: "kotlin", "c++": "cpp", cc: "cpp", hpp: "cpp", h: "c", cs: "csharp", "c#": "csharp",
  sh: "bash", shell: "bash", zsh: "bash", jsonc: "json", yml: "yaml", toml: "ini", md: "markdown", html: "xml", htm: "xml", svg: "xml", vue: "xml",
  pl: "perl", gql: "graphql", docker: "dockerfile", make: "makefile", mk: "makefile",
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const txt = (s: string) => s.replace(/&(?!#\d{1,7};|#x[\da-f]{1,6};|[a-z][a-z\d]{1,31};)|[<>"]/gi, (c) => ESC[c]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()];
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd";
  });

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

const plain = (ts: T[] = []): string => ts.map((t) => (t.tokens ? plain(t.tokens) : typeof t.text === "string" ? t.text : "")).join("");
const fence = (info?: string) => {
  const l = (info ?? "").trim().split(/\s/)[0].toLowerCase();
  return Object.hasOwn(ALIAS, l) ? ALIAS[l] : l;
};

function inline(ts: T[] = []): string {
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
      case "link": {
        const h = url(t.href);
        const inner = inline(t.tokens);
        o += h ? `<a href="${esc(h)}"${t.title ? ` title="${txt(t.title)}"` : ""} rel="noopener noreferrer nofollow ugc">${inner}</a>` : inner;
        break;
      }
      case "image": {
        const s = url(t.href, true);
        o += s
          ? `<img src="${esc(s)}" alt="${txt(t.text)}"${t.title ? ` title="${txt(t.title)}"` : ""} loading="lazy" decoding="async" referrerpolicy="no-referrer">`
          : txt(t.text);
        break;
      }
      default:
        o += esc(typeof t.text === "string" ? t.text : t.raw);
    }
  }
  return o;
}

function render(tokens: T[], hl: ((code: string, lang: string) => string | null) | null): Out {
  const seen = new Map<string, number>();
  const cell = (tag: string, c: T) => `<${tag}${c.align === "center" ? ' class="c"' : c.align === "right" ? ' class="r"' : ""}>${inline(c.tokens)}</${tag}>`;
  const block = (t: T): string => {
    switch (t.type) {
      case "paragraph":
        return `<p>${inline(t.tokens)}</p>`;
      case "text":
        return t.tokens ? inline(t.tokens) : txt(t.text);
      case "heading": {
        const d = Math.min(6, Math.max(1, Number(t.depth) || 1));
        const base = decode(plain(t.tokens)).toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return `<h${d} id="md-${esc(n ? `${base}-${n}` : base)}">${inline(t.tokens)}</h${d}>`;
      }
      case "code": {
        const lang = t.codeBlockStyle ? "" : fence(t.lang);
        const code = (lang && hl && hl(t.text, lang)) || esc(t.text);
        return `<pre><code${lang && !hl ? ` data-hl="${esc(lang)}"` : ""}>${code}</code></pre>`;
      }
      case "html":
        return t.block ? `<pre><code>${esc(t.text.replace(/\n+$/, ""))}</code></pre>` : esc(t.text);
      case "blockquote":
        return `<blockquote>${t.tokens!.map(block).join("")}</blockquote>`;
      case "list": {
        const tag = t.ordered ? "ol" : "ul";
        const start = Number(t.start);
        const task = t.items.some((i: T) => i.task);
        const items = t.items.map((i: T) => {
          const body = i.tokens!.map(block).join("");
          return `<li>${i.task ? `<span class="box${i.checked ? " x" : ""}"></span><div${i.checked ? ' class="done"' : ""}>${body}</div>` : body}</li>`;
        });
        return `<${tag}${task ? ' class="task"' : ""}${t.ordered && Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</${tag}>`;
      }
      case "table":
        return `<div class="tw"><table><thead><tr>${t.header.map((c: T) => cell("th", c)).join("")}</tr></thead><tbody>${t.rows
          .map((r: T[]) => `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`)
          .join("")}</tbody></table></div>`;
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
  const out: Out = { html: [], lines: [] };
  let line = 1;
  for (const t of tokens) {
    const html = t.type === "text" ? `<p>${block(t)}</p>` : block(t);
    if (html) {
      out.html.push(html);
      out.lines.push(line + (t.raw.match(/^\n*/)?.[0].length ?? 0));
    }
    line += t.raw.split("\n").length - 1;
  }
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
  addEventListener("message", async (e: MessageEvent<{ text: string; assets: Assets }>) => {
    const tokens = Lexer.lex(e.data.text) as T[];
    const core = await hljs(langsOf(tokens, e.data.assets), e.data.assets);
    postMessage(render(tokens, core && paint(core)));
  });
}

function offThread(text: string, assets: Assets, src: string): Promise<Out | null> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = new Worker(src, { type: "module" });
    } catch {
      return resolve(null);
    }
    w.onmessage = (e: MessageEvent<Out>) => {
      w.terminate();
      resolve(e.data);
    };
    w.onerror = () => {
      w.terminate();
      resolve(null);
    };
    w.postMessage({ text, assets });
  });
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

let blocks: HTMLCollection | null = null;
let starts: number[] = [];

export async function mount(after: HTMLElement, text: string, assets: Assets): Promise<void> {
  const doc = document.createElement("article");
  doc.className = "md";
  after.after(doc);
  blocks = doc.children;
  let out = text.length > WORKER_MIN ? await offThread(text, assets, assets["md.js"]) : null;
  let tokens: T[] | null = null;
  if (!out) out = render((tokens = Lexer.lex(text) as T[]), null);
  starts = out.lines;
  for (let i = 0; i < out.html.length; ) {
    let html = "";
    while (i < out.html.length && html.length < CHUNK) html += out.html[i++];
    doc.insertAdjacentHTML("beforeend", html);
    if (i < out.html.length) await frame();
  }
  const hash = location.hash.startsWith("#md-") && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (hash) hash.scrollIntoView();
  if (tokens) colour(doc, langsOf(tokens, assets), assets);
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

export function top(): [number, number] | null {
  if (!blocks) return null;
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    if (r.bottom > 0) return [starts[i], r.top];
  }
  return null;
}

export function at(line: number): Element | null {
  if (!blocks) return null;
  let i = 0;
  while (i + 1 < blocks.length && starts[i + 1] <= line) i++;
  return blocks[i] ?? null;
}
