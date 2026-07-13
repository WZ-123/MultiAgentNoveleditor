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
    const paragraphFunctionReviewTool = (tools || []).find((tool) => tool.name === 'review_paragraph_function');

    assert.ok(deAiTool);
    assert.ok(deAiReviewTool);
    assert.ok(paragraphFunctionReviewTool);
    assert.equal(deAiTool.inputSchema?.required?.includes('text'), true);
    assert.equal(deAiTool.requiresConfirmation, false);
    assert.equal(deAiReviewTool.requiresConfirmation, false);
    assert.equal(paragraphFunctionReviewTool.requiresConfirmation, false);
    pass('DAT1_de_ai_tool_is_exposed_via_mcp', 'de_ai_ify, review_de_ai_style, and review_paragraph_function are visible in the MCP tool list');

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
        {
          text: '然后她笑了。那是一个很淡的笑。',
          guidance: '保留冷淡感',
          beforeContext: '门外的脚步声停了。',
          afterContext: '他没有追问。',
          preserveConstraints: ['保持第三人称'],
        },
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
      assert.match(calls[0]?.input || '', /前文只读上下文/u);
      assert.match(calls[0]?.input || '', /后文只读上下文/u);
      assert.match(calls[0]?.input || '', /保持第三人称/u);
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
    assert.ok(mcpToolsText.includes("name: 'review_paragraph_function'"));
    assert.ok(mcpToolsText.includes("subagentId: 'sa-prose-quality'"));
    assert.ok(mcpToolsText.includes("subagentId: 'sa-paragraph-function-reviewer'"));
    assert.ok(mcpToolsText.includes('Promise.all(requested.map(async (chapterName) =>'));
    pass('DAT3_de_ai_review_tool_fans_out_parallel_quality_reviews', 'review tools are wired to batch chapters through Promise.all and dedicated quality subagents');
  } catch (err) {
    fail('DAT3_de_ai_review_tool_fans_out_parallel_quality_reviews', err?.message || String(err));
  }

  try {
    const builtinSubagentsText = fs.readFileSync(path.join(ROOT, 'src/main/seeds/builtinSubagents.js'), 'utf8');
    const chatAgentText = fs.readFileSync(path.join(ROOT, 'src/main/runtime/chatAgent.js'), 'utf8');
    const remoteAiText = fs.readFileSync(path.join(ROOT, 'src/services/remoteAI.js'), 'utf8');
    const appText = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');

    assert.ok(builtinSubagentsText.includes("id: 'sa-de-ai-ifier'"));
    assert.ok(builtinSubagentsText.includes("id: 'sa-prose-quality'"));
    assert.ok(builtinSubagentsText.includes("id: 'sa-paragraph-function-reviewer'"));
    assert.ok(builtinSubagentsText.includes('去 AI 味改写'));
    assert.ok(builtinSubagentsText.includes('段落功能审查'));
    assert.ok(chatAgentText.includes('de_ai_ify'));
    assert.ok(chatAgentText.includes('review_de_ai_style'));
    assert.ok(chatAgentText.includes('review_paragraph_function'));
    assert.ok(chatAgentText.includes('Do not claim that you manually reviewed the chapter without calling the tool.'));
    assert.ok(chatAgentText.includes('if the user also wants a concrete rewrite sample, call `de_ai_ify` on one flagged excerpt'));
    assert.ok(chatAgentText.includes('list_skills'));
    assert.ok(chatAgentText.includes('read_skill_content'));
    assert.ok(remoteAiText.includes("de_ai_rewrite: 'sa-de-ai-ifier'"));
    assert.ok(appText.includes("actionId === 'deAi' ? 'de_ai_rewrite'"));
    pass('DAT4_chat_prompt_advertises_explicit_de_ai_tooling', 'chat system prompt now names de_ai_ify, review_de_ai_style, and the explicit skill tools');
  } catch (err) {
    fail('DAT4_chat_prompt_advertises_explicit_de_ai_tooling', err?.message || String(err));
  }

  try {
    const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
    const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
    const originalRunWorkflow = workflowOrchestrator.runWorkflow;
    const tmpDir = path.join(ROOT, 'tmp-test-de-ai-sharded-review');
    const chapterDir = path.join(tmpDir, 'chapters');
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await fs.promises.mkdir(chapterDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(chapterDir, 'chapter-001.md'),
      Array.from({ length: 30 }, (_, index) => `第${index + 1}段正文，用于重叠分片并发审查。`).join('\n\n'),
      'utf8'
    );
    let active = 0;
    let maxActive = 0;
    const shardPayloads = [];
    workflowOrchestrator.runWorkflow = async (payload) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      shardPayloads.push(JSON.parse(payload.input));
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { output: JSON.stringify({ annotations: [] }) };
    };
    try {
      const result = await getToolByName('review_de_ai_style').handler(
        { chapterName: 'chapter-001.md' },
        { novel: { id: 'novel-de-ai-shard' }, novelDir: tmpDir }
      );
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.shardCount, 3);
      assert.equal(payload.failedShardCount, 0);
      assert.equal(shardPayloads.length, 3);
      assert.equal(maxActive, 3);
      assert.ok(shardPayloads.every((item) => item.styleBaseline?.rhythmRule));
      assert.ok(shardPayloads.every((item) => Array.isArray(item.styleBaseline?.referenceSamples)));
      assert.deepEqual(shardPayloads.map((item) => item.shard.paragraphIndexes), [
        Array.from({ length: 12 }, (_, index) => index),
        Array.from({ length: 12 }, (_, index) => index + 10),
        Array.from({ length: 10 }, (_, index) => index + 20),
      ]);
      pass('DAT5_single_chapter_review_uses_bounded_overlapping_shards', '30 paragraphs fan out to three overlapping shards with bounded concurrency');
    } finally {
      workflowOrchestrator.runWorkflow = originalRunWorkflow;
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    fail('DAT5_single_chapter_review_uses_bounded_overlapping_shards', err?.message || String(err));
  }

  try {
    const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
    const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
    const originalRunWorkflow = workflowOrchestrator.runWorkflow;
    const tmpDir = path.join(ROOT, 'tmp-test-de-ai-style-baseline');
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(tmpDir, 'chapters'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, 'style'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, 'outlines'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpDir, 'characters'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'style', 'memory.md'), '句子短，停顿硬，不主动补景物或心理。', 'utf8');
    await fs.promises.writeFile(path.join(tmpDir, 'chapters', 'chapter-001.md'), [
      '# 第一章',
      '',
      '林夜把杯子推远，没有解释。',
      '',
      '然后她笑了。那是一个很淡的笑。',
      '',
      '“不必。”林夜说。',
    ].join('\n'), 'utf8');
    await fs.promises.writeFile(path.join(tmpDir, 'outlines', 'nodes.json'), JSON.stringify({
      schemaVersion: 1,
      nodes: [{ id: 'scene-1', chapterIndex: 1, title: '冷谈', setting: '室内对话', pov: 'lin-ye', characters: ['lin-ye'], summary: '林夜拒绝解释。' }],
    }), 'utf8');
    await fs.promises.writeFile(path.join(tmpDir, 'characters', 'lin-ye.json'), JSON.stringify({
      id: 'lin-ye', name: '林夜', personality: '克制，不解释', speechStyle: '短句，少修饰', quotes: '不必。',
    }), 'utf8');
    const calls = [];
    workflowOrchestrator.runWorkflow = async (payload) => {
      calls.push(payload);
      return { output: '她轻轻笑了一下。' };
    };
    try {
      const result = await getToolByName('de_ai_ify').handler({
        text: '然后她笑了。那是一个很淡的笑。',
        chapterName: 'chapter-001.md',
        targetParagraphIndexes: [2],
        problemEvidence: ['然后她笑了。那是一个很淡的笑。'],
      }, { novel: { id: 'novel-style-baseline' }, novelDir: tmpDir });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(calls.length, 1);
      assert.match(calls[0].input, /句子短，停顿硬/u);
      assert.match(calls[0].input, /POV 人物：林夜（lin-ye）/u);
      assert.match(calls[0].input, /短句，少修饰/u);
      assert.match(calls[0].input, /“不必。”林夜说。/u);
      assert.match(calls[0].input, /作者当前保留的段落样本/u);
      assert.match(calls[0].input, /只修改这些问题句/u);
      assert.equal(payload.styleBaseline.hasStyleMemory, true);
      assert.equal(payload.styleBaseline.characterVoiceCount, 1);
      assert.ok(payload.styleBaseline.referenceSampleCount >= 1);
      pass('DAT6_de_ai_rewrite_uses_work_style_and_voice_baseline', 'style memory, POV, scene, character voice, dialogue, and retained paragraphs reach the rewriter');
    } finally {
      workflowOrchestrator.runWorkflow = originalRunWorkflow;
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    fail('DAT6_de_ai_rewrite_uses_work_style_and_voice_baseline', err?.message || String(err));
  }

  try {
    const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
    const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
    const originalRunWorkflow = workflowOrchestrator.runWorkflow;
    const outputs = [
      '月光落在她肩头，她仿佛终于明白了什么：“我已经等得太久。”',
      '她轻轻笑了一下。',
    ];
    const calls = [];
    workflowOrchestrator.runWorkflow = async (payload) => {
      calls.push(payload);
      return { output: outputs[calls.length - 1] };
    };
    try {
      const result = await getToolByName('de_ai_ify').handler({ text: '她笑了。' }, {});
      const payload = JSON.parse(result.content[0].text);
      assert.equal(calls.length, 2);
      assert.match(calls[1].input, /上一版候选因违反“最小必要修改”被拒绝/u);
      assert.equal(payload.revisedText, '她轻轻笑了一下。');
      assert.equal(payload.attemptCount, 2);
      assert.equal(payload.keptOriginal, false);
      pass('DAT7_over_polished_candidate_is_retried', 'an embellished candidate is rejected and retried with minimal-edit feedback');
    } finally {
      workflowOrchestrator.runWorkflow = originalRunWorkflow;
    }
  } catch (err) {
    fail('DAT7_over_polished_candidate_is_retried', err?.message || String(err));
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
