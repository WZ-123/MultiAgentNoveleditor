'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-data-500-assets-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const novel = await novels.createNovel({ title: '500 资产小说', dir: path.join(root, 'novel') });
    for (let index = 0; index < 501; index += 1) {
      await data.upsertAsset(novel.dir, { id: 'asset-' + String(index).padStart(3, '0'), name: '资产 ' + index, description: '测试资产 ' + index });
    }
    const assets = await data.listAssets(novel.dir);
    const ids = assets.map((asset) => asset.id).sort();
    assert.equal(assets.length, 501);
    assert.deepEqual([ids[0], ids[250], ids[500]], ['asset-000', 'asset-250', 'asset-500']);
    assert.equal(new Set(ids).size, 501);
    console.log('DATA-B02 passed: 501 persisted assets list fully without truncation or duplicate IDs.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
