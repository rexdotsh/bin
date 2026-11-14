#!/bin/sh
set -eu

base="${BIN_URL:-https://bin.rex.wf}"
case "$base" in
  https://*) fetch() { curl -fsSL --proto =https --proto-redir =https "$@"; } ;;
  *) fetch() { curl -fsSL "$@"; } ;;
esac
lib="${XDG_DATA_HOME:-$HOME/.local/share}/bin"
bin="$HOME/.local/bin"
skill="$HOME/.agents/skills/bin"

physical() {
  dir="$1"
  rest=""
  while [ ! -d "$dir" ]; do
    rest="/$(basename "$dir")$rest"
    dir=$(dirname "$dir")
  done
  echo "$(cd "$dir" && pwd -P)$rest"
}

in_checkout() {
  home=$(physical "$HOME")
  dir=$(physical "$1")
  while [ "$dir" != "$home" ] && [ "$dir" != "/" ] && [ -n "$dir" ]; do
    [ -e "$dir/.git" ] && return 0
    dir=$(dirname "$dir")
  done
  return 1
}

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null || {
  echo "bin needs Node 20+ (https://nodejs.org)" >&2
  exit 1
}

mkdir -p "$lib" "$bin"
fetch "$base/cli" -o "$lib/bin.mjs.$$"
chmod 755 "$lib/bin.mjs.$$"
mv "$lib/bin.mjs.$$" "$lib/bin.mjs"
ln -sf "$lib/bin.mjs" "$bin/bin"
echo "installed $bin/bin"

if [ -L "$skill" ] || [ -L "$skill/SKILL.md" ] || in_checkout "$skill"; then
  echo "left $skill alone (it's a symlink or inside a git checkout)"
else
  mkdir -p "$skill"
  fetch "$base/skill.md" -o "$skill/SKILL.md.$$"
  mv "$skill/SKILL.md.$$" "$skill/SKILL.md"
  echo "installed $skill/SKILL.md"
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "add $bin to your PATH" ;;
esac
echo "ready: try  echo hello | bin"
