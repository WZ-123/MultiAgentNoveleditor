'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function runQualityCrossParagraphRegressionTest() {
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

  try {
    const qualityReviewModule = await import(
      pathToFileURL(path.join(ROOT, 'src/services/qualityReview.mjs')).href
    );
    const { buildQualityReviewPayload, detectCrossParagraphQualityAnnotations } = qualityReviewModule;

    const paragraphs = [
      { id: 'p1', index: 0, text: '然后她笑了。' },
      { id: 'p2', index: 1, text: '那是一个与从前都不同的笑。' },
      { id: 'p3', index: 2, text: '他不是不想回头，' },
      { id: 'p4', index: 3, text: '而是已经没有脸再站在那里。' },
      { id: 'p5', index: 4, text: '不是用钱、不是用药、不是用暴力。' },
      { id: 'p6', index: 5, text: '他是用一碗温热的肉粥。' },
      { id: 'p7', index: 6, text: '她的声音中带着一丝慵懒的笑意，如同从梦境深处传来，如同一匹被揉碎的丝绸。' },
      { id: 'p8', index: 7, text: '耳朵、眼睛、鼻子、嘴巴、乳头、乳房切口、大腿切口都在发烫。' },
      { id: 'p9', index: 8, text: '……' },
      { id: 'p10', index: 9, text: '……' },
      { id: 'p11', index: 10, text: '……' },
      { id: 'p12', index: 11, text: '……' },
      { id: 'p13', index: 12, text: '圣路易斯藏匿的秘密，是否还有更多未曾展示的隐藏珍宝，等待着被发掘？而这场盛宴，也才刚刚拉开帷幕。' },
      { id: 'p14', index: 13, text: '没有愤怒，没有悲伤，只是疲惫。' },
      { id: 'p15', index: 14, text: '他看了她一眼——没有说话——只是把杯子放回桌上。' },
    ];

    const payload = buildQualityReviewPayload(paragraphs);
    assert.equal(payload.paragraphs[0].prevText, '');
    assert.equal(payload.paragraphs[0].nextText, '那是一个与从前都不同的笑。');
    assert.equal(payload.paragraphs[1].prevText, '然后她笑了。');
    assert.equal(payload.paragraphs[2].nextText, '而是已经没有脸再站在那里。');
    pass('QCP1_payload_includes_adjacent_context', 'Agent5 input now carries prevText/nextText for each paragraph');

    const annotations = detectCrossParagraphQualityAnnotations(paragraphs);
    const reactionParagraphs = annotations
      .filter((annotation) => annotation.note.includes('那是一个'))
      .map((annotation) => annotation.paragraphId)
      .sort();
    const notButParagraphs = annotations
      .filter((annotation) => annotation.kind === 'not_but_overuse')
      .map((annotation) => annotation.paragraphId)
      .sort();

    assert.deepEqual(reactionParagraphs, ['p1', 'p2']);
    assert.deepEqual(notButParagraphs, ['p14', 'p3', 'p4', 'p5', 'p6']);
    const multiNegativeParagraphs = annotations
      .filter((annotation) => annotation.note.includes('否定铺排'))
      .map((annotation) => annotation.paragraphId)
      .sort();
    assert.deepEqual(multiNegativeParagraphs, ['p5', 'p6']);
    pass('QCP2_split_patterns_are_flagged_on_both_paragraphs', 'cross-paragraph cliches are deterministically annotated on each involved paragraph');

    const structuralParagraphs = annotations
      .filter((annotation) => /章末三段式收尾|转场过度依赖「……」分隔线|顺手意象库存痕迹|标签式描述|感官清单式枚举|比喻触发词过密|破折号使用过密/u.test(annotation.note))
      .map((annotation) => annotation.paragraphId)
      .sort();
    assert.deepEqual(structuralParagraphs, ['p10', 'p11', 'p12', 'p13', 'p15', 'p7', 'p7', 'p7', 'p8', 'p9']);
    pass('QCP3_structural_ai_patterns_are_flagged_heuristically', 'chapter-ending套路, ellipsis separators, stock imagery, label descriptors, sensory checklist, and dense similes are deterministically annotated');

    const noNoJustParagraphs = annotations
      .filter((annotation) => annotation.note.includes('没有A，没有B，只是C'))
      .map((annotation) => annotation.paragraphId)
      .sort();
    assert.deepEqual(noNoJustParagraphs, ['p14']);
    pass('QCP4_no_no_just_pattern_is_flagged', 'the “没有，没有，只是” not-but variant is deterministically annotated');
  } catch (err) {
    fail('QCP_regression', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runQualityCrossParagraphRegressionTest };

if (require.main === module) {
  runQualityCrossParagraphRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}