/**
 * Local integration test for the feedback relay.
 * Primary deployment is Tencent Cloud SCF Web Function; Cloudflare Worker is a
 * backup target, so this script accepts both runtime health modes.
 *
 * Usage:
 *   1. Start local dev server: cd relay-worker && npx wrangler dev
 *   2. In another terminal: cd relay-worker && node scripts/test-relay.js
 *
 * Requires .dev.vars file with:
 *   RELAY_API_KEY=your-key
 *   FEISHU_APP_ID=cli_xxx
 *   FEISHU_APP_SECRET=xxx
 *   FEISHU_APP_TOKEN=xxx
 *   FEISHU_TABLE_ID=xxx
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE_URL = process.env.RELAY_TEST_URL || 'http://localhost:8787';

function loadDevVars() {
  const varsPath = path.join(__dirname, '..', '.dev.vars');
  if (!fs.existsSync(varsPath)) {
    console.error('Missing .dev.vars file. See wrangler.toml for setup instructions.');
    process.exit(1);
  }
  const content = fs.readFileSync(varsPath, 'utf8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return vars;
}

const devVars = loadDevVars();
const API_KEY = devVars.RELAY_API_KEY;

async function request(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'X-Relay-Api-Key': API_KEY,
      ...opts.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1_health() {
  const { status, data } = await request('/api/v1/health', { method: 'GET', headers: {} });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data.ok === true, 'Expected ok=true');
  assert(
    data.mode === 'scf-web-function' || data.mode === 'cloudflare-worker',
    `Expected scf-web-function or cloudflare-worker mode, got ${data.mode}`
  );
}

async function test2_auth_rejected() {
  const res = await fetch(`${BASE_URL}/api/v1/feedback/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Api-Key': 'wrong-key' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  assert(res.status === 401, `Expected 401, got ${res.status}`);
  assert(data.error === 'Unauthorized', `Expected Unauthorized, got ${data.error}`);
}

async function test3_submit_without_screenshot() {
  const { status, data } = await request('/api/v1/feedback/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feedbackId: `test-${Date.now()}`,
      fields: {
        feedbackId: `test-${Date.now()}`,
        createdAt: '2026-05-16 12:00:00 +08:00',
        issueTitle: '[TEST] Tencent SCF primary relay',
        actualBehavior: 'Automated test from test-relay.js',
        feedbackMode: 'opinion-only',
        severity: 'low',
        appVersion: 'test',
        platform: process.platform,
      },
      fileTokens: [],
    }),
  });

  // If Feishu credentials are configured, this should succeed (200)
  // If credentials are missing/invalid, it should return 502 with feishuError
  if (status === 200) {
    assert(data.recordId, 'Expected recordId in response');
    assert(data.status === 'created', 'Expected status=created');
    console.log('  → Created record:', data.recordId);
  } else if (status === 502) {
    console.log('  → Feishu call failed (expected if credentials not configured):', data.error);
    assert(data.feishuError, 'Expected feishuError in 502 response');
  } else {
    assert(false, `Unexpected status ${status}: ${JSON.stringify(data)}`);
  }
}

async function test4_upload_screenshot() {
  // Create a dummy PNG file
  const tmpFile = path.join(os.tmpdir(), `relay-test-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // Manual multipart construction (works in all Node.js versions)
  const boundary = `----TestBoundary${Date.now()}`;
  const fileBuffer = fs.readFileSync(tmpFile);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(`${BASE_URL}/api/v1/feedback/upload`, {
    method: 'POST',
    headers: {
      'X-Relay-Api-Key': API_KEY,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  fs.unlinkSync(tmpFile);

  const data = await res.json().catch(() => ({}));
  if (res.status === 200) {
    assert(data.fileToken, 'Expected fileToken');
    console.log('  → Uploaded file token:', data.fileToken);
  } else if (res.status === 502) {
    console.log('  → Feishu upload failed (expected if credentials not configured):', data.error);
    assert(data.feishuError, 'Expected feishuError');
  } else {
    assert(false, `Unexpected status ${res.status}: ${JSON.stringify(data)}`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tests = [
  test1_health,
  test2_auth_rejected,
  test3_submit_without_screenshot,
  test4_upload_screenshot,
];

(async () => {
  console.log(`Testing against ${BASE_URL}\n`);
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
    }
  }

  console.log(`\n${passed}/${tests.length} passed, ${failed}/${tests.length} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
