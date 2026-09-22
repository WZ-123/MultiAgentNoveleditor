'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const {
  ACCESS_TTL_SECONDS,
  createMemoryRelayState,
  createRelayCore,
  jwksFromEnv,
  verifyJwt,
} = require('../relay-worker/src/relay-core.cjs');

async function buildEnv() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  privateJwk.kid = 'test-active';
  return {
    RELAY_SIGNING_KID: 'test-active',
    RELAY_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    RELAY_ISSUER: 'https://relay.test.invalid',
    RELAY_AUTH_CODE_PEPPER: 'test-only-pepper-that-is-long-enough',
    RELAY_STATE_STORE: createMemoryRelayState(),
  };
}

function req(path, options = {}) {
  const body = options.body == null ? '' : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  return {
    method: options.method || 'POST',
    path,
    headers: { 'content-length': String(Buffer.byteLength(body)), ...(options.headers || {}) },
    body,
    remoteAddress: options.remoteAddress || '127.0.0.1',
  };
}

function json(result) { return JSON.parse(result.body || '{}'); }

async function run() {
  const env = await buildEnv();
  const calls = { exchange: 0, upload: 0, submit: 0 };
  const route = createRelayCore({
    env,
    now: () => Date.parse('2026-08-23T00:00:00.000Z'),
    handlers: {
      exchangeLicense: async ({ installationIdHash }) => {
        calls.exchange += 1;
        assert.match(installationIdHash, /^[a-f0-9]{64}$/);
        return { valid: true, deviceCount: 1, maxDevices: 5, expiresAt: '2026-09-01T00:00:00.000Z' };
      },
      uploadFeedback: async ({ idempotencyKey }) => { calls.upload += 1; return { fileToken: `file-${idempotencyKey}` }; },
      submitFeedback: async ({ data }) => { calls.submit += 1; return { recordId: `record-${data.feedbackId}`, status: 'created' }; },
    },
  });

  const tombstone = await route(req('/api/v1/auth/verify'));
  assert.equal(tombstone.status, 426);
  assert.equal(json(tombstone).code, 'upgrade_required');

  const exchange = await route(req('/api/v2/session/exchange', {
    body: { authCode: 'code-123', installationId: 'A'.repeat(43), appVersion: '0.0.9', platform: 'darwin-arm64' },
  }));
  assert.equal(exchange.status, 200);
  const session = json(exchange);
  assert.equal(calls.exchange, 1);
  assert.ok(session.accessToken);
  assert.ok(session.offlineLease);
  const claims = await verifyJwt(session.accessToken, { ...env, RELAY_PUBLIC_JWKS: JSON.stringify(jwksFromEnv(env)) }, {
    nowSeconds: Date.parse('2026-08-23T00:00:00.000Z') / 1000,
    tokenType: 'access',
    requiredScope: 'feedback:submit',
  });
  assert.equal(claims.exp - claims.iat, ACCESS_TTL_SECONDS);
  assert.equal(claims.aud, 'mana-desktop');
  assert.equal(Object.hasOwn(claims, 'authCode'), false);

  const missingBearer = await route(req('/api/v2/feedback/submit', { body: { feedbackId: 'fb-1', fields: {} } }));
  assert.equal(missingBearer.status, 401);
  assert.equal(calls.submit, 0);

  const submit = await route(req('/api/v2/feedback/submit', {
    body: { feedbackId: 'fb-1', fields: { title: 'ok' } },
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'fb-1' },
  }));
  assert.equal(submit.status, 200);
  assert.equal(json(submit).recordId, 'record-fb-1');
  assert.equal(calls.submit, 1);

  const repeatedSubmit = await route(req('/api/v2/feedback/submit', {
    body: { feedbackId: 'fb-1', fields: { title: 'changed-but-same-command' } },
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'fb-1' },
  }));
  assert.equal(repeatedSubmit.status, 200);
  assert.equal(json(repeatedSubmit).recordId, 'record-fb-1');
  assert.equal(calls.submit, 1, 'a completed idempotency key must not execute twice');

  const badIdempotency = await route(req('/api/v2/feedback/submit', {
    body: { feedbackId: 'fb-2', fields: {} },
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'different' },
  }));
  assert.equal(badIdempotency.status, 400);
  assert.equal(calls.submit, 1);

  const oversized = await route({
    method: 'POST', path: '/api/v2/session/exchange', headers: { 'content-length': String(17 * 1024) }, body: '', remoteAddress: '127.0.0.2',
  });
  assert.equal(oversized.status, 413);

  for (let i = 0; i < 5; i += 1) {
    const limited = await route(req('/api/v2/session/exchange', {
      remoteAddress: '192.0.2.1',
      body: { authCode: `another-${i}`, installationId: 'B'.repeat(43), appVersion: '0.0.9', platform: 'linux-x64' },
    }));
    assert.equal(limited.status, 200);
  }
  const limited = await route(req('/api/v2/session/exchange', {
    remoteAddress: '192.0.2.1',
    body: { authCode: 'another-final', installationId: 'B'.repeat(43), appVersion: '0.0.9', platform: 'linux-x64' },
  }));
  assert.equal(limited.status, 429);
  assert.equal(json(limited).code, 'rate_limited');

  console.log('TEST_PASS relay-v2-core-regression');
}

if (require.main === module) run().catch((error) => {
  console.error(`TEST_FAIL relay-v2-core-regression: ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { run };
