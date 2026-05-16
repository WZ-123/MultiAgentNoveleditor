#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
TEST_USERDATA="$ROOT/tmp-test-chat-scroll-ui"
LOG_FILE="/tmp/mana-chat-scroll-ui-e2e.log"

echo "[build] rebuilding dist..."
(cd "$ROOT" && npx vite build > /dev/null)

rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

echo "[launch] electron . --test-chat-scroll-ui-regression"
cd "$ROOT"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-chat-scroll-ui-regression 2>&1 | tee "$LOG_FILE"

run_exit=${PIPESTATUS[0]}
rm -rf "$TEST_USERDATA"
exit "$run_exit"