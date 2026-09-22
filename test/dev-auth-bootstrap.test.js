'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runDevAuthBootstrapTest() {
  const root = path.resolve(__dirname, '..');
  const tempRoot = path.join(root, 'tmp-test-dev-auth-bootstrap');
  const configPath = path.join(tempRoot, 'release-public-config.json');
  const bootstrapPath = path.join(root, 'src/main/license/devAuthBootstrap.js');
  const previous = {
    force: process.env.MANA_FORCE_AUTH,
    local: process.env.MANA_ALLOW_LOCAL_RELAY,
    config: process.env.MANA_RELEASE_PUBLIC_CONFIG,
  };

  try {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });
    const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.webcrypto.subtle.exportKey('jwk', pair.publicKey);
    await fs.writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      environment: 'staging',
      relayBaseUrl: 'http://127.0.0.1:8789',
      minimumClientVersion: '0.0.9',
      jwks: { keys: [{ ...jwk, kid: 'dev-auth-test', alg: 'ES256', use: 'sig' }] },
    }), 'utf8');
    process.env.MANA_FORCE_AUTH = '1';
    process.env.MANA_ALLOW_LOCAL_RELAY = '1';
    process.env.MANA_RELEASE_PUBLIC_CONFIG = configPath;
    delete require.cache[bootstrapPath];
    const { ensureDevAuthRelayConfig } = require(bootstrapPath);
    const result = await ensureDevAuthRelayConfig();

    assert.deepEqual(result, {
      seeded: false,
      relayUrl: 'http://127.0.0.1:8789',
      environment: 'staging',
    });
    assert.equal(JSON.stringify(result).includes('apiKey'), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (previous.force === undefined) delete process.env.MANA_FORCE_AUTH; else process.env.MANA_FORCE_AUTH = previous.force;
    if (previous.local === undefined) delete process.env.MANA_ALLOW_LOCAL_RELAY; else process.env.MANA_ALLOW_LOCAL_RELAY = previous.local;
    if (previous.config === undefined) delete process.env.MANA_RELEASE_PUBLIC_CONFIG; else process.env.MANA_RELEASE_PUBLIC_CONFIG = previous.config;
    delete require.cache[bootstrapPath];
  }

  console.log('TEST_PASS DEV_AUTH_BOOTSTRAP: forced auth reads public Relay V2 config without seeding a shared key');
  console.log('TEST_SUMMARY 1/1 passed, 0 failed');
  console.log('TEST_DONE');
}

module.exports = { runDevAuthBootstrapTest };

if (require.main === module) {
  runDevAuthBootstrapTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
