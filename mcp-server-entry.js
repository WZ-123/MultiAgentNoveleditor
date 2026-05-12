#!/usr/bin/env node
'use strict';

/**
 * mcp-server-entry.js — top-level entry script for the stdio MCP server.
 *
 * Used by:
 *   1. directApi driver via child_process.fork() with an IPC channel (Phase 6)
 *   2. External drivers (Claude Code VSCode / CLI) via spawn from
 *      `claude --mcp-config <path>` (Phase 7+) — no IPC channel; relies on
 *      MANA_MAIN_PORT TCP fallback for confirmation round-trip.
 *
 * Why a top-level script (not a function inside src/)?
 *   electron-builder's asarUnpack pattern needs a stable absolute path that
 *   external CLIs can spawn. Keeping it at the project root simplifies path
 *   resolution.
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
// setting early matches the parent-fork contract).
if (args['user-data-root']) {
  process.env.MANA_USER_DATA_ROOT = path.resolve(args['user-data-root']);
}
if (args['main-port']) {
  process.env.MANA_MAIN_PORT = String(args['main-port']);
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
  if (typeof process.send === 'function') {
    try { process.send({ type: 'error', message: err.message || String(err) }); } catch { /* ignore */ }
  } else {
    process.stderr.write(`[mcp-server-entry] startup failed: ${err.message || err}\n`);
  }
  process.exit(1);
});

// If invoked without parent IPC (external driver scenario), seed active novel
// from CLI args. We must do this AFTER the server module is loaded so its
// internal `activeNovelDir` setter is available — but the server module's
// active-novel state is currently managed via IPC messages, not direct API.
// For now we synthesize a synthetic message via process.emit; if no IPC
// channel exists, the message handler is a no-op so we tag globals instead.
if (initialNovel.id || initialNovel.dir) {
  if (typeof process.send === 'function') {
    // Parent-fork case: parent will send set-active-novel after ready.
    // Nothing to do here; CLI args are informational only.
  } else {
    // External-spawn case: set env vars so server.js:buildCtx() reads them as fallback.
    if (initialNovel.id) process.env.MANA_ACTIVE_NOVEL_ID = initialNovel.id;
    if (initialNovel.dir) process.env.MANA_ACTIVE_NOVEL_DIR = initialNovel.dir;
  }
}
