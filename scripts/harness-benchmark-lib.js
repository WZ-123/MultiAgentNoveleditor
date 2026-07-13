'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'test', 'fixtures', 'chapter-harness-benchmark', 'corpus.json');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'harness-benchmark');
const BENCHMARK_POLICY_VERSION = '2.3.0';
const LIVE_CORE_BUDGET = Object.freeze({
  maxTotalTokens: 780000,
  maxP95LatencyMs: 450000,
});

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeJson(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/api.?key|base.?url|provider.?url|local.?path/i.test(key)) return undefined;
    return item;
  }));
}

async function loadCorpus() {
  return JSON.parse(await fs.readFile(CORPUS_PATH, 'utf8'));
}

function parseArgs(argv) {
  const out = {
    mode: 'offline',
    profile: 'smoke',
    cases: [],
    repeat: null,
    resume: false,
    report: '',
    baseline: '',
    acceptBaseline: false,
    maxCalls: 200,
    maxInputTokens: 2000000,
    maxOutputTokens: 500000,
    callTimeoutMs: 180000,
    concurrency: 1,
    providerRoot: process.env.MANA_PROVIDER_CONFIG_ROOT || process.env.MANA_USER_DATA_ROOT || '',
    novelDir: '',
  };
  for (const arg of argv) {
    const [key, raw = ''] = arg.split('=', 2);
    if (key === '--mode') out.mode = raw;
    else if (key === '--profile') out.profile = raw;
    else if (key === '--cases') out.cases = raw.split(',').map((item) => item.trim()).filter(Boolean);
    else if (key === '--repeat') out.repeat = Math.max(1, Number(raw) || 1);
    else if (key === '--report') out.report = path.resolve(raw);
    else if (key === '--baseline') out.baseline = path.resolve(raw);
    else if (key === '--max-calls') out.maxCalls = Math.max(1, Number(raw) || out.maxCalls);
    else if (key === '--max-input-tokens') out.maxInputTokens = Math.max(1, Number(raw) || out.maxInputTokens);
    else if (key === '--max-output-tokens') out.maxOutputTokens = Math.max(1, Number(raw) || out.maxOutputTokens);
    else if (key === '--call-timeout-ms') out.callTimeoutMs = Math.max(1000, Number(raw) || out.callTimeoutMs);
    else if (key === '--concurrency') out.concurrency = Math.max(1, Number(raw) || 1);
    else if (key === '--provider-root') out.providerRoot = path.resolve(raw);
    else if (key === '--novel') out.novelDir = path.resolve(raw);
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--accept-baseline') out.acceptBaseline = true;
  }
  if (!['offline', 'live'].includes(out.mode)) throw new Error(`unknown benchmark mode: ${out.mode}`);
  if (!['smoke', 'core', 'full'].includes(out.profile)) throw new Error(`unknown benchmark profile: ${out.profile}`);
  if (!out.repeat) out.repeat = out.mode === 'live' ? (out.profile === 'smoke' ? 1 : 3) : 1;
  return out;
}

async function materializeNovel(fixture, dir) {
  await fs.mkdir(path.join(dir, 'chapters'), { recursive: true });
  await fs.mkdir(path.join(dir, 'summaries'), { recursive: true });
  await fs.mkdir(path.join(dir, 'outlines'), { recursive: true });
  await fs.mkdir(path.join(dir, 'characters'), { recursive: true });
  await fs.mkdir(path.join(dir, 'timeline'), { recursive: true });
  await fs.mkdir(path.join(dir, 'style'), { recursive: true });
  await fs.writeFile(path.join(dir, 'novel.json'), JSON.stringify({ schemaVersion: 1, id: `benchmark-${hash(fixture.title).slice(0, 8)}`, title: fixture.title }, null, 2));
  for (let index = 0; index < fixture.chapters.length; index += 1) {
    const name = `chapter-${String(index + 1).padStart(3, '0')}.md`;
    await fs.writeFile(path.join(dir, 'chapters', name), fixture.chapters[index], 'utf8');
    await fs.writeFile(path.join(dir, 'summaries', name), fixture.summaries[index] || '', 'utf8');
  }
  await fs.writeFile(path.join(dir, 'outlines', 'nodes.json'), JSON.stringify({ schemaVersion: 1, nodes: fixture.nodes }, null, 2));
  await fs.writeFile(path.join(dir, 'outlines', 'outline.md'), `# ${fixture.title}\n\n${fixture.nodes.map((node) => node.summary).join('\n')}`, 'utf8');
  await fs.writeFile(path.join(dir, 'style', 'memory.md'), fixture.style, 'utf8');
  await fs.writeFile(path.join(dir, 'timeline', 'events.jsonl'), `${fixture.timeline.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  for (const character of fixture.characters) {
    await fs.writeFile(path.join(dir, 'characters', `${character.id}.json`), JSON.stringify(character, null, 2));
  }
  return dir;
}

function toolResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { isError, content: [{ type: 'text', text }] };
}

function createFixtureCallTool(fixture, novelDir) {
  const displays = fixture.chapters.map((_chapter, index) => ({
    name: `chapter-${String(index + 1).padStart(3, '0')}.md`,
    fileName: `chapter-${String(index + 1).padStart(3, '0')}.md`,
    displayName: `第${index + 1}章`,
    seq: index + 1,
  }));
  return async ({ name, arguments: args = {} }) => {
    if (name === 'list_chapter_displays') return toolResult(displays);
    if (name === 'read_outline_nodes') return toolResult({ nodes: fixture.nodes });
    if (name === 'query_timeline') return toolResult({ events: fixture.timeline });
    if (name === 'read_style_memory') return toolResult(fixture.style);
    if (name === 'suggest_next_chapter_name') return toolResult({ fileName: 'chapter-011.md', displayName: '第11章', seq: 11 });
    if (name === 'read_chapter') {
      try { return toolResult(await fs.readFile(path.join(novelDir, 'chapters', path.basename(args.name || '')), 'utf8')); }
      catch (err) { return toolResult(err.message, true); }
    }
    if (name === 'read_chapter_summary') {
      try { return toolResult(await fs.readFile(path.join(novelDir, 'summaries', path.basename(args.name || '')), 'utf8')); }
      catch { return toolResult(''); }
    }
    if (name === 'read_outline') return toolResult(`# 大纲\n${fixture.nodes.map((node) => `${node.title}：${node.summary}`).join('\n')}`);
    if (name === 'assemble_scene_context') {
      const node = fixture.nodes.find((item) => item.id === args.nodeId);
      return toolResult({
        nodeId: node?.id || '',
        title: node?.title || '',
        location: node?.location || '',
        pov: node?.pov || '',
        characters: fixture.characters.filter((character) => (node?.characters || []).includes(character.id)),
      });
    }
    if (name === 'retrieve_context') return toolResult({ query: args.query || '', resultCount: 2, contextText: `Retrieved Novel Context\n${fixture.style}\n${fixture.timeline.map((event) => event.description).join('\n')}`, items: [], wasTrimmed: false });
    return toolResult(`unsupported fixture tool: ${name}`, true);
  };
}

function scriptedModelRuntime({ fault = '' } = {}) {
  let calls = 0;
  let writerCalls = 0;
  return {
    get calls() { return calls; },
    async invoke(options, meta = {}) {
      calls += 1;
      const role = meta.role || options.subagentId || '';
      const inputText = typeof options.input === 'string' ? options.input : JSON.stringify(options.input || {});
      let output;
      if (role === 'constraint_verifier') {
        const input = JSON.parse(inputText);
        output = JSON.stringify({
          checks: (input.assertions || []).map((assertion) => ({
            constraintId: assertion.constraintId,
            status: 'satisfied',
            summary: '脚本验证器确认约束已满足。',
            confidence: 0.99,
            evidenceParagraphIds: ['p-0'],
            sourceRefs: (assertion.sourceRefs || []).map((ref) => ref.ref || ref),
          })),
        });
      } else if (role === 'state_extractor') {
        const input = JSON.parse(inputText);
        const refs = input.sceneContract?.sourceRefs || [];
        output = JSON.stringify({
          extracted: input.writerDeclared || {},
          discrepancies: fault === 'state-direct-conflict'
            ? [{ path: 'assets.magneticKey', conflictType: 'direct', comparisonSource: 'deterministic_context', severity: 'blocking', summary: '正文与磁钥持有状态直接冲突。', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'timeline:bb-10' }]
            : fault === 'state-absence-advisory'
              ? [{ path: 'assets.magneticKey', conflictType: 'absence', comparisonSource: 'deterministic_context', severity: 'blocking', summary: '入场状态未单列磁钥字段。', confidence: 0.99, evidenceParagraphIds: ['p-0'], deterministicSourceRef: 'timeline:bb-10' }]
              : [],
          confidence: 0.98,
          evidenceParagraphIds: ['p-0'],
          sourceUsage: refs.map((ref) => ({ sourceRef: ref.ref, usedFor: '核对场景状态', evidenceParagraphIds: ['p-0'] })),
        });
      } else if (role === 'character_world' || role === 'timeline') {
        output = JSON.stringify({ issues: [] });
      } else if (['prose_quality', 'style', 'paragraph_function'].includes(role)) {
        output = JSON.stringify({ annotations: [] });
      } else if (role === 'benchmark_judge') {
        const judgeInput = JSON.parse(inputText);
        output = JSON.stringify({
          scores: { characterVoice: 4.2, causalCoherence: 4.3, knowledgeBoundary: 4.5, styleAdherence: 4.1, sceneTransition: 4.2, proseNaturalness: 4.1 },
          hardViolations: [],
          sourceEvidence: (judgeInput?.criticalSources || []).map((source) => ({ sourceRef: source.sourceRef, status: 'covered', evidenceParagraphIds: [fault === 'judge-invalid-evidence' ? 'p-999' : 'p-0'] })),
          coveredConstraintIds: (judgeInput?.assertions || []).filter((item) => item?.severity === 'advisory').map((item) => item.constraintId),
        });
      } else {
        writerCalls += 1;
        let scene = null;
        try { scene = JSON.parse(inputText); } catch { scene = null; }
        const isScene = scene?.task === 'draft_single_scene';
        if (fault === 'retry' && writerCalls === 1) output = '{bad json';
        else if (fault === 'fallback' && writerCalls <= 2) output = '{bad json';
        else if (isScene) {
          const refs = [
            `chapter:${scene.targetChapter?.name || 'chapter-011.md'}`,
            'chapter:chapter-010.md',
            ...(scene.sceneContract?.sourceRefs || []).map((ref) => ref.ref),
          ];
          output = JSON.stringify({
            sceneId: scene.sceneContract.sceneId,
            text: `${scene.sceneContract.title || '场景'}里，${(scene.sceneContract.mustHappen || []).join('，') || '人物谨慎推进了行动'}。`,
            eventLedger: { events: [{ order: 1, when: scene.sceneContract.when || '', where: scene.sceneContract.location || '', participants: scene.sceneContract.appearingCharacterIds || [], action: scene.sceneContract.mustHappen?.[0] || scene.sceneContract.purpose }] },
            stateDelta: { location: scene.sceneContract.location || '', events: scene.sceneContract.mustHappen || [] },
            constraintCoverage: (scene.assertions || []).map((item) => item.constraintId),
            sourceUsage: Array.from(new Set(refs)).map((ref) => ({ sourceRef: ref, usedFor: '场景事实', evidenceParagraphIds: ['p-0'] })),
          });
        } else {
          output = JSON.stringify({ title: '基准章节', summary: '按大纲完成章节', text: '窗外的光一点点移过地板，人物依照既定线索完成了这一章必须发生的行动。', eventLedger: { events: [] }, stateDelta: {}, constraintCoverage: [], sourceUsage: [] });
        }
      }
      const inputTokens = Math.ceil(inputText.length / 2);
      const outputTokens = Math.ceil(output.length / 2);
      return { output, runId: `scripted-${calls}`, telemetry: { model: 'scripted-model', providerType: 'scripted', turns: 1, durationMs: 1, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true } } };
    },
  };
}

function inferProviderType(provider) {
  if (provider?.type === 'anthropic' || provider?.type === 'openai-compat') return provider.type;
  return /anthropic|claude/i.test(`${provider?.baseUrl || ''} ${provider?.name || ''}`) ? 'anthropic' : 'openai-compat';
}

async function loadProviderSnapshot(providerRoot) {
  if (!providerRoot) {
    providerRoot = path.join(process.env.HOME || '', 'Library', 'Application Support', 'multi-agent-novel-assistant', 'MultiAgentNovelAssistant');
  }
  const providersState = JSON.parse(await fs.readFile(path.join(providerRoot, 'providers.json'), 'utf8'));
  const aliasesState = JSON.parse(await fs.readFile(path.join(providerRoot, 'modelAliases.json'), 'utf8'));
  const providers = Array.isArray(providersState.providers) ? providersState.providers : [];
  const aliases = Array.isArray(aliasesState.aliases) ? aliasesState.aliases : [];
  const active = providers.find((provider) => provider.id === providersState.activeProviderId) || providers.find((provider) => provider.apiKey);
  if (!active?.apiKey) throw new Error('本地 dev Provider 未配置可用 API Key');
  return { providers, aliases, activeProviderId: active.id };
}

function createLiveModelRuntime(snapshot, limits) {
  const anthropic = require('../src/main/runtime/providers/anthropic');
  const openaiCompat = require('../src/main/runtime/providers/openaiCompat');
  let callCount = 0;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const modelIds = new Set();
  function aliasForRole(role) {
    const id = role === 'writer' ? 'sonnet' : ['prose_quality', 'style', 'paragraph_function'].includes(role) ? 'haiku' : 'opus';
    return snapshot.aliases.find((alias) => alias.id === id) || snapshot.aliases[0] || {};
  }
  return {
    get calls() { return callCount; },
    get usage() { return { ...usage }; },
    get models() { return Array.from(modelIds); },
    async invoke(options, meta = {}) {
      if (callCount >= limits.maxCalls) throw new Error(`benchmark max-calls exceeded: ${limits.maxCalls}`);
      callCount += 1;
      const alias = aliasForRole(meta.role || '');
      const provider = snapshot.providers.find((item) => item.id === alias.providerId)
        || snapshot.providers.find((item) => item.id === snapshot.activeProviderId);
      if (!provider?.apiKey) throw new Error(`benchmark provider unavailable for alias ${alias.id || 'unknown'}`);
      const type = inferProviderType(provider);
      const adapter = type === 'anthropic' ? anthropic : openaiCompat;
      const tier = {
        type,
        baseUrl: provider.baseUrl || '',
        apiKey: provider.apiKey,
        model: alias.modelId || provider.models?.[0]?.id || '',
        extra: { ...(provider.extra || {}), maxTokens: alias.maxOutputTokens || 8192, temperature: alias.temperature ?? 0.2 },
        thinking: alias.thinking ? { type: 'enabled', budget_tokens: alias.thinkingBudget || 16000 } : undefined,
      };
      modelIds.add(tier.model);
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.callTimeoutMs);
      const onAbort = () => controller.abort();
      options.abortSignal?.addEventListener?.('abort', onAbort, { once: true });
      let result;
      try {
        result = await adapter.sendMessage({
          system: options.systemPromptOverride || '',
          messages: [{ role: 'user', content: [{ type: 'text', text: typeof options.input === 'string' ? options.input : JSON.stringify(options.input || {}) }] }],
          tools: undefined,
          tier,
          abortSignal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        options.abortSignal?.removeEventListener?.('abort', onAbort);
      }
      usage.inputTokens += result.usage?.inputTokens || 0;
      usage.outputTokens += result.usage?.outputTokens || 0;
      usage.totalTokens += result.usage?.totalTokens || 0;
      if (usage.inputTokens > limits.maxInputTokens) throw new Error('benchmark max-input-tokens exceeded');
      if (usage.outputTokens > limits.maxOutputTokens) throw new Error('benchmark max-output-tokens exceeded');
      const output = (result.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('');
      return { output, runId: result.requestId || `live-${callCount}`, telemetry: { model: result.model || tier.model, providerType: type, turns: 1, durationMs: Date.now() - startedAt, usage: result.usage, providerCalls: [{ requestId: result.requestId || '', usage: result.usage }] } };
    },
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  const numeric = values.filter(Number.isFinite);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function evaluateReport(report, baseline = null) {
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  const deterministic = runs.filter((run) => run.mode === 'offline' || run.deterministic === true);
  const live = runs.filter((run) => run.live === true);
  const hardPassRate = deterministic.length ? deterministic.filter((run) => run.passed).length / deterministic.length : 1;
  const liveByCase = new Map();
  for (const run of live) {
    if (!liveByCase.has(run.caseId)) liveByCase.set(run.caseId, []);
    liveByCase.get(run.caseId).push(run);
  }
  const liveCasePass = Array.from(liveByCase.values()).every((items) => {
    const required = Math.ceil(items.length * 2 / 3);
    const accepted = items.filter((item) => item.passed === true && !(item.hardViolations || []).length);
    return accepted.length >= required;
  });
  const acceptedLive = live.filter((run) => run.passed === true && !(run.hardViolations || []).length);
  const coverage = acceptedLive.map((run) => run.metrics?.criticalSourceRecall).filter(Number.isFinite);
  const state = acceptedLive.map((run) => run.metrics?.stateConsistency).filter(Number.isFinite);
  const stateCompletion = acceptedLive.map((run) => run.metrics?.stateVerificationCompletion).filter(Number.isFinite);
  const soft = acceptedLive.map((run) => run.metrics?.softConstraintCoverage).filter(Number.isFinite);
  const allCoverage = live.map((run) => run.metrics?.criticalSourceRecall).filter(Number.isFinite);
  const allState = live.map((run) => run.metrics?.stateConsistency).filter(Number.isFinite);
  const allStateCompletion = live.map((run) => run.metrics?.stateVerificationCompletion).filter(Number.isFinite);
  const allSoft = live.map((run) => run.metrics?.softConstraintCoverage).filter(Number.isFinite);
  const scoreKeys = ['characterVoice', 'causalCoherence', 'knowledgeBoundary', 'styleAdherence', 'sceneTransition', 'proseNaturalness'];
  const quality = Object.fromEntries(scoreKeys.map((key) => [key, median(live.map((run) => run.quality?.scores?.[key]))]));
  const qualityValues = Object.values(quality).filter(Number.isFinite);
  const qualitySamples = live.flatMap((run) => Object.values(run.quality?.scores || {}).filter(Number.isFinite));
  const minimumSample = qualitySamples.length ? Math.min(...qualitySamples) : null;
  const totalTokens = runs.reduce((sum, run) => sum + (run.usage?.totalTokens || 0), 0);
  const p95LatencyMs = percentile(runs.map((run) => run.durationMs), 0.95);
  const coreBudgetApplies = report?.mode === 'live' && report?.profile === 'core';
  const performanceBudget = {
    applicable: coreBudgetApplies,
    ...LIVE_CORE_BUDGET,
    totalTokensPassed: !coreBudgetApplies || totalTokens <= LIVE_CORE_BUDGET.maxTotalTokens,
    p95LatencyPassed: !coreBudgetApplies || p95LatencyMs <= LIVE_CORE_BUDGET.maxP95LatencyMs,
  };
  performanceBudget.passed = performanceBudget.totalTokensPassed && performanceBudget.p95LatencyPassed;
  const summary = {
    deterministicPassRate: hardPassRate,
    liveCasePass,
    criticalSourceRecall: mean(coverage),
    stateConsistency: mean(state),
    stateVerificationCompletion: mean(stateCompletion),
    softConstraintCoverage: mean(soft),
    allSampleCriticalSourceRecall: mean(allCoverage),
    allSampleStateConsistency: mean(allState),
    allSampleStateVerificationCompletion: mean(allStateCompletion),
    allSampleSoftConstraintCoverage: mean(allSoft),
    acceptedLiveSamples: acceptedLive.length,
    failedLiveSamples: live.length - acceptedLive.length,
    quality,
    minimumQualitySample: minimumSample,
    totalTokens,
    p95LatencyMs,
    performanceBudget,
  };
  const absolutePassed = hardPassRate === 1
    && liveCasePass
    && report?.telemetry?.usageMatched !== false
    && (!coverage.length || Math.min(...coverage) >= 1)
    && (!state.length || mean(state) >= 0.95)
    && (!stateCompletion.length || mean(stateCompletion) >= 0.95)
    && (!soft.length || mean(soft) >= 0.85)
    && (!qualityValues.length || (qualityValues.every((value) => value >= 4) && minimumSample >= 3))
    && performanceBudget.passed;
  const comparable = baseline?.acceptance?.summary
    ? report.corpusVersion === baseline.corpusVersion
      && report.benchmarkPolicyVersion === baseline.benchmarkPolicyVersion
      && JSON.stringify(report.provider?.models || []) === JSON.stringify(baseline.provider?.models || [])
      && report.promptSignature === baseline.promptSignature
    : true;
  const comparison = baseline?.acceptance?.summary
    ? comparable
      ? compareSummaries(summary, baseline.acceptance.summary)
      : { passed: false, comparable: false, reason: 'Corpus、Benchmark 策略、模型 ID 或 Prompt 签名不一致。' }
    : null;
  return { passed: absolutePassed && (!comparison || comparison.passed), summary, comparison };
}

function compareSummaries(candidate, baseline) {
  const qualityDeltas = {};
  for (const key of Object.keys(candidate.quality || {})) {
    if (Number.isFinite(candidate.quality[key]) && Number.isFinite(baseline.quality?.[key])) qualityDeltas[key] = candidate.quality[key] - baseline.quality[key];
  }
  const tokenRatio = baseline.totalTokens > 0 ? candidate.totalTokens / baseline.totalTokens : null;
  const latencyRatio = baseline.p95LatencyMs > 0 ? candidate.p95LatencyMs / baseline.p95LatencyMs : null;
  const qualityGain = median(Object.values(qualityDeltas));
  const performanceExceeded = (tokenRatio != null && tokenRatio > 1.2) || (latencyRatio != null && latencyRatio > 1.3);
  const tradeoffReview = performanceExceeded && qualityGain >= 0.3;
  return {
    qualityDeltas,
    tokenRatio,
    latencyRatio,
    tradeoffReview,
    passed: Object.values(qualityDeltas).every((delta) => delta >= -0.2) && !performanceExceeded,
  };
}

module.exports = {
  ARTIFACT_ROOT,
  BENCHMARK_POLICY_VERSION,
  CORPUS_PATH,
  ROOT,
  compareSummaries,
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
};
