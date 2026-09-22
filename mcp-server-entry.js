#!/usr/bin/env node
'use strict';

/**
 * mcp-server-entry.js — top-level entry script for the stdio MCP server.
 *
 * Spawned by the official Codex App Server as the application's sole stdio
 * novel-tools MCP process. This process exposes no mutation or confirmation channel.
 *
 * Why a top-level script (not a function inside src/)?
 *   Keeping it at the project root gives Codex a stable path in both the
 *   source tree and the packaged app.asar.
 */

const path = require('node:path');

// ---- CLI argument parsing ----
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Apply env var overrides BEFORE requiring server.js (which transitively
// imports paths.js — paths.js reads MANA_USER_DATA_ROOT at call time, but
// setting early matches the App Server subprocess contract).
if (args['user-data-root']) {
  process.env.MANA_USER_DATA_ROOT = path.resolve(args['user-data-root']);
}
if (args['run-id']) {
  process.env.MANA_RUN_ID = String(args['run-id']);
}

// ---- Bootstrap initial active-novel context (used when no IPC parent) ----
const initialNovel = {
  id: args['novel-id'] || null,
  dir: args['novel-dir'] ? path.resolve(args['novel-dir']) : null,
};

// Fallback: if novel-id is provided but novel-dir is not, resolve from store.
if (initialNovel.id && !initialNovel.dir) {
  try {
    const { getNovelById } = require('./src/main/store/novels');
    getNovelById(initialNovel.id).then((entry) => {
      if (entry?.dir) initialNovel.dir = path.resolve(entry.dir);
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// We have to require AFTER env vars are set so the inner paths resolution
// picks up MANA_USER_DATA_ROOT.
const { startServer } = require('./src/main/mcp/server.js');

startServer().catch((err) => {
  process.stderr.write(`[mcp-server-entry] startup failed: ${err.message || err}\n`);
  process.exit(1);
});

// Seed the resource scope supplied by Codex after the server module has loaded.
if (initialNovel.id || initialNovel.dir) {
  if (initialNovel.id) process.env.MANA_ACTIVE_NOVEL_ID = initialNovel.id;
  if (initialNovel.dir) process.env.MANA_ACTIVE_NOVEL_DIR = initialNovel.dir;
}
