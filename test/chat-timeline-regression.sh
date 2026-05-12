#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
TEST_USERDATA="$ROOT/tmp-test-chat-timeline-regression-userdata"
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-chat-timeline-regression 2>&1 | tee /tmp/mana-chat-timeline-regression.log

E2E_EXIT=${PIPESTATUS[0]}
while IFS= read -r line; do
  case "$line" in
    TEST_PASS*) echo "  ✅ ${line#TEST_PASS }" ;;
    TEST_FAIL*) echo "  ❌ ${line#TEST_FAIL }" ;;
    TEST_SUMMARY*) echo "       ${line#TEST_SUMMARY }" ;;
  esac
done < /tmp/mana-chat-timeline-regression.log

rm -rf "$TEST_USERDATA"
rm -f /tmp/mana-chat-timeline-regression.log
exit $E2E_EXIT