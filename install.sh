#!/bin/sh
set -eu
cd "$(dirname "$0")"

GSTACK=0
for arg in "$@"; do
  case "$arg" in
    --gstack) GSTACK=1 ;;
    -h|--help)
      echo "Usage: ./install.sh [--gstack]"
      echo "  --gstack  also link apart as ~/.local/bin/aside, the command gstack's browser skills look for"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

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
TARGET="$PWD/dist/apart.js"
mkdir -p "$BIN"

link() {
  name="$1"
  dest="$BIN/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    current=$(readlink "$dest" 2>/dev/null || true)
    case "$current" in
      */dist/apart.js) ;;
      *)
        echo "  skipped $dest: a different program already uses that name (${current:-a regular file})"
        return 0
        ;;
    esac
  fi
  ln -sf "$TARGET" "$dest"
  echo "  $dest"
}

echo
echo "Installed:"
link apart
if [ "$GSTACK" = 1 ]; then
  link aside
  echo "  (aside is the same binary, for gstack's browser skills)"
fi

echo
echo "Load the extension once:"
echo "  1. In Chrome open chrome://extensions and turn on Developer mode"
echo "  2. Click \"Load unpacked\" and choose: $PWD/dist/extension"
echo
echo "Then check everything with:  $BIN/apart doctor"
