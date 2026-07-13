'use strict';

const assert = require('node:assert/strict');
const { verifyChapterConstraints } = require('../src/main/runtime/chapterConstraintVerifier');

async function run() {
  const assertions = [{
    constraintId: 'door-order',
    assertion: '自动隔离门必须依次关闭，不能同时关闭。',
    severity: 'blocking',
    deterministic: true,
    sceneId: 'scene-a',
    sourceRefs: [{ ref: 'outline:scene-a', deterministic: true }],
  }];
  const violated = await verifyChapterConstraints({
    draft: { text: '警报响起，所有气密门同时落下。', assertions },
    assertions,
    modelRuntime: { async invoke() { return { output: JSON.stringify({ checks: [{ constraintId: 'door-order', status: 'violated', summary: '正文写成同时关闭。', confidence: 0.99, evidenceParagraphIds: ['p-0'] }] }) }; } },
  });
  assert.equal(violated.status, 'blocked');
  assert.equal(violated.checks[0].severity, 'blocking');
  assert.equal(violated.issues[0].reviewIncomplete, false);

  const badEvidence = await verifyChapterConstraints({
    draft: { text: '气密门逐扇关闭。', assertions },
    assertions,
    modelRuntime: { async invoke() { return { output: JSON.stringify({ checks: [{ constraintId: 'door-order', status: 'satisfied', summary: '满足', confidence: 0.99, evidenceParagraphIds: ['p-999'] }] }) }; } },
  });
  assert.equal(badEvidence.status, 'blocked');
  assert.equal(badEvidence.checks[0].status, 'unclear');
  assert.equal(badEvidence.issues[0].reviewIncomplete, true);
  console.log('TEST_PASS chapter-constraint-verifier-regression');
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { run };
