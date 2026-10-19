'use strict';

// Durable, read-back verified file plans shared by import and regeneration.
// A plan is bound to reviewed bytes. Recovery accepts only before/after bytes;
// an unrelated edit always stops recovery instead of rebasing it.
const fs = require('node:fs/promises');
const path = require('node:path');
const { contentHashExact } = require('../store/resourceIdentity');
const { assertContainedFile } = require('../store/entityIdentity');
const digest = (value) => value === null ? 'missing' : contentHashExact(value);
async function read(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function snapshot(root, relative) {
  const file = path.resolve(root, relative);
  await assertContainedFile(root, file);
  const before = await read(file);
  return { relative, before, beforeHash: digest(before) };
}
function conflict(relative) {
  return Object.assign(new Error(`审阅后资源已变化，请重新审阅：${relative}`), { code: 'stale_import_review', retryable: true });
}
async function commitPlan(root, plan, persist) {
  // The transaction journal is authoritative. A stale UI/session receipt cannot
  // skip storage recovery or silently rebase a reviewed baseline.
  const receipt = await require('../store/projectTransactions').commitPlan(root, plan);
  plan.receipt = receipt; plan.state = 'committed';
  for (const change of plan.changes) change.receipt = receipt.resources.find((r) => r.path === change.relative);
  await persist();
  return receipt;
}
module.exports = { snapshot, read, digest, commitPlan, conflict };
