'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELAY_DIR = path.join(ROOT, 'relay-worker');
const DEV_VARS_PATH = path.join(RELAY_DIR, '.dev.vars');
const ALLOWED_KEYS = new Set([
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_APP_TOKEN', 'FEISHU_TABLE_ID',
  'FEISHU_AUTH_TABLE_ID', 'RELAY_SIGNING_KID', 'RELAY_SIGNING_PRIVATE_JWK',
  'RELAY_PUBLIC_JWKS', 'RELAY_ISSUER', 'RELAY_AUTH_CODE_PEPPER',
  'RELAY_REDIS_URL', 'RELAY_ALLOWED_ORIGIN',
]);
const REQUIRED_KEYS = [...ALLOWED_KEYS].filter((key) => key !== 'RELAY_ALLOWED_ORIGIN');

function loadIgnoredDevVars() {
  if (!fs.existsSync(DEV_VARS_PATH)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(DEV_VARS_PATH, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!ALLOWED_KEYS.has(key)) continue;
    values[key] = line.slice(separator + 1).trim();
  }
  return values;
}

function main() {
  const fileValues = loadIgnoredDevVars();
  const relayEnv = { ...process.env, PORT: String(process.env.MANA_DEV_AUTH_RELAY_PORT || '8787') };
  for (const key of ALLOWED_KEYS) relayEnv[key] = String(process.env[key] || fileValues[key] || '');
  const missing = REQUIRED_KEYS.filter((key) => !relayEnv[key]);
  if (missing.length) {
    throw new Error(`Relay V2 缺少配置：${missing.join(', ')}。请复制 .dev.vars.example 到被忽略的 .dev.vars 后填写。`);
  }

  const child = spawn(process.execPath, [path.join(RELAY_DIR, 'scripts/local-v2-server.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: relayEnv,
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  process.on('SIGINT', () => child.kill('SIGINT'));
  if (process.platform !== 'win32') process.on('SIGTERM', () => child.kill('SIGTERM'));
}

try { main(); } catch (error) {
  process.stderr.write(`[real-feishu-relay] ${error.message}\n`);
  process.exitCode = 1;
}
