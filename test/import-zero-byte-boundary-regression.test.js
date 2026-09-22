'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-import-zero-byte-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const { parseNovelFile } = require('../src/main/import/fileParser');
    const staging = require('../src/main/import/stagingProject');
    const emptyFile = path.join(root, 'empty.txt');
    fs.writeFileSync(emptyFile, '', 'utf8');
    const parsed = await parseNovelFile(emptyFile);
    assert.deepEqual(parsed.chapters, [{ title: '', content: '', confident: false }]);
    const created = await staging.createStagingProject({ sourceFiles: [emptyFile], chapters: parsed.chapters, metadata: { title: '空文件导入' } });
    const restored = await staging.getStagingProject(created.importId);
    assert.equal(restored?.chapters?.length, 1);
    assert.equal(restored.chapters[0].title, '');
    assert.equal(restored.chapters[0].content, '', 'zero-byte input must become a recoverable empty staging chapter, not expose its Markdown heading as body text');
    assert.equal(restored.novelMeta.importMeta.status, 'active');
    console.log('IMPORT-B01 passed: zero-byte TXT creates one explicitly empty recoverable staging chapter.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
