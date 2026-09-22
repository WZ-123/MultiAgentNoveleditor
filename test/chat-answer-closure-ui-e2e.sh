#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_USERDATA="$ROOT/tmp-test-chat-answer-closure-ui-userdata"
LOG_FILE="/tmp/mana-chat-answer-closure-ui-e2e.log"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

cd "$ROOT"
npx vite build > /dev/null
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

set +e
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
MANA_USE_STDIO_MCP=0 \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-chat-answer-closure-ui-regression 2>&1 | tee "$LOG_FILE"
E2E_EXIT=${PIPESTATUS[0]}
set -e

while IFS= read -r line; do
  case "$line" in
    TEST_PASS*|TEST_FAIL*|TEST_SUMMARY*|TEST_SCREENSHOT*|TEST_DONE)
      echo "$line"
      ;;
  esac
done < "$LOG_FILE"

rm -rf "$TEST_USERDATA"
exit "$E2E_EXIT"
