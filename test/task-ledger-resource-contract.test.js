'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-ledger-contract-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
    const { TaskLedger, normalizeTaskConstraints, plainText } = require('../src/main/codex-runtime/taskLedger');
    const { proseRepetitionEvidence } = require('../src/main/mcp/novelResources');
  const novels = require('../src/main/store/novels');
  const { getToolByName } = require('../src/main/mcp/tools');
  try {
    const { taskConstraintsFor } = await import('../src/components/writingTaskConstraints.mjs');
    const exactTarget = taskConstraintsFor('把全书修订到50,000字', 'mana-fiction-writing', {});
    assert.equal(exactTarget.minBodyCjk, 50_000);
    assert.equal(exactTarget.maxBodyCjk, null, 'a single word target must not create an implicit 110% hard maximum');
    const rangeTarget = taskConstraintsFor('最终目标50，000—55,000字', 'mana-fiction-writing', {});
    assert.deepEqual([rangeTarget.minBodyCjk, rangeTarget.maxBodyCjk], [50_000, 55_000]);
    assert.equal(plainText([{ type: 'text', text: '前' }, { type: 'image', data: 'x' }, { type: 'text', text: '后' }]), '前\n后');
    assert.deepEqual(
      [normalizeTaskConstraints({ minBodyCjk: null, maxBodyCjk: null }).minBodyCjk, normalizeTaskConstraints({ minBodyCjk: null, maxBodyCjk: null }).maxBodyCjk],
      [null, null],
      'an absent final length target must stay absent instead of becoming a zero-character limit',
    );
    assert.equal(normalizeTaskConstraints({ prohibitRepetition: true, requiresCompleteEnding: true }).prohibitRepetition, true);
    const repeated = proseRepetitionEvidence('潮水越过石阶。潮水越过石阶。潮水越过石阶。另一个人推开窗。');
    assert.equal(repeated.sentenceCount, 4);
    assert.equal(repeated.repeatedOccurrenceRatio, 0.75);
    assert.equal(repeated.topRepeated[0].occurrences.length, 3);
    const obviousFailureEvidence = proseRepetitionEvidence([
      { resourceRef: 'chapter:chapter-001.md', hash: 'hash-1', content: `${'潮水越过石阶。'.repeat(98)}甲推开了旧木窗。乙合上了航海图。` },
    ]);
    assert.equal(obviousFailureEvidence.repeatedOccurrenceRatio, 0.98);
    assert.equal(obviousFailureEvidence.topRepeated[0].sentence, '潮水越过石阶');
    assert.deepEqual(obviousFailureEvidence.topRepeated[0].occurrences[0], { resourceRef: 'chapter:chapter-001.md', hash: 'hash-1', line: 1 });
    assert.equal('qualityConclusion' in obviousFailureEvidence, false, 'repetition evidence must not claim a quality verdict');
    const ledgerFile = path.join(root, 'ledger.jsonl');
    const ledger = new TaskLedger({ file: ledgerFile });
    await ledger.start({ taskId: 'task-1', attemptId: 'attempt-1', runId: 'run-1', constraints: {}, route: null });
    await ledger.record('run-1', 'text_delta', { delta: [{ type: 'text', text: '不会复制正文' }] });
    await ledger.record('run-1', 'tool_started', { itemId: 'tool-1' });
    await ledger.record('run-1', 'tool_completed', { itemId: 'tool-1', ok: false, output: [{ type: 'text', text: '参数错误' }] });
    await ledger.finish('run-1', 'failed', { failure: { code: 'bad_args' } });
    await ledger.start({ taskId: 'task-1', attemptId: 'attempt-2', runId: 'run-2', constraints: {}, route: null });
    await ledger.finish('run-2', 'model_turn_completed');
    const rows = (await fsp.readFile(ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter((row) => row.type === 'task_finished').length, 2, 'a later success must not overwrite the failed attempt');
    assert.equal(rows.find((row) => row.type === 'text_delta').delta, undefined, 'prose deltas are represented by length and hash');
    assert.equal(rows.find((row) => row.type === 'tool_completed').output.format, 'text-block-array');
    assert.equal(rows.find((row) => row.type === 'task_finished' && row.runId === 'run-1').toolErrors, 1);

    const novel = await novels.createNovel({ title: '计数契约', dir: path.join(root, 'novel') });
    const chapters = path.join(novel.dir, 'chapters');
    await fsp.mkdir(chapters, { recursive: true });
    await fsp.writeFile(path.join(chapters, 'chapter-001.md'), '# 第一章\n时间：雨夜\n她看见灯。\n\n水情:上涨\n第二行。\n');
    const tool = getToolByName('read_novel_resource');
    const metadata = await tool.handler({ resourceRef: 'chapter:chapter-001.md', mode: 'metadata' }, { novel, novelDir: novel.dir });
    assert.equal(metadata.structuredContent.content, undefined);
    assert.equal(metadata.structuredContent.chineseCharacterCount, 18);
    assert.equal(metadata.structuredContent.bodyChineseCharacterCount, 7);
    const lines = await tool.handler({ resourceRef: 'chapter:chapter-001.md', startLine: 3, endLine: 5 }, { novel, novelDir: novel.dir });
    assert.equal(lines.structuredContent.content, '她看见灯。\n\n水情:上涨');
    assert.equal(lines.structuredContent.startLine, 3);
    assert.ok(lines.structuredContent.hash);
    console.log('task-ledger-resource-contract: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
