'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELAY_WORKER_DIR = path.join(ROOT, 'relay-worker');
const DEV_VARS_PATH = path.join(RELAY_WORKER_DIR, '.dev.vars');
const DEFAULT_PORT = process.env.MANA_DEV_AUTH_RELAY_PORT || '8787';
const DEFAULT_RELAY_URL = process.env.MANA_DEV_AUTH_RELAY_URL || `http://127.0.0.1:${DEFAULT_PORT}`;

function loadDevVars() {
  const out = {};
  if (!fs.existsSync(DEV_VARS_PATH)) return out;

  const content = fs.readFileSync(DEV_VARS_PATH, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing required relay env: ${name}. Run relay-worker/scripts/init.js and fill relay-worker/.dev.vars.`);
  }
  return value;
}

function main() {
  const fileVars = loadDevVars();
  const env = {
    ...process.env,
    PORT: String(DEFAULT_PORT),
    FEISHU_APP_ID: process.env.FEISHU_APP_ID || fileVars.FEISHU_APP_ID || '',
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || fileVars.FEISHU_APP_SECRET || '',
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN || fileVars.FEISHU_APP_TOKEN || '',
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID || fileVars.FEISHU_TABLE_ID || '',
    FEISHU_AUTH_TABLE_ID: process.env.FEISHU_AUTH_TABLE_ID || fileVars.FEISHU_AUTH_TABLE_ID || '',
    RELAY_API_KEY: process.env.RELAY_API_KEY || fileVars.RELAY_API_KEY || '',
    MANA_DEV_AUTH_RELAY_URL: DEFAULT_RELAY_URL,
    MANA_DEV_AUTH_RELAY_API_KEY: process.env.MANA_DEV_AUTH_RELAY_API_KEY || fileVars.RELAY_API_KEY || '',
  };

  requireValue('FEISHU_APP_ID', env.FEISHU_APP_ID);
  requireValue('FEISHU_APP_SECRET', env.FEISHU_APP_SECRET);
  requireValue('FEISHU_APP_TOKEN', env.FEISHU_APP_TOKEN);
  requireValue('FEISHU_TABLE_ID', env.FEISHU_TABLE_ID);
  requireValue('FEISHU_AUTH_TABLE_ID', env.FEISHU_AUTH_TABLE_ID);
  requireValue('RELAY_API_KEY', env.RELAY_API_KEY);

  const child = spawn(process.execPath, [path.join(RELAY_WORKER_DIR, 'scf-app-final.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  // On Windows, SIGTERM is never delivered; skip to avoid issues.
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  }

  console.log(`[real-feishu-relay] relay url: ${DEFAULT_RELAY_URL}`);
}

try {
  main();
} catch (err) {
  console.error('[real-feishu-relay] failed:', err.message || String(err));
  process.exit(1);
}