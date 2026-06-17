import assert from 'node:assert/strict';
import { buildChapterChangePreview } from '../src/components/changePreview.mjs';

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message || err}`);
    process.exitCode = 1;
  }
}

test('CCP1_summarizes_local_change_without_full_chapter_preview', () => {
  const before = [
    '保留开头。',
    '旧句一。',
    '旧句二。',
    '旧句三。',
    '旧句四。',
    '旧句五。',
    '保留结尾。',
  ].join('\n');
  const after = [
    '保留开头。',
    '新句一。',
    '新句二。',
    '新句三。',
    '新句四。',
    '新句五。',
    '保留结尾。',
  ].join('\n');

  const preview = buildChapterChangePreview(before, after);

  assert.equal(preview.summary, '第 2-6 行：改写 5 行，变为 5 行');
  assert.match(preview.beforeSnippet, /旧句一/);
  assert.match(preview.afterSnippet, /新句一/);
  assert.doesNotMatch(preview.beforeSnippet, /保留开头|保留结尾/);
  assert.doesNotMatch(preview.afterSnippet, /保留开头|保留结尾/);
});

test('CCP2_truncates_large_rewrite_preview', () => {
  const before = Array.from({ length: 20 }, (_, index) => `旧正文第 ${index + 1} 行`).join('\n');
  const after = Array.from({ length: 20 }, (_, index) => `新正文第 ${index + 1} 行`).join('\n');

  const preview = buildChapterChangePreview(before, after);

  assert.equal(preview.summary, '第 1-20 行：改写 20 行，变为 20 行');
  assert.match(preview.beforeSnippet, /\.\.\./);
  assert.match(preview.afterSnippet, /\.\.\./);
  assert.doesNotMatch(preview.beforeSnippet, /旧正文第 20 行/);
  assert.doesNotMatch(preview.afterSnippet, /新正文第 20 行/);
});
