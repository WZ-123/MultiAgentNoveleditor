'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const root = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(root, 'tmp-test-boot-registry-boundary');
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(fixtureRoot, { recursive: true });
  process.env.MANA_USER_DATA_ROOT = path.join(fixtureRoot, 'userdata');
  const novels = require(path.join(root, 'src/main/store/novels'));
  const novelDir = path.join(fixtureRoot, 'same-project');
  await fs.mkdir(novelDir, { recursive: true });
  const first = await novels.createNovel({ title: '重复目录项目', dir: novelDir });
  const second = await novels.createNovel({ title: '不应覆盖标题', dir: novelDir });
  const list = await novels.listNovels();
  assert.equal(first.id, second.id);
  assert.equal(list.filter((entry) => entry.dir === novelDir).length, 1);
  assert.equal(list.filter((entry) => entry.id === first.id).length, 1);
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  console.log('TEST_PASS BOOT_B04_duplicate_directory_has_one_stable_identity');
}

if (require.main === module) run().catch((error) => { console.error(`TEST_FAIL boot-registry-boundary: ${error.stack || error}`); process.exitCode = 1; });

module.exports = { run };
