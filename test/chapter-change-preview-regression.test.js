'use strict';

const assert = require('node:assert/strict');
const {
  buildChapterChangePreview,
  chapterChangePreviewForPending,
  changePreviewAfterText,
} = require('../src/services/chapterChangePreview.cjs');

function pass(name, detail) {
  console.log(`TEST_PASS ${name}: ${detail}`);
}

function run() {
  const longPrefix = '甲'.repeat(640);
  const longSuffix = '乙'.repeat(640);
  const before = `${longPrefix}旧句落在长行尾部。${longSuffix}`;
  const after = `${longPrefix}新句落在长行尾部。${longSuffix}`;
  const preview = buildChapterChangePreview(before, after);
  assert.equal(preview.hasChanges, true);
  assert.equal(preview.changeCount, 1);
  assert.ok(preview.hunks[0].beforeStart > 500);
  assert.match(preview.hunks[0].beforeSnippet, /旧句落在长行尾部/u);
  assert.match(preview.hunks[0].afterSnippet, /新句落在长行尾部/u);
  assert.doesNotMatch(preview.hunks[0].beforeSnippet, /^甲{500}/u);
  assert.match(changePreviewAfterText(preview), /新句落在长行尾部/u);
  pass('CCPR1_change_after_500_in_long_line_is_visible', 'the hunk is centered on the actual old/new text instead of the chapter prefix');

  const multiBefore = ['保留开头。', '第一处旧文。', '中间正文。'.repeat(60), '第二处旧文。', '保留结尾。'].join('\n');
  const multiAfter = ['保留开头。', '第一处新文。', '中间正文。'.repeat(60), '第二处新文。', '保留结尾。'].join('\n');
  const multiPreview = buildChapterChangePreview(multiBefore, multiAfter);
  assert.equal(multiPreview.changeCount, 2);
  assert.equal(multiPreview.hunks.length, 2);
  assert.match(multiPreview.hunks[0].beforeSnippet, /第一处旧文/u);
  assert.match(multiPreview.hunks[0].afterSnippet, /第一处新文/u);
  assert.match(multiPreview.hunks[1].beforeSnippet, /第二处旧文/u);
  assert.match(multiPreview.hunks[1].afterSnippet, /第二处新文/u);
  pass('CCPR2_multiple_distant_changes_keep_separate_hunks', 'each distant edit retains an old/new preview instead of swallowing the middle of the chapter');

  const restoredPreview = chapterChangePreviewForPending({
    baseContent: before.replace(/\n/gu, '\r\n'),
    content: after.replace(/\n/gu, '\r\n'),
  });
  const repeatedPreview = chapterChangePreviewForPending({ baseContent: before, content: after });
  assert.deepEqual(restoredPreview, repeatedPreview);
  assert.deepEqual(chapterChangePreviewForPending({
    baseContent: 'ignored old value',
    content: 'ignored new value',
    changePreview: preview,
  }), preview);
  pass('CCPR3_preview_is_stable_across_restore_and_line_endings', 'legacy transactions rebuild deterministically and persisted versioned previews remain unchanged');
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { run };
