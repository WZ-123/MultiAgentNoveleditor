'use strict';

const assert = require('node:assert/strict');
const { serializeConversationForDriver } = require('../src/main/runtime/chatConversationHistory');

async function run() {
  const history = serializeConversationForDriver([
    { role: 'assistant', content: [
      { type: 'text', text: '先读取章节。' },
      { type: 'tool_use', id: 'toolu-1', name: 'read_chapter', input: { name: 'chapter-001.md' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu-1', content: '章节结果摘要', is_error: false },
    ] },
    { role: 'assistant', content: [
      { type: 'redacted_thinking', data: 'secret' },
      { type: 'text', text: '读取完成。' },
    ] },
  ]);
  assert.match(history, /先读取章节/u);
  assert.match(history, /ToolCall read_chapter#toolu-1/u);
  assert.match(history, /ToolResult #toolu-1/u);
  assert.match(history, /章节结果摘要/u);
  assert.match(history, /Redacted model thinking omitted/u);
  assert.doesNotMatch(history, /secret/u);
  console.log('TEST_PASS driver-conversation-history-regression');
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
