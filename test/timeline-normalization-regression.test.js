'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function runTimelineNormalizationRegressionTest() {
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

  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));

  const tmpRoot = path.join(ROOT, 'tmp-test-timeline-normalization');
  const novelDir = path.join(tmpRoot, 'novel-' + Date.now());

  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(novelDir, { recursive: true });

    await novelData.writeChapter(novelDir, 'chapter-001.md', '第1章');
    await novelData.writeChapter(novelDir, 'chapter-002.md', '第2章');
    await novelData.writeChapter(novelDir, 'chapter-003.md', '第3章');
    await novelData.writeChapter(novelDir, 'chapter-004.md', '第4章');
    pass('N1_seed_chapters', 'created chapter-001..004');

    await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-001.md', [
      { when: '第一夜', where: '破庙', participants: ['hero'], description: '第一章事件' },
    ]);
    await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-002.md', [
      { when: '第二天白天', where: '天桥', participants: ['aning'], description: '第二章事件' },
    ]);
    const chapter4Summary = await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-004.md', [
      { when: '晚上八点', where: '直播间', participants: ['hero'], description: '第四章事件' },
    ]);
    if (chapter4Summary.validation?.missingChapterRefs?.includes('chapter-003.md')) {
      pass('N2_missing_chapter_gap_detected', 'sync reported chapter-003 timeline gap between chapter-002 and chapter-004');
    } else {
      fail('N2_missing_chapter_gap_detected', JSON.stringify(chapter4Summary));
    }

    await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-003a.md', [
      { when: '插入章夜间', where: '废弃稿', participants: ['hero'], description: '残留插入章事件' },
    ]);
    await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-003.md', [
      { when: '第三天凌晨', where: '派出所', participants: ['hero'], description: '第三章事件' },
    ]);
    const orphanSummary = await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-004.md', [
      { when: '晚上八点', where: '直播间', participants: ['hero'], description: '第四章事件（修订）' },
    ]);
    if (orphanSummary.validation?.orphanChapterRefs?.includes('chapter-003a.md')) {
      pass('N3_orphan_chapter_ref_detected', 'sync reported stale chapter-003a timeline residue');
    } else {
      fail('N3_orphan_chapter_ref_detected', JSON.stringify(orphanSummary));
    }

    const orderedTimeline = await novelData.listTimeline(novelDir);
    const lastChapter3Index = orderedTimeline.map((event) => event.chapterRef).lastIndexOf('chapter-003.md');
    const firstChapter4Index = orderedTimeline.findIndex((event) => event.chapterRef === 'chapter-004.md');
    if (lastChapter3Index >= 0 && firstChapter4Index >= 0 && lastChapter3Index < firstChapter4Index) {
      pass('N4_story_order_stable_after_late_sync', 'chapter-003 events stayed ahead of chapter-004 after syncing chapter-003 late');
    } else {
      fail('N4_story_order_stable_after_late_sync', JSON.stringify(orderedTimeline));
    }

    await novelData.syncTimelineEventsForChapter(novelDir, 'chapter-002.md', [
      { when: '第二天白天', where: '天桥', participants: ['aning'], description: '第二章合并事件' },
      { when: '第二天白天', where: '天桥', participants: ['aning'], description: '第二章合并事件' },
    ]);
    const chapter2Events = await novelData.queryTimeline(novelDir, { chapterRef: 'chapter-002.md' });
    if (chapter2Events.length === 1 && chapter2Events[0]?.description === '第二章合并事件') {
      pass('N5_sync_dedupes_same_chapter_duplicates', 'semantic duplicates in one sync batch were collapsed to one event');
    } else {
      fail('N5_sync_dedupes_same_chapter_duplicates', JSON.stringify(chapter2Events));
    }
  } catch (err) {
    fail('N6_harness', err && err.stack ? err.stack : String(err));
  } finally {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runTimelineNormalizationRegressionTest };

if (require.main === module) {
  runTimelineNormalizationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}