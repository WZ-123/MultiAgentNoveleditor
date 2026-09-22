'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoveryPreview } = require('../src/main/modelConfig/providerTemplates');
const { discoverConnection, normalizeDiscoveredModel } = require('../src/main/modelConfig/connectionDiscovery');

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-model-v6-'));
  process.env.MANA_USER_DATA_ROOT = root;
  await fsp.writeFile(path.join(root, 'providers.json'), JSON.stringify({ providers: [{ id: 'shared', apiKey: 'recoverable-key' }] }));
  await fsp.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ schemaVersion: 2, records: { 'provider:shared:api-key': { legacy: true, revision: 1 } } }));
  await fsp.writeFile(path.join(root, 'model-config.json'), JSON.stringify({
    schemaVersion: 4,
    providers: [
      { id: 'first', name: '旧连接 A', adapterId: 'openai-chat-completions', baseUrl: 'https://one.invalid/v1', auth: { secretRef: 'provider:shared:api-key', mode: 'bearer', headerName: 'Authorization' }, models: [{ id: 'model-a', capabilities: { contextWindow: 100000 } }] },
      { id: 'second', name: '旧连接 B', adapterId: 'anthropic-messages', baseUrl: 'https://two.invalid/anthropic', auth: { secretRef: 'provider:shared:api-key', mode: 'x-api-key', headerName: 'x-api-key' }, models: [{ id: 'model-b', capabilities: { maxOutputTokens: 8000 } }] },
    ],
  }));
  const modelConfig = require('../src/main/modelConfig');
  try {
    const migrated = await modelConfig.load();
    assert.equal(migrated.schemaVersion, 8);
    assert.equal(migrated.credentials.length, 1, 'same secretRef must become one reusable credential');
    assert.equal(migrated.connections.length, 2);
    assert.equal(migrated.activeSelection, null);
    assert.equal(migrated.connections[1].auth.headerName, 'x-api-key');
    assert.equal(migrated.connections[0].models[0].capabilities.maxOutputTokens, null, 'unknown values must not be guessed');
    const recovered = await modelConfig.credentialSecret(migrated.credentials[0].id);
    assert.equal(recovered.value, 'recoverable-key');

    await modelConfig.updateModelVerification({ connectionId: migrated.connections[0].id, modelId: 'model-a', mode: 'responses', ok: true, credentialRevision: recovered.revision });
    await modelConfig.setActive({ connectionId: migrated.connections[0].id, modelId: 'model-a', reasoningEffort: null });
    assert.equal((await modelConfig.load()).activeSelection.modelId, 'model-a');
    await modelConfig.saveCredential({ id: migrated.credentials[0].id, name: '共享 Key', apiKey: 'rotated-key' });
    const rotated = await modelConfig.load();
    assert.equal(rotated.connections[0].models[0].verification.responses, 'unknown', 'key rotation invalidates verification');
    await assert.rejects(() => modelConfig.deleteCredential(migrated.credentials[0].id), (cause) => cause.code === 'credential_in_use');

    const preview = discoveryPreview({ inputUrl: 'https://gateway.invalid/v1/responses?api-version=2026-01-01', templateId: 'generic', authMode: 'auto' });
    assert.deepEqual(preview.candidates.map((item) => item.modelsUrl), ['https://gateway.invalid/v1/models?api-version=2026-01-01']);
    assert.equal(preview.queryParams['api-version'], '2026-01-01');
    const deepseekPreview = discoveryPreview({ inputUrl: 'https://api.deepseek.com/anthropic', templateId: 'auto', authMode: 'auto' });
    assert.equal(deepseekPreview.candidates[0].baseUrl, 'https://api.deepseek.com');
    assert.equal(deepseekPreview.candidates[0].modelsUrl, 'https://api.deepseek.com/models');
    assert.equal(deepseekPreview.candidates.some((item) => item.baseUrl.includes('/anthropic')), false, 'legacy Anthropic path must not be treated as a Responses base');
    const requests = [];
    const result = await discoverConnection({
      inputUrl: 'https://gateway.invalid/v1/responses?api-version=2026-01-01', templateId: 'generic', authMode: 'auto', apiKey: 'same-key', approvedCandidateUrls: preview.candidates.map((item) => item.modelsUrl),
    }, { fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers, redirect: options.redirect });
      if (requests.length === 1) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ data: [{ id: 'responses-model', display_name: 'Responses Model', context_window: 256000, supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text', 'image'] } }] }), { status: 200 });
    } });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.Authorization, 'Bearer same-key');
    assert.equal(requests[1].headers['x-api-key'], 'same-key');
    assert.equal(requests[1].redirect, 'manual');
    assert.equal(result.auth.headerName, 'x-api-key');
    assert.equal(result.models[0].capabilities.contextWindow, 256000);
    assert.equal(result.models[0].capabilities.maxOutputTokens, null);
    assert.equal(result.models[0].capabilities.supportsTools, true);
    assert.deepEqual(result.models[0].capabilities.inputModalities, ['text', 'image']);

    const beforeSubscription = await modelConfig.load();
    const withSubscription = await modelConfig.saveCodexSubscription([
      { id: 'gpt-5.6-sol', capabilities: { reasoningEfforts: ['low', 'medium'] } },
      { id: 'gpt-5.6-luna', capabilities: { reasoningEfforts: ['low', 'medium', 'high'] } },
    ], beforeSubscription.revision);
    const subscription = withSubscription.connections.find((item) => item.kind === 'codexSubscription');
    assert.ok(subscription, 'subscription login persists a managed connection');
    assert.equal(subscription.credentialId, '');
    assert.equal(subscription.baseUrl, '');
    assert.deepEqual(withSubscription.activeSelection, beforeSubscription.activeSelection, 'refresh preserves current selection');
    await modelConfig.setActive({ connectionId: 'codex-subscription', modelId: 'gpt-5.6-luna', reasoningEffort: 'medium' });
    const subscriptionRoute = await modelConfig.activeRoute();
    assert.equal(subscriptionRoute.modelProvider, 'openai');
    assert.equal(subscriptionRoute.apiKey, '');

    const unknown = normalizeDiscoveredModel({ id: 'opaque-model' });
    assert.equal(unknown.capabilities.contextWindow, null);
    assert.equal(unknown.capabilities.supportsTools, null);
    await assert.rejects(() => discoverConnection({ inputUrl: 'https://gateway.invalid/v1', templateId: 'generic', authMode: 'bearer', apiKey: 'key', approvedCandidateUrls: ['https://gateway.invalid/v1/models'] }, { fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://other.invalid/models' } }) }), (cause) => cause.code === 'redirect_requires_confirmation');

    const recoveryRoot = path.join(root, 'empty-v6-recovery');
    await fsp.mkdir(recoveryRoot, { recursive: true });
    process.env.MANA_USER_DATA_ROOT = recoveryRoot;
    await fsp.writeFile(path.join(recoveryRoot, 'model-config.json'), JSON.stringify({ schemaVersion: 7, revision: 2, credentials: [], connections: [], activeSelection: null }));
    await fsp.writeFile(path.join(recoveryRoot, 'providers.json'), JSON.stringify({ schemaVersion: 2, providers: [{ id: 'legacy-kimi', name: '旧 Kimi', apiKey: 'preserved-key', baseUrl: 'https://legacy.invalid/coding', models: ['legacy-model'] }] }));
    await fsp.writeFile(path.join(recoveryRoot, 'secrets.json'), JSON.stringify({ schemaVersion: 2, records: {} }));
    const recoveredEmptyV6 = await modelConfig.load();
    assert.equal(recoveredEmptyV6.credentials.length, 1, 'an accidentally empty v6 must recover legacy credentials');
    assert.equal(recoveredEmptyV6.connections.length, 1, 'an accidentally empty v6 must recover legacy connections');
    assert.equal(recoveredEmptyV6.connections[0].models[0].id, 'legacy-model', 'string model ids must survive recovery');
    assert.equal((await modelConfig.credentialSecret(recoveredEmptyV6.credentials[0].id)).value, 'preserved-key');
    await fsp.access(path.join(recoveryRoot, 'migration-backups', 'responses-connections-v1', 'providers-pre-v6.json'));
    await fsp.access(path.join(recoveryRoot, 'migration-backups', 'responses-connections-v1', 'providers-recovery-receipt.json'));
    await fsp.writeFile(path.join(recoveryRoot, 'model-config.json'), JSON.stringify({ schemaVersion: 7, revision: 4, credentials: [], connections: [], activeSelection: null }));
    assert.equal((await modelConfig.load()).credentials.length, 0, 'recovery receipt must prevent deleted credentials from being resurrected');

    const v6Root = path.join(root, 'v6-to-v7');
    await fsp.mkdir(v6Root, { recursive: true });
    process.env.MANA_USER_DATA_ROOT = v6Root;
    const v6 = {
      schemaVersion: 6, revision: 9,
      credentials: [{ id: 'credential-a', name: 'A', secretRef: 'credential:a' }],
      connections: [{ id: 'connection-a', name: 'A', credentialId: 'credential-a', baseUrl: 'https://api.invalid/v1', models: [{ id: 'model-a' }] }],
      activeSelection: null,
    };
    await fsp.writeFile(path.join(v6Root, 'model-config.json'), JSON.stringify(v6));
    await fsp.writeFile(path.join(v6Root, 'secrets.json'), JSON.stringify({ schemaVersion: 2, records: {} }));
    const upgraded = await modelConfig.load();
    assert.equal(upgraded.schemaVersion, 8);
    assert.equal(upgraded.connections[0].kind, 'api');
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(v6Root, 'migration-backups', 'responses-connections-v1', 'model-config-pre-v7.json'), 'utf8')), v6);
    console.log('model-config-v6: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
