'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-secrets-unwritable-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = root;
  try {
    const secrets = require('../src/main/store/secrets');
    fs.mkdirSync(path.join(root, 'secrets.json'));
    await assert.rejects(
      () => secrets.setSecret('provider:fixture:api-key', 'value'),
      (error) => ['EISDIR', 'EACCES', 'EPERM'].includes(error?.code),
    );
    const storage = await secrets.status();
    assert.equal(storage.storageMode, 'local-plaintext');
    assert.equal(storage.encryptionAvailable, false);
    console.log('BOOT-E06 passed: invalid/unwritable local secrets target rejects explicitly and never invokes Keychain/safeStorage.');
  } finally {
    try { fs.chmodSync(root, 0o700); } catch { /* best effort */ }
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
