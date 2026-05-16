#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
TEST_USERDATA="$ROOT/tmp-test-chat-feedback-ui-userdata"
LOG_FILE="/tmp/mana-chat-feedback-ui-e2e.log"

rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

cd "$ROOT"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
MANA_USE_STDIO_MCP=0 \
env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-chat-feedback-ui-regression 2>&1 | tee "$LOG_FILE"

status=${PIPESTATUS[0]}
while IFS= read -r line; do
  case "$line" in
    TEST_PASS*|TEST_FAIL*|TEST_SUMMARY*|TEST_DONE)
      echo "$line"
      ;;
  esac
done < "$LOG_FILE"

rm -f "$LOG_FILE"
exit "$status"