'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-discard-ipc-'));
  process.env.MANA_USER_DATA_ROOT = root;
  const config = require('../src/main/modelConfig');
  const handlers = new Map(), events = [];
  const electron = {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    webContents: { getAllWebContents: () => [{ send: (name, payload) => events.push({ name, payload }) }] },
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, ...args) {
    if (request === 'electron') return electron;
    if (request === '../codex-runtime' && parent?.filename.endsWith(path.join('ipc', 'modelConfig.js'))) return { getCodexSessionService: () => ({}) };
    return originalLoad.call(this, request, parent, ...args);
  };
  const bridge = require('../src/main/lan/ipcBridge');
  bridge.install();
  require('../src/main/ipc/modelConfig').registerModelConfigIpc();
  const remote = require('../src/main/lan/remoteServer');
  try {
    for (const id of ['desktop', 'lan']) {
      await config.saveCredential({ id: `setup-key-${id}`, apiKey: 'isolated-discard-secret' });
      await config.mutateState(state => state.setupOperations.push({ id, name: id, credentialId: `setup-key-${id}`, status: 'failed', stage: 'responses', error: 'isolated probe failed', updatedAt: 1 }));
    }
    await config.saveCodexSubscription([{ id: 'fixture-model', capabilities: { reasoningEfforts: ['medium'] } }]);
    await config.setActive({ connectionId: 'codex-subscription', modelId: 'fixture-model', reasoningEffort: 'medium' });
    await config.saveCredential({ id: 'shared', apiKey: 'isolated-shared-key' });
    await config.saveConnection({ id: 'saved', credentialId: 'shared', baseUrl: 'https://api.invalid/v1', models: [{ id: 'saved-model' }], templateId: 'generic' });
    const original = await config.load();
    const discard = handlers.get('mana:modelConfig:discardSetup');
    const started = await handlers.get('mana:modelConfig:startSetup')({}, {
      id: 'saved-attempt', connectionId: 'saved', credentialId: 'shared', apiKey: '', useSaved: true,
      inputUrl: 'https://api.invalid/v1', templateId: 'generic', authMode: 'bearer', modelId: 'saved-model',
      expectedRevision: original.revision, approvedCandidateUrls: ['https://api.invalid/v1/models'],
    });
    assert.equal(started.ok, true);
    assert.ok(events.some(event => event.name === 'mana:modelConfig:changed' && event.payload.action === 'setup_started'));
    assert.deepEqual(await discard({}, { id: 'saved-attempt' }), { ok: true, value: true });
    assert.deepEqual(await discard({}, { id: 'desktop' }), { ok: true, value: true });
    assert.ok(events.some(event => event.name === 'mana:modelConfig:changed' && event.payload.action === 'setup_discarded'));
    assert.deepEqual(await discard({}, { id: 'desktop' }), { ok: true, value: false });
    const status = await remote.start({ host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${status.port}`;
    const payload = { channel: 'mana:modelConfig:discardSetup', payload: { id: 'lan' } };
    const unauthorized = await fetch(origin + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(unauthorized.status, 401);
    assert.ok((await config.load()).setupOperations.some(item => item.id === 'lan'));
    const auth = await fetch(origin + '/api/lan/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: status.accessCode }), redirect: 'manual' });
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    const script = await (await fetch(origin + '/__mana_remote_bridge.js', { headers: { Cookie: cookie } })).text();
    assert.ok(script.includes("discardSetup: (id) => invoke('mana:modelConfig:discardSetup', { id })"));
    const response = await fetch(origin + '/api/rpc', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.deepEqual(await response.json(), { ok: true, value: true });
    const saved = await config.load();
    assert.deepEqual(saved.activeSelection, original.activeSelection);
    assert.deepEqual(saved.connections, original.connections);
    assert.ok(!saved.setupOperations.some(item => ['desktop', 'lan'].includes(item.id)));
    assert.ok(!saved.credentials.some(item => ['setup-key-desktop', 'setup-key-lan'].includes(item.id)));
    assert.ok((await config.credentialSecret('shared')).value);
    for (const id of ['desktop', 'lan']) await assert.rejects(config.credentialSecret(`setup-key-${id}`));
    console.log('model-config-discard-ipc: ok (desktop notifications, authorized LAN, key cleanup and active selection)');
  } finally { Module._load = originalLoad; await remote.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
