import { DurableObject } from "cloudflare:workers";
import CSS from "../dist/bin.css";
import { esc, hlModules, INLINE_MAX, LOCK_ICON, safeJson, segments, THEME_BUTTON, viewBody } from "./page";

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
const OWNER_MAX = 5 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_CHUNK = 64 * 1024;
const MAX_APPENDS = 20_000;
const SEGMENT_BYTES = 512 * 1024;
const ANON_FILES = 10;
const SCAN_MAX = 256 * 1024;
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

type LiveCfg = { id: string; meta: Meta; write: string; max: number; etag: string; exp: number };
type Segment = { t: string; s: number; at: number };

export class Live extends DurableObject<Env> {
  private cfg: LiveCfg | null = null;
  private segs: Segment[] = [];
  private text = "";
  private size = 0;
  private last = 0;
  private appends = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.cfg = (await ctx.storage.get<LiveCfg>("cfg")) ?? null;
      if (!this.cfg) return;
      this.segs = [...(await ctx.storage.list<Segment>({ prefix: "s:" })).values()];
      this.text = this.segs.map((g) => g.t).join("");
      this.size = this.segs.reduce((n, g) => n + g.s, 0);
      this.last = Math.max(0, ...this.segs.map((g) => g.at), (await ctx.storage.get<number>("last")) ?? 0);
    });
  }

  async start(cfg: LiveCfg) {
    await this.ctx.storage.deleteAll();
    this.cfg = cfg;
    this.segs = [];
    this.text = "";
    this.size = 0;
    this.appends = 0;
    this.last = Date.now();
    await this.ctx.storage.put("cfg", cfg);
    await this.ctx.storage.setAlarm(this.due());
  }

  async append(write: string, chunk: string, bytes: number): Promise<number> {
    const status = await this.check(write);
    if (status !== 200) return status;
    const now = Date.now();
    if (!chunk) {
      this.last = now;
      await this.ctx.storage.put("last", now);
      return 200;
    }
    if (this.size + bytes > this.cfg!.max || ++this.appends > MAX_APPENDS) return 413;
    let tail = this.segs[this.segs.length - 1];
    if (!tail || tail.s + bytes > SEGMENT_BYTES) this.segs.push((tail = { t: "", s: 0, at: now }));
    tail.t += chunk;
    tail.s += bytes;
    tail.at = now;
    await this.ctx.storage.put(`s:${String(this.segs.length - 1).padStart(4, "0")}`, tail);
    this.text += chunk;
    this.size += bytes;
    this.last = now;
    this.broadcast(JSON.stringify({ append: chunk, n: this.text.length }));
    return 200;
  }

  async snapshot(): Promise<Snapshot | null> {
    if (!this.cfg) return null;
    if (this.expired()) {
      await this.expire();
      return null;
    }
    return { text: this.text, meta: this.cfg.meta, n: this.text.length };
  }

  async seal(write: string, extra: Meta): Promise<number> {
    const status = await this.check(write);
    if (status === 200) await this.finish(extra);
    return status;
  }

  async abort() {
    this.broadcast(JSON.stringify({ gone: true }), true);
    await this.reset();
  }

  async alarm() {
    if (!this.cfg) return;
    if (this.expired()) return this.expire();
    if (Date.now() < this.last + LIVE_IDLE_MS) return this.ctx.storage.setAlarm(this.due());
    await this.finish({ exit: "interrupted" });
  }

  async fetch(req: Request): Promise<Response> {
    if (!this.cfg || this.expired()) return new Response("not live", { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const from = Number(new URL(req.url).searchParams.get("from")) || 0;
    if (this.text.length > from) server.send(JSON.stringify({ append: this.text.slice(from), n: this.text.length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket) {
    ws.close(1008, "read-only");
  }

  private async check(write: string): Promise<number> {
    if (!this.cfg) return 404;
    if (this.expired()) {
      await this.expire();
      return 404;
    }
    return (await same(await sha256(write), this.cfg.write)) ? 200 : 403;
  }

  private due(): number {
    const idle = this.last + LIVE_IDLE_MS;
    return this.cfg?.exp ? Math.min(idle, this.cfg.exp) : idle;
  }

  private expired(): boolean {
    return Boolean(this.cfg?.exp && Date.now() >= this.cfg.exp);
  }

  private async expire() {
    const key = `p/${this.cfg!.id}`;
    if ((await this.env.BUCKET.head(key))?.etag === this.cfg!.etag) await this.env.BUCKET.delete(key);
    await this.abort();
  }

  private broadcast(msg: string, close = false) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        if (close) ws.close(1000, "done");
      } catch {}
    }
  }

  private async reset() {
    this.cfg = null;
    this.segs = [];
    this.text = "";
    this.size = 0;
    await this.ctx.storage.deleteAll();
  }

  private async finish(extra: Meta) {
    if (!this.cfg) return;
    const meta: Meta = { ...this.cfg.meta, ...statsOf(this.text, this.size), ...extra };
    delete meta.kind;
    await this.env.BUCKET.put(`p/${this.cfg.id}`, this.text, {
      customMetadata: meta,
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      onlyIf: { etagMatches: this.cfg.etag },
    });
    this.broadcast(JSON.stringify({ sealed: true }), true);
    await this.reset();
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
    if (wantsHtml(req)) return composePage(req);
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
  const ip = rateKey(req.headers.get("cf-connecting-ip") ?? "local");
  if (!owner && !(await env.ANON.limit({ key: ip })).success) return slowDown();
  const q = url.searchParams;
  const max = owner ? OWNER_MAX : ANON_MAX;
  const limit = `${max / 1048576} MB`;
  const tooBig = () => fail(413, `pastes are limited to ${limit}`);

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
  const id = q.get("id");
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
    const exp = meta.exp ? Number(meta.exp) * 1000 : 0;
    try {
      await live(env, placed.id).start({ id: placed.id, meta, write: await sha256(write), max, etag: placed.etag, exp });
    } catch (err) {
      await env.BUCKET.delete(`p/${placed.id}`);
      throw err;
    }
    return receipt(placed.id, "", { write, live: true });
  }

  const type = req.headers.get("content-type") ?? "";
  const multipart = type.startsWith("multipart/form-data");
  const raw = await readBounded(req, multipart ? max + 65536 : max);
  if (!raw) return tooBig();

  if (multipart) {
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
    } catch {
      return fail(400, "couldn't read that multipart form");
    }
    const cap = owner ? MAX_FILES : ANON_FILES;
    const files: [string, Uint8Array, string][] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const [field, value] of form) {
      if (typeof value === "string") continue;
      if (files.length >= cap) return fail(400, `at most ${cap} files per paste`);
      const name = cleanName(value.name || field);
      if (!name) return fail(400, `bad file name: ${value.name || field}`);
      if (seen.has(name)) return fail(400, `duplicate file name: ${name}`);
      seen.add(name);
      const bytes = new Uint8Array(await value.arrayBuffer());
      total += bytes.byteLength;
      if (total > max) return tooBig();
      const body = decodeText(bytes);
      if (body === null) return fail(415, `${name} isn't text`);
      files.push([name, bytes, body]);
    }
    if (!files.length) return fail(400, "no files in the form");
    if (files.length === 1) return single(env, url, id, meta, files[0][1], files[0][2], files[0][0], q, receipt);
    if (!owner && !(await env.ANON.limit({ key: ip, delta: Math.ceil(files.length / 5) })).success) return slowDown();
    const entries: FileEntry[] = files.map(([name, bytes, body]) => {
      const st = statsOf(bytes);
      return { name, lang: pickLang(null, name, body), lines: Number(st.lines), bytes: Number(st.bytes), tokens: Number(st.tok) };
    });
    meta.kind = "multi";
    meta.files = String(files.length);
    meta.lines = String(entries.reduce((n, f) => n + f.lines, 0));
    meta.bytes = String(entries.reduce((n, f) => n + f.bytes, 0));
    meta.tok = String(entries.reduce((n, f) => n + f.tokens, 0));
    const placed = await claim(env, id, JSON.stringify({ files: entries }), meta);
    if (!placed) return fail(409, "that id is taken");
    await Promise.all(
      files.map(([name, bytes], i) =>
        env.BUCKET.put(`p/${placed.id}/${name}`, bytes, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: { lang: entries[i].lang, lines: String(entries[i].lines), tok: String(entries[i].tokens) },
        }),
      ),
    );
    const warnings = [...new Set(files.flatMap(([, , body]) => scanSecrets(body)))];
    return receipt(placed.id, "", {
      files: entries.map((f) => ({ ...f, url: `${url.origin}/${placed.id}/${encodePath(f.name)}` })),
      lines: Number(meta.lines),
      bytes: Number(meta.bytes),
      tokens: Number(meta.tok),
      warnings,
    });
  }

  if (!raw.byteLength) return fail(400, "the paste is empty");
  const body = decodeText(raw);
  if (body === null) return fail(415, "that isn't text; bin only takes text");
  return single(env, url, id, meta, raw, body, cleanName(q.get("name") ?? pathName ?? ""), q, receipt);
}

async function single(
  env: Env,
  url: URL,
  id: string | null,
  meta: Meta,
  bytes: Uint8Array,
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
    meta.bytes = String(bytes.byteLength);
    meta.lang = pickLang(q.get("lang"), name, "");
  } else {
    Object.assign(meta, statsOf(bytes));
    meta.lang = pickLang(q.get("lang"), name, body);
    warnings = scanSecrets(body);
  }
  const placed = await claim(env, id, bytes, meta);
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

async function claim(env: Env, wanted: string | null, body: string | Uint8Array, meta: Meta): Promise<{ id: string; etag: string } | null> {
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

async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function rateKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

const slowDown = () => fail(429, "too many pastes from this address; try again in a minute", { "retry-after": "60" });

// ---------------------------------------------------------------- live

async function liveAppend(req: Request, env: Env, id: string): Promise<Response> {
  const write = req.headers.get("x-write");
  if (!write) return fail(401, "missing x-write");
  const bytes = await readBounded(req, MAX_CHUNK);
  if (!bytes) return fail(413, `send at most ${MAX_CHUNK / 1024} KB per chunk`);
  const chunk = decodeText(bytes);
  if (chunk === null) return fail(415, "chunks must be text");
  const status = await live(env, id).append(write, chunk, bytes.byteLength);
  if (status === 200) return json({ ok: true });
  return fail(status, status === 413 ? "the live paste hit its size limit" : status === 403 ? "wrong write token" : "not live");
}

async function liveSeal(req: Request, env: Env, id: string): Promise<Response> {
  const write = req.headers.get("x-write");
  if (!write) return fail(401, "missing x-write");
  const raw = await readBounded(req, 1024);
  if (!raw) return fail(413, "seal bodies are tiny");
  let body: { exit?: unknown; dur?: unknown } = {};
  try {
    body = JSON.parse(new TextDecoder().decode(raw) || "{}");
  } catch {}
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

async function getPaste(env: Env, ctx: ExecutionContext, id: string): Promise<R2ObjectBody | null> {
  const obj = await env.BUCKET.get(`p/${id}`);
  if (!obj) return null;
  const meta = obj.customMetadata ?? {};
  if (meta.exp && Number(meta.exp) * 1000 < Date.now()) {
    ctx.waitUntil(obj.body.cancel().then(() => purge(env, id, meta)));
    return null;
  }
  return obj;
}

const SLICES = ["digest", "lines", "head", "tail", "grep"];
const slicing = (url: URL) => SLICES.some((k) => url.searchParams.has(k));

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
  const obj = await getPaste(env, ctx, id);
  if (!obj) return notFound(req);
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
    const fileMeta: Meta = { ...meta, ...(part.customMetadata ?? {}), name: file, lang: entry.lang, lines: String(entry.lines), bytes: String(entry.bytes), tok: String(entry.tokens) };
    delete fileMeta.kind;
    if (mode !== "view") return rawResponse(part.body, fileMeta, id, mode);
    if (streamable(req, url, fileMeta)) return agentStream(part.body, fileMeta);
    return present(req, url, id, ext, fileMeta, await viewText(req, url, fileMeta, part), { files: index.files, file });
  }
  if (file) return notFound(req);

  if (meta.kind === "live") {
    const snap = await live(env, id).snapshot();
    if (!snap) {
      const sealed = await getPaste(env, ctx, id);
      if (!sealed || sealed.customMetadata?.kind === "live") return notFound(req);
      if (mode !== "view") return rawResponse(sealed.body, sealed.customMetadata ?? {}, id, mode);
      return present(req, url, id, ext, sealed.customMetadata ?? {}, await sealed.text());
    }
    const liveMeta = { ...snap.meta, ...statsOf(snap.text) };
    if (mode !== "view") return rawResponse(snap.text, liveMeta, id, mode);
    return present(req, url, id, ext, liveMeta, snap.text, { live: snap.n });
  }

  if (mode !== "view") return rawResponse(obj.body, meta, id, mode);
  if (streamable(req, url, meta)) return agentStream(obj.body, meta);
  return present(req, url, id, ext, meta, await viewText(req, url, meta, obj));
}

async function viewText(req: Request, url: URL, meta: Meta, obj: R2ObjectBody): Promise<string> {
  if (meta.enc === "1" || !(Number(meta.bytes) > INLINE_MAX) || slicing(url) || !wantsHtml(req)) return obj.text();
  await obj.body.cancel();
  return "";
}

function streamable(req: Request, url: URL, meta: Meta): boolean {
  return !meta.ansi && !meta.cr && !meta.enc && meta.lines !== undefined && !slicing(url) && !wantsHtml(req);
}

function agentStream(body: ReadableStream, meta: Meta): Response {
  const headers = agentHeaders(meta);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(body, { headers });
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
  const sliced = slicing(url);
  if (!sliced && wantsHtml(req)) return viewer(req, url, id, ext, meta, body, extra);
  const headers = agentHeaders(meta);
  if (extra.live !== undefined) headers.set("x-bin-live", "1");
  if (meta.enc === "1") {
    headers.set("x-bin-encrypted", "1");
    if (sliced) return fail(400, "this paste is encrypted; read it with `bin get <url> --password`");
    return text(`This paste is encrypted. Read it with: bin get ${url.origin}/${id} --password\n\n${body}\n`, 200, headers);
  }
  const plain = stripAnsi(body);
  if (q.has("digest")) return text(digest(plain, meta), 200, headers);
  if (q.has("grep")) {
    const out = grep(plain, q.get("grep")!, Math.min(Math.max(0, Number(q.get("context")) || 0), 20), range(q.get("lines")));
    if (typeof out !== "string") return fail(400, out.error);
    return text(out, 200, headers);
  }
  if (q.has("lines") || q.has("head") || q.has("tail")) {
    const lines = plain.split("\n");
    if (plain.endsWith("\n")) lines.pop();
    let span: [number, number] | null = null;
    if (q.has("lines")) span = range(q.get("lines"));
    else if (q.has("head")) span = [1, Math.max(1, Number(q.get("head")) || 0)];
    else span = [Math.max(1, lines.length - Math.max(1, Number(q.get("tail")) || 0) + 1), lines.length];
    if (!span) return fail(400, "lines must look like 10-80 or 42");
    const [a, b] = [Math.max(1, span[0]), Math.min(lines.length, span[1])];
    headers.set("x-bin-range", `${a}-${b}`);
    const picked = lines.slice(a - 1, b);
    const numbered = q.get("n") === "1" ? picked.map((l, i) => `${a + i}:${l}`) : picked;
    return text(numbered.length ? `${numbered.join("\n")}\n` : "", 200, headers);
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
  const tokens = Number(meta.tok) || 0;
  if (tokens > 10_000) set("hint", `large paste (~${tokens} tokens): try ?digest, ?head=200, ?tail=200 or ?grep=<text>&context=3`);
  return h;
}

function multiIndex(url: URL, id: string, meta: Meta, files: FileEntry[]): string {
  const head = `# ${meta.t ? `${meta.t} · ` : ""}${files.length} files · ${Number(meta.lines).toLocaleString("en")} lines · ~${Number(meta.tok).toLocaleString("en")} tokens\n`;
  const width = Math.max(...files.map((f) => f.name.length));
  const rows = files.map(
    (f) => `${f.name.padEnd(width)}  ${String(f.lines).padStart(6)} lines  ${`~${f.tokens}`.padStart(7)} tokens  ${url.origin}/${id}/${encodePath(f.name)}`,
  );
  return `${head}\n${rows.join("\n")}\n`;
}

// ---------------------------------------------------------------- compare

async function compare(req: Request, env: Env, ctx: ExecutionContext, url: URL, a: string, b: string): Promise<Response> {
  const [x, y] = await Promise.all([getPaste(env, ctx, a), getPaste(env, ctx, b)]);
  const refuse = (status: number, error: string) => {
    for (const o of [x, y]) o?.body.cancel();
    return status === 404 ? notFound(req) : fail(status, error);
  };
  if (!x || !y) return refuse(404, "");
  for (const o of [x, y]) {
    const m = o.customMetadata ?? {};
    if (m.kind || m.enc) return refuse(400, "only plain single-file pastes can be compared");
    if (Number(m.bytes) > 512_000 || Number(m.lines) > 5000) return refuse(400, "too big to compare (over 500 KB or 5,000 lines)");
  }
  const [ta, tb] = await Promise.all([x.text(), y.text()]);
  const out = unified(a, b, stripAnsi(ta), stripAnsi(tb));
  const meta: Meta = { ...statsOf(out), lang: "diff", t: `${a} → ${b}` };
  return present(req, url, `${a}/vs/${b}`, undefined, meta, out, { diff: `${a}/vs/${b}` });
}

type Op = [-1 | 0 | 1, string];

function unified(an: string, bn: string, a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  if (a.endsWith("\n")) al.pop();
  if (b.endsWith("\n")) bl.pop();
  let pre = 0;
  while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
  let suf = 0;
  while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf++;
  const mid = myers(al.slice(pre, al.length - suf), bl.slice(pre, bl.length - suf));
  if (!mid) return `--- a/${an}\n+++ b/${bn}\n# too different to diff (over 500 changed lines)\n`;
  const ops: Op[] = [...al.slice(0, pre).map((t): Op => [0, t]), ...mid, ...al.slice(al.length - suf).map((t): Op => [0, t])];
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

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const off = n + m + 1;
  const v = new Int32Array(2 * off + 2);
  const trace: Int32Array[] = [];
  search: for (let d = 0; d <= n + m; d++) {
    if (d > 500) return null;
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
    const index = await env.BUCKET.get(`p/${id}`);
    const files = index ? ((await index.json()) as { files: FileEntry[] }).files : [];
    if (files.length) await env.BUCKET.delete(files.map((f) => `p/${id}/${f.name}`));
  }
  await env.BUCKET.delete(`p/${id}`);
}

// ---------------------------------------------------------------- text tools

function statsOf(src: string | Uint8Array, byteLength?: number): Meta {
  let lines = 0;
  let bytes: number;
  let last: number;
  if (typeof src === "string") {
    for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) lines++;
    bytes = byteLength ?? new TextEncoder().encode(src).byteLength;
    last = src.charCodeAt(src.length - 1);
  } else {
    for (let i = src.indexOf(10); i !== -1; i = src.indexOf(10, i + 1)) lines++;
    bytes = src.byteLength;
    last = src[src.length - 1];
  }
  if (src.length && last !== 10) lines++;
  const meta: Meta = { lines: String(lines), bytes: String(bytes), tok: String(Math.ceil(bytes / 4)) };
  const has = (c: number) => (typeof src === "string" ? src.includes(String.fromCharCode(c)) : src.includes(c));
  if (has(27)) meta.ansi = "1";
  if (has(13)) meta.cr = "1";
  return meta;
}

const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]?/g;

function stripAnsi(s: string): string {
  if (!/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) return s;
  let out = s.replace(ANSI_RE, "");
  if (out.includes("\r")) {
    out = out.replace(/\r\n/g, "\n").replace(/[^\n]*\r[^\n]*/g, (l) => l.slice(l.lastIndexOf("\r", l.length - 2) + 1).replace(/\r$/, ""));
  }
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
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

const ANY_SECRET = new RegExp(SECRETS.map(([re]) => re.source).join("|"));

function scanSecrets(body: string): string[] {
  const sample = body.length > SCAN_MAX ? body.slice(0, SCAN_MAX) : body;
  if (!ANY_SECRET.test(sample)) return [];
  return SECRETS.filter(([re]) => re.test(sample)).map(([, kind]) => `this paste looks like it contains a ${kind}`);
}

function isEnvelope(body: string): boolean {
  try {
    const e = JSON.parse(body);
    return (
      e?.v === 1 &&
      typeof e.salt === "string" &&
      typeof e.iv === "string" &&
      typeof e.ct === "string" &&
      Number.isInteger(e.iter) &&
      e.iter >= 100_000 &&
      e.iter <= 5_000_000
    );
  } catch {
    return false;
  }
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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

type Alt = { start: boolean; end: boolean; pieces: string[] };

function matcher(pattern: string): ((line: string) => boolean) | { error: string } {
  if (!pattern || pattern.length > 300) return { error: "grep needs a pattern of at most 300 characters" };
  const fold = !/[A-Z]/.test(pattern);
  const alts: Alt[] = [];
  let cur: Alt = { start: false, end: false, pieces: [""] };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const piece = cur.pieces.length - 1;
    if (c === "\\") {
      const n = pattern[++i];
      if (n === undefined || /[A-Za-z0-9]/.test(n)) {
        return { error: `grep matches text, with | for "or", ^ and $ for line start and end, and .* for "anything"; \\${n ?? ""} isn't supported` };
      }
      cur.pieces[piece] += n;
    } else if (c === "|") {
      alts.push(cur);
      cur = { start: false, end: false, pieces: [""] };
    } else if (c === "^" && piece === 0 && cur.pieces[0] === "") cur.start = true;
    else if (c === "$" && (pattern[i + 1] === undefined || pattern[i + 1] === "|")) cur.end = true;
    else if (c === "." && pattern[i + 1] === "*") {
      cur.pieces.push("");
      i++;
    } else if ("()[]{}+?*".includes(c)) {
      return { error: `grep matches text, with | for "or", ^ and $ for line start and end, and .* for "anything"; escape ${c} as \\${c}` };
    } else cur.pieces[piece] += c;
  }
  alts.push(cur);
  for (const a of alts) if (fold) a.pieces = a.pieces.map((p) => p.toLowerCase());
  const one = (l: string, a: Alt) => {
    const { pieces } = a;
    if (pieces.length === 1) {
      const p = pieces[0];
      return a.start && a.end ? l === p : a.start ? l.startsWith(p) : a.end ? l.endsWith(p) : l.includes(p);
    }
    let pos = 0;
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      if (k === 0 && a.start) {
        if (!l.startsWith(p)) return false;
        pos = p.length;
      } else if (k === pieces.length - 1 && a.end) {
        return l.length - p.length >= pos && l.endsWith(p);
      } else {
        const at = l.indexOf(p, pos);
        if (at === -1) return false;
        pos = at + p.length;
      }
    }
    return true;
  };
  return (line) => {
    const l = fold ? line.toLowerCase() : line;
    return alts.some((a) => one(l, a));
  };
}

function grep(body: string, pattern: string, context: number, within: [number, number] | null): string | { error: string } {
  const test = matcher(pattern);
  if (typeof test !== "function") return test;
  const lines = body.split("\n");
  if (body.endsWith("\n")) lines.pop();
  const [lo, hi] = within ?? [1, lines.length];
  const hits: number[] = [];
  for (let i = Math.max(0, lo - 1); i < Math.min(lines.length, hi); i++) if (test(lines[i])) hits.push(i);
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
      out.push("-- (stopped after 5000 lines; narrow the pattern or add &lines=)");
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
      .slice(0, 300)
      .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b|\d+(?:\.\d+)?/gi, (m) => (m[1] === "x" || m[1] === "X" ? "0x…" : /^\d+(?:\.\d+)?$/.test(m) ? "N" : "…"));
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
    if (errors.size + warns.size >= 2000) continue;
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
  req: Request,
  url: URL,
  id: string,
  ext: string | undefined,
  meta: Meta,
  body: string,
  extra: { files?: FileEntry[]; file?: string; live?: number; diff?: string },
): Response {
  const enc = meta.enc === "1";
  const inline = enc || Number(meta.bytes || body.length) <= INLINE_MAX;
  const heading = meta.t || meta.name || "";
  const { cls, html } = viewBody({
    id,
    ext: ext ?? "",
    host: url.host,
    wrap: cookie(req, "wrap") === "1",
    meta,
    text: enc || !inline ? undefined : stripAnsi(body),
    ansi: inline && !enc && meta.ansi === "1" ? body : undefined,
    enc: enc ? body : undefined,
    files: extra.files,
    file: extra.file,
    live: extra.live === undefined ? undefined : inline ? extra.live : 0,
    diff: extra.diff,
  });
  const desc = inline ? preview(body, meta) : `${Number(meta.lines || 0).toLocaleString("en")} lines`;
  const raw = extra.diff ? "" : `/raw/${id}${extra.file ? `/${segments(extra.file)}` : ""}`;
  const hl = inline && !enc && meta.ansi !== "1" && extra.live === undefined ? hlModules(meta.lang || "", body.length) : null;
  const og = `${(hl ?? []).map((m) => `<link rel="modulepreload" href="${m}">`).join("")}
<meta property="og:title" content="${esc(heading || id)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:site_name" content="bin"><meta property="og:type" content="article"><meta name="twitter:card" content="summary">${raw ? `<link rel="alternate" type="text/plain" href="${raw}">` : ""}`;
  return page(req, `${head(req, `${heading || id} · bin`, og, "/view.js")}
<body class="${cls}">
${html}
</body></html>`);
}

function composePage(req: Request): Response {
  const mac = /Macintosh|iPhone|iPad/.test(req.headers.get("user-agent") ?? "");
  const mod = mac ? "⌘" : "Ctrl+";
  const options = (name: string, label: string, items: [string, string][], selected: string) =>
    `<span class="lbl">${label}</span><select id="${name}" aria-label="${label}">${items.map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const langs = [["auto", "auto"], ...[...LANGS].sort().map((l) => [l, l])] as [string, string][];
  const secrets = SECRETS.map(([re, kind]) => [re.source, kind]);
  return page(req, `${head(req, "bin", `<meta name="description" content="Paste text, get a link.">`, "/compose.js")}
<body class="compose">
<header class="top wrap"><a class="mark" href="/">bin</a><span class="sp"></span>${THEME_BUTTON}</header>
<main class="wrap"><textarea id="t" spellcheck="false" autofocus aria-label="Paste" placeholder="Paste to save instantly&#10;${mac ? "⇧⌘V" : "Ctrl+Shift+V"} to edit first"></textarea></main>
<footer class="bar wrap">
<input id="title" class="field" placeholder="Title" maxlength="200" autocomplete="off" aria-label="Title">
${options("lang", "Language", langs, "auto")}
${options("ttl", "Expires", [["never", "never"], ["1h", "in 1 hour"], ["1d", "in 1 day"], ["7d", "in 7 days"], ["30d", "in 30 days"]], "never")}
<span class="pw"><button type="button" id="lock" class="lockbtn" aria-pressed="false" title="Encrypt with a password">${LOCK_ICON}<span>Password</span></button><input id="pw" type="password" placeholder="password" autocomplete="new-password" aria-label="Password" hidden></span>
<span class="sp"></span><span id="status" role="status"></span><button id="save" class="btn">Save <kbd>${mod}S</kbd></button>
</footer>
<script type="application/json" id="data">${safeJson({ mod, secrets })}</script>
</body></html>`);
}

const FONTS = [...CSS.matchAll(/url\("?(\/fonts\/[^)"]+)"?\)/g)].map((m) => m[1]);

function head(req: Request, title: string, extra: string, script?: string): string {
  const theme = themeOf(req);
  const fonts = script ? FONTS : FONTS.filter((f) => !f.includes("mono"));
  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${extra}
<meta name="theme-color" content="${theme === "light" ? "#fcfcfb" : "#0a0a0a"}"><link rel="icon" href="/favicon.svg">
${fonts.map((f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`).join("")}${script ? `<script type="module" src="${script}"></script>` : ""}
<style>${CSS}</style></head>`;
}

function page(req: Request, body: string, status = 200): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", vary: "accept-encoding" });
  const accept = req.headers.get("accept-encoding") ?? "";
  if (/\bbr\b/.test(accept)) headers.set("content-encoding", "br");
  else if (/\bgzip\b/.test(accept)) headers.set("content-encoding", "gzip");
  return new Response(body, { status, headers });
}

function cookie(req: Request, name: string): string | undefined {
  return req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
}

// ---------------------------------------------------------------- helpers

async function isOwner(req: Request, env: Env): Promise<boolean> {
  if (!env.BIN_TOKEN) return false;
  const given = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  return same(given, env.BIN_TOKEN);
}


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
  h.set("strict-transport-security", "max-age=31536000");
  h.set("vary", "accept, sec-fetch-dest, user-agent, cookie");
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
  if (segs[0] === "vs" || segs.some((s) => !s || s === "." || s === ".." || s.startsWith("_"))) return "";
  return name;
}

const encodePath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

function notFound(req: Request): Response {
  if (!wantsHtml(req)) return text("not found\n", 404);
  return page(
    req,
    `${head(req, "Not found · bin", "")}<body class="view"><header class="top wrap"><a class="mark" href="/">bin</a></header><main class="wrap"><h1>Not found</h1><p class="muted">This paste doesn't exist, expired, or was deleted.</p></main></body></html>`,
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
