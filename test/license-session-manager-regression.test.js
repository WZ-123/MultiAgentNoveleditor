'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createMemoryRelayState, createRelayCore, jwksFromEnv } = require('../relay-worker/src/relay-core.cjs');
const {
  AUTH_CODE_SECRET,
  INSTALLATION_ID_SECRET,
  OFFLINE_LEASE_SECRET,
  SessionManager,
} = require('../src/main/license/sessionManager');

async function run() {
  const previousForceAuth = process.env.MANA_FORCE_AUTH;
  process.env.MANA_FORCE_AUTH = '1';
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  privateJwk.kid = 'client-test';
  const relayBaseUrl = 'https://relay.session.test';
  const env = {
    RELAY_SIGNING_KID: privateJwk.kid,
    RELAY_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    RELAY_ISSUER: relayBaseUrl,
    RELAY_AUTH_CODE_PEPPER: 'session-manager-regression-pepper',
    RELAY_STATE_STORE: createMemoryRelayState(),
  };
  let now = Date.parse('2026-08-23T03:00:00.000Z');
  const route = createRelayCore({
    env,
    now: () => now,
    handlers: {
      exchangeLicense: async ({ authCode }) => authCode === 'valid-code'
        ? { valid: true, deviceCount: 1, maxDevices: 5, expiresAt: '2026-09-01T00:00:00.000Z' }
        : { valid: false, reason: 'invalid_code' },
      uploadFeedback: async () => ({ fileToken: 'unused' }),
      submitFeedback: async () => ({ recordId: 'unused' }),
    },
  });
  const records = new Map();
  const fakeSecrets = {
    async migratePlainRecords() { return { migrated: 0, blocked: false }; },
    async getSecretStatus(id) {
      const value = records.get(id) || '';
      return { value, present: Boolean(value), readable: Boolean(value), issue: value ? null : 'missing', revision: value ? 1 : 0 };
    },
    async setSecret(id, value) { records.set(id, String(value)); return id; },
  };
  let clearedLegacy = false;
  const fakeConfig = {
    async readLegacyLicenseMaterial() { return { authCode: 'valid-code', relayApiKey: 'must-not-survive' }; },
    async clearLegacyLicenseMaterial() { clearedLegacy = true; },
    async save(patch) { assert.equal(patch.license.lastAuthStatus, 'verified'); },
  };
  const publicConfig = {
    schemaVersion: 1,
    environment: 'production',
    relayBaseUrl,
    minimumClientVersion: '0.0.9',
    jwks: jwksFromEnv(env),
  };
  let exchanges = 0;
  let networkDown = false;
  const fakeFetch = async (url, options) => {
    if (networkDown) throw new Error('simulated offline');
    assert.equal(url, `${relayBaseUrl}/api/v2/session/exchange`);
    exchanges += 1;
    const result = await route({
      method: options.method,
      path: '/api/v2/session/exchange',
      headers: options.headers,
      body: options.body,
      remoteAddress: `198.51.100.${exchanges}`,
    });
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  const manager = new SessionManager({
    fetch: fakeFetch,
    releaseConfigLoader: async () => publicConfig,
    secrets: fakeSecrets,
    appConfig: fakeConfig,
    now: () => now,
    getAppVersion: () => '0.0.9',
    getPlatform: () => 'test-x64',
  });

  await manager.prepareSecureState();
  assert.equal(clearedLegacy, true);
  assert.equal(records.get(AUTH_CODE_SECRET), 'valid-code');
  assert.match(records.get(INSTALLATION_ID_SECRET), /^[A-Za-z0-9_-]{43}$/);
  assert.equal([...records.values()].includes('must-not-survive'), false);

  const online = await manager.verifyLicense({ forceOnline: true });
  assert.equal(online.valid, true);
  assert.equal(exchanges, 1);
  assert.ok(records.get(OFFLINE_LEASE_SECRET));
  const firstToken = await manager.getAccessToken('feedback:submit');
  assert.equal(firstToken, online.accessToken);
  assert.equal(exchanges, 1);

  manager.clearAccessToken();
  const cached = await manager.verifyLicense();
  assert.equal(cached.valid, true);
  assert.equal(cached.cached, true);
  assert.equal(exchanges, 1);

  now += 8 * 24 * 60 * 60 * 1000;
  networkDown = true;
  const expired = await manager.verifyLicense();
  assert.equal(expired.valid, false);

  networkDown = false;
  const recovered = await manager.verifyLicense({ forceOnline: true });
  assert.equal(recovered.valid, true);
  assert.equal(exchanges, 2);

  if (previousForceAuth == null) delete process.env.MANA_FORCE_AUTH;
  else process.env.MANA_FORCE_AUTH = previousForceAuth;
  console.log('TEST_PASS license-session-manager-regression');
}

if (require.main === module) run().catch((error) => {
  console.error(`TEST_FAIL license-session-manager-regression: ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { run };
