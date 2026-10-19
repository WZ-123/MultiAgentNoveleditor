'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const helper = fs.readFileSync(path.join(__dirname, '../src/components/modelSetupId.mjs'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '../src/components/ProviderSettingsPanel.jsx'), 'utf8');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function loadId(globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(helper.replace('export function ', 'function '), context);
  return context;
}
function lanCrypto() {
  const api = { getRandomValues(bytes) { assert.equal(this, api); return webcrypto.getRandomValues(bytes); } };
  return api;
}

const native = { randomUUID() { assert.equal(this, native); return 'native-uuid'; }, getRandomValues() { assert.fail('native UUID should be preferred'); } };
assert.equal(loadId({ crypto: native }).createModelSetupId(), 'native-uuid');

const lan = loadId({ crypto: lanCrypto(), isSecureContext: false });
const ids = Array.from({ length: 10000 }, () => lan.createModelSetupId());
assert.equal(new Set(ids).size, ids.length);
ids.forEach((id) => assert.match(id, uuidPattern));
const zeros = loadId({ crypto: { getRandomValues(bytes) { return bytes.fill(0); } } });
assert.equal(zeros.createModelSetupId(), '00000000-0000-4000-8000-000000000000');

for (const crypto of [undefined, {}]) {
  // With frozen time and random, the per-renderer counter must still separate attempts.
  const context = loadId({ crypto, Date: { now: () => 42 }, Math: { random: () => 0.5 } });
  const fallbackIds = Array.from({ length: 10000 }, () => context.createModelSetupId());
  assert.equal(new Set(fallbackIds).size, fallbackIds.length);
  fallbackIds.forEach((id) => assert.match(id, /^setup-[a-z0-9-]+$/));
}

// Execute the real component handler bodies without React/JSX or a browser.
// Wiring checks below complement this, but do not replace DOM/LAN UI acceptance.
function handler(name, nextName) {
  const start = panel.indexOf(`  const ${name} = `);
  const end = panel.indexOf(`  const ${nextName} = `, start);
  assert.ok(start > 0 && end > start, `find ${name} handler`);
  return panel.slice(start, end);
}
const draftDeclaration = panel.match(/^const newDraft = .*$/m)?.[0];
assert.ok(draftDeclaration);
assert.match(panel, /import \{ createModelSetupId \} from '\.\/modelSetupId\.mjs'/);
assert.doesNotMatch(panel, /crypto\.randomUUID/);
assert.match(panel, /onClick=\{\(\) => begin\(\)\}/);
assert.match(panel, /connection\.kind === 'api' \? begin\(connection\)/);
assert.match(panel, /onClick=\{\(\) => resume\(item\)\}/);
assert.match(panel, /onClick=\{editAgain\}/);
assert.match(panel, /onClick=\{detect\}/);
const handlers = [handler('begin', 'chooseSaved'), handler('resume', 'discard'), handler('editAgain', 'detect'), handler('detect', 'verify'), handler('verify', 'activateSubscription')].join('\n');

async function testActions(crypto) {
  const started = [];
  const retried = [];
  const context = loadId({ crypto, URL, isSecureContext: false, started, retried });
  vm.runInContext(`${draftDeclaration}
    let draft = null, operation = null, adding = false;
    const operationRef = { current: null };
    const state = { revision: 7, templates: [{ id: 'deepseek', baseUrl: 'https://provider.invalid/v1' }] };
    const preview = { candidates: [
      { origin: 'https://provider.invalid', modelsUrl: 'https://provider.invalid/v1/models' },
      { origin: 'https://other.invalid', modelsUrl: 'https://other.invalid/v1/models' }
    ] };
    const crossOrigins = [];
    const selected = 'test-model', effort = '', capabilities = null, manualId = '';
    const setDraft = (next) => { draft = typeof next === 'function' ? next(draft) : next; };
    const setAdding = (next) => { adding = next; };
    const setMethod = () => {}, setError = () => {}, setMessage = () => {}, setManualId = () => {};
    const useOperation = (next) => { operation = next; operationRef.current = next?.id || null; };
    const setOperation = (next) => { operation = next; };
    const act = (fn) => fn();
    const refresh = async () => state;
    const mana = { modelConfig: {
      startSetup: async (payload) => { started.push(payload); return { id: payload.id, credentialId: 'saved-credential' }; },
      retrySetup: async (payload) => { retried.push(payload); return { id: payload.id }; },
      querySetup: async (id) => ({ id })
    } };
    ${handlers}
    globalThis.actions = { begin, resume, editAgain, detect, verify,
      snapshot: () => ({ draft, operation, adding, operationId: operationRef.current }),
      setKey: (apiKey) => { draft.apiKey = apiKey; }
    };
  `, context);
  const { actions } = context;
  const first = actions.begin();
  assert.ok(first.id);
  assert.equal(first.inputUrl, 'https://provider.invalid/v1');
  assert.equal(actions.snapshot().adding, true);
  const second = actions.begin();
  assert.notEqual(second.id, first.id);
  assert.equal(actions.snapshot().draft.id, second.id);
  actions.setKey('test-only-placeholder');
  await actions.detect();
  assert.equal(started[0].id, second.id);
  assert.equal(started[0].expectedRevision, 7);
  assert.equal(started[0].apiKey, 'test-only-placeholder');
  assert.deepEqual(Array.from(started[0].approvedCandidateUrls), ['https://provider.invalid/v1/models']);
  assert.equal(actions.snapshot().draft.id, second.id);
  assert.equal(actions.snapshot().draft.apiKey, '');
  assert.equal(actions.snapshot().draft.credentialId, 'saved-credential');
  actions.editAgain();
  assert.notEqual(actions.snapshot().draft.id, second.id);
  assert.equal(actions.snapshot().draft.credentialId, 'saved-credential');
  assert.equal(actions.snapshot().draft.apiKey, '');
  assert.equal(actions.snapshot().operation, null);
  const connection = { id: 'connection-existing', credentialId: 'credential-existing', name: 'Saved', baseUrl: 'https://provider.invalid/v1', queryParams: { version: '2' }, templateId: 'custom', auth: { mode: 'bearer' } };
  const edited = actions.begin(connection);
  assert.equal(edited.connectionId, connection.id);
  assert.equal(edited.credentialId, connection.credentialId);
  assert.equal(edited.inputUrl, 'https://provider.invalid/v1?version=2');
  assert.equal(edited.apiKey, '');
  const pending = { id: 'pending-original', credentialId: 'pending-credential', status: 'paused', connectionId: 'uncommitted-candidate-id', apiKey: 'must-not-restore' };
  actions.resume(pending);
  assert.equal(actions.snapshot().draft.id, pending.id);
  await actions.verify();
  assert.equal(retried[0].id, pending.id);
  assert.equal(retried[0].chatOnly, false);
  assert.equal(retried[0].interruptActive, false);
  assert.equal(actions.snapshot().draft.id, pending.id);
  assert.equal(actions.snapshot().draft.credentialId, pending.credentialId);
  assert.equal(actions.snapshot().draft.apiKey, '');
  assert.equal(actions.snapshot().operationId, pending.id);
  actions.resume(pending);
  assert.equal(actions.snapshot().draft.id, pending.id);
  assert.equal(actions.snapshot().draft.connectionId, '', 'a pending new candidate is not an existing saved connection');
  actions.editAgain();
  assert.equal(actions.snapshot().draft.connectionId, '');
  actions.resume({ ...pending, originalConnection: connection });
  actions.editAgain();
  assert.equal(actions.snapshot().draft.connectionId, connection.id, 'editing a saved connection retains its actual identity');
  assert.equal(actions.begin(null, 'reused-credential').credentialId, 'reused-credential');
}

(async () => {
  await testActions(lanCrypto());
  await testActions(undefined);
  console.log('model setup IDs: ok (native, insecure HTTP crypto, missing crypto, uniqueness, handler behavior and wiring)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
