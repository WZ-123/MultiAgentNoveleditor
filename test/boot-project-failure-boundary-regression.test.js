'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const root = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(root, 'tmp-test-boot-project-failures');
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(fixtureRoot, { recursive: true });
  try {
    process.env.MANA_USER_DATA_ROOT = path.join(fixtureRoot, 'userdata');
    const novels = require(path.join(root, 'src/main/store/novels'));

    const deletedDir = path.join(fixtureRoot, 'deleted-project');
    const deleted = await novels.createNovel({ title: '删除目录', dir: deletedDir });
    await fs.rm(deletedDir, { recursive: true, force: true });
    await assert.rejects(() => novels.openNovel(deleted.id), /novel\.json missing/u);
    console.log('TEST_PASS BOOT_E03_external_project_directory_deleted');

    const corruptDir = path.join(fixtureRoot, 'corrupt-project');
    const corrupt = await novels.createNovel({ title: '损坏元数据', dir: corruptDir });
    await fs.writeFile(path.join(corruptDir, 'novel.json'), '{ invalid json', 'utf8');
    await assert.rejects(() => novels.openNovel(corrupt.id), /novel\.json missing/u);
    console.log('TEST_PASS BOOT_E04_corrupt_novel_metadata_rejected');
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(`TEST_FAIL boot-project-failure-boundary: ${error.stack || error}`); process.exitCode = 1; });

module.exports = { run };
