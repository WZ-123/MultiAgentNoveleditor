'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function runChapterWriteSanitizationRegressionTest() {
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

  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-write-sanitization');
  const novelDir = path.join(tmpRoot, 'novel-' + Date.now());

  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(novelDir, { recursive: true });

    const normalText = '第一段。\n\n第二段。';
    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', normalText, { title: '保留段落' });
    const readNormal = await novelData.readChapter(novelDir, 'chapter-001.md');
    if (readNormal === normalText) {
      pass('S1_preserve_normal_paragraph_breaks', 'double newline remains unchanged');
    } else {
      fail('S1_preserve_normal_paragraph_breaks', JSON.stringify({ expected: normalText, actual: readNormal }));
    }

    const noisyText = [
      '第一行\\n\\n第二行',
      '',
      '',
      '',
      '锟斤拷',
      '第三行�',
    ].join('\n');

    await novelData.writeChapterWithMeta(novelDir, 'chapter-002.md', noisyText, { title: '清洗异常文本' });
    const cleaned = await novelData.readChapter(novelDir, 'chapter-002.md');

    if (
      cleaned.includes('第一行\n\n第二行')
      && cleaned.includes('第三行')
      && !cleaned.includes('锟斤拷')
      && !cleaned.includes('�')
      && !/\n{3,}/.test(cleaned)
    ) {
      pass('S2_clean_pathological_newlines_and_mojibake', 'escaped newlines decoded and noisy placeholders removed');
    } else {
      fail('S2_clean_pathological_newlines_and_mojibake', JSON.stringify({ cleaned }));
    }
  } catch (err) {
    fail('S3_harness', err && err.stack ? err.stack : String(err));
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

module.exports = { runChapterWriteSanitizationRegressionTest };

if (require.main === module) {
  runChapterWriteSanitizationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
