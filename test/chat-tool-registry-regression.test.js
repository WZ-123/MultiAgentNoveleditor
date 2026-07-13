'use strict';

const assert = require('node:assert/strict');
const { applyToolPolicy } = require('../src/main/runtime/contextAssembler');
const { classifyChatTaskContract, getToolCapability } = require('../src/main/runtime/chatToolRegistry');

async function run() {
  const tools = [
    { name: 'read_chapter' },
    { name: 'replace_selected_text' },
    { name: 'write_chapter' },
    { name: 'create_novel' },
    { name: 'WebSearch' },
  ];
  const general = classifyChatTaskContract('先分析一下有哪些风险', { workflowPhase: 'writing' });
  assert.deepEqual(general.labels, ['general']);
  assert.equal(general.phaseHint, 'writing');
  const generalTools = applyToolPolicy(tools, general).tools.map((tool) => tool.name);
  assert.deepEqual(generalTools, ['read_chapter', 'WebSearch']);

  const edit = classifyChatTaskContract('把我选中的这句话改得更紧张');
  assert.ok(edit.labels.includes('writing'));
  const editTools = applyToolPolicy(tools, edit).tools.map((tool) => tool.name);
  assert.ok(editTools.includes('replace_selected_text'));
  assert.ok(editTools.includes('write_chapter'));

  const setup = classifyChatTaskContract('创建一个新的小说项目');
  assert.ok(setup.labels.includes('project_setup'));
  assert.ok(applyToolPolicy(tools, setup).tools.some((tool) => tool.name === 'create_novel'));

  assert.equal(getToolCapability('read_chapter').parallelSafe, true);
  assert.equal(getToolCapability('write_chapter').parallelSafe, false);
  assert.equal(getToolCapability('write_chapter').requiresConfirmation, true);
  console.log('TEST_PASS chat-tool-registry-regression');
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
