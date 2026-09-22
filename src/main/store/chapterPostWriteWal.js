'use strict';

const path = require('node:path');
const { ensureNovelLayout, novelPaths } = require('./paths');
const { deleteFile, listJsonFiles, readJson, writeJson } = require('./jsonStore');

const SCHEMA_VERSION = 1;
const VALID_PHASES = new Set([
  'prepared',
  'incomplete_marked',
  'memory_written',
  'state_staged',
  'state_committed',
  'rollback_failed',
  'recovery_failed',
]);

function safeTransactionId(value) {
  return String(value || '').trim().replace(/[^\w.-]+/gu, '_');
}

function walRoot(novelDir) {
  return path.join(novelPaths(novelDir).mana, 'post-write-wal');
}

function walPath(novelDir, transactionId) {
  const safe = safeTransactionId(transactionId);
  if (!safe) throw new Error('post-write WAL requires transactionId');
  return path.join(walRoot(novelDir), `${safe}.json`);
}

function normalizeRecord(value = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    transactionId: String(value.transactionId || '').trim(),
    draftId: String(value.draftId || '').trim(),
    chapterName: String(value.chapterName || '').trim(),
    jobFingerprint: String(value.jobFingerprint || '').trim(),
    novelIdentityHash: String(value.novelIdentityHash || '').trim(),
    draftContentHash: String(value.draftContentHash || '').trim(),
    phase: VALID_PHASES.has(value.phase) ? value.phase : 'prepared',
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || new Date().toISOString(),
    stateSnapshot: value.stateSnapshot && typeof value.stateSnapshot === 'object'
      ? value.stateSnapshot
      : { existed: false, value: null },
    memorySnapshots: (Array.isArray(value.memorySnapshots) ? value.memorySnapshots : [])
      .filter((item) => item && typeof item === 'object' && String(item.characterId || '').trim())
      .map((item) => ({
        characterId: String(item.characterId).trim(),
        existed: item.existed === true,
        memory: item.memory && typeof item.memory === 'object' ? item.memory : null,
      })),
    error: String(value.error || ''),
  };
}

async function prepare(novelDir, record) {
  ensureNovelLayout(novelDir);
  const normalized = normalizeRecord({ ...record, phase: 'prepared' });
  if (!normalized.transactionId || !normalized.draftId || !normalized.jobFingerprint || !normalized.novelIdentityHash) {
    throw new Error('post-write WAL requires transaction, draft, job and novel identity');
  }
  await writeJson(walPath(novelDir, normalized.transactionId), normalized);
  return normalized;
}

async function update(novelDir, transactionId, patch = {}) {
  const file = walPath(novelDir, transactionId);
  const current = await readJson(file, null);
  if (!current) throw new Error(`post-write WAL not found: ${transactionId}`);
  const next = normalizeRecord({
    ...current,
    ...patch,
    transactionId: current.transactionId,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  });
  await writeJson(file, next);
  return next;
}

async function remove(novelDir, transactionId) {
  await deleteFile(walPath(novelDir, transactionId));
}

async function listForJob(novelDir, { draftId, jobFingerprint } = {}) {
  const records = [];
  for (const file of await listJsonFiles(walRoot(novelDir))) {
    const record = normalizeRecord(await readJson(file, {}));
    if (!record.transactionId) continue;
    if (draftId && record.draftId !== String(draftId)) continue;
    if (jobFingerprint && record.jobFingerprint !== String(jobFingerprint)) continue;
    records.push(record);
  }
  return records.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

module.exports = {
  SCHEMA_VERSION,
  listForJob,
  prepare,
  remove,
  update,
  walPath,
  _testNormalizeRecord: normalizeRecord,
};
