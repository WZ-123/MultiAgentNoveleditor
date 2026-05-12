#!/usr/bin/env bash
# Flow E2E test — multi-turn chat + MCP tools + novel data operations
#
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOTAL=0; PASSED=0; FAILED=0

pass() { PASSED=$((PASSED+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAILED=$((FAILED+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1: $2"; }

echo "=========================================="
echo " MANA Flow E2E — Chat + MCP + Novel Data"
echo "=========================================="
echo ""

if [ ! -f "$ROOT/dist/index.html" ]; then
  (cd "$ROOT" && npx vite build > /dev/null 2>&1) && pass "vite build" || { fail "vite build" "failed"; exit 1; }
else
  (cd "$ROOT" && npx vite build > /dev/null 2>&1) && pass "vite build" || { fail "vite build" "failed"; exit 1; }
fi

TEST_USERDATA="$ROOT/tmp-test-flow-root"
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

cd "$ROOT"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-flow 2>&1 | tee /tmp/mana-flow-e2e.log

E2E_EXIT=${PIPESTATUS[0]}

while IFS= read -r line; do
  case "$line" in
    TEST_PASS*) pass "flow: ${line#TEST_PASS }" ;;
    TEST_FAIL*) fail "flow" "${line#TEST_FAIL }" ;;
    TEST_SUMMARY*) echo "       ${line#TEST_SUMMARY }" ;;
    TEST_DONE) echo "       tests complete" ;;
  esac
done < /tmp/mana-flow-e2e.log

rm -rf "$TEST_USERDATA"
rm -f /tmp/mana-flow-e2e.log

echo ""
echo "=========================================="
echo " Results: $PASSED passed, $FAILED failed, $TOTAL total"
echo "=========================================="
[ "$FAILED" -eq 0 ] && [ "$E2E_EXIT" -eq 0 ] && echo " ✅ ALL TESTS PASSED" || echo " ❌ $FAILED TESTS FAILED"
exit $FAILED
