#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.MANA_DEV_AUTH_RELAY_PORT || 8789);
const RELAY_URL = `http://127.0.0.1:${PORT}`;
const isFresh = process.argv.includes('--fresh');

async function run() {
  const freshDir = path.join(ROOT, 'tmp-test-auth-required-userdata', 'fresh');
  if (isFresh && fs.existsSync(freshDir)) fs.rmSync(freshDir, { recursive: true, force: true });
  const userDir = isFresh ? freshDir : path.join(ROOT, 'tmp-test-auth-required-userdata', 'client');

  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.webcrypto.subtle.exportKey('jwk', pair.privateKey);
  privateJwk.kid = 'local-dev-active';
  const { d: _private, ...publicJwk } = privateJwk;
  const publicConfigPath = path.join(ROOT, '.cache', 'dev-auth-release-public-config.json');
  fs.mkdirSync(path.dirname(publicConfigPath), { recursive: true });
  fs.writeFileSync(publicConfigPath, JSON.stringify({
    schemaVersion: 1,
    environment: 'staging',
    relayBaseUrl: RELAY_URL,
    minimumClientVersion: require('../package.json').version,
    jwks: { keys: [{ ...publicJwk, use: 'sig', alg: 'ES256' }] },
  }, null, 2));

  const vite = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' }, shell: process.platform === 'win32',
  });
  if (vite.status !== 0) throw new Error(`Vite build failed with exit ${vite.status}`);

  const sharedEnv = {
    ...process.env,
    MANA_DEV_AUTH_RELAY_PORT: String(PORT),
    RELAY_SIGNING_KID: privateJwk.kid,
    RELAY_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    RELAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, use: 'sig', alg: 'ES256' }] }),
    RELAY_ISSUER: RELAY_URL,
    RELAY_AUTH_CODE_PEPPER: 'local-development-pepper-only',
  };
  const relay = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-auth-relay.js')], { cwd: ROOT, stdio: 'inherit', env: sharedEnv });
  const cleanup = () => { if (!relay.killed) relay.kill(); };

  setTimeout(() => {
    const electronEnv = {
      ...sharedEnv,
      NODE_ENV: 'production',
      MANA_USER_DATA_ROOT: userDir,
      MANA_FORCE_AUTH: '1',
      MANA_ALLOW_LOCAL_RELAY: '1',
      MANA_RELEASE_PUBLIC_CONFIG: publicConfigPath,
    };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    const electron = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
      cwd: ROOT, stdio: 'inherit', env: electronEnv, shell: process.platform === 'win32',
    });
    electron.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
  }, 750);

  relay.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

run().catch((error) => {
  console.error(`[dev:auth] ${error.message}`);
  process.exitCode = 1;
});
