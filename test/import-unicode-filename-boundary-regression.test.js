'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-import-unicode-name-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const { parseNovelFile } = require('../src/main/import/fileParser');
    const staging = require('../src/main/import/stagingProject');
    const source = path.join(root, '第01章 空格-月🌙-한글-日本語.txt');
    fs.writeFileSync(source, '# 月下相逢\n\n莉音抬头。', 'utf8');
    const parsed = await parseNovelFile(source);
    assert.equal(parsed.chapters.length, 1);
    assert.equal(parsed.chapters[0].title, '月下相逢');
    const created = await staging.createStagingProject({ sourceFiles: [source], chapters: parsed.chapters, metadata: { title: 'Unicode 导入' } });
    const restored = await staging.getStagingProject(created.importId);
    assert.deepEqual(restored.novelMeta.importMeta.sourceFiles, [source]);
    assert.equal(restored.chapters[0].title, '月下相逢');
    assert.equal(restored.chapters[0].content, '莉音抬头。');
    console.log('IMPORT-B07 passed: CJK, space, emoji, and Korean/Japanese source filename survives parse, staging, and readback.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
