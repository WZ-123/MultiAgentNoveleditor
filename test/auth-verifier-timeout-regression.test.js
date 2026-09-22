'use strict';

const assert = require('node:assert/strict');
const { AUTH_CODE_SECRET, SessionManager } = require('../src/main/license/sessionManager');

async function runAuthVerifierTimeoutRegressionTest() {
  const records = new Map();
  const fakeSecrets = {
    async migratePlainRecords() { return { migrated: 0, blocked: false }; },
    async getSecretStatus(id) {
      const value = records.get(id) || '';
      return { value, present: Boolean(value), readable: Boolean(value), revision: value ? 1 : 0 };
    },
    async setSecret(id, value) { records.set(id, String(value)); },
  };
  const manager = new SessionManager({
    exchangeTimeoutMs: 20,
    secrets: fakeSecrets,
    appConfig: {
      async readLegacyLicenseMaterial() { return { authCode: 'timeout-code' }; },
      async clearLegacyLicenseMaterial() {},
      async save() {},
    },
    releaseConfigLoader: async () => ({ relayBaseUrl: 'https://relay.timeout.test', jwks: { keys: [] } }),
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('request aborted by deadline');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  const startedAt = Date.now();
  const result = await manager.verifyLicense({ forceOnline: true });
  const elapsed = Date.now() - startedAt;

  assert.equal(records.get(AUTH_CODE_SECRET), 'timeout-code');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'relay_timeout');
  assert.equal(result.error?.userAction, 'retry');
  assert.match(result.message, /超时/);
  assert.ok(elapsed < 1000, `timeout should respect the injected deadline, got ${elapsed}ms`);
  console.log('TEST_PASS AUTH_VERIFY_TIMEOUT: online verification aborts and returns a retryable timeout result');
  console.log('TEST_SUMMARY 1/1 passed, 0 failed');
  console.log('TEST_DONE');
}

module.exports = { runAuthVerifierTimeoutRegressionTest };

if (require.main === module) {
  runAuthVerifierTimeoutRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
