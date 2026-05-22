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
    assert.deepEqual(notButParagraphs, ['p3', 'p4']);
    pass('QCP2_split_patterns_are_flagged_on_both_paragraphs', 'cross-paragraph cliches are deterministically annotated on each involved paragraph');
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