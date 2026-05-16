'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function pass(name, detail) {
  console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, detail) {
  console.log(`TEST_FAIL ${name}: ${detail}`);
}

async function runOutlineDraftReviewRegression() {
  let passed = 0;
  let failed = 0;

  const mcpPath = path.join(ROOT, 'src/main/mcp/mcpClientStdio.js');
  const subagentsPath = path.join(ROOT, 'src/main/store/subagents.js');
  const workflowPath = path.join(ROOT, 'src/main/runtime/workflowOrchestrator.js');
  const runSubagentPath = path.join(ROOT, 'src/main/runtime/runSubagent.js');
  const servicePath = path.join(ROOT, 'src/main/runtime/outlineDraftService.js');

  const originalMcp = require.cache[mcpPath];
  const originalSubagents = require.cache[subagentsPath];
  const originalWorkflow = require.cache[workflowPath];
  const originalRunSubagent = require.cache[runSubagentPath];
  const originalService = require.cache[servicePath];

  try {
    require.cache[mcpPath] = {
      id: mcpPath,
      filename: mcpPath,
      loaded: true,
      exports: {
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        getActiveNovelContext: () => ({ id: 'novel-test', dir: '/tmp/novel-test' }),
      },
    };

    require.cache[subagentsPath] = {
      id: subagentsPath,
      filename: subagentsPath,
      loaded: true,
      exports: {
        getSubagent: async (id) => ({ id, systemPrompt: `${id} prompt` }),
      },
    };

    require.cache[workflowPath] = {
      id: workflowPath,
      filename: workflowPath,
      loaded: true,
      exports: {
        runWorkflow: async ({ subagentId }) => {
          if (subagentId === 'sa-timeline-guardian') {
            throw new Error('workflow fallback unavailable');
          }
          return { output: JSON.stringify({ issues: [] }) };
        },
      },
    };

    require.cache[runSubagentPath] = {
      id: runSubagentPath,
      filename: runSubagentPath,
      loaded: true,
      exports: {
        runSubagent: async ({ subagentId }) => {
          if (subagentId === 'sa-outline-drafter') {
            return {
              output: JSON.stringify({
                master: [{ id: 'vol-1', title: '回港', summary: '主角返港', volumeIndex: 1 }],
                volumes: [{
                  volumeIndex: 1,
                  metadata: { id: 'vol-1', title: '回港', summary: '主角返港', volumeIndex: 1 },
                  sections: [{
                    sectionIndex: 1,
                    metadata: { id: 'sec-1-1', title: '旧案回潮', summary: '旧案回潮', volumeIndex: 1, sectionIndex: 1 },
                    chapterOutlines: [{
                      chapterIndex: 1,
                      title: '归雾',
                      scenes: [{
                        id: 'scene-1',
                        title: '来信抵港',
                        summary: '主角收到求救信。',
                        characters: ['hero'],
                        location: '海雾港',
                        volumeIndex: 1,
                        sectionIndex: 1,
                        chapterIndex: 1,
                      }],
                    }],
                  }],
                }],
              }),
            };
          }
          if (subagentId === 'sa-character-reviewer') {
            return { output: JSON.stringify({ issues: [] }) };
          }
          if (subagentId === 'sa-timeline-guardian') {
            throw new Error('timeline mcp chain unstable');
          }
          return { output: JSON.stringify({ issues: [] }) };
        },
      },
    };

    delete require.cache[servicePath];
    const outlineDraftService = require(servicePath);

    const result = await outlineDraftService.generateOutlineDraft({
      mode: 'plot_direction',
      userText: '第三章的剧情是陈队长先去领人，第四章准备开直播。',
      pendingOutlineDraft: null,
    });

    if (/大纲草案/.test(result.assistantText) && /我现在先停在大纲审阅阶段，不进入正文写作/.test(result.assistantText)) {
      pass('R1_outline_reply_stays_in_review_stage', 'assistant text explicitly stays in outline review');
      passed += 1;
    } else {
      fail('R1_outline_reply_stays_in_review_stage', result.assistantText);
      failed += 1;
    }

    if (result.blockingIssues.some((issue) => issue.reviewIncomplete && issue.sourceAgent === 'timeline') && /时空校验本轮未完成/.test(result.assistantText)) {
      pass('R2_timeline_review_failure_is_visible', 'timeline review failure is surfaced to the user');
      passed += 1;
    } else {
      fail('R2_timeline_review_failure_is_visible', JSON.stringify({ issues: result.blockingIssues, text: result.assistantText }));
      failed += 1;
    }
  } catch (err) {
    fail('R3_harness', err.message || String(err));
    failed += 1;
  } finally {
    if (originalMcp) require.cache[mcpPath] = originalMcp; else delete require.cache[mcpPath];
    if (originalSubagents) require.cache[subagentsPath] = originalSubagents; else delete require.cache[subagentsPath];
    if (originalWorkflow) require.cache[workflowPath] = originalWorkflow; else delete require.cache[workflowPath];
    if (originalRunSubagent) require.cache[runSubagentPath] = originalRunSubagent; else delete require.cache[runSubagentPath];
    if (originalService) require.cache[servicePath] = originalService; else delete require.cache[servicePath];
  }

  console.log(`TEST_SUMMARY ${passed}/${passed + failed} passed, ${failed} failed`);
  console.log('TEST_DONE');
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  runOutlineDraftReviewRegression().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}