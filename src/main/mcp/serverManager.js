'use strict';

/**
 * MCP server lifecycle manager.
 *
 * Owns:
 *   - the forked child process running ./server.js (long-lived, lazy-started)
 *   - the SDK MCP Client connected over stdin/stdout via ForkChildTransport
 *   - the parent-side control IPC bridge (set-active-novel / confirm-request /
 *     confirm-response / shutdown)
 *
 * This module is what `mcpClientStdio.js` calls into; it intentionally has the
 * same shape as `mcp/client.js` for the Phase 5 → 6 swap.
 *
 * Crash recovery: if the child exits unexpectedly, the next `listTools()` /
 * `callTool()` re-spawns it. In-flight confirmation promises are rejected
 * (-> isError tool result) when the child dies.
 */

const path = require('node:path');
const { fork } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { ForkChildTransport } = require('./forkChildTransport');
const { paths } = require('../store/paths');
const eventBus = require('../runtime/eventBus');

let child = null;
let client = null;
let starting = null; // Promise dedup for concurrent ensureServer()
let activeNovel = { id: null, dir: null };

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

function _notifyChapterMutation(name, args, result) {
  if (result?.isError) return;
  const payload = _readTextPayload(result) || {};
  if (name === 'write_chapter') {
    _notifyChapterChanged(payload.name || args?.name, 'created', args?.title || payload.title || null);
  }
  if (name === 'replace_chapter_text') {
    _notifyChapterChanged(payload.name || args?.name, 'updated', args?.title || payload.title || null);
  }
}

// pending[`${runId}:${toolUseId}`] = serverConfirmId  (populated when child sends confirm-request)
const pendingByToolUseId = new Map();
// pending[serverConfirmId] = { runId, toolUseId, name, arguments, subagentId, nodeId, ts }
const pendingByServerId = new Map();

function _resolveEntryScript() {
  // Prefer the asar-unpacked root entry (same file external drivers will use).
  const root = path.resolve(__dirname, '..', '..', '..');
  const rootEntry = path.join(root, 'mcp-server-entry.js');
  // Use the in-repo one in dev (since asar-unpack only matters in packaged builds).
  return rootEntry;
}

function _resolveUserDataRoot() {
  try {
    return paths().root;
  } catch {
    return null;
  }
}

function _spawnChild() {
  const entry = _resolveEntryScript();
  const userDataRoot = _resolveUserDataRoot();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (userDataRoot) env.MANA_USER_DATA_ROOT = userDataRoot;

  const proc = fork(entry, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env,
  });

  proc.on('error', (err) => {
    console.error('[mcp/serverManager] child error', err);
  });
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[mcp/serverManager] child exited code=${code} signal=${signal || ''}`);
    }
    // If we lose the child while there are pending confirmations, reject them.
    for (const [serverId, payload] of pendingByServerId.entries()) {
      try {
        eventBus.emit({
          runId: payload.runId,
          subagentId: payload.subagentId,
          nodeId: payload.nodeId,
          kind: 'error',
          data: { message: `MCP server child exited with pending confirmation for ${payload.name}` },
        }).catch(() => {});
      } catch { /* ignore */ }
      pendingByServerId.delete(serverId);
    }
    pendingByToolUseId.clear();
    if (child === proc) {
      child = null;
      client = null;
      starting = null;
    }
  });

  // Surface child stderr to console for debugging (do not block on it).
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      try {
        const text = chunk.toString('utf8');
        if (text.trim()) console.error('[mcp/serverManager:child]', text.trimEnd());
      } catch { /* ignore */ }
    });
  }

  proc.on('message', (msg) => _handleChildMessage(msg).catch((err) => {
    console.error('[mcp/serverManager] message handler failed', err);
  }));

  return proc;
}

async function _handleChildMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ready':
      // Acknowledge — nothing to do; ensureServer() awaits client.connect().
      break;
    case 'confirm-request': {
      const { id, name, arguments: args, runId, subagentId, nodeId, toolUseId } = msg;
      const tuid = toolUseId || `tu-stdio-${id}`;
      const key = `${runId || ''}:${tuid}`;
      pendingByServerId.set(id, { runId, toolUseId: tuid, name, arguments: args, subagentId, nodeId, ts: Date.now() });
      pendingByToolUseId.set(key, id);
      try {
        await eventBus.emit({
          runId,
          subagentId,
          nodeId,
          kind: 'awaiting_confirmation',
          data: { toolUseId: tuid, tool: name, arguments: args, subagentId, nodeId },
        });
      } catch (err) {
        console.error('[mcp/serverManager] failed to emit awaiting_confirmation', err);
      }
      break;
    }
    case 'log':
      if (msg.level === 'error') console.error('[mcp/serverManager:child]', msg.message, msg.data || '');
      else console.log('[mcp/serverManager:child]', msg.message, msg.data || '');
      break;
    case 'error':
      console.error('[mcp/serverManager:child error]', msg.message);
      break;
    default:
      break;
  }
}

async function ensureServer() {
  if (client && child && !child.killed) return client;
  if (starting) return starting;
  starting = (async () => {
    child = _spawnChild();
    const transport = new ForkChildTransport({ stdin: child.stdin, stdout: child.stdout });
    const newClient = new Client(
      { name: 'mana-host', version: '1.0.0' },
      { capabilities: {} }
    );
    await newClient.connect(transport);
    client = newClient;
    // Replay active novel context if we had one.
    if (activeNovel.id || activeNovel.dir) {
      // Re-resolve dir from store if it went stale (e.g. child process restart
      // after startup before setActiveNovel was called with a dir).
      if (activeNovel.id && !activeNovel.dir) {
        try {
          const novelsStore = require('../store/novels');
          const entry = await novelsStore.getNovelById(activeNovel.id);
          if (entry?.dir) activeNovel.dir = entry.dir;
        } catch { /* best-effort */ }
      }
      try {
        child.send({ type: 'set-active-novel', novelId: activeNovel.id, novelDir: activeNovel.dir });
      } catch (err) {
        console.error('[mcp/serverManager] replay set-active-novel failed', err);
      }
    }
    starting = null;
    return client;
  })();
  try {
    return await starting;
  } catch (err) {
    starting = null;
    if (child) { try { child.kill(); } catch { /* ignore */ } }
    child = null;
    client = null;
    throw err;
  }
}

// ---------- Public surface ----------

async function setActiveNovel(novelId, novelDir = null) {
  console.error('[mcp/serverManager] setActiveNovel called:', { novelId, novelDir });
  activeNovel = { id: novelId || null, dir: novelDir || null };
  // If a novelId was given but no dir resolved, try the registry.
  if (activeNovel.id && !activeNovel.dir) {
    try {
      const novelsStore = require('../store/novels');
      const entry = await novelsStore.getNovelById(activeNovel.id);
      if (entry?.dir) activeNovel.dir = entry.dir;
    } catch { /* ignore */ }
  }
  if (child && !child.killed) {
    try {
      child.send({ type: 'set-active-novel', novelId: activeNovel.id, novelDir: activeNovel.dir });
    } catch (err) {
      console.error('[mcp/serverManager] set-active-novel send failed', err);
    }
  }
}

function getActiveNovel() { return activeNovel.id; }
function getActiveNovelContext() { return { id: activeNovel.id, dir: activeNovel.dir }; }

async function listTools() {
  const c = await ensureServer();
  const r = await c.listTools();
  return (r?.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: 'object' },
    // requiresConfirmation flag is a server-internal concern; UI does not need it.
  }));
}

/**
 * Same shape as mcp/client.js callTool — returns
 *   { content: [{type:'text', text}], isError?: boolean }
 */
async function callTool({ name, arguments: args, runId, toolUseId, subagentId, nodeId, autoConfirm } = {}) {
  const c = await ensureServer();

  // Emit tool_use up front (matches in-process mcp/client.js behavior).
  try {
    await eventBus.emit({
      runId, nodeId, subagentId,
      kind: 'tool_use',
      data: { name, arguments: args || {}, toolUseId },
    });
  } catch { /* ignore */ }

  try {
    // Inject active novel context on every tool call
    const novelId = activeNovel.id || null;
    const novelDir = activeNovel.dir || null;
    console.error('[mcp/serverManager] callTool injecting:', { name, novelId, novelDir });
    const result = await c.callTool({
      name,
      arguments: args || {},
      _meta: {
        mana_runId: runId || null,
        mana_subagentId: subagentId || null,
        mana_nodeId: nodeId || null,
        mana_toolUseId: toolUseId || null,
        mana_autoConfirm: autoConfirm ? true : undefined,
        mana_activeNovelId: novelId,
        mana_activeNovelDir: novelDir,
      },
    });
    _notifyChapterMutation(name, args || {}, result);
    // Normalize: SDK returns {content, isError?, structuredContent?}
    return { content: result.content || [], isError: !!result.isError };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err?.message || String(err) }],
    };
  }
}

function resolveConfirmation(runId, toolUseId, decision) {
  const key = `${runId || ''}:${toolUseId}`;
  const serverId = pendingByToolUseId.get(key);
  if (!serverId) return false;
  const payload = pendingByServerId.get(serverId);
  pendingByToolUseId.delete(key);
  pendingByServerId.delete(serverId);
  if (!child || child.killed) return false;
  try {
    child.send({
      type: 'confirm-response',
      id: serverId,
      accept: !!decision?.accept,
      patch: decision?.patch || null,
      reason: decision?.reason || null,
    });
    return true;
  } catch (err) {
    console.error('[mcp/serverManager] resolveConfirmation send failed', err);
    if (payload) {
      // Re-queue so UI can retry; but more importantly, log it.
      pendingByServerId.set(serverId, payload);
      pendingByToolUseId.set(key, serverId);
    }
    return false;
  }
}

function listPendingConfirmations() {
  return Array.from(pendingByServerId.values()).map((p) => ({
    key: `${p.runId || ''}:${p.toolUseId}`,
    tool: p.name,
    arguments: p.arguments,
    runId: p.runId,
    toolUseId: p.toolUseId,
    subagentId: p.subagentId,
    nodeId: p.nodeId,
    ts: p.ts,
  }));
}

async function dispose() {
  // Best-effort graceful shutdown of the child.
  if (!child) return;
  try { child.send({ type: 'shutdown' }); } catch { /* ignore */ }
  const dying = child;
  child = null;
  client = null;
  starting = null;
  setTimeout(() => {
    try { dying.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { dying.kill('SIGKILL'); } catch { /* ignore */ }
    }, 1500).unref?.();
  }, 200).unref?.();
}

module.exports = {
  ensureServer,
  setActiveNovel,
  getActiveNovel,
  getActiveNovelContext,
  listTools,
  callTool,
  resolveConfirmation,
  listPendingConfirmations,
  dispose,
};
