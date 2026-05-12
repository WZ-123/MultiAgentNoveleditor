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
const { readJson, writeJson } = require('./jsonStore');

const LOGS_DIR = 'offline-logs';
const INDEX_FILE = 'index.json';

function logsDir() {
  return path.join(paths().root, LOGS_DIR);
}

function logFilePath(novelId, dateStr) {
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

async function appendEntry({ type, action, targetId, targetName, payload, networkStatus, novelId }) {
  await _ensureLogsDir();
  const entry = {
    id: generateId('offline'),
    timestamp: new Date().toISOString(),
    type: type || 'unknown',
    action: action || 'update',
    targetId: targetId || '',
    targetName: targetName || '',
    payload: payload || {},
    networkStatus: networkStatus || 'offline',
    synced: false,
    novelId: novelId || null,
  };
  const file = logFilePath(novelId, _todayStr());
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(file, line, 'utf8');

  // Update index
  const idx = await _readIndex();
  idx.entries = idx.entries || [];
  idx.entries.push({ id: entry.id, novelId, timestamp: entry.timestamp, synced: false, date: _todayStr() });
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
    try {
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.id === e.id) {
          result.push(obj);
          break;
        }
      }
    } catch { /* ignore missing file */ }
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

async function markSynced(entryIds) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) return;
  const idx = await _readIndex();
  const idSet = new Set(entryIds);
  for (const e of idx.entries || []) {
    if (idSet.has(e.id)) e.synced = true;
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

  for (const f of jsonlFiles) {
    if (stats.totalBytes <= targetBytes) break;
    try {
      await fs.unlink(path.join(dir, f.name));
      stats.totalBytes -= f.size;
      deleted += 1;
    } catch { /* ignore */ }
  }
  return { deleted };
}

module.exports = {
  appendEntry,
  listUnsyncedEntries,
  listUnsyncedByType,
  markSynced,
  discardUnsynced,
  getStorageStats,
  enforceQuota,
};
