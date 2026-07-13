'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureNovelLayout } = require('../src/main/store/paths');
const novelData = require('../src/main/store/novelData');

function hash(value) {
  return createHash('sha256').update(String(value || '').replace(/\r\n/gu, '\n').trim()).digest('hex').slice(0, 16);
}

async function run() {
  const root = path.join(__dirname, '..', 'tmp-test-chapter-mutation-preview');
  await fs.rm(root, { recursive: true, force: true });
  try {
    ensureNovelLayout(root);
    await novelData.writeChapter(root, 'chapter-001.md', '第一段。\n\n气密门同时关闭。');
    const preview = await novelData.replaceChapterText(root, 'chapter-001.md', '同时关闭', '依次关闭', { previewOnly: true });
    assert.equal(preview.previewOnly, true);
    assert.match(preview.content, /依次关闭/u);
    assert.match(await novelData.readChapter(root, 'chapter-001.md'), /同时关闭/u);

    await assert.rejects(
      novelData.replaceChapterText(root, 'chapter-001.md', '同时关闭', '依次关闭', {
        baseContent: preview.baseContent,
        verifiedContentHash: 'wrong-hash',
      }),
      /verification hash mismatch/u,
    );
    assert.match(await novelData.readChapter(root, 'chapter-001.md'), /同时关闭/u);

    await novelData.replaceChapterText(root, 'chapter-001.md', '同时关闭', '依次关闭', {
      baseContent: preview.baseContent,
      verifiedContentHash: hash(preview.content),
    });
    assert.match(await novelData.readChapter(root, 'chapter-001.md'), /依次关闭/u);

    const beforeEditorCommit = await novelData.readChapter(root, 'chapter-001.md');
    const editorCandidate = `${beforeEditorCommit}\n\n她回头确认门锁。`;
    await assert.rejects(
      novelData.writeChapterWithMeta(root, 'chapter-001.md', editorCandidate, { title: '第一章' }, {
        baseContent: beforeEditorCommit,
        verifiedContentHash: 'stale-verification-hash',
      }),
      /verification hash mismatch/u,
    );
    assert.equal(await novelData.readChapter(root, 'chapter-001.md'), beforeEditorCommit);
    await novelData.writeChapterWithMeta(root, 'chapter-001.md', editorCandidate, { title: '第一章' }, {
      baseContent: beforeEditorCommit,
      verifiedContentHash: hash(editorCandidate),
    });
    assert.equal(await novelData.readChapter(root, 'chapter-001.md'), editorCandidate);
    console.log('TEST_PASS chapter-mutation-preview-regression');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { run };
