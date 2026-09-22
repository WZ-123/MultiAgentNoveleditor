'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const novelData = require('../src/main/store/novelData');
const { assertChapterName, atomicWriteFile } = require('../src/main/store/resourceIdentity');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-storage-atomicity-'));
  const novelDir = path.join(root, 'novel');
  try {
    await novelData.writeChapter(novelDir, 'chapter-安全章.md', '第一行\r\n第二行\r\n');
    assert.equal(await novelData.readChapter(novelDir, 'chapter-安全章.md'), '第一行\r\n第二行\r\n', 'safe Unicode and CRLF bytes are preserved');
    assert.equal(fs.readFileSync(path.join(novelDir, 'chapters', 'chapter-安全章.md'), 'utf8'), '第一行\r\n第二行\r\n');

    for (const hostile of ['../chapter-x.md', 'chapter-a/b.md', 'chapter-a:b.md', ' chapter-a.md', 'chapter-..md']) {
      assert.throws(() => assertChapterName(hostile), (error) => error?.code === 'invalid_resource_name');
    }
    await assert.rejects(() => novelData.writeChapter(novelDir, '../chapter-escape.md', 'bad'), (error) => error?.code === 'invalid_resource_name');
    assert.equal(fs.existsSync(path.join(root, 'chapter-escape.md')), false);

    await novelData.writeChapter(novelDir, 'chapter-Case.md', 'case');
    await assert.rejects(() => novelData.writeChapter(novelDir, 'chapter-case.md', 'collision'), (error) => error?.code === 'resource_name_conflict');
    await novelData.writeChapter(novelDir, 'chapter-é.md', 'nfkc');
    await assert.rejects(() => novelData.writeChapter(novelDir, 'chapter-e\u0301.md', 'collision'), (error) => error?.code === 'resource_name_conflict');

    const absent = await novelData.deleteChapter(novelDir, 'chapter-404.md', { commandId: 'delete-missing' });
    assert.deepEqual({ deleted: absent.deleted, reason: absent.reason, treeChanged: absent.treeChanged }, { deleted: false, reason: 'not_found', treeChanged: false });
    assert.deepEqual(await novelData.deleteChapter(novelDir, 'chapter-404.md', { commandId: 'delete-missing' }), absent, 'same command returns the same receipt');

    await novelData.writeChapterWithMeta(novelDir, 'chapter-delete.md', '正文\r\n', { title: '待删除' });
    await assert.rejects(() => novelData.deleteChapter(novelDir, 'chapter-delete.md', { commandId: 'needs-confirmation' }), (error) => error?.code === 'confirmation_required');
    assert.equal(await novelData.readChapter(novelDir, 'chapter-delete.md'), '正文\r\n');
    const deleted = await novelData.deleteChapter(novelDir, 'chapter-delete.md', { confirmed: true, commandId: 'delete-once' });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.treeChanged, true);
    assert.ok(deleted.revisionId, 'delete keeps a recoverable revision');
    assert.equal(fs.existsSync(path.join(novelDir, 'chapters', 'chapter-delete.md')), false);
    assert.deepEqual(await novelData.deleteChapter(novelDir, 'chapter-delete.md', { confirmed: true, commandId: 'delete-once' }), deleted);

    const atomicTarget = path.join(root, 'atomic', 'value.txt');
    const write = await atomicWriteFile(atomicTarget, Buffer.from('exact\r\nbytes\n'));
    assert.equal(write.contentHash.length, 64);
    assert.deepEqual(await fsp.readFile(atomicTarget), Buffer.from('exact\r\nbytes\n'));
    assert.equal((await fsp.readdir(path.dirname(atomicTarget))).some((name) => name.includes('.tmp-')), false);
    console.log('TEST_PASS storage-resource-atomicity-regression');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(`TEST_FAIL storage-resource-atomicity-regression: ${error.stack || error}`); process.exitCode = 1; });
module.exports = { run };
