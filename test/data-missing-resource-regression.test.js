'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-data-missing-resource-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const { getToolByName } = require('../src/main/mcp/tools');
    const novel = await novels.createNovel({ title: '缺资源小说', dir: path.join(root, 'novel') });
    const ctx = { novelDir: novel.dir };
    await assert.rejects(() => getToolByName('read_character').handler({ id: 'missing' }, ctx), /character not found/u);
    await assert.rejects(() => getToolByName('read_asset').handler({ id: 'missing' }, ctx), /asset not found/u);
    await assert.rejects(() => getToolByName('read_chapter').handler({ name: 'missing.md' }, ctx), /chapter not found/u);

    await data.writeChapter(novel.dir, 'chapter-001.md', '');
    const emptyExisting = await getToolByName('read_chapter').handler({ name: 'chapter-001.md' }, ctx);
    assert.equal(emptyExisting.content[0].text, '');
    console.log('DATA-E01 passed: missing chapter/character/asset report stable errors while a real empty chapter remains readable.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
