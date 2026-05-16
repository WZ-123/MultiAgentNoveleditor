'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function runProviderManagerRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-provider-manager-userdata');

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

  const userRoot = process.env.MANA_USER_DATA_ROOT;
  const providersFile = path.join(userRoot, 'providers.json');
  let providerManager = null;

  try {
    await fs.rm(userRoot, { recursive: true, force: true });
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(providersFile, JSON.stringify({
      schemaVersion: 2,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          type: 'anthropic',
          baseUrl: '',
          apiKey: '',
          isBuiltin: true,
          models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 }],
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiKey: 'sk-test',
          isBuiltin: false,
          models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 200000 }],
        },
      ],
      activeProviderId: 'deepseek-v4-pro',
    }, null, 2), 'utf8');

    const providerManagerPath = path.join(ROOT, 'src/main/providerManager');
    delete require.cache[require.resolve(providerManagerPath)];
    providerManager = require(providerManagerPath);

    const active = await providerManager.getActiveProvider();
    const current = await providerManager.current();
    const byName = await providerManager.getProvider('DeepSeek V4 Pro');
    const diskAfterLoad = JSON.parse(await fs.readFile(providersFile, 'utf8'));

    if (active?.type === 'anthropic' && current?.id === 'deepseek-v4-pro' && byName?.id === 'deepseek-v4-pro') {
      pass('PM1_provider_type_is_inferred_and_getProvider_normalizes_name', 'missing provider.type was inferred and provider lookup accepts display names');
    } else {
      fail('PM1_provider_type_is_inferred_and_getProvider_normalizes_name', JSON.stringify({ active, current, byName }));
    }

    const persistedType = (diskAfterLoad.providers || []).find((p) => p.id === 'deepseek-v4-pro')?.type;
    if (persistedType === 'anthropic') {
      pass('PM2_provider_upgrade_is_persisted_to_disk', 'upgraded provider type was written back to providers.json');
    } else {
      fail('PM2_provider_upgrade_is_persisted_to_disk', JSON.stringify(diskAfterLoad));
    }
  } catch (err) {
    fail('PM3_harness', err?.message || String(err));
  } finally {
    try {
      await fs.rm(userRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runProviderManagerRegressionTest };

if (require.main === module) {
  runProviderManagerRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}