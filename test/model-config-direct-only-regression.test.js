'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

function target(id, providerId, modelId, temperature) {
  return {
    id,
    providerId,
    modelId,
    params: {
      contextLimit: 128000,
      maxOutputTokens: 4096,
      temperature,
      thinking: false,
      thinkingBudget: 0,
    },
  };
}

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  const userRoot = path.join(ROOT, 'tmp-test-model-config-direct-only');
  process.env.MANA_USER_DATA_ROOT = userRoot;
  await fs.rm(userRoot, { recursive: true, force: true });
  await fs.mkdir(userRoot, { recursive: true });

  const routing = {
    defaultProfileId: 'profile-direct',
    systemAssignments: { chat: 'profile-external' },
    subagentAssignments: { 'sa-writer': 'profile-direct' },
    legacyTierProfileMap: { sonnet: 'profile-direct' },
  };
  const originalDirectGroup = {
    primary: target('direct-primary', 'provider-a', 'model-a', 0.42),
    fallbacks: [
      target('direct-fallback-a', 'provider-b', 'model-b', 0.61),
      target('direct-fallback-b', 'provider-a', 'model-a', 0.73),
    ],
  };
  const externalOnlyGroup = {
    primary: target('external-missing-primary', 'missing-provider', 'missing-model', 0.11),
    fallbacks: [
      target('external-first-valid', 'provider-b', 'model-b', 0.55),
      target('external-second-valid', 'provider-a', 'model-a', 0.66),
    ],
  };
  const state = {
    schemaVersion: 3,
    revision: 7,
    providers: [
      {
        id: 'provider-a', name: 'Provider A', adapterId: 'openai-chat-completions', baseUrl: 'https://a.invalid/v1',
        auth: { mode: 'bearer', secretRef: 'provider:a:api-key', headerName: 'Authorization' },
        models: [{ id: 'model-a', name: 'Model A', capabilities: { contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false } }],
      },
      {
        id: 'provider-b', name: 'Provider B', adapterId: 'anthropic-messages', baseUrl: 'https://b.invalid',
        auth: { mode: 'x-api-key', secretRef: 'provider:b:api-key', headerName: 'x-api-key' },
        models: [{ id: 'model-b', name: 'Model B', capabilities: { contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false } }],
      },
    ],
    profiles: [
      {
        id: 'profile-direct', name: '已有 Direct 档案', priority: 'quality',
        targetsByDriver: {
          'direct-api': originalDirectGroup,
          'claude-code-vscode': { primary: target('legacy-driver-target', 'provider-b', 'model-b', 0.9), fallbacks: [] },
        },
      },
      {
        id: 'profile-external', name: '仅旧 Driver 档案', priority: 'balanced',
        targetsByDriver: { codex: externalOnlyGroup },
      },
      {
        id: 'profile-direct-recovery', name: 'Direct 备用恢复', priority: 'balanced',
        targetsByDriver: {
          'direct-api': {
            primary: target('missing-direct-primary', 'missing-provider', 'missing-model', 0.2),
            fallbacks: [
              target('missing-direct-fallback', 'provider-a', 'missing-model', 0.3),
              target('valid-direct-fallback-a', 'provider-b', 'model-b', 0.4),
              target('valid-direct-fallback-b', 'provider-a', 'model-a', 0.5),
            ],
          },
        },
      },
    ],
    routing,
    migration: { source: 'model-config-v3', warnings: ['保留原警告'] },
  };
  await fs.writeFile(path.join(userRoot, 'model-config.json'), JSON.stringify(state, null, 2));

  const modelConfig = require('../src/main/modelConfig');
  try {
    const snapshot = await modelConfig.publicSnapshot();
    assert.equal(snapshot.schemaVersion, 4);
    assert.equal(snapshot.revision, 9);
    assert.equal(snapshot.reasoningPolicyVersion, 1);
    assert.equal(snapshot.routing.systemAssignments.chat, 'profile-agent-orchestration');
    assert.equal(snapshot.routing.systemAssignments['chat-orchestration'], 'profile-agent-orchestration');
    assert.equal(snapshot.routing.systemAssignments['character-enrichment'], 'profile-agent-orchestration');
    assert.equal(snapshot.routing.systemAssignments['config-helper'], 'profile-agent-orchestration');
    assert.equal(snapshot.routing.subagentAssignments['sa-writer'], 'profile-direct');
    assert.equal(snapshot.routing.subagentAssignments['sa-prose-quality'], 'profile-agent-orchestration');
    assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['provider-a', 'provider-b']);
    assert.equal(snapshot.providers[0].auth.hasApiKey, false);

    const directProfile = snapshot.profiles.find((profile) => profile.id === 'profile-direct');
    assert.deepEqual(Object.keys(directProfile.targetsByDriver), ['direct-api']);
    assert.equal(directProfile.targetsByDriver['direct-api'].primary.id, originalDirectGroup.primary.id);
    assert.equal(directProfile.targetsByDriver['direct-api'].primary.params.temperature, 0.42);
    assert.equal(directProfile.targetsByDriver['direct-api'].primary.params.effortLevel, 'none');

    const convertedProfile = snapshot.profiles.find((profile) => profile.id === 'profile-external');
    assert.deepEqual(Object.keys(convertedProfile.targetsByDriver), ['direct-api']);
    assert.equal(convertedProfile.targetsByDriver['direct-api'].primary.providerId, 'provider-b');
    assert.equal(convertedProfile.targetsByDriver['direct-api'].primary.modelId, 'model-b');
    assert.deepEqual(
      convertedProfile.targetsByDriver['direct-api'].fallbacks.map((item) => [item.providerId, item.modelId]),
      [['provider-a', 'model-a']]
    );
    assert.equal(convertedProfile.targetsByDriver['direct-api'].primary.params.temperature, 0.55);
    const recoveredDirectProfile = snapshot.profiles.find((profile) => profile.id === 'profile-direct-recovery');
    assert.equal(recoveredDirectProfile.targetsByDriver['direct-api'].primary.id, 'valid-direct-fallback-a');
    assert.deepEqual(recoveredDirectProfile.targetsByDriver['direct-api'].fallbacks.map((item) => item.id), ['valid-direct-fallback-b']);
    assert.match(snapshot.migration.warnings.join('\n'), /保留原警告/);
    assert.match(snapshot.migration.warnings.join('\n'), /需要在模型中心绑定支持思考的模型/);
    const agentProfile = snapshot.profiles.find((profile) => profile.id === 'profile-agent-orchestration');
    assert.equal(agentProfile.targetsByDriver['direct-api'].primary.params.thinking, false);
    assert.equal(agentProfile.targetsByDriver['direct-api'].primary.params.effortLevel, 'none');

    const disk = JSON.parse(await fs.readFile(path.join(userRoot, 'model-config.json'), 'utf8'));
    assert.equal(JSON.stringify(disk).includes('claude-code-vscode'), false);
    assert.equal(JSON.stringify(disk).includes('"codex"'), false);
    assert.equal(disk.reasoningPolicyVersion, 1);
    assert.equal(disk.routing.systemAssignments.chat, 'profile-agent-orchestration');
    assert.equal(disk.routing.systemAssignments['chat-orchestration'], 'profile-agent-orchestration');
    assert.equal(disk.providers[0].auth.secretRef, 'provider:a:api-key');

    await assert.rejects(
      () => modelConfig.saveProfile({ id: 'profile-direct', name: '非法旧 Driver 档案', targetsByDriver: { codex: externalOnlyGroup } }, snapshot.revision),
      /Direct API/
    );
    assert.equal((await modelConfig.publicSnapshot()).revision, snapshot.revision);
    await assert.rejects(
      () => modelConfig.resolveTargets({ driverId: 'codex', modelProfileId: 'profile-direct' }),
      (err) => err.code === 'DIRECT_API_ONLY'
    );

    const remoteAiSource = await fs.readFile(path.join(ROOT, 'src/services/remoteAI.js'), 'utf8');
    const appSource = await fs.readFile(path.join(ROOT, 'src/App.jsx'), 'utf8');
    const mainSource = await fs.readFile(path.join(ROOT, 'src/main/index.js'), 'utf8');
    const preloadSource = await fs.readFile(path.join(ROOT, 'preload.js'), 'utf8');
    const lanRemoteSource = await fs.readFile(path.join(ROOT, 'src/main/lan/remoteServer.js'), 'utf8');
    const appConfigSource = await fs.readFile(path.join(ROOT, 'src/main/store/appConfig.js'), 'utf8');
    const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.doesNotMatch(remoteAiSource, /getAgentConfig|postChatCompletions|window\.mana\.chatCompletions/u);
    assert.doesNotMatch(remoteAiSource, /offlineMockEnabled|mockComplete|mock plain text completion/u);
    assert.match(remoteAiSource, /没有可用的 Direct API 运行时映射/u);
    assert.doesNotMatch(mainSource, /registerLegacyChatCompletionsIpc|mana-chat-completions/u);
    assert.doesNotMatch(preloadSource, /chatCompletions|mana-chat-completions/u);
    assert.doesNotMatch(lanRemoteSource, /chatCompletions|mana-chat-completions/u);
    assert.doesNotMatch(appConfigSource, /offlineMockEnabled/u);
    assert.doesNotMatch(appSource, /RuntimeDriverSettings|case 'runtime'/u);
    assert.equal(JSON.stringify(packageJson.build?.asarUnpack || []).includes('claudeCli'), false);
    await assert.rejects(() => fs.access(path.join(ROOT, 'src/services/agentApiConfig.js')));
    await assert.rejects(() => fs.access(path.join(ROOT, 'src/components/AgentApiSettings.jsx')));

    console.log('TEST_PASS model-config-direct-only-regression');
  } finally {
    await fs.rm(userRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { run };
