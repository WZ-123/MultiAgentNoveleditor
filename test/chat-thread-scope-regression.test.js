'use strict';

const path = require('node:path');

async function runChatThreadScopeRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const scope = await import(path.join(ROOT, 'src/components/chatThreadScope.mjs'));

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
    const threads = [
      { id: 'thread-a-1', title: 'A-1', novelId: 'novel-a' },
      { id: 'thread-empty-1', title: 'Blank-1', novelId: null },
      { id: 'thread-b-1', title: 'B-1', novelId: 'novel-b' },
      { id: 'thread-empty-legacy', title: 'Blank-legacy' },
    ];

    const inA = scope.splitThreadsByNovel(threads, 'novel-a');
    if (
      inA.currentThreads.map((thread) => thread.id).join(',') === 'thread-a-1'
      && inA.otherThreads.map((thread) => thread.id).join(',') === 'thread-empty-1,thread-b-1,thread-empty-legacy'
    ) {
      pass('CTS1_current_project_only_shows_own_threads', 'novel-a only keeps its own thread in current list');
    } else {
      fail('CTS1_current_project_only_shows_own_threads', JSON.stringify(inA));
    }

    const inBlank = scope.splitThreadsByNovel(threads, '');
    if (
      inBlank.currentThreads.map((thread) => thread.id).join(',') === 'thread-empty-1,thread-empty-legacy'
      && inBlank.otherThreads.map((thread) => thread.id).join(',') === 'thread-a-1,thread-b-1'
    ) {
      pass('CTS2_blank_project_absorbs_null_and_legacy_threads', 'blank project includes null and missing novelId threads');
    } else {
      fail('CTS2_blank_project_absorbs_null_and_legacy_threads', JSON.stringify(inBlank));
    }

    const titleMap = scope.buildNovelTitleMap([
      { id: 'novel-a', title: 'A项目' },
      { id: 'novel-b', title: 'B项目' },
    ]);
    if (
      scope.getThreadNovelLabel({ novelId: 'novel-b' }, titleMap) === 'B项目'
      && scope.getThreadNovelLabel({ novelId: null }, titleMap) === '空白项目'
      && scope.getThreadNovelLabel({}, titleMap) === '空白项目'
    ) {
      pass('CTS3_labels_include_blank_project_compat', 'project labels resolve correctly for mapped and blank threads');
    } else {
      fail('CTS3_labels_include_blank_project_compat', 'label resolution mismatch');
    }

    if (
      scope.shouldConfirmThreadProjectSwitch({ novelId: 'novel-b' }, 'novel-a')
      && !scope.shouldConfirmThreadProjectSwitch({ novelId: null }, '')
      && scope.shouldConfirmThreadProjectSwitch({ novelId: null }, 'novel-a')
    ) {
      pass('CTS4_cross_project_detection_handles_blank_project', 'confirm logic only triggers on actual project changes');
    } else {
      fail('CTS4_cross_project_detection_handles_blank_project', 'confirm logic mismatch');
    }
  } catch (err) {
    fail('CTS5_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatThreadScopeRegressionTest };

if (require.main === module) {
  runChatThreadScopeRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}