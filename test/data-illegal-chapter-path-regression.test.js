'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-data-illegal-path-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const { getToolByName } = require('../src/main/mcp/tools');
    const novel = await novels.createNovel({ title: '路径边界小说', dir: path.join(root, 'novel') });
    await assert.rejects(
      () => getToolByName('write_chapter').handler({ name: '../../escaped.md', content: '安全正文' }, { novel: novel, novelDir: novel.dir }),
      (error) => error?.code === 'invalid_resource_name',
    );
    assert.equal(fs.existsSync(path.join(root, 'escaped.md')), false);
    assert.deepEqual(await data.listChapters(novel.dir), []);
    await assert.rejects(
      () => getToolByName('read_chapter').handler({ name: '../../escaped.md' }, { novelDir: novel.dir }),
      (error) => error?.code === 'invalid_resource_name',
    );
    console.log('DATA-E03 passed: hostile chapter paths are rejected without writing or aliasing a file.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
