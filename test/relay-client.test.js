'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { RelayClient } = require('../src/main/sync/relayClient');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => handler(req, res, Buffer.concat(chunks)));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }
function reply(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

async function testBearerUploadAndIdempotency() {
  let observed = null;
  const server = await startServer((req, res, body) => {
    observed = { headers: req.headers, path: req.url, body };
    reply(res, 200, { fileToken: 'file-1', fileName: 'shot.png' });
  });
  const file = path.join(os.tmpdir(), `mana-relay-${process.pid}.png`);
  await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    const client = new RelayClient({ relayUrl: `http://127.0.0.1:${server.address().port}`, getAccessToken: async () => 'device-token' });
    const result = await client.uploadAttachment(file, 'fb-123');
    assert.equal(result.fileToken, 'file-1');
    assert.equal(observed.path, '/api/v2/feedback/upload');
    assert.equal(observed.headers.authorization, 'Bearer device-token');
    assert.equal(observed.headers['x-feedback-id'], 'fb-123');
    assert.match(observed.headers['x-attachment-sha256'], /^[a-f0-9]{64}$/);
    assert.equal(observed.headers['idempotency-key'], `fb-123:${observed.headers['x-attachment-sha256']}`);
    assert.equal(observed.headers['x-relay-api-key'], undefined);
  } finally {
    await fs.rm(file, { force: true });
    await close(server);
  }
}

async function testSingleRefreshOn401() {
  let requests = 0;
  const tokens = [];
  const server = await startServer((req, res) => {
    requests += 1;
    tokens.push(req.headers.authorization);
    if (requests === 1) reply(res, 401, { code: 'token_expired', diagnosticId: 'diag-1' });
    else reply(res, 200, { recordId: 'record-1', status: 'created' });
  });
  try {
    const calls = [];
    const client = new RelayClient({
      relayUrl: `http://127.0.0.1:${server.address().port}`,
      getAccessToken: async (_scope, options) => { calls.push(options.forceRefresh); return options.forceRefresh ? 'fresh-token' : 'old-token'; },
    });
    const result = await client.createRecord('fb-refresh', { title: 'x' }, []);
    assert.equal(result.recordId, 'record-1');
    assert.deepEqual(calls, [false, true]);
    assert.deepEqual(tokens, ['Bearer old-token', 'Bearer fresh-token']);
  } finally {
    await close(server);
  }
}

async function testStableErrorRedaction() {
  const server = await startServer((_req, res) => reply(res, 502, { code: 'server_error', error: 'private Feishu stack and credential details' }));
  try {
    const client = new RelayClient({ relayUrl: `http://127.0.0.1:${server.address().port}`, getAccessToken: async () => 'token' });
    await assert.rejects(
      () => client.createRecord('fb-error', { title: 'x' }, []),
      (error) => error.code === 'relay_unavailable'
        && error.retryable === true
        && error.userAction === 'retry'
        && error.message === '反馈服务暂时不可用，请稍后重试。'
        && !error.message.includes('Feishu')
    );
  } finally {
    await close(server);
  }
}

async function testSubmitAndUpdateContract() {
  const bodies = [];
  const server = await startServer((req, res, body) => {
    bodies.push({ headers: req.headers, data: JSON.parse(body.toString('utf8')) });
    reply(res, 200, { recordId: bodies.length === 1 ? 'record-create' : 'record-update', status: bodies.length === 1 ? 'created' : 'updated' });
  });
  try {
    const client = new RelayClient({ relayUrl: `http://127.0.0.1:${server.address().port}`, getAccessToken: async () => 'token' });
    await client.createRecord('fb-contract', { title: 'create' }, ['file-1']);
    await client.updateRecord('fb-contract', 'record-create', { title: 'update' }, ['file-1']);
    assert.equal(bodies[0].headers['idempotency-key'], 'fb-contract');
    assert.equal(bodies[0].data.remoteRecordId, undefined);
    assert.equal(bodies[1].data.remoteRecordId, 'record-create');
    assert.equal(bodies[0].headers['x-relay-api-key'], undefined);
  } finally {
    await close(server);
  }
}

async function run() {
  const tests = [testBearerUploadAndIdempotency, testSingleRefreshOn401, testStableErrorRedaction, testSubmitAndUpdateContract];
  for (const test of tests) { await test(); console.log(`PASS ${test.name}`); }
  console.log(`TEST_PASS relay-client ${tests.length}/${tests.length}`);
}

if (require.main === module) run().catch((error) => {
  console.error(`TEST_FAIL relay-client: ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { run };
