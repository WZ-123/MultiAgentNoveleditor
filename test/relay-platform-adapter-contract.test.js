'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createScfRedisRelayState } = require('../relay-worker/src/scf-redis-state.cjs');
const scf = require('../relay-worker/src/scf-entry.cjs');

class FakeD1 {
  constructor() {
    this.rates = new Map();
    this.idempotency = new Map();
  }

  prepare(sql) {
    const normalized = String(sql).replace(/\s+/gu, ' ').trim();
    return {
      bind: (...args) => ({
        first: async () => {
          if (normalized.includes('INSERT INTO relay_rate_limits')) {
            const next = (this.rates.get(args[0]) || 0) + 1;
            this.rates.set(args[0], next);
            return { count: next };
          }
          if (normalized.startsWith('SELECT status')) {
            const entry = this.idempotency.get(args[0]);
            return entry && entry.expiresAt > args[1]
              ? { status: entry.status, resultJson: entry.resultJson }
              : null;
          }
          throw new Error(`unsupported fake D1 first(): ${normalized}`);
        },
        run: async () => {
          if (normalized.startsWith('DELETE FROM relay_idempotency') && normalized.includes('expires_at')) {
            const entry = this.idempotency.get(args[0]);
            if (entry && entry.expiresAt <= args[1]) this.idempotency.delete(args[0]);
            return { meta: { changes: 0 } };
          }
          if (normalized.startsWith('INSERT OR IGNORE INTO relay_idempotency')) {
            if (this.idempotency.has(args[0])) return { meta: { changes: 0 } };
            this.idempotency.set(args[0], { status: 'pending', token: args[1], resultJson: null, expiresAt: args[2] });
            return { meta: { changes: 1 } };
          }
          if (normalized.startsWith('UPDATE relay_idempotency')) {
            const entry = this.idempotency.get(args[0]);
            if (!entry || entry.status !== 'pending' || entry.token !== args[1]) return { meta: { changes: 0 } };
            this.idempotency.set(args[0], { status: 'done', token: '', resultJson: args[2], expiresAt: args[3] });
            return { meta: { changes: 1 } };
          }
          if (normalized.startsWith('DELETE FROM relay_idempotency')) {
            const entry = this.idempotency.get(args[0]);
            const matches = entry?.status === 'pending' && entry.token === args[1];
            if (matches) this.idempotency.delete(args[0]);
            return { meta: { changes: matches ? 1 : 0 } };
          }
          throw new Error(`unsupported fake D1 run(): ${normalized}`);
        },
      }),
    };
  }
}

class FakeRedis {
  constructor() {
    this.status = 'ready';
    this.values = new Map();
  }

  async get(key) { return this.values.get(key) || null; }

  async set(key, value, ...args) {
    if (args.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async eval(script, _keyCount, key, ...args) {
    if (script.startsWith('local n=')) {
      const next = Number(this.values.get(key) || 0) + 1;
      this.values.set(key, String(next));
      return next;
    }
    if (script.includes("redis.call('SET'")) {
      if (this.values.get(key) !== args[0]) return 0;
      this.values.set(key, args[1]);
      return 1;
    }
    if (script.includes("redis.call('DEL'")) {
      if (this.values.get(key) !== args[0]) return 0;
      this.values.delete(key);
      return 1;
    }
    throw new Error('unsupported fake Redis script');
  }
}

async function assertStateContract(state, label) {
  assert.equal(await state.consume('rate', 1, 60, 1_000), true, `${label}: first request must pass`);
  assert.equal(await state.consume('rate', 1, 60, 1_000), false, `${label}: limit must be atomic`);
  assert.equal(await state.getIdempotency('job', 1_000), null);
  assert.equal(await state.claimIdempotency('job', 'claim-a', 600, 1_000), true);
  assert.equal(await state.claimIdempotency('job', 'claim-b', 600, 1_000), false);
  assert.deepEqual(await state.getIdempotency('job', 1_000), { pending: true });
  assert.equal(await state.completeIdempotency('job', 'wrong', { ok: true }, 600, 1_000), false);
  assert.equal(await state.completeIdempotency('job', 'claim-a', { receipt: 'saved' }, 600, 1_000), true);
  assert.deepEqual(await state.getIdempotency('job', 1_000), { receipt: 'saved' });
  assert.equal(await state.claimIdempotency('released', 'claim-c', 600, 1_000), true);
  await state.releaseIdempotency('released', 'claim-c');
  assert.equal(await state.getIdempotency('released', 1_000), null);
}

function normalizedPayload(body) {
  if (!body) return null;
  const parsed = JSON.parse(body);
  delete parsed.diagnosticId;
  return parsed;
}

async function assertAdapterParity(worker) {
  const cases = [
    { method: 'GET', path: '/api/v2/health' },
    { method: 'POST', path: '/api/v1/auth/verify', body: '{}' },
    { method: 'GET', path: '/missing' },
    { method: 'OPTIONS', path: '/api/v2/session/exchange' },
    {
      method: 'POST',
      path: '/api/v2/session/exchange',
      body: JSON.stringify({ authCode: 'test-code', installationId: 'A'.repeat(32), appVersion: '1.0.0', platform: 'test' }),
      expectedCode: 'relay_state_unavailable',
    },
  ];
  const inertHandlers = {
    exchangeLicense: async () => ({ valid: false, reason: 'invalid_code' }),
    uploadFeedback: async () => ({ fileToken: 'unused' }),
    submitFeedback: async () => ({ recordId: 'unused' }),
  };
  for (const item of cases) {
    const headers = item.body ? { 'content-type': 'application/json' } : undefined;
    const cloudflare = await worker.fetch(new Request(`https://relay.invalid${item.path}`, { method: item.method, headers, body: item.body }), {}, {});
    const scfResult = await scf.__test.handleScfEvent({
      httpMethod: item.method,
      path: item.path,
      headers: { Host: 'relay.invalid', ...(headers || {}) },
      body: item.body || '',
      requestContext: { sourceIp: '127.0.0.1' },
    }, { stateStore: null, handlers: inertHandlers });
    assert.equal(cloudflare.status, scfResult.statusCode, `${item.method} ${item.path}: platform status drift`);
    const cloudflareBody = cloudflare.status === 204 ? null : normalizedPayload(await cloudflare.text());
    const scfBody = scfResult.statusCode === 204 ? null : normalizedPayload(scfResult.body);
    assert.deepEqual(cloudflareBody, scfBody, `${item.method} ${item.path}: platform response drift`);
    if (item.expectedCode) assert.equal(cloudflareBody.code, item.expectedCode);
  }
}

async function run() {
  const cloudflareStateModule = await import(pathToFileURL(path.join(__dirname, '..', 'relay-worker', 'src', 'cloudflare-state.js')).href);
  await assertStateContract(cloudflareStateModule.createCloudflareRelayState(new FakeD1()), 'Cloudflare D1');
  await assertStateContract(createScfRedisRelayState('redis://test.invalid', { client: new FakeRedis() }), 'SCF Redis');
  const workerModule = await import(pathToFileURL(path.join(__dirname, '..', 'relay-worker', 'src', 'index.js')).href);
  await assertAdapterParity(workerModule.default);

  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'relay-worker', 'src', 'index.js'), 'utf8');
  const scfSource = fs.readFileSync(path.join(__dirname, '..', 'relay-worker', 'src', 'scf-entry.cjs'), 'utf8');
  for (const source of [workerSource, scfSource]) {
    assert.match(source, /createFeishuRelayHandlers/u);
    assert.doesNotMatch(source, /open\.feishu\.cn|tenant_access_token|listAllBitableRecords/u, 'platform adapter must not duplicate Feishu business logic');
  }
  console.log('TEST_PASS relay-platform-adapter-contract');
}

if (require.main === module) run().catch((error) => {
  console.error(`TEST_FAIL relay-platform-adapter-contract: ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { FakeD1, FakeRedis, assertStateContract, run };
