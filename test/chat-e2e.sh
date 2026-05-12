#!/usr/bin/env bash
# Chat E2E test — AI chat event flow verification
#
# Launches the full Electron app with --test-chat flag, which triggers
# main.js to inject synthetic chat events and verify event handling.
#
# Usage:  bash test/chat-e2e.sh
# Exits:  0 on all pass, 1 on any failure
#
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOTAL=0; PASSED=0; FAILED=0

pass() { PASSED=$((PASSED+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAILED=$((FAILED+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1: $2"; }

echo "=========================================="
echo " MANA Chat E2E — AI Chat Event Flow"
echo "=========================================="
echo ""

# -- 1. Ensure dist is built --
if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "[build] building dist..."
  (cd "$ROOT" && npx vite build > /dev/null 2>&1) && pass "vite build" || { fail "vite build" "failed"; exit 1; }
else
  echo "[build] rebuilding..."
  (cd "$ROOT" && npx vite build > /dev/null 2>&1) && pass "vite build" || { fail "vite build" "failed"; exit 1; }
fi

# -- 2. Launch Electron with test mode --
TEST_USERDATA="$ROOT/tmp-test-chat"
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

echo ""
echo "[launch] electron . --test-chat (production mode)"

cd "$ROOT"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --no-sandbox --test-chat 2>&1 | tee /tmp/mana-chat-e2e.log

E2E_EXIT=${PIPESTATUS[0]}
echo ""
echo "[exit] code $E2E_EXIT"

# -- 3. Parse test results --
while IFS= read -r line; do
  case "$line" in
    TEST_PASS*) pass "chat: ${line#TEST_PASS }" ;;
    TEST_FAIL*) fail "chat" "${line#TEST_FAIL }" ;;
    TEST_SUMMARY*) echo "       ${line#TEST_SUMMARY }" ;;
    TEST_DONE) echo "       tests complete" ;;
  esac
done < /tmp/mana-chat-e2e.log

# -- 4. Cleanup --
rm -rf "$TEST_USERDATA"
rm -f /tmp/mana-chat-e2e.log

echo ""
echo "=========================================="
echo " Results: $PASSED passed, $FAILED failed, $TOTAL total"
echo "=========================================="
[ "$FAILED" -eq 0 ] && [ "$E2E_EXIT" -eq 0 ] && echo " ✅ ALL TESTS PASSED" || echo " ❌ $FAILED TESTS FAILED"
exit $FAILED
