import { DurableObject } from "cloudflare:workers";

interface Env {
  BUCKET: R2Bucket;
  LIVE: DurableObjectNamespace<Live>;
  ANON: RateLimit;
  ASSETS: Fetcher;
  BIN_TOKEN?: string;
}

type Meta = Record<string, string>;
type FileEntry = { name: string; lang: string; lines: number; bytes: number; tokens: number };
type Snapshot = { text: string; meta: Meta; n: number };

const ID_RE = /^[A-Za-z0-9+-]{6}$/;
const IDX_RE = /^([A-Za-z0-9+-]{6})(?:\.([A-Za-z0-9]{1,12}))?$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ANON_MAX = 2 * 1024 * 1024;
const OWNER_MAX = 10 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_CHUNK = 64 * 1024;
const LIVE_IDLE_MS = 10 * 60_000;
const TTL: Record<string, number> = { "1h": 3600, "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
const UNFURLERS =
  /Slackbot|Discordbot|Twitterbot|facebookexternalhit|TelegramBot|WhatsApp|LinkedInBot|Mastodon|Signal|Iframely|Embedly|redditbot|SkypeUriPreview|Teams|Google-PageRenderer|Bluesky|Cardyb/i;

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", lua: "lua",
  sh: "bash", bash: "bash", zsh: "bash", json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  md: "markdown", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", css: "css", scss: "scss",
  sql: "sql", diff: "diff", patch: "diff", log: "log", txt: "text", r: "r", pl: "perl", graphql: "graphql",
  dockerfile: "dockerfile", makefile: "makefile",
};
const LANGS = new Set(Object.values(EXT_LANG));

const SECRETS: [RegExp, string][] = [
  [/\b[sr]k_live_[0-9a-zA-Z]{16,}/, "Stripe key"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[0-9A-Za-z_]{20,}/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bxox[abpr]-[0-9A-Za-z-]{10,}/, "Slack token"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, "API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
];

export class Live extends DurableObject<Env> {
  async start(cfg: { id: string; meta: Meta; write: string; max: number; etag: string }) {
    await this.ctx.storage.put({ cfg, n: 0, size: 0 });
    await this.ctx.storage.setAlarm(Date.now() + LIVE_IDLE_MS);
  }

  async append(write: string, chunk: string): Promise<number> {
    const cfg = await this.ctx.storage.get<{ write: string; max: number }>("cfg");
    if (!cfg) return 404;
    if (!(await same(await sha256(write), cfg.write))) return 403;
    const n = (await this.ctx.storage.get<number>("n")) ?? 0;
    const size = ((await this.ctx.storage.get<number>("size")) ?? 0) + chunk.length;
    if (size > cfg.max) return 413;
    await this.ctx.storage.put({ [`c:${String(n).padStart(8, "0")}`]: chunk, n: n + 1, size });
    await this.ctx.storage.setAlarm(Date.now() + LIVE_IDLE_MS);
    this.broadcast(JSON.stringify({ append: chunk, n: n + 1 }));
    return 200;
  }

  async snapshot(): Promise<Snapshot | null> {
    const cfg = await this.ctx.storage.get<{ meta: Meta }>("cfg");
    if (!cfg) return null;
    const chunks = await this.ctx.storage.list<string>({ prefix: "c:" });
    return { text: [...chunks.values()].join(""), meta: cfg.meta, n: chunks.size };
  }

  async seal(write: string, extra: Meta): Promise<number> {
    const cfg = await this.ctx.storage.get<{ write: string }>("cfg");
    if (!cfg) return 404;
    if (!(await same(await sha256(write), cfg.write))) return 403;
    await this.finish(extra);
    return 200;
  }

  async abort() {
    this.broadcast(JSON.stringify({ gone: true }), true);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    await this.finish({ exit: "interrupted" });
  }

  async fetch(req: Request): Promise<Response> {
    const snap = await this.snapshot();
    if (!snap) return new Response("not live", { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const from = Number(new URL(req.url).searchParams.get("from")) || 0;
    const chunks = [...(await this.ctx.storage.list<string>({ prefix: "c:" })).values()];
    if (chunks.length > from) server.send(JSON.stringify({ append: chunks.slice(from).join(""), n: chunks.length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket) {
    ws.close(1008, "read-only");
  }

  private broadcast(msg: string, close = false) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        if (close) ws.close(1000, "done");
      } catch {}
    }
  }

  private async finish(extra: Meta) {
    const cfg = await this.ctx.storage.get<{ id: string; meta: Meta; etag: string }>("cfg");
    if (!cfg) return;
    const snap = (await this.snapshot())!;
    const meta: Meta = { ...cfg.meta, ...textStats(snap.text), ...extra };
    delete meta.kind;
    await this.env.BUCKET.put(`p/${cfg.id}`, snap.text, {
      customMetadata: meta,
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      onlyIf: { etagMatches: cfg.etag },
    });
    this.broadcast(JSON.stringify({ sealed: true }), true);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      return harden(await route(req, env, ctx, url));
    } catch (err) {
      console.error(err);
      return harden(fail(500, "something went wrong"));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return notFound(req);
  }
  const m = req.method;
  if (!parts.length) {
    if (m === "POST" || m === "PUT") return create(req, env, url);
    if (m !== "GET" && m !== "HEAD") return fail(405, "method not allowed");
    if (wantsHtml(req)) return composePage(themeOf(req));
    const usage = await env.ASSETS.fetch(new Request(new URL("/llms.txt", url)));
    return new Response(usage.body, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (m === "PUT" && parts.length === 1) return create(req, env, url, parts[0]);
  if (parts[0] === "robots.txt") return text("User-agent: *\nDisallow: /\n");

  const [first, ...rest] = parts;
  if ((first === "raw" || first === "dl") && rest.length) {
    const idx = rest[0].match(IDX_RE);
    if (!idx || !(m === "GET" || m === "HEAD")) return notFound(req);
    return read(req, env, ctx, url, idx[1], idx[2], rest.slice(1).join("/"), first);
  }
  const idx = first.match(IDX_RE);
  if (!idx) return notFound(req);
  const [, id, ext] = idx;
  const sub = rest.join("/");
  if (sub === "_live") return liveSocket(req, env, id);
  if (sub === "_append" && m === "POST") return liveAppend(req, env, id);
  if (sub === "_seal" && m === "POST") return liveSeal(req, env, id);
  if (m === "DELETE" && !sub) return remove(req, env, id);
  if (m !== "GET" && m !== "HEAD") return fail(405, "method not allowed");
  if (rest[0] === "vs" && rest.length === 2) {
    const other = rest[1].match(IDX_RE);
    if (other) return compare(req, env, ctx, url, id, other[1]);
  }
  return read(req, env, ctx, url, id, ext, sub, "view");
}

// ---------------------------------------------------------------- create

async function create(req: Request, env: Env, url: URL, pathName?: string): Promise<Response> {
  const owner = await isOwner(req, env);
  if (!owner) {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (!(await env.ANON.limit({ key: ip })).success) {
      return fail(429, "too many pastes from this address; try again in a minute", { "retry-after": "60" });
    }
  }
  const q = url.searchParams;
  const max = owner ? OWNER_MAX : ANON_MAX;
  const limit = `${max / 1048576} MB`;
  if (Number(req.headers.get("content-length") ?? 0) > max + 65536) return fail(413, `pastes are limited to ${limit}`);

  const meta: Meta = { at: new Date().toISOString() };
  const title = clean(q.get("title"), 200);
  if (title) meta.t = title;
  const cmd = clean(q.get("cmd"), 400);
  if (cmd) meta.cmd = cmd;
  const ttl = q.get("ttl") || "never";
  if (owner && q.get("expires")) {
    const exp = Number(q.get("expires"));
    if (!Number.isFinite(exp) || exp <= 0) return fail(400, "expires must be a unix timestamp");
    meta.exp = String(Math.floor(exp));
  } else if (ttl !== "never") {
    if (!Object.hasOwn(TTL, ttl)) return fail(400, "ttl must be 1h, 1d, 7d, 30d or never");
    meta.exp = String(Math.floor(Date.now() / 1000) + TTL[ttl]);
  }
  let id = q.get("id");
  if (id !== null && (!owner || !ID_RE.test(id))) return fail(400, "only the owner can choose an id, and it must be 6 characters");

  const anonDelete = owner ? null : token();
  if (anonDelete) meta.del = await sha256(anonDelete);
  const receipt = (pid: string, ext: string, extra: Record<string, unknown>) => {
    const link = `${url.origin}/${pid}${ext ? `.${ext}` : ""}`;
    const body = {
      ok: true,
      id: pid,
      url: link,
      raw: `${url.origin}/raw/${pid}`,
      expires: meta.exp ? new Date(Number(meta.exp) * 1000).toISOString() : null,
      ...(anonDelete && { delete: anonDelete }),
      ...extra,
    };
    if (q.has("json") || (req.headers.get("accept") ?? "").includes("application/json")) return json(body, 201);
    const notes = [
      ...(anonDelete ? [`# delete: curl -X DELETE ${url.origin}/${pid} -H 'x-delete: ${anonDelete}'`] : []),
      ...((extra.warnings as string[] | undefined) ?? []).map((w) => `# warning: ${w}`),
    ];
    return text(`${link}\n${notes.map((n) => `${n}\n`).join("")}`, 201);
  };

  if (q.get("live") === "1") {
    const name = cleanName(q.get("name") ?? pathName ?? "");
    if (name) meta.name = name;
    meta.lang = pickLang(q.get("lang"), name, "") || "log";
    meta.kind = "live";
    const write = token();
    const placed = await claim(env, id, "", meta);
    if (!placed) return fail(409, "that id is taken");
    await live(env, placed.id).start({ id: placed.id, meta, write: await sha256(write), max, etag: placed.etag });
    return receipt(placed.id, "", { write, live: true });
  }

  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const files: [string, string][] = [];
    let total = 0;
    for (const [field, value] of form) {
      if (typeof value === "string") continue;
      const name = cleanName(value.name || field);
      if (!name) return fail(400, `bad file name: ${value.name || field}`);
      if (files.some(([n]) => n === name)) return fail(400, `duplicate file name: ${name}`);
      const bytes = new Uint8Array(await value.arrayBuffer());
      total += bytes.byteLength;
      if (total > max) return fail(413, `pastes are limited to ${limit}`);
      const body = decodeText(bytes);
      if (body === null) return fail(415, `${name} isn't text`);
      files.push([name, body]);
    }
    if (!files.length) return fail(400, "no files in the form");
    if (files.length > MAX_FILES) return fail(400, `at most ${MAX_FILES} files per paste`);
    if (files.length === 1) return single(env, url, id, meta, files[0][1], files[0][0], q, receipt);
    const entries: FileEntry[] = files.map(([name, body]) => {
      const s = textStats(body);
      return { name, lang: pickLang(null, name, body), lines: Number(s.lines), bytes: Number(s.bytes), tokens: Number(s.tok) };
    });
    meta.kind = "multi";
    meta.files = String(files.length);
    meta.lines = String(entries.reduce((n, f) => n + f.lines, 0));
    meta.bytes = String(entries.reduce((n, f) => n + f.bytes, 0));
    meta.tok = String(entries.reduce((n, f) => n + f.tokens, 0));
    const placed = await claim(env, id, JSON.stringify({ files: entries }), meta);
    if (!placed) return fail(409, "that id is taken");
    await Promise.all(
      files.map(([name, body], i) =>
        env.BUCKET.put(`p/${placed.id}/${name}`, body, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: { lang: entries[i].lang, lines: String(entries[i].lines), tok: String(entries[i].tokens) },
        }),
      ),
    );
    const warnings = [...new Set(files.flatMap(([, body]) => scanSecrets(body)))];
    return receipt(placed.id, "", {
      files: entries.map((f) => ({ ...f, url: `${url.origin}/${placed.id}/${f.name}` })),
      lines: Number(meta.lines),
      bytes: Number(meta.bytes),
      tokens: Number(meta.tok),
      warnings,
    });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > max) return fail(413, `pastes are limited to ${limit}`);
  if (!bytes.byteLength) return fail(400, "the paste is empty");
  const body = decodeText(bytes);
  if (body === null) return fail(415, "that isn't text; bin only takes text");
  return single(env, url, id, meta, body, cleanName(q.get("name") ?? pathName ?? ""), q, receipt);
}

async function single(
  env: Env,
  url: URL,
  id: string | null,
  meta: Meta,
  body: string,
  name: string,
  q: URLSearchParams,
  receipt: (id: string, ext: string, extra: Record<string, unknown>) => Response,
): Promise<Response> {
  if (name) meta.name = name;
  let warnings: string[] = [];
  if (q.get("enc") === "1") {
    if (!isEnvelope(body)) return fail(400, "enc=1 needs an encrypted envelope (the CLI and web form make these)");
    meta.enc = "1";
    meta.bytes = String(body.length);
    meta.lang = pickLang(q.get("lang"), name, "");
  } else {
    Object.assign(meta, textStats(body));
    meta.lang = pickLang(q.get("lang"), name, body);
    warnings = scanSecrets(body);
  }
  const placed = await claim(env, id, body, meta);
  if (!placed) return fail(409, "that id is taken");
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return receipt(placed.id, /^[a-z0-9]{1,12}$/.test(ext) ? ext : "", {
    lines: meta.lines ? Number(meta.lines) : undefined,
    bytes: Number(meta.bytes),
    tokens: meta.tok ? Number(meta.tok) : undefined,
    lang: meta.lang || null,
    encrypted: meta.enc === "1",
    warnings,
  });
}

async function claim(env: Env, wanted: string | null, body: string, meta: Meta): Promise<{ id: string; etag: string } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = wanted ?? makeId();
    const obj = await env.BUCKET.put(`p/${id}`, body, {
      customMetadata: meta,
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      onlyIf: new Headers({ "if-none-match": "*" }),
    });
    if (obj) return { id, etag: obj.etag };
    if (wanted) return null;
  }
  throw new Error("could not find a free id");
}

// ---------------------------------------------------------------- live

async function liveAppend(req: Request, env: Env, id: string): Promise<Response> {
  const write = req.headers.get("x-write");
  if (!write) return fail(401, "missing x-write");
  const chunk = await req.text();
  if (chunk.length > MAX_CHUNK) return fail(413, `send at most ${MAX_CHUNK / 1024} KB per chunk`);
  const status = await live(env, id).append(write, chunk);
  if (status === 200) return json({ ok: true });
  return fail(status, status === 413 ? "the live paste hit its size limit" : status === 403 ? "wrong write token" : "not live");
}

async function liveSeal(req: Request, env: Env, id: string): Promise<Response> {
  const write = req.headers.get("x-write");
  if (!write) return fail(401, "missing x-write");
  const body = (await req.json().catch(() => ({}))) as { exit?: unknown; dur?: unknown };
  const extra: Meta = {};
  if (typeof body.exit === "number" || typeof body.exit === "string") extra.exit = clean(String(body.exit), 20);
  if (typeof body.dur === "number" && body.dur >= 0) extra.dur = String(Math.round(body.dur));
  const status = await live(env, id).seal(write, extra);
  return status === 200 ? json({ ok: true }) : fail(status, status === 403 ? "wrong write token" : "not live");
}

async function liveSocket(req: Request, env: Env, id: string): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") return fail(426, "expected a websocket");
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return fail(403, "forbidden");
  return live(env, id).fetch(req);
}

const live = (env: Env, id: string) => env.LIVE.get(env.LIVE.idFromName(id));

// ---------------------------------------------------------------- read

async function getPaste(env: Env, key: string): Promise<R2ObjectBody | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const exp = obj.customMetadata?.exp;
  if (exp && Number(exp) * 1000 < Date.now()) return null;
  return obj;
}

async function read(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  id: string,
  ext: string | undefined,
  file: string,
  mode: "view" | "raw" | "dl",
): Promise<Response> {
  const obj = await getPaste(env, `p/${id}`);
  if (!obj) {
    const gone = await env.BUCKET.head(`p/${id}`);
    if (gone?.customMetadata?.exp) ctx.waitUntil(purge(env, id, gone.customMetadata));
    return notFound(req);
  }
  const meta = obj.customMetadata ?? {};

  if (meta.kind === "multi") {
    const index = JSON.parse(await obj.text()) as { files: FileEntry[] };
    if (!file) {
      if (mode !== "view" || !wantsHtml(req)) return text(multiIndex(url, id, meta, index.files), 200, agentHeaders(meta));
      file = index.files[0].name;
    }
    const entry = index.files.find((f) => f.name === file);
    const part = entry && (await env.BUCKET.get(`p/${id}/${file}`));
    if (!entry || !part) return notFound(req);
    const fileMeta: Meta = { ...meta, name: file, lang: entry.lang, lines: String(entry.lines), bytes: String(entry.bytes), tok: String(entry.tokens) };
    delete fileMeta.kind;
    if (mode !== "view") return rawResponse(part.body, fileMeta, id, mode);
    return present(req, url, id, ext, fileMeta, await part.text(), { files: index.files, file });
  }
  if (file) return notFound(req);

  if (meta.kind === "live") {
    const snap = await live(env, id).snapshot();
    if (!snap) {
      const sealed = await getPaste(env, `p/${id}`);
      if (!sealed || sealed.customMetadata?.kind === "live") return notFound(req);
      if (mode !== "view") return rawResponse(sealed.body, sealed.customMetadata ?? {}, id, mode);
      return present(req, url, id, ext, sealed.customMetadata ?? {}, await sealed.text());
    }
    const liveMeta = { ...snap.meta, ...textStats(snap.text) };
    if (mode !== "view") return rawResponse(snap.text, liveMeta, id, mode);
    return present(req, url, id, ext, liveMeta, snap.text, { live: snap.n });
  }

  if (mode !== "view") return rawResponse(obj.body, meta, id, mode);
  return present(req, url, id, ext, meta, await obj.text());
}

function rawResponse(body: ReadableStream | string, meta: Meta, id: string, mode: "raw" | "dl"): Response {
  const headers = agentHeaders(meta);
  headers.set("content-type", "text/plain; charset=utf-8");
  if (mode === "dl") {
    const name = (meta.name || `${id}.${meta.enc ? "json" : "txt"}`).split("/").pop()!.replace(/[^\w.+-]/g, "_");
    headers.set("content-disposition", `attachment; filename="${name}"`);
  }
  return new Response(body, { headers });
}

function present(
  req: Request,
  url: URL,
  id: string,
  ext: string | undefined,
  meta: Meta,
  body: string,
  extra: { files?: FileEntry[]; file?: string; live?: number; diff?: string } = {},
): Response {
  const q = url.searchParams;
  const slicing = ["digest", "lines", "head", "tail", "grep"].some((k) => q.has(k));
  if (!slicing && wantsHtml(req)) return viewer(themeOf(req), url, id, ext, meta, body, extra);
  const headers = agentHeaders(meta);
  if (extra.live !== undefined) headers.set("x-bin-live", "1");
  if (meta.enc === "1") {
    headers.set("x-bin-encrypted", "1");
    if (slicing) return fail(400, "this paste is encrypted; read it with `bin get <url> --password`");
    return text(`This paste is encrypted. Read it with: bin get ${url.origin}/${id} --password\n\n${body}\n`, 200, headers);
  }
  const plain = stripAnsi(body);
  if (q.has("digest")) return text(digest(plain, meta), 200, headers);
  if (q.has("grep")) {
    const out = grep(plain, q.get("grep")!, Math.min(Number(q.get("context")) || 0, 20), range(q.get("lines")));
    if (typeof out !== "string") return fail(400, out.error);
    return text(out, 200, headers);
  }
  const lines = plain.split("\n");
  if (plain.endsWith("\n")) lines.pop();
  let span: [number, number] | null = null;
  if (q.has("lines")) span = range(q.get("lines"));
  else if (q.has("head")) span = [1, Math.max(1, Number(q.get("head")) || 0)];
  else if (q.has("tail")) span = [Math.max(1, lines.length - (Math.max(1, Number(q.get("tail")) || 0)) + 1), lines.length];
  if (span) {
    const [a, b] = [Math.max(1, span[0]), Math.min(lines.length, span[1])];
    headers.set("x-bin-range", `${a}-${b}`);
    const picked = lines.slice(a - 1, b);
    const numbered = q.get("n") === "1" ? picked.map((l, i) => `${a + i}:${l}`) : picked;
    return text(numbered.length ? `${numbered.join("\n")}\n` : "", 200, headers);
  }
  const tokens = Number(meta.tok) || 0;
  if (tokens > 10_000) {
    headers.set("x-bin-hint", `large paste (~${tokens} tokens): try ?digest, ?head=200, ?tail=200 or ?grep=<regex>&context=3`);
  }
  return text(plain, 200, headers);
}

function agentHeaders(meta: Meta): Headers {
  const h = new Headers();
  const set = (k: string, v: string | undefined) => v && h.set(`x-bin-${k}`, v);
  set("lines", meta.lines);
  set("bytes", meta.bytes);
  set("tokens", meta.tok);
  set("lang", meta.lang);
  set("files", meta.files);
  set("title", meta.t && encodeURIComponent(meta.t));
  set("name", meta.name && encodeURIComponent(meta.name));
  set("command", meta.cmd && encodeURIComponent(meta.cmd));
  set("exit", meta.exit);
  set("duration-ms", meta.dur);
  set("expires", meta.exp && new Date(Number(meta.exp) * 1000).toISOString());
  return h;
}

function multiIndex(url: URL, id: string, meta: Meta, files: FileEntry[]): string {
  const head = `# ${meta.t ? `${meta.t} · ` : ""}${files.length} files · ${Number(meta.lines).toLocaleString("en")} lines · ~${Number(meta.tok).toLocaleString("en")} tokens\n`;
  const width = Math.max(...files.map((f) => f.name.length));
  const rows = files.map(
    (f) => `${f.name.padEnd(width)}  ${String(f.lines).padStart(6)} lines  ${`~${f.tokens}`.padStart(7)} tokens  ${url.origin}/${id}/${f.name}`,
  );
  return `${head}\n${rows.join("\n")}\n`;
}

// ---------------------------------------------------------------- compare

async function compare(req: Request, env: Env, ctx: ExecutionContext, url: URL, a: string, b: string): Promise<Response> {
  const [x, y] = await Promise.all([getPaste(env, `p/${a}`), getPaste(env, `p/${b}`)]);
  if (!x || !y) return notFound(req);
  for (const o of [x, y]) {
    const k = o.customMetadata?.kind;
    if (k || o.customMetadata?.enc) return fail(400, "only plain single-file pastes can be compared");
  }
  const [ta, tb] = await Promise.all([x.text(), y.text()]);
  const out = unified(a, b, stripAnsi(ta), stripAnsi(tb));
  const meta: Meta = { ...textStats(out), lang: "diff", t: `${a} → ${b}` };
  return present(req, url, `${a}/vs/${b}`, undefined, meta, out, { diff: `${a}/vs/${b}` });
}

type Op = [-1 | 0 | 1, string];

function unified(an: string, bn: string, a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  if (a.endsWith("\n")) al.pop();
  if (b.endsWith("\n")) bl.pop();
  if (al.length > 5000 || bl.length > 5000) return `--- a/${an}\n+++ b/${bn}\n# too long to compare (over 5,000 lines)\n`;
  const ops = myers(al, bl);
  if (!ops.some(([t]) => t !== 0)) return `--- a/${an}\n+++ b/${bn}\n# identical\n`;
  const out = [`--- a/${an}`, `+++ b/${bn}`];
  const C = 3;
  let i = 0;
  let ai = 1;
  let bi = 1;
  while (i < ops.length) {
    if (ops[i][0] === 0) {
      i++;
      ai++;
      bi++;
      continue;
    }
    let start = i;
    let sa = ai;
    let sb = bi;
    for (let k = 0; k < C && start > 0 && ops[start - 1][0] === 0; k++) start--, sa--, sb--;
    let end = i;
    let gap = 0;
    while (end < ops.length) {
      if (ops[end][0] !== 0) gap = 0;
      else if (++gap > 2 * C) break;
      end++;
    }
    end -= Math.max(0, gap - C);
    const hunk = ops.slice(start, end);
    const na = hunk.filter(([t]) => t <= 0).length;
    const nb = hunk.filter(([t]) => t >= 0).length;
    out.push(`@@ -${sa},${na} +${sb},${nb} @@`);
    for (const [t, line] of hunk) out.push(`${t === 0 ? " " : t < 0 ? "-" : "+"}${line}`);
    for (let k = i; k < end; k++) {
      if (ops[k][0] <= 0) ai++;
      if (ops[k][0] >= 0) bi++;
    }
    i = end;
  }
  return `${out.join("\n")}\n`;
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const off = n + m + 1;
  const v = new Int32Array(2 * off + 2);
  const trace: Int32Array[] = [];
  search: for (let d = 0; d <= n + m; d++) {
    if (d > 500) return [...a.map((t): Op => [-1, t]), ...b.map((t): Op => [1, t])];
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break search;
    }
  }
  const out: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) out.push([0, a[--x]]), y--;
    if (d > 0) out.push(x === px ? [1, b[y - 1]] : [-1, a[x - 1]]);
    x = px;
    y = py;
  }
  return out.reverse();
}

// ---------------------------------------------------------------- delete

async function remove(req: Request, env: Env, id: string): Promise<Response> {
  const head = await env.BUCKET.head(`p/${id}`);
  if (!head) return fail(404, "no such paste");
  const meta = head.customMetadata ?? {};
  const given = req.headers.get("x-delete");
  const allowed = (await isOwner(req, env)) || (Boolean(given && meta.del) && (await same(await sha256(given!), meta.del)));
  if (!allowed) return fail(403, "needs the paste's delete token (x-delete) or the owner token");
  await purge(env, id, meta);
  return json({ ok: true, deleted: id });
}

async function purge(env: Env, id: string, meta: Meta) {
  if (meta.kind === "live") await live(env, id).abort();
  if (meta.kind === "multi") {
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix: `p/${id}/`, cursor });
      if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  await env.BUCKET.delete(`p/${id}`);
}

// ---------------------------------------------------------------- text tools

function textStats(body: string): Meta {
  let lines = 0;
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) lines++;
  if (body && !body.endsWith("\n")) lines++;
  const meta: Meta = {
    lines: String(lines),
    bytes: String(new TextEncoder().encode(body).byteLength),
    tok: String(Math.ceil(body.length / 4)),
  };
  if (body.includes("\x1b")) meta.ansi = "1";
  return meta;
}

function stripAnsi(s: string): string {
  if (!s.includes("\x1b") && !s.includes("\r")) return s;
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r", l.length - 2) + 1).replace(/\r$/, "") : l))
    .join("\n");
}

function pickLang(given: string | null, name: string, body: string): string {
  const g = given?.toLowerCase();
  if (g && g !== "auto") return EXT_LANG[g] ?? (LANGS.has(g) ? g : "");
  const base = name.split("/").pop()!.toLowerCase();
  if (base === "dockerfile" || base === "makefile") return base;
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  if (ext && Object.hasOwn(EXT_LANG, ext)) return EXT_LANG[ext];
  const head = body.slice(0, 2048);
  if (/^diff --git /.test(head) || (/^--- /m.test(head) && /^\+\+\+ /m.test(head) && /^@@ /m.test(head))) return "diff";
  const shebang = head.match(/^#!\S*?(?:\/env\s+)?(\w+)/);
  if (shebang) return { bash: "bash", sh: "bash", zsh: "bash", python: "python", python3: "python", node: "javascript", bun: "typescript" }[shebang[1]] ?? "";
  if (head.includes("\x1b[")) return "log";
  return "";
}

function scanSecrets(body: string): string[] {
  return SECRETS.filter(([re]) => re.test(body)).map(([, kind]) => `this paste looks like it contains a ${kind}`);
}

function isEnvelope(body: string): boolean {
  try {
    const e = JSON.parse(body);
    return e && e.v === 1 && typeof e.salt === "string" && typeof e.iv === "string" && typeof e.ct === "string" && typeof e.iter === "number";
  } catch {
    return false;
  }
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function range(spec: string | null): [number, number] | null {
  const m = spec?.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  return [a, m[2] ? Number(m[2]) : a];
}

function grep(body: string, pattern: string, context: number, within: [number, number] | null): string | { error: string } {
  if (pattern.length > 300) return { error: "grep pattern is too long" };
  let re: RegExp;
  try {
    re = new RegExp(pattern, /[A-Z]/.test(pattern) ? "" : "i");
  } catch (e) {
    return { error: `bad regex: ${(e as Error).message}` };
  }
  const lines = body.split("\n");
  if (body.endsWith("\n")) lines.pop();
  const [lo, hi] = within ?? [1, lines.length];
  const hits: number[] = [];
  for (let i = Math.max(0, lo - 1); i < Math.min(lines.length, hi); i++) if (re.test(lines[i])) hits.push(i);
  if (!hits.length) return "";
  const out: string[] = [];
  let last = -2;
  const isHit = new Set(hits);
  for (const h of hits) {
    const a = Math.max(0, h - context);
    const b = Math.min(lines.length - 1, h + context);
    if (out.length && a > last + 1) out.push("--");
    for (let i = Math.max(a, last + 1); i <= b; i++) out.push(`${i + 1}${isHit.has(i) ? ":" : "-"}${lines[i]}`);
    last = Math.max(last, b);
    if (out.length > 5000) {
      out.push(`-- (stopped after 5000 lines; narrow the pattern or use ?lines=)`);
      break;
    }
  }
  return `${out.join("\n")}\n`;
}

const ERROR_RE = /\b(?:error|errors|failed|failure|fatal|panic|panicked|exception|traceback)\b|✗|✘|\bFAIL(?:ED)?\b|\bERR!|^E\s{2,}/i;
const WARN_RE = /\b(?:warn|warning|warnings|deprecated|deprecation)\b/i;
const SUMMARY_RE =
  /^\s*(?:\d+\s+(?:pass|passed|fail|failed|skip|skipped|todo|tests?|errors?|warnings?)\b|tests?:|test (?:files|suites)?:|ran \d+ tests?|=+ .*\b(?:passed|failed)\b)/i;
const ZERO_RE = /\b0\s+(?:errors?|fail(?:ed|ures?)?)\b|\bno errors\b/i;

function digest(body: string, meta: Meta): string {
  const lines = body.split("\n");
  if (body.endsWith("\n")) lines.pop();
  const norm = (l: string) =>
    l
      .trim()
      .replace(/\b0x[0-9a-f]+\b/gi, "0x…")
      .replace(/\b[0-9a-f]{8,}\b/gi, "…")
      .replace(/\d+(?:\.\d+)?/g, "N")
      .slice(0, 200);
  type Group = { first: number; end: number; count: number; lines: number[] };
  const errors = new Map<string, Group>();
  const warns = new Map<string, Group>();
  const summary: number[] = [];
  let errorCount = 0;
  let warnCount = 0;
  let inBlock = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || i <= inBlock) continue;
    if (SUMMARY_RE.test(l)) {
      summary.push(i);
      continue;
    }
    const isErr = ERROR_RE.test(l) && !ZERO_RE.test(l);
    const isWarn = !isErr && WARN_RE.test(l);
    if (!isErr && !isWarn) continue;
    const map = isErr ? errors : warns;
    if (isErr) errorCount++;
    else warnCount++;
    const key = norm(l);
    const g = map.get(key);
    if (g) {
      g.count++;
      if (g.lines.length < 3) g.lines.push(i);
      if (isErr) inBlock = i + (g.end - g.first);
      continue;
    }
    let end = i;
    if (isErr) {
      const indent = l.length - l.trimStart().length;
      while (end + 1 < lines.length && end - i < 12) {
        const next = lines[end + 1];
        const nIndent = next.length - next.trimStart().length;
        if (!next.trim() || (nIndent <= indent && !/^\s*at\s/.test(next) && !/^\s*File "/.test(next))) break;
        end++;
      }
    }
    map.set(key, { first: i, end, count: 1, lines: [i] });
    inBlock = end;
  }
  const cut = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  const loc = (a: number, b: number) => (a === b ? `L${a + 1}` : `L${a + 1}-${b + 1}`);
  const out: string[] = [];
  const head = [
    `${lines.length.toLocaleString("en")} lines`,
    `${errorCount} error${errorCount === 1 ? "" : "s"}`,
    `${warnCount} warning${warnCount === 1 ? "" : "s"}`,
  ];
  if (meta.exit) head.push(`exit ${meta.exit}`);
  if (meta.cmd) out.push(`$ ${meta.cmd}`);
  out.push(head.join(" · "));
  if (errors.size) {
    out.push("", "errors");
    const groups = [...errors.values()].slice(0, 25);
    const width = Math.max(...groups.map((g) => loc(g.first, g.end).length));
    for (const g of groups) {
      out.push(`  ${loc(g.first, g.end).padEnd(width)}  ${g.count > 1 ? `×${g.count}  ` : ""}${cut(lines[g.first].trim())}`);
    }
    if (errors.size > 25) out.push(`  … and ${errors.size - 25} more distinct errors (?grep=error to see all)`);
  }
  const repeated = [...warns.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  if (repeated.length) {
    out.push("", "warnings");
    for (const g of repeated) {
      const where = g.lines.map((n) => `L${n + 1}`).join(", ") + (g.count > g.lines.length ? ", …" : "");
      out.push(`  ×${g.count}  ${cut(lines[g.first].trim())}  (${where})`);
    }
  }
  if (summary.length) {
    out.push("", "summary");
    for (const i of summary.slice(-6)) out.push(`  L${i + 1}  ${cut(lines[i].trim())}`);
  }
  const tail: number[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) if (lines[i].trim()) tail.unshift(i);
  if (tail.length) {
    out.push("", "tail");
    for (const i of tail) out.push(`  L${i + 1}  ${cut(lines[i])}`);
  }
  return `${out.join("\n")}\n`;
}

function preview(body: string, meta: Meta): string {
  if (meta.enc === "1") return "Encrypted paste";
  const sample = stripAnsi(body.slice(0, 64 * 1024));
  const lines = sample.split("\n");
  const errs = lines.filter((l) => ERROR_RE.test(l) && !ZERO_RE.test(l) && !SUMMARY_RE.test(l)).slice(0, 3);
  const picked = errs.length ? errs : lines.filter((l) => l.trim()).slice(0, 5);
  const out = picked.map((l) => l.trimEnd().slice(0, 120)).join("\n");
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}

// ---------------------------------------------------------------- pages

function viewer(
  theme: string,
  url: URL,
  id: string,
  ext: string | undefined,
  meta: Meta,
  body: string,
  extra: { files?: FileEntry[]; file?: string; live?: number; diff?: string },
): Response {
  const enc = meta.enc === "1";
  const plain = enc ? "" : stripAnsi(body);
  const name = meta.name || "";
  const heading = meta.t || name || "";
  const facts: string[] = [];
  if (meta.cmd) facts.push(`<span class="cmd">$ ${esc(meta.cmd)}</span>`);
  if (meta.exit) facts.push(`<span class="${meta.exit === "0" ? "ok" : "bad"}">exit ${esc(meta.exit)}</span>`);
  if (meta.dur) facts.push(`<span>${fmtDuration(Number(meta.dur))}</span>`);
  if (meta.lang && meta.lang !== "text") facts.push(`<span>${esc(meta.lang)}</span>`);
  if (!enc) facts.push(`<span id="nlines">${Number(meta.lines || 0).toLocaleString("en")} lines</span>`);
  facts.push(`<span>${fmtSize(Number(meta.bytes || 0))}</span>`);
  if (enc) facts.push(`<span class="lock">encrypted</span>`);
  if (meta.exp) facts.push(`<span>expires ${new Date(Number(meta.exp) * 1000).toISOString().slice(0, 10)}</span>`);
  if (extra.live !== undefined) facts.push(`<span class="live">live</span>`);
  const tabs = extra.files
    ? `<nav class="tabs">${extra.files
        .map((f) => `<a href="/${id}/${encodeURI(f.name)}"${f.name === extra.file ? ' aria-current="page"' : ""}>${esc(f.name)}</a>`)
        .join("")}</nav>`
    : "";
  const filePath = extra.file ? `/${encodeURI(extra.file)}` : "";
  const data = {
    id,
    ext: ext ?? "",
    name,
    lang: meta.lang || "",
    ansi: meta.ansi === "1" && !enc ? body : undefined,
    enc: enc ? body : undefined,
    live: extra.live,
    diff: Boolean(extra.diff),
    raw: extra.diff ? null : `/raw/${id}${filePath}`,
    dl: extra.diff ? null : `/dl/${id}${filePath}`,
  };
  const title = `${heading || id} · bin`;
  const desc = preview(body, meta);
  const shown = extra.diff ? esc(extra.diff.replace("/vs/", " vs ")) : `<b>${esc(id)}</b>${ext ? `.${esc(ext)}` : ""}`;
  const page = `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(heading || id)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:site_name" content="bin"><meta property="og:type" content="article"><meta name="twitter:card" content="summary">
<meta name="theme-color" content="${theme === "light" ? "#fcfcfb" : "#0a0a0a"}">
${data.raw ? `<link rel="alternate" type="text/plain" href="${data.raw}">` : ""}
<link rel="icon" href="/favicon.svg"><link rel="preload" href="/fonts/GeistMono-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/bin.css"></head>
<body class="view">
<header class="top wrap"><a class="mark" href="/">bin</a><span class="crumb">/ ${shown}<span id="hash"></span></span><span class="sp"></span>
<nav class="acts">${icons(data.raw, data.dl)}</nav></header>
<main class="wrap">
${heading ? `<h1>${esc(heading)}</h1>` : ""}<div class="meta">${facts.join("")}</div>
${tabs}${enc ? `<form id="unlock" class="unlock"><p>This paste is encrypted. The password never leaves your browser.</p><div><input type="password" id="pw" placeholder="password" autocomplete="off" autofocus><button>unlock</button></div><p id="pwerr" class="bad" hidden>wrong password</p></form>` : ""}
<pre id="text">${esc(plain)}</pre><div id="code" class="code" hidden></div>
</main>
<footer class="foot"><div class="wrap"><span><kbd>y</kbd>copy</span><span><kbd>r</kbd>raw</span><span><kbd>/</kbd>find</span><span><kbd>g</kbd>line</span><span><kbd>w</kbd>wrap</span><span><kbd>e</kbd>edit as new</span><span><kbd>t</kbd>theme</span><span class="sp"></span><span>${esc(url.host)}</span></div></footer>
<div id="find" class="find" hidden><input id="q" placeholder="find" autocomplete="off"><span id="count"></span></div>
<script type="application/json" id="data">${safeJson(data)}</script>
<script type="module" src="/view.js"></script>
</body></html>`;
  return html(page);
}

function icons(raw: string | null, dl: string | null): string {
  const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  return [
    `<button id="copy" class="ib" title="Copy (y)">${svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>')}</button>`,
    raw ? `<a class="ib" href="${raw}" title="Raw (r)">${svg('<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>')}</a>` : "",
    dl ? `<a class="ib" href="${dl}" title="Download (d)">${svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>')}</a>` : "",
    `<button id="del" class="ib" title="Delete" hidden>${svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>')}</button>`,
    `<a class="ib" href="/" title="New paste">${svg('<path d="M12 5v14M5 12h14"/>')}</a>`,
    THEME_BUTTON,
  ].join("");
}

function composePage(theme: string): Response {
  const options = (name: string, items: [string, string][], selected: string) =>
    `<select id="${name}">${items.map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const langs = [["auto", "auto"], ...[...LANGS].sort().map((l) => [l, l])] as [string, string][];
  return html(`<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>bin</title><meta name="description" content="Paste text, get a link.">
<meta name="theme-color" content="${theme === "light" ? "#fcfcfb" : "#0a0a0a"}">
<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/bin.css"></head>
<body class="compose">
<header class="top wrap"><a class="mark" href="/">bin</a><span class="sp"></span><span class="hint">ctrl+v saves instantly · ctrl+shift+v to edit first</span>${THEME_BUTTON}</header>
<main class="wrap"><textarea id="t" spellcheck="false" autofocus placeholder="Paste something…"></textarea></main>
<footer class="bar wrap">
<input id="title" placeholder="Title" maxlength="200" autocomplete="off">
<label>Language ${options("lang", langs, "auto")}</label>
<label>Expires ${options("ttl", [["never", "never"], ["1h", "1 hour"], ["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"]], "never")}</label>
<label class="pwl"><input type="checkbox" id="lock"> Password</label><input id="pw" type="password" placeholder="password" hidden autocomplete="new-password">
<span class="sp"></span><span id="status"></span><button id="save" class="save">Save <span>ctrl+s</span></button>
</footer>
<script type="module" src="/compose.js"></script>
</body></html>`);
}

// ---------------------------------------------------------------- helpers

async function isOwner(req: Request, env: Env): Promise<boolean> {
  if (!env.BIN_TOKEN) return false;
  const given = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  return same(given, env.BIN_TOKEN);
}

const THEME_BUTTON = `<button id="theme" class="ib" title="Light or dark (t)"><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`;

function themeOf(req: Request): "light" | "dark" {
  return /(?:^|;\s*)theme=light(?:;|$)/.test(req.headers.get("cookie") ?? "") ? "light" : "dark";
}

function wantsHtml(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  if (UNFURLERS.test(req.headers.get("user-agent") ?? "")) return true;
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("text/markdown") && !accept.startsWith("text/plain");
}

function harden(res: Response): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("x-content-type-options", "nosniff");
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("referrer-policy", "no-referrer");
  if (!h.has("cache-control")) h.set("cache-control", "private, no-cache, no-transform");
  if ((h.get("content-type") ?? "").startsWith("text/html")) {
    h.set(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    h.set("x-frame-options", "DENY");
  } else h.set("content-security-policy", "sandbox; default-src 'none'");
  return out;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function same(given: string | null | undefined, expected: string): Promise<boolean> {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function makeId(): string {
  let id = "";
  while (id.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) if (b < 248 && id.length < 6) id += ALPHABET[b % 62];
  }
  return id;
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

function clean(s: string | null | undefined, max: number): string {
  return (s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
}

function cleanName(raw: string): string {
  const name = raw.replace(/^\.\/+/, "").trim();
  if (!name || name.length > 200 || name.includes("\\") || /[\x00-\x1f\x7f]/.test(name)) return "";
  const segs = name.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || s.startsWith("_"))) return "";
  return name;
}

function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function notFound(req: Request): Response {
  if (!wantsHtml(req)) return text("not found\n", 404);
  return html(
    `<!doctype html><html lang="en" data-theme="${themeOf(req)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · bin</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/bin.css"></head><body class="view"><header class="top wrap"><a class="mark" href="/">bin</a></header><main class="wrap"><h1>Not found</h1><p class="muted">This paste doesn't exist, expired, or was deleted.</p></main></body></html>`,
    404,
  );
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ ok: false, error }, { status, headers });
const text = (body: string, status = 200, headers?: Headers) => {
  const h = new Headers(headers);
  h.set("content-type", "text/plain; charset=utf-8");
  return new Response(body, { status, headers: h });
};
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
