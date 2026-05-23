#!/usr/bin/env node
'use strict';

/**
 * Cross-platform `npm run dev:auth` / `npm run dev:auth:fresh` wrapper.
 *
 * Original (Unix-only):
 *   REAL_RELAY_KEY=$(grep '^RELAY_API_KEY=' "$PWD/relay-worker/.dev.vars" | cut -d= -f2-) \
 *   && NODE_ENV=production vite build \
 *   && NODE_ENV=production MANA_USER_DATA_ROOT=... MANA_FORCE_AUTH=1 ... \
 *      concurrently "node scripts/start-real-feishu-relay.js" "unset ELECTRON_RUN_AS_NODE && electron . --no-sandbox"
 *
 * This script does the same thing using Node APIs so it works on Windows too.
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const isFresh = process.argv.includes('--fresh');

// --- 1. Read RELAY_API_KEY from relay-worker/.dev.vars ---
const devVarsPath = path.join(ROOT, 'relay-worker', '.dev.vars');
let relayKey = '';
try {
  const text = fs.readFileSync(devVarsPath, 'utf8');
  const match = text.match(/^RELAY_API_KEY=(.+)$/m);
  if (match) relayKey = match[1].trim();
} catch (err) {
  console.error('[dev:auth] Cannot read', devVarsPath, err.message);
  process.exit(1);
}
if (!relayKey) {
  console.error('[dev:auth] RELAY_API_KEY not found in', devVarsPath);
  process.exit(1);
}

// --- 2. If --fresh, clean the fresh test directory ---
const freshDir = path.join(ROOT, 'tmp-test-auth-required-userdata', 'fresh');
if (isFresh && fs.existsSync(freshDir)) {
  fs.rmSync(freshDir, { recursive: true, force: true });
}

// --- 3. Determine user data root ---
const userDir = isFresh
  ? freshDir
  : path.join(ROOT, 'tmp-test-auth-required-userdata', 'client');

// --- 4. Run vite build ---
console.log('[dev:auth] Building vite...');
try {
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
} catch {
  console.error('[dev:auth] Vite build failed');
  process.exit(1);
}

// --- 5. Start relay + Electron ---
const relayEnv = {
  ...process.env,
  RELAY_API_KEY: relayKey,
};

const electronEnv = {
  ...process.env,
  NODE_ENV: 'production',
  MANA_USER_DATA_ROOT: userDir,
  MANA_FORCE_AUTH: '1',
  MANA_DEV_AUTH_RELAY_PORT: '8787',
  MANA_DEV_AUTH_RELAY_URL: 'http://127.0.0.1:8787',
  MANA_DEV_AUTH_RELAY_API_KEY: relayKey,
  RELAY_API_KEY: relayKey,
};
delete electronEnv.ELECTRON_RUN_AS_NODE;

// Start relay server
const relayProc = spawn(
  process.execPath,
  [path.join(ROOT, 'scripts', 'start-real-feishu-relay.js')],
  { cwd: ROOT, stdio: 'inherit', env: relayEnv }
);

// Start electron (slight delay for relay to bind)
setTimeout(() => {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const electronProc = spawn(
    npx,
    ['electron', '.', '--no-sandbox'],
    { cwd: ROOT, stdio: 'inherit', env: electronEnv }
  );

  electronProc.on('exit', (code) => {
    relayProc.kill();
    process.exit(code ?? 0);
  });
}, 1000);

relayProc.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  relayProc.kill();
  process.exit(0);
});
