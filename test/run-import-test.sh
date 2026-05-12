#!/usr/bin/env bash
set -e

# Import + Analysis automated test.
# Checks:
#   1. File parsing works
#   2. Staging project creation works
#   3. Analyzer code has tasks for characters, factions, timeline, world, outline, style
#   4. finalizeAnalyses handles all expected output directories
#
# The AI analysis step requires the Electron app (provider config).
# To test analysis end-to-end, import through the app UI.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_NOVEL="$ROOT/test/碧蓝牧场 id 13913286@sosdbot.txt"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "=== 1. Novel file exists ==="
[ -f "$TEST_NOVEL" ] && pass "Test file found" || fail "Missing: $TEST_NOVEL"

echo ""
echo "=== 2. Parser produces chapters ==="
CHAPTER_COUNT=$(node -e "
const p = require('$ROOT/src/main/import/fileParser');
p.parseNovelFile('$TEST_NOVEL').then(r => {
  console.log(r.chapters.length);
  if (r.chapters.length > 0) {
    r.chapters.forEach((c,i) => console.log('CH:' + (i+1) + '|' + c.title.substring(0,60) + '|' + c.content.length));
  }
}).catch(e => { console.error(e.message); process.exit(1); });
")
CH_NUM=$(echo "$CHAPTER_COUNT" | head -1)
echo "  Chapters: $CH_NUM"
echo "$CHAPTER_COUNT" | tail -n +2 | while IFS='|' read -r num title len; do
  echo "    $num. $title ($len chars)"
done
[ "$CH_NUM" -ge 1 ] && pass "Parser produced $CH_NUM chapters" || fail "Parser returned 0 chapters"

echo ""
echo "=== 3. Analyzer has required task definitions ==="
TASKS=$(node -e "
const fs = require('fs');
const src = fs.readFileSync('$ROOT/src/main/import/analyzer.js', 'utf8');
// Extract TASK_DEFS
const m = src.match(/TASK_DEFS\s*=\s*\[([\s\S]*?)\];/);
if (!m) { console.error('TASK_DEFS not found'); process.exit(1); }
const ids = m[1].match(/id:\s*'([^']+)'/g).map(s => s.replace(/id:\s*'([^']+)'/, '\$1'));
console.log(ids.join('\n'));
")

for task in characters factions timeline world outline style; do
  echo "$TASKS" | grep -q "$task" && pass "Task '$task' defined" || fail "Missing task: $task"
done

echo ""
echo "=== 4. finalizeAnalyses handles all output directories ==="
DIRS=$(node -e "
const fs = require('fs');
const src = fs.readFileSync('$ROOT/src/main/import/analyzer.js', 'utf8');
// Extract outputDir references
const dirs = src.match(/outputDir:\s*'([^']+)'/g).map(s => s.match(/outputDir:\s*'([^']+)'/)[1]);
console.log([...new Set(dirs)].join('\n'));
")

for dir in characters factions timeline world outlines style; do
  echo "$DIRS" | grep -q "$dir" && pass "Output dir '$dir' handled in finalizeAnalyses" || fail "Missing output dir handler: $dir"
done

echo ""
echo "=== 5. Style prompt has protection notice ==="
STYLE_PROTECTED=$(node -e "
const fs = require('fs');
const src = fs.readFileSync('$ROOT/src/main/import/analyzer.js', 'utf8');
// Check for the STYLE protection comment before the style prompt
const hasNote = src.includes('STYLE') && src.includes('二次确认');
console.log(hasNote ? 'yes' : 'no');
")
[ "$STYLE_PROTECTED" = "yes" ] && pass "Style prompt protected" || fail "Style prompt missing protection notice"

echo ""
echo "=== 6. Syntax check ==="
node --check "$ROOT/src/main/import/analyzer.js" 2>/dev/null && pass "analyzer.js syntax OK" || fail "analyzer.js syntax error"
node --check "$ROOT/src/main/import/fileParser.js" 2>/dev/null && pass "fileParser.js syntax OK" || fail "fileParser.js syntax error"

echo ""
echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[ "$FAIL" -eq 0 ] && echo "  ✅ ALL CHECKS PASSED" || echo "  ❌ $FAIL check(s) failed"
exit $FAIL
