'use strict';

const assert = require('node:assert/strict');

async function run() {
  const originalFetch = global.fetch;
  try {
    const anthropic = require('../src/main/runtime/providers/anthropic');
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'request-id' ? 'req-anthropic' : '' },
      json: async () => ({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }], usage: { input_tokens: 21, output_tokens: 7, cache_read_input_tokens: 4 } }),
    });
    const anthropicResult = await anthropic.sendMessage({ system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'input' }] }], tier: { apiKey: 'test', model: 'claude-test', extra: { streaming: false, maxTokens: 32 } } });
    assert.equal(anthropicResult.requestId, 'req-anthropic');
    assert.equal(anthropicResult.usage.totalTokens, 28);
    assert.equal(anthropicResult.usage.cacheReadTokens, 4);

    const openai = require('../src/main/runtime/providers/openaiCompat');
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'x-request-id' ? 'req-openai' : '' },
      json: async () => ({ id: 'chatcmpl-test', model: 'openai-test', choices: [{ finish_reason: 'stop', message: { content: '完成' } }], usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 } }),
    });
    const openaiResult = await openai.sendMessage({ system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'input' }] }], tier: { apiKey: 'test', baseUrl: 'https://example.invalid/v1', model: 'openai-test', extra: { streaming: false } } });
    assert.equal(openaiResult.requestId, 'req-openai');
    assert.equal(openaiResult.usage.inputTokens, 13);
    assert.equal(openaiResult.usage.outputTokens, 5);
    console.log('TEST_PASS provider-usage-regression');
  } finally {
    global.fetch = originalFetch;
  }
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { run };
