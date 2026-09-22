'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-e2e-local-secret-'));
  const previous = {
    root: process.env.MANA_USER_DATA_ROOT,
    automated: process.env.MANA_AUTOMATED_TEST,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.MANA_USER_DATA_ROOT = root;
  process.env.MANA_AUTOMATED_TEST = '1';
  process.env.NODE_ENV = 'test';
  const secrets = require('../src/main/store/secrets');
  try {
    assert.equal(secrets.automatedTestStorageEnabled(), true);
    assert.equal(secrets.isAvailable(), true, 'local credential storage must not depend on an OS credential service');
    await secrets.setSecret('test:e2e-provider', 'fixture-only');
    const status = await secrets.getSecretStatus('test:e2e-provider');
    assert.equal(status.readable, true);
    assert.equal(status.value, 'fixture-only');
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8'));
    assert.equal(stored.records['test:e2e-provider'].localOnly, true);

    const wrapper = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-codex-runtime-p4-ui-e2e.js'), 'utf8');
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'electron-test-runner.js'), 'utf8');
    assert.match(wrapper, /runElectronCase/u, 'UI wrappers must delegate environment isolation to the unified runner');
    assert.match(runner, /MANA_AUTOMATED_TEST:\s*'1'/u);
    assert.match(runner, /NODE_ENV:\s*'test'/u);
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const marker = main.indexOf("process.env.MANA_AUTOMATED_TEST = '1'");
    const backendLoad = main.indexOf("require('./src/main/index.js')");
    assert.ok(marker >= 0 && marker < backendLoad, 'all --test-* app entries must isolate test credentials before backend modules load');
    console.log('TEST_PASS electron-e2e-local-secret-regression');
  } finally {
    for (const [key, value] of Object.entries({ MANA_USER_DATA_ROOT: previous.root, MANA_AUTOMATED_TEST: previous.automated, NODE_ENV: previous.nodeEnv })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(`TEST_FAIL electron-e2e-local-secret-regression: ${error.stack || error}`); process.exitCode = 1; });

module.exports = { run };
