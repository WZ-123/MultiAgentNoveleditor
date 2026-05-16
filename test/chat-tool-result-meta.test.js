import assert from 'node:assert/strict';
import { parseToolResultMeta } from '../src/components/chatToolResultMeta.mjs';

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message || err}`);
    process.exitCode = 1;
  }
}

test('CTRM1_parses_structured_checkpoint_and_changed_file', () => {
  const resultText = JSON.stringify({
    ok: true,
    message: '已替换当前章节中的选中文本',
    checkpoint: {
      kind: 'chapter',
      source: 'replace_selected_text',
      novelId: 'novel-1',
      chapterName: 'chapter-001.md',
      label: '第一章',
      beforeContent: 'old',
      afterContent: 'new',
      beforeMetadata: { title: '旧标题' },
      afterMetadata: { title: '新标题' },
      restoreMode: 'write',
    },
    changedFiles: [
      {
        kind: 'chapter',
        novelId: 'novel-1',
        chapterName: 'chapter-001.md',
        label: '第一章',
        beforeContent: 'old',
        afterContent: 'new',
        restoreMode: 'write',
      },
    ],
  });

  const meta = parseToolResultMeta(resultText);
  assert.equal(meta.summary, '已替换当前章节中的选中文本');
  assert.equal(meta.changedFiles.length, 1);
  assert.equal(meta.changedFiles[0].chapterName, 'chapter-001.md');
  assert.equal(meta.checkpoint?.novelId, 'novel-1');
  assert.equal(meta.checkpoint?.restoreMode, 'write');
});

test('CTRM2_falls_back_to_plain_text_for_unstructured_result', () => {
  const meta = parseToolResultMeta('Text inserted successfully (12 chars)');
  assert.equal(meta.summary, 'Text inserted successfully (12 chars)');
  assert.equal(meta.changedFiles.length, 0);
  assert.equal(meta.checkpoint, null);
});