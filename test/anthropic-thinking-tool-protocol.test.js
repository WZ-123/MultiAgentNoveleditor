'use strict';

const assert = require('node:assert/strict');
const anthropic = require('../src/main/runtime/providers/anthropic');

function sseResponse(events) {
  const encoder = new TextEncoder();
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return {
    ok: true,
    headers: { get: () => 'request-thinking-tool-1' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  };
}

async function run() {
  const originalFetch = global.fetch;
  const emitted = [];
  let secondRequestBody = null;
  try {
    global.fetch = async () => sseResponse([
      { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先读取资料。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-redacted' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu-1', name: 'read_chapter', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"name":"chapter-001.md"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]);
    const first = await anthropic.sendMessage({
      system: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: '读取章节' }] }],
      tools: [{ name: 'read_chapter', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
      tier: { apiKey: 'test', baseUrl: 'https://example.invalid', model: 'claude-test', extra: { streaming: true, maxTokens: 128 }, thinking: { type: 'enabled', budget_tokens: 64 } },
      onEvent: (event) => emitted.push(event),
    });
    assert.equal(first.content[0].type, 'thinking');
    assert.equal(first.content[0].signature, 'opaque-signature');
    assert.equal(first.content[1].type, 'redacted_thinking');
    assert.equal(first.content[1].data, 'opaque-redacted');
    assert.deepEqual(first.content[2].input, { name: 'chapter-001.md' });
    const toolEvents = emitted.filter((event) => event.kind === 'tool_use');
    assert.equal(toolEvents.length, 2);
    assert.deepEqual(toolEvents[1].data.input, { name: 'chapter-001.md' });
    assert.equal(toolEvents[1].data.finalized, true);

    global.fetch = async (_url, options) => {
      secondRequestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => 'request-thinking-tool-2' },
        async json() { return { model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }], usage: {} }; },
      };
    };
    await anthropic.sendMessage({
      system: 'test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读取章节' }] },
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: '章节内容' }] },
      ],
      tools: [{ name: 'read_chapter', input_schema: { type: 'object', properties: {} } }],
      tier: { apiKey: 'test', baseUrl: 'https://example.invalid', model: 'claude-test', extra: { streaming: false, maxTokens: 128 }, thinking: { type: 'enabled', budget_tokens: 64 } },
    });
    assert.equal(secondRequestBody.messages[1].content[0].signature, 'opaque-signature');
    assert.equal(secondRequestBody.messages[1].content[1].type, 'redacted_thinking');
    console.log('TEST_PASS anthropic-thinking-tool-protocol');
  } finally {
    global.fetch = originalFetch;
  }
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { run };
