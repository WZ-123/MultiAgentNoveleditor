#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ARTIFACT_ROOT,
  BENCHMARK_POLICY_VERSION,
  ROOT,
  createFixtureCallTool,
  createLiveModelRuntime,
  evaluateReport,
  hash,
  loadCorpus,
  loadProviderSnapshot,
  materializeNovel,
  parseArgs,
  safeJson,
  scriptedModelRuntime,
} = require('./harness-benchmark-lib');
const { splitIntoParagraphs } = require('../src/main/runtime/chapterCharacterReview');

function jsonText(result) {
  return Array.isArray(result?.content) ? result.content.map((item) => item.text || '').join('\n') : '';
}

async function directoryFingerprint(dir) {
  const rows = [];
  async function walk(current, relative = '') {
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.join(relative, entry.name);
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) rows.push(`${childRelative}:${hash(await fs.readFile(child))}`);
    }
  }
  await walk(dir);
  return hash(rows.join('\n'));
}

function parseJsonOutput(value) {
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
  try { return JSON.parse(raw); } catch { return null; }
}

function mergeUsage(...values) {
  return values.reduce((total, value) => ({
    inputTokens: total.inputTokens + (Number(value?.inputTokens) || 0),
    outputTokens: total.outputTokens + (Number(value?.outputTokens) || 0),
    totalTokens: total.totalTokens + (Number(value?.totalTokens) || 0),
    cacheReadTokens: total.cacheReadTokens + (Number(value?.cacheReadTokens) || 0),
    cacheWriteTokens: total.cacheWriteTokens + (Number(value?.cacheWriteTokens) || 0),
    estimated: total.estimated || value?.estimated === true,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false });
}

function chapterContentForRef(fixture, sourceRef) {
  const match = /^chapter:chapter-(\d+)/u.exec(String(sourceRef || ''));
  if (!match) return '';
  const index = Number(match[1]) - 1;
  return fixture.chapters?.[index] || '';
}

function sourceFactsForJudge(fixture, criticalRefs) {
  return (Array.isArray(criticalRefs) ? criticalRefs : []).map((item) => {
    const sourceRef = String(item?.ref || '').trim();
    if (sourceRef.startsWith('outline:')) {
      const node = (fixture.nodes || []).find((entry) => `outline:${entry.id}` === sourceRef);
      return { sourceRef, type: 'outline', facts: node ? {
        summary: node.summary || '', mustHappen: node.mustHappen || [], mustNotHappen: node.mustNotHappen || [], informationBoundaries: node.informationBoundaries || [], location: node.location || '', when: node.when || '', pov: node.pov || '',
      } : {} };
    }
    if (sourceRef.startsWith('timeline:')) {
      const event = (fixture.timeline || []).find((entry) => `timeline:${entry.id}` === sourceRef);
      return { sourceRef, type: 'timeline', facts: event ? { when: event.when || '', where: event.where || '', participants: event.participants || [], description: event.description || '' } : {} };
    }
    if (sourceRef.startsWith('harness-state:')) {
      const chapterRef = sourceRef.slice('harness-state:'.length);
      const events = (fixture.timeline || []).filter((entry) => entry.chapterRef === chapterRef);
      return { sourceRef, type: 'chapter_state', facts: { chapterRef, continuityFacts: events.map((entry) => entry.description || '').filter(Boolean) } };
    }
    if (sourceRef.startsWith('chapter:')) return { sourceRef, type: 'chapter', facts: { ending: chapterContentForRef(fixture, sourceRef) } };
    return { sourceRef, type: item?.type || 'unknown', facts: {} };
  });
}

function independentSourceCoverage(criticalRefs, judge, paragraphs, { entryState = null, stateChecks = [] } = {}) {
  const required = Array.from(new Set((Array.isArray(criticalRefs) ? criticalRefs : []).map((item) => String(item?.ref || '').trim()).filter(Boolean)));
  const validParagraphIds = new Set((Array.isArray(paragraphs) ? paragraphs : []).map((paragraph) => paragraph.id));
  const evidence = Array.isArray(judge?.sourceEvidence) ? judge.sourceEvidence : [];
  const covered = new Set(evidence
    .filter((item) => item?.status === 'covered'
      && required.includes(String(item?.sourceRef || '').trim())
      && Array.isArray(item?.evidenceParagraphIds)
      && item.evidenceParagraphIds.some((id) => validParagraphIds.has(String(id || '').trim())))
    .map((item) => String(item.sourceRef).trim()));
  const hasVerifiedStateEvidence = (Array.isArray(stateChecks) ? stateChecks : []).some((item) => (
    item?.status === 'verified'
    && Number(item?.confidence) >= 0.7
    && Array.isArray(item?.evidenceParagraphIds)
    && item.evidenceParagraphIds.length > 0
  ));
  const stateSourceRefs = new Set((Array.isArray(entryState?.sourceRefs) ? entryState.sourceRefs : [])
    .map((item) => String(item?.ref || item?.sourceRef || '').trim()).filter(Boolean));
  if (entryState?.chapterRef) stateSourceRefs.add(`chapter:${entryState.chapterRef}`);
  const stateGuarded = hasVerifiedStateEvidence
    ? required.filter((ref) => !covered.has(ref) && stateSourceRefs.has(ref))
    : [];
  for (const ref of stateGuarded) covered.add(ref);
  const missing = required.filter((ref) => !covered.has(ref));
  return { required: required.length, covered: covered.size, stateGuarded, missing };
}

function independentSoftConstraintCoverage(assertions, judge) {
  const softIds = (Array.isArray(assertions) ? assertions : [])
    .filter((item) => item?.severity === 'advisory')
    .map((item) => String(item.constraintId || '').trim())
    .filter(Boolean);
  if (!softIds.length) return 1;
  const covered = new Set((Array.isArray(judge?.coveredConstraintIds) ? judge.coveredConstraintIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => softIds.includes(id)));
  return covered.size / softIds.length;
}

function verifiedStateConsistency(stateChecks) {
  const checks = Array.isArray(stateChecks) ? stateChecks : [];
  if (!checks.length) return 1;
  return checks.filter((item) => {
    const discrepancies = Array.isArray(item?.discrepancies) ? item.discrepancies : [];
    const extractorFailed = discrepancies.some((discrepancy) => /^独立状态抽取未完成/u.test(String(discrepancy?.summary || '')));
    const deterministicConflict = discrepancies.some((discrepancy) => (
      discrepancy?.conflictType === 'direct'
      && discrepancy?.comparisonSource === 'deterministic_context'
    ));
    return !extractorFailed && !deterministicConflict && Number(item?.confidence) >= 0.7;
  }).length / checks.length;
}

function stateVerificationCompletion(stateChecks) {
  const checks = Array.isArray(stateChecks) ? stateChecks : [];
  if (!checks.length) return 1;
  return checks.filter((item) => {
    const discrepancies = Array.isArray(item?.discrepancies) ? item.discrepancies : [];
    return Number(item?.confidence) >= 0.7
      && !discrepancies.some((discrepancy) => /^独立状态抽取未完成/u.test(String(discrepancy?.summary || '')));
  }).length / checks.length;
}

function summarizeStateVerifications(stateChecks) {
  return (Array.isArray(stateChecks) ? stateChecks : []).map((item) => ({
    sceneId: String(item?.sceneId || ''),
    status: String(item?.status || 'skipped'),
    confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : 0,
    discrepancyCount: Array.isArray(item?.discrepancies) ? item.discrepancies.length : 0,
    directConflictCount: (Array.isArray(item?.discrepancies) ? item.discrepancies : [])
      .filter((discrepancy) => discrepancy?.conflictType === 'direct').length,
    deterministicDirectConflictCount: (Array.isArray(item?.discrepancies) ? item.discrepancies : [])
      .filter((discrepancy) => discrepancy?.conflictType === 'direct' && discrepancy?.comparisonSource === 'deterministic_context').length,
    extractorFailed: (Array.isArray(item?.discrepancies) ? item.discrepancies : [])
      .some((discrepancy) => /^独立状态抽取未完成/u.test(String(discrepancy?.summary || ''))),
  }));
}

async function judgeDraft(runtime, draft, fixture, caseDef, criticalRefs = [], assertions = []) {
  const systemPrompt = `你是盲评小说章节质量的 Benchmark Judge。只根据输入正文和固定资料评分，不参考 writer 的解释。
每项 1 到 5 分，输出 JSON：{"scores":{"characterVoice":0,"causalCoherence":0,"knowledgeBoundary":0,"styleAdherence":0,"sceneTransition":0,"proseNaturalness":0},"hardViolations":["明确硬伤"],"sourceEvidence":[{"sourceRef":"关键来源","status":"covered|not_covered","evidenceParagraphIds":["p-0"]}],"coveredConstraintIds":["advisory constraint id"]}。不要 Markdown。`;
  const strictSystemPrompt = `${systemPrompt}\nhardViolations 只允许列出可直接追溯到输入大纲 mustHappen/mustNotHappen、informationBoundaries 或结构化 timeline 的明确冲突。重复段落、文风、节奏、措辞、eventLedger 格式和推断性问题只能降低 scores，不得列为 hardViolations。\nsourceEvidence 必须逐一覆盖 criticalSources 中每个 sourceRef。只有正文确实体现该来源所给的可判定事实时 status 才能是 covered，并必须给出正文 paragraph id；writer 的 sourceUsage 和 eventLedger 不是证据。coveredConstraintIds 只能列出正文实际满足的 advisory assertions。`;
  const paragraphs = splitIntoParagraphs(draft.text).map((paragraph) => ({ id: paragraph.id, text: paragraph.text }));
  const result = await runtime.invoke({
    subagentId: 'sa-harness-benchmark-judge',
    systemPromptOverride: strictSystemPrompt,
    input: JSON.stringify({ style: fixture.style, characters: fixture.characters, outline: fixture.nodes, timeline: fixture.timeline, request: caseDef.request, paragraphs, criticalSources: sourceFactsForJudge(fixture, criticalRefs), assertions, text: draft.text }),
  }, { role: 'benchmark_judge', promptVersion: 'harness-benchmark-judge-v2' });
  const telemetry = result?.telemetry || {};
  return {
    quality: parseJsonOutput(result.output) || { scores: {}, hardViolations: ['judge_output_invalid'], sourceEvidence: [], coveredConstraintIds: [] },
    usage: telemetry.usage || {},
    modelCall: {
      role: 'benchmark_judge',
      model: telemetry.model || '',
      durationMs: telemetry.durationMs || 0,
      usage: telemetry.usage || {},
      promptVersion: 'harness-benchmark-judge-v2',
      promptHash: hash(strictSystemPrompt),
    },
  };
}

async function runCase({ caseDef, fixture, novelDir, mode, modelRuntime, modules, callToolOverride = null }) {
  const startedAt = Date.now();
  const callTool = callToolOverride || createFixtureCallTool(fixture, novelDir);
  const targetResolver = modules.targetResolver;
  const compiler = modules.compiler;
  const validator = modules.validator;
  const stateStore = modules.stateStore;
  const draftService = modules.draftService;
  const base = { caseId: caseDef.id, mode, live: mode === 'live' && caseDef.live === true, deterministic: caseDef.kind !== 'generation', success: false, passed: false, hardViolations: [], metrics: {} };
  try {
    if (caseDef.kind === 'target' || caseDef.kind === 'target-conflict') {
      const target = await targetResolver.resolveChapterTarget({
        mode: caseDef.kind === 'target-conflict' ? 'revise' : 'create',
        userText: caseDef.request,
        pendingChapterDraft: caseDef.kind === 'target-conflict' ? { name: 'chapter-010.md', displayName: '第10章', text: '待修订' } : null,
        editorContext: caseDef.kind === 'target-conflict' ? { type: 'chapter', name: 'chapter-010.md', title: '第10章' } : null,
        callTool,
      });
      const code = target.diagnostics?.[0]?.code || '';
      const passed = target.status === caseDef.expected.status && (!caseDef.expected.name || target.name === caseDef.expected.name) && (!caseDef.expected.code || code === caseDef.expected.code);
      return { ...base, success: true, passed, target: { status: target.status, name: target.name, code }, durationMs: Date.now() - startedAt };
    }

    const target = await targetResolver.resolveChapterTarget({ mode: 'create', userText: caseDef.request || '写第11章', callTool });
    if (target.status === 'blocked') throw new Error(target.diagnostics?.[0]?.message || 'target blocked');

    if (caseDef.kind === 'context' || caseDef.kind === 'cache-hit' || caseDef.kind === 'cache-invalidate') {
      compiler.clearChapterContextCache();
      const first = await compiler.compileChapterContext({ targetChapter: target, userText: caseDef.request, callTool, novelDir, settings: { contextDepth: 'auto' } });
      if (caseDef.kind === 'context') {
        const criticalTypes = new Set((first.criticalSourceRefs || []).map((item) => item.type));
        const passed = (caseDef.expected.criticalTypes || []).every((type) => criticalTypes.has(type));
        return { ...base, success: true, passed, metrics: { criticalSourceCount: first.criticalSourceRefs.length }, riskProfile: first.riskProfile, durationMs: Date.now() - startedAt };
      }
      const second = await compiler.compileChapterContext({ targetChapter: target, userText: caseDef.request, callTool, novelDir, settings: { contextDepth: 'auto' } });
      if (caseDef.kind === 'cache-hit') return { ...base, success: true, passed: second.cache?.hit === true, metrics: { cacheHit: second.cache?.hit === true }, durationMs: Date.now() - startedAt };
      await fs.appendFile(path.join(novelDir, 'chapters', 'chapter-010.md'), '\n\n缓存失效标记。', 'utf8');
      const third = await compiler.compileChapterContext({ targetChapter: target, userText: caseDef.request, callTool, novelDir, settings: { contextDepth: 'auto' } });
      return { ...base, success: true, passed: second.cache?.hit === true && third.cache?.hit === false, metrics: { beforeMutationHit: second.cache?.hit === true, afterMutationHit: third.cache?.hit === true }, durationMs: Date.now() - startedAt };
    }

    if (caseDef.kind === 'contracts') {
      const contracts = compiler.sceneContractsFromOutline(target, fixture.nodes, fixture.timeline);
      return { ...base, success: true, passed: contracts.some((scene) => scene.sceneId === caseDef.expected.sceneId && scene.appearingCharacterIds.length === 0), metrics: { sceneCount: contracts.length }, durationMs: Date.now() - startedAt };
    }

    if (caseDef.kind === 'judge-evidence' || caseDef.kind === 'judge-evidence-invalid') {
      const draft = {
        name: target.name,
        text: '林夜把蓝铜钥匙压进锁孔，门后的档案柜只剩潮湿的盐痕。',
        assertions: [{ constraintId: 'soft-style', severity: 'advisory' }],
      };
      const criticalRefs = [
        { ref: 'timeline:mh-10', type: 'timeline', deterministic: true },
        { ref: 'outline:mh-11-a', type: 'outline', deterministic: true },
      ];
      const expectsEvidenceRejection = caseDef.kind === 'judge-evidence-invalid';
      const judged = await judgeDraft(scriptedModelRuntime({ fault: expectsEvidenceRejection ? 'judge-invalid-evidence' : '' }), draft, fixture, caseDef, criticalRefs, draft.assertions);
      const quality = judged.quality;
      const coverage = independentSourceCoverage(criticalRefs, quality, splitIntoParagraphs(draft.text));
      const softConstraintCoverage = independentSoftConstraintCoverage(draft.assertions, quality);
      return {
        ...base,
        success: true,
        passed: expectsEvidenceRejection
          ? coverage.covered === 0 && coverage.missing.length === coverage.required
          : coverage.covered === coverage.required && softConstraintCoverage === 1 && !(quality.hardViolations || []).length,
        metrics: { criticalSourceRecall: coverage.required ? coverage.covered / coverage.required : 1, softConstraintCoverage },
        criticalSourceCoverage: { independentlyVerified: coverage },
        expectedEvidenceRejection: expectsEvidenceRejection,
        quality,
        usage: judged.usage,
        modelCalls: [judged.modelCall],
        durationMs: Date.now() - startedAt,
      };
    }

    if (caseDef.kind === 'anchored-repair') {
      const original = { name: 'chapter-010a.md', text: '第一段。\n\n阿婆说旧灯已经送到铺里。\n\n第三段。' };
      const request = validator.buildLocalRepairRequest({ draft: original, issues: [{ severity: 'blocking', paragraphIds: ['p-1'], summary: '物品位置冲突' }], repairRound: 1 });
      const shifted = { ...original, text: `新插入段。\n\n${original.text}` };
      const repaired = validator.applyParagraphReplacements(shifted, [{ paragraphId: 'p-1', text: '阿婆说旧灯还留在河西小院。' }], { targets: request.targets });
      const passed = repaired.applied === 1 && repaired.draft.text.includes('还留在河西小院') && repaired.draft.text.includes('新插入段') && !repaired.impact?.collateralParagraphIds?.length;
      return { ...base, success: true, passed, metrics: { applied: repaired.applied, collateral: repaired.impact?.collateralParagraphIds?.length || 0 }, durationMs: Date.now() - startedAt };
    }

    if (caseDef.kind === 'state-stale') {
      const content = await fs.readFile(path.join(novelDir, 'chapters', 'chapter-010.md'), 'utf8');
      await stateStore.saveConfirmedChapterState(novelDir, { name: 'chapter-010.md', text: content, eventLedger: { events: [] } }, []);
      const stale = await stateStore.readChapterState(novelDir, 'chapter-010.md', { expectedContent: `${content}\n变化` });
      return { ...base, success: true, passed: stale?.status === 'stale', durationMs: Date.now() - startedAt };
    }

    if (caseDef.kind === 'postwrite-idempotent') {
      const draft = { name: 'chapter-011.md', text: '确认后的正文。', eventLedger: { events: [] }, pendingStateDelta: { chapter: { worldState: { lampOpen: true } } } };
      const first = await stateStore.saveConfirmedChapterState(novelDir, draft, []);
      const firstRaw = await fs.readFile(stateStore.statePath(novelDir, draft.name), 'utf8');
      const second = await stateStore.saveConfirmedChapterState(novelDir, draft, []);
      const secondRaw = await fs.readFile(stateStore.statePath(novelDir, draft.name), 'utf8');
      return { ...base, success: true, passed: first.contentHash === second.contentHash && JSON.parse(firstRaw).worldState.lampOpen === JSON.parse(secondRaw).worldState.lampOpen, durationMs: Date.now() - startedAt };
    }

    const beforeFingerprint = await directoryFingerprint(novelDir);
    const fault = caseDef.kind === 'generation-retry' ? 'retry'
      : caseDef.kind === 'generation-fallback' ? 'fallback'
        : caseDef.kind === 'generation-state-block' ? 'state-direct-conflict'
          : caseDef.kind === 'generation-state-absence' ? 'state-absence-advisory'
            : '';
    const runtime = mode === 'live' && caseDef.live ? modelRuntime : scriptedModelRuntime({ fault });
    const result = await draftService.generateChapterDraft({
      mode: 'create',
      userText: caseDef.request || '写第11章',
      pendingChapterDraft: null,
      editorContext: null,
      modelRuntime: runtime,
      roleplayOptions: { disableRoleplay: true },
      runtimeDeps: {
        callTool,
        novelDir,
        writingConfig: { harnessMode: 'adaptive', contextDepth: 'auto', sceneGeneration: 'auto', verificationLevel: 'strict', mode: 'command_driven' },
      },
    });
    const afterFingerprint = await directoryFingerprint(novelDir);
    const trace = result.harnessTrace || {};
    const draft = result.draft;
    const critical = trace.criticalSourceCoverage || {};
    const chapterContext = draft?.contextBundle || null;
    let quality = null;
    let judgeUsage = {};
    let judgeModelCall = null;
    if (mode === 'live' && caseDef.live && draft?.text) {
      const judged = await judgeDraft(modelRuntime, draft, fixture, caseDef, chapterContext?.criticalSourceRefs || [], draft.assertions || []);
      quality = judged.quality;
      judgeUsage = judged.usage;
      judgeModelCall = judged.modelCall;
    }
    const assertions = draft?.assertions || [];
    const stateChecks = trace.stateVerifications || [];
    const paragraphs = splitIntoParagraphs(draft?.text || '');
    const independentCoverage = quality
      ? independentSourceCoverage(chapterContext?.criticalSourceRefs || [], quality, paragraphs, { entryState: chapterContext?.entryState, stateChecks })
      : { required: critical.required || 0, covered: critical.verified || 0, missing: critical.missing || [] };
    const metrics = {
      criticalSourceRecall: independentCoverage.required ? independentCoverage.covered / independentCoverage.required : 1,
      stateConsistency: verifiedStateConsistency(stateChecks),
      stateVerificationCompletion: stateVerificationCompletion(stateChecks),
      softConstraintCoverage: quality ? independentSoftConstraintCoverage(assertions, quality) : 1,
      preconfirmZeroWrite: beforeFingerprint === afterFingerprint,
      sceneCount: draft?.sceneDrafts?.length || 0,
    };
    const hardViolations = [
      ...(quality?.hardViolations || []),
      ...(result.blockingIssues || []).filter((item) => !item.reviewIncomplete && item.severity !== 'advisory').map((item) => item.summary || item.note || 'blocking_issue'),
    ];
    const enforceLiveQuality = mode === 'live' && caseDef.live === true;
    const expectedStateBlock = caseDef.kind === 'generation-state-block';
    const passed = !!draft && metrics.preconfirmZeroWrite && (expectedStateBlock ? hardViolations.length > 0 : !hardViolations.length)
      && (!enforceLiveQuality || (
        metrics.criticalSourceRecall === 1
        && metrics.stateConsistency >= 0.95
        && metrics.stateVerificationCompletion >= 0.95
        && metrics.softConstraintCoverage >= 0.85
      ))
      && (caseDef.kind !== 'generation-retry' || !trace.fallbackReason)
      && (caseDef.kind !== 'generation-fallback' || /scene_generation_failed/.test(trace.fallbackReason || ''));
    return {
      ...base,
      live: mode === 'live' && caseDef.live === true,
      deterministic: mode !== 'live' || !caseDef.live,
      success: !!draft,
      passed,
      hardViolations,
      expectedOutcome: expectedStateBlock ? 'blocked' : 'draft',
      observedOutcome: hardViolations.length ? 'blocked' : 'draft',
      metrics,
      criticalSourceCoverage: {
        writerDeclared: critical,
        independentlyVerified: independentCoverage,
      },
      stateVerificationSummary: summarizeStateVerifications(stateChecks),
      quality,
      usage: mergeUsage(trace.usage || {}, judgeUsage),
      modelCalls: [
        ...(trace.modelCalls || []).map((call) => ({ role: call.role, model: call.model, durationMs: call.durationMs, usage: call.usage, promptVersion: call.promptVersion, promptHash: call.promptHash })),
        ...(judgeModelCall ? [judgeModelCall] : []),
      ],
      promptVersions: trace.promptVersions || {},
      riskProfile: trace.riskProfile || {},
      outputHash: hash(draft?.text || ''),
      error: result?.draftGenerationError || (result?.draftGenerationFailed ? 'draft_generation_failed' : undefined),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return { ...base, error: err?.message || String(err), durationMs: Date.now() - startedAt };
  }
}

async function loadShadowFixture(novelDir, modules) {
  const novelData = require('../src/main/store/novelData');
  const chapters = await novelData.listChapters(novelDir);
  const characters = await novelData.listCharacters(novelDir);
  const nodes = await novelData.readOutlineNodes(novelDir);
  const timeline = await novelData.listTimeline(novelDir);
  const style = await novelData.readStyleMemory(novelDir);
  return {
    title: 'shadow',
    style,
    characters,
    nodes,
    timeline,
    chapters: chapters.map(() => ''),
    summaries: chapters.map(() => ''),
  };
}

function createDirectNovelCallTool(novelDir) {
  const { getToolByName } = require('../src/main/mcp/tools');
  const { novelPaths } = require('../src/main/store/paths');
  const ctx = { novelDir, paths: novelPaths(novelDir), novel: { id: 'shadow' } };
  return async ({ name, arguments: args = {} }) => {
    const tool = getToolByName(name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
    try { return await tool.handler(args, ctx); }
    catch (err) { return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] }; }
  };
}

function sanitizeShadowRun(row) {
  return {
    caseId: row.caseId,
    mode: row.mode,
    live: row.live,
    deterministic: false,
    success: row.success,
    passed: row.passed,
    hardViolations: row.hardViolations?.length ? ['redacted-shadow-hard-violation'] : [],
    metrics: row.metrics,
    quality: row.quality ? { scores: row.quality.scores || {}, hardViolations: row.quality.hardViolations?.length ? ['redacted'] : [] } : null,
    usage: row.usage,
    modelCalls: row.modelCalls,
    riskProfile: row.riskProfile ? { level: row.riskProfile.level, score: row.riskProfile.score, dimensions: row.riskProfile.dimensions } : null,
    outputHash: row.outputHash,
    durationMs: row.durationMs,
    error: row.error ? 'redacted-shadow-error' : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = await loadCorpus();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(ARTIFACT_ROOT, timestamp);
  const reportPath = args.report || path.join(runDir, 'report.json');
  await fs.mkdir(runDir, { recursive: true });
  let priorReport = null;
  if (args.resume) {
    if (!args.report) throw new Error('--resume requires an explicit --report path');
    try { priorReport = JSON.parse(await fs.readFile(reportPath, 'utf8')); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; }
  }

  let providerSnapshot = null;
  if (args.mode === 'live') providerSnapshot = await loadProviderSnapshot(args.providerRoot);
  process.env.MANA_USER_DATA_ROOT = path.join(runDir, 'userdata');
  process.env.MANA_USE_STDIO_MCP = '0';

  const modules = {
    targetResolver: require('../src/main/runtime/chapterTargetResolver'),
    compiler: require('../src/main/runtime/chapterContextCompiler'),
    validator: require('../src/main/runtime/chapterConstraintValidator'),
    stateStore: require('../src/main/store/chapterHarnessState'),
    draftService: require('../src/main/runtime/chapterDraftService'),
  };
  await require('../src/main/store/subagents').ensureBuiltinSeeds();
  const liveRuntime = providerSnapshot ? createLiveModelRuntime(providerSnapshot, args) : null;
  const selected = corpus.cases.filter((caseDef) => (
    caseDef.profile.includes(args.profile)
    && (!args.cases.length || args.cases.includes(caseDef.id))
    && (args.mode !== 'live' || caseDef.live === true || ['target', 'target-conflict', 'context', 'contracts'].includes(caseDef.kind))
  ));
  let shadowJob = null;
  if (args.mode === 'live' && args.novelDir) {
    const shadowDir = path.join(runDir, 'shadow-work');
    await fs.cp(args.novelDir, shadowDir, { recursive: true });
    shadowJob = {
      caseDef: { id: `shadow-${hash(args.novelDir).slice(0, 10)}`, kind: 'generation', request: '续写下一章', live: true, shadow: true },
      fixture: await loadShadowFixture(shadowDir, modules),
      novelDir: shadowDir,
      callTool: createDirectNovelCallTool(shadowDir),
    };
  }
  const jobs = [];
  const priorPassed = new Map((priorReport?.runs || []).filter((run) => (
    run.passed === true
    && (!run.live || ((run.metrics?.criticalSourceRecall ?? 1) >= 1 && (run.metrics?.stateConsistency ?? 1) >= 0.95))
  )).map((run) => [`${run.caseId}#${run.iteration}`, run]));
  for (const caseDef of selected) {
    const repeat = args.mode === 'live' && caseDef.live ? args.repeat : 1;
    for (let iteration = 1; iteration <= repeat; iteration += 1) {
      if (!priorPassed.has(`${caseDef.id}#${iteration}`)) jobs.push({ caseDef, iteration });
    }
  }
  if (shadowJob) {
    for (let iteration = 1; iteration <= args.repeat; iteration += 1) jobs.push({ ...shadowJob, iteration });
  }
  const runs = Array.from(priorPassed.values());
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const jobIndex = cursor;
      cursor += 1;
      const { caseDef, iteration } = jobs[jobIndex];
      const novelDir = jobs[jobIndex].novelDir || path.join(runDir, 'work', caseDef.id, String(iteration));
      const fixture = jobs[jobIndex].fixture || corpus.novels[caseDef.novel];
      if (!jobs[jobIndex].novelDir) await materializeNovel(fixture, novelDir);
      const row = await runCase({ caseDef, fixture, novelDir, mode: args.mode, modelRuntime: liveRuntime, modules, callToolOverride: jobs[jobIndex].callTool || null });
      runs.push({ ...(caseDef.shadow ? sanitizeShadowRun(row) : row), iteration });
      console.log(`[harness-benchmark] ${caseDef.id} #${iteration}: ${row.passed ? 'PASS' : 'FAIL'}${row.error ? ` (${row.error})` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, jobs.length || 1) }, () => worker()));
  const caseOrder = new Map(selected.map((caseDef, index) => [caseDef.id, index]));
  runs.sort((left, right) => (caseOrder.get(left.caseId) ?? 9999) - (caseOrder.get(right.caseId) ?? 9999) || left.iteration - right.iteration);
  let git = { commit: '', dirty: false };
  try {
    git.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    git.dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* metadata only */ }
  const report = safeJson({
    schemaVersion: 1,
    corpusVersion: corpus.corpusVersion,
    benchmarkPolicyVersion: BENCHMARK_POLICY_VERSION,
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    profile: args.profile,
    repeat: args.repeat,
    git,
    provider: args.mode === 'live' ? { models: liveRuntime.models, callCount: liveRuntime.calls, usage: liveRuntime.usage } : { type: 'scripted', models: ['scripted-model'] },
    promptSignature: hash(Array.from(new Set(runs.flatMap((run) => (run.modelCalls || []).map((call) => `${call.promptVersion}:${call.promptHash}`)))).sort().join('\n')),
    runs,
  });
  if (args.mode === 'live') {
    const caseUsage = mergeUsage(...runs.map((run) => run.usage || {}));
    const providerUsage = liveRuntime.usage;
    report.telemetry = {
      caseUsage,
      providerUsage,
      usageMatched: ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => caseUsage[key] === providerUsage[key]),
    };
  }
  let baseline = null;
  if (args.baseline) baseline = JSON.parse(await fs.readFile(args.baseline, 'utf8'));
  report.acceptance = evaluateReport(report, baseline);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  if (args.acceptBaseline) {
    if (report.acceptance.passed) {
      const baselinePath = path.join(ROOT, 'test', 'fixtures', 'chapter-harness-benchmark', `baseline-${args.mode}-${args.profile}.json`);
      await fs.writeFile(baselinePath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`[harness-benchmark] accepted baseline: ${baselinePath}`);
    } else {
      console.log('[harness-benchmark] baseline not updated because acceptance failed');
    }
  }
  console.log(`[harness-benchmark] report: ${reportPath}`);
  console.log(JSON.stringify(report.acceptance, null, 2));
  if (!report.acceptance.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[harness-benchmark] FATAL: ${err?.stack || err}`);
  process.exit(1);
});
