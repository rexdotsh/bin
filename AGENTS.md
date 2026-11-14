# AGENTS.md

bin: an agent-first pastebin at bin.rex.wf. One Cloudflare Worker, one R2 bucket (`bin-apac`, APAC location hint, R2 Local Uploads on), a zero-dependency CLI and a skill. Built like tack (`~/tack`), which serves HTML docs; bin only ever serves text.

## Layout

- `src/worker.ts`: the whole Worker (create, read, slices, digest, compare, delete, page shells). Pages inline `dist/bin.css` (imported as text via the `**/*.css` rule in `wrangler.jsonc`).
- `web/`: browser code, bundled by `bun run build` into static assets: `view.ts` (the paste viewer: rendering, ANSI colours, highlighting, selection, keyboard, unlock), `compose.ts` (the new-paste page), `crypto.ts` (shared PBKDF2 + AES-GCM), `hl.ts` + `hl-worker.ts` (highlight.js, lazy-loaded; auto-detection and big texts run in a module Worker), `ui.ts` (toast, best-effort storage and cookies), `theme.ts`, `bin.css`.
- `src/page.ts` and `src/text.ts` are shared by the Worker and the browser (no DOM or Worker APIs): the viewer shell and asset names, and ANSI/`\r` stripping (`stripAnsi` is the server's; `toLines` gives the same text line by line).
- `cli/bin.ts`: the whole CLI, zero dependencies, Node built-ins only and erasable TypeScript only (runs as-is on Node 22.18+ and Bun; bundled to `dist/cli` for Node 20+).
- `skill/bin/SKILL.md`: the agent skill. `public/llms.txt`: plain-text usage, also what `GET /` returns to non-browsers.
- `scripts/import.ts`: one-off import of the old wastebin export (`bin-export*` is gitignored; never commit it, it holds other people's pastes).
- `scripts/build.ts`: the whole build: CLI bundle, browser bundles with hashed names, highlight.js split per language (the list comes from `EXT_LANG`), Geist subset into core + `unicode-range` ext files with metric-matched fallbacks, minified CSS, `_headers`, and a check that `dist/` holds exactly the expected files.
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so it's the source of truth. `dist/` is served as static assets before the Worker (`/cli`, `/install`, `/skill.md`, `/llms.txt`, `/robots.txt`, `/favicon.ico`, `/favicon.svg`, `/bin.css`, hashed `/fonts/*`, and the browser JS under `/a/`). Static assets never reach the Worker, so `harden()` doesn't apply to them; `_headers` sets their cache headers. Browser JS (`view`, `compose`, highlight.js core, languages and `auto`) gets content-hashed names under `/a/` with immutable caching; `dist/assets.json` (not uploaded, see `.assetsignore`) maps `view.js` to `/a/view.<hash>.js` and is bundled into the Worker and the browser code through `asset()` in `src/page.ts`. A stale hashed name (an old cached page after a deploy) gets a 307 to the current file.

## Commands

```sh
bun install
bun run check     # wrangler types + tsc for worker, cli and web
bun run build     # dist/; fails unless it holds exactly the expected files
printf 'BIN_TOKEN=dev\n' > .dev.vars
bun run dev       # local worker on :8787 (from a generated wrangler.dev.json without routes) with local R2 and rate limiters
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

- A paste is one R2 object `p/<id>` with everything else in `customMetadata` (strings): `at`, `t` (title), `name`, `lang`, `lines`, `bytes`, `tok` (≈ bytes/4), `ansi` (has ESC or another control character besides tab/newline/CR), `cr` (has a bare `\r`, not part of CRLF), `exp` (unix seconds), `del` (sha256 of the delete token), `enc`, `kind` (`multi`), `files`, `cmd`, `exit`, `dur`. A read is one R2 get. Pastes are immutable: no editing, no versions ("edit as new" forks).
- IDs are 6 random characters from `A-Za-z0-9`, written create-only (`if-none-match: *`) so a new paste never overwrites an old one. The router also accepts `+` and `-` in ids, for imported wastebin links in the upstream alphabet; only the owner can choose an id (`?id=`).
- Multi-file: `p/<id>` holds a JSON index (`{ files: [{ name, lang, lines, bytes, tokens }] }`), each file is `p/<id>/<name>`. File names are canonical relative paths (no `.`/`..`/empty segments, no backslashes, and the first segment isn't `vs`, which `/<a>/vs/<b>` uses).
- Expiry is checked on read; an expired paste reads as 404 and is purged lazily. No cron, no lifecycle rules. Anonymous pastes never expire unless `ttl` is set.
- No live pastes: there's no Durable Object (the `v2` migration deleted the old `Live` class). `bin run` collects the command's output (redacted line by line, keeping the last 2 MB, or 5 MB with the owner token) and creates one paste when it exits, with `cmd`, `exit` and `dur` as query parameters.
- Delete: `DELETE /<id>` with `x-delete: <token>` (returned once to anonymous creators; the CLI keeps one file per paste in `~/.config/bin/deletes/`, the browser keeps it in localStorage) or the owner token. Compare secrets with `same()`.
- Owner: `Authorization: Bearer <BIN_TOKEN>` lifts the size limit (2 MB → 5 MB), the file cap (10 → 50) and the rate limits, and allows `?id=` and `?expires=`. Anonymous creates go through two rate-limit bindings: `ANON` (about 20 a minute per IP, IPv6 keyed by /64, per location; multi-file creates are weighted by file count) and `ANON_BYTES`, a shared budget for all anonymous pastes charged `max(R2 writes, 64 KB units)` per create (40 a minute per location, about 2.5 MB), which bounds storage growth and Class A ops since R2 has no free-tier hard stop. Request bodies are read with a byte cap (`readBounded`), never buffered whole first.
- Encrypted pastes are encrypted client-side (browser or CLI): `{ v: 1, kdf: "pbkdf2-sha256", iter, salt, iv, ct }`, AES-256-GCM with the tag appended to `ct` (WebCrypto's layout). The server stores the envelope and can't read it; slices and digests refuse them.

## Serving

- `HEAD` on a paste is one R2 `head` (agent headers, no body).
- One URL, two audiences: `wantsHtml()` sends the viewer to browsers (`Sec-Fetch-Dest: document`) and chat unfurlers (by user agent), and plain text to everything else. Agents get the text with ANSI escapes and `\r` overwrites resolved; `/raw/<id>` and `/dl/<id>` are always the exact bytes. `/<id>.<ext>` is the same paste; the extension is cosmetic.
- Agent responses carry `x-bin-lines`, `x-bin-bytes`, `x-bin-tokens`, `x-bin-lang`, `x-bin-title`, `x-bin-name`, `x-bin-command`, `x-bin-exit`, `x-bin-duration-ms`, `x-bin-expires`, and `x-bin-hint` above ~10k tokens.
- Agent reads of plain pastes (no ANSI, no `\r`, not encrypted, no slice) stream the R2 body untouched: no decode, no CPU. Everything else is decoded and cleaned with `stripAnsi` (one regex pass, then `\r` overwrites and stray control characters).
- Slices (`lines`, `head`, `tail`, `grep` + `context`, `n=1`) and `digest` are plain text even for browsers. `grep` output matches `grep -n -C`. `grep` is not a regex (user regexes can blow the CPU budget): text, `|` for alternatives, `^`/`$` anchors, `.*` wildcards, `\` escapes punctuation; case-insensitive unless the pattern has capitals; matched linearly with `indexOf`. The digest is rules, not AI: error/warning/summary regexes, error blocks extended over more-indented lines and stack frames, near-identical lines collapsed by normalising numbers and hex, then the tail; every item has line numbers.
- `/<a>/vs/<b>` is a Myers line diff of the middle after trimming the common prefix and suffix (refused over 500 KB or 5,000 lines a side, checked from metadata before reading; "too different" past 500 edits), served like a `diff` paste.
- Server-side secret scanning only reads the first 256 KB and pre-tests one combined regex. The CLI refuses or `--redact`s before uploading, and `bin run` redacts its output line by line (a private key block is masked through its END line) and the recorded command.
- The viewer page is a shell: the text goes in `<pre id="text">` (ANSI stripped, so it reads fine without JS and for HTML-fetching agents), the original goes in `<template id="ansi">` (with `\r` as `&#13;`) only when it has ANSI codes, pastes over `INLINE_MAX` (512 KB) aren't inlined (the page fetches `/raw`, or `/<a>/vs/<b>` for big diffs), and `view.js` renders rows in the browser, 256-line blocks at a time: blocks far from the viewport hold their plain text (same height, wrapped or not) and get rows when they come within 1500 px. The Worker never renders lines: Workers Free has a 10 ms CPU budget, and a 1 MB log must cost only an R2 read, an escape and a JSON encode.
- Nothing pasted is ever rendered as HTML. Raw text is `text/plain` with `nosniff` and `content-security-policy: sandbox`; pages have `script-src 'self'`, `style-src 'unsafe-inline'` (inline CSS), `'inline-speculation-rules'` (multi-file tab prefetch) and `frame-ancestors 'none'`. All paste text reaching the DOM goes through `esc()` or highlight.js (which escapes).
- Theme: dark by default; the `theme=light` cookie (set by the toggle or `t`) makes the server render `data-theme="light"`, so there's no flash. The `wrap=1` cookie works the same way for line wrapping.
- Successful paste reads (view, raw, dl, slices) are `private, max-age` ≤ 300 (and never past expiry), so back/forward and refetches are free; a delete is seen by new visitors at once and by earlier ones within 5 minutes. Everything else is `private, no-cache`.
- Every response is `cache-control: ... no-transform` (Cloudflare otherwise injects scripts into HTML), `x-robots-tag: noindex`, `referrer-policy: no-referrer`.

## Cost (Workers Free)

- Create: 1 request, 1 R2 put (multi-file: 1 + one per file), 2 rate-limit checks if anonymous (3 for multi-file). Free limits are per account and daily (100k Worker requests), shared with tack and the other Workers.
- View or slice: 1 request, 1 R2 get (multi-file: 2; pastes over 512 KB: a second request for `/raw`). Static assets cost no Worker invocation.
- Expired pastes: purged (free deletes) when someone asks for them; a multi-file purge reads its index rather than listing.
