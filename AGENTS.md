# AGENTS.md

bin: an agent-first pastebin at bin.rex.wf. One Cloudflare Worker, one R2 bucket, one Durable Object class for live pastes, a zero-dependency CLI and a skill. Built like tack (`~/tack`), which serves HTML docs; bin only ever serves text.

## Layout

- `src/worker.ts`: the whole Worker (create, read, slices, digest, compare, delete, page shells) plus the `Live` Durable Object.
- `web/`: browser code, bundled by `bun run build` into static assets: `view.ts` (the paste viewer: rendering, ANSI colours, highlighting, selection, keyboard, unlock, live streaming), `compose.ts` (the new-paste page), `crypto.ts` (shared PBKDF2 + AES-GCM), `theme.ts`, `hl.ts` (highlight.js, lazy-loaded), `bin.css`.
- `cli/bin.ts`: the whole CLI, zero dependencies, Node built-ins only and erasable TypeScript only (runs as-is on Node 22.18+ and Bun; bundled to `dist/cli` for Node 20+).
- `skill/bin/SKILL.md`: the agent skill. `public/llms.txt`: plain-text usage, also what `GET /` returns to non-browsers.
- `scripts/import.ts`: one-off import of the old wastebin export (`bin-export*` is gitignored; never commit it, it holds other people's pastes).
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so it's the source of truth. `dist/` is served as static assets before the Worker (`/cli`, `/install`, `/skill.md`, `/llms.txt`, `/view.js`, `/compose.js`, `/hl.js`, `/bin.css`, `/fonts/*`, `/favicon.svg`).

## Commands

```sh
bun install
bun run check     # wrangler types + tsc for worker, cli and web
bun run build     # dist/; fails unless it holds exactly the expected files
printf 'BIN_TOKEN=dev\n' > .dev.vars
bun run dev       # local worker on :8787 with local R2, DO and rate limiter
echo hi | curl --data-binary @- http://127.0.0.1:8787
BIN_URL=http://127.0.0.1:8787 XDG_CONFIG_HOME=/tmp/bin-cfg ./cli/bin.ts file.ts
```

There are no automated tests. Verify against `bun run dev` with curl, the CLI and a browser. `bun run dev` runs `bun run build` on start (the `build.command` in `wrangler.jsonc`), which recreates `dist/`; don't run two dev servers from the same checkout. Never run `bin setup` without `--token` while testing (it sets the secret on the real Worker), and don't run wrangler commands that touch Cloudflare.

## Rules

- Bun for repo tooling. No npm/npx.
- The CLI must not depend on Bun (no `Bun.*`, no top-level await, erasable syntax only). Check with `node cli/bin.ts` and `bun run build && node dist/cli`.
- Minimal: no frameworks, no runtime dependencies in the Worker. highlight.js and the Geist fonts are bundled into static assets at build time.
- No comments unless the code would be misleading without one.
- Conventional commits with short messages.

## Model

- A paste is one R2 object `p/<id>` with everything else in `customMetadata` (strings): `at`, `t` (title), `name`, `lang`, `lines`, `bytes`, `tok` (≈ bytes/4), `ansi` (has ESC), `cr` (has `\r`), `exp` (unix seconds), `del` (sha256 of the delete token), `enc`, `kind` (`multi` | `live`), `files`, `cmd`, `exit`, `dur`. A read is one R2 get. Pastes are immutable: no editing, no versions ("edit as new" forks).
- IDs are 6 random characters from `A-Za-z0-9`, written create-only (`if-none-match: *`) so a new paste never overwrites an old one. The router also accepts `+` and `-` in ids, for imported wastebin links in the upstream alphabet; only the owner can choose an id (`?id=`).
- Multi-file: `p/<id>` holds a JSON index (`{ files: [{ name, lang, lines, bytes, tokens }] }`), each file is `p/<id>/<name>`. File names are canonical relative paths (no `.`/`..`/empty segments, no backslashes, no leading `_`).
- Expiry is checked on read; an expired paste reads as 404 and is purged lazily. No cron, no lifecycle rules. Anonymous pastes never expire unless `ttl` is set.
- Live pastes (`?live=1`, used by `bin run` and `bin --live`): the create writes a placeholder `p/<id>` (`kind: live`) and starts the paste's `Live` Durable Object with the hash of a write token. Chunks (`POST /<id>/_append`, `x-write`, ≤ 64 KB of UTF-8) are appended to a tail segment (`s:<n>`, ≤ 512 KB, rewritten per append: one row written per append, and only a handful of rows to delete at seal) and broadcast to hibernatable WebSockets as `{append, n}`, where `n` is the text length so far; `/<id>/_live?from=n` replays from that character offset. The DO keeps the text in memory and rebuilds it from the segments with one `list` on a cold start; reads of a live paste come from memory. An empty append is a heartbeat (writes only `last`; the CLI sends one after 4 quiet minutes). The alarm is set once and re-armed lazily: it fires at the earlier of expiry and `last + 10 min`; idle pastes seal as exit `interrupted`, expired ones are deleted. `POST /<id>/_seal` writes the full text to R2 with `onlyIf: { etagMatches }` of the placeholder (so a paste deleted mid-run stays deleted), tells tabs `{sealed}` (they reload), and clears the DO. Byte cap = the creator's paste limit; at most 20,000 appends.
- Delete: `DELETE /<id>` with `x-delete: <token>` (returned once to anonymous creators; the CLI and the browser keep it) or the owner token. Compare secrets with `same()`.
- Owner: `Authorization: Bearer <BIN_TOKEN>` lifts the size limit (2 MB → 5 MB), the file cap (10 → 50) and the rate limit, and allows `?id=` and `?expires=`. Anonymous creates go through the `ANON` rate-limit binding (about 20 a minute per IP, IPv6 keyed by /64, per location; multi-file creates are weighted by file count). Request bodies are read with a byte cap (`readBounded`), never buffered whole first.
- Encrypted pastes are encrypted client-side (browser or CLI): `{ v: 1, kdf: "pbkdf2-sha256", iter, salt, iv, ct }`, AES-256-GCM with the tag appended to `ct` (WebCrypto's layout). The server stores the envelope and can't read it; slices and digests refuse them.

## Serving

- One URL, two audiences: `wantsHtml()` sends the viewer to browsers (`Sec-Fetch-Dest: document`) and chat unfurlers (by user agent), and plain text to everything else. Agents get the text with ANSI escapes and `\r` overwrites resolved; `/raw/<id>` and `/dl/<id>` are always the exact bytes. `/<id>.<ext>` is the same paste; the extension is cosmetic.
- Agent responses carry `x-bin-lines`, `x-bin-bytes`, `x-bin-tokens`, `x-bin-lang`, `x-bin-title`, `x-bin-name`, `x-bin-command`, `x-bin-exit`, `x-bin-duration-ms`, `x-bin-expires`, and `x-bin-hint` above ~10k tokens.
- Agent reads of plain pastes (no ANSI, no `\r`, not encrypted, no slice) stream the R2 body untouched: no decode, no CPU. Everything else is decoded and cleaned with `stripAnsi` (one regex pass, then `\r` overwrites and stray control characters).
- Slices (`lines`, `head`, `tail`, `grep` + `context`, `n=1`) and `digest` are plain text even for browsers. `grep` output matches `grep -n -C`. `grep` is not a regex (user regexes can blow the CPU budget): text, `|` for alternatives, `^`/`$` anchors, `.*` wildcards, `\` escapes punctuation; case-insensitive unless the pattern has capitals; matched linearly with `indexOf`. The digest is rules, not AI: error/warning/summary regexes, error blocks extended over more-indented lines and stack frames, near-identical lines collapsed by normalising numbers and hex, then the tail; every item has line numbers.
- `/<a>/vs/<b>` is a Myers line diff of the middle after trimming the common prefix and suffix (refused over 500 KB or 5,000 lines a side, checked from metadata before reading; "too different" past 500 edits), served like a `diff` paste.
- Server-side secret scanning only reads the first 256 KB and pre-tests one combined regex. The CLI refuses or `--redact`s before uploading, and `bin run` redacts its output line by line (a private key block is masked through its END line; partial lines are only flushed up to whitespace) and the recorded command.
- The viewer page is a shell: the text goes in `<pre id="text">` (ANSI stripped, so it reads fine without JS and for HTML-fetching agents), the original goes in the JSON data block only when it has ANSI codes, and `view.js` renders rows in the browser. The Worker never renders lines: Workers Free has a 10 ms CPU budget, and a 1 MB log must cost only an R2 read, an escape and a JSON encode.
- Nothing pasted is ever rendered as HTML. Raw text is `text/plain` with `nosniff` and `content-security-policy: sandbox`; pages have `script-src 'self'` and `frame-ancestors 'none'`. All paste text reaching the DOM goes through `esc()` or highlight.js (which escapes).
- Theme: dark by default; the `theme=light` cookie (set by the toggle or `t`) makes the server render `data-theme="light"`, so there's no flash.
- Every response is `cache-control: ... no-transform` (Cloudflare otherwise injects scripts into HTML), `x-robots-tag: noindex`, `referrer-policy: no-referrer`.

## Cost (Workers Free)

- Create: 1 request, 1 R2 put (multi-file: 1 + one per file), 1 rate-limit check if anonymous (2 for multi-file).
- View or slice: 1 request, 1 R2 get (multi-file: 2). Static assets cost no Worker invocation.
- Live: one DO request and one row written per append (the CLI flushes complete lines once a second, ≤ 64 KB each); reads and WebSocket replays come from DO memory; sealing deletes a few segment rows. Free DO limits are account-wide and daily (100k requests, 100k rows written), shared with tack.
- Expired pastes: purged (free deletes) when someone asks for them; a multi-file purge reads its index rather than listing.
