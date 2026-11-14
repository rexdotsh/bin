---
name: bin
description: Share text, logs, code, command output or diffs as a short link with bin (bin.rex.wf), and read bin links efficiently. Use when the user wants to paste or share text or a file, share a command's output or a failing test/build run, send a log or snippet to someone, or gives you a bin.rex.wf link to read.
---

# bin

`bin` pastes text to https://bin.rex.wf and returns a short link. Links work for people (a viewer) and for agents (plain text). Pastes never change once made. Use tack instead for HTML docs.

## Share something

- A file: `bin path/to/file.ts`. Several files: `bin a.ts b.ts` (one link, a tab per file).
- Text you produced: `bin --name notes.md <<'EOF' ... EOF`. The name picks the highlighting.
- A command's result: `bin run -- <command> [args]`. It runs the command with its normal output, streams that output to a live paste, records the command, exit code and duration, and exits with the command's exit code. Use this instead of pasting a log by hand when sharing a test or build run.
- Options: `--title "..."`, `--ttl 1h|1d|7d|30d` (default: never expires), `--json` for a machine-readable receipt.

Reply with the link the command prints.

## Secrets

`bin` refuses to upload text that looks like it contains secrets (API keys, tokens, private keys, `.env` values) and lists what it found. Don't work around this with `--allow-secrets` unless the user explicitly says the content is safe to share. Prefer removing the secret, or `--redact` to mask it. `--password` encrypts the paste (asks for a password, or reads `$BIN_PASSWORD`); only use it if the user wants a password-protected paste, and never put the password in a chat reply unless asked.

`bin run` masks secrets in the output it streams.

## Read a bin link

Bin links return plain text to non-browsers, so any fetch tool or `curl` works. For anything long, look before reading it all:

- `curl -sI <url>` shows `x-bin-lines` and `x-bin-tokens` (a rough token count).
- `bin get <url> --digest` (or `<url>?digest`) summarizes a log: distinct errors with line numbers, repeated warnings, summary lines and the tail.
- Then fetch only what you need: `--lines 120-180`, `--head 50`, `--tail 50`, `--grep <regex> --context 3` (or the same as query parameters: `?lines=`, `?head=`, `?tail=`, `?grep=&context=`).
- A multi-file paste's link lists its files; fetch one with `<url>/<file>`.
- `<url-a>/vs/<id-b>` gives a unified diff of two pastes.
- Encrypted pastes need `bin get <url> --password`; ask the user for the password.

## Other commands

`bin rm <id>` deletes a paste made from this machine. `bin help` lists everything. `bin` needs no setup or token to paste.

If `bin` isn't installed, ask the user to install it (`curl -fsSL https://bin.rex.wf/install | sh`), or use plain curl: `curl --data-binary @file https://bin.rex.wf`.
