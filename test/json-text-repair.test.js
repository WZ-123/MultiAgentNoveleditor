'use strict';

const assert = require('node:assert/strict');
const { parseJsonText } = require('../src/main/runtime/jsonText');

const repaired = parseJsonText('{"summary":"长文本\n第二行" "timelineEvents":[],}');
assert.equal(repaired.summary, '长文本\n第二行');
assert.deepEqual(repaired.timelineEvents, []);

const quoted = parseJsonText('{"text":"她说"你好"，随后转身。","ok":true}');
assert.equal(quoted.text, '她说"你好"，随后转身。');
assert.equal(quoted.ok, true);

const fenced = parseJsonText('说明：\n```json\n{"ok":true}\n```');
assert.equal(fenced.ok, true);

assert.throws(
  () => parseJsonText('{"summary":"无法修复" "timelineEvents":['),
  /模型返回的 JSON 格式不完整/,
);

console.log('TEST_PASS JSON_TEXT_repair_common_llm_syntax');
