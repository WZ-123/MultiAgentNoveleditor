#!/usr/bin/env node
'use strict';

/**
 * Cross-platform `npm run start` wrapper.
 * Replaces: concurrently "vite" "unset ELECTRON_RUN_AS_NODE && electron . --no-sandbox"
 *
 * On Windows, `unset` does not exist and `$()` shell substitution fails.
 * This script starts both processes using Node child_process directly.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Start vite dev server
const viteProc = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite'],
  { cwd: ROOT, stdio: 'inherit' }
);

// Build the env for the Electron child – ensure ELECTRON_RUN_AS_NODE is unset.
const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

// Start electron (delay slightly to let vite begin)
setTimeout(() => {
  const electronProc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.', '--no-sandbox'],
    { cwd: ROOT, stdio: 'inherit', env: electronEnv }
  );

  electronProc.on('exit', (code) => {
    viteProc.kill();
    process.exit(code ?? 0);
  });
}, 500);

viteProc.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  viteProc.kill();
  process.exit(0);
});
