'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function runFrontmatterTitleRegressionTest() {
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
  const {
    parseFrontmatter,
    readFrontmatterFromFileSync,
  } = require(path.join(ROOT, 'src/main/store/frontmatter'));
  const { resolveChapterTitle } = require(path.join(ROOT, 'src/main/store/novelData'));

  const sampleBody = '正文第一段。\n\n正文第二段。';
  const tmpRoot = path.join(ROOT, 'tmp-test-frontmatter-title-regression');

  try {
    const text = `---\ntitle: 武夷山破庙\nvolume: 1\nsection: 2\n---\n\n${sampleBody}`;
    const parsed = parseFrontmatter(text);
    if (parsed.metadata?.title === '武夷山破庙' && parsed.metadata?.volume === 1 && parsed.metadata?.section === 2) {
      pass('F1_parse_standard_frontmatter_title');
    } else {
      fail('F1_parse_standard_frontmatter_title', JSON.stringify(parsed.metadata));
    }

    const textCrLf = `\uFEFF---\r\ntitle： \"夜归\"\r\nvolume: 3\r\n---\r\n\r\n${sampleBody}`;
    const parsedCrLf = parseFrontmatter(textCrLf);
    if (parsedCrLf.metadata?.title === '夜归' && parsedCrLf.metadata?.volume === 3) {
      pass('F2_parse_bom_crlf_fullwidth_colon_title');
    } else {
      fail('F2_parse_bom_crlf_fullwidth_colon_title', JSON.stringify(parsedCrLf.metadata));
    }

    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(tmpRoot, { recursive: true });
    const f = path.join(tmpRoot, 'chapter-001.md');
    await fs.writeFile(f, textCrLf, 'utf8');

    const fm = readFrontmatterFromFileSync(f);
    if (fm?.metadata?.title === '夜归') {
      pass('F3_read_frontmatter_from_file_sync_title');
    } else {
      fail('F3_read_frontmatter_from_file_sync_title', JSON.stringify(fm));
    }

    const resolvedFromHeading = resolveChapterTitle({ content: '# 雨夜\n\n正文', fallbackTitle: '旧标题' });
    if (resolvedFromHeading === '雨夜') {
      pass('F4_resolve_title_prefers_heading_over_fallback');
    } else {
      fail('F4_resolve_title_prefers_heading_over_fallback', resolvedFromHeading);
    }

    const resolvedFromMetadata = resolveChapterTitle({ metadataTitle: '前置标题', content: '# 雨夜\n\n正文', fallbackTitle: '旧标题' });
    if (resolvedFromMetadata === '前置标题') {
      pass('F5_resolve_title_prefers_metadata_over_heading');
    } else {
      fail('F5_resolve_title_prefers_metadata_over_heading', resolvedFromMetadata);
    }

    const resolvedFromFallback = resolveChapterTitle({ content: '没有标题行', fallbackTitle: '旧标题' });
    if (resolvedFromFallback === '旧标题') {
      pass('F6_resolve_title_falls_back_when_content_has_no_heading');
    } else {
      fail('F6_resolve_title_falls_back_when_content_has_no_heading', resolvedFromFallback);
    }
  } catch (err) {
    fail('F7_harness', err && err.stack ? err.stack : String(err));
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

module.exports = { runFrontmatterTitleRegressionTest };

if (require.main === module) {
  runFrontmatterTitleRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
