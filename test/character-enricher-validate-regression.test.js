'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { _validateWebInfo } = require(path.join(ROOT, 'src/main/import/characterEnricher.js'));

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function run() {
  let failed = 0;
  try {
    const lycaonPayload = {
      appearance: '银发狼希人执事',
      quotes: '执事莱卡恩，感谢您的指名。',
      personality: '维多利亚家政',
    };
    assert.equal(_validateWebInfo('尼可·莱恩', '原神', lycaonPayload, { title: '冯·莱卡恩' }), false);
    pass('CEVR1_rejects_lycaon_contamination_for_nico');

    const okPayload = {
      appearance: '火元素法器角色',
      personality: '魔女会成员',
      hairColor: '银发',
    };
    assert.equal(_validateWebInfo('尼可·莱恩', '原神', okPayload, { title: '尼可·莱恩' }), true);
    pass('CEVR2_accepts_plausible_nico_payload');
  } catch (err) {
    failed += 1;
    fail('CEVR_harness', err?.stack || String(err));
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
