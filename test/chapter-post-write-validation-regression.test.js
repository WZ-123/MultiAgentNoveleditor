'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-post-write-validation');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '章节回写校验回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  return { entry, dir, cleanupRoot: tmpRoot };
}

async function runChapterPostWriteValidationRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chapter-post-write-validation-userdata');
  process.env.MANA_USE_STDIO_MCP = '0';

  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
  const runSubagentModule = require(path.join(ROOT, 'src/main/runtime/runSubagent'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const subagentsStore = require(path.join(ROOT, 'src/main/store/subagents'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalRunSubagent = runSubagentModule.runSubagent;

  let cleanupRoot = '';
  let analysisCallCount = 0;

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    pass('V1_seed_novel', `novel=${seeded.entry.id}`);

    await subagentsStore.ensureBuiltinSeeds();
    providerManager.getActiveProvider = async () => ({
      id: 'post-write-validation-provider',
      name: 'post-write-validation-provider',
      type: 'anthropic',
      apiKey: 'post-write-validation-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'post-write-validation-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'opus',
      providerId: null,
      modelId: 'post-write-validation-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    runSubagentModule.runSubagent = async () => {
      const payloads = [
        {
          summary: '校验摘要',
          supplementMarkdown: '',
          timelineEvents: [
            { when: '晚上八点', where: '直播间', participants: ['楚岚'], description: '第四章直播事件' },
          ],
        },
        {
          summary: '低置信摘要',
          summaryConfidence: 0.92,
          timelineConfidence: 0.42,
          outlineConfidence: 0.81,
          supplementMarkdown: '',
          timelineEvents: [
            { when: '错误时间', where: '错误地点', participants: ['楚岚'], description: '低置信事件不应覆盖。' },
          ],
        },
        {
          summary: '无理由清空摘要',
          summaryConfidence: 0.95,
          timelineConfidence: 0.95,
          outlineConfidence: 0.95,
          supplementMarkdown: '',
          timelineEvents: [],
          timelineShouldClear: true,
        },
      ];
      const payload = payloads[Math.min(analysisCallCount, payloads.length - 1)];
      analysisCallCount += 1;
      return { output: JSON.stringify(payload) };
    };
    delete require.cache[require.resolve(path.join(ROOT, 'src/main/runtime/chapterPostWriteService'))];
    const { persistChapterArtifacts } = require(path.join(ROOT, 'src/main/runtime/chapterPostWriteService'));

    await novelData.writeChapter(seeded.dir, 'chapter-001.md', '第1章');
    await novelData.writeChapter(seeded.dir, 'chapter-002.md', '第2章');
    await novelData.writeChapter(seeded.dir, 'chapter-003.md', '第3章');
    await novelData.writeChapter(seeded.dir, 'chapter-004.md', '第4章');
    await novelData.syncTimelineEventsForChapter(seeded.dir, 'chapter-001.md', [
      { when: '第一夜', where: '破庙', participants: ['楚岚'], description: '第一章事件' },
    ]);
    await novelData.syncTimelineEventsForChapter(seeded.dir, 'chapter-002.md', [
      { when: '第二天白天', where: '天桥', participants: ['阿宁'], description: '第二章事件' },
    ]);
    await novelData.syncTimelineEventsForChapter(seeded.dir, 'chapter-003a.md', [
      { when: '废弃插章夜间', where: '旧稿', participants: ['楚岚'], description: 'chapter-003a 残留事件' },
    ]);

    const result = await persistChapterArtifacts({
      draft: {
        name: 'chapter-004.md',
        displayName: '第4章',
        title: '直播间论牛',
        summary: '章节草稿',
        text: '正文占位。',
      },
      abortSignal: null,
    });

    const blocking = Array.isArray(result.blockingWarnings) ? result.blockingWarnings.join(' | ') : '';
    const warnings = Array.isArray(result.warnings) ? result.warnings.join(' | ') : '';
    if (/缺少时间线覆盖的章节: chapter-003.md/.test(blocking) && /残留或无效章节引用: chapter-003a.md/.test(blocking) && /时间线校验未通过：缺少时间线覆盖的章节: chapter-003.md/.test(warnings)) {
      pass('V2_post_write_surfaces_blocking_timeline_validation', 'persistChapterArtifacts marked missing chapter and orphan chapter refs as blocking');
    } else {
      fail('V2_post_write_surfaces_blocking_timeline_validation', JSON.stringify(result));
    }

    const lowConfidenceResult = await persistChapterArtifacts({
      draft: {
        name: 'chapter-004.md',
        displayName: '第4章',
        title: '直播间论牛',
        summary: '章节草稿',
        text: '正文占位。',
      },
      abortSignal: null,
    });
    const timelineAfterLowConfidence = await novelData.queryTimeline(seeded.dir, { chapterRef: 'chapter-004.md' });
    const lowConfidenceWarnings = Array.isArray(lowConfidenceResult.warnings) ? lowConfidenceResult.warnings.join(' | ') : '';
    const lowConfidenceToolNames = (lowConfidenceResult.toolCalls || []).map((toolCall) => toolCall.name);
    if (
      lowConfidenceResult.summarySaved
      && lowConfidenceResult.timelineCount === 1
      && lowConfidenceResult.outlineUpdated === 0
      && /第四章直播事件/.test(timelineAfterLowConfidence[0]?.description || '')
      && !/低置信事件/.test(timelineAfterLowConfidence[0]?.description || '')
      && /置信度低于 0.75/.test(lowConfidenceWarnings)
      && !lowConfidenceToolNames.includes('sync_chapter_timeline')
      && !lowConfidenceToolNames.includes('write_outline_nodes')
    ) {
      pass('V2b_low_confidence_only_saves_summary', 'low-confidence post-write analysis preserved timeline and skipped outline sync');
    } else {
      fail('V2b_low_confidence_only_saves_summary', JSON.stringify({ lowConfidenceResult, timelineAfterLowConfidence, lowConfidenceToolNames }));
    }

    const clearWithoutReason = await persistChapterArtifacts({
      draft: {
        name: 'chapter-004.md',
        displayName: '第4章',
        title: '直播间论牛',
        summary: '章节草稿',
        text: '正文占位。',
      },
      abortSignal: null,
    });
    const timelineAfterClearWithoutReason = await novelData.queryTimeline(seeded.dir, { chapterRef: 'chapter-004.md' });
    const clearWarnings = Array.isArray(clearWithoutReason.warnings) ? clearWithoutReason.warnings.join(' | ') : '';
    if (
      clearWithoutReason.timelineCount === 1
      && timelineAfterClearWithoutReason.length === 1
      && /第四章直播事件/.test(timelineAfterClearWithoutReason[0]?.description || '')
      && /未提供 timelineClearReason/.test(clearWarnings)
    ) {
      pass('V2c_timeline_clear_requires_reason', 'timelineShouldClear without reason preserved existing chapter timeline');
    } else {
      fail('V2c_timeline_clear_requires_reason', JSON.stringify({ clearWithoutReason, timelineAfterClearWithoutReason }));
    }
  } catch (err) {
    fail('V3_harness', err && err.stack ? err.stack : String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    anthropicProvider.sendMessage = originalSendMessage;
    runSubagentModule.runSubagent = originalRunSubagent;
    try {
      await mcpClient.dispose();
    } catch {
      // ignore
    }
    try {
      if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChapterPostWriteValidationRegressionTest };

if (require.main === module) {
  runChapterPostWriteValidationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
