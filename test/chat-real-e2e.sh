#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
(npx vite build > /dev/null 2>&1)

TEST_USERDATA="$ROOT/tmp-test-real-chat"
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-real-chat 2>&1 | tee /tmp/mana-real-chat.log

E2E_EXIT=${PIPESTATUS[0]}
while IFS= read -r line; do
  case "$line" in
    TEST_PASS*) echo "  ✅ ${line#TEST_PASS }" ;;
    TEST_FAIL*) echo "  ❌ ${line#TEST_FAIL }" ;;
    TEST_SUMMARY*) echo "       ${line#TEST_SUMMARY }" ;;
  esac
done < /tmp/mana-real-chat.log

rm -rf "$TEST_USERDATA"
rm -f /tmp/mana-real-chat.log
exit $E2E_EXIT
