'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('./paths');
const { readJson, writeJson, readAllJson } = require('./jsonStore');
const transactions = require('./projectTransactions');
const { contractError } = require('../codex-runtime/contracts');
function directory() { return path.join(paths().root, 'chat-runs'); }
function file(runId) { return path.join(directory(), `${crypto.createHash('sha256').update(String(runId)).digest('hex')}.json`); }
async function get(runId) { return transactions.exclusive(directory(), () => readJson(file(runId), null)); }
async function list() { return transactions.exclusive(directory(), () => readAllJson(directory())); }
async function save(value) {
  const target = file(value.runId);
  const snapshot = JSON.parse(JSON.stringify(value));
  return transactions.transaction(directory(), async () => {
    const prior = await readJson(target, null);
    if (prior && prior.version > snapshot.version) return;
    // The MCP owns only this material section. A host checkpoint cannot replace
    // it with a stale in-memory copy; both processes use the existing storage
    // coordinator for the entire read/modify/write operation.
    delete snapshot.writingPreparations;
    if (prior?.writingPreparations) snapshot.writingPreparations = prior.writingPreparations;
    await writeJson(target, snapshot, { mode: 0o600 });
  });
}
async function saveWritingPreparation(runId, candidate, expectedRevision = 0) {
  return transactions.transaction(directory(), async () => {
    const target = file(runId);
    const run = await readJson(target, null);
    if (!run || run.novelId !== candidate.novelId || !['starting','running','waiting-approval'].includes(run.status) || run.cancelRequested) throw contractError('候选所属任务已停止或不存在', 'preparation_task_inactive');
    const prior = run.writingPreparations?.[candidate.id];
    if ((prior?.revision || 0) !== expectedRevision) throw contractError('候选已被另一阶段更新，请取回当前版本', 'preparation_revision_changed');
    run.writingPreparations = { ...run.writingPreparations, [candidate.id]: { ...candidate, runId, revision: expectedRevision + 1 } };
    await writeJson(target, run, { mode: 0o600 });
    return run.writingPreparations[candidate.id];
  });
}
module.exports = { get, list, save, saveWritingPreparation };
