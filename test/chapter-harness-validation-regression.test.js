'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  const userDataRoot = path.join(ROOT, 'tmp-test-chapter-harness-jobs');
  const novelDir = path.join(ROOT, 'tmp-test-chapter-harness-memory');
  process.env.MANA_USER_DATA_ROOT = userDataRoot;
  await fs.rm(userDataRoot, { recursive: true, force: true });
  await fs.rm(novelDir, { recursive: true, force: true });

  try {
    const appConfig = require('../src/main/store/appConfig');
    const config = await appConfig.load();
    assert.equal(config.writing.harnessMode, 'adaptive');
    assert.equal(config.writing.contextDepth, 'auto');
    assert.equal(config.writing.sceneGeneration, 'auto');
    assert.equal(config.writing.verificationLevel, 'auto');
    const normalized = await appConfig.save({
      writing: { harnessMode: 'bad', contextDepth: 'huge', sceneGeneration: 'parallel' },
    });
    assert.equal(normalized.writing.harnessMode, 'adaptive');
    assert.equal(normalized.writing.contextDepth, 'auto');
    assert.equal(normalized.writing.sceneGeneration, 'auto');

    const validator = require('../src/main/runtime/chapterConstraintValidator');
    const originalDraft = { name: 'chapter-011.md', text: '第一段保留。\n\n第二段需要修复。\n\n第三段也保留。' };
    const repaired = validator.applyParagraphReplacements(originalDraft, [{
      paragraphId: 'p-1',
      text: '第二段已局部修复。',
    }]);
    assert.equal(repaired.applied, 1);
    assert.equal(repaired.draft.text, '第一段保留。\n\n第二段已局部修复。\n\n第三段也保留。');

    const reviewDomain = require('../src/domain/chapterReview.cjs');
    assert.equal(reviewDomain.hasBlockingReviewIssues([{ status: 'open', severity: 'advisory' }]), false);
    assert.equal(reviewDomain.hasBlockingReviewIssues([{ status: 'open', severity: 'blocking' }]), true);
    const normalizedIssue = reviewDomain.normalizeReviewIssue({
      constraintId: 'scene-a-must-1',
      sceneId: 'scene-a',
      severity: 'blocking',
      summary: '未完成必要事件',
      repairInstruction: '只补足该段的鉴定动作',
      paragraphIds: ['p-1'],
    }, { paragraphs: validator.buildConstraintReviewPacket(originalDraft, []).paragraphs });
    assert.equal(normalizedIssue.constraintId, 'scene-a-must-1');
    assert.equal(normalizedIssue.sceneId, 'scene-a');
    assert.match(normalizedIssue.repairInstruction, /鉴定动作/u);

    const draftService = require('../src/main/runtime/chapterDraftService');
    assert.equal(draftService._testShouldUseSceneGeneration({
      settings: { mode: 'command_driven', sceneGeneration: 'auto' },
      mode: 'create',
      editorContext: {},
      sceneContracts: [{ sceneId: 'a' }, { sceneId: 'b' }],
    }), true);
    assert.equal(draftService._testShouldUseSceneGeneration({
      settings: { mode: 'command_driven', sceneGeneration: 'auto' },
      mode: 'revise',
      editorContext: { selectedText: '局部文本' },
      sceneContracts: [{ sceneId: 'a' }, { sceneId: 'b' }],
    }), false);
    const assembled = draftService._testAssembleSceneDrafts([
      { sceneId: 'a', text: '场景一第一段。\n\n场景一第二段。', eventLedger: { events: [] }, stateDelta: { location: '书房' } },
      { sceneId: 'b', text: '场景二。', eventLedger: { events: [] }, stateDelta: { clueFound: true } },
    ], { name: 'chapter-011.md', displayName: '第十一章', titleHint: '密信' }, {
      sceneContracts: [{ purpose: '鉴定密信' }, { purpose: '发现线索' }],
    });
    assert.deepEqual(assembled.sceneDrafts[0].paragraphIds, ['p-0', 'p-1']);
    assert.deepEqual(assembled.sceneDrafts[1].paragraphIds, ['p-2']);
    assert.equal(assembled.pendingStateDelta.b.clueFound, true);

    const jobs = require('../src/main/store/chapterPostWriteJobs');
    await jobs.ensureJob({
      draftId: 'draft-11',
      draft: { name: 'chapter-011.md', text: '正文' },
      roleplayContext: null,
    });
    await jobs.updateStep('draft-11', 'chapterWrite', 'running');
    await jobs.updateStep('draft-11', 'chapterWrite', 'done');
    await jobs.updateStep('draft-11', 'harnessState', 'done');
    await jobs.updateStep('draft-11', 'summary', 'done');
    await jobs.updateStep('draft-11', 'timeline', 'failed', { error: '临时失败' });
    let job = await jobs.getLatestRetryableJob();
    assert.equal(job.draftId, 'draft-11');
    assert.equal(job.steps.chapterWrite.attempts, 1);
    await jobs.updateStep('draft-11', 'timeline', 'running');
    await jobs.updateStep('draft-11', 'timeline', 'done');
    await jobs.updateStep('draft-11', 'outline', 'skipped');
    await jobs.updateStep('draft-11', 'characterMemory', 'skipped');
    await jobs.updateStep('draft-11', 'deAiReview', 'done');
    job = await jobs.getJob('draft-11');
    assert.equal(job.status, 'complete');
    assert.equal(job.steps.timeline.attempts, 1);

    const roleplay = require('../src/main/runtime/chapterRoleplayService');
    const patch = roleplay._testMakeIdempotentMemoryPatch({
      factsKnown: [{ text: '密信是伪造的。' }],
    }, 'chapter-011.md', 'hero');
    assert.match(patch.factsKnown[0].id, /^factsKnown-/u);
    const novelData = require('../src/main/store/novelData');
    await novelData.patchCharacterMemory(novelDir, 'hero', patch);
    await novelData.patchCharacterMemory(novelDir, 'hero', patch);
    const memory = await novelData.readCharacterMemory(novelDir, 'hero');
    assert.equal(memory.factsKnown.length, 1);
    assert.equal(memory.factsKnown[0].sourceChapterRef, 'chapter-011.md');

    console.log('TEST_PASS chapter-harness-validation-regression');
  } finally {
    await fs.rm(userDataRoot, { recursive: true, force: true });
    await fs.rm(novelDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { run };
