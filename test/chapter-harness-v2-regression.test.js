'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const ROOT = path.resolve(__dirname, '..');
  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-harness-v2');
  process.env.MANA_USER_DATA_ROOT = path.join(tmpRoot, 'userdata');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  try {
    const domain = require('../src/domain/chapterHarness.cjs');
    const usage = domain.normalizeUsage({ prompt_tokens: 12, completion_tokens: 5 });
    assert.deepEqual(usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false });
    const trace = domain.normalizeDraftTrace({
      verificationLevel: 'strict',
      modelCalls: [{ role: 'writer', usage: { inputTokens: 10, outputTokens: 4 } }, { role: 'state_extractor', usage: { inputTokens: 5, outputTokens: 2 } }],
      riskProfile: { level: 'high', score: 11, dimensions: { knowledge: 3 } },
    });
    assert.equal(trace.usage.totalTokens, 21);
    assert.equal(trace.verificationLevel, 'strict');
    assert.equal(trace.riskProfile.level, 'high');

    const stateVerifier = require('../src/main/runtime/chapterStateVerifier');
    const deterministicRefs = stateVerifier._testKnownDeterministicRefs({
      sceneContract: { sourceRefs: [{ ref: 'outline:scene-11', deterministic: true }] },
      entryState: { sourceRefs: [{ ref: 'timeline:chapter-10', deterministic: true }] },
    });
    assert.equal(stateVerifier._testIsBlockingDiscrepancy({
      conflictType: 'absence', severity: 'blocking', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'timeline:chapter-10',
    }, deterministicRefs), false);
    assert.equal(stateVerifier._testIsBlockingDiscrepancy({
      conflictType: 'direct', comparisonSource: 'deterministic_context', severity: 'blocking', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'timeline:chapter-10',
    }, deterministicRefs), true);
    const legacyDirect = await stateVerifier.verifySceneState({
      sceneDraft: { sceneId: 'scene-11', text: '陈岸拖着固定的左腿走了两公里。', stateDelta: {} },
      sceneContract: { sceneId: 'scene-11', sourceRefs: [{ ref: 'timeline:chapter-10', deterministic: true }] },
      modelRuntime: {
        invoke: async () => ({ output: JSON.stringify({
          extracted: {},
          discrepancies: [{ severity: 'blocking', summary: '正文与确定性时间线中的左腿固定状态直接冲突。', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'timeline:chapter-10' }],
          confidence: 0.99,
          evidenceParagraphIds: ['p-0'],
        }) }),
      },
    });
    assert.equal(legacyDirect.verification.status, 'blocking');
    const writerDeltaMismatch = await stateVerifier.verifySceneState({
      sceneDraft: { sceneId: 'scene-11', text: '阿婆说明天回灯铺。', stateDelta: { returnTime: '很久以后' } },
      sceneContract: { sceneId: 'scene-11', sourceRefs: [{ ref: 'outline:scene-11', deterministic: true }] },
      modelRuntime: {
        invoke: async () => ({ output: JSON.stringify({
          extracted: { returnTime: '明天' },
          discrepancies: [{ conflictType: 'direct', comparisonSource: 'writer_declaration', severity: 'blocking', summary: 'writer 状态与正文直接冲突。', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'outline:scene-11' }],
          confidence: 0.99,
          evidenceParagraphIds: ['p-0'],
        }) }),
      },
    });
    assert.equal(writerDeltaMismatch.verification.status, 'warning');
    assert.equal(stateVerifier._testIsBlockingDiscrepancy({
      conflictType: 'direct', comparisonSource: 'deterministic_context', severity: 'blocking', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'retrieval:guess',
    }, deterministicRefs), false);
    const parsedState = await stateVerifier.verifySceneState({
      sceneDraft: { sceneId: 'scene-11', text: '陈岸用磁钥恢复了供电。', stateDelta: { power: 'restored' } },
      sceneContract: { sceneId: 'scene-11', sourceRefs: [{ ref: 'outline:scene-11', deterministic: true }] },
      entryState: { sourceRefs: [{ ref: 'timeline:chapter-10', deterministic: true }] },
      modelRuntime: {
        invoke: async () => ({ output: '```json\n{"extracted":{"power":"restored"},"discrepancies":[],"confidence":0.96,"evidenceParagraphIds":["p-0"],"sourceUsage":[]}\n```' }),
      },
    });
    assert.equal(parsedState.verification.status, 'verified');
    assert.equal(parsedState.verification.merged.power, 'restored');

    const risk = require('../src/main/runtime/chapterRiskProfile');
    const profile = risk.buildChapterRiskProfile({
      targetChapter: { name: 'chapter-010a.md' },
      mode: 'revise',
      matchingNodes: [{ characters: ['a', 'b', 'c', 'd'], location: '甲地', informationBoundaries: ['秘密'] }, { characters: ['a'], location: '乙地' }],
      diagnostics: [],
      entryState: { status: 'stale' },
    });
    assert.equal(profile.level, 'high');
    assert.equal(risk.resolveAdaptivePolicy({ riskProfile: profile, settings: {} }).verificationLevel, 'strict');
    assert.equal(risk.resolveAdaptivePolicy({ riskProfile: profile, settings: { verificationLevel: 'fast', sceneGeneration: 'chapter' } }).verificationLevel, 'fast');

    const draftService = require('../src/main/runtime/chapterDraftService');
    const coverage = draftService._testComputeCriticalSourceCoverage({
      criticalSourceRefs: [{ ref: 'chapter:chapter-010.md' }, { ref: 'timeline:t-10' }],
      entryState: { chapterRef: 'chapter-010.md', sourceRefs: [{ ref: 'timeline:t-10' }] },
      assertions: [],
    }, [], {
      constraintCoverage: [],
      stateVerifications: [{ status: 'verified', confidence: 0.95, evidenceParagraphIds: ['p-0'] }],
    });
    assert.deepEqual(coverage.missing, []);
    assert.equal(coverage.verified, 2);
    const selfClaimedCoverage = draftService._testComputeCriticalSourceCoverage({
      criticalSourceRefs: [{ ref: 'timeline:t-10' }],
      assertions: [],
    }, [{ sourceRef: 'timeline:t-10', evidenceParagraphIds: ['p-0'] }], {
      constraintCoverage: [],
      stateVerifications: [],
    });
    assert.equal(selfClaimedCoverage.used, 1);
    assert.equal(selfClaimedCoverage.verified, 0);
    const reviewInput = JSON.parse(draftService._testBuildReviewInput({
      mode: 'create',
      userText: '写第十一章',
      assertions: [],
      retrievedContext: { query: '旧线索', contextText: '检索资料'.repeat(1200) },
      draft: {
        name: 'chapter-011.md', text: '陈岸留在控制舱。', eventLedger: { events: [] },
        contextBundle: {
          entryState: { chapterRef: 'chapter-010.md', status: 'valid', characters: [{ id: 'chen-an', location: '控制舱', physicalState: ['左腿固定'], knowledge: [{ factId: 'signal', proposition: '异常信号'.repeat(200), state: 'known' }] }], assets: [], worldState: { oxygen: '四十分钟' } },
          sceneContracts: [{ sceneId: 'bb-11-b', location: '控制舱', mustHappen: ['磁钥恢复局部供电'] }],
          sceneCharacterContexts: [{ characters: [{ id: 'chen-an', name: '陈岸', personality: '守规程', speechStyle: '先报数据' }] }],
          nearbyTimeline: [{ when: '03:10', where: '控制舱', description: '陈岸左腿固定。' }],
        },
      },
    }));
    assert.equal(reviewInput.reviewContext.entryState.characters[0].location, '控制舱');
    assert.equal(reviewInput.reviewContext.characters[0].speechStyle, '先报数据');
    assert.ok(reviewInput.reviewContext.entryState.characters[0].knowledge[0].proposition.length <= 280);
    assert.ok(reviewInput.retrievedContext.contextText.length <= 2400);
    assert.equal(reviewInput.retrievedContext.wasTrimmed, true);

    const advisoryStarts = [];
    const advisoryIssues = await draftService._testRunDraftAdvisoryReviews({
      text: '窗外的灯灭了，书桌上只剩半封信。\n\n他没有立刻拆开，只把信压在掌心。\n\n走廊尽头传来脚步，门缝里的光晃了一下。',
    }, null, null, {
      invoke: async (_options, meta) => {
        advisoryStarts.push({ role: meta.role, at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { output: JSON.stringify({ annotations: [] }) };
      },
    }, { readStyleMemory: async () => '克制叙事。' });
    assert.equal(Array.isArray(advisoryIssues), true);
    assert.deepEqual(advisoryStarts.map((item) => item.role).sort(), ['paragraph_function', 'prose_quality', 'style']);
    assert.ok(Math.max(...advisoryStarts.map((item) => item.at)) - Math.min(...advisoryStarts.map((item) => item.at)) < 50);

    const validator = require('../src/main/runtime/chapterConstraintValidator');
    const original = { name: 'chapter-011.md', text: '第一段。\n\n目标段。\n\n末段。' };
    const request = validator.buildLocalRepairRequest({ draft: original, issues: [{ severity: 'blocking', paragraphIds: ['p-1'], summary: '修复' }], repairRound: 1 });
    assert.match(request.targets[0].anchor.textHash, /^[a-f0-9]{16}$/u);
    const shifted = { ...original, text: `插入段。\n\n${original.text}` };
    const repaired = validator.applyParagraphReplacements(shifted, [{ paragraphId: 'p-1', text: '目标段已修复。' }], { targets: request.targets });
    assert.equal(repaired.applied, 1);
    assert.equal(repaired.impact.collateralParagraphIds.length, 0);
    assert.match(repaired.draft.text, /插入段。[\s\S]*目标段已修复。/u);

    const stateStore = require('../src/main/store/chapterHarnessState');
    const novelDir = path.join(tmpRoot, 'novel');
    const draft = { name: 'chapter-001.md', text: '确认正文。', eventLedger: { events: [] }, pendingStateDelta: { chapter: { worldState: { doorOpen: true } } } };
    const saved = await stateStore.saveConfirmedChapterState(novelDir, draft, []);
    assert.equal(saved.status, 'valid');
    assert.equal((await stateStore.readChapterState(novelDir, draft.name, { expectedContent: draft.text })).status, 'valid');
    assert.equal((await stateStore.readChapterState(novelDir, draft.name, { expectedContent: '正文变化。' })).status, 'stale');

    const benchmark = require('../scripts/harness-benchmark-lib');
    const redacted = benchmark.safeJson({ providerUrl: 'https://secret.invalid', apiKey: 'secret', provider: { models: ['safe-model'] } });
    assert.equal(JSON.stringify(redacted).includes('secret.invalid'), false);
    assert.deepEqual(redacted.provider.models, ['safe-model']);
    const liveQuality = { scores: { characterVoice: 4, causalCoherence: 4, knowledgeBoundary: 4, styleAdherence: 4, sceneTransition: 4, proseNaturalness: 4 } };
    const liveMetrics = { criticalSourceRecall: 1, stateConsistency: 1, softConstraintCoverage: 1 };
    const twoOfThree = benchmark.evaluateReport({
      runs: [
        { live: true, caseId: 'case-a', passed: false, success: true, hardViolations: ['确定性冲突'], metrics: liveMetrics, quality: liveQuality },
        { live: true, caseId: 'case-a', passed: true, success: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality },
        { live: true, caseId: 'case-a', passed: true, success: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality },
      ],
    });
    assert.equal(twoOfThree.summary.liveCasePass, true);
    assert.equal(twoOfThree.passed, true);
    const twoOfThreeWithRetainedFailure = benchmark.evaluateReport({
      runs: [
        { live: true, caseId: 'case-e', passed: false, hardViolations: ['来源未落实'], metrics: { ...liveMetrics, criticalSourceRecall: 0.5 }, quality: liveQuality },
        { live: true, caseId: 'case-e', passed: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality },
        { live: true, caseId: 'case-e', passed: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality },
      ],
    });
    assert.equal(twoOfThreeWithRetainedFailure.passed, true);
    assert.equal(twoOfThreeWithRetainedFailure.summary.criticalSourceRecall, 1);
    assert.ok(twoOfThreeWithRetainedFailure.summary.allSampleCriticalSourceRecall < 1);
    assert.equal(twoOfThreeWithRetainedFailure.summary.failedLiveSamples, 1);
    const stateOutlier = benchmark.evaluateReport({
      runs: [
        { live: true, caseId: 'case-b', passed: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality },
        { live: true, caseId: 'case-b', passed: true, hardViolations: [], metrics: { ...liveMetrics, stateConsistency: 0.8 }, quality: liveQuality },
      ],
    });
    assert.equal(stateOutlier.summary.stateConsistency, 0.9);
    assert.equal(stateOutlier.passed, false);
    const policyMismatch = benchmark.evaluateReport({
      corpusVersion: '1.1.0',
      benchmarkPolicyVersion: '2.0.0',
      provider: { models: ['test-model'] },
      promptSignature: 'prompt-a',
      runs: [
        { live: true, caseId: 'case-c', passed: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality },
      ],
    }, {
      corpusVersion: '1.1.0',
      benchmarkPolicyVersion: '1.0.0',
      provider: { models: ['test-model'] },
      promptSignature: 'prompt-a',
      acceptance: { summary: twoOfThree.summary },
    });
    assert.equal(policyMismatch.passed, false);
    assert.equal(policyMismatch.comparison.comparable, false);
    const missingUsage = benchmark.evaluateReport({
      telemetry: { usageMatched: false },
      runs: [{ live: true, caseId: 'case-d', passed: true, hardViolations: [], metrics: liveMetrics, quality: liveQuality }],
    });
    assert.equal(missingUsage.passed, false);
    const coreOverBudget = benchmark.evaluateReport({
      mode: 'live',
      profile: 'core',
      runs: [{
        live: true,
        caseId: 'case-budget',
        passed: true,
        hardViolations: [],
        metrics: liveMetrics,
        quality: liveQuality,
        usage: { totalTokens: 780001 },
        durationMs: 450001,
      }],
    });
    assert.equal(coreOverBudget.summary.performanceBudget.applicable, true);
    assert.equal(coreOverBudget.summary.performanceBudget.totalTokensPassed, false);
    assert.equal(coreOverBudget.summary.performanceBudget.p95LatencyPassed, false);
    assert.equal(coreOverBudget.passed, false);
    const coreAtBudget = benchmark.evaluateReport({
      mode: 'live',
      profile: 'core',
      runs: [{
        live: true,
        caseId: 'case-budget',
        passed: true,
        hardViolations: [],
        metrics: liveMetrics,
        quality: liveQuality,
        usage: { totalTokens: 780000 },
        durationMs: 450000,
      }],
    });
    assert.equal(coreAtBudget.summary.performanceBudget.passed, true);
    assert.equal(coreAtBudget.passed, true);

    console.log('TEST_PASS chapter-harness-v2-regression');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { run };
