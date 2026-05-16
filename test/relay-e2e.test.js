'use strict';

/**
 * End-to-end test: relayClient → mock Worker → mock Feishu response
 * Validates the complete client→server protocol alignment.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RelayClient } = require('../src/main/sync/relayClient');

const MOCK_URL = process.env.RELAY_TEST_URL || 'http://localhost:8787';
const API_KEY = 'test-key';

async function test1_upload_and_create() {
  const client = new RelayClient({ relayUrl: MOCK_URL, relayApiKey: API_KEY });

  // Create dummy screenshot
  const tmpFile = path.join(os.tmpdir(), `relay-e2e-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));

  try {
    // Step 1: Upload attachment
    const uploadResult = await client.uploadAttachment(tmpFile);
    assert(uploadResult.fileToken, 'Expected fileToken');
    assert(uploadResult.fileName === path.basename(tmpFile), 'Expected fileName match');
    console.log('  → uploadAttachment:', uploadResult.fileToken);

    // Step 2: Create record with attachment
    const fields = {
      feedbackId: `e2e-${Date.now()}`,
      createdAt: '2026-05-16 12:00:00 +08:00',
      issueTitle: '[E2E] RelayClient → Worker',
      actualBehavior: 'Full upload + create flow',
      feedbackMode: 'context-with-logs',
      severity: 'low',
      appVersion: 'e2e-test',
      platform: process.platform,
    };

    const createResult = await client.createRecord(fields.feedbackId, fields, [uploadResult.fileToken]);
    assert(createResult.recordId, 'Expected recordId');
    assert(createResult.status === 'created', 'Expected status=created');
    console.log('  → createRecord:', createResult.recordId);

    // Step 3: Update same record (attachment retry simulation)
    const updateResult = await client.updateRecord(fields.feedbackId, createResult.recordId, fields, [uploadResult.fileToken]);
    assert(updateResult.recordId === createResult.recordId, 'Expected same recordId');
    assert(updateResult.status === 'updated', 'Expected status=updated');
    console.log('  → updateRecord:', updateResult.status);

  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function test2_create_without_attachment() {
  const client = new RelayClient({ relayUrl: MOCK_URL, relayApiKey: API_KEY });

  const fields = {
    feedbackId: `e2e-noattach-${Date.now()}`,
    createdAt: '2026-05-16 12:00:00 +08:00',
    issueTitle: '[E2E] No attachment',
    feedbackMode: 'opinion-only',
    severity: 'low',
  };

  const result = await client.createRecord(fields.feedbackId, fields, []);
  assert(result.recordId, 'Expected recordId');
  assert(result.status === 'created', 'Expected status=created');
  console.log('  → createRecord (no attachment):', result.recordId);
}

async function test3_error_handling() {
  const badClient = new RelayClient({ relayUrl: MOCK_URL, relayApiKey: 'wrong-key' });

  try {
    await badClient.createRecord('test', {}, []);
    assert.fail('Expected auth error');
  } catch (err) {
    assert(err.feishuError?.code === 'auth_failed', `Expected auth_failed, got ${err.feishuError?.code}`);
    console.log('  → Auth rejected as expected');
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test1_upload_and_create,
  test2_create_without_attachment,
  test3_error_handling,
];

(async () => {
  console.log(`E2E testing relayClient → mock Worker at ${MOCK_URL}\n`);
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      console.log(`PASS ${test.name}\n`);
      passed++;
    } catch (err) {
      console.error(`FAIL ${test.name}:`, err.message, '\n');
      failed++;
    }
  }

  console.log(`${passed}/${tests.length} passed, ${failed}/${tests.length} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
