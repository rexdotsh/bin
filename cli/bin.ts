#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm as removeFile, stat, writeFile } from "node:fs/promises";
import { constants as osConstants, homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

const DEFAULT_URL = "https://bin.rex.wf";
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "bin");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DELETES_FILE = path.join(CONFIG_DIR, "deletes.json");
const DELETES_DIR = path.join(CONFIG_DIR, "deletes");
const MAX_BYTES = 5 * 1024 * 1024;
const ITER = 600_000;
const isLocal = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");
const common = { url: { type: "string" }, json: { type: "boolean" } } as const;
const pasteOpts = {
  ...common,
  title: { type: "string" },
  lang: { type: "string" },
  ttl: { type: "string" },
  name: { type: "string" },
  password: { type: "boolean" },
  redact: { type: "boolean" },
  "allow-secrets": { type: "boolean" },
} as const;

const HELP = `bin - paste text to your bin and get a link

Usage:
  bin [file...]                     paste files (several files make one link with a tab each)
  cmd | bin                         paste stdin
  bin run [opts] -- <cmd> [args]    run a command, paste its output with the exit code, exit with its code
  bin get <id|url> [--digest | --grep <text> [--context n] | --head n | --tail n | --lines a-b | --raw] [--password]
  bin rm <id|url>                   delete a paste (one you made from this machine, or any with the owner token)
  bin update                        update this CLI (and the skill) from your bin
  bin setup [--token|--rotate]      owner only: save + set the owner token (--token: paste an existing one)

Paste options:
  --title <t>       a title
  --lang <l>        highlighting (default: from the file name or content)
  --ttl <t>         1h, 1d, 7d, 30d or never (default never)
  --name <n>        file name for stdin, e.g. --name crash.log
  --password        encrypt before uploading (asks, or reads $BIN_PASSWORD); the server never sees the text
  --redact          mask anything that looks like a secret instead of refusing
  --allow-secrets   upload even if it looks like it contains secrets
  --json            machine-readable receipt

Every command accepts --url <url>. Precedence: --url, $BIN_URL, config file, ${DEFAULT_URL}.
No setup needed to paste; the owner token only lifts limits. Config: ${CONFIG_FILE} (env: BIN_URL, BIN_TOKEN)
`;

type Config = { url: string; token: string; hint?: string };
type Receipt = {
  ok: true;
  id: string;
  url: string;
  raw: string;
  delete?: string;
  lines?: number;
  bytes?: number;
  tokens?: number;
  warnings?: string[];
  files?: { name: string; url: string }[];
};

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SECRETS: [RegExp, string][] = [
  [/\b[sr]k_live_[0-9a-zA-Z]{16,}/g, "Stripe key"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[0-9A-Za-z_]{20,}/g, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "private key"],
  [/\bxox[abpr]-[0-9A-Za-z-]{10,}/g, "Slack token"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "Google API key"],
  [/^(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"'#]{8,}/gm, "secret in an env file"],
];

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const commands: Record<string, (argv: string[]) => Promise<void>> = { run, get, rm, update, setup };
const argv = process.argv.slice(2);
const first = argv[0];

if (first === "help" || first === "--help" || first === "-h" || (!argv.length && process.stdin.isTTY)) {
  process.stdout.write(HELP);
} else if (first && Object.hasOwn(commands, first)) {
  commands[first](argv.slice(1)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
} else {
  paste(argv).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

// ---------------------------------------------------------------- paste

async function paste(args: string[]) {
  const { values: o, positionals } = parseArgs({ args, allowPositionals: true, options: pasteOpts });
  const cfg = await loadConfig(o.url);
  const files: [string, string][] = [];
  if (positionals.length) {
    for (const p of positionals) files.push([path.basename(p), await readTextFile(p)]);
    if (new Set(files.map(([n]) => n)).size !== files.length) {
      files.splice(0, files.length);
      const root = commonDir(positionals.map((p) => path.resolve(p)));
      for (const p of positionals) files.push([path.relative(root, path.resolve(p)).split(path.sep).join("/"), await readTextFile(p)]);
    }
  } else {
    if (process.stdin.isTTY) throw new Error("nothing to paste: give a file, or pipe something in");
    files.push([o.name ?? "", await readStdin()]);
  }
  const total = files.reduce((n, [, t]) => n + Buffer.byteLength(t), 0);
  if (!total) throw new Error("that's empty");
  if (total > MAX_BYTES) throw new Error("over the 5 MB limit");

  if (!o.password) {
    const found = files.flatMap(([n, t]) => findSecrets(t).map((f) => ({ ...f, file: n })));
    if (found.length && o.redact) {
      for (const f of files) f[1] = redact(f[1]);
      process.stderr.write(`bin: masked ${found.length} secret${found.length === 1 ? "" : "s"}\n`);
    } else if (found.length && !o["allow-secrets"]) {
      const lines = found.slice(0, 8).map((f) => `  ${f.file ? `${f.file}:` : "line "}${f.line}  ${f.kind}: ${f.preview}`);
      throw new Error(`this looks like it contains secrets:\n${lines.join("\n")}\nrefusing. Use --redact to mask them, --password to encrypt, or --allow-secrets`);
    }
  }

  const params = new URLSearchParams();
  if (o.title) params.set("title", o.title);
  if (o.lang) params.set("lang", o.lang);
  if (o.ttl) params.set("ttl", o.ttl);
  let init: RequestInit;
  if (o.password) {
    if (files.length > 1) throw new Error("--password works with one file at a time");
    const password = await readSecret("password: ", "BIN_PASSWORD");
    params.set("enc", "1");
    if (o.name) params.set("name", o.name);
    else if (!o.lang && files[0][0].includes(".")) params.set("lang", files[0][0].split(".").pop()!);
    init = { method: "POST", body: encrypt(files[0][1], password), headers: { "content-type": "text/plain; charset=utf-8" } };
  } else if (files.length === 1) {
    if (files[0][0]) params.set("name", files[0][0]);
    init = { method: "POST", body: files[0][1], headers: { "content-type": "text/plain; charset=utf-8" } };
  } else {
    const form = new FormData();
    for (const [name, body] of files) form.append(name, new Blob([body], { type: "text/plain" }), name);
    init = { method: "POST", body: form };
  }
  const r = await api<Receipt>(cfg, `/?${params}`, init);
  await remember(r);
  if (o.json) return printJson(r);
  const copied = process.stdout.isTTY && (await copy(r.url));
  console.log(`${r.url}${copied ? "  (copied)" : ""}`);
  for (const w of r.warnings ?? []) process.stderr.write(`bin: warning: ${w}\n`);
}

// ---------------------------------------------------------------- run

async function run(args: string[]) {
  const dash = args.indexOf("--");
  let optArgs = dash === -1 ? [] : args.slice(0, dash);
  let cmd = dash === -1 ? args : args.slice(dash + 1);
  if (dash === -1) {
    const firstPlain = args.findIndex((a, i) => !a.startsWith("-") && !["--title", "--ttl", "--url"].includes(args[i - 1] ?? ""));
    optArgs = firstPlain === -1 ? args : args.slice(0, firstPlain);
    cmd = firstPlain === -1 ? [] : args.slice(firstPlain);
  }
  const { values: o } = parseArgs({ args: optArgs, options: { ...common, title: { type: "string" }, ttl: { type: "string" } } });
  if (!cmd.length) throw new Error("usage: bin run [--title t] [--ttl t] -- <command> [args]");
  const cfg = await loadConfig(o.url);
  const started = Date.now();
  const shown = redactArgs(cmd).map(shellQuote).join(" ");
  const session = collect(cfg, { title: o.title, ttl: o.ttl, cmd: shown });
  const env = { ...process.env };
  if (!env.NO_COLOR && !env.FORCE_COLOR) env.FORCE_COLOR = "1";
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ["inherit", "pipe", "pipe"], env });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const outDec = new StringDecoder("utf8");
  const errDec = new StringDecoder("utf8");
  child.stdout.on("data", (d: Buffer) => {
    (o.json ? process.stderr : process.stdout).write(d);
    session.push(outDec.write(d));
  });
  child.stderr.on("data", (d: Buffer) => {
    process.stderr.write(d);
    session.push(errDec.write(d));
  });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      const msg = err.code === "ENOENT" ? `command not found: ${cmd[0]}` : err.message;
      process.stderr.write(`bin: ${msg}\n`);
      session.push(`bin: ${msg}\n`);
      resolve([127, null]);
    });
    child.on("close", (c, s) => resolve([c, s]));
  });
  session.push(outDec.end() + errDec.end());
  process.off("SIGINT", ignore);
  const exit = code ?? signal ?? "1";
  const dur = Date.now() - started;
  process.exitCode = code ?? 128 + ((signal && osConstants.signals[signal]) || 1);
  await session.close({ exit, dur });
  if (!session.receipt) return;
  if (o.json) return printJson({ ...session.receipt, exit: process.exitCode, ...(signal && { signal }), durationMs: dur });
  const link = session.receipt.url;
  const copied = process.stderr.isTTY && (await copy(link));
  process.stderr.write(`bin: exit ${exit} · ${fmtDuration(dur)} · ${link}${copied ? "  (copied)" : ""}\n`);
}

type Sink = {
  receipt: Receipt | null;
  push: (s: string) => void;
  close: (seal: { exit?: string | number; dur?: number }) => Promise<void>;
};

function collect(cfg: Config, opts: { title?: string; ttl?: string; cmd: string }): Sink {
  const limit = (cfg.token ? 5 : 2) * 1024 * 1024 - 4096;
  const redactLine = makeRedactor();
  const parts: string[] = [];
  let pending = "";
  let size = 0;
  let cut = 0;
  const keep = (text: string) => {
    if (!text) return;
    if (Buffer.byteLength(text) > limit) {
      const tail = Buffer.from(text).subarray(-limit).toString("utf8").replace(/^\uFFFD+/, "");
      cut += Buffer.byteLength(text) - Buffer.byteLength(tail);
      text = tail;
    }
    parts.push(text);
    size += Buffer.byteLength(text);
    while (size > limit && parts.length > 1) {
      const dropped = parts.shift()!;
      size -= Buffer.byteLength(dropped);
      cut += Buffer.byteLength(dropped);
    }
  };
  const sink: Sink = {
    receipt: null,
    push: (s) => {
      pending += s;
      const nl = pending.lastIndexOf("\n") + 1;
      if (!nl) {
        if (pending.length > 1024 * 1024) {
          keep(redactLine(pending).replaceAll("\0", ""));
          pending = "";
        }
        return;
      }
      keep(redactLine(pending.slice(0, nl)).replaceAll("\0", ""));
      pending = pending.slice(nl);
    },
    close: async (seal) => {
      keep(redactLine(pending).replaceAll("\0", ""));
      const params = new URLSearchParams({ lang: "log", cmd: opts.cmd });
      if (opts.title) params.set("title", opts.title);
      if (opts.ttl) params.set("ttl", opts.ttl);
      if (seal.exit !== undefined) params.set("exit", String(seal.exit));
      if (seal.dur !== undefined) params.set("dur", String(seal.dur));
      const body = (cut ? `[bin: the first ${fmtSize(cut)} of output were cut to fit the size limit]\n` : "") + (parts.join("") || "(no output)\n");
      try {
        sink.receipt = await api<Receipt>(cfg, `/?${params}`, { method: "POST", body, headers: { "content-type": "text/plain; charset=utf-8" } });
        await remember(sink.receipt);
      } catch (err) {
        process.stderr.write(`bin: couldn't upload the output (${err instanceof Error ? err.message : err})\n`);
      }
    },
  };
  return sink;
}

function fmtSize(n: number): string {
  return n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- get / rm

async function get(args: string[]) {
  const { values: o, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...common,
      digest: { type: "boolean" },
      grep: { type: "string" },
      context: { type: "string" },
      head: { type: "string" },
      tail: { type: "string" },
      lines: { type: "string" },
      raw: { type: "boolean" },
      password: { type: "boolean" },
    },
  });
  if (positionals.length !== 1) throw new Error("usage: bin get <id|url> [--digest | --grep text | --head n | --tail n | --lines a-b | --raw]");
  const cfg = await loadConfig(o.url);
  const { base, id, file, query } = locate(cfg, positionals[0]);
  const params = new URLSearchParams(query);
  if (o.digest) params.set("digest", "1");
  if (o.grep) params.set("grep", o.grep);
  if (o.context) params.set("context", o.context);
  if (o.head) params.set("head", o.head);
  if (o.tail) params.set("tail", o.tail);
  if (o.lines) params.set("lines", o.lines);
  const target = `${base}/${o.raw || o.password ? "raw/" : ""}${id}${file ? `/${file}` : ""}${params.size ? `?${params}` : ""}`;
  const res = await request(cfg, target, { headers: { accept: "text/plain" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.match(/"error":"([^"]+)"/)?.[1] ?? body.trim().slice(0, 200)}`);
  }
  let body = await res.text();
  if (res.headers.get("x-bin-encrypted") || o.password) {
    if (!o.password && !process.stdin.isTTY && !process.env.BIN_PASSWORD) throw new Error("this paste is encrypted; pass --password");
    if (params.size) throw new Error("encrypted pastes can't be sliced on the server; get the whole thing");
    const envelope = res.headers.get("x-bin-encrypted") && !o.raw && !o.password ? (await (await request(cfg, `${base}/raw/${id}`)).text()) : body;
    body = decrypt(envelope, await readSecret("password: ", "BIN_PASSWORD"));
  }
  const facts = [res.headers.get("x-bin-lines") && `${res.headers.get("x-bin-lines")} line${res.headers.get("x-bin-lines") === "1" ? "" : "s"}`, res.headers.get("x-bin-tokens") && `~${res.headers.get("x-bin-tokens")} tokens`];
  const range = res.headers.get("x-bin-range");
  if (range) facts.push(`showing ${range}`);
  const exit = res.headers.get("x-bin-exit");
  if (exit) facts.push(`exit ${exit}`);
  process.stderr.write(`# ${[`${id}${file ? `/${file}` : ""}`, ...facts.filter(Boolean)].join(" · ")}\n`);
  process.stdout.write(body);
}

async function rm(args: string[]) {
  const { values: o, positionals } = parseArgs({ args, allowPositionals: true, options: common });
  if (positionals.length !== 1) throw new Error("usage: bin rm <id|url>");
  const cfg = await loadConfig(o.url);
  const { base, id } = locate(cfg, positionals[0]);
  const file = tokenFile(base, id);
  const legacy = ((await readJson(DELETES_FILE)) ?? {}) as Record<string, string>;
  const saved = (await readText(file))?.trim() || legacy[`${new URL(base).origin}/${id}`];
  const headers: Record<string, string> = {};
  if (saved) headers["x-delete"] = saved;
  else if (!cfg.token) throw new Error("no delete token for that paste on this machine (and no owner token)");
  const res = await api<{ deleted: string }>(cfg, `${base}/${id}`, { method: "DELETE", headers });
  await removeFile(file, { force: true });
  if (o.json) return printJson(res);
  console.log(`deleted ${id}`);
}

function locate(cfg: Config, ref: string): { base: string; id: string; file: string; query: string } {
  if (/^https?:\/\//i.test(ref)) {
    const u = new URL(ref);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "raw" || parts[0] === "dl") parts.shift();
    const id = parts[0]?.match(/^([A-Za-z0-9+-]{6})/)?.[1];
    if (!id) throw new Error(`that doesn't look like a paste link: ${ref}`);
    return { base: u.origin, id, file: parts.slice(1).join("/"), query: u.search };
  }
  const [idPart, ...rest] = ref.split("/");
  const id = idPart.match(/^([A-Za-z0-9+-]{6})(?:\.\w+)?$/)?.[1];
  if (!id) throw new Error(`not a paste id: ${ref}`);
  return { base: cfg.url, id, file: rest.map(encodeURIComponent).join("/"), query: "" };
}

const tokenFile = (origin: string, id: string) => path.join(DELETES_DIR, `${new URL(origin).host.replace(/[^\w.-]/g, "_")}_${id.replace(/\+/g, "%2B")}`);

async function remember(r: Receipt) {
  if (!r.delete) return;
  await writePrivate(tokenFile(r.url, r.id), `${r.delete}\n`);
}

// ---------------------------------------------------------------- secrets + crypto

function findSecrets(text: string): { line: number; kind: string; preview: string }[] {
  const out: { line: number; kind: string; preview: string }[] = [];
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const [re, kind] of SECRETS) {
    for (const m of text.matchAll(re)) {
      const line = lineOf(m.index);
      const first = m[0].split("\n")[0];
      out.push({ line, kind, preview: `${first.slice(0, Math.min(8, Math.floor(first.length / 3)))}…` });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const SECRET_FLAG = /^--?[\w-]*(?:token|secret|password|passwd|api[-_]?key|auth)[\w-]*$/i;

function redactArgs(args: string[]): string[] {
  return args.map((a, i) => {
    if (i > 0 && SECRET_FLAG.test(args[i - 1])) return "[redacted]";
    const eq = a.indexOf("=");
    if (eq > 0 && /token|secret|password|passwd|api[-_]?key|auth/i.test(a.slice(0, eq))) return `${a.slice(0, eq + 1)}[redacted]`;
    return redact(a);
  });
}

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()*+\-./][ -~]|\x1b[@-Z\\-_]?/g;

function makeRedactor(): (text: string) => string {
  let inKey = false;
  return (text) =>
    text
      .split("\n")
      .map((line) => {
        if (inKey) {
          if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = false;
          return line ? "[redacted private key]" : line;
        }
        const begin = line.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
        if (begin !== -1) {
          inKey = !/-----END [A-Z ]*PRIVATE KEY-----/.test(line.slice(begin));
          return `${redact(line.slice(0, begin))}[redacted private key]`;
        }
        const once = redact(line);
        if (once !== line || !line.includes("\x1b")) return once;
        const plain = line.replace(ANSI, "");
        const clean = redact(plain);
        return clean === plain ? line : clean;
      })
      .join("\n");
}

function redact(text: string): string {
  let out = text;
  for (const [re, kind] of SECRETS) {
    out = out.replace(re, (m) => {
      const eq = kind === "secret in an env file" ? m.indexOf("=") + 1 : 0;
      return `${m.slice(0, eq)}[redacted ${kind}]`;
    });
  }
  return out;
}

function encrypt(text: string, password: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, ITER, 32, "sha256");
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, kdf: "pbkdf2-sha256", iter: ITER, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") });
}

function decrypt(envelope: string, password: string): string {
  let e: { iter: number; salt: string; iv: string; ct: string };
  try {
    e = JSON.parse(envelope);
  } catch {
    throw new Error("that paste isn't encrypted");
  }
  if (!(e.iter >= 100_000 && e.iter <= 5_000_000)) throw new Error("that encrypted paste has an unsupported key setting");
  const ct = Buffer.from(e.ct, "base64");
  const key = pbkdf2Sync(password, Buffer.from(e.salt, "base64"), e.iter, 32, "sha256");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
  } catch {
    throw new Error("wrong password");
  }
}

// ---------------------------------------------------------------- update / setup

async function update(args: string[]) {
  const { values: o } = parseArgs({ args, options: common });
  const cfg = await loadConfig(o.url);
  const self = await realpath(process.argv[1]);
  const repo = await gitRoot(self);
  if (repo) throw new Error(`${self} is in a git checkout (${repo}); use git pull instead`);
  const targets: [string, string][] = [["/cli", self]];
  const skill = path.join(homedir(), ".agents", "skills", "bin", "SKILL.md");
  if ((await lstat(skill).catch(() => null))?.isFile()) {
    const real = await realpath(skill);
    if (!(await gitRoot(real))) targets.push(["/skill.md", real]);
  }
  for (const [route, file] of targets) {
    const res = await request(cfg, route);
    const body = await res.text();
    if (!res.ok || (route === "/cli" && !body.startsWith("#!/usr/bin/env"))) throw new Error(`couldn't download ${cfg.url}${route}`);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
    await writeFile(temp, body, { flag: "wx", mode: route === "/cli" ? 0o755 : 0o644 });
    await rename(temp, file).catch(async (err) => {
      await removeFile(temp, { force: true });
      throw err;
    });
    console.log(`updated ${file}`);
  }
}

async function gitRoot(file: string): Promise<string | null> {
  const home = homedir();
  for (let dir = path.dirname(file); dir !== home; dir = path.dirname(dir)) {
    if (await stat(path.join(dir, ".git")).catch(() => null)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
  return null;
}

async function setup(args: string[]) {
  const { values: o, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...common, token: { type: "boolean" }, rotate: { type: "boolean" } },
  });
  if (positionals.length) {
    throw new Error("don't put the token on the command line (it shows up in ps and shell history); run `bin setup --token` and paste it when asked, or pipe it in");
  }
  const current = ((await readJson(CONFIG_FILE)) ?? {}) as Partial<Config>;
  const url = instanceUrl(o.url || process.env.BIN_URL || current.url || DEFAULT_URL);
  const sameInstance = new URL(url).origin === new URL(instanceUrl(current.url || DEFAULT_URL)).origin;
  const token = o.token ? await readSecret("token: ") : (!o.rotate && sameInstance && current.token) || randomBytes(32).toString("base64url");

  if (!o.token) {
    const repo = path.join(path.dirname(await realpath(process.argv[1])), "..");
    const config = await readText(path.join(repo, "wrangler.jsonc"));
    if (config === null) throw new Error("creating or rotating the token runs wrangler from a bin checkout; on this machine use `bin setup --token`");
    const hosts = [...config.matchAll(/"pattern"\s*:\s*"([^"/]+)/g)].map((m) => m[1]);
    if (!hosts.includes(new URL(url).hostname)) {
      throw new Error(`this sets the token on the Worker in ${repo} (${hosts.join(", ")}), not ${url}; use \`bin setup --token\` for other instances`);
    }
    console.log("setting BIN_TOKEN on the Worker with wrangler...");
    if ((await runQuiet(["bunx", "wrangler", "secret", "put", "BIN_TOKEN"], { input: token, cwd: repo })) !== 0) {
      throw new Error("wrangler failed. Is the Worker deployed and are you logged in (`bunx wrangler login`)?");
    }
  }
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writePrivate(CONFIG_FILE, `${JSON.stringify({ ...(url !== DEFAULT_URL && { url }), token }, null, 2)}\n`);
  console.log(`saved ${CONFIG_FILE}`);
}

// ---------------------------------------------------------------- plumbing

async function loadConfig(flagUrl?: string): Promise<Config> {
  const file = ((await readJson(CONFIG_FILE)) ?? {}) as Partial<Config>;
  const saved = instanceUrl(file.url || DEFAULT_URL);
  const url = instanceUrl(flagUrl || process.env.BIN_URL || saved);
  if (process.env.BIN_TOKEN) return { url, token: process.env.BIN_TOKEN };
  if (new URL(url).origin === new URL(saved).origin) return { url, token: file.token || "" };
  const hint = file.token ? ` (the saved token is only sent to ${saved}; set BIN_TOKEN to use ${url})` : "";
  return { url, token: "", hint };
}

function instanceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !isLocal(url.hostname)) throw new Error(`${raw}: use https (plain http is only allowed for localhost)`);
  return raw.replace(/\/+$/, "");
}

async function request(cfg: Config, target: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(target, `${cfg.url}/`);
  const origin = new URL(cfg.url).origin;
  const first = url.origin;
  for (let hop = 0; hop < 5; hop++) {
    const headers = new Headers(init.headers);
    if (url.origin !== first) for (const h of ["x-delete", "x-write"]) headers.delete(h);
    if (url.origin === origin && cfg.token) headers.set("authorization", `Bearer ${cfg.token}`);
    else headers.delete("authorization");
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, redirect: "manual" });
    } catch (err) {
      throw new Error(`could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    url = new URL(location, url);
    if (url.protocol !== "https:" && !isLocal(url.hostname)) throw new Error(`refusing to follow a redirect to ${url.origin}`);
  }
  throw new Error("too many redirects");
}

async function api<T>(cfg: Config, target: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const res = await request(cfg, target, { ...init, headers });
  const body = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!body) throw new HttpError(`unexpected HTTP ${res.status} from ${new URL(target, `${cfg.url}/`).origin}`, res.status);
  if (!res.ok || !body.ok) throw new HttpError(`${body.error || `HTTP ${res.status}`}${res.status === 401 || res.status === 403 ? (cfg.hint ?? "") : ""}`, res.status);
  return body;
}

async function readTextFile(p: string): Promise<string> {
  const st = await stat(p).catch(() => null);
  if (!st?.isFile()) throw new Error(`not a file: ${p}`);
  if (st.size > MAX_BYTES) throw new Error(`${p} is over the 5 MB limit`);
  const bytes = await readFile(p);
  if (bytes.includes(0)) throw new Error(`${p} isn't text`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${p} isn't UTF-8 text`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("stdin is over the 5 MB limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.includes(0)) throw new Error("stdin isn't text");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("stdin isn't UTF-8 text");
  }
}

function commonDir(paths: string[]): string {
  let dir = path.dirname(paths[0]);
  const prefix = () => (dir.endsWith(path.sep) ? dir : dir + path.sep);
  while (!paths.every((p) => p.startsWith(prefix())) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

async function readSecret(prompt: string, envName?: string): Promise<string> {
  if (envName && process.env[envName]) return process.env[envName]!;
  let value = "";
  if (!process.stdin.isTTY) {
    if (envName) throw new Error(`no terminal to ask on; set $${envName}`);
    for await (const chunk of process.stdin) value += chunk;
  } else {
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    try {
      for await (const chunk of process.stdin) {
        let done = false;
        for (const ch of chunk as string) {
          if (ch === "\r" || ch === "\n") done = true;
          else if (ch === "\u0003") throw new Error("cancelled");
          else if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
          if (done) break;
        }
        if (done) break;
      }
    } finally {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    }
  }
  value = value.replace(/\r?\n$/, "");
  if (!value) throw new Error("nothing entered");
  return value;
}

function runQuiet(cmd: string[], opts: { input?: string; cwd?: string } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, stdio: [opts.input === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
    child.stdin?.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

async function copy(text: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [["wl-copy"]] : []),
            ...(process.env.DISPLAY ? [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] : []),
          ];
  for (const cmd of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}

async function writePrivate(file: string, body: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string) {
  if (process.argv.includes("--json")) printJson({ ok: false, error: message });
  else process.stderr.write(`bin: ${message}\n`);
  process.exitCode = 1;
}
