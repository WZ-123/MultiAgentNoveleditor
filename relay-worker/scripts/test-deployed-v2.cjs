'use strict';

const assert = require('node:assert/strict');

const baseUrl = String(process.env.RELAY_TEST_BASE_URL || '').replace(/\/$/u, '');
if (!/^https:\/\//u.test(baseUrl)) throw new Error('RELAY_TEST_BASE_URL must be an HTTPS Relay V2 URL');

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'error', ...init });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function run() {
  const health = await request('/api/v2/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.apiVersion, 2);

  const tombstone = await request('/api/v1/auth/verify', { method: 'POST', body: '{}' });
  assert.equal(tombstone.response.status, 426);
  assert.equal(tombstone.data.code, 'upgrade_required');

  if (process.env.RELAY_TEST_AUTH_CODE) {
    const exchange = await request('/api/v2/session/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authCode: process.env.RELAY_TEST_AUTH_CODE,
        installationId: 'deployment-smoke-installation-id-000000000000',
        appVersion: process.env.RELAY_TEST_APP_VERSION || '0.0.9',
        platform: process.platform,
      }),
    });
    assert.equal(exchange.response.status, 200);
    assert.ok(exchange.data.accessToken);
    assert.ok(exchange.data.offlineLease);
  }
  process.stdout.write('RELAY_V2_DEPLOYED_SMOKE_PASS\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
