#!/bin/sh
set -eu
cd "$(dirname "$0")"

case "${1:-}" in
  -h|--help)
    echo "Usage: ./install.sh [--gstack] [--browser=<name>]"
    echo "Builds apart from this checkout and links it as ~/.local/bin/apart, for working on apart itself."
    echo "To just use apart: npm install -g apart-browser && apart setup"
    exit 0
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "apart needs Node.js 22 or newer: https://nodejs.org" >&2
  exit 1
fi
if ! command -v yarn >/dev/null 2>&1; then
  echo "apart uses yarn: corepack enable  (or: npm install -g yarn)" >&2
  exit 1
fi

yarn install
yarn build

BIN="$HOME/.local/bin"
DEST="$BIN/apart"
mkdir -p "$BIN"
current=$(readlink "$DEST" 2>/dev/null || true)
if { [ -e "$DEST" ] || [ -L "$DEST" ]; } && case "$current" in */dist/apart.js) false ;; *) true ;; esac; then
  echo "skipped $DEST: a different program already uses that name (${current:-a regular file})"
else
  ln -sf "$PWD/dist/apart.js" "$DEST"
  echo "linked $DEST"
fi

node dist/apart.js setup "$@"
