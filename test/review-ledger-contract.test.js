'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-review-ledger-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const { readResource } = require('../src/main/mcp/novelResources');
  const { fileFor, invalidateForResources, recordReview, stableIssue } = require('../src/main/codex-runtime/reviewLedger');
  try {
    const novel = await novels.createNovel({ title: '审校账本', dir: path.join(root, 'novel') });
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', '甲说门开着。', {}, { baseContent: '' });
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-002.md', '乙说门锁着。', {}, { baseContent: '' });
    const one = await readResource(novel, 'chapter:chapter-001.md');
    const two = await readResource(novel, 'chapter:chapter-002.md');
    const report = `发现一项冲突。\n\n\`\`\`json\n${JSON.stringify({
      coveredResourceRefs: [one.resourceRef, two.resourceRef],
      issues: [{ issueId: 'continuity:door:state', category: 'continuity', severity: 'hard', status: 'open', contradiction: '同一时刻门的开关状态冲突', evidence: [
        { resourceRef: one.resourceRef, hash: one.sourceHash, location: '第1行', quote: '门开着' },
        { resourceRef: two.resourceRef, hash: two.sourceHash, location: '第1行', quote: '门锁着' },
      ] }],
    })}\n\`\`\``;
    const row = await recordReview(novel, {
      taskId: 'review-1', attemptId: 'attempt-1', runId: 'run-1', text: report,
      items: [
        { name: 'read_novel_resource', status: 'completed', arguments: { resourceRef: one.resourceRef } },
        { name: 'read_novel_resource', status: 'completed', arguments: JSON.stringify({ resourceRef: two.resourceRef }) },
      ],
    });
    assert.equal(row.coverageVerified, true);
    assert.equal(row.issues[0].severity, 'hard');
    assert.equal(row.issues[0].verified, true);
    assert.equal(stableIssue({ issueId: 'style:x:y', severity: 'hard', evidence: [] }).severity, 'suspicion', 'hard claims without contradictory evidence cannot block delivery');
    const invalidated = await invalidateForResources(novel, [{ resourceRef: one.resourceRef }]);
    assert.deepEqual(invalidated, ['continuity:door:state']);
    const rows = (await fsp.readFile(fileFor(novel), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).type, 'review_issue_invalidated');
    console.log('review-ledger-contract: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
