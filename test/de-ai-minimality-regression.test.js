'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runDeAiMinimalityRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };
  const pass = (name, detail) => {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}: ${detail}`);
  };
  const fail = (name, error) => {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${error?.message || String(error)}`);
  };

  const modulePath = path.join(__dirname, '..', 'src/services/deAiMinimality.mjs');
  const { assessDeAiMinimality, minimalityRetryInstruction } = await import(modulePath);

  try {
    const result = assessDeAiMinimality(
      '然后她笑了。那是一个很淡的笑。',
      '她轻轻笑了一下。'
    );
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
    pass('DAIM1_minimal_rewrite_passes', 'a shorter direct rewrite is accepted');
  } catch (error) {
    fail('DAIM1_minimal_rewrite_passes', error);
  }

  try {
    const result = assessDeAiMinimality(
      '她笑了。',
      '月光落在她肩头，她仿佛终于明白了什么：“我已经等得太久。”'
    );
    const ids = result.violations.map((item) => item.id);
    assert.equal(result.ok, false);
    assert.ok(ids.includes('added_dialogue'));
    assert.ok(ids.includes('added_metaphor'));
    assert.ok(ids.includes('added_atmosphere'));
    assert.ok(ids.includes('added_psychology'));
    assert.match(minimalityRetryInstruction(result), /不得增添原文没有的对白、动作、景物/u);
    pass('DAIM2_new_decorations_are_rejected', 'new dialogue, metaphor, atmosphere, and psychology are rejected');
  } catch (error) {
    fail('DAIM2_new_decorations_are_rejected', error);
  }

  try {
    const source = '她停了一下。\n\n门没开。\n\n她又敲了一次。';
    const flattened = assessDeAiMinimality(source, '她停了一下，见门没开，便又敲了一次。');
    assert.equal(flattened.ok, false);
    assert.ok(flattened.violations.some((item) => item.id === 'flattened_paragraph_rhythm'));

    const allowed = assessDeAiMinimality(source, '她停了一下，见门没开，便又敲了一次。', {
      guidance: '段落功能审查确认这是一组机械拆段，请合并。',
    });
    assert.equal(allowed.violations.some((item) => item.id === 'flattened_paragraph_rhythm'), false);
    pass('DAIM3_irregular_rhythm_is_preserved_unless_merge_is_explicit', 'paragraph flattening requires explicit paragraph-function guidance');
  } catch (error) {
    fail('DAIM3_irregular_rhythm_is_preserved_unless_merge_is_explicit', error);
  }

  try {
    const fixed = assessDeAiMinimality('她不是愤怒，而是疲惫。', '她疲惫地靠在门边。');
    assert.equal(fixed.ok, true);
    assert.equal(fixed.metrics.sourceNotButPatternCount, 1);
    assert.equal(fixed.metrics.revisedNotButPatternCount, 0);

    const persisted = assessDeAiMinimality(
      '她不是愤怒，而是疲惫。',
      '她不\u3000是愤怒．\n\n“却\u00a0是疲惫。”'
    );
    assert.equal(persisted.ok, false);
    assert.ok(persisted.violations.some((item) => item.id === 'not_but_pattern_persists'));
    assert.match(minimalityRetryInstruction(persisted), /候选仍保留/u);
    pass('DAIM4_not_but_target_must_be_removed', 'the candidate must remove the targeted skeleton across punctuation, whitespace, sentence and paragraph variants');
  } catch (error) {
    fail('DAIM4_not_but_target_must_be_removed', error);
  }

  try {
    const introduced = assessDeAiMinimality('她很疲惫。', '她不是愤怒，只是疲惫。');
    assert.equal(introduced.ok, false);
    assert.ok(introduced.violations.some((item) => item.id === 'introduced_not_but_pattern'));
    assert.equal(introduced.metrics.sourceNotButPatternCount, 0);
    assert.equal(introduced.metrics.revisedNotButPatternCount, 1);
    pass('DAIM5_not_but_target_cannot_be_introduced', 'a de-ai candidate cannot introduce a new not-but skeleton into clean source text');
  } catch (error) {
    fail('DAIM5_not_but_target_cannot_be_introduced', error);
  }

  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runDeAiMinimalityRegressionTest };

if (require.main === module) {
  runDeAiMinimalityRegressionTest().then((results) => {
    if (results.failed) process.exitCode = 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
