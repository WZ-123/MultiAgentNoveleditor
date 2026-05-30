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
const fs = require('node:fs');
const net = require('node:net');
const { fork } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { ForkChildTransport } = require('./forkChildTransport');
const { paths } = require('../store/paths');
const eventBus = require('../runtime/eventBus');
const pkg = require('../../../package.json');

let child = null;
let client = null;
let starting = null; // Promise dedup for concurrent ensureServer()
let activeNovel = { id: null, dir: null };
let childServerToken = null;
let childProviderToken = null;
let childRestartToken = null;

function _isPackagedRuntime() {
  try {
    const { app } = require('electron');
    return !!app?.isPackaged;
  } catch {
    return false;
  }
}

function _walkLatestSourceMtime(targetPath) {
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return 0;
  }

  if (stat.isFile()) {
    return /\.(?:js|mjs|cjs|json)$/i.test(targetPath) ? stat.mtimeMs : 0;
  }
  if (!stat.isDirectory()) return 0;

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    latest = Math.max(latest, _walkLatestSourceMtime(path.join(targetPath, entry.name)));
  }
  return latest;
}

function _computeServerToken() {
  const forced = process.env.MANA_TEST_MCP_SERVER_TOKEN;
  if (forced) return `forced:${forced}`;
  if (_isPackagedRuntime()) return `pkg:${pkg.version}`;

  const root = path.resolve(__dirname, '..', '..', '..');
  const latest = Math.max(
    _walkLatestSourceMtime(path.join(root, 'mcp-server-entry.js')),
    _walkLatestSourceMtime(path.join(root, 'src', 'main')),
    _walkLatestSourceMtime(path.join(root, 'src', 'services'))
  );
  return `src:${Math.trunc(latest)}`;
}

function _computeProviderToken() {
  try {
    const providerManager = require('../providerManager');
    if (typeof providerManager.getProviderStateTokenSync === 'function') {
      return providerManager.getProviderStateTokenSync();
    }
  } catch {
    // fall through
  }
  return 'providers:unknown';
}

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
  if (name === 'replace_chapter_text' || name === 'apply_chapter_patch') {
    _notifyChapterChanged(payload.name || args?.name, 'updated', args?.title || payload.title || null);
  }
}

// pending[`${runId}:${toolUseId}`] = serverConfirmId  (populated when child sends confirm-request)
const pendingByToolUseId = new Map();
// pending[serverConfirmId] = { runId, toolUseId, name, arguments, subagentId, nodeId, ts }
const pendingByServerId = new Map();

let confirmationRelayServer = null;
let confirmationRelayPort = null;
let confirmationRelayStarting = null;

function _confirmationKey(runId, toolUseId) {
  return `${runId || ''}:${toolUseId}`;
}

function _removePendingConfirmation(serverId) {
  const payload = pendingByServerId.get(serverId);
  if (!payload) return null;
  pendingByServerId.delete(serverId);
  pendingByToolUseId.delete(_confirmationKey(payload.runId, payload.toolUseId));
  return payload;
}

async function _emitAwaitingConfirmation(payload) {
  try {
    await eventBus.emit({
      runId: payload.runId,
      subagentId: payload.subagentId,
      nodeId: payload.nodeId,
      kind: 'awaiting_confirmation',
      data: {
        toolUseId: payload.toolUseId,
        tool: payload.name,
        arguments: payload.arguments,
        subagentId: payload.subagentId,
        nodeId: payload.nodeId,
      },
    });
  } catch (err) {
    console.error('[mcp/serverManager] failed to emit awaiting_confirmation', err);
  }
}

async function _registerPendingConfirmation({ id, name, arguments: args, runId, subagentId, nodeId, toolUseId, respond }) {
  const resolvedToolUseId = toolUseId || `tu-stdio-${id}`;
  const payload = {
    runId,
    toolUseId: resolvedToolUseId,
    name,
    arguments: args,
    subagentId,
    nodeId,
    ts: Date.now(),
    respond,
  };
  pendingByServerId.set(id, payload);
  pendingByToolUseId.set(_confirmationKey(runId, resolvedToolUseId), id);
  await _emitAwaitingConfirmation(payload);
  return payload;
}

function _writeSocketMessage(socket, message) {
  socket.write(JSON.stringify(message) + '\n');
}

function _handleConfirmationRelaySocket(socket) {
  socket.setEncoding('utf8');
  let buffer = '';
  let pendingServerId = null;

  const clearPending = () => {
    if (!pendingServerId) return;
    _removePendingConfirmation(pendingServerId);
    pendingServerId = null;
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        _writeSocketMessage(socket, { type: 'error', message: 'invalid JSON' });
        socket.end();
        clearPending();
        return;
      }

      if (msg.type !== 'confirm-request' || !msg.id) {
        _writeSocketMessage(socket, { type: 'error', message: 'invalid confirmation request' });
        socket.end();
        clearPending();
        return;
      }

      pendingServerId = msg.id;
      _registerPendingConfirmation({
        id: msg.id,
        name: msg.name,
        arguments: msg.arguments,
        runId: msg.runId,
        subagentId: msg.subagentId,
        nodeId: msg.nodeId,
        toolUseId: msg.toolUseId,
        respond: (decision) => {
          _writeSocketMessage(socket, {
            type: 'confirm-response',
            id: msg.id,
            accept: !!decision?.accept,
            patch: (decision?.patch && typeof decision.patch === 'object') ? decision.patch : null,
            reason: decision?.reason || null,
          });
          socket.end();
          pendingServerId = null;
        },
      }).catch((err) => {
        console.error('[mcp/serverManager] relay confirm registration failed', err);
        _writeSocketMessage(socket, { type: 'error', message: err?.message || String(err) });
        socket.end();
        clearPending();
      });
    }
  });

  socket.on('close', () => {
    clearPending();
  });
  socket.on('error', () => {
    clearPending();
  });
}

async function ensureConfirmationRelay() {
  if (confirmationRelayServer && confirmationRelayPort) {
    return { port: confirmationRelayPort };
  }
  if (confirmationRelayStarting) return confirmationRelayStarting;

  confirmationRelayStarting = new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      _handleConfirmationRelaySocket(socket);
    });
    const onError = (err) => {
      server.off('listening', onListening);
      confirmationRelayStarting = null;
      if (confirmationRelayServer === server) {
        confirmationRelayServer = null;
        confirmationRelayPort = null;
      }
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      confirmationRelayServer = server;
      confirmationRelayPort = server.address()?.port || null;
      confirmationRelayStarting = null;
      server.on('close', () => {
        if (confirmationRelayServer === server) {
          confirmationRelayServer = null;
          confirmationRelayPort = null;
        }
      });
      resolve({ port: confirmationRelayPort });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  return confirmationRelayStarting;
}

function _resolveEntryScript() {
  // Prefer the asar-unpacked root entry (same file external drivers will use).
  const root = path.resolve(__dirname, '..', '..', '..');
  const rootEntry = path.join(root, 'mcp-server-entry.js');
  // In a packaged build, `__dirname` points inside `app.asar/...`, but
  // `mcp-server-entry.js` is asar-unpacked to `app.asar.unpacked/`.
  // Replace `.asar/` or `.asar\` with `.asar.unpacked/` (or `\`).
  if (rootEntry.includes('.asar') && !rootEntry.includes('.asar.unpacked')) {
    const unpacked = rootEntry.replace(/\.asar([\\/])/, '.asar.unpacked$1');
    try {
      const fs = require('node:fs');
      if (fs.existsSync(unpacked)) return unpacked;
    } catch { /* fall through to original path */ }
  }
  return rootEntry;
}

function _resolveUserDataRoot() {
  try {
    return paths().root;
  } catch {
    return null;
  }
}

function _spawnChild(serverToken) {
  const entry = _resolveEntryScript();
  const userDataRoot = _resolveUserDataRoot();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MANA_MCP_SERVER_TOKEN: serverToken,
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
      childServerToken = null;
      childProviderToken = null;
      childRestartToken = null;
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
      await _registerPendingConfirmation({
        id,
        name,
        arguments: args,
        runId,
        subagentId,
        nodeId,
        toolUseId,
        respond: (decision) => {
          if (!child || child.killed) throw new Error('MCP child unavailable');
          child.send({
            type: 'confirm-response',
            id,
            accept: !!decision?.accept,
            patch: decision?.patch || null,
            reason: decision?.reason || null,
          });
        },
      });
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
  const currentServerToken = _computeServerToken();
  const currentProviderToken = _computeProviderToken();
  const currentRestartToken = `${currentServerToken}|${currentProviderToken}`;

  if (client && child && !child.killed && childRestartToken === currentRestartToken) return client;
  if (child && !child.killed && childRestartToken !== currentRestartToken) {
    const reason = {};
    if (childServerToken !== currentServerToken) {
      reason.serverToken = { from: childServerToken, to: currentServerToken };
    }
    if (childProviderToken !== currentProviderToken) {
      reason.providerToken = { from: childProviderToken, to: currentProviderToken };
    }
    console.error('[mcp/serverManager] restart token changed, restarting MCP child', reason);
    await dispose();
  }
  if (starting) return starting;
  starting = (async () => {
    child = _spawnChild(currentServerToken);
    childServerToken = currentServerToken;
    childProviderToken = currentProviderToken;
    childRestartToken = currentRestartToken;
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
    childServerToken = null;
    childProviderToken = null;
    childRestartToken = null;
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
  const key = _confirmationKey(runId, toolUseId);
  const serverId = pendingByToolUseId.get(key);
  if (!serverId) return false;
  const payload = _removePendingConfirmation(serverId);
  if (!payload?.respond) return false;
  try {
    payload.respond({
      accept: !!decision?.accept,
      patch: decision?.patch || null,
      reason: decision?.reason || null,
    });
    return true;
  } catch (err) {
    console.error('[mcp/serverManager] resolveConfirmation send failed', err);
    if (payload) {
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
  if (confirmationRelayServer) {
    const relay = confirmationRelayServer;
    confirmationRelayServer = null;
    confirmationRelayPort = null;
    confirmationRelayStarting = null;
    await new Promise((resolve) => {
      try { relay.close(() => resolve()); } catch { resolve(); }
    });
  }
  // Best-effort graceful shutdown of the child.
  if (!child) return;
  try { child.send({ type: 'shutdown' }); } catch { /* ignore */ }
  const dying = child;
  child = null;
  client = null;
  starting = null;
  childServerToken = null;
  childProviderToken = null;
  childRestartToken = null;
  setTimeout(() => {
    const sig = process.platform === 'win32' ? undefined : 'SIGTERM';
    try { dying.kill(sig); } catch { /* ignore */ }
    setTimeout(() => {
      const sigKill = process.platform === 'win32' ? undefined : 'SIGKILL';
      try { dying.kill(sigKill); } catch { /* ignore */ }
    }, 1500).unref?.();
  }, 200).unref?.();
}

module.exports = {
  ensureServer,
  ensureConfirmationRelay,
  setActiveNovel,
  getActiveNovel,
  getActiveNovelContext,
  listTools,
  callTool,
  resolveConfirmation,
  listPendingConfirmations,
  dispose,
  _debugGetChildPid: () => child?.pid || null,
  _debugGetChildServerToken: () => childServerToken,
  _debugGetChildProviderToken: () => childProviderToken,
};
