'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const chapterDraftService = require(path.join(ROOT, 'src/main/runtime/chapterDraftService'));

const targetChapter = {
  name: 'chapter-022.md',
  displayName: '第二十二章',
  titleHint: '第二十二章',
};

function run() {
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

  try {
    const contaminated = JSON.stringify({
      title: '夜雨',
      summary: '测试污染文本',
      text: [
        '我松开她的唇，低头看掌中的玉佩。',
        '',
        '确实是旧玉——之前章节写成新玉，该改了。她没有说话，只把指尖收进袖中。',
      ].join('\n'),
    });
    assert.throws(
      () => chapterDraftService._testNormalizeDraft(contaminated, targetChapter),
      /章节草稿包含非小说内容/u
    );
    pass('CDC1_rejects_embedded_editorial_note', 'embedded chapter-correction note is blocked before pending draft');
  } catch (err) {
    fail('CDC1_rejects_embedded_editorial_note', err?.stack || err?.message || String(err));
  }

  try {
    const clean = JSON.stringify({
      title: '夜雨',
      summary: '测试正常文本',
      text: '我松开她的手，低头看掌中的旧玉。雨水从檐角滴下来，她没有说话，只把指尖收进袖中。',
    });
    const draft = chapterDraftService._testNormalizeDraft(clean, targetChapter);
    assert.equal(draft.title, '夜雨');
    assert.match(draft.text, /雨水从檐角滴下来/u);
    pass('CDC2_allows_clean_narrative_text', 'normal narrative text still passes');
  } catch (err) {
    fail('CDC2_allows_clean_narrative_text', err?.stack || err?.message || String(err));
  }

  if (results.failed) {
    console.error(`TEST_SUMMARY failed=${results.failed} passed=${results.passed} total=${results.total}`);
    process.exit(1);
  }
  console.log(`TEST_SUMMARY failed=0 passed=${results.passed} total=${results.total}`);
}

run();
