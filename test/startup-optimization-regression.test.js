'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const novelData = require(path.join(ROOT, 'src/main/store/novelData.js'));

async function runStartupOptimizationRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  let tmpNovelDir = null;
  try {
    tmpNovelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-opt-reg-'));
    await fs.mkdir(path.join(tmpNovelDir, 'chapters'), { recursive: true });
    await fs.writeFile(
      path.join(tmpNovelDir, 'chapters', 'chapter-001.md'),
      `# 序章\n\n${'正文段落。'.repeat(5000)}`,
      'utf8'
    );

    const legacyMeta = await novelData.readChapterMeta(tmpNovelDir, 'chapter-001.md');
    assert.ok(legacyMeta);
    assert.equal(legacyMeta.metadata, null);
    assert.equal(legacyMeta.headingTitle, '序章');
    pass('SOR1_read_chapter_meta_extracts_heading_without_frontmatter', 'lightweight chapter metadata reads can now recover the leading H1 for legacy files');

    const batchMeta = await novelData.listChapterMetas(tmpNovelDir);
    assert.equal(batchMeta.length, 1);
    assert.equal(batchMeta[0].fileName, 'chapter-001.md');
    assert.equal(batchMeta[0].headingTitle, '序章');
    assert.equal(batchMeta[0].title, '序章');
    assert.equal(batchMeta[0].volume, null);
    assert.equal(batchMeta[0].section, null);
    pass('SOR1b_list_chapter_metas_batches_startup_reads', 'chapter metadata can now be collected in one main-process sweep for startup hydration');

    const appCode = await fs.readFile(path.join(ROOT, 'src/App.jsx'), 'utf8');
    const syncStart = appCode.indexOf('async function syncNovelTreeFromDisk');
    const syncEnd = appCode.indexOf('  const chapterEntries = useMemo', syncStart);
    const syncBlock = appCode.slice(syncStart, syncEnd);
    assert.ok(syncBlock.includes('listChapterMetas'));
    assert.ok(syncBlock.includes('chapterMeta.displayName'));
    assert.equal(syncBlock.includes('readChapterMeta('), false);
    assert.equal(syncBlock.includes('readChapter('), false);
    assert.equal(appCode.includes('function buildChapterDisplayName('), false);
    assert.ok(appCode.includes('const ensureChapterContentLoaded = useCallback(async (chapterId) => {'));
    assert.ok(appCode.includes('await ensureChapterContentLoaded(chapterId);'));
    pass('SOR2_app_syncs_tree_from_batched_metadata_and_loads_body_on_open', 'startup sync now batches chapter metadata reads, uses main-process display names, and defers body loading until open/write paths');

    const mainIndexCode = await fs.readFile(path.join(ROOT, 'src/main/index.js'), 'utf8');
    const initStart = mainIndexCode.indexOf('async function initBackend()');
    const attachStart = mainIndexCode.indexOf('function attachWindow', initStart);
    const initBlock = mainIndexCode.slice(initStart, attachStart);
    assert.equal(initBlock.includes('await ensureSkillSeed();'), false);
    assert.equal(initBlock.includes('await subagentsStore.ensureBuiltinSeeds();'), false);
    assert.equal(initBlock.includes('await dagsStore.ensureBuiltinSeeds();'), false);
    assert.ok(mainIndexCode.includes('async function startDeferredStartup()'));
    assert.ok(mainIndexCode.includes('ensureSkillSeed(),'));
    assert.ok(mainIndexCode.includes('subagentsStore.ensureBuiltinSeeds(),'));
    assert.ok(mainIndexCode.includes('dagsStore.ensureBuiltinSeeds(),'));

    const mainCode = await fs.readFile(path.join(ROOT, 'main.js'), 'utf8');
    const createWindowIndex = mainCode.indexOf('await createWindow();');
    const deferredIndex = mainCode.indexOf('backend.startDeferredStartup?.().catch');
    assert.ok(createWindowIndex >= 0);
    assert.ok(deferredIndex > createWindowIndex);
    pass('SOR3_main_process_defers_noncritical_startup_work', 'seed/quota/worker cleanup tasks now run after createWindow instead of blocking initBackend');
  } catch (err) {
    fail('SOR_harness', err && err.stack ? err.stack : String(err));
  } finally {
    if (tmpNovelDir) {
      await fs.rm(tmpNovelDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runStartupOptimizationRegressionTest };

if (require.main === module) {
  runStartupOptimizationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
