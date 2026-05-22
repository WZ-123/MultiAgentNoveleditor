'use strict';

/**
 * In-process MCP-shaped client.
 *
 * Exposes the same surface as a "real" MCP client (`listTools`, `callTool`) but
 * runs the tool handlers directly inside the main process. This keeps the
 * runSubagent contract identical to a future stdio-based MCP server (Phase 4
 * upgrade path) while avoiding subprocess overhead in Phase 2.
 *
 * Active novel context is set via setActiveNovel(novelId).
 */

const { TOOLS, getToolByName } = require('./tools');
const novelsStore = require('../store/novels');
const { novelPaths } = require('../store/paths');
const eventBus = require('../runtime/eventBus');

let activeNovelId = null;

function _notifyChapterChanged(name, action, title) {
  if (!name) return;
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send('mana:chapter:changed', { name, action, title: title || null }); } catch {}
    }
  } catch {
    // ignore renderer sync failures
  }
}

function _readTextPayload(result) {
  const block = (result?.content || []).find((item) => item?.type === 'text' && typeof item.text === 'string');
  if (!block?.text) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return null;
  }
}

function setActiveNovel(id) { activeNovelId = id || null; }
function getActiveNovel() { return activeNovelId; }

async function buildCtx() {
  if (!activeNovelId) return { novelDir: null, paths: null, novel: null };
  try {
    const entry = await novelsStore.getNovelById(activeNovelId);
    if (!entry) return { novelDir: null, paths: null, novel: null };
    return { novelDir: entry.dir, paths: novelPaths(entry.dir), novel: entry };
  } catch {
    return { novelDir: null, paths: null, novel: null };
  }
}

function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: 'object' },
    requiresConfirmation: !!t.requiresConfirmation,
  }));
}

// ---------------- Confirmation registry ----------------

const pendingConfirmations = new Map(); // key=`${runId}:${toolUseId}` -> {resolve, reject, payload}

function _confirmKey(runId, toolUseId) { return `${runId}:${toolUseId}`; }

/**
 * Called by IPC when user accepts/denies a pending tool call.
 * decision: { accept: boolean, patch?: object } — patch can override args before run
 */
function resolveConfirmation(runId, toolUseId, decision) {
  const key = _confirmKey(runId, toolUseId);
  const pending = pendingConfirmations.get(key);
  if (!pending) return false;
  pendingConfirmations.delete(key);
  pending.resolve(decision || { accept: false });
  return true;
}

function listPendingConfirmations() {
  return Array.from(pendingConfirmations.entries()).map(([key, v]) => ({ key, ...v.payload }));
}

async function _awaitConfirmation({ runId, toolUseId, payload }) {
  const key = _confirmKey(runId, toolUseId);
  return new Promise((resolve, reject) => {
    pendingConfirmations.set(key, { resolve, reject, payload });
    // emit event for UI
    eventBus.emit({
      runId,
      kind: 'awaiting_confirmation',
      data: { toolUseId, ...payload },
    }).catch(() => { /* ignore */ });
  });
}

// ---------------- Tool dispatch ----------------

async function callTool(opts) {
  const { name, arguments: args, runId, toolUseId, subagentId, nodeId, autoConfirm } = opts || {};
  const tool = getToolByName(name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }

  let finalArgs = args || {};

  if (tool.requiresConfirmation && !autoConfirm) {
    const tuid = toolUseId || `tu-${Date.now()}`;
    const decision = await _awaitConfirmation({
      runId,
      toolUseId: tuid,
      payload: { tool: name, arguments: finalArgs, subagentId, nodeId },
    });
    if (!decision?.accept) {
      return {
        isError: true,
        content: [{ type: 'text', text: `User rejected tool call: ${name}` }],
      };
    }
    if (decision.patch && typeof decision.patch === 'object') {
      finalArgs = { ...finalArgs, ...decision.patch };
    }
  }

  const ctx = await buildCtx();

  await eventBus.emit({
    runId,
    nodeId,
    subagentId,
    kind: 'tool_use',
    data: { name, arguments: finalArgs, toolUseId },
  });

  try {
    const result = await tool.handler(finalArgs, { ...ctx, runId, subagentId });
    const payload = _readTextPayload(result) || {};
    if (!result?.isError && name === 'write_chapter') {
      _notifyChapterChanged(payload.name || finalArgs?.name, 'created', finalArgs?.title || payload.title || null);
    }
    if (!result?.isError && (name === 'replace_chapter_text' || name === 'apply_chapter_patch')) {
      _notifyChapterChanged(payload.name || finalArgs?.name, 'updated', finalArgs?.title || payload.title || null);
    }
    return result;
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err.message || String(err) }],
    };
  }
}

module.exports = {
  listTools,
  callTool,
  setActiveNovel,
  getActiveNovel,
  resolveConfirmation,
  listPendingConfirmations,
};
