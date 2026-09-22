'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadReleasePublicConfig, validateReleasePublicConfig } = require('../src/main/release/publicConfig');

const PUBLIC_KEY = {
  kty: 'EC', crv: 'P-256', kid: 'active-1', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
};

async function run() {
  const valid = validateReleasePublicConfig({
    schemaVersion: 1,
    environment: 'production',
    relayBaseUrl: 'https://relay.example.test/',
    minimumClientVersion: '0.0.9',
    jwks: { keys: [PUBLIC_KEY] },
  });
  assert.equal(valid.relayBaseUrl, 'https://relay.example.test');
  assert.equal(valid.jwks.keys[0].d, undefined);
  assert.throws(() => validateReleasePublicConfig({ ...valid, relayBaseUrl: 'http://relay.example.test' }), (error) => error.code === 'release_config_invalid');
  assert.throws(() => validateReleasePublicConfig({ ...valid, relayBaseUrl: 'https://user:secret@relay.example.test' }), (error) => error.code === 'release_config_invalid');
  assert.throws(() => validateReleasePublicConfig({ ...valid, jwks: { keys: [{ ...PUBLIC_KEY, d: 'private' }] } }), (error) => error.code === 'release_config_invalid');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-public-config-'));
  const file = path.join(root, 'release-public-config.json');
  await fs.writeFile(file, JSON.stringify(valid));
  assert.deepEqual(await loadReleasePublicConfig({ path: file }), valid);
  await assert.rejects(() => loadReleasePublicConfig({ path: path.join(root, 'missing.json') }), (error) => error.code === 'release_config_missing');
  await fs.rm(root, { recursive: true, force: true });
  console.log('TEST_PASS release-public-config-regression');
}

if (require.main === module) run().catch((error) => {
  console.error(`TEST_FAIL release-public-config-regression: ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { run };
