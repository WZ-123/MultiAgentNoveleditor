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
    const {
      buildQualityReviewPayload,
      detectCrossParagraphQualityAnnotations,
      findDeterministicNotButPatterns,
    } = qualityReviewModule;

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
      { id: 'p16', index: 15, text: '窗外的雨停了一阵。屋檐还在滴水。' },
      { id: 'p17', index: 16, text: '楼道里的灯坏了三天，开关按下去只有空响。' },
      { id: 'p18', index: 17, text: '物业一直没有派人来修，公告栏上还贴着上个月的通知。' },
      { id: 'p19', index: 18, text: '住户们只能摸黑走过那段台阶，鞋底蹭着潮湿的水泥边。' },
      { id: 'p20', index: 19, text: '“那我明天再来。”' },
      { id: 'p21', index: 20, text: '“你别等太久。”' },
      { id: 'p22', index: 21, text: '“我知道。”' },
      { id: 'p23', index: 22, text: '这间屋子里是否还有更多未曾展示的秘密，等待着被揭开？而真正的风暴，也才刚刚开始。' },
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
    assert.deepEqual(structuralParagraphs, ['p10', 'p11', 'p12', 'p15', 'p23', 'p7', 'p7', 'p7', 'p8', 'p9']);
    pass('QCP3_structural_ai_patterns_are_flagged_heuristically', 'chapter-ending套路, ellipsis separators, stock imagery, label descriptors, sensory checklist, and dense similes are deterministically annotated');

    const noNoJustParagraphs = annotations
      .filter((annotation) => annotation.note.includes('没有A，没有B，只是C'))
      .map((annotation) => annotation.paragraphId)
      .sort();
    assert.deepEqual(noNoJustParagraphs, ['p14']);
    pass('QCP4_no_no_just_pattern_is_flagged', 'the “没有，没有，只是” not-but variant is deterministically annotated');

    const mechanicalSingleSentenceParagraphs = annotations
      .filter((annotation) => annotation.note.includes('段落功能审查'))
      .map((annotation) => annotation.paragraphId)
      .sort();
    assert.equal(mechanicalSingleSentenceParagraphs.includes('p17'), true);
    assert.equal(mechanicalSingleSentenceParagraphs.includes('p18'), true);
    assert.equal(mechanicalSingleSentenceParagraphs.includes('p19'), true);
    assert.equal(mechanicalSingleSentenceParagraphs.includes('p20'), false);
    assert.equal(mechanicalSingleSentenceParagraphs.includes('p21'), false);
    assert.equal(mechanicalSingleSentenceParagraphs.includes('p22'), false);
    pass('QCP5_mechanical_single_sentence_runs_are_flagged', 'three adjacent non-dialogue one-sentence paragraphs are flagged as choppy while dialogue lines are ignored');

    const normalizedVariants = detectCrossParagraphQualityAnnotations([
      { id: 'v1', index: 0, text: '没有愤怒,没有悲伤,只是疲惫。' },
      { id: 'v2', index: 1, text: '不是用钱,不是用药,不是用暴力。是靠一碗热粥。' },
      { id: 'v3', index: 2, text: '...' },
      { id: 'v4', index: 3, text: '⋯⋯' },
      { id: 'v5', index: 4, text: '随后他们沉默了。' },
      { id: 'v6', index: 5, text: '那是一种谁也没有料到的默契。' },
    ]);
    assert.ok(normalizedVariants.some((annotation) => annotation.paragraphId === 'v1' && annotation.patternId === 'no_no_just'));
    assert.ok(normalizedVariants.some((annotation) => annotation.paragraphId === 'v2' && annotation.patternId === 'multi_negative_enumeration'));
    assert.ok(normalizedVariants.some((annotation) => annotation.paragraphId === 'v5' && annotation.note.includes('跨段 AI 套句')));
    assert.ok(normalizedVariants.some((annotation) => annotation.paragraphId === 'v6' && annotation.note.includes('跨段 AI 套句')));
    pass('QCP6_fullwidth_halfwidth_and_reaction_variants_are_normalized', 'mixed punctuation and expanded reaction pronouns are detected without changing paragraph IDs');

    const notButVariants = [
      '她不是愤怒，而是疲惫。',
      '她不是愤怒,是疲惫。',
      '她不是愤怒；却是疲惫。',
      '她不是愤怒。只是疲惫。',
      '她不是愤怒。那是长途奔逃后的疲惫。',
      '她不\u3000是愤怒．\n\n“更像\u00a0是疲惫。”',
      '她不\u200b是愤怒！\r\n\r\n「是疲惫。」',
    ];
    for (const variant of notButVariants) {
      assert.ok(findDeterministicNotButPatterns(variant).length > 0, `not-but variant was missed: ${variant}`);
    }
    assert.equal(findDeterministicNotButPatterns('这是不是他总是迟到的原因？').length, 0);
    assert.equal(findDeterministicNotButPatterns('她不是愤怒。她转身离开。是疲惫让她沉默。').length, 0);

    for (const punctuation of ['，', ',', '。', '．', '！', '!', '？', '?', '；', ';']) {
      const pairAnnotations = detectCrossParagraphQualityAnnotations([
        { id: `left-${punctuation}`, index: 0, text: `她不是愤怒${punctuation}` },
        { id: `right-${punctuation}`, index: 1, text: '“是疲惫。”' },
      ]).filter((annotation) => annotation.patternId === 'split_not_but');
      assert.deepEqual(pairAnnotations.map((annotation) => annotation.paragraphId), [
        `left-${punctuation}`,
        `right-${punctuation}`,
      ]);
    }
    pass('QCP7_not_but_variants_share_one_deterministic_normalizer', 'same-sentence, cross-sentence, cross-paragraph, full/half-width punctuation and ignorable spaces are detected without matching unrelated prose');
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
