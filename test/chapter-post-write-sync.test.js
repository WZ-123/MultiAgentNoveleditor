'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-post-write-sync');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '章节回写同步回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  return { entry, dir, cleanupRoot: tmpRoot };
}

async function runChapterPostWriteSyncRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chapter-post-write-sync-userdata');
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
  let providerCallCount = 0;
  const responses = [
    {
      summary: '第一版摘要',
      outlineActualSummary: '第一版写后大纲摘要',
      supplementMarkdown: '- 第一版补充',
      timelineEvents: [
        {
          when: '当晚',
          where: '武夷山',
          participants: ['楚岚', '陈队长'],
          description: '陈队长当晚赶到武夷山领人。',
        },
        {
          when: '次日清晨',
          where: '高速路上',
          participants: ['楚岚', '陈队长'],
          description: '两人连夜返程，天亮前驶离山区。',
        },
      ],
    },
    {
      summary: '第二版摘要',
      outlineActualSummary: '楚岚回到鹏城后转入复盘阶段，阿宁加入信息核对，旧线索被重新挂起。',
      outlineUpdates: [
        {
          nodeId: 'scene-3-main',
          actualSummary: '楚岚回到鹏城，与阿宁复盘吴老狗留下的疑点，确认下一步调查方向。',
          actualBeats: ['返程后的落点从领人转为复盘', '阿宁成为下一步调查的信息支点'],
        },
      ],
      supplementMarkdown: '- 第二版补充',
      timelineEvents: [
        {
          when: '次日上午',
          where: '鹏城',
          participants: ['楚岚', '阿宁'],
          description: '楚岚回到鹏城后与阿宁复盘吴老狗的蹊跷。',
        },
      ],
    },
    {
      summary: '第三版摘要',
      outlineActualSummary: '第三版写后大纲摘要',
      supplementMarkdown: '',
      timelineEvents: [],
    },
  ];

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    pass('P1_seed_novel', `novel=${seeded.entry.id}`);

    await subagentsStore.ensureBuiltinSeeds();
    providerManager.getActiveProvider = async () => ({
      id: 'post-write-sync-provider',
      name: 'post-write-sync-provider',
      type: 'anthropic',
      apiKey: 'post-write-sync-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'post-write-sync-model' }],
    });
    modelAliases.getAlias = async () => ({
      id: 'opus',
      providerId: null,
      modelId: 'post-write-sync-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    runSubagentModule.runSubagent = async () => {
      const payload = responses[Math.min(providerCallCount, responses.length - 1)];
      providerCallCount += 1;
      return { output: JSON.stringify(payload) };
    };
    delete require.cache[require.resolve(path.join(ROOT, 'src/main/runtime/chapterPostWriteService'))];
    const { persistChapterArtifacts } = require(path.join(ROOT, 'src/main/runtime/chapterPostWriteService'));

    const draft = {
      name: 'chapter-003.md',
      displayName: '第3章',
      title: '领人',
      summary: '章节草稿',
      text: '正文占位。',
    };

    await novelData.writeOutlineNodesToHierarchy(seeded.dir, [
      { id: 'vol-1', title: '鹏城疑云', summary: '楚岚回到鹏城追查旧案。', volumeIndex: 1, level: 1 },
      { id: 'sec-1-1', title: '返程复盘', summary: '领人后进入复盘。', volumeIndex: 1, sectionIndex: 1, level: 2 },
      {
        id: 'scene-3-main',
        title: '旧案复盘',
        summary: '原计划：楚岚返程后整理吴老狗留下的疑点。',
        volumeIndex: 1,
        sectionIndex: 1,
        chapterIndex: 3,
        characters: ['楚岚', '阿宁'],
        location: '鹏城',
      },
    ]);

    const first = await persistChapterArtifacts({ draft, abortSignal: null });
    const timelineAfterFirst = await novelData.queryTimeline(seeded.dir, { chapterRef: draft.name });
    if (first.timelineCount === 2 && timelineAfterFirst.length === 2) {
      pass('P2_first_sync_writes_initial_events', 'first post-write sync created two chapter-scoped events');
    } else {
      fail('P2_first_sync_writes_initial_events', JSON.stringify({ first, timelineAfterFirst }));
    }

    const second = await persistChapterArtifacts({ draft, abortSignal: null });
    const timelineAfterSecond = await novelData.queryTimeline(seeded.dir, { chapterRef: draft.name });
    const summaryAfterSecond = await novelData.readSummary(seeded.dir, draft.name);
    const outlineAfterSecond = await novelData.readOutlineChapter(seeded.dir, 1, 1, 3);
    if (
      second.timelineCount === 1
      && second.outlineUpdated === 1
      && timelineAfterSecond.length === 1
      && /次日上午/.test(timelineAfterSecond[0]?.when || '')
      && /阿宁复盘吴老狗/.test(timelineAfterSecond[0]?.description || '')
      && !timelineAfterSecond.some((event) => /武夷山领人|连夜返程/.test(event?.description || ''))
      && /第二版摘要/.test(summaryAfterSecond)
      && /写后进展/.test(outlineAfterSecond)
      && /楚岚回到鹏城，与阿宁复盘吴老狗留下的疑点/.test(outlineAfterSecond)
      && providerCallCount === 2
    ) {
      pass('P3_second_sync_replaces_old_chapter_events_and_updates_outline', 'second sync replaced the chapter timeline and wrote actual outline progress');
    } else {
      fail('P3_second_sync_replaces_old_chapter_events_and_updates_outline', JSON.stringify({ second, timelineAfterSecond, summaryAfterSecond, outlineAfterSecond, providerCallCount }));
    }

    const third = await persistChapterArtifacts({ draft, abortSignal: null });
    const timelineAfterThird = await novelData.queryTimeline(seeded.dir, { chapterRef: draft.name });
    const thirdWarnings = Array.isArray(third.warnings) ? third.warnings.join(' | ') : '';
    if (
      third.timelineCount === 1
      && timelineAfterThird.length === 1
      && /阿宁复盘吴老狗/.test(timelineAfterThird[0]?.description || '')
      && /保留本章原有时间线/.test(thirdWarnings)
      && providerCallCount === 3
    ) {
      pass('P4_empty_timeline_response_preserves_existing_events', 'empty AI timeline output no longer wipes existing chapter events');
    } else {
      fail('P4_empty_timeline_response_preserves_existing_events', JSON.stringify({ third, timelineAfterThird, providerCallCount }));
    }
  } catch (err) {
    fail('P5_harness', err.message || String(err));
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

module.exports = { runChapterPostWriteSyncRegressionTest };

if (require.main === module) {
  runChapterPostWriteSyncRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
