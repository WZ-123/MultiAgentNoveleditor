#!/usr/bin/env bash
# UI E2E acceptance suite
#
# Launches the full Electron app in multiple UI test modes and parses
# the TEST_PASS / TEST_FAIL markers from each run.
#
# Usage:  bash test/ui-e2e.sh
# Exits:  0 on all pass, 1 on any failure
#
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOTAL=0; PASSED=0; FAILED=0

pass() { PASSED=$((PASSED+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAILED=$((FAILED+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1: $2"; }

run_ui_case() {
  local flag="$1"
  local label="$2"
  local log_file="$3"

  echo ""
  echo "[launch] electron . $flag ($label)"

  NODE_ENV=production \
  MANA_USER_DATA_ROOT="$TEST_USERDATA" \
    env -u ELECTRON_RUN_AS_NODE \
    "$ELECTRON_BIN" . --no-sandbox "$flag" 2>&1 | tee "$log_file"

  local run_exit=${PIPESTATUS[0]}
  echo ""
  echo "[exit] $label code $run_exit"

  while IFS= read -r line; do
    case "$line" in
      TEST_PASS*) pass "$label: ${line#TEST_PASS }" ;;
      TEST_FAIL*) fail "$label" "${line#TEST_FAIL }" ;;
      TEST_SUMMARY*) echo "       ${line#TEST_SUMMARY }" ;;
      TEST_DONE) echo "       tests complete" ;;
    esac
  done < "$log_file"

  if [ "$run_exit" -ne 0 ]; then
    fail "$label" "runner exited with $run_exit"
  fi

  rm -f "$log_file"
}

echo "=========================================="
echo " MANA UI E2E Acceptance Suite"
echo "=========================================="
echo ""

# -- 1. Ensure dist is built --
if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "[build] building dist..."
  (cd "$ROOT" && npx vite build > /dev/null 2>&1) && pass "vite build" || { fail "vite build" "failed"; exit 1; }
else
  # Rebuild to ensure latest code is tested
  echo "[build] rebuilding..."
  (cd "$ROOT" && npx vite build > /dev/null 2>&1) && pass "vite build" || { fail "vite build" "failed"; exit 1; }
fi

# -- 2. Launch Electron with test mode --
TEST_USERDATA="$ROOT/tmp-test-ui"
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

echo ""
cd "$ROOT"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
run_ui_case "--test-ui" "ui" "/tmp/mana-ui-e2e.log"
run_ui_case "--test-datatab-edit-ui" "datatab-ui" "/tmp/mana-datatab-ui-e2e.log"
run_ui_case "--test-chat-timeline-regression" "chat-timeline" "/tmp/mana-chat-timeline-regression.log"
run_ui_case "--test-chat-replace-regression" "chat-replace" "/tmp/mana-chat-replace-regression.log"
run_ui_case "--test-chat-outline-ui-regression" "chat-outline" "/tmp/mana-chat-outline-ui-e2e.log"
run_ui_case "--test-chat-feedback-ui-regression" "chat-feedback" "/tmp/mana-chat-feedback-ui-e2e.log"

# -- 4. Cleanup --
rm -rf "$TEST_USERDATA"

echo ""
echo "=========================================="
echo " Results: $PASSED passed, $FAILED failed, $TOTAL total"
echo "=========================================="
[ "$FAILED" -eq 0 ] && echo " ✅ ALL TESTS PASSED" || echo " ❌ $FAILED TESTS FAILED"
exit $FAILED
