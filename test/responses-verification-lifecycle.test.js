'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-probe-lifecycle-'));
  process.env.MANA_USER_DATA_ROOT = root;
  const config = require('../src/main/modelConfig');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  await config.saveCredential({ id: 'key', name: 'test', apiKey: 'fake' });
  await config.saveConnection({ id: 'test', credentialId: 'key', name: 'test', templateId: 'deepseek', baseUrl: 'http://127.0.0.1:1', discovery: { status: 'ok' }, models: [{ id: 'deepseek-v4-flash' }] });
  const args = { connectionId: 'test', modelId: 'deepseek-v4-flash', mode: 'responses', reasoningEffort: 'none' };
  const status = async () => (await config.load()).connections[0].models[0].verification;
  const make = () => {
    const service = new CodexSessionService();
    service.verificationTimeoutMs = 20;
    service.calls = [];
    service.processManager = { request: async (method) => service.calls.push(method) };
    service._startThread = async (route) => { service.route = route; return 'thread-test'; };
    service.archiveThread = async () => service.calls.push('archive');
    service._startNativeTurn = async () => ({ turn: { id: 'turn-test' } });
    return service;
  };
  const clean = (service) => {
    assert.equal(service.activeRuns.size, 0);
    assert.equal(service.listenerCount('event'), 0);
  };
  try {
    let service = make();
    await assert.rejects(service.verifyModel(args), { code: 'verification_timeout' });
    clean(service);
    assert.deepEqual(service.calls, ['turn/interrupt', 'archive']);
    assert.equal((await status()).errorCode, 'verification_timeout');
    assert.equal(service.route.reasoningEffort, 'none');
    service = make();
    service._startNativeTurn = async () => { throw new Error('start rejected'); };
    await assert.rejects(service.verifyModel(args), /start rejected/);
    clean(service);
    assert.ok(service.calls.includes('turn/interrupt'));
    service = make();
    service._startThread = async () => { throw new Error('thread rejected'); };
    await assert.rejects(service.verifyModel(args), /thread rejected/);
    clean(service);
    assert.equal((await status()).responses, 'failed');
    const prior = await status();
    service = make();
    service._startThread = async () => { throw Object.assign(new Error('busy'), { code: 'codex_turn_active' }); };
    await assert.rejects(service.verifyModel(args), { code: 'codex_turn_active' });
    assert.deepEqual(await status(), prior);
    service = make();
    service._startNativeTurn = async () => {
      const run = [...service.activeRuns.values()][0];
      service.emit('event', { runId: run.runId, type: 'turn_failed', error: 'early failure' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { turn: { id: 'turn-test' } };
    };
    await assert.rejects(service.verifyModel(args), /early failure/);
    clean(service);
    service = make();
    service._startNativeTurn = async () => {
      const run = [...service.activeRuns.values()][0];
      run.text = 'I called connection_probe';
      run.items.push({ type: 'agentMessage', text: 'connection_probe' });
      service.emit('event', { runId: run.runId, type: 'turn_completed' });
      return { turn: { id: 'turn-test' } };
    };
    await assert.rejects(service.verifyModel({ ...args, mode: 'tools' }), /未完成要求/);
    clean(service);
    const cancelBaseline = await status();
    service = make();
    service.verificationTimeoutMs = 1000;
    const cancelController = new AbortController();
    service._startNativeTurn = async () => { setTimeout(() => cancelController.abort(), 2); return { turn: { id: 'turn-cancelled' } }; };
    await assert.rejects(service.verifyModel({ ...args, signal: cancelController.signal }), { code: 'setup_cancelled' });
    clean(service);
    assert.deepEqual(await status(), cancelBaseline, 'cancelled probe must not change verification');
    await config.updateModelVerification({ ...args, ok: true });
    await config.setActive({ connectionId: 'test', modelId: 'deepseek-v4-flash', reasoningEffort: 'none' });
    service = make();
    service.oneShotTimeoutMs = 20;
    await assert.rejects(service.runOneShot({ text: 'hello' }), { code: 'turn_timeout' });
    clean(service);
    assert.deepEqual(service.calls, ['turn/interrupt', 'archive']);
    service = make();
    service._startNativeTurn = async () => { throw new Error('one-shot start rejected'); };
    await assert.rejects(service.runOneShot({ text: 'hello' }), /one-shot start rejected/);
    clean(service);
    service = make();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.runOneShot({ text: 'hello', abortSignal: controller.signal }), { code: 'turn_interrupted' });
    clean(service);
    service = make();
    service.processManager.start = async () => ({ request: async (method) => {
      assert.equal(method, 'account/read'); return { account: null, requiresOpenaiAuth: false };
    } });
    service._ensureProcess = async () => { throw new Error('account refresh switched provider'); };
    assert.equal((await service.accountStatus()).account, null);
    assert.equal((await service.status()).ready, true, 'status must not switch a live provider process');
    const route = await config.connectionRoute('test', 'deepseek-v4-flash');
    const textConfig = await service._threadConfig(route, '', 'test', { includeMcp: false, disableAgents: true });
    assert.equal(textConfig.features.code_mode, false);
    assert.equal(textConfig.features.multi_agent, false);
    const toolsConfig = await service._threadConfig(route, '', 'test');
    assert.equal(toolsConfig.features.code_mode, false);
    assert.equal(toolsConfig.features.multi_agent, undefined);
    assert.equal(toolsConfig.mcp_servers.novel_tools.enabled, true);
    const subscriptionConfig = await service._threadConfig({ ...route, connection: { kind: 'codexSubscription' } }, '', 'test');
    assert.equal(subscriptionConfig.features.code_mode, undefined);
    await config.saveCredential({ id: 'key', name: 'test', apiKey: 'rotated' });
    await assert.rejects(config.updateModelVerification({ ...args, ok: true, credentialRevision: route.credentialRevision, expectedConnection: route.connection }), { code: 'verification_obsolete' });
    assert.equal((await status()).responses, 'unknown');
    const rotatedRoute = await config.connectionRoute('test', 'deepseek-v4-flash');
    await config.saveConnection({ ...rotatedRoute.connection, baseUrl: 'http://127.0.0.1:2' });
    await assert.rejects(config.updateModelVerification({ ...args, ok: true, credentialRevision: rotatedRoute.credentialRevision, expectedConnection: rotatedRoute.connection }), { code: 'verification_obsolete' });
    const freshRoute = await config.connectionRoute('test', 'deepseek-v4-flash');
    const secretStore = require('../src/main/store/secrets');
    const originalGetSecretStatus = secretStore.getSecretStatus;
    secretStore.getSecretStatus = async (...values) => {
      const result = await originalGetSecretStatus(...values);
      await config.saveConnection({ ...freshRoute.connection, baseUrl: 'http://127.0.0.1:3' });
      return result;
    };
    try {
      await assert.rejects(config.updateModelVerification({ ...args, ok: true, credentialRevision: freshRoute.credentialRevision, expectedConnection: freshRoute.connection }), { code: 'model_config_stale' });
      assert.equal((await config.load()).connections[0].baseUrl, 'http://127.0.0.1:3');
    } finally { secretStore.getSecretStatus = originalGetSecretStatus; }
    service = make();
    service._ensureProcess = async () => ({ request: async () => ({}) });
    service._resumeThread = async () => { throw new Error('reused old exec history'); };
    assert.equal(await service._bindConversation(rotatedRoute, { persistence: 'one-shot', includeMcp: true }, {
      codexBinding: { schemaVersion: 1, providerFingerprint: `${rotatedRoute.fingerprint}:tools`, threadId: 'legacy', novelId: null }, messages: [],
    }), 'thread-test');

    console.log('responses-verification-lifecycle: ok');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
