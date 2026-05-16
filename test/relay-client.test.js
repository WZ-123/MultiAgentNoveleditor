'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { RelayClient } = require('../src/main/sync/relayClient');

let server = null;
let serverPort = 0;

function startMockServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        handler(req, res, body);
      });
    });
    s.listen(0, () => {
      serverPort = s.address().port;
      resolve(s);
    });
  });
}

async function stopMockServer() {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1_relayClient_auth_header() {
  server = await startMockServer((req, res, body) => {
    assert.strictEqual(req.headers['x-relay-api-key'], 'test-key-123');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fileToken: 'ft-abc' }));
  });

  const client = new RelayClient({ relayUrl: `http://localhost:${serverPort}`, relayApiKey: 'test-key-123' });
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmpFile = path.join(os.tmpdir(), 'relay-test.png');
  fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG header

  try {
    const result = await client.uploadAttachment(tmpFile);
    assert.strictEqual(result.fileToken, 'ft-abc');
  } finally {
    fs.unlinkSync(tmpFile);
    await stopMockServer();
  }
}

async function test2_relayClient_error_classification() {
  server = await startMockServer((req, res, body) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key' }));
  });

  const client = new RelayClient({ relayUrl: `http://localhost:${serverPort}`, relayApiKey: 'wrong-key' });
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmpFile = path.join(os.tmpdir(), 'relay-test2.png');
  fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    await client.uploadAttachment(tmpFile);
    assert.fail('Expected error');
  } catch (err) {
    assert.strictEqual(err.feishuError?.type, 'terminal');
    assert.strictEqual(err.feishuError?.code, 'auth_failed');
  } finally {
    fs.unlinkSync(tmpFile);
    await stopMockServer();
  }
}

async function test3_relayClient_createRecord_success() {
  server = await startMockServer((req, res, body) => {
    const data = JSON.parse(body.toString());
    assert.strictEqual(data.feedbackId, 'fb-123');
    assert.strictEqual(data.fields.issueTitle, 'Test');
    assert.deepStrictEqual(data.fileTokens, ['ft-1']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recordId: 'rec-456', status: 'created' }));
  });

  const client = new RelayClient({ relayUrl: `http://localhost:${serverPort}`, relayApiKey: 'key' });
  const result = await client.createRecord('fb-123', { issueTitle: 'Test' }, ['ft-1']);
  assert.strictEqual(result.recordId, 'rec-456');
  assert.strictEqual(result.status, 'created');
  await stopMockServer();
}

async function test4_relayClient_createRecord_failure_with_feishu_error() {
  server = await startMockServer((req, res, body) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Feishu table not found',
      feishuError: { type: 'terminal', code: 'table_not_found', message: 'Table not found', feishuCode: 1254045 },
    }));
  });

  const client = new RelayClient({ relayUrl: `http://localhost:${serverPort}`, relayApiKey: 'key' });
  try {
    await client.createRecord('fb-123', { issueTitle: 'Test' }, []);
    assert.fail('Expected error');
  } catch (err) {
    assert.strictEqual(err.feishuError?.type, 'terminal');
    assert.strictEqual(err.feishuError?.code, 'table_not_found');
    assert.strictEqual(err.feishuError?.feishuCode, 1254045);
  } finally {
    await stopMockServer();
  }
}

async function test5_relayClient_updateRecord_success() {
  server = await startMockServer((req, res, body) => {
    const data = JSON.parse(body.toString());
    assert.strictEqual(data.remoteRecordId, 'rec-789');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recordId: 'rec-789', status: 'updated' }));
  });

  const client = new RelayClient({ relayUrl: `http://localhost:${serverPort}`, relayApiKey: 'key' });
  const result = await client.updateRecord('fb-123', 'rec-789', { issueTitle: 'Updated' }, ['ft-2']);
  assert.strictEqual(result.recordId, 'rec-789');
  assert.strictEqual(result.status, 'updated');
  await stopMockServer();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test1_relayClient_auth_header,
  test2_relayClient_error_classification,
  test3_relayClient_createRecord_success,
  test4_relayClient_createRecord_failure_with_feishu_error,
  test5_relayClient_updateRecord_success,
];

(async () => {
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      console.log(`PASS ${test.name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL ${test.name}:`, err.message);
      failed++;
    } finally {
      server = null;
    }
  }
  console.log(`\n${passed}/${tests.length} passed, ${failed}/${tests.length} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
