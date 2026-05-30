#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "electron binary not found: $ELECTRON_BIN" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "usage: scripts/with-electron-proxy.sh <command> [args...]" >&2
  exit 1
fi

proxy="$(
  env -u ELECTRON_RUN_AS_NODE \
    "$ELECTRON_BIN" \
    "$ROOT_DIR/scripts/resolve-electron-proxy.js" \
    "https://chii.in" | tr -d '\r'
)"

if [[ -z "$proxy" ]]; then
  exec "$@"
fi

if [[ "$proxy" != http://* && "$proxy" != https://* && "$proxy" != socks5://* && "$proxy" != socks://* ]]; then
  proxy="http://$proxy"
fi

export HTTPS_PROXY="$proxy"
export HTTP_PROXY="$proxy"
export ALL_PROXY="$proxy"

exec "$@"
