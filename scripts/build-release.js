#!/usr/bin/env node
'use strict';

/**
 * Build a packaged release with pre-seeded relay configuration.
 *
 * Usage:
 *   RELEASE_RELAY_URL=https://relay.example RELEASE_RELAY_API_KEY=xxx npm run build:win
 *   BETA_RELAY_URL=https://relay.example BETA_RELAY_API_KEY=xxx npm run build
 *
 * This script injects relayUrl + relayApiKey into DEFAULT_APP_CONFIG for the
 * duration of the build so packaged clients can pass relay-backed auth.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APPCONFIG_PATH = path.resolve(ROOT, 'src', 'main', 'store', 'appConfig.js');
const BACKUP_PATH = path.join(os.tmpdir(), `mana-build-release-appConfig-${process.pid}-${Date.now()}.js.bak`);

const RELAY_URL = process.env.RELEASE_RELAY_URL || process.env.BETA_RELAY_URL || '';
const RELAY_API_KEY = process.env.RELEASE_RELAY_API_KEY || process.env.BETA_RELAY_API_KEY || '';
const BUILDER_ARGS = process.argv.slice(2);

function log(...args) {
  console.log('[build-release]', ...args);
}

function errorExit(msg) {
  throw new Error(`[build-release] ${msg}`);
}

function injectValue(content, key, value) {
  const pattern = new RegExp(`(\\b${key}\\s*:\\s*)['"][^'"]*['"]`, 'g');
  return content.replace(pattern, `$1'${value.replace(/'/g, "\\'")}'`);
}

if (!RELAY_URL) errorExit('RELEASE_RELAY_URL (or legacy BETA_RELAY_URL) is required');
if (!RELAY_API_KEY) errorExit('RELEASE_RELAY_API_KEY (or legacy BETA_RELAY_API_KEY) is required');

log('Relay URL:', RELAY_URL);
log('API Key:', `${RELAY_API_KEY.slice(0, 4)}...${RELAY_API_KEY.slice(-4)}`);

const original = fs.readFileSync(APPCONFIG_PATH, 'utf8');
fs.writeFileSync(BACKUP_PATH, original);
log('Backup created:', BACKUP_PATH);

let injected = original;
injected = injected.replace(
  /(feishuSync:\s*\{[\s\S]*?enabled:\s*)false(\s*,)/,
  '$1true$2'
);
injected = injectValue(injected, 'relayUrl', RELAY_URL);
injected = injectValue(injected, 'relayApiKey', RELAY_API_KEY);
fs.writeFileSync(APPCONFIG_PATH, injected);

const verify = fs.readFileSync(APPCONFIG_PATH, 'utf8');
if (!verify.includes(RELAY_URL)) errorExit('Injection failed: relayUrl not found');
if (!verify.includes(RELAY_API_KEY)) errorExit('Injection failed: relayApiKey not found');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  log('Running vite build...');
  const viteResult = spawnSync(npmCmd, ['exec', 'vite', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (viteResult.status !== 0) {
    errorExit(`vite build failed with exit code ${viteResult.status}`);
  }

  log('Running electron-builder', BUILDER_ARGS.join(' ') || '(default)');
  const builderResult = spawnSync(npmCmd, ['exec', '--', 'electron-builder', ...BUILDER_ARGS], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (builderResult.status !== 0) {
    errorExit(`electron-builder failed with exit code ${builderResult.status}`);
  }
} finally {
  fs.writeFileSync(APPCONFIG_PATH, original);
  try {
    fs.unlinkSync(BACKUP_PATH);
  } catch {
    // ignore cleanup failure
  }
  log('Restored original appConfig.js');
}

log('Packaged build complete. Relay config is baked into the app.');
