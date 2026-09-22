'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const novelData = require('../store/novelData');
const { readJson, writeJson } = require('../store/jsonStore');
const { atomicWriteFile } = require('../store/resourceIdentity');
const { outlineChapterPath, paths } = require('../store/paths');
const { hash } = require('../codex-runtime/contracts');
const { parseResourceRef, readResource, stableJson } = require('./novelResources');
const { ResourceLockService } = require('./resourceLockService');

const locks = new ResourceLockService();
let walQueue = Promise.resolve();
let mutationQueue = Promise.resolve();

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
async function current(entry, resourceRef) {
  try { return { exists: true, ...(await readResource(entry, resourceRef)) }; }
  catch (error) {
    if (error?.code === 'context_incomplete' || error?.code === 'ENOENT') return { exists: false, resourceRef, content: '', sourceHash: hash(null), bytes: 0 };
    throw error;
  }
}
function candidateFor(change, snapshot) {
  const mode = String(change.mode || '');
  if (mode === 'delete') return null;
  if (mode === 'create' || mode === 'replace') return typeof change.content === 'string' ? change.content : stableJson(change.content);
  throw new Error(`不支持的变更模式：${mode}`);
}
function parseCandidateJson(resourceRef, content) {
  try { return JSON.parse(String(content || '')); }
  catch { throw new Error(`${resourceRef} 必须是有效 JSON`); }
}
function canonicalCandidate(resourceRef, content) {
  if (content == null) return null;
  const parsed = parseResourceRef(resourceRef);
  if (parsed.kind === 'character') {
    const value = novelData.normalizeCharacter(parseCandidateJson(resourceRef, content));
    if (!value?.id || value.id !== parsed.key) throw new Error(`${resourceRef} 的 character.id 必须与 resourceRef 一致`);
    return stableJson({ schemaVersion: 1, ...value });
  }
  if (parsed.kind === 'character-memory') {
    const value = novelData.normalizeCharacterMemory(parseCandidateJson(resourceRef, content), parsed.key);
    if (value.characterId !== parsed.key) throw new Error(`${resourceRef} 的 characterId 必须与 resourceRef 一致`);
    return stableJson(value);
  }
  if (parsed.kind === 'timeline') {
    const values = parseCandidateJson(resourceRef, content);
    if (!Array.isArray(values)) throw new Error(`${resourceRef} 必须是 JSON 数组`);
    return stableJson(values.map((event) => novelData.normalizeTimelineEvent({
      ...event,
      chapterRef: event?.chapterRef ?? event?.chapter ?? null,
      when: event?.when ?? ([event?.date, event?.time].filter(Boolean).join(' ') || null),
      description: event?.description ?? event?.event ?? event?.title ?? '',
    })));
  }
  if (parsed.kind === 'timeline-event') {
    const event = parseCandidateJson(resourceRef, content);
    if (String(event?.id || '') !== parsed.key) throw new Error(`${resourceRef} 的 timeline.id 必须与 resourceRef 一致`);
    return stableJson(novelData.normalizeTimelineEvent({
      ...event,
      chapterRef: event?.chapterRef ?? event?.chapter ?? null,
      when: event?.when ?? ([event?.date, event?.time].filter(Boolean).join(' ') || null),
      description: event?.description ?? event?.event ?? event?.title ?? '',
    }));
  }
  return content;
}
async function prepareChanges(entry, request) {
  const changes = Array.isArray(request?.changes) ? request.changes : [];
  if (!String(request?.reason || '').trim()) throw new Error('小说变更事务需要 reason');
  if (!changes.length || changes.length > 16) throw new Error('单次变更资源数必须为 1–16');
  const refs = changes.map((change) => String(change?.resourceRef || ''));
  if (refs.some((ref) => !ref) || new Set(refs).size !== refs.length) throw new Error('resourceRef 不能为空或重复');
  const prepared = [];
  for (const change of changes) {
    const snapshot = await current(entry, change.resourceRef);
    const createMode = change.mode === 'create';
    const parsed = parseResourceRef(change.resourceRef);
    // The editor materializes a zero-byte chapter as soon as a new tab is
    // opened.  From the model's point of view this is still the first write,
    // so allow create to adopt that placeholder while keeping create strict
    // for every non-empty resource and every other resource kind.
    const adoptEmptyChapter = createMode
      && snapshot.exists
      && (parsed.kind === 'chapter' || (parsed.kind === 'outline' && parsed.key === 'chapter'))
      && snapshot.content === '';
    if (!createMode && String(change.baseHash || '') !== snapshot.sourceHash) {
      const error = new Error(`资源版本已变化：${change.resourceRef}`);
      error.code = 'stale_hash';
      throw error;
    }
    if (createMode && snapshot.exists && !adoptEmptyChapter) throw new Error(`资源已存在，不能 create：${change.resourceRef}`);
    if (!createMode && !snapshot.exists) throw new Error(`资源不存在：${change.resourceRef}`);
    const candidate = canonicalCandidate(change.resourceRef, candidateFor(change, snapshot));
    prepared.push({ change: clone(change), existedBefore: snapshot.exists, before: snapshot.content, beforeHash: snapshot.sourceHash, after: candidate, afterHash: hash(candidate) });
  }
  return {
    reason: String(request.reason).trim(),
    resources: prepared,
    preview: prepared.map((item) => ({ resourceRef: item.change.resourceRef, mode: item.change.mode, beforeHash: item.beforeHash, afterHash: item.afterHash, before: item.before, after: item.after })),
  };
}
async function writeResource(entry, resourceRef, content) {
  const parsed = parseResourceRef(resourceRef);
  const value = typeof content === 'string' ? content : stableJson(content);
  if (parsed.kind === 'chapter') {
    let meta = {};
    let before = '';
    try { const snapshot = await novelData.readChapterWithMeta(entry.dir, parsed.key); meta = snapshot.metadata || {}; before = snapshot.content || ''; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await novelData.writeChapterWithMeta(entry.dir, parsed.key, value, meta, { baseContent: before });
  } else if (parsed.kind === 'character') await novelData.writeCharacter(entry.dir, JSON.parse(value));
  else if (parsed.kind === 'character-memory') await novelData.writeCharacterMemory(entry.dir, JSON.parse(value));
  else if (parsed.kind === 'asset') await novelData.upsertAsset(entry.dir, JSON.parse(value));
  else if (parsed.kind === 'timeline') await novelData.replaceTimeline(entry.dir, JSON.parse(value));
  else if (parsed.kind === 'timeline-event') {
    const events = await novelData.listTimeline(entry.dir);
    const candidate = JSON.parse(value);
    const index = events.findIndex((item) => String(item.id) === parsed.key);
    if (index >= 0) events[index] = candidate; else events.push(candidate);
    await novelData.replaceTimeline(entry.dir, events);
  } else if (parsed.kind === 'style') await novelData.writeStyleMemory(entry.dir, value);
  else if (parsed.kind === 'outline' && parsed.key === 'nodes') await novelData.writeOutlineNodes(entry.dir, JSON.parse(value));
  else if (parsed.kind === 'outline' && parsed.key === 'hierarchy') await novelData.writeHierarchicalOutline(entry.dir, JSON.parse(value));
  else if (parsed.kind === 'outline' && parsed.key === 'master') await atomicWriteFile(path.join(entry.dir, 'outlines', 'outline.md'), value);
  else if (parsed.kind === 'outline' && parsed.key === 'chapter') await atomicWriteFile(outlineChapterPath(entry.dir, parsed.volumeIndex, parsed.sectionIndex, parsed.chapterIndex), value);
  else if (parsed.kind === 'world') {
    const world = await novelData.readWorld(entry.dir);
    await novelData.writeWorld(entry.dir, parsed.key === 'lore' ? { lore: value } : { places: JSON.parse(value) }, { baseLore: world.lore || '' });
  } else if (parsed.kind === 'novel') await writeJson(path.join(entry.dir, 'novel.json'), JSON.parse(value));
  else if (parsed.kind === 'chapter-summary') await atomicWriteFile(path.join(entry.dir, 'summaries', `${parsed.key}.md`), value);
  else throw new Error(`该资源暂不支持写入：${resourceRef}`);
}
async function deleteResource(entry, resourceRef) {
  const parsed = parseResourceRef(resourceRef);
  // This private path executes an approved transaction (or rolls it back).
  // Carry that authorization into the store's independent deletion guard.
  if (parsed.kind === 'chapter') await novelData.deleteChapter(entry.dir, parsed.key, { confirmed: true });
  else if (parsed.kind === 'character') await novelData.deleteCharacter(entry.dir, parsed.key);
  else if (parsed.kind === 'character-memory') await novelData.deleteCharacterMemory(entry.dir, parsed.key);
  else if (parsed.kind === 'asset') await novelData.deleteAsset(entry.dir, parsed.key);
  else if (parsed.kind === 'timeline-event') await novelData.replaceTimeline(entry.dir, (await novelData.listTimeline(entry.dir)).filter((item) => String(item.id) !== parsed.key));
  else if (parsed.kind === 'outline' && parsed.key === 'chapter') await fsp.unlink(outlineChapterPath(entry.dir, parsed.volumeIndex, parsed.sectionIndex, parsed.chapterIndex));
  else if (parsed.kind === 'chapter-summary') await fsp.unlink(path.join(entry.dir, 'summaries', `${parsed.key}.md`));
  else throw new Error(`该资源不允许删除：${resourceRef}`);
}
async function appendWal(record) {
  const file = path.join(paths().root, 'mutation-service', 'wal.json');
  const operation = walQueue.then(async () => {
    const wal = await readJson(file, { schemaVersion: 1, blocked: false, transactions: [] });
    if (wal.blocked) { const error = new Error('存在未恢复事务，后续写入已阻止'); error.code = 'recovery_required'; throw error; }
    const index = wal.transactions.findIndex((item) => item.transactionId === record.transactionId);
    if (index >= 0) wal.transactions[index] = record; else wal.transactions.push(record);
    if (record.status === 'recovery_required') wal.blocked = true;
    await writeJson(file, wal, { mode: 0o600 });
  });
  walQueue = operation.catch(() => {});
  return operation;
}
async function recoverIncompleteTransactions() {
  const operation = walQueue.then(async () => {
    const file = path.join(paths().root, 'mutation-service', 'wal.json');
    const wal = await readJson(file, { schemaVersion: 1, blocked: false, transactions: [] });
    if (wal.blocked) { const error = new Error('存在未恢复事务，后续写入已阻止'); error.code = 'recovery_required'; throw error; }
    for (const transaction of wal.transactions.filter((item) => item.status === 'prepared')) {
      const entry = { id: transaction.novelId, dir: transaction.novelDir };
      const refs = transaction.resources.map((item) => item.resourceRef);
      await locks.withLocks(refs, async () => {
        const failures = [];
        for (const item of [...transaction.resources].reverse()) {
          try {
            const snapshot = await current(entry, item.resourceRef);
            if (snapshot.sourceHash === item.beforeHash) continue;
            if (snapshot.sourceHash !== item.afterHash) throw new Error('资源已出现事务外修改');
            if (item.existed) await writeResource(entry, item.resourceRef, item.before);
            else if (snapshot.exists) await deleteResource(entry, item.resourceRef);
            if ((await current(entry, item.resourceRef)).sourceHash !== item.beforeHash) throw new Error('恢复后读回校验失败');
          } catch (error) { failures.push(`${item.resourceRef}: ${error.message}`); }
        }
        transaction.status = failures.length ? 'recovery_required' : 'rolled_back';
        transaction.recoveredAt = new Date().toISOString();
        transaction.rollbackErrors = failures;
        if (failures.length) wal.blocked = true;
      });
    }
    await writeJson(file, wal, { mode: 0o600 });
    if (wal.blocked) { const error = new Error('崩溃事务无法安全恢复，后续写入已阻止'); error.code = 'recovery_required'; throw error; }
  });
  walQueue = operation.catch(() => {});
  return operation;
}
async function applyPreparedTransaction(entry, prepared) {
  const refs = prepared.resources.map((item) => item.change.resourceRef);
  return locks.withLocks(refs, async () => {
    for (const item of prepared.resources) {
      const snapshot = await current(entry, item.change.resourceRef);
      if (snapshot.sourceHash !== item.beforeHash) { const error = new Error(`确认后资源再次变化：${item.change.resourceRef}`); error.code = 'stale_hash'; throw error; }
    }
    const transaction = { transactionId: `mutation-${crypto.randomUUID()}`, novelId: entry.id, novelDir: entry.dir, reason: prepared.reason, status: 'prepared', resources: prepared.resources.map((item) => ({ resourceRef: item.change.resourceRef, before: item.before, beforeHash: item.beforeHash, afterHash: item.afterHash, existed: item.existedBefore })), createdAt: new Date().toISOString() };
    await appendWal(transaction);
    const written = [];
    try {
      for (const item of prepared.resources) {
        if (item.change.mode === 'delete') await deleteResource(entry, item.change.resourceRef);
        else await writeResource(entry, item.change.resourceRef, item.after);
        written.push(item);
      }
      for (const item of prepared.resources) {
        const after = await current(entry, item.change.resourceRef);
        if (after.sourceHash !== item.afterHash) throw new Error(`写后读回校验失败：${item.change.resourceRef}`);
      }
      transaction.status = 'committed';
      transaction.committedAt = new Date().toISOString();
      await appendWal(transaction);
      return { transactionId: transaction.transactionId, status: 'committed', resources: prepared.resources.map((item) => ({ resourceRef: item.change.resourceRef, beforeHash: item.beforeHash, afterHash: item.afterHash })) };
    } catch (error) {
      const rollbackErrors = [];
      for (const item of written.reverse()) {
        try {
          if (!item.existedBefore) await deleteResource(entry, item.change.resourceRef);
          else await writeResource(entry, item.change.resourceRef, item.before);
        } catch (rollbackError) { rollbackErrors.push(`${item.change.resourceRef}: ${rollbackError.message}`); }
      }
      transaction.status = rollbackErrors.length ? 'recovery_required' : 'rolled_back';
      transaction.error = error.message;
      transaction.rollbackErrors = rollbackErrors;
      await appendWal(transaction);
      if (rollbackErrors.length) error.code = 'recovery_required';
      throw error;
    }
  });
}

async function applyPrepared(entry, prepared) {
  const operation = mutationQueue.then(async () => {
    await recoverIncompleteTransactions();
    return applyPreparedTransaction(entry, prepared);
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

module.exports = { applyPrepared, candidateFor, canonicalCandidate, prepareChanges, recoverIncompleteTransactions };
