#!/usr/bin/env node
'use strict';

/**
 * Build a beta release with pre-seeded relay configuration.
 *
 * Usage:
 *   BETA_RELAY_URL=https://xxx.workers.dev BETA_RELAY_API_KEY=xxx npm run build:beta
 *
 * This script injects the relay URL and API key into DEFAULT_APP_CONFIG so that
 * beta testers get a fully pre-configured app — no manual setup required.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RELAY_URL = process.env.BETA_RELAY_URL || '';
const RELAY_API_KEY = process.env.BETA_RELAY_API_KEY || '';

const APPCONFIG_PATH = path.resolve(__dirname, '..', 'src', 'main', 'store', 'appConfig.js');
const BACKUP_PATH = `${APPCONFIG_PATH}.backup`;

function log(...args) {
  console.log('[build-beta]', ...args);
}

function errorExit(msg) {
  console.error('[build-beta] ERROR:', msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate inputs
// ---------------------------------------------------------------------------

if (!RELAY_URL) errorExit('BETA_RELAY_URL is required');
if (!RELAY_API_KEY) errorExit('BETA_RELAY_API_KEY is required');

log('Relay URL:', RELAY_URL);
log('API Key:', `${RELAY_API_KEY.slice(0, 4)}...${RELAY_API_KEY.slice(-4)}`);

// ---------------------------------------------------------------------------
// Backup original
// ---------------------------------------------------------------------------

const original = fs.readFileSync(APPCONFIG_PATH, 'utf8');
fs.writeFileSync(BACKUP_PATH, original);
log('Backup created:', BACKUP_PATH);

// ---------------------------------------------------------------------------
// Inject pre-seeded values
// ---------------------------------------------------------------------------

function injectValue(content, key, value, quote = true) {
  const pattern = new RegExp(`(\\b${key}\\s*:\\s*)['"][^'"]*['"]`, 'g');
  const replacement = quote
    ? `$1'${value.replace(/'/g, "\\'")}'`
    : `$1${value}`;
  return content.replace(pattern, replacement);
}

let injected = original;

// enabled: false → true (match within feishuSync block)
injected = injected.replace(
  /(feishuSync:\s*\{[\s\S]*?enabled:\s*)false(\s*,)/,
  '$1true$2'
);

// relayUrl: '' → actual URL
injected = injectValue(injected, 'relayUrl', RELAY_URL);

// relayApiKey: '' → actual key
injected = injectValue(injected, 'relayApiKey', RELAY_API_KEY);

fs.writeFileSync(APPCONFIG_PATH, injected);
log('Injected pre-seeded config into', APPCONFIG_PATH);

// ---------------------------------------------------------------------------
// Verify injection
// ---------------------------------------------------------------------------

const verify = fs.readFileSync(APPCONFIG_PATH, 'utf8');
if (!verify.includes(RELAY_URL)) errorExit('Injection failed: relayUrl not found');
if (!verify.includes(RELAY_API_KEY)) errorExit('Injection failed: relayApiKey not found');

// ---------------------------------------------------------------------------
// Run build
// ---------------------------------------------------------------------------

log('Running npm run build...');
const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  shell: true,
});

// ---------------------------------------------------------------------------
// Restore original regardless of build result
// ---------------------------------------------------------------------------

fs.writeFileSync(APPCONFIG_PATH, original);
fs.unlinkSync(BACKUP_PATH);
log('Restored original appConfig.js');

if (result.status !== 0) {
  errorExit(`Build failed with exit code ${result.status}`);
}

log('Beta build complete. Relay config is baked into the app.');
log('Beta testers do not need to configure anything.');
