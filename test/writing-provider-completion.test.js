'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { chatCompletionAsResponses } = require('../src/main/codex-runtime/deepseekNoReasoningBridge');
async function main() {
  let packets = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* fixture */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const packet of packets) response.write('data: ' + (typeof packet === 'string' ? packet : JSON.stringify(packet)) + '\n\n');
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let count = 0;
  try {
    for (const reason of ['stop', 'length', 'content_filter', null]) {
      packets = [{ choices: [{ delta: { content: '正文片段' }, finish_reason: reason }] }, ...(reason ? ['[DONE]'] : [])];
      const response = await chatCompletionAsResponses({ body: { model: 'deepseek-v4-flash', input: [], tools: [] }, headers: { 'content-type': 'application/json' }, target: 'http://127.0.0.1:' + server.address().port });
      let wire = '';
      for await (const chunk of response.stream) wire += chunk;
      const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const final = events.at(-1);
      assert.equal(final.type, reason === 'stop' ? 'response.completed' : 'response.incomplete');
      if (reason !== 'stop') assert.ok(final.response.incomplete_details.reason);
      count++;
    }
    packets = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'apply_patch', arguments: '{"patch":"*** Begin' } }] }, finish_reason: 'length' }] }, '[DONE]'];
    const response = await chatCompletionAsResponses({ body: { model: 'deepseek-v4-flash', input: [], tools: [] }, headers: {}, target: 'http://127.0.0.1:' + server.address().port });
    let wire = '';
    for await (const chunk of response.stream) wire += chunk;
    assert.equal(wire.includes('response.custom_tool_call_input'), false);
    assert.ok(wire.includes('response.incomplete'));
    count++;
    console.log(`writing-provider-completion: ok (${count} scenarios)`);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
