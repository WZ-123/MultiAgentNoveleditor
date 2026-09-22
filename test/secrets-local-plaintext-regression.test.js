'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-secret-local-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = root;
  const secrets = require('../src/main/store/secrets');
  try {
    await secrets.setSecret('test:provider', 'local-value');
    const status = await secrets.getSecretStatus('test:provider');
    assert.equal(status.readable, true);
    assert.equal(status.value, 'local-value');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'secrets.json'), 'utf8'));
    assert.deepEqual(stored.records['test:provider'], {
      plain: true, localOnly: true, value: 'local-value', revision: 1,
    });
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(root, 'secrets.json'))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    const state = await secrets.status();
    assert.equal(state.storageMode, 'local-plaintext');
    assert.equal(state.encryptionAvailable, false);

    await fs.writeFile(path.join(root, 'providers.json'), JSON.stringify({
      providers: [{ id: 'legacy-provider', apiKey: 'recovered-value' }],
    }), 'utf8');
    const beforeMigration = JSON.parse(await fs.readFile(path.join(root, 'secrets.json'), 'utf8'));
    beforeMigration.records['provider:legacy-provider:api-key'] = { plain: false, value: 'obsolete-ciphertext', revision: 3 };
    beforeMigration.records['license:offline-lease'] = { plain: false, value: 'obsolete-ciphertext', revision: 2 };
    await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify(beforeMigration), { mode: 0o600 });
    const migration = await secrets.migratePlainRecords();
    assert.deepEqual(migration, { migrated: 1, blocked: false, unrecoverable: 1 });
    assert.equal((await secrets.getSecretStatus('provider:legacy-provider:api-key')).value, 'recovered-value');
    assert.equal((await secrets.getSecretStatus('license:offline-lease')).issue, 'legacy-encrypted-record');
    console.log('TEST_PASS secrets-local-plaintext-regression');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => {
  console.error(`TEST_FAIL secrets-local-plaintext-regression: ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { run };
