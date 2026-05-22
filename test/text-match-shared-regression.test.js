'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runTextMatchSharedRegressionTest() {
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
    const matcher = require(path.join(__dirname, '..', 'src/domain/textMatch.cjs'));

    const normalizedCandidates = matcher.collectPreferredTextMatches(
      '她说：　“今夜先别走。”',
      '她说: "今夜先别走。"'
    );
    assert.equal(normalizedCandidates.matches.length, 1);
    assert.equal(normalizedCandidates.matches[0]?.start, 0);
    assert.equal(normalizedCandidates.matches[0]?.end, '她说：　“今夜先别走。”'.length);
    assert.equal(normalizedCandidates.matches[0]?.strategy, 'normalized');
    pass('TSM1_collect_preferred_matches_falls_back_to_normalized_forms', 'shared matcher treats Chinese full-width punctuation and ASCII equivalents as the same visual span');

    const resolved = matcher.resolveAnchoredTextMatches(
      [
        '第一段。',
        '',
        '她轻声说：“欢迎回来。”',
        '',
        '第二段。',
        '',
        '她轻声说：“欢迎回来。”',
        '',
        '第三段。',
      ].join('\n'),
      '她轻声说：“欢迎回来。”',
      {
        beforeContext: '第二段。',
        afterContext: '第三段。',
      }
    );
    assert.equal(resolved.matches.length, 1);
    assert.equal(resolved.strategy, 'normalized_context');
    pass('TSM2_resolve_anchored_matches_uses_context_to_disambiguate', 'shared matcher narrows duplicate hits with before/after context');
  } catch (err) {
    fail('TSM_harness', err && err.stack ? err.stack : String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runTextMatchSharedRegressionTest };

if (require.main === module) {
  runTextMatchSharedRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}