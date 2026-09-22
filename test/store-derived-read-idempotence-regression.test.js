'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { ensureNovelLayout } = require(path.join(ROOT, 'src/main/store/paths'));
  const novelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-derived-read-idempotence-'));

  try {
    const np = ensureNovelLayout(novelDir);
    await novelData.writeCharacter(novelDir, { id: 'hero', name: '主角', role: '主角' });
    await fs.rm(np.charactersIndex, { force: true });
    const characters = await novelData.listCharacterIndex(novelDir, { persistRebuild: false });
    assert.equal(characters.length, 1);
    await assert.rejects(fs.stat(np.charactersIndex), { code: 'ENOENT' });

    await novelData.upsertAsset(novelDir, { id: 'asset-1', name: '旧钥匙', type: '道具' });
    const indexBefore = await fs.readFile(np.assetsMain, 'utf8');
    const listed = await novelData.listAssets(novelDir);
    const read = await novelData.readAsset(novelDir, 'asset-1');
    const indexAfter = await fs.readFile(np.assetsMain, 'utf8');
    assert.equal(listed.length, 1);
    assert.equal(read?.name, '旧钥匙');
    assert.equal(indexAfter, indexBefore, 'normal asset reads must not refresh the derived index timestamp');

    console.log('TEST_PASS store-derived-read-idempotence-regression');
  } finally {
    await fs.rm(novelDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.log(`TEST_FAIL store-derived-read-idempotence-regression: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
