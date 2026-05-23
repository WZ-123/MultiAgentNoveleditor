'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runFeishuClientConfigRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const userRoot = path.join(ROOT, 'tmp-test-feishu-client-config-userdata');
  process.env.MANA_USER_DATA_ROOT = userRoot;

  const appConfigPath = path.join(ROOT, 'src/main/store/appConfig.js');
  const appConfigFile = path.join(userRoot, 'app-config.json');

  try {
    fs.rmSync(userRoot, { recursive: true, force: true });
    delete require.cache[appConfigPath];
    const appConfig = require(appConfigPath);

    const saved = await appConfig.save({
      feishuSync: {
        enabled: true,
        endpointProfile: 'prod',
        relayUrl: 'https://relay.example.test',
        relayApiKey: 'relay-key',
        appId: 'legacy-app-id',
        appSecret: 'legacy-secret',
        appToken: 'legacy-token',
        tableId: 'legacy-table',
      },
    });

    assert.equal(saved.feishuSync.relayUrl, 'https://relay.example.test');
    assert.equal(saved.feishuSync.relayApiKey, 'relay-key');
    assert.equal(saved.feishuSync.appSecret, undefined);
    assert.equal(saved.feishuSync.appToken, undefined);
    assert.equal(saved.feishuSync.tableId, undefined);
    pass('FEISHU1_save_strips_direct_credentials', 'appConfig.save keeps relay config only');

    const raw = JSON.parse(fs.readFileSync(appConfigFile, 'utf8'));
    assert.equal(raw.feishuSync.relayUrl, 'https://relay.example.test');
    assert.equal(raw.feishuSync.relayApiKey, 'relay-key');
    assert.equal(raw.feishuSync.appId, undefined);
    assert.equal(raw.feishuSync.appSecret, undefined);
    assert.equal(raw.feishuSync.appToken, undefined);
    assert.equal(raw.feishuSync.tableId, undefined);
    pass('FEISHU2_disk_config_strips_direct_credentials', 'app-config.json no longer persists direct Feishu keys');

    raw.feishuSync.appSecret = 'stale-secret';
    raw.feishuSync.appToken = 'stale-token';
    raw.feishuSync.tableId = 'stale-table';
    fs.writeFileSync(appConfigFile, JSON.stringify(raw, null, 2));

    delete require.cache[appConfigPath];
    const reloadedAppConfig = require(appConfigPath);
    const loaded = await reloadedAppConfig.load();
    assert.equal(loaded.feishuSync.relayUrl, 'https://relay.example.test');
    assert.equal(loaded.feishuSync.relayApiKey, 'relay-key');
    assert.equal(loaded.feishuSync.appSecret, undefined);
    assert.equal(loaded.feishuSync.appToken, undefined);
    assert.equal(loaded.feishuSync.tableId, undefined);
    pass('FEISHU3_load_ignores_legacy_direct_credentials', 'legacy direct Feishu fields are dropped during load');
  } catch (err) {
    fail('FEISHU_client_config_regression', err?.message || String(err));
  } finally {
    fs.rmSync(userRoot, { recursive: true, force: true });
    delete require.cache[appConfigPath];
    delete process.env.MANA_USER_DATA_ROOT;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runFeishuClientConfigRegressionTest };

if (require.main === module) {
  runFeishuClientConfigRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}