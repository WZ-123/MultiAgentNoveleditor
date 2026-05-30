'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runAuthVerifierTimeoutRegressionTest() {
  const root = path.resolve(__dirname, '..');
  const authVerifierPath = path.join(root, 'src/main/license/authVerifier.js');
  const appConfigPath = path.join(root, 'src/main/store/appConfig.js');

  const originalFetch = global.fetch;
  const oldNodeEnv = process.env.NODE_ENV;
  const oldForceAuth = process.env.MANA_FORCE_AUTH;

  try {
    process.env.NODE_ENV = 'production';
    process.env.MANA_FORCE_AUTH = '1';

    delete require.cache[authVerifierPath];
    delete require.cache[appConfigPath];

    const appConfig = require(appConfigPath);
    const originalLoad = appConfig.load;
    const originalSave = appConfig.save;

    try {
      appConfig.load = async () => ({
        feishuSync: {
          relayUrl: 'http://127.0.0.1:8789',
          relayApiKey: 'mana-dev-relay-key',
        },
        license: {
          authCode: '114514',
          verifiedUntil: '',
          deviceId: '',
        },
      });
      appConfig.save = async () => ({ ok: true });

      global.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });

      const { verifyLicense } = require(authVerifierPath);
      const startedAt = Date.now();
      const result = await verifyLicense({ silent: true });
      const elapsed = Date.now() - startedAt;

      assert.equal(result.valid, false);
      assert.equal(result.reason, 'timeout');
      assert.match(result.message, /网络超时/);
      assert.ok(elapsed < 12000, `timeout should abort promptly, got ${elapsed}ms`);
    } finally {
      appConfig.load = originalLoad;
      appConfig.save = originalSave;
      delete require.cache[authVerifierPath];
      delete require.cache[appConfigPath];
    }
  } finally {
    global.fetch = originalFetch;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldForceAuth === undefined) delete process.env.MANA_FORCE_AUTH;
    else process.env.MANA_FORCE_AUTH = oldForceAuth;
  }

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
