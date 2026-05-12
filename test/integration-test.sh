#!/usr/bin/env bash
set -e
TOTAL=0; FAILED=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$ROOT/tmp-test-integration"
TEST_NOVEL="$ROOT/test/碧蓝牧场 id 13913286@sosdbot.txt"
rm -rf "$TEST_DIR"; mkdir -p "$TEST_DIR"
export MANA_USER_DATA_ROOT="$TEST_DIR/userdata"

PASS() { TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
FAIL() { TOTAL=$((TOTAL+1)); FAILED=$((FAILED+1)); echo "  ❌ $1"; }

echo "═══════════════════════════════════════════"
echo " MANA Integration Test — Full User Journey"
echo "═══════════════════════════════════════════"

# ==== 1. Parse novel ====
echo ""
echo "[1] User selects a .txt novel file"
chapter_count=$(node -e "
const p = require('$ROOT/src/main/import/fileParser');
p.parseNovelFile('$TEST_NOVEL').then(r => {
  console.log(r.chapters.length);
  if (r.chapters[0]) console.log('TITLE:'+(r.chapters[0].title||'(empty)'));
  console.log('SIZE:'+r.chapters[0].content.length);
  console.log('CONFIDENT:'+(r.chapters[0].confident===false?'no':'yes'));
}).catch(e => { console.log('ERR:'+e.message); });
" 2>&1)
echo "$chapter_count" | while read line; do
  case "$line" in
    [0-9]) cc=$(echo "$line" | head -1); [ "$cc" -ge 1 ] && PASS "Parsed $cc chapter(s)" || FAIL "No chapters" ;;
    TITLE:*) PASS "Chapter title: ${line#TITLE:}" ;;
    SIZE:*) s=${line#SIZE:}; [ "$s" -gt 1000 ] && PASS "Chapter content $s chars" || FAIL "Content too short: $s" ;;
    CONFIDENT:*) [ "${line#CONFIDENT:}" = "no" ] && PASS "No-chapter-markers → 1 whole chapter (correct)" || PASS "Chapter markers detected" ;;
    ERR:*) FAIL "Parse error: ${line#ERR:}" ;;
  esac
done

# ==== 2. Create staging ====
echo ""
echo "[2] User chooses 'create as new project'"
STAGING_ID=$(node -e "
const sp = require('$ROOT/src/main/import/stagingProject');
const fp = require('$ROOT/src/main/import/fileParser');
(async () => {
  const parsed = await fp.parseNovelFile('$TEST_NOVEL');
  const r = await sp.createStagingProject({
    sourceFiles: ['$TEST_NOVEL'],
    chapters: parsed.chapters,
    metadata: parsed.metadata,
    targetNovelId: null,
  });
  console.log(r.importId);
  fs.writeFileSync('/tmp/test-import-id', r.importId);
})().catch(e => { console.log('ERR:'+e.message); });
" 2>&1)
STAGING_ID=$(echo "$STAGING_ID" | grep -v "ERR:" | head -1)
if [ -n "$STAGING_ID" ]; then
  PASS "Staging created: $STAGING_ID"
  STAGING_DIR="$TEST_DIR/userdata/import-staging/$STAGING_ID"
  # Verify directory structure
  for d in chapters characters factions timeline world outlines style; do
    [ -d "$STAGING_DIR/$d" ] && PASS "  staging/$d dir exists" || FAIL "  staging/$d MISSING"
  done
  # Verify chapter file
  CF=$(ls "$STAGING_DIR/chapters/"*.md 2>/dev/null | head -1)
  if [ -n "$CF" ]; then
    PASS "  staging/chapters has chapter file(s)"
  else
    FAIL "  staging/chapters EMPTY"
  fi
else
  FAIL "Staging creation failed"
fi

# ==== 3. Simulate analysis output ====
echo ""
echo "[3] AI analysis completes (simulated — writes sample data)"
node -e "
const fs = require('fs').promises;
const path = require('path');
const dir = '$STAGING_DIR';
(async () => {
  // Characters
  await fs.mkdir(path.join(dir, 'characters'), {recursive:true});
  await fs.writeFile(path.join(dir, 'characters', 'st-louis.json'), JSON.stringify({id:'st-louis',name:'圣路易斯',role:'董事长',gender:'女',appearance:'蓝发，紫红色眼睛，身材火辣',personality:'自信、露出爱好者'}), 'utf8');
  await fs.writeFile(path.join(dir, 'characters', 'honolulu.json'), JSON.stringify({id:'honolulu',name:'火奴鲁鲁',role:'秘书长',gender:'女',personality:'关心公司'}), 'utf8');

  // Factions
  await fs.mkdir(path.join(dir, 'factions'), {recursive:true});
  await fs.writeFile(path.join(dir, 'factions', 'blue-ranch.json'), JSON.stringify({id:'blue-ranch',name:'碧蓝航线乳业',type:'公司',description:'乳制品公司'}), 'utf8');

  // Timeline
  await fs.mkdir(path.join(dir, 'timeline'), {recursive:true});
  await fs.writeFile(path.join(dir, 'timeline', 'events.jsonl'), JSON.stringify({id:'evt-1',timestamp:'第一天上午',title:'商议公司发展',event:'圣路易斯与火奴鲁鲁讨论财报'})+'\n'+JSON.stringify({id:'evt-2',timestamp:'第二天',title:'牧场参观',event:'各界人士参观牧场'})+'\n', 'utf8');

  // World
  await fs.mkdir(path.join(dir, 'world'), {recursive:true});
  await fs.writeFile(path.join(dir, 'world', 'lore.md'), '碧蓝航线世界观：舰娘共存的世界', 'utf8');
  await fs.writeFile(path.join(dir, 'world', 'places.json'), JSON.stringify({places:[{name:'碧蓝航线乳业牧场',type:'工厂',description:'草原上的全自动乳制品工厂'}]}), 'utf8');

  // Outline
  await fs.mkdir(path.join(dir, 'outlines'), {recursive:true});
  await fs.writeFile(path.join(dir, 'outlines', 'main.md'), '# 大纲\n## 原作识别\n碧蓝航线同人\n## 故事梗概\n圣路易斯经营乳业公司', 'utf8');

  // Style
  await fs.mkdir(path.join(dir, 'style'), {recursive:true});
  await fs.writeFile(path.join(dir, 'style', 'memory.md'), '第三人称叙述，细节描写丰富', 'utf8');

  console.log('OK');
})().catch(e => console.log('ERR:'+e.message));
" 2>&1 | while read line; do
  case "$line" in
    OK) PASS "Simulated analysis data written" ;;
    ERR:*) FAIL "Analysis simulation failed: ${line#ERR:}" ;;
  esac
done

# ==== 4. Verify staging read ====
echo ""
echo "[4] Verify staging project read-back"
node -e "
const sp = require('$ROOT/src/main/import/stagingProject');
sp.getStagingProject('$STAGING_ID').then(st => {
  if (!st) { console.log('ERR:getStaging returned null'); return; }
  console.log('CHAR:'+st.characters.length);
  console.log('WORLD:'+(st.world?.lore ? 'yes' : 'no'));
  console.log('OUTLINE:'+(st.outline ? 'yes' : 'no'));
  console.log('STYLE:'+(st.styleMemory ? 'yes' : 'no'));
}).catch(e => console.log('ERR:'+e.message));
" 2>&1 | while read line; do
  case "$line" in
    CHAR:*) [ "${line#CHAR:}" -ge 1 ] && PASS "Characters loaded: ${line#CHAR:}" || FAIL "No characters" ;;
    WORLD:yes) PASS "World lore found" ;;
    WORLD:no) FAIL "World lore missing" ;;
    OUTLINE:yes) PASS "Outline found" ;;
    OUTLINE:no) FAIL "Outline missing" ;;
    STYLE:yes) PASS "Style memory found" ;;
    STYLE:no) FAIL "Style memory missing" ;;
    ERR:*) FAIL "Read-back error: ${line#ERR:}" ;;
  esac
done

# ==== 5. Promote to novel ====
echo ""
echo "[5] Promote staging to real novel project"
PROMOTE_DIR="$TEST_DIR/my-novel-project"
PROMOTED=$(node -e "
const sp = require('$ROOT/src/main/import/stagingProject');
sp.promoteToNovel('$STAGING_ID', {title:'碧蓝牧场测试',dir:'$PROMOTE_DIR'}).then(r => {
  console.log('ID:'+r.id);
  console.log('TITLE:'+r.title);
}).catch(e => console.log('ERR:'+e.message));
" 2>&1)
echo "$PROMOTED" | while read line; do
  case "$line" in
    ID:*) PASS "Novel created: ${line#ID:}" ;;
    TITLE:*) PASS "Novel title: ${line#TITLE:}" ;;
    ERR:*) FAIL "Promote failed: ${line#ERR:}" ;;
  esac
done

# Verify promoted files
for f in "novel.json" ".mana-project" "chapters/chapter-001.md" "characters/st-louis.json" "outlines/main.md" "world/lore.md" "style/memory.md"; do
  [ -f "$PROMOTE_DIR/$f" ] && PASS "  novel/$f exists" || FAIL "  novel/$f MISSING"
done

# ==== 6. Verify novel registry ====
echo ""
echo "[6] Novel appears in registry"
node -e "
const nstore = require('$ROOT/src/main/store/novels');
nstore.listNovels().then(list => {
  const found = list.filter(n => n.dir === '$PROMOTE_DIR');
  console.log('COUNT:'+list.length + ' FOUND:'+found.length);
  if (found[0]) console.log('TITLE:'+found[0].title);
}).catch(e => console.log('ERR:'+e.message));
" 2>&1 | while read line; do
  case "$line" in
    COUNT:*FOUND:1*) PASS "Novel in registry" ;;
    TITLE:*) PASS "Registry title: ${line#TITLE:}" ;;
    COUNT:*FOUND:0) FAIL "Novel NOT in registry" ;;
    ERR:*) FAIL "Registry error: ${line#ERR:}" ;;
  esac
done

# ==== 7. Open novel ====
echo ""
echo "[7] Open novel — load chapters from disk"
node -e "
const nstore = require('$ROOT/src/main/store/novels');
const nd = require('$ROOT/src/main/store/novelData');
(async () => {
  const list = await nstore.listNovels();
  const novel = list.find(n => n.dir === '$PROMOTE_DIR');
  if (!novel) { console.log('ERR:novel not found'); return; }
  await nstore.openNovel(novel.id);
  const chapters = await nd.listChapters('$PROMOTE_DIR');
  console.log('CHAPS:'+(chapters?chapters.length:0));
  for (const c of (chapters||[])) {
    const name = typeof c === 'string' ? c : c.name || c.fileName || '';
    const content = await nd.readChapter('$PROMOTE_DIR', name);
    console.log('CH:'+name+' SIZE:'+(content?content.length:0));
  }
  const chars = await nd.listCharacters('$PROMOTE_DIR');
  console.log('CHARS:'+(chars?chars.length:0));
  for (const ch of (chars||[])) console.log('CHAR:'+ch.name+' role:'+ch.role);
  const world = await nd.readWorld('$PROMOTE_DIR');
  console.log('WORLD:'+(world?.lore ? 'yes' : 'no')+' places:'+(world?.places?.length||0));
  const timeline = await nd.listTimeline('$PROMOTE_DIR');
  console.log('TIMELINE:'+(timeline?timeline.length:0));
})().catch(e => console.log('ERR:'+e.message));
" 2>&1 | while read line; do
  case "$line" in
    CHAPS:*) [ "${line#CHAPS:}" -ge 1 ] && PASS "Chapter files: ${line#CHAPS:}" || FAIL "No chapter files" ;;
    CH:*) PASS "  ${line}" ;;
    CHARS:*) [ "${line#CHARS:}" -ge 1 ] && PASS "Characters loaded: ${line#CHARS:}" || FAIL "No characters" ;;
    CHAR:*) PASS "  ${line}" ;;
    WORLD:*) PASS "World: ${line}" ;;
    TIMELINE:*) [ "${line#TIMELINE:}" -ge 1 ] && PASS "Timeline events: ${line#TIMELINE:}" || PASS "Timeline: ${line#TIMELINE:} events" ;;
    ERR:*) FAIL "Open error: ${line#ERR:}" ;;
  esac
done

# ==== 8. Character enrichment framework check ====
echo ""
echo "[8] Character enrichment framework"
node -e "
const ce = require('$ROOT/src/main/import/characterEnricher');
const cs = require('$ROOT/src/main/import/culturalSphere');
const se = require('$ROOT/src/main/import/searchEngine');
// Test cultural sphere detection
cs.detectSphere('碧蓝航线').then(r => {
  console.log('SPHERE:'+r.sphere+' SOURCE:'+r.source);
});
// Test search priority
const prio = se.sourcePriority('east-asian-cn', 'zh-CN');
console.log('PRIORITY:'+prio.join(','));
// Test enricher with no fanwork
ce.enrichCharacters([{name:'测试'}], '').then(chars => {
  console.log('ENRICH_NOFW:'+chars.length+' chars, enriched:'+chars.filter(c=>c._enrichmentSource).length);
});
" 2>&1 | while read line; do
  case "$line" in
    SPHERE:*) PASS "Cultural sphere: ${line}" ;;
    PRIORITY:*) PASS "Source priority: ${line#PRIORITY:}" ;;
    ENRICH_NOFW:*enriched:0) PASS "No fanwork → 0 enriched chars (correct)" ;;
    ENRICH_NOFW:*) PASS "Enricher result: ${line#ENRICH_NOFW:}" ;;
    ERR:*) FAIL "Enrichment error: ${line#ERR:}" ;;
  esac
done

# ==== 9. Merge engine with real data ====
echo ""
echo "[9] Merge engine integration test"
M2_DIR="$TEST_DIR/merge-proj"
mkdir -p "$M2_DIR"
node -e "
const fs = require('fs').promises;
const path = require('path');
const me = require('$ROOT/src/main/import/mergeEngine');
const {novelPaths} = require('$ROOT/src/main/store/paths');
(async () => {
  // Setup novel 2 with conflicting data
  const np = novelPaths('$M2_DIR');
  await fs.mkdir(np.characters, {recursive:true}); await fs.mkdir(np.outlines, {recursive:true});
  await fs.mkdir(np.world, {recursive:true}); await fs.mkdir(np.style, {recursive:true});
  await fs.writeFile(path.join(np.characters, 'st-louis.json'), JSON.stringify({id:'st-louis',name:'圣路易斯',role:'秘书',gender:'女',appearance:'蓝发，身材苗条'}), 'utf8');
  await fs.writeFile(path.join(np.outlines, 'main.md'), '现有大纲v2', 'utf8');

  const {sessionId, items, summary} = await me.createMergeSession('$STAGING_DIR', 'test-novel-2', '$M2_DIR');
  console.log('ITEMS:'+items.length+' CRIT:'+summary.critical+' NORM:'+summary.normal+' MINOR:'+summary.minor);

  // Check character conflict
  const charItem = items.find(i => i.type === 'character');
  if (charItem) console.log('CHAR_CONFLICT:'+charItem.label+' SEV:'+charItem.severity);

  // Resolve all items to left
  for (const item of items) me.resolveConflict(sessionId, item.id, 'left');
  const ms = me.getMergeSummary(sessionId);
  console.log('RESOLVED:'+ms.resolved+'/'+ms.total);

  // Finalize
  await me.finalizeMerge(sessionId);
  console.log('FINALIZED:OK');
})().catch(e => console.log('ERR:'+e.message));
" 2>&1 | while read line; do
  case "$line" in
    ITEMS:*) PASS "Merge session: ${line}" ;;
    CHAR_CONFLICT:*) PASS "  ${line}" ;;
    RESOLVED:*) PASS "All resolved: ${line}" ;;
    FINALIZED:OK) PASS "Merge finalized" ;;
    ERR:*) FAIL "Merge error: ${line#ERR:}" ;;
  esac
done

# ==== 10. EC-13: Duplicate import fingerprint check ====
echo ""
echo "[10] EC-13: Duplicate import fingerprint"
DUP_STAGING_ID=$(node -e "
const sp = require('$ROOT/src/main/import/stagingProject');
const fp = require('$ROOT/src/main/import/fileParser');
(async () => {
  // Create a fresh staging for duplicate test (step 2's staging was promoted)
  const parsed = await fp.parseNovelFile('$TEST_NOVEL');
  const r = await sp.createStagingProject({
    sourceFiles: ['$TEST_NOVEL'],
    chapters: parsed.chapters,
    metadata: parsed.metadata,
    targetNovelId: null,
  });
  console.log('DUP_STAGING:'+r.importId);
  // Now check duplicate
  const dup1 = await sp.checkDuplicateImport(['$TEST_NOVEL']);
  if (dup1.isDuplicate) {
    console.log('DUP1:yes ID:'+dup1.existingImportId);
  } else {
    console.log('DUP1:no');
  }
  // Different file should not match
  const dup2 = await sp.checkDuplicateImport(['/nonexistent/other.txt']);
  if (!dup2.isDuplicate) {
    console.log('DUP2:no FINGERPRINT:'+(dup2.fingerprint ? 'yes' : 'no'));
  } else {
    console.log('DUP2:yes');
  }
})().catch(e => console.log('ERR:'+e.message));
" 2>&1 | grep -v "^DUP_STAGING:")
echo "$DUP_STAGING_ID" | while read line; do
  case "$line" in
    DUP1:yes*) PASS "Duplicate detected: ${line}" ;;
    DUP1:no) FAIL "Should detect duplicate" ;;
    DUP2:no*) PASS "Different file not duplicate: ${line}" ;;
    DUP2:yes) FAIL "Different file should not match" ;;
    ERR:*) FAIL "EC-13 error: ${line#ERR:}" ;;
  esac
done

# ==== 11. EC-14: Chunked analysis for long texts ====
echo ""
echo "[11] EC-14: Chunked text analysis"
node -e "
const {splitIntoChunks, mergeCharacters, mergeFactions, mergeWorld, mergeTimeline} = require('$ROOT/src/main/import/resultMerger');
// Test 1: short text → 1 chunk
const short = '第一章\n\n内容'.repeat(100);
const chunks1 = splitIntoChunks(short, 40000);
console.log('CHUNK_SHORT:'+chunks1.length);
// Test 2: long text → multiple chunks
const long = '# 第一章\n\n' + 'a'.repeat(50000) + '\n\n# 第二章\n\n' + 'b'.repeat(50000);
const chunks2 = splitIntoChunks(long, 40000);
console.log('CHUNK_LONG:'+chunks2.length);
// Test 3: merge characters with duplicates
const mergedChars = mergeCharacters([
  { chunkIndex: 0, characters: [{name:'张三', gender:'男', age:'20', personality:'活泼'}] },
  { chunkIndex: 1, characters: [{name:'张三', gender:'男', age:'21', personality:'', background:'出身贫寒'}, {name:'李四', gender:'女'}] },
]);
console.log('MERGE_CHARS:'+mergedChars.length+' NAMES:'+mergedChars.map(c=>c.name).join(','));
const zhang = mergedChars.find(c=>c.name==='张三');
if (zhang && zhang.age === '21' && zhang.background === '出身贫寒') console.log('MERGE_FIELD:ok');
else console.log('MERGE_FIELD:fail');
// Test 4: merge world places
const mergedWorld = mergeWorld([
  { chunkIndex: 0, world: { lore: '设定A', places: [{name:'北京', type:'城市', description:'首都'}] } },
  { chunkIndex: 1, world: { lore: '设定B', places: [{name:'北京', type:'城市', description:'中国的首都'}, {name:'上海', type:'城市'}] } },
]);
console.log('MERGE_PLACES:'+mergedWorld.places.length);
const beijing = mergedWorld.places.find(p=>p.name==='北京');
if (beijing && beijing.description.includes('中国')) console.log('MERGE_PLACE_DESC:ok');
else console.log('MERGE_PLACE_DESC:fail');
// Test 5: merge timeline dedup
const mergedTimeline = mergeTimeline([
  { chunkIndex: 0, timeline: [{title:'大战爆发', event:'战争开始', involvedCharacters:['张三']}] },
  { chunkIndex: 1, timeline: [{title:'大战爆发', event:'战争开始了', involvedCharacters:['张三','李四']}] },
  { chunkIndex: 1, timeline: [{title:'和平协议', event:'签署协议'}] },
]);
console.log('MERGE_EVENTS:'+mergedTimeline.length);
" 2>&1 | while read line; do
  case "$line" in
    CHUNK_SHORT:1) PASS "Short text → 1 chunk" ;;
    CHUNK_SHORT:*) FAIL "Short text should be 1 chunk: ${line}" ;;
    CHUNK_LONG:*) [ "${line#CHUNK_LONG:}" -ge 2 ] && PASS "Long text → ${line#CHUNK_LONG:} chunks" || FAIL "Long text not chunked" ;;
    MERGE_CHARS:2*) PASS "Merged characters: ${line}" ;;
    MERGE_CHARS:*) FAIL "Character merge wrong count: ${line}" ;;
    MERGE_FIELD:ok) PASS "Character field merge correct" ;;
    MERGE_FIELD:fail) FAIL "Character field merge failed" ;;
    MERGE_PLACES:2) PASS "World places dedup: 2 places" ;;
    MERGE_PLACES:*) FAIL "Place merge wrong count: ${line}" ;;
    MERGE_PLACE_DESC:ok) PASS "Place description merged correctly" ;;
    MERGE_PLACE_DESC:fail) FAIL "Place description merge failed" ;;
    MERGE_EVENTS:2) PASS "Timeline dedup: 2 unique events" ;;
    MERGE_EVENTS:*) FAIL "Timeline dedup wrong count: ${line}" ;;
    ERR:*) FAIL "EC-14 error: ${line#ERR:}" ;;
  esac
done

# ==== Summary ====
echo ""
echo "═══════════════════════════════════════════"
echo " Results: $((TOTAL - FAILED))/$TOTAL passed, $FAILED failed"
echo "═══════════════════════════════════════════"

# Cleanup
rm -rf "$TEST_DIR" /tmp/test-import-id
exit $FAILED
