'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

async function runChapterReplaceContextRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-replace-context');
  const novelDir = path.join(tmpRoot, 'novel-' + Date.now());

  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(novelDir, { recursive: true });

    const duplicateContent = [
      '第一段。',
      '',
      '她轻声说：“欢迎回来。”',
      '',
      '第二段。',
      '',
      '她轻声说：“欢迎回来。”',
      '',
      '第三段。',
    ].join('\n');

    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', duplicateContent, { title: '上下文锚点' });
    const duplicateResult = await novelData.replaceChapterText(
      novelDir,
      'chapter-001.md',
      '她轻声说：“欢迎回来。”',
      '她压低声音说：“欢迎回来。”',
      {
        beforeContext: '第二段。',
        afterContext: '第三段。',
      }
    );
    const duplicateAfter = await novelData.readChapter(novelDir, 'chapter-001.md');

    assert.equal(duplicateResult.matchStrategy, 'normalized_context');
    assert.equal((duplicateAfter.match(/压低声音/g) || []).length, 1);
    assert.ok(duplicateAfter.includes('第一段。\n\n她轻声说：“欢迎回来。”'));
    assert.ok(duplicateAfter.includes('第二段。\n\n她压低声音说：“欢迎回来。”'));
    pass('CRC1_context_anchor_resolves_duplicate_occurrence', 'beforeContext/afterContext narrowed a duplicate target down to the intended occurrence');

    const normalizedContent = '窗外是雨声。\r\n\r\n她说：\u3000“今夜先别走。”\r\n\r\n门外的脚步声停住了。';
    await novelData.writeChapterWithMeta(novelDir, 'chapter-002.md', normalizedContent, { title: '规范化匹配' });
    const normalizedResult = await novelData.replaceChapterText(
      novelDir,
      'chapter-002.md',
      '她说: "今夜先别走。"',
      '她轻声说：“今夜先别走。”',
      {
        beforeContext: '窗外是雨声。',
        afterContext: '门外的脚步声停住了。',
      }
    );
    const normalizedAfter = await novelData.readChapter(novelDir, 'chapter-002.md');

    assert.equal(normalizedResult.matchStrategy, 'normalized_context');
    assert.ok(normalizedAfter.includes('她轻声说：“今夜先别走。”'));
    assert.equal(normalizedAfter.includes('她说：　“今夜先别走。”'), false);
    pass('CRC2_normalized_matching_tolerates_line_endings_and_fullwidth_forms', 'replaceChapterText matched a visually equivalent span despite CRLF and full-width spacing differences');
  } catch (err) {
    fail('CRC_harness', err && err.stack ? err.stack : String(err));
  } finally {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChapterReplaceContextRegressionTest };

if (require.main === module) {
  runChapterReplaceContextRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}