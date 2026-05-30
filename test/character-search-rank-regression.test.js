'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { scoreSearchResult, rankSearchResults } = require(path.join(ROOT, 'src/main/import/searchEngine.js'));

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function run() {
  let failed = 0;

  try {
    const ctx = { charName: '肇和', fanworkName: '碧蓝航线' };
    const listScore = scoreSearchResult({ title: '碧蓝航线/图鉴/驱逐(DD)', source: 'moegirl' }, ctx);
    const charScore = scoreSearchResult({ title: '碧蓝航线:肇和', source: 'moegirl', url: 'https://moegirl.icu/x' }, ctx);
    assert.ok(charScore > listScore, `char=${charScore} list=${listScore}`);
    pass('CSRR1_list_page_scores_lower_than_character_page');

    const ranked = rankSearchResults([
      { title: '碧蓝航线/图鉴/驱逐(DD)', source: 'moegirl' },
      { title: '碧蓝航线:肇和', source: 'moegirl', url: 'https://moegirl.icu/x' },
    ], ctx);
    assert.equal(ranked[0]?.title, '碧蓝航线:肇和');
    pass('CSRR2_rank_puts_character_page_first');

    const nicoWrong = scoreSearchResult({ title: '冯·莱卡恩', source: 'moegirl' }, { charName: '尼可·莱恩', fanworkName: '原神' });
    const nicoRight = scoreSearchResult({ title: '尼可·莱恩', source: 'moegirl' }, { charName: '尼可·莱恩', fanworkName: '原神' });
    assert.ok(nicoRight > nicoWrong);
    pass('CSRR3_nico_lein_prefers_correct_title_over_lycaon');
  } catch (err) {
    failed += 1;
    fail('CSRR_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${failed ? 0 : 1}/1 passed, ${failed} failed`);
  console.log('TEST_DONE');
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
