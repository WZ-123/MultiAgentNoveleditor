#!/usr/bin/env node
'use strict';

/**
 * Build without mutating tracked source files. The generated resource contains
 * only a public Relay URL, minimum version and public ES256 verification keys.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateReleasePublicConfig } = require('../src/main/release/publicConfig');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_CONFIG_PATH = path.join(ROOT, '.cache', 'release-public-config.json');
const BUILDER_ARGS = process.argv.slice(2);

// Prefer the pinned Electron installation already present in the workspace.
// This keeps release builds reproducible and prevents electron-builder from
// silently reaching out to GitHub when the matching distribution is local.
if (!BUILDER_ARGS.some((value) => value.startsWith('--config.electronDist'))) {
  const localElectronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(localElectronDist)) BUILDER_ARGS.push(`--config.electronDist=${localElectronDist}`);
}

function fail(message) { throw new Error(`[build-release] ${message}`); }
function log(message) { process.stdout.write(`[build-release] ${message}\n`); }

function parseJwks(raw) {
  try { return JSON.parse(String(raw || '')); }
  catch { fail('RELEASE_RELAY_JWKS must be valid JSON'); }
}

function generatePublicConfig() {
  const relayBaseUrl = String(process.env.RELEASE_RELAY_URL || '').trim();
  const jwksRaw = String(process.env.RELEASE_RELAY_JWKS || '').trim();
  const minimumClientVersion = String(process.env.RELEASE_MINIMUM_CLIENT_VERSION || require('../package.json').version).trim();
  const releaseRequired = process.env.MANA_REQUIRE_RELEASE_CONFIG === '1' || process.env.MANA_REQUIRE_RELEASE_SIGNATURE === '1';
  if (!relayBaseUrl || !jwksRaw) {
    if (releaseRequired) fail('release builds require RELEASE_RELAY_URL and RELEASE_RELAY_JWKS');
    log('Public Relay config is absent; generating an explicit local staging placeholder. Online authentication will fail closed.');
    return {
      schemaVersion: 1,
      environment: 'staging',
      relayBaseUrl: 'http://127.0.0.1:9',
      minimumClientVersion,
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', kid: 'local-placeholder', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] },
    };
  }
  return validateReleasePublicConfig({
    schemaVersion: 1,
    environment: process.env.RELEASE_ENVIRONMENT === 'staging' ? 'staging' : 'production',
    relayBaseUrl,
    minimumClientVersion,
    jwks: parseJwks(jwksRaw),
  });
}

function run(command, args, label, env = process.env) {
  log(label);
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status}`);
}

const publicConfig = generatePublicConfig();
fs.mkdirSync(path.dirname(PUBLIC_CONFIG_PATH), { recursive: true });
fs.writeFileSync(PUBLIC_CONFIG_PATH, `${JSON.stringify(publicConfig, null, 2)}\n`, { mode: 0o644 });
log(`Generated public release config for ${publicConfig.environment}; no Relay credential was embedded.`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(process.execPath, ['scripts/prepare-codex-runtime.js'], 'Preparing pinned Codex App Server sidecar');
run(process.execPath, ['scripts/verify-codex-runtime-package.js'], 'Verifying pinned Codex App Server sidecar');
run(npmCmd, ['exec', 'vite', 'build'], 'Building renderer');
const builderEnv = process.env.MANA_REQUIRE_RELEASE_SIGNATURE === '1'
  ? process.env
  : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
run(npmCmd, ['exec', '--', 'electron-builder', ...BUILDER_ARGS], `Building Electron artifact ${BUILDER_ARGS.join(' ') || '(default)'}`, builderEnv);
run(process.execPath, ['scripts/verify-packaged-codex-runtime.js'], 'Verifying packaged Codex App Server resource');
log('Packaged build complete.');
