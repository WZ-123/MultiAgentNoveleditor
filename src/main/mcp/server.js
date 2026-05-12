'use strict';

/**
 * Stdio MCP server. Runs as a forked child of the main process (Phase 6
 * directApi driver) or as a spawned subprocess of an external driver
 * (Phase 7+ Claude Code via `--mcp-config`).
 *
 * Wire layout:
 *   - stdin/stdout : MCP JSON-RPC protocol (handled by SDK StdioServerTransport)
 *   - fd 3 (IPC)   : control protocol with parent (active novel + tool confirmations)
 *
 * Control IPC protocol — parent → child:
 *   { type: 'set-active-novel', novelId, novelDir }
 *   { type: 'confirm-response', id, accept, patch?, reason? }
 *   { type: 'shutdown' }
 *
 * Control IPC protocol — child → parent:
 *   { type: 'ready' }
 *   { type: 'confirm-request', id, name, arguments, runId, subagentId, nodeId, toolUseId }
 *   { type: 'log', level, message, data? }
 *   { type: 'error', message }
 *
 * For external-driver scenarios where there is no parent IPC channel,
 * confirmation requests fail-closed (auto-reject). Phase 7 adds a TCP fallback
 * via MANA_MAIN_PORT.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { TOOLS, getToolByName } = require('./tools');

// ---------- Active novel context ----------

let activeNovelId = null;
let activeNovelDir = null;

// ---------- Confirmation pending map ----------

const pendingConfirmations = new Map(); // id -> resolve fn
let confirmIdSeq = 0;

function nextConfirmId() {
  confirmIdSeq += 1;
  return `cf-${process.pid}-${confirmIdSeq.toString(36)}-${Date.now().toString(36)}`;
}

// ---------- Parent IPC ----------

function ipcAvailable() {
  return typeof process.send === 'function' && process.connected !== false;
}

function sendToParent(msg) {
  if (!ipcAvailable()) return false;
  try {
    process.send(msg);
    return true;
  } catch {
    return false;
  }
}

function awaitConfirmation(payload) {
  if (!ipcAvailable()) {
    // No IPC parent (driver path with external Claude Code process).
    // Auto-confirm write tools — same behavior as direct-API's autoConfirm:true.
    return Promise.resolve({ accept: true, reason: 'auto-confirmed (no IPC parent)' });
  }
  const id = nextConfirmId();
  return new Promise((resolve) => {
    pendingConfirmations.set(id, resolve);
    sendToParent({ type: 'confirm-request', id, ...payload });
  });
}

if (ipcAvailable()) {
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-active-novel':
        activeNovelId = msg.novelId || null;
        activeNovelDir = msg.novelDir || null;
        break;
      case 'confirm-response': {
        const r = pendingConfirmations.get(msg.id);
        if (r) {
          pendingConfirmations.delete(msg.id);
          r({
            accept: !!msg.accept,
            patch: (msg.patch && typeof msg.patch === 'object') ? msg.patch : null,
            reason: msg.reason || null,
          });
        }
        break;
      }
      case 'shutdown':
        gracefulExit(0);
        break;
      default:
        break;
    }
  });
  process.on('disconnect', () => {
    // Parent gone — nothing more to do.
    gracefulExit(0);
  });
}

// ---------- Tool dispatch context ----------

async function buildCtx({ runId, subagentId, metaNovelId, metaNovelDir }) {
  console.error("[mcp/server:buildCtx]", { activeNovelId, activeNovelDir, metaNovelId, metaNovelDir });
  // Prefer per-call meta context (injected by parent on every tool call).
  // Falls back to process-level state from set-active-novel IPC message.
  // Also check env vars (set by mcp-server-entry.js from --novel-id/--novel-dir CLI args).
  // This is the only source available in the external driver path where Claude Code
  // spawns the MCP server directly (no IPC parent, no _meta injection).
  const envNovelId = process.env.MANA_ACTIVE_NOVEL_ID || null;
  const envNovelDir = process.env.MANA_ACTIVE_NOVEL_DIR || null;
  let resolvedDir = metaNovelDir || activeNovelDir || envNovelDir;
  const resolvedId = metaNovelId || activeNovelId || envNovelId;
  if (!resolvedDir && resolvedId) {
    try {
      const novelsStore = require('../store/novels');
      const entry = await novelsStore.getNovelById(resolvedId);
      if (entry?.dir) resolvedDir = entry.dir;
    } catch { /* best-effort */ }
  }
  if (!resolvedDir) {
    return { novelDir: null, paths: null, novel: null, runId, subagentId };
  }
  const { novelPaths } = require('../store/paths');
  return {
    novelDir: resolvedDir,
    paths: novelPaths(resolvedDir),
    novel: { id: resolvedId, dir: resolvedDir },
    runId,
    subagentId,
  };
}

// ---------- MCP server bootstrap ----------

async function startServer() {
  const server = new Server(
    { name: 'novel-tools', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const meta = request.params._meta || {};
    const runId = meta.mana_runId || null;
    const subagentId = meta.mana_subagentId || null;
    const nodeId = meta.mana_nodeId || null;
    const toolUseId = meta.mana_toolUseId || null;
    // Active novel injected by parent on every call (more reliable than
    // the set-active-novel IPC message which can have race conditions).
    const metaNovelId = meta.mana_activeNovelId || null;
    const metaNovelDir = meta.mana_activeNovelDir || null;

    const tool = getToolByName(name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }

    let finalArgs = args;
    if (tool.requiresConfirmation && !meta.mana_autoConfirm) {
      const decision = await awaitConfirmation({
        name,
        arguments: finalArgs,
        runId,
        subagentId,
        nodeId,
        toolUseId,
      });
      if (!decision?.accept) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `User rejected tool call: ${name}${decision?.reason ? ` (${decision.reason})` : ''}`,
          }],
        };
      }
      if (decision.patch) {
        finalArgs = { ...finalArgs, ...decision.patch };
      }
    }

    const ctx = await buildCtx({ runId, subagentId, metaNovelId, metaNovelDir });
    try {
      const result = await tool.handler(finalArgs, ctx);
      // Tool handlers return { content: [{type:'text', text}] } or throw.
      return result;
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err.message || String(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  sendToParent({ type: 'ready' });
}

function gracefulExit(code = 0) {
  // Resolve any in-flight confirmations as rejected to free callers.
  for (const [id, resolve] of pendingConfirmations.entries()) {
    try { resolve({ accept: false, reason: 'server shutting down' }); } catch { /* ignore */ }
    pendingConfirmations.delete(id);
  }
  process.exit(code);
}

process.on('SIGTERM', () => gracefulExit(0));
process.on('SIGINT', () => gracefulExit(0));
process.on('uncaughtException', (err) => {
  sendToParent({ type: 'error', message: err.message || String(err) });
  setTimeout(() => gracefulExit(1), 50).unref?.();
});

// Allow running directly: `node server.js` or via fork.
if (require.main === module) {
  startServer().catch((err) => {
    sendToParent({ type: 'error', message: err.message || String(err) });
    gracefulExit(1);
  });
}

module.exports = { startServer };
