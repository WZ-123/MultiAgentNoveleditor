'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runDevAuthBootstrapTest() {
  const root = path.resolve(__dirname, '..');
  const appConfigPath = path.join(root, 'src/main/store/appConfig.js');
  const bootstrapPath = path.join(root, 'src/main/license/devAuthBootstrap.js');

  const oldForceAuth = process.env.MANA_FORCE_AUTH;
  const oldNodeEnv = process.env.NODE_ENV;
  const oldRelayUrl = process.env.MANA_DEV_AUTH_RELAY_URL;
  const oldRelayKey = process.env.MANA_DEV_AUTH_RELAY_API_KEY;

  try {
    process.env.MANA_FORCE_AUTH = '1';
    process.env.NODE_ENV = 'production';
    process.env.MANA_DEV_AUTH_RELAY_URL = 'http://127.0.0.1:8789';
    process.env.MANA_DEV_AUTH_RELAY_API_KEY = 'mana-dev-relay-key';

    delete require.cache[appConfigPath];
    delete require.cache[bootstrapPath];

    const appConfig = require(appConfigPath);
    const originalLoad = appConfig.load;
    const originalSave = appConfig.save;

    try {
      appConfig.load = async () => ({
        feishuSync: {
          enabled: true,
          endpointProfile: 'dev',
          relayUrl: '',
          relayApiKey: '',
        },
      });

      let savedPatch = null;
      appConfig.save = async (patch) => {
        savedPatch = patch;
        return patch;
      };

      const { ensureDevAuthRelayConfig } = require(bootstrapPath);
      const result = await ensureDevAuthRelayConfig();

      assert.equal(result.seeded, true);
      assert.equal(savedPatch.feishuSync.relayUrl, 'http://127.0.0.1:8789');
      assert.equal(savedPatch.feishuSync.relayApiKey, 'mana-dev-relay-key');
      assert.equal(savedPatch.feishuSync.enabled, true);
      assert.equal(savedPatch.feishuSync.endpointProfile, 'dev');
    } finally {
      appConfig.load = originalLoad;
      appConfig.save = originalSave;
      delete require.cache[appConfigPath];
      delete require.cache[bootstrapPath];
    }
  } finally {
    if (oldForceAuth === undefined) delete process.env.MANA_FORCE_AUTH;
    else process.env.MANA_FORCE_AUTH = oldForceAuth;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldRelayUrl === undefined) delete process.env.MANA_DEV_AUTH_RELAY_URL;
    else process.env.MANA_DEV_AUTH_RELAY_URL = oldRelayUrl;
    if (oldRelayKey === undefined) delete process.env.MANA_DEV_AUTH_RELAY_API_KEY;
    else process.env.MANA_DEV_AUTH_RELAY_API_KEY = oldRelayKey;
  }

  console.log('TEST_PASS DEV_AUTH_BOOTSTRAP: auto-seeds relay config in forced dev auth mode');
  console.log('TEST_SUMMARY 1/1 passed, 0 failed');
  console.log('TEST_DONE');
}

module.exports = { runDevAuthBootstrapTest };

if (require.main === module) {
  runDevAuthBootstrapTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}