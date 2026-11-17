# bin

An agent-first pastebin on Cloudflare Workers. Paste text, get a short link. People get a quiet viewer; agents get plain text they can slice.

```sh
bun test 2>&1 | curl --data-binary @- https://bin.rex.wf
curl -T crash.log https://bin.rex.wf
```

- **One link, two audiences.** Browsers see a viewer with line links, highlighting and terminal colours, and markdown formatted (one key away from the source). curl and agents get plain text with the line and token counts in headers.
- **Read only what you need.** `?head=50`, `?tail=50`, `?lines=10-80`, `?grep=error&context=3`, and `?digest` for a log's errors, repeated warnings and tail with line numbers.
- **`bin run -- bun test`** runs a command, then pastes its output with the command, exit code and duration.
- **Multi-file pastes**, diffs (`/a/vs/b`), password pastes encrypted in your browser, Ctrl+V on the home page to paste instantly, keyboard shortcuts, dark and light themes.
- **No accounts.** Anonymous pastes are fine; nothing pasted is ever rendered as HTML (raw HTML in markdown shows as text).

## CLI

```sh
curl -fsSL https://bin.rex.wf/install | sh   # Node 20+; also installs the agent skill

bin file.ts                 # or several files, or: cmd | bin
bin run -- bun test         # paste a command's output + exit code; exits with its code
bin get <id> --digest       # or --grep, --head, --tail, --lines, --raw
bin rm <id>
```

`bin` refuses to upload things that look like secrets unless you pass `--redact`, `--password` or `--allow-secrets`.

## Setup

1. Create an R2 bucket named `bin-apac` (or change `bucket_name` in `wrangler.jsonc`).
2. Workers & Pages → import this repo. Deploy command `bunx wrangler deploy`, build variable `BUN_VERSION=1.4.0`. Put your domain in `wrangler.jsonc` (`routes`), `DEFAULT_URL` in `cli/bin.ts`, `base` in `cli/install.sh`, and the URLs in `public/llms.txt` and the skill.
3. Optional, for bigger pastes and no rate limit: `bin setup` from a checkout sets the owner token (`BIN_TOKEN`) on the Worker.

## Dev

```sh
bun install
printf 'BIN_TOKEN=dev\n' > .dev.vars
bun run dev
echo hello | curl --data-binary @- http://127.0.0.1:8787
```

See `AGENTS.md` for the design.
