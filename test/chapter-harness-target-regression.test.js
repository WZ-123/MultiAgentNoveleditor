'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const {
  chineseNumberToInteger,
  extractExplicitChapterTarget,
  resolveChapterTarget,
} = require('../src/main/runtime/chapterTargetResolver');
const { normalizeConstraintAssertion } = require('../src/domain/chapterHarness.cjs');
const novelData = require('../src/main/store/novelData');
const { getToolByName } = require('../src/main/mcp/tools');

function toolResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function createCallTool({ displays = [], outlineNodes = [], suggested = null } = {}) {
  const calls = [];
  const callTool = async ({ name }) => {
    calls.push(name);
    if (name === 'list_chapter_displays') return toolResult(displays);
    if (name === 'read_outline_nodes') return toolResult({ nodes: outlineNodes });
    if (name === 'suggest_next_chapter_name') {
      return toolResult(suggested || {
        seq: displays.length + 1,
        fileName: `chapter-${String(displays.length + 1).padStart(3, '0')}.md`,
        displayName: `第${displays.length + 1}章`,
      });
    }
    throw new Error(`unexpected tool: ${name}`);
  };
  return { callTool, calls };
}

async function run() {
  assert.equal(chineseNumberToInteger('十一'), 11);
  assert.equal(chineseNumberToInteger('一百零一'), 101);
  assert.equal(chineseNumberToInteger('二〇二'), 202);
  assert.equal(extractExplicitChapterTarget('写第１１章：风雨前夕').ordinal, 11);
  assert.equal(extractExplicitChapterTarget('写第十一章:风雨前夕').titleHint, '风雨前夕');

  const displays = Array.from({ length: 11 }, (_, index) => ({
    seq: index + 1,
    fileName: index === 10 ? 'chapter-010a.md' : `chapter-${String(index + 1).padStart(3, '0')}.md`,
    displayName: `第${index + 1}章`,
  }));
  const inserted = createCallTool({ displays });
  const existing = await resolveChapterTarget({
    mode: 'create',
    userText: '写第十一章',
    callTool: inserted.callTool,
  });
  assert.equal(existing.status, 'resolved');
  assert.equal(existing.name, 'chapter-010a.md');
  assert.equal(existing.source, 'explicit_existing');

  const nextTools = createCallTool({ displays: displays.slice(0, 10) });
  const next = await resolveChapterTarget({
    mode: 'create',
    userText: '写第１１章',
    callTool: nextTools.callTool,
  });
  assert.equal(next.name, 'chapter-011.md');
  assert.ok(nextTools.calls.includes('suggest_next_chapter_name'));

  const nextWithoutOutline = await resolveChapterTarget({
    mode: 'create',
    userText: '写第十一章',
    callTool: async ({ name }) => {
      if (name === 'list_chapter_displays') return toolResult(displays.slice(0, 10));
      if (name === 'read_outline_nodes') throw new Error('outline temporarily unavailable');
      if (name === 'suggest_next_chapter_name') return toolResult({ seq: 11, fileName: 'chapter-011.md', displayName: '第十一章' });
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  assert.equal(nextWithoutOutline.name, 'chapter-011.md');

  const outlineTools = createCallTool({
    displays: displays.slice(0, 3),
    outlineNodes: [{ chapterIndex: 8, chapterRef: 'chapter-future-eight.md', title: '远期计划' }],
  });
  const outlined = await resolveChapterTarget({
    mode: 'create',
    userText: '写第八章',
    callTool: outlineTools.callTool,
  });
  assert.equal(outlined.name, 'chapter-future-eight.md');
  assert.equal(outlined.source, 'explicit_outline');

  const unresolvedTools = createCallTool({ displays: displays.slice(0, 3) });
  const unresolved = await resolveChapterTarget({
    mode: 'create',
    userText: '写第八章',
    callTool: unresolvedTools.callTool,
  });
  assert.equal(unresolved.status, 'blocked');
  assert.equal(unresolved.diagnostics[0].code, 'chapter_target_unresolved');

  const conflictTools = createCallTool({ displays });
  const conflict = await resolveChapterTarget({
    mode: 'revise',
    userText: '把第十一章重写',
    pendingChapterDraft: { name: 'chapter-003.md', displayName: '第3章', text: '草稿' },
    callTool: conflictTools.callTool,
  });
  assert.equal(conflict.status, 'blocked');
  assert.equal(conflict.diagnostics[0].code, 'revision_target_conflict');

  const softAssertion = normalizeConstraintAssertion({
    id: 'model-guess',
    assertion: '角色可能会离开',
    severity: 'blocking',
  });
  assert.equal(softAssertion.severity, 'advisory');
  const hardAssertion = normalizeConstraintAssertion({
    id: 'outline-fact',
    assertion: '本章必须揭示信件伪造',
    severity: 'blocking',
    sourceRefs: [{ ref: 'outline:scene-11', deterministic: true }],
  });
  assert.equal(hardAssertion.severity, 'blocking');

  const novelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-summary-tool-'));
  try {
    await novelData.appendSummary(novelDir, {
      chapterRef: 'chapter-003.md',
      summary: '第三章的确定性摘要。',
      supplementMarkdown: '',
    });
    const summaryTool = getToolByName('read_chapter_summary');
    const result = await summaryTool.handler({ name: 'chapter-003.md' }, { novelDir });
    assert.match(result.content[0].text, /第三章的确定性摘要/u);
    const missing = await summaryTool.handler({ name: 'chapter-999.md' }, { novelDir });
    assert.equal(missing.content[0].text, '');
  } finally {
    await fs.rm(novelDir, { recursive: true, force: true });
  }

  console.log('TEST_PASS chapter-harness-target-regression');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { run };
