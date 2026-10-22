#!/bin/sh
set -eu
cd "$(dirname "$0")"

GSTACK=0
BROWSER=""
for arg in "$@"; do
  case "$arg" in
    --gstack) GSTACK=1 ;;
    --browser=*) BROWSER="${arg#--browser=}" ;;
    -h|--help)
      echo "Usage: ./install.sh [--gstack] [--browser=chrome|headless]"
      echo "  --gstack    also link apart as ~/.local/bin/aside, the command gstack's browser skills look for"
      echo "  --browser   which browser apart repl uses by default: chrome, arc, brave, edge or headless"
      echo "              (asked on first install if left out)"
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
  NAMES=""
  LABELS=""
  add_choice() {
    NAMES="$NAMES $1"
    LABELS="$LABELS|$2"
  }
  if [ "$(uname)" = Darwin ]; then
    [ -d "/Applications/Google Chrome.app" ] && add_choice chrome "Chrome"
    [ -d "/Applications/Arc.app" ] && add_choice arc "Arc"
    [ -d "/Applications/Brave Browser.app" ] && add_choice brave "Brave"
    [ -d "/Applications/Microsoft Edge.app" ] && add_choice edge "Edge"
    [ -d "/Applications/Chromium.app" ] && add_choice chromium "Chromium"
  fi
  [ -z "$NAMES" ] && add_choice chrome "Chrome"
  add_choice headless "Headless"
  echo
  echo "Which browser should apart use by default?"
  i=1
  for name in $NAMES; do
    label=$(printf '%s' "$LABELS" | cut -d'|' -f$((i + 1)))
    if [ "$name" = headless ]; then
      echo "  $i. $label: a hidden Chrome apart starts itself, signed out"
    else
      echo "  $i. $label: signed in as you, and you can watch it work (needs the extension)"
    fi
    i=$((i + 1))
  done
  printf "Choose a number [1]: "
  read -r answer || answer=""
  case "$answer" in
    ''|*[!0-9]*) answer=1 ;;
  esac
  BROWSER=$(printf '%s\n' $NAMES | sed -n "${answer}p")
  [ -z "$BROWSER" ] && BROWSER=$(printf '%s\n' $NAMES | sed -n 1p)
fi
if [ -n "$BROWSER" ]; then
  echo
  node "$TARGET" config default-browser "$BROWSER"
  echo "Change it any time in the extension's settings or with: apart config default-browser <name>"
fi

if [ -z "$BROWSER" ]; then
  BROWSER=$(node "$TARGET" config default-browser)
fi

echo
if [ "$BROWSER" = headless ]; then
  echo "To also use your own browsers (repl --browser <name>), load the extension once in each:"
else
  echo "Load the extension once in each browser you want apart to use (Chrome, Arc, Brave, Edge):"
fi
echo "  1. Open chrome://extensions (in Arc: arc://extensions) and turn on Developer mode"
echo "  2. Click \"Load unpacked\" and choose: $PWD/dist/extension"
echo
echo "Then check everything with:  $BIN/apart doctor"
echo
echo "To let a coding agent use apart, add this line to your CLAUDE.md or AGENTS.md:"
echo "  To read or act on a web page, use apart. Run \`apart guide\` first and follow it."
