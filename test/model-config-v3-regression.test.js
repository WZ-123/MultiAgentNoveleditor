'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  const userRoot = path.join(ROOT, 'tmp-test-model-config-v3');
  process.env.MANA_USER_DATA_ROOT = userRoot;
  await fs.rm(userRoot, { recursive: true, force: true });
  await fs.mkdir(userRoot, { recursive: true });
  await fs.writeFile(path.join(userRoot, 'providers.json'), JSON.stringify({
    schemaVersion: 2,
    activeProviderId: 'primary',
    providers: [{
      id: 'primary', name: 'Primary', type: 'anthropic', baseUrl: 'https://primary.invalid/anthropic', apiKey: 'primary-secret',
      models: [{ id: 'primary-model', name: 'Primary Model', contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: true }],
    }],
  }));
  await fs.writeFile(path.join(userRoot, 'modelAliases.json'), JSON.stringify({
    schemaVersion: 2,
    aliases: [
      { id: 'opus', providerId: 'primary', modelId: 'primary-model', contextWindow: 300000, maxOutputTokens: 12000, thinking: true, thinkingBudget: 8000 },
      { id: 'sonnet', providerId: 'primary', modelId: 'primary-model', maxOutputTokens: 8000 },
      { id: 'haiku', providerId: 'primary', modelId: 'primary-model', maxOutputTokens: 4000 },
    ],
  }));

  const modelConfig = require('../src/main/modelConfig');
  const { createProfileProvider } = require('../src/main/runtime/profileProvider');
  const anthropic = require('../src/main/runtime/providers/anthropic');
  const { assembleProviderContext } = require('../src/main/runtime/contextAssembler');

  try {
    let snapshot = await modelConfig.publicSnapshot();
    assert.equal(snapshot.schemaVersion, 3);
    const primaryPublic = snapshot.providers.find((provider) => provider.id === 'primary');
    assert.equal(primaryPublic.auth.hasApiKey, true);
    assert.equal(primaryPublic.apiKey, undefined);
    assert.equal((await fs.readFile(path.join(userRoot, 'model-config.json'), 'utf8')).includes('primary-secret'), false);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(userRoot, 'model-config.json'))).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.join(userRoot, 'secrets.json'))).mode & 0o777, 0o600);
    }
    const migratedOpus = snapshot.profiles.find((profile) => profile.id === 'profile-deep-reasoning');
    assert.equal(migratedOpus.targetsByDriver['direct-api'].primary.params.contextLimit, 300000);
    assert.equal(snapshot.providers.find((provider) => provider.id === 'primary').models[0].capabilities.contextWindow, 300000);

    await modelConfig.saveProvider({ name: '中文服务商', adapterId: 'openai-chat-completions', baseUrl: 'https://cn.invalid/v1' }, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    const chineseProvider = snapshot.providers.find((provider) => provider.name === '中文服务商');
    assert.match(chineseProvider.id, /^provider-[0-9a-f-]+$/);
    await modelConfig.saveProfile({ name: '长篇中文写作', targetsByDriver: {} }, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    assert.match(snapshot.profiles.find((item) => item.name === '长篇中文写作').id, /^profile-[0-9a-f-]+$/);

    snapshot = await modelConfig.saveProvider({
      id: 'backup', name: 'Backup', adapterId: 'anthropic-messages', baseUrl: 'https://backup.invalid/anthropic', apiKey: 'backup-secret',
      models: [{ id: 'backup-model', name: 'Backup Model', capabilities: { contextWindow: 300000, maxOutputTokens: 12000, supportsThinking: true, thinkingBudget: 8000 } }],
    }, snapshot.revision).then(() => modelConfig.publicSnapshot());

    const profile = snapshot.profiles.find((item) => item.id === 'profile-deep-reasoning');
    profile.targetsByDriver['direct-api'].fallbacks = [{
      id: 'target-backup', providerId: 'backup', modelId: 'backup-model', params: { contextLimit: 300000, maxOutputTokens: 12000, thinking: true, thinkingBudget: 8000 },
    }];
    await modelConfig.saveProfile(profile, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    await modelConfig.saveRouting({ subagentAssignments: { 'sa-test': 'profile-fast-utility' } }, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();

    assert.equal((await modelConfig.resolvePreview({ driverId: 'direct-api', subagentId: 'sa-test' }))[0].profileId, 'profile-fast-utility');
    assert.equal((await modelConfig.resolvePreview({ driverId: 'direct-api', subagentId: 'sa-test', dagModelProfileId: 'profile-longform-writing' }))[0].profileId, 'profile-longform-writing');
    assert.equal((await modelConfig.resolvePreview({ driverId: 'direct-api', subagentId: 'sa-test', modelProfileId: 'profile-deep-reasoning' }))[0].profileId, 'profile-deep-reasoning');

    // A stale encrypted record is not a configured key. It can happen after a
    // macOS keychain reset or when app identity changes between builds.
    const secretPath = path.join(userRoot, 'secrets.json');
    const secretStore = JSON.parse(await fs.readFile(secretPath, 'utf8'));
    secretStore.records['provider:backup:api-key'] = { plain: false, value: 'not-a-valid-safe-storage-record' };
    await fs.writeFile(secretPath, JSON.stringify(secretStore));
    const unreadableProfile = snapshot.profiles.find((item) => item.id === 'profile-fast-utility');
    unreadableProfile.targetsByDriver['direct-api'].primary = {
      id: 'target-unreadable-key', providerId: 'backup', modelId: 'backup-model', params: { maxOutputTokens: 128 },
    };
    await modelConfig.saveProfile(unreadableProfile, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    assert.equal(snapshot.providers.find((provider) => provider.id === 'backup').auth.hasApiKey, false);
    assert.notEqual(snapshot.providers.find((provider) => provider.id === 'backup').auth.keyStatus, 'missing');
    await assert.rejects(
      () => modelConfig.resolveTargets({ driverId: 'direct-api', modelProfileId: 'profile-fast-utility' }),
      /已保存但无法从系统安全存储读取/
    );
    secretStore.records['provider:backup:api-key'] = { plain: true, value: 'backup-secret' };
    await fs.writeFile(secretPath, JSON.stringify(secretStore));

    const imported = await modelConfig.importLegacyRendererConfig({
      agent1: { providerId: 'legacy-openai', baseUrl: 'https://legacy.invalid/v1', apiKey: 'legacy-secret', model: 'legacy-model', useMock: false },
    });
    assert.equal(imported.imported, 1);
    const importedPreview = await modelConfig.resolvePreview({ driverId: 'direct-api', subagentId: 'sa-outline-drafter' });
    assert.equal(importedPreview[0].modelId, 'legacy-model');
    assert.equal((await fs.readFile(path.join(userRoot, 'model-config.json'), 'utf8')).includes('legacy-secret'), false);

    const originalSend = anthropic.sendMessage;
    const calls = [];
    anthropic.sendMessage = async ({ tier, onEvent }) => {
      calls.push(tier.model);
      if (tier.model === 'primary-model') {
        const err = new Error('service unavailable');
        err.httpStatus = 503;
        throw err;
      }
      onEvent?.({ kind: 'text', data: { delta: 'ok' } });
      return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' };
    };
    const routed = await createProfileProvider({ modelProfileId: 'profile-deep-reasoning' });
    const success = await routed.provider.sendMessage({ messages: [], tier: routed.tier });
    assert.equal(success.content[0].text, 'ok');
    assert.deepEqual(calls, ['primary-model', 'backup-model']);

    calls.length = 0;
    anthropic.sendMessage = async ({ tier, onEvent }) => {
      calls.push(tier.model);
      if (tier.model === 'primary-model') {
        onEvent?.({ kind: 'text', data: { delta: 'partial' } });
        const err = new Error('stream failed');
        err.httpStatus = 503;
        throw err;
      }
      return { content: [{ type: 'text', text: 'unexpected' }] };
    };
    await assert.rejects(() => routed.provider.sendMessage({ messages: [], tier: routed.tier, onEvent: () => {} }), /stream failed/);
    assert.deepEqual(calls, ['primary-model']);
    anthropic.sendMessage = originalSend;

    await assert.rejects(() => modelConfig.deleteProvider('primary'), (err) => err.code === 'PROVIDER_IN_USE');

    const hugeMessages = Array.from({ length: 12 }, (_, idx) => ({ role: 'user', content: [{ type: 'text', text: `${idx}:` + 'x'.repeat(3000) }] }));
    const assembled = assembleProviderContext({ system: 's', messages: hugeMessages, modelLimits: { contextWindow: 3000, maxOutputTokens: 1000 } });
    assert.ok(assembled.messages.length < hugeMessages.length);
    assert.ok(assembled.stats.omittedMessages > 0);

    console.log('TEST_PASS model-config-v3-regression');
  } finally {
    await fs.rm(userRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { run };
