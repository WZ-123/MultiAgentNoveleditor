'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runDeAiToolRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
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

  process.env.MANA_USE_STDIO_MCP = '0';
  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-de-ai-tool-userdata');

  try {
    const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
    const tools = await mcpClient.listTools();
    const deAiTool = (tools || []).find((tool) => tool.name === 'de_ai_ify');
    const deAiReviewTool = (tools || []).find((tool) => tool.name === 'review_de_ai_style');

    assert.ok(deAiTool);
    assert.ok(deAiReviewTool);
    assert.equal(deAiTool.inputSchema?.required?.includes('text'), true);
    assert.equal(deAiTool.requiresConfirmation, false);
    assert.equal(deAiReviewTool.requiresConfirmation, false);
    pass('DAT1_de_ai_tool_is_exposed_via_mcp', 'de_ai_ify and review_de_ai_style are visible in the MCP tool list');

    try {
      await mcpClient.dispose();
    } catch {
      // ignore
    }
  } catch (err) {
    fail('DAT1_de_ai_tool_is_exposed_via_mcp', err?.message || String(err));
  }

  try {
    const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
    const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
    const originalRunWorkflow = workflowOrchestrator.runWorkflow;
    const calls = [];
    workflowOrchestrator.runWorkflow = async (payload) => {
      calls.push(payload);
      return { output: '改写后的正文。' };
    };

    try {
      const tool = getToolByName('de_ai_ify');
      assert.ok(tool);
      const result = await tool.handler(
        { text: '然后她笑了。那是一个很淡的笑。', guidance: '保留冷淡感' },
        { novel: { id: 'novel-de-ai' }, novelDir: '/tmp/novel-de-ai' }
      );
      const payload = JSON.parse(result.content[0].text);

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.mode, 'subagent');
      assert.equal(calls[0]?.subagentId, 'sa-de-ai-ifier');
      assert.equal(calls[0]?.novelContext?.novelId, 'novel-de-ai');
      assert.equal(calls[0]?.novelContext?.novelDir, '/tmp/novel-de-ai');
      assert.match(calls[0]?.input || '', /去 AI 味改写/);
      assert.match(calls[0]?.input || '', /保留冷淡感/);
      assert.match(calls[0]?.input || '', /然后她笑了。那是一个很淡的笑。/);
      assert.equal(payload.revisedText, '改写后的正文。');
      assert.equal(payload.subagentId, 'sa-de-ai-ifier');
      pass('DAT2_de_ai_tool_wraps_dedicated_subagent', 'tool handler forwards to sa-de-ai-ifier and returns rewritten text');
    } finally {
      workflowOrchestrator.runWorkflow = originalRunWorkflow;
    }
  } catch (err) {
    fail('DAT2_de_ai_tool_wraps_dedicated_subagent', err?.message || String(err));
  }

  try {
    const mcpToolsText = fs.readFileSync(path.join(ROOT, 'src/main/mcp/tools.js'), 'utf8');

    assert.ok(mcpToolsText.includes("name: 'review_de_ai_style'"));
    assert.ok(mcpToolsText.includes("subagentId: 'sa-prose-quality'"));
    assert.ok(mcpToolsText.includes('Promise.all(requested.map(async (chapterName) =>'));
    pass('DAT3_de_ai_review_tool_fans_out_parallel_quality_reviews', 'review_de_ai_style is wired to batch chapters through Promise.all and sa-prose-quality');
  } catch (err) {
    fail('DAT3_de_ai_review_tool_fans_out_parallel_quality_reviews', err?.message || String(err));
  }

  try {
    const builtinSubagentsText = fs.readFileSync(path.join(ROOT, 'src/main/seeds/builtinSubagents.js'), 'utf8');
    const chatAgentText = fs.readFileSync(path.join(ROOT, 'src/main/runtime/chatAgent.js'), 'utf8');

    assert.ok(builtinSubagentsText.includes("id: 'sa-de-ai-ifier'"));
    assert.ok(builtinSubagentsText.includes("id: 'sa-prose-quality'"));
    assert.ok(builtinSubagentsText.includes('去 AI 味改写'));
    assert.ok(chatAgentText.includes('de_ai_ify'));
    assert.ok(chatAgentText.includes('review_de_ai_style'));
    assert.ok(chatAgentText.includes('Do not claim that you manually reviewed the chapter without calling the tool.'));
    assert.ok(chatAgentText.includes('if the user also wants a concrete rewrite sample, call `de_ai_ify` on one flagged excerpt'));
    assert.ok(chatAgentText.includes('list_skills'));
    assert.ok(chatAgentText.includes('read_skill_content'));
    pass('DAT4_chat_prompt_advertises_explicit_de_ai_tooling', 'chat system prompt now names de_ai_ify, review_de_ai_style, and the explicit skill tools');
  } catch (err) {
    fail('DAT4_chat_prompt_advertises_explicit_de_ai_tooling', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runDeAiToolRegressionTest };

if (require.main === module) {
  runDeAiToolRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}