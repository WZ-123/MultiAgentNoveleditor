'use strict';

/**
 * Chat History Store — persistent conversation records for the AI chat panel.
 *
 * Each conversation is a "thread" with:
 *   id, title, createdAt, updatedAt, messages[], currentNodeId
 *
 * Messages are stored as a DAG (directed acyclic graph) to support branching
 * from any point (revert from a node):
 *   Each message has: id, parentId, role, text, timestamp, edited?, toolCalls?
 *
 * The "current branch" is the path from root to currentNodeId.
 *
 * Storage layout:
 *   <userData>/chat-threads/<threadId>.json
 *   <userData>/chat-threads/index.json — list of all threads with metadata
 */

const fs = require('node:fs').promises;
const path = require('node:path');
const { paths, generateId } = require('./paths');
const { readJson, writeJson } = require('./jsonStore');
const clientEvents = require('../runtime/clientEvents');

const THREADS_DIR = 'chat-threads';
const INDEX_FILE = 'index.json';
const changeListeners = new Set();

function threadsDir() {
  return path.join(paths().root, THREADS_DIR);
}

function threadPath(threadId) {
  return path.join(threadsDir(), `${threadId}.json`);
}

function indexPath() {
  return path.join(threadsDir(), INDEX_FILE);
}

async function _ensureThreadsDir() {
  await fs.mkdir(threadsDir(), { recursive: true });
}

async function _readIndex() {
  return readJson(indexPath(), { threads: [] });
}

async function _writeIndex(index) {
  await _ensureThreadsDir();
  await writeJson(indexPath(), index);
}

function _emitChange(event) {
  const payload = {
    type: event.type,
    threadId: event.threadId || event.thread?.id || null,
    novelId: event.thread?.novelId ?? event.novelId ?? null,
    messageId: event.messageId || event.message?.id || null,
    title: event.thread?.title || event.title || null,
    updatedAt: event.thread?.updatedAt || event.updatedAt || new Date().toISOString(),
  };
  try {
    clientEvents.emit('chatHistory:changed', payload);
  } catch {
    // Non-critical: local store subscribers still run below.
  }
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send('chatHistory:changed', payload); } catch {}
    }
  } catch {
    // Non-Electron tests can still use local subscribers.
  }
  for (const listener of changeListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

// ---------- thread CRUD ----------

async function listThreads(novelId) {
  const idx = await _readIndex();
  let threads = idx.threads || [];
  if (novelId !== undefined) {
    threads = threads.filter((t) => t.novelId === novelId || (!t.novelId && !novelId));
  }
  return threads.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function createThread({ title, novelId, maxBytes } = {}) {
  await _ensureThreadsDir();
  // Enforce quota before creating if a maxBytes is provided
  if (maxBytes && maxBytes > 0) {
    await enforceQuota(maxBytes);
  }
  const threadId = generateId('thread');
  const now = new Date().toISOString();
  const thread = {
    id: threadId,
    title: title || '新对话',
    novelId: novelId || null,
    createdAt: now,
    updatedAt: now,
    messages: [],
    currentNodeId: null,
  };
  await writeJson(threadPath(threadId), thread);
  const idx = await _readIndex();
  idx.threads = idx.threads || [];
  idx.threads.push({ id: threadId, title: thread.title, novelId: thread.novelId, createdAt: now, updatedAt: now });
  await _writeIndex(idx);
  _emitChange({ type: 'create', threadId, thread });
  return thread;
}

async function getThread(threadId) {
  if (!threadId) return null;
  return readJson(threadPath(threadId), null);
}

async function deleteThread(threadId) {
  if (!threadId) return;
  try {
    await fs.unlink(threadPath(threadId));
  } catch { /* ignore */ }
  const idx = await _readIndex();
  idx.threads = (idx.threads || []).filter((t) => t.id !== threadId);
  await _writeIndex(idx);
  _emitChange({ type: 'delete', threadId });
}

async function renameThread(threadId, title) {
  const thread = await getThread(threadId);
  if (!thread) return null;
  thread.title = title || thread.title;
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(threadId), thread);
  const idx = await _readIndex();
  const entry = (idx.threads || []).find((t) => t.id === threadId);
  if (entry) {
    entry.title = thread.title;
    entry.updatedAt = thread.updatedAt;
    await _writeIndex(idx);
  }
  _emitChange({ type: 'rename', threadId, thread });
  return thread;
}

// ---------- message operations (DAG) ----------

function createMessage({ role, text, parentId, toolCalls }) {
  return {
    id: generateId('msg'),
    parentId: parentId || null,
    role,
    text: text || '',
    timestamp: Date.now(),
    edited: false,
    toolCalls: toolCalls || null,
  };
}

async function appendMessage(threadId, message) {
  const thread = await getThread(threadId);
  if (!thread) return null;
  thread.messages = thread.messages || [];
  // Auto-link to previous message so getBranch() can reconstruct full chain
  if (message.parentId === undefined && thread.messages.length > 0) {
    const prev = thread.messages[thread.messages.length - 1];
    message.parentId = prev.id;
  }
  thread.messages.push(message);
  thread.currentNodeId = message.id;
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(threadId), thread);
  // Update index
  const idx = await _readIndex();
  const entry = (idx.threads || []).find((t) => t.id === threadId);
  if (entry) {
    entry.updatedAt = thread.updatedAt;
    await _writeIndex(idx);
  }
  _emitChange({ type: 'append', threadId, message, thread });
  return thread;
}

async function editMessage(threadId, messageId, newText) {
  const thread = await getThread(threadId);
  if (!thread) return null;
  const msg = (thread.messages || []).find((m) => m.id === messageId);
  if (!msg) return null;
  msg.text = newText;
  msg.edited = true;
  msg.editedAt = new Date().toISOString();
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(threadId), thread);
  _emitChange({ type: 'edit', threadId, messageId, thread });
  return thread;
}

/**
 * Revert to just before a message node: the target message and all of its
 * descendants are removed. The thread's currentNodeId is set to the target's
 * parent, or null when reverting before the root message.
 */
async function revertToNode(threadId, messageId) {
  const thread = await getThread(threadId);
  if (!thread) return null;
  const messages = thread.messages || [];
  const target = messages.find((m) => m.id === messageId);
  if (!target) return null;

  // Build set of ancestor IDs from root to the target's parent.
  const keepIds = new Set();
  let cur = target.parentId ? messages.find((m) => m.id === target.parentId) : null;
  while (cur) {
    keepIds.add(cur.id);
    cur = cur.parentId ? messages.find((m) => m.id === cur.parentId) : null;
  }

  thread.messages = messages.filter((m) => keepIds.has(m.id));
  thread.currentNodeId = target.parentId || null;
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(threadId), thread);
  _emitChange({ type: 'revert', threadId, messageId, thread });
  return thread;
}

/**
 * Get the current branch: messages from root to currentNodeId.
 */
function getBranch(thread) {
  if (!thread || !thread.messages) return [];
  const msgs = thread.messages;
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const current = thread.currentNodeId
    ? byId.get(thread.currentNodeId)
    : msgs[msgs.length - 1];
  if (!current) return [];

  const branch = [];
  let cur = current;
  while (cur) {
    branch.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return branch;
}

async function updateThreadNovelId(threadId, novelId) {
  const thread = await getThread(threadId);
  if (!thread) return null;
  thread.novelId = novelId || null;
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(threadId), thread);
  const idx = await _readIndex();
  const entry = (idx.threads || []).find((t) => t.id === threadId);
  if (entry) {
    entry.novelId = thread.novelId;
    entry.updatedAt = thread.updatedAt;
    await _writeIndex(idx);
  }
  _emitChange({ type: 'move', threadId, novelId: thread.novelId, thread });
  return thread;
}

// ---------- storage quota management ----------

async function getStorageStats() {
  const dir = threadsDir();
  let totalBytes = 0;
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const stat = await fs.stat(path.join(dir, f));
      totalBytes += stat.size;
    }
  } catch {
    // dir may not exist yet
  }
  return { totalBytes, threadCount: (await listThreads()).length };
}

async function enforceQuota(maxBytes) {
  if (!maxBytes || maxBytes <= 0) return { deleted: 0 };
  const targetBytes = Math.floor(maxBytes * 0.9);
  let stats = await getStorageStats();
  if (stats.totalBytes <= targetBytes) return { deleted: 0 };

  let deleted = 0;
  const threads = await listThreads();
  // Oldest first (listThreads returns newest first, so reverse)
  const oldestFirst = [...threads].reverse();

  for (const t of oldestFirst) {
    if (stats.totalBytes <= targetBytes) break;
    try {
      const p = threadPath(t.id);
      const stat = await fs.stat(p);
      await fs.unlink(p);
      stats.totalBytes -= stat.size;
      deleted += 1;
      // Remove from index
      const idx = await _readIndex();
      idx.threads = (idx.threads || []).filter((entry) => entry.id !== t.id);
      await _writeIndex(idx);
    } catch { /* ignore */ }
  }
  return { deleted };
}

module.exports = {
  listThreads,
  createThread,
  getThread,
  deleteThread,
  renameThread,
  appendMessage,
  editMessage,
  revertToNode,
  getBranch,
  updateThreadNovelId,
  createMessage,
  getStorageStats,
  enforceQuota,
  subscribe,
};
