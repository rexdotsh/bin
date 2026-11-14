export type FileRef = { name: string };

export type View = {
  id: string;
  ext: string;
  host: string;
  wrap: boolean;
  meta: Record<string, string>;
  text?: string;
  ansi?: string;
  enc?: string;
  src?: string;
  files?: FileRef[];
  file?: string;
  live?: number;
  diff?: string;
};

export const INLINE_MAX = 512 * 1024;
export const LINE_PX = 24;
const HL_MAX = 300_000;
const NO_HL = new Set(["log", "text", "diff"]);

export function hlModules(lang: string, size: number): string[] | null {
  if (size > HL_MAX || NO_HL.has(lang)) return null;
  if (!lang) return size < 30_000 ? ["/hl/auto.js"] : null;
  return ["/hl/core.js", `/hl/${lang}.js`];
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const escText = (s: string) => s.split("&").join("&amp;").split("<").join("&lt;");
export const escRaw = (s: string) => escText(s).split("\r").join("&#13;");
export const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");
export const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
export const gutter = (lines: number, live: boolean) => `${Math.max(String(Math.max(lines, 1)).length, live ? 6 : 1) + 1}ch`;

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

export const THEME_BUTTON = `<button id="theme" class="ib" title="Light or dark (t)">${svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>').replace("<svg", '<svg class="moon"')}${svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>').replace("<svg", '<svg class="sun"')}</button>`;
export const LOCK_ICON = svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');

function icons(raw: string | null, dl: string | null): string {
  return [
    `<button id="del" class="ib" title="Delete" hidden>${svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>')}</button>`,
    `<button id="copy" class="ib" title="Copy (y)">${svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>')}</button>`,
    raw ? `<a id="raw" class="ib" href="${raw}" title="Raw (r)">${svg('<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>')}</a>` : "",
    dl ? `<a id="dl" class="ib" href="${dl}" title="Download (d)">${svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>')}</a>` : "",
    `<a class="ib" href="/" title="New paste">${svg('<path d="M12 5v14M5 12h14"/>')}</a>`,
    THEME_BUTTON,
  ].join("");
}

export function viewBody(v: View): { cls: string; html: string } {
  const { meta, id } = v;
  const enc = meta.enc === "1";
  const live = v.live !== undefined;
  const heading = meta.t || meta.name || "";
  const lines = Number(meta.lines || 0);
  const facts: string[] = [];
  if (meta.cmd) facts.push(`<span class="cmd">$ ${esc(meta.cmd)}</span>`);
  if (meta.exit) facts.push(`<span class="${meta.exit === "0" ? "ok" : "bad"}">exit ${esc(meta.exit)}</span>`);
  if (meta.dur) facts.push(`<span>${fmtDuration(Number(meta.dur))}</span>`);
  if (meta.lang && meta.lang !== "text") facts.push(`<span>${esc(meta.lang)}</span>`);
  if (!enc) facts.push(`<span id="nlines">${lines.toLocaleString("en")} lines</span>`);
  facts.push(`<span>${fmtSize(Number(meta.bytes || 0))}</span>`);
  if (enc) facts.push(`<span class="lock">encrypted</span>`);
  if (meta.exp) facts.push(`<span>expires ${new Date(Number(meta.exp) * 1000).toISOString().slice(0, 10)}</span>`);
  if (live) facts.push(`<span class="live"><i>live</i><i>disconnected</i></span>`);
  const filePath = v.file ? `/${segments(v.file)}` : "";
  const raw = v.diff ? null : `/raw/${id}${filePath}`;
  const dl = v.diff ? null : `/dl/${id}${filePath}`;
  const tabs = v.files
    ? `<nav class="tabs">${v.files
        .map((f) => `<a href="/${id}/${segments(f.name)}"${f.name === v.file ? ' aria-current="page"' : ""}>${esc(f.name)}</a>`)
        .join("")}</nav>`
    : "";
  const locked = enc && v.text === undefined;
  const big = !locked && v.text === undefined;
  const style = `--gw:${gutter(lines, live)}${big ? `;min-height:${lines * LINE_PX}px` : ""}`;
  const body = locked
    ? ""
    : big
      ? `${lines.toLocaleString("en")} lines (${fmtSize(Number(meta.bytes || 0))}). <a href="${raw}">Raw text</a>`
      : escText(v.text!);
  const data = {
    id,
    ext: v.ext,
    name: meta.name || "",
    lang: meta.lang || "",
    enc: locked ? v.enc : undefined,
    live: v.live,
    src: big ? raw : undefined,
    diff: Boolean(v.diff),
    raw,
    dl,
  };
  const shown = v.diff ? esc(v.diff.replace("/vs/", " vs ")) : `<b>${esc(id)}</b>${v.ext ? `.${esc(v.ext)}` : ""}`;
  const html = `<header class="top wrap"><a class="mark" href="/">bin</a><span class="crumb">/ ${shown}<span id="hash"></span></span><span class="sp"></span>
<nav class="acts">${icons(raw, dl)}</nav></header>
<main class="wrap">
${heading ? `<h1>${esc(heading)}</h1>` : ""}<div class="meta">${facts.join("")}</div>
${tabs}${locked ? `<form id="unlock" class="unlock"><p>This paste is encrypted. The password never leaves your browser.</p><div><input type="password" id="pw" class="field" placeholder="password" autocomplete="off" aria-label="Password" autofocus><button class="btn">Unlock</button></div><p id="pwerr" class="bad" hidden>wrong password</p></form>` : ""}
<pre id="text" class="code" style="${style}"${locked ? " hidden" : ""}>
${body}</pre>
</main>
${live ? "" : `<footer class="foot"><div class="wrap"><span><kbd>y</kbd>copy</span><span><kbd>r</kbd>raw</span><span><kbd>/</kbd>find</span><span><kbd>g</kbd>line</span><span><kbd>w</kbd>wrap</span><span><kbd>e</kbd>edit as new</span><span><kbd>t</kbd>theme</span><span class="sp"></span><span>${esc(v.host)}</span></div></footer>`}
<div id="find" class="find" hidden><input id="q" placeholder="find" autocomplete="off" aria-label="Find"><span id="count"></span></div>
${v.ansi !== undefined && !big ? `<template id="ansi">${escRaw(v.ansi)}</template>` : ""}<script type="application/json" id="data">${safeJson(data)}</script>`;
  const cls = ["view", v.wrap && "wrap-on", (locked || big) && "tall", live && "live-on"].filter(Boolean).join(" ");
  return { cls, html };
}
