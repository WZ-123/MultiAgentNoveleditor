'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runRuntimeActiveNovelDriverRegressionTest() {
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
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-runtime-active-novel-driver-userdata');
  process.env.MANA_USE_STDIO_MCP = '0';

  try {
    const runSubagentPath = path.join(ROOT, 'src/main/runtime/runSubagent.js');
    const workflowPath = path.join(ROOT, 'src/main/runtime/workflowOrchestrator.js');
    const subagentsPath = path.join(ROOT, 'src/main/store/subagents.js');
    const mcpPath = path.join(ROOT, 'src/main/mcp/mcpClientStdio.js');
    const chapterPath = path.join(ROOT, 'src/main/runtime/chapterDraftService.js');
    const outlinePath = path.join(ROOT, 'src/main/runtime/outlineDraftService.js');

    const touched = [runSubagentPath, workflowPath, subagentsPath, mcpPath, chapterPath, outlinePath];
    const originalCache = new Map();
    for (const filePath of touched) {
      originalCache.set(filePath, require.cache[filePath]);
      delete require.cache[filePath];
    }

    const workflowCalls = [];
    require.cache[runSubagentPath] = {
      id: runSubagentPath,
      filename: runSubagentPath,
      loaded: true,
      exports: {
        runSubagent: async ({ subagentId }) => {
          if (subagentId === 'sa-writer') {
            return { output: JSON.stringify({ title: '测试标题', text: '测试正文。' }) };
          }
          if (subagentId === 'sa-outline-drafter') {
            return { output: JSON.stringify({ nodes: [{ id: '1', title: '场景一', summary: '摘要' }] }) };
          }
          throw new Error('forced reviewer fallback');
        },
      },
    };
    require.cache[workflowPath] = {
      id: workflowPath,
      filename: workflowPath,
      loaded: true,
      exports: {
        runWorkflow: async (args) => {
          workflowCalls.push(args);
          return { output: JSON.stringify({ issues: [] }) };
        },
      },
    };
    require.cache[subagentsPath] = {
      id: subagentsPath,
      filename: subagentsPath,
      loaded: true,
      exports: {
        getSubagent: async () => ({ systemPrompt: '' }),
      },
    };
    require.cache[mcpPath] = {
      id: mcpPath,
      filename: mcpPath,
      loaded: true,
      exports: {
        getActiveNovelContext: () => ({ id: 'novel-test', dir: '/tmp/novel-test' }),
        callTool: async ({ name }) => {
          if (name === 'suggest_next_chapter_name') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ fileName: 'chapter-001.md', displayName: '第1章' }),
              }],
            };
          }
          throw new Error(`unexpected tool call: ${name}`);
        },
      },
    };

    const chapterService = require(chapterPath);
    const outlineService = require(outlinePath);

    await chapterService.generateChapterDraft({
      mode: 'create',
      userText: '写一章',
      pendingChapterDraft: { name: 'chapter-001.md', displayName: '第1章' },
      editorContext: {},
    });
    await outlineService.generateOutlineDraft({
      mode: 'create',
      userText: '给个大纲',
      pendingOutlineDraft: null,
    });

    const reviewerCalls = workflowCalls.filter((call) =>
      call.subagentId === 'sa-character-reviewer' || call.subagentId === 'sa-timeline-guardian'
    );
    assert.equal(reviewerCalls.length, 4, `expected 4 reviewer fallback calls, got ${reviewerCalls.length}`);
    for (const call of reviewerCalls) {
      assert.deepEqual(call.novelContext, { novelId: 'novel-test', novelDir: '/tmp/novel-test' });
    }

    pass(
      'RAD1_reviewer_workflow_fallback_inherits_active_novel_context',
      'chapter + outline reviewer fallback both carried novelContext'
    );

    for (const filePath of touched) {
      delete require.cache[filePath];
      const original = originalCache.get(filePath);
      if (original) require.cache[filePath] = original;
    }
  } catch (err) {
    fail('RAD1_reviewer_workflow_fallback_inherits_active_novel_context', err?.message || String(err));
  }

  try {
    const driver = require(path.join(ROOT, 'src/main/runtime/drivers/claudeCodeVscode.js'));
    const expected = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit'];
    for (const toolName of expected) {
      assert.ok(driver.PREAPPROVED_TOOLS.includes(toolName), `missing preapproved tool ${toolName}`);
      assert.ok(driver.DEFAULT_ALLOWED_TOOLS.includes(toolName), `missing allowed tool ${toolName}`);
    }
    assert.ok(driver.DEFAULT_ALLOWED_TOOLS.includes('mcp__novel-tools__*'));
    assert.ok(driver.DEFAULT_ALLOWED_TOOLS.includes('Task'));
    assert.ok(driver.DEFAULT_ALLOWED_TOOLS.includes('Agent'));

    pass(
      'RAD2_claude_code_driver_preapproves_common_file_tools',
      'driver exports stable allowlists for MCP + built-in file tools'
    );
  } catch (err) {
    fail('RAD2_claude_code_driver_preapproves_common_file_tools', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runRuntimeActiveNovelDriverRegressionTest };

if (require.main === module) {
  runRuntimeActiveNovelDriverRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
