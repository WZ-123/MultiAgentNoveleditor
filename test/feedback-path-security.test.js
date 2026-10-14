'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-feedback-security-'));
  process.env.MANA_USER_DATA_ROOT = root;
  const store = require('../src/main/store/feedbackOutbox');
  const { FeedbackSyncWorker } = require('../src/main/sync/feedbackSyncWorker');
  const { RelayClient } = require('../src/main/sync/relayClient');
  const worker = new FeedbackSyncWorker({ sessionManager: { getRelayBaseUrl: async () => 'http://127.0.0.1:1', getAccessToken: async () => 'fixture' } });
  const originalLoad = Module._load;
  const handlers = new Map();
  const electron = { ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) } };
  Module._load = function(request, parent, ...args) {
    if (request === 'electron') return electron;
    if (request === '../index' && /ipc[/\\]feedback/.test(parent.filename)) return { getFeedbackSyncWorker: () => worker };
    return originalLoad.call(this, request, parent, ...args);
  };
  const bridge = require('../src/main/lan/ipcBridge');
  bridge.install();
  require('../src/main/ipc/feedback').registerFeedbackIpc();
  require('../src/main/ipc/feedbackSync').registerFeedbackSyncIpc();
  const remote = require('../src/main/lan/remoteServer');
  let checks = 0;
  const test = async (name, fn) => { await fn(); checks++; console.log('PASS feedback-security ' + name); };
  const invoke = (name, payload, event = {}) => handlers.get('mana:feedback:' + name)(event, payload);
  const originalRequest = RelayClient.prototype._authorizedRequest;
  const uploads = [];
  RelayClient.prototype._authorizedRequest = async function(scope, factory) {
    const request = factory('fixture');
    if (scope === 'feedback:upload') uploads.push(request.body);
    return { statusCode: 200, data: { fileToken: 'fixture-file', recordId: 'fixture-record' } };
  };
  try {
    const sentinel = path.join(root, 'sentinel.json');
    await fs.writeFile(sentinel, '{"marker":"untouched"}');
    await test('invalid IDs rejected across storage and IPC', async () => {
      for (const id of ['../sentinel', '..\\sentinel', '/tmp/sentinel', 'C:\\sentinel', 'fb/a', 'fb%2f..', 'fb\u0000x', '中文', 'index', '.', '..', 'a'.repeat(129), 7, {}, ' fb-x']) {
        assert.throws(() => store.feedbackPath(id));
        await assert.rejects(store.submitFeedback({ feedbackId: id }));
        await assert.rejects(store.getRecord(id));
        await assert.rejects(store.updateSyncMeta(id, { syncStatus: 'sent' }));
        for (const [name, payload] of [['submit', { payload: { feedbackId: id } }], ['getRecord', { feedbackId: id }], ['retrySync', { feedbackId: id }]]) assert.equal((await invoke(name, payload)).ok, false);
      }
      assert.equal(await fs.readFile(sentinel, 'utf8'), '{"marker":"untouched"}');
    });
    await test('duplicate concurrent submissions retain first record and attachment', async () => {
      const payload = { feedbackId: 'fb-duplicate', userInput: { issueTitle: 'original' } };
      const options = { attachments: [{ fileName: 'shot.png', data: Buffer.from('original') }] };
      const attempts = await Promise.allSettled([store.submitFeedback(payload, options), store.submitFeedback({ ...payload, userInput: { issueTitle: 'replacement' } }, options)]);
      assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(attempts[1].reason.code, 'feedback_id_duplicate');
      const record = await store.getRecord(payload.feedbackId);
      assert.equal(record.payload.userInput.issueTitle, 'original');
      assert.equal((await store.readAttachment(payload.feedbackId, record.payload.attachments[0])).toString(), 'original');
    });
    await test('parallel records retained in index', async () => {
      await Promise.all(Array.from({ length: 8 }, (_, index) => store.submitFeedback({ feedbackId: `fb-parallel-${index}` })));
      const ids = (await store.readIndex()).items.map(item => item.feedbackId);
      assert.equal(ids.filter(id => id.startsWith('fb-parallel-')).length, 8);
    });
    await test('failed publication leaves no partial record and can be retried', async () => {
      const originalLink = fs.link;
      fs.link = async () => { throw Object.assign(new Error('isolated publication failure'), { code: 'EIO' }); };
      try { await assert.rejects(store.submitFeedback({ feedbackId: 'fb-publication' }, { attachments: [{ fileName: 'shot.png', data: Buffer.from('retryable') }] }), error => error.code === 'EIO'); }
      finally { fs.link = originalLink; }
      assert.equal(await store.getRecord('fb-publication'), null);
      await assert.rejects(fs.access(store.attachmentPath('fb-publication', 'shot.png')));
      await store.submitFeedback({ feedbackId: 'fb-publication' });
      assert.equal((await store.getRecord('fb-publication')).feedbackId, 'fb-publication');
    });
    await test('safe legacy records remain readable and syncable', async () => {
      const id = 'fb-mabc1234-abc123';
      const fileName = 'screenshot.png';
      const localPath = store.attachmentPath(id, fileName);
      await fs.writeFile(localPath, 'legacy-image');
      await fs.writeFile(store.feedbackPath(id), JSON.stringify({ feedbackId: id, syncStatus: 'pending', retryCount: 0, payload: { feedbackId: id, userInput: { issueTitle: 'legacy' }, attachments: [{ kind: 'window-screenshot', fileName, localPath }] } }));
      assert.ok((await store.listPendingForSync()).some(record => record.feedbackId === id));
      await worker.retryRecord(id);
      assert.equal((await store.getRecord(id)).syncStatus, 'sent');
      assert.ok(uploads.some(buffer => buffer.includes(Buffer.from('legacy-image'))));
    });
    await test('attachment names cannot escape or silently replace each other', async () => {
      assert.throws(() => store.attachmentPath('fb-safe', '../x'));
      const result = await store.submitFeedback({ feedbackId: 'fb-names' }, { attachments: [{ fileName: '../截图.png', data: Buffer.from('one') }, { fileName: '../截图.png', data: Buffer.from('two') }] });
      assert.equal(new Set(result.attachments.map(item => item.localPath)).size, 2);
      assert.ok(result.attachments.every(item => path.dirname(item.localPath) === path.resolve(store.outboxDir())));
      assert.equal((await store.readAttachment(result.feedbackId, result.attachments[0])).toString(), 'one');
      assert.equal((await store.readAttachment(result.feedbackId, result.attachments[1])).toString(), 'two');
    });
    await test('record and index symlinks rejected without touching targets', async () => {
      await fs.symlink(sentinel, store.feedbackPath('fb-link'));
      await assert.rejects(store.getRecord('fb-link'));
      await assert.rejects(store.updateSyncMeta('fb-link', {}));
      await assert.rejects(store.submitFeedback({ feedbackId: 'fb-link' }));
      assert.ok(!(await store.listAllRecords()).some(record => record.feedbackId === 'fb-link'));
      const indexFile = path.join(store.outboxDir(), 'index.json');
      const priorIndex = await fs.readFile(indexFile);
      await fs.unlink(indexFile);
      await fs.symlink(sentinel, indexFile);
      await assert.rejects(store.submitFeedback({ feedbackId: 'fb-index-link' }));
      await fs.unlink(indexFile);
      await fs.writeFile(indexFile, priorIndex);
      assert.equal(await fs.readFile(sentinel, 'utf8'), '{"marker":"untouched"}');
    });
    await test('forged attachment paths and symlinks never uploaded', async () => {
      const count = uploads.length;
      for (const id of ['fb-forged', 'fb-shot-link']) {
        const localPath = store.attachmentPath(id, 'shot.png');
        await store.submitFeedback({ feedbackId: id });
        if (id === 'fb-shot-link') await fs.symlink(sentinel, localPath);
        const record = await store.getRecord(id);
        record.payload.attachments = [{ kind: 'window-screenshot', fileName: 'shot.png', localPath: id === 'fb-forged' ? sentinel : localPath }];
        await fs.writeFile(store.feedbackPath(id), JSON.stringify(record));
        await worker.retryRecord(id);
        const failed = await store.getRecord(id);
        assert.equal(failed.syncStatus, 'failed_terminal');
        assert.equal(failed.lastErrorCode, 'feedback_path_invalid');
      }
      assert.equal(uploads.length, count);
    });
    await test('mismatched and malformed records isolated from valid records', async () => {
      await fs.writeFile(store.feedbackPath('fb-mismatch'), '{"feedbackId":"../sentinel","syncStatus":"pending"}');
      await fs.writeFile(store.feedbackPath('fb-malformed'), '{bad json');
      await assert.rejects(store.getRecord('fb-mismatch'));
      const records = await store.listAllRecords();
      assert.ok(records.some(record => record.feedbackId === 'fb-duplicate'));
      assert.ok(!records.some(record => ['../sentinel', 'fb-malformed'].includes(record.feedbackId)));
    });
    await test('IPC screenshot submission query retry and duplicate failure', async () => {
      const event = { sender: { executeJavaScript: async () => [], capturePage: async () => ({ toPNG: () => Buffer.from('captured-image') }) } };
      const result = await invoke('submit', { payload: { feedbackId: 'fb-ipc' }, options: { includeScreenshot: true } }, event);
      assert.equal(result.ok, true);
      assert.equal((await invoke('getRecord', { feedbackId: 'fb-ipc' })).value.payload.attachments.length, 1);
      assert.equal((await invoke('retrySync', { feedbackId: 'fb-ipc' })).value.ok, true);
      assert.equal((await store.getRecord('fb-ipc')).syncStatus, 'sent');
      assert.equal((await invoke('submit', { payload: { feedbackId: 'fb-ipc' } })).ok, false);
    });
    await test('authenticated LAN uses production feedback IPC handlers', async () => {
      const status = await remote.start({ port: 0, host: '127.0.0.1' });
      const origin = `http://127.0.0.1:${status.port}`;
      const auth = await fetch(origin + '/api/lan/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: status.accessCode }), redirect: 'manual' });
      const cookie = auth.headers.get('set-cookie').split(';')[0];
      const rpc = async (name, payload, authenticated = true) => {
        const response = await fetch(origin + '/api/rpc', { method: 'POST', headers: { ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mana:feedback:' + name, payload }) });
        return { status: response.status, body: await response.json() };
      };
      assert.equal((await rpc('submit', { payload: { feedbackId: 'fb-lan' } }, false)).status, 401);
      const submitted = (await rpc('submit', { payload: { feedbackId: 'fb-lan' } })).body;
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      assert.equal((await rpc('getRecord', { feedbackId: 'fb-lan' })).body.value.feedbackId, 'fb-lan');
      assert.equal((await rpc('retrySync', { feedbackId: 'fb-lan' })).body.value.ok, true);
      assert.equal((await store.getRecord('fb-lan')).syncStatus, 'sent');
      for (const [name, payload] of [['submit', { payload: { feedbackId: '../sentinel' } }], ['getRecord', { feedbackId: '../sentinel' }], ['retrySync', { feedbackId: '../sentinel' }]]) assert.equal((await rpc(name, payload)).body.ok, false);
    });
    await test('outbox directory symlink rejected', async () => {
      const otherRoot = path.join(root, 'other-root');
      await fs.mkdir(otherRoot);
      await fs.symlink(store.outboxDir(), path.join(otherRoot, 'feedback-outbox'));
      process.env.MANA_USER_DATA_ROOT = otherRoot;
      await assert.rejects(store.submitFeedback({ feedbackId: 'fb-dir-link' }));
      process.env.MANA_USER_DATA_ROOT = root;
    });
    console.log(`feedback-path-security: ok (${checks} scenarios)`);
  } finally {
    Module._load = originalLoad;
    RelayClient.prototype._authorizedRequest = originalRequest;
    await remote.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
