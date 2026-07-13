#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
TEST_USERDATA="$ROOT/tmp-test-model-center-ui-userdata"
LOG_FILE="/tmp/mana-model-center-ui-e2e.log"

(cd "$ROOT" && npx vite build > /dev/null)
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

cd "$ROOT"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
MANA_USE_STDIO_MCP=0 \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-model-center-ui-regression 2>&1 | tee "$LOG_FILE"

exit "${PIPESTATUS[0]}"
