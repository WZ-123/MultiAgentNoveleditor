'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
const appConfig = require(path.join(ROOT, 'src/main/store/appConfig'));
const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
const enricher = require(path.join(ROOT, 'src/main/import/characterEnricher'));

const originalGetAlias = modelAliases.getAlias;
const originalGetActiveProvider = providerManager.getActiveProvider;
const originalInferProviderType = providerManager.inferProviderType;
const originalAppConfigLoad = appConfig.load;
const originalSendMessage = anthropicProvider.sendMessage;

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, reason) {
  console.log(`TEST_FAIL ${name}: ${reason}`);
}

async function run() {
  let failed = 0;

  try {
    modelAliases.getAlias = async () => null;
    providerManager.getActiveProvider = async () => ({
      id: 'fake-provider',
      apiKey: 'fake-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'fake-model' }],
    });
    providerManager.inferProviderType = () => 'anthropic';
    appConfig.load = async () => ({ enrichmentMode: 'llm', enrichmentConcurrency: 1, searchEngine: 'auto' });
    anthropicProvider.sendMessage = async () => ({
      content: [{ type: 'text', text: '{"appearance":"凭空编造"}' }],
    });

    const result = await enricher.enrichCharacters(
      [{ id: 'char-1', name: '不存在角色', appearance: '', personality: '', background: '' }],
      null,
      'zh-CN',
      { fanworkNameOverride: '碧蓝航线' }
    );

    assert.equal(result[0]._enrichmentStatus, 'llm-tool-required');
    assert.equal(result[0].appearance, '');
    pass('CELGR1_rejects_llm_direct_json_without_search', 'LLM direct JSON is rejected when no real tool-based search happened');
  } catch (err) {
    failed += 1;
    fail('CELGR_harness', err?.stack || String(err));
  } finally {
    modelAliases.getAlias = originalGetAlias;
    providerManager.getActiveProvider = originalGetActiveProvider;
    providerManager.inferProviderType = originalInferProviderType;
    appConfig.load = originalAppConfigLoad;
    anthropicProvider.sendMessage = originalSendMessage;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${failed ? 0 : 1}/1 passed, ${failed} failed`);
  console.log('TEST_DONE');
  if (failed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});