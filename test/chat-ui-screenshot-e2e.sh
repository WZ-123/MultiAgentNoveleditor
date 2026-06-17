#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
TEST_USERDATA="$ROOT/tmp-test-chat-ui-screenshot-userdata"
LOG_FILE="/tmp/mana-chat-ui-screenshot-e2e.log"

echo "[build] rebuilding dist..."
(cd "$ROOT" && npx vite build > /dev/null)

rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

echo "[launch] electron . --test-chat-ui-screenshot-regression"
cd "$ROOT"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
MANA_USE_STDIO_MCP=0 \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-chat-ui-screenshot-regression 2>&1 | tee "$LOG_FILE"

run_exit=${PIPESTATUS[0]}
while IFS= read -r line; do
  case "$line" in
    TEST_PASS*|TEST_FAIL*|TEST_SUMMARY*|TEST_SCREENSHOT*|TEST_DONE)
      echo "$line"
      ;;
  esac
done < "$LOG_FILE"

exit "$run_exit"
