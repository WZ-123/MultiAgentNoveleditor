'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

async function runChapterTitleHydrationRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData.js'));
  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-title-hydration');
  const novelDir = path.join(tmpRoot, `novel-${Date.now()}`);

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

  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });

    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', '# 山雨欲来\n\n正文一。', { title: '山雨欲来', volume: 2, section: 3 });
    await fs.writeFile(path.join(novelDir, 'chapters', 'chapter-002.md'), '# 无前置元数据\n\n正文二。', 'utf8');

    const batch = await novelData.listChapterMetas(novelDir);
    assert.equal(batch.length, 2);

    const frontmatterChapter = batch.find((entry) => entry.fileName === 'chapter-001.md');
    assert.ok(frontmatterChapter);
    assert.equal(frontmatterChapter.title, '山雨欲来');
    assert.equal(frontmatterChapter.volume, 2);
    assert.equal(frontmatterChapter.section, 3);
    pass('CTH1_frontmatter_title_survives_batch_hydration');

    const legacyChapter = batch.find((entry) => entry.fileName === 'chapter-002.md');
    assert.ok(legacyChapter);
    assert.equal(legacyChapter.title, '无前置元数据');
    assert.equal(legacyChapter.headingTitle, '无前置元数据');
    pass('CTH2_heading_fallback_survives_batch_hydration');
  } catch (err) {
    fail('CTH_harness', err?.stack || String(err));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChapterTitleHydrationRegressionTest };

if (require.main === module) {
  runChapterTitleHydrationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
