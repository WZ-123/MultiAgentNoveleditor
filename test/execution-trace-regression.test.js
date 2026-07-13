'use strict';

const assert = require('node:assert/strict');
const { createExecutionTraceAccumulator } = require('../src/main/runtime/executionTrace');

async function run() {
  const updates = [];
  const trace = createExecutionTraceAccumulator({
    driverId: 'direct-api', path: 'direct-api', intent: 'review',
    onUpdate: (update) => updates.push(update),
  });
  trace.upsertStage('route', { kind: 'route', label: '路由', status: 'completed', summary: '审查任务' });
  trace.setContextManifest({ included: [{ sourceRef: 'chapter:chapter-001.md', kind: 'chapter' }], trimmed: [], cached: [], omitted: [], toolPolicy: { id: 'review' } });
  trace.upsertTool({ id: 'toolu-1', name: 'read_chapter', input: { name: 'chapter-001.md' }, status: 'running' });
  trace.upsertTool({ id: 'toolu-1', name: 'read_chapter', input: { name: 'chapter-001.md' }, status: 'done', text: '正文内容', cached: true, sourceRef: 'tool:read_chapter#toolu-1' });
  trace.setVerification({ checks: [{ constraintId: 'must-1', status: 'satisfied', severity: 'blocking', evidenceParagraphIds: ['p-0'] }] });
  const completed = trace.complete('completed');
  assert.equal(completed.schemaVersion, 1);
  assert.equal(completed.tools.length, 1);
  assert.equal(completed.tools[0].cached, true);
  assert.equal(completed.context.sources[0].sourceRef, 'chapter:chapter-001.md');
  assert.equal(completed.verification.status, 'passed');
  assert.equal(Object.prototype.hasOwnProperty.call(completed, 'thinking'), false);
  assert.ok(updates.length >= 6);
  console.log('TEST_PASS execution-trace-regression');
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { run };
