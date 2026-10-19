'use strict';

/**
 * Offline Operation Log — records user edits while offline for later sync.
 *
 * Each log entry:
 *   {
 *     id, timestamp, type: 'character'|'world'|'outline'|'chapter'|'asset'|...,
 *     action: 'create'|'update'|'delete',
 *     targetId, targetName,
 *     payload: { ... },
 *     networkStatus: 'offline'|'disconnected',
 *     synced: boolean,
 *     novelId
 *   }
 *
 * Storage: <userData>/offline-logs/<novelId>-<date>.jsonl
 * Also an index: <userData>/offline-logs/index.json
 */

const fs = require('node:fs').promises;
const path = require('node:path');
const { paths, generateId } = require('./paths');
const { contentHashExact } = require('./resourceIdentity');
const { readJson, writeJson } = require('./jsonStore');

const LOGS_DIR = 'offline-logs';
const INDEX_FILE = 'index.json';

function logsDir() {
  return path.join(paths().root, LOGS_DIR);
}

function logFilePath(novelId, dateStr) {
  if (novelId) require('./entityIdentity').assertEntityId(novelId);
  return path.join(logsDir(), `${novelId || 'global'}-${dateStr}.jsonl`);
}

function indexPath() {
  return path.join(logsDir(), INDEX_FILE);
}

async function _ensureLogsDir() {
  await fs.mkdir(logsDir(), { recursive: true });
}

async function _readIndex() {
  return readJson(indexPath(), { entries: [] });
}

async function _writeIndex(index) {
  await _ensureLogsDir();
  await writeJson(indexPath(), index);
}

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- network detection ----------

function getNetworkStatus() {
  // In main process we don't have navigator.onLine.
  // We rely on the renderer telling us, or we infer from recent API failures.
  return 'unknown';
}

// ---------- log entry CRUD ----------

async function appendEntry({ type, action, targetId, targetName, payload, networkStatus, novelId, persistence = 'pending', change }) {
  await _ensureLogsDir();
  const entry = {
    id: generateId('offline'),
    schemaVersion: 2, persistence, change,
    timestamp: new Date().toISOString(),
    type: type || 'unknown',
    action: action || 'update',
    targetId: targetId || '',
    targetName: targetName || '',
    payload: payload || {},
    payloadHash: contentHashExact(JSON.stringify(payload || {})),
    networkStatus: networkStatus || 'offline',
    synced: false,
    novelId: novelId || null,
  };
  const date = _todayStr();
  const file = logFilePath(novelId, date);
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(file, line, 'utf8');

  // Update index
  const idx = await _readIndex();
  idx.entries = idx.entries || [];
  idx.entries.push({ id: entry.id, novelId, timestamp: entry.timestamp, synced: false, date });
  await _writeIndex(idx);
  return entry;
}

async function listUnsyncedEntries(novelId) {
  const idx = await _readIndex();
  const entries = (idx.entries || []).filter((e) => !e.synced && (!novelId || e.novelId === novelId));
  // Read actual payloads from jsonl files
  const result = [];
  for (const e of entries) {
    const file = logFilePath(e.novelId, e.date);
    let found = false;
    try {
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.id === e.id) {
          result.push({ ...obj, synced: e.synced, receipt: e.receipt });
          found = true;
          break;
        }
      }
    } catch (error) { throw new Error(`离线记录无法读取 (${e.id}): ${error.message}`); }
    if (!found) throw new Error(`离线记录载荷缺失 (${e.id})，请保留日志并恢复`);
  }
  return result;
}

async function listUnsyncedByType(novelId) {
  const entries = await listUnsyncedEntries(novelId);
  const byType = {};
  for (const e of entries) {
    byType[e.type] = byType[e.type] || [];
    byType[e.type].push(e);
  }
  return byType;
}

async function markSynced(entryIds, receipts = {}) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) return;
  const idx = await _readIndex();
  const idSet = new Set(entryIds);
  for (const e of idx.entries || []) {
    if (idSet.has(e.id)) {
      const receipt = receipts[e.id] || e.receipt;
      if (!receipt) throw new Error('each offline entry requires a host commit receipt');
      e.synced = true; e.receipt = receipt;
    }
  }
  await _writeIndex(idx);
}

async function discardUnsynced(novelId) {
  const idx = await _readIndex();
  const toRemove = (idx.entries || []).filter((e) => !e.synced && (!novelId || e.novelId === novelId));
  const idSet = new Set(toRemove.map((e) => e.id));
  idx.entries = (idx.entries || []).filter((e) => !idSet.has(e.id));
  await _writeIndex(idx);
  // Also remove from jsonl files is tricky; we just leave orphaned lines.
  return { discarded: toRemove.length };
}

// ---------- storage quota ----------

async function getStorageStats() {
  const dir = logsDir();
  let totalBytes = 0;
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.jsonl') && f !== INDEX_FILE) continue;
      const stat = await fs.stat(path.join(dir, f));
      totalBytes += stat.size;
    }
  } catch { /* ignore */ }
  return { totalBytes };
}

async function enforceQuota(maxBytes) {
  if (!maxBytes || maxBytes <= 0) return { deleted: 0 };
  const targetBytes = Math.floor(maxBytes * 0.9);
  let stats = await getStorageStats();
  if (stats.totalBytes <= targetBytes) return { deleted: 0 };

  let deleted = 0;
  // Get all jsonl files sorted by date (oldest first)
  const dir = logsDir();
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch { return { deleted: 0 }; }

  const jsonlFiles = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const stat = await fs.stat(path.join(dir, f));
      jsonlFiles.push({ name: f, size: stat.size, mtime: stat.mtime });
    } catch { /* ignore */ }
  }
  jsonlFiles.sort((a, b) => a.mtime - b.mtime);

  const index = await _readIndex();
  const pendingFiles = new Set((index.entries || []).filter((entry) => !entry.synced).map((entry) => path.basename(logFilePath(entry.novelId, entry.date))));
  for (const f of jsonlFiles) {
    if (pendingFiles.has(f.name)) continue;
    if (stats.totalBytes <= targetBytes) break;
    try {
      await fs.unlink(path.join(dir, f.name));
      stats.totalBytes -= f.size;
      deleted += 1;
    } catch { /* ignore */ }
  }
  return { deleted };
}


// Local IPC logs describe operations already committed to this same disk. They
// are acknowledged without executing them a second time. Legacy summaries lack
// that proof and must never become overwrite payloads.
const { ResourceLockService } = require('../mcp/resourceLockService');
const syncLocks = new ResourceLockService();
async function applyOfflineResource(root, change, content) {
  const data = require('./novelData');
  const { parseResourceRef } = require('../mcp/novelResources');
  const { outlineChapterPath } = require('./paths');
  const ref = parseResourceRef(change.resourceRef);
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (change.mode === 'delete') {
    if (ref.kind === 'character') return data.deleteCharacter(root, ref.key);
    if (ref.kind === 'chapter') return data.deleteChapter(root, ref.key, { confirmed: true });
    if (ref.kind === 'asset') return data.deleteAsset(root, ref.key);
    if (ref.kind === 'timeline-event') return data.replaceTimeline(root, (await data.listTimeline(root)).filter((e) => String(e.id) !== ref.key));
    if (ref.kind === 'outline' && ref.key === 'chapter') return require('./projectTransactions').writeFile(outlineChapterPath(root, ref.volumeIndex, ref.sectionIndex, ref.chapterIndex), null);
    throw new Error(`unsupported offline deletion: ${change.resourceRef}`);
  }
  if (ref.kind === 'character') return data.writeCharacter(root, JSON.parse(text));
  if (ref.kind === 'chapter') {
    let previous = { content: '', metadata: {} };
    try { previous = await data.readChapterWithMeta(root, ref.key); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return data.writeChapterWithMeta(root, ref.key, text, previous.metadata || {}, { baseContent: previous.content });
  }
  if (ref.kind === 'style') return data.writeStyleMemory(root, text);
  if (ref.kind === 'world') return data.writeWorld(root, ref.key === 'lore' ? { lore: text } : { places: JSON.parse(text) });
  if (ref.kind === 'asset') return data.upsertAsset(root, JSON.parse(text));
  if (ref.kind === 'timeline') return data.replaceTimeline(root, JSON.parse(text));
  if (ref.kind === 'timeline-event') {
    const events = await data.listTimeline(root), index = events.findIndex((e) => String(e.id) === ref.key);
    if (index < 0) events.push(JSON.parse(text)); else events[index] = JSON.parse(text);
    return data.replaceTimeline(root, events);
  }
  if (ref.kind === 'outline' && ref.key === 'nodes') return data.writeOutlineNodes(root, JSON.parse(text));
  if (ref.kind === 'outline' && ref.key === 'hierarchy') return data.writeHierarchicalOutline(root, JSON.parse(text));
  if (ref.kind === 'outline' && ref.key === 'master') return require('./projectTransactions').writeFile(path.join(root, 'outlines', 'outline.md'), text);
  if (ref.kind === 'outline' && ref.key === 'chapter') return require('./projectTransactions').writeFile(outlineChapterPath(root, ref.volumeIndex, ref.sectionIndex, ref.chapterIndex), text);
  throw new Error(`unsupported offline resource: ${change.resourceRef}`);
}
async function syncEntry(novelId, entryId) {
  if (!novelId) throw new Error('offline sync requires a bound novel');
  return syncLocks.withLocks(['offline-index'], async () => {
    const index = await _readIndex();
    const indexed = (index.entries || []).find((entry) => entry.id === entryId);
    if (!indexed || indexed.novelId !== novelId) throw new Error('offline entry belongs to another novel');
    if (indexed.synced) return indexed.receipt;
    const entry = (await listUnsyncedEntries(novelId)).find((entry) => entry.id === entryId);
    if (!entry || entry.schemaVersion !== 2) throw new Error('旧离线记录缺少完整数据或保存凭证，请审阅，禁止自动覆盖');
    let receipt;
    if (entry.persistence === 'local_committed') {
      receipt = { entryId, novelId, status: 'already_saved_locally', payloadHash: entry.payloadHash, acknowledgedAt: new Date().toISOString() };
    } else {
      const change = entry.change;
      if (!change || !['create', 'replace', 'delete', 'patch'].includes(change.mode) || !change.resourceRef || !change.baseHash) {
        throw new Error(`unsupported or incomplete offline operation: ${entry.type}/${entry.action}`);
      }
      const prefix = { character: 'character:', chapter: 'chapter:', world: 'world:', style: 'style:', timeline: 'timeline:', outline: 'outline:', asset: 'asset:' }[entry.type];
      if (!prefix || !change.resourceRef.startsWith(prefix)) throw new Error('offline operation target/type mismatch');
      const novels = require('./novels');
      const target = await novels.getNovelById(novelId);
      if (!target) throw new Error('offline target novel is missing');
      // Logical offline changes use the same domain stores inside the shared
      // project transaction. They do not enter the independent writing queue.
      const { hash } = require('../codex-runtime/contracts');
      const { prepareChanges } = require('../mcp/mutationService');
      receipt = await require('./projectTransactions').transaction(target.dir, async () => {
        const prepared = await prepareChanges(target, { reason: `offline ${entryId}`, changes: [change] });
        const candidate = prepared.resources[0];
        indexed.expectedHash = candidate.afterHash;
        await _writeIndex(index);
        await applyOfflineResource(target.dir, change, candidate.after);
        const current = await require('../mcp/novelResources').readResource(target, change.resourceRef).catch((error) => {
          if (change.mode === 'delete' && ['ENOENT', 'context_incomplete'].includes(error.code)) return { sourceHash: hash(null) };
          throw error;
        });
        if (current.sourceHash !== candidate.afterHash) throw new Error('offline storage readback mismatch');
        return { entryId, novelId, status: 'committed', resourceRef: change.resourceRef, afterHash: candidate.afterHash };
      }, { id: `offline-${entryId}`, fingerprint: hash(change) });
    }
    await markSynced([entryId], { [entryId]: receipt });
    return receipt;
  });
}

module.exports = {
  syncEntry,
  appendEntry: (entry) => syncLocks.withLocks(['offline-index'], () => appendEntry(entry)),
  listUnsyncedEntries,
  listUnsyncedByType,
  markSynced: (ids) => syncLocks.withLocks(['offline-index'], () => markSynced(ids)),
  discardUnsynced: (id) => syncLocks.withLocks(['offline-index'], () => discardUnsynced(id)),
  getStorageStats,
  enforceQuota: (quota) => syncLocks.withLocks(['offline-index'], () => enforceQuota(quota)),
};
