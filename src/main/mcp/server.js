'use strict';

/**
 * Stdio MCP server. Runs as an isolated child of the official Codex App Server.
 * It exposes read-only resources and deterministic local checks. Mutations
 * are owned by Codex native apply_patch, not by this MCP process.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { TOOLS, getToolByName } = require('./tools');

// ---------- Tool dispatch context ----------

async function buildCtx({ runId, subagentId, metaNovelId, metaNovelDir }) {
  // App Server supplies the isolated process scope through CLI-derived env.
  const envNovelId = process.env.MANA_ACTIVE_NOVEL_ID || null;
  const envNovelDir = process.env.MANA_ACTIVE_NOVEL_DIR || null;
  let resolvedDir = metaNovelDir || envNovelDir;
  const resolvedId = metaNovelId || envNovelId;
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const meta = request.params._meta || {};
    const runId = meta.mana_runId || process.env.MANA_RUN_ID || null;
    const subagentId = meta.mana_subagentId || null;
    const metaNovelId = meta.mana_activeNovelId || null;
    const metaNovelDir = meta.mana_activeNovelDir || null;

    const tool = getToolByName(name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }

    try {
      const ctx = await buildCtx({ runId, subagentId, metaNovelId, metaNovelDir });
      ctx.abortSignal = extra?.signal || null;
      const result = await tool.handler(args, ctx);
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
}

function gracefulExit(code = 0) {
  process.exit(code);
}

// On Windows, SIGTERM is never delivered; only register it on non-Windows.
if (process.platform !== 'win32') {
  process.on('SIGTERM', () => gracefulExit(0));
}
process.on('SIGINT', () => gracefulExit(0));
process.on('uncaughtException', (err) => {
  process.stderr.write(`[novel-tools] ${err.message || String(err)}\n`);
  setTimeout(() => gracefulExit(1), 50).unref?.();
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[novel-tools] Unhandled Rejection: ${err?.message || String(err)}\n`);
  setTimeout(() => gracefulExit(1), 50).unref?.();
});

// Allow running directly for protocol diagnostics.
if (require.main === module) {
  startServer().catch((err) => {
    process.stderr.write(`[novel-tools] ${err.message || String(err)}\n`);
    gracefulExit(1);
  });
}

module.exports = { startServer };
