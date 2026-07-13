#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Electron aborts when launched inside the Codex macOS sandbox and each abort
# opens a system crash dialog. Keep the real GUI E2E available for normal local
# runs, but require an explicit opt-in when a sandbox is detected. Codex should
# use test/fixtures/character-card-ui-harness.html for sandboxed UI verification.
if [[ -n "${CODEX_SANDBOX:-}" && "${MANA_ALLOW_SANDBOX_GUI_E2E:-0}" != "1" ]]; then
  echo "TEST_SKIP character-card-ui: Electron GUI E2E is blocked inside CODEX_SANDBOX to avoid macOS crash dialogs." >&2
  echo "TEST_SKIP use the browser harness, or set MANA_ALLOW_SANDBOX_GUI_E2E=1 only when GUI launch is explicitly approved." >&2
  exit 78
fi

cd "$ROOT"
(npx vite build > /dev/null 2>&1)

TEST_USERDATA="$ROOT/tmp-test-character-card-userdata"
rm -rf "$TEST_USERDATA"
mkdir -p "$TEST_USERDATA"

ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE_ENV=production \
MANA_USER_DATA_ROOT="$TEST_USERDATA" \
ELECTRON_DISABLE_CRASH_REPORTER=1 \
  env -u ELECTRON_RUN_AS_NODE \
  "$ELECTRON_BIN" . --disable-breakpad --no-sandbox --test-character-card-ui 2>&1 | tee /tmp/mana-character-card-ui.log

E2E_EXIT=${PIPESTATUS[0]}
while IFS= read -r line; do
  case "$line" in
    TEST_PASS*) echo "  ✅ ${line#TEST_PASS }" ;;
    TEST_FAIL*) echo "  ❌ ${line#TEST_FAIL }" ;;
    TEST_SUMMARY*) echo "       ${line#TEST_SUMMARY }" ;;
  esac
done < /tmp/mana-character-card-ui.log

rm -rf "$TEST_USERDATA"
rm -f /tmp/mana-character-card-ui.log
exit $E2E_EXIT
