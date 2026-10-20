#!/bin/sh
set -eu
cd "$(dirname "$0")"

GSTACK=0
BROWSER=""
for arg in "$@"; do
  case "$arg" in
    --gstack) GSTACK=1 ;;
    --browser=chrome|--browser=headless) BROWSER="${arg#--browser=}" ;;
    -h|--help)
      echo "Usage: ./install.sh [--gstack] [--browser=chrome|headless]"
      echo "  --gstack    also link apart as ~/.local/bin/aside, the command gstack's browser skills look for"
      echo "  --browser   which browser apart repl uses by default (asked on first install if left out)"
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

CONFIG="${APART_HOME:-$HOME/.apart}/config.json"
if [ -z "$BROWSER" ] && [ ! -f "$CONFIG" ] && [ -t 0 ]; then
  echo
  echo "Which browser should apart use by default?"
  echo "  1. Your Chrome: signed in as you, and you can watch it work (needs the extension)"
  echo "  2. Headless: a hidden Chrome apart starts itself, signed out"
  printf "Choose 1 or 2 [1]: "
  read -r answer || answer=""
  case "$answer" in
    2) BROWSER=headless ;;
    *) BROWSER=chrome ;;
  esac
fi
if [ -n "$BROWSER" ]; then
  echo
  node "$TARGET" config default-browser "$BROWSER"
  echo "Change it any time in the extension's settings or with: apart config default-browser chrome|headless"
fi

if [ -z "$BROWSER" ]; then
  BROWSER=$(node "$TARGET" config default-browser)
fi

echo
if [ "$BROWSER" = headless ]; then
  echo "To also use your own Chrome (repl --chrome), load the extension once:"
else
  echo "Load the extension once:"
fi
echo "  1. In Chrome open chrome://extensions and turn on Developer mode"
echo "  2. Click \"Load unpacked\" and choose: $PWD/dist/extension"
echo
echo "Then check everything with:  $BIN/apart doctor"
