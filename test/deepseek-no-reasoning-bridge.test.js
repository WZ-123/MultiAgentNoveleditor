'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { CONSISTENCY_REVIEW_TIMEOUT_MS, DEEPSEEK_UPSTREAM_TIMEOUT_MS, createDeepSeekNoReasoningBridge, normalizeChatToolCall, normalizeChatToolCalls, normalizeNoReasoningRequest, normalizePatchInput, originalToolCall, originalToolName, responsesInputToChatMessages, responsesToolsToChatTools, upstreamTimeoutMs } = require('../src/main/codex-runtime/deepseekNoReasoningBridge');

async function run() {
  const transformed = normalizeNoReasoningRequest({
    reasoning: { effort: 'none' },
    input: [{ type: 'message' }, { type: 'reasoning', content: 'private' }, { type: 'function_call' }],
  });
  assert.deepEqual(transformed.input.map((item) => item.type), ['message', 'function_call']);
  assert.equal(transformed.max_output_tokens, 6000);
  assert.deepEqual(transformed.thinking, { type: 'disabled' });
  const textOnly = normalizeNoReasoningRequest({ reasoning: { effort: 'none' }, input: [], tools: [{ name: 'unused-a' }, { name: 'unused-b' }] });
  assert.deepEqual(textOnly.tools, []);
  assert.equal(textOnly.tool_choice, 'none');
  const flash = normalizeNoReasoningRequest({ model: 'deepseek-v4-flash', reasoning: { effort: 'none' }, input: [] });
  assert.equal(flash.model, 'deepseek-chat');
  const pro = normalizeNoReasoningRequest({ model: 'deepseek-v4-pro', reasoning: { effort: 'none' }, input: [] });
  assert.equal(pro.model, 'deepseek-v4-pro');
  const untouched = { reasoning: { effort: 'high' }, input: [{ type: 'reasoning' }], max_output_tokens: 9000 };
  assert.equal(normalizeNoReasoningRequest(untouched), untouched);
  const chatMessages = responsesInputToChatMessages({ input: [
    { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"id":1}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    { type: 'custom_tool_call', call_id: 'call-2', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'custom_tool_call_output', call_id: 'call-2', output: 'done' },
  ] });
  assert.equal(chatMessages[0].tool_calls[0].function.name, 'read');
  assert.equal(chatMessages[1].role, 'tool');
  assert.equal(chatMessages[2].tool_calls[0].function.name, 'apply_patch');
  const roleCompatibleMessages = responsesInputToChatMessages({
    instructions: '基础系统指令',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '宿主开发者约束' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '写正文' }] },
    ],
  });
  assert.deepEqual(roleCompatibleMessages.map((message) => message.role), ['system', 'user']);
  assert.match(roleCompatibleMessages[0].content, /基础系统指令[\s\S]*宿主开发者约束/u);
  assert.equal(responsesToolsToChatTools([{ type: 'custom', name: 'apply_patch' }])[0].function.name, 'apply_patch');
  assert.deepEqual(responsesToolsToChatTools([{ type: 'function', name: 'read_mcp_resource' }, { type: 'function', name: 'mcp__novel_tools__read_novel_resource' }]).map((tool) => tool.function.name), ['novel_read_novel_resource']);
  assert.equal(originalToolName('novel_read_novel_resource', [{ name: 'mcp__novel_tools__read_novel_resource' }]), 'mcp__novel_tools__read_novel_resource');
  assert.equal(originalToolName('read_novel_resource', [{ name: 'mcp__novel_tools__read_novel_resource' }]), 'mcp__novel_tools__read_novel_resource');
  assert.deepEqual(originalToolCall('novel_read_novel_resource', [{ name: 'read_novel_resource', namespace: 'mcp__novel_tools' }]), { name: 'read_novel_resource', namespace: 'mcp__novel_tools' });
  assert.deepEqual(originalToolCall('read_novel_resource', []), { name: 'read_novel_resource', namespace: 'mcp__novel_tools' });
  assert.equal(responsesToolsToChatTools([{ type: 'function', name: 'read_novel_resource', namespace: 'mcp__novel_tools' }])[0].function.name, 'novel_read_novel_resource');
  assert.deepEqual(responsesToolsToChatTools([{ type: 'function', name: 'read_novel_resource', input_schema: { type: 'object', required: ['resourceRef'] } }])[0].function.parameters.required, ['resourceRef']);
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'read_novel_resource', arguments: '{"arguments":"{\\"resourceRef\\":\\"chapter:chapter-007.md\\"}"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-007.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'invoke', arguments: '{"name":"read_novel_resource","argument":"{\\"resourceRef\\":\\"chapter:chapter-007.md\\"}"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-007.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'invoke', arguments: '{"function":"read_novel_resource\">\\n<｜｜DSML｜｜parameter name=\\"resourceRef\\" string=\\"true\\">{\\"resourceRef\\":\\"chapter:chapter-006.md\\"}"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-006.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'novel_tools', arguments: '{"tool_name":"read_novel_resource","arguments":{"resourceRef":"outline:chapter:1:2:14"}}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"outline:chapter:1:2:14"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'novel_tools', arguments: '{"command":"read","resourceRef":"chapter:chapter-001.md"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-001.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'novel_tools', arguments: '{"command":"read_novel_resource","resourceRef":"world:lore"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"world:lore"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'novel_tools_read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-022.md"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-022.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'functions.mcp.novel_tools.read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-015.md"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-015.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'invoke_function', arguments: '{"function":"novel_tools.read_novel_resource","parameter":"{\\"resourceRef\\":\\"chapter:chapter-013.md\\"}"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-013.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'functions.exec', arguments: '{"function":"novel_tools.read_novel_resource","parameter":"{\\"resourceRef\\":\\"world:lore\\"}"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"world:lore"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'functions.novel_tools.read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-015.md"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-015.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'invoke', arguments: '{"tool":"novel_tools.read_novel_resource","arguments":{"resourceRef":"chapter:chapter-022.md","novelId":"extra"}}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"chapter:chapter-022.md"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'functions.exec', arguments: '{"tools":["novel_tools.read_novel_resource"],"arguments":{"resourceRef":"world:lore","novelId":"extra"}}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"world:lore"}' });
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'functions.exec', arguments: '{"tools":[{"name":"read_novel_resource","input_schema":{"resourceRef":"string"},"mcpserver":"novel_tools"}],"entrypoint":"read all"}' } }), { name: 'read_novel_resource', arguments: '{}' });

  const consistencyRequest = normalizeNoReasoningRequest({
    model: 'deepseek-v4-flash', reasoning: { effort: 'none' }, max_output_tokens: 6000, tools: [{ type: 'function' }, { type: 'function' }, { type: 'function' }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<name>mana-consistency-review</name>' }] }],
  });
  assert.equal(consistencyRequest.max_output_tokens, 1200);
  assert.equal(upstreamTimeoutMs({ input: [{ type: 'message', content: '<name>mana-consistency-review</name>' }] }), CONSISTENCY_REVIEW_TIMEOUT_MS);
  assert.equal(upstreamTimeoutMs({ input: [{ type: 'message', content: '写正文' }] }), DEEPSEEK_UPSTREAM_TIMEOUT_MS);
  assert.deepEqual(normalizeChatToolCall({ function: { name: 'read_novel_resource', arguments: '{"resourceRef":"{\\"resourceRef\\":\\"world:lore\\"}"}' } }), { name: 'read_novel_resource', arguments: '{"resourceRef":"world:lore"}' });
  const repairedReads = normalizeChatToolCalls([
    { function: { name: 'read_novel_resource', arguments: '{}' } },
    { function: { name: 'read_novel_resource', arguments: '{}' } },
  ], { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '读取 chapter:chapter-010.md 和 world:lore' }] }] });
  assert.deepEqual(repairedReads.map(({ normalized }) => JSON.parse(normalized.arguments)), [{}, {}], 'the bridge must preserve missing arguments so schema validation reports the model error instead of guessing from history');
  assert.equal(normalizePatchInput('*** Update File: a.txt\n@@\n-old\n+new'), '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch');
  assert.equal(normalizePatchInput('*** Begin Patch\n*** Update File: a.txt\n*** End Patch'), '*** Begin Patch\n*** Update File: a.txt\n*** End Patch');

  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ path: request.url, body });
    if (request.url === '/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '正' } }] })}\n\n`);
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '文' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        response.end('data: [DONE]\n\n');
      }, 20);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = await createDeepSeekNoReasoningBridge(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasoning: { effort: 'none' }, input: [{ type: 'reasoning', content: 'drop' }, { type: 'message' }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received[0].body.input.map((item) => item.type), ['message']);
    assert.equal(received[0].body.reasoning.effort, 'none');
    assert.equal(received[0].body.max_output_tokens, 6000);
    const textResponse = await fetch(`${bridge.baseUrl}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', reasoning: { effort: 'none' }, instructions: 'system', tools: [{}, {}], input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '写正文' }] }] }),
    });
    const sse = await textResponse.text();
    assert.equal(received[1].path, '/chat/completions');
    assert.deepEqual(received[1].body.thinking, { type: 'disabled' });
    assert.equal(received[1].body.stream, true);
    assert.deepEqual(received[1].body.stream_options, { include_usage: true });
    assert.match(sse, /response\.completed/u);
    assert.match(sse, /response\.output_text\.delta/u);
    assert.match(sse, /正文/u);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
  console.log('deepseek-no-reasoning-bridge: ok');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
