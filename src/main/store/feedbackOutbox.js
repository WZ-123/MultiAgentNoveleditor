'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const { paths, generateId, ensureDirSync } = require('./paths');
const { readJson, writeJson, listJsonFiles } = require('./jsonStore');

function outboxDir() {
  return paths().feedbackOutbox;
}

function indexPath() {
  return paths().feedbackIndex;
}

function feedbackPath(feedbackId) {
  return path.join(outboxDir(), `${feedbackId}.json`);
}

function attachmentPath(feedbackId, fileName) {
  return path.join(outboxDir(), `${feedbackId}-${fileName}`);
}

function ensureFeedbackOutbox() {
  ensureDirSync(outboxDir());
}

async function readIndex() {
  return readJson(indexPath(), { items: [] });
}

async function writeIndex(index) {
  ensureFeedbackOutbox();
  await writeJson(indexPath(), index);
}

function enrichPayload(payload) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {};
  const environment = next.environment && typeof next.environment === 'object' ? { ...next.environment } : {};
  if (!environment.appVersion) {
    try {
      environment.appVersion = require(path.join(__dirname, '../../../package.json')).version || '';
    } catch {
      environment.appVersion = '';
    }
  }
  next.environment = environment;
  return next;
}

function sanitizeFileName(fileName) {
  return String(fileName || 'attachment.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeAttachments(feedbackId, attachments) {
  const normalized = Array.isArray(attachments) ? attachments : [];
  const saved = [];
  for (const attachment of normalized) {
    const buffer = attachment?.data;
    if (!Buffer.isBuffer(buffer) || !buffer.length) continue;
    const fileName = sanitizeFileName(attachment.fileName || `${attachment.kind || 'attachment'}.bin`);
    const filePath = attachmentPath(feedbackId, fileName);
    await fs.writeFile(filePath, buffer);
    saved.push({
      kind: attachment.kind || 'attachment',
      label: attachment.label || fileName,
      mimeType: attachment.mimeType || 'application/octet-stream',
      fileName,
      localPath: filePath,
      size: buffer.length,
      createdAt: new Date().toISOString(),
    });
  }
  return saved;
}

async function submitFeedback(payload, options = {}) {
  ensureFeedbackOutbox();
  const enriched = enrichPayload(payload);
  const feedbackId = typeof enriched.feedbackId === 'string' && enriched.feedbackId
    ? enriched.feedbackId
    : generateId('fb');
  const createdAt = enriched.createdAt || new Date().toISOString();
  const attachments = await writeAttachments(feedbackId, options.attachments);
  const endpointProfile = options.endpointProfile || 'dev';
  const record = {
    feedbackId,
    createdAt,
    status: 'pending',
    transport: 'local-outbox',
    syncStatus: 'pending',
    retryCount: 0,
    lastSendAttemptAt: null,
    lastSendSucceededAt: null,
    nextRetryAt: null,
    lastError: null,
    lastErrorCode: null,
    remoteRecordId: null,
    remoteTableId: null,
    remoteAttachmentTokens: [],
    endpointProfile,
    transportMeta: null,
    payload: {
      ...enriched,
      feedbackId,
      createdAt,
      attachments,
    },
  };
  await writeJson(feedbackPath(feedbackId), record);

  const index = await readIndex();
  const items = Array.isArray(index.items) ? index.items.filter((item) => item.feedbackId !== feedbackId) : [];
  items.unshift({
    feedbackId,
    createdAt,
    status: 'pending',
    syncStatus: 'pending',
    issueTitle: record.payload?.userInput?.issueTitle || '未命名反馈',
    feedbackMode: record.payload?.userInput?.feedbackMode || 'opinion-only',
  });
  await writeIndex({ items });

  return {
    feedbackId,
    createdAt,
    status: 'pending',
    syncStatus: 'pending',
    attachments,
    savedTo: feedbackPath(feedbackId),
  };
}

async function getRecord(feedbackId) {
  return readJson(feedbackPath(feedbackId), null);
}

async function updateSyncMeta(feedbackId, patch) {
  const file = feedbackPath(feedbackId);
  const record = await readJson(file, null);
  if (!record) return null;

  const allowed = [
    'syncStatus',
    'retryCount',
    'lastSendAttemptAt',
    'lastSendSucceededAt',
    'nextRetryAt',
    'lastError',
    'lastErrorCode',
    'remoteRecordId',
    'remoteTableId',
    'remoteAttachmentTokens',
    'endpointProfile',
    'transportMeta',
  ];
  const next = { ...record };
  for (const key of allowed) {
    if (key in patch) next[key] = patch[key];
  }
  await writeJson(file, next);

  // Update index summary if syncStatus changed
  if ('syncStatus' in patch) {
    const index = await readIndex();
    const items = Array.isArray(index.items) ? index.items : [];
    const idx = items.findIndex((item) => item.feedbackId === feedbackId);
    if (idx >= 0) {
      items[idx] = { ...items[idx], syncStatus: patch.syncStatus };
      await writeIndex({ items });
    }
  }

  return next;
}

async function listPendingForSync() {
  const now = new Date().toISOString();
  const files = await listJsonFiles(outboxDir());
  const pending = [];
  for (const file of files) {
    const name = path.basename(file);
    if (name === 'index.json') continue;
    const record = await readJson(file, null);
    if (!record || !record.feedbackId) continue;
    const status = record.syncStatus;
    if (status !== 'pending' && status !== 'retryable_failed') continue;
    if (record.nextRetryAt && record.nextRetryAt > now) continue;
    pending.push(record);
  }
  pending.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return pending;
}

async function listAllRecords() {
  const files = await listJsonFiles(outboxDir());
  const records = [];
  for (const file of files) {
    if (path.basename(file) === 'index.json') continue;
    const record = await readJson(file, null);
    if (record && record.feedbackId) records.push(record);
  }
  records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return records;
}

async function recoverStuckSyncing() {
  const files = await listJsonFiles(outboxDir());
  let recovered = 0;
  for (const file of files) {
    if (path.basename(file) === 'index.json') continue;
    const record = await readJson(file, null);
    if (record && record.syncStatus === 'syncing') {
      await updateSyncMeta(record.feedbackId, { syncStatus: 'pending' });
      recovered += 1;
    }
  }
  return recovered;
}

module.exports = {
  submitFeedback,
  getRecord,
  updateSyncMeta,
  listPendingForSync,
  listAllRecords,
  recoverStuckSyncing,
  feedbackPath,
  attachmentPath,
  outboxDir,
  readIndex,
};
