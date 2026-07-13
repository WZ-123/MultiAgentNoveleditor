'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function runConfigMigrationRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const userRoot = path.join(ROOT, 'tmp-test-config-migration-userdata');
  process.env.MANA_USER_DATA_ROOT = userRoot;

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

  const providersFile = path.join(userRoot, 'providers.json');
  const aliasesFile = path.join(userRoot, 'modelAliases.json');
  const appConfigFile = path.join(userRoot, 'app-config.json');

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
          type: 'anthropic',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiKey: 'sk-test',
          isBuiltin: false,
          models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 200000 }],
        },
      ],
      activeProviderId: 'deepseek-v4-pro',
    }, null, 2), 'utf8');

    await fs.writeFile(aliasesFile, JSON.stringify({
      schemaVersion: 1,
      aliases: [
        {
          id: 'sonnet',
          displayName: 'Sonnet',
          providerId: 'DeepSeek V4 Pro',
          modelId: 'deepseek-v4-pro',
          maxOutputTokens: 8192,
        },
      ],
    }, null, 2), 'utf8');

    await fs.writeFile(appConfigFile, JSON.stringify({
      schemaVersion: 1,
      language: 'system',
      drivers: {
        'direct-api': {},
        codex: { binPath: '/tmp/codex' },
      },
    }, null, 2), 'utf8');

    const providerManagerPath = path.join(ROOT, 'src/main/providerManager');
    const modelAliasesPath = path.join(ROOT, 'src/main/modelAliases');
    const appConfigPath = path.join(ROOT, 'src/main/store/appConfig');
    delete require.cache[require.resolve(providerManagerPath)];
    delete require.cache[require.resolve(modelAliasesPath)];
    delete require.cache[require.resolve(appConfigPath)];

    require(providerManagerPath);
    const modelAliases = require(modelAliasesPath);
    const appConfig = require(appConfigPath);

    const alias = await modelAliases.getAlias('sonnet');
    const modelConfigDisk = JSON.parse(await fs.readFile(path.join(userRoot, 'model-config.json'), 'utf8'));
    const migratedProfile = modelConfigDisk.profiles?.find((profile) => profile.id === 'profile-longform-writing');
    if (alias?.providerId === 'deepseek-v4-pro' && migratedProfile?.targetsByDriver?.['direct-api']?.primary?.providerId === 'deepseek-v4-pro') {
      pass('CFG1_alias_provider_name_is_migrated_to_provider_id', 'legacy alias provider name was normalized into the unified model profile');
    } else {
      fail('CFG1_alias_provider_name_is_migrated_to_provider_id', JSON.stringify({ alias, modelConfigDisk }));
    }

    const cfg = await appConfig.load();
    const appConfigDisk = JSON.parse(await fs.readFile(appConfigFile, 'utf8'));
    if (
      cfg.activeDriverId === 'direct-api' &&
      cfg.drivers?.['direct-api']?.kind === 'direct-api' &&
      cfg.drivers?.codex?.kind === 'codex' &&
      appConfigDisk.activeDriverId === 'direct-api' &&
      appConfigDisk.drivers?.['claude-code-vscode']?.kind === 'claude-code-vscode'
    ) {
      pass('CFG2_app_config_driver_discriminants_are_backfilled_and_persisted', 'missing activeDriverId and driver.kind values were normalized to disk');
    } else {
      fail('CFG2_app_config_driver_discriminants_are_backfilled_and_persisted', JSON.stringify({ cfg, appConfigDisk }));
    }
  } catch (err) {
    fail('CFG3_harness', err?.message || String(err));
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

module.exports = { runConfigMigrationRegressionTest };

if (require.main === module) {
  runConfigMigrationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
