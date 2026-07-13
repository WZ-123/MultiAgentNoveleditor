'use strict';

const HARNESS_MODES = new Set(['adaptive', 'legacy']);
const CONTEXT_DEPTHS = new Set(['auto', 'compact', 'deep']);
const SCENE_GENERATION_MODES = new Set(['auto', 'chapter', 'scene']);
const CONSTRAINT_SEVERITIES = new Set(['blocking', 'advisory']);
const VERIFICATION_LEVELS = new Set(['auto', 'fast', 'strict']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const KNOWLEDGE_STATES = new Set(['unknown', 'suspected', 'known', 'misinformed']);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function stringList(value) {
  return list(value).map(text).filter(Boolean);
}

function enumValue(value, allowed, fallback) {
  const normalized = text(value);
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeSourceRef(value = {}) {
  if (typeof value === 'string') {
    return { ref: text(value), type: 'unknown', priority: 99, deterministic: false, criticality: 'optional' };
  }
  return {
    ref: text(value.ref || value.sourceRef),
    type: text(value.type || value.sourceType) || 'unknown',
    priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 99,
    deterministic: value.deterministic === true,
    criticality: ['critical', 'required', 'optional'].includes(value.criticality) ? value.criticality : 'optional',
  };
}

function normalizeUsage(value = {}) {
  const safeNumber = (raw) => Number.isFinite(Number(raw)) ? Math.max(0, Math.trunc(Number(raw))) : 0;
  const inputTokens = safeNumber(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
  const outputTokens = safeNumber(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: safeNumber(value.totalTokens ?? value.total_tokens) || inputTokens + outputTokens,
    cacheReadTokens: safeNumber(value.cacheReadTokens ?? value.cache_read_input_tokens),
    cacheWriteTokens: safeNumber(value.cacheWriteTokens ?? value.cache_creation_input_tokens),
    estimated: value.estimated === true,
  };
}

function normalizeModelCallTrace(value = {}, index = 0) {
  return {
    callId: text(value.callId) || `model-call-${index + 1}`,
    role: text(value.role || value.subagentId) || 'unknown',
    model: text(value.model),
    providerType: text(value.providerType),
    requestId: text(value.requestId),
    durationMs: Number.isFinite(Number(value.durationMs)) ? Math.max(0, Number(value.durationMs)) : 0,
    turns: Number.isInteger(Number(value.turns)) ? Math.max(0, Number(value.turns)) : 0,
    usage: normalizeUsage(value.usage || {}),
    promptVersion: text(value.promptVersion),
    promptHash: text(value.promptHash),
    status: text(value.status) || 'done',
  };
}

function normalizeRiskProfile(value = {}) {
  const dimensions = value.dimensions && typeof value.dimensions === 'object' ? value.dimensions : {};
  return {
    level: enumValue(value.level, RISK_LEVELS, 'low'),
    score: Number.isFinite(Number(value.score)) ? Math.max(0, Number(value.score)) : 0,
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, raw]) => [
      key,
      Number.isFinite(Number(raw)) ? Math.max(0, Math.min(3, Number(raw))) : 0,
    ])),
    reasons: stringList(value.reasons),
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
  };
}

function normalizeKnowledgeFact(value = {}) {
  return {
    factId: text(value.factId || value.id),
    proposition: text(value.proposition || value.fact),
    state: enumValue(value.state, KNOWLEDGE_STATES, 'unknown'),
    learnedChapterRef: text(value.learnedChapterRef),
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
    evidenceParagraphIds: stringList(value.evidenceParagraphIds),
  };
}

function normalizeChapterExitState(value = {}) {
  return {
    schemaVersion: Number.isInteger(Number(value.schemaVersion)) ? Number(value.schemaVersion) : 1,
    chapterRef: text(value.chapterRef),
    contentHash: text(value.contentHash),
    status: value.status === 'stale' ? 'stale' : 'valid',
    extractedAt: text(value.extractedAt),
    characters: list(value.characters).map((character) => ({
      id: text(character?.id),
      name: text(character?.name),
      location: text(character?.location),
      physicalState: stringList(character?.physicalState),
      emotionalState: stringList(character?.emotionalState),
      relationships: character?.relationships && typeof character.relationships === 'object' ? character.relationships : {},
      knowledge: list(character?.knowledge).map(normalizeKnowledgeFact).filter((fact) => fact.factId || fact.proposition),
    })).filter((character) => character.id || character.name),
    assets: list(value.assets),
    worldState: value.worldState && typeof value.worldState === 'object' ? value.worldState : {},
    unresolvedThreads: list(value.unresolvedThreads),
    events: list(value.events),
    evidence: list(value.evidence),
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
  };
}

function normalizeVerifiedStateDelta(value = {}) {
  return {
    sceneId: text(value.sceneId),
    writerDeclared: value.writerDeclared && typeof value.writerDeclared === 'object' ? value.writerDeclared : {},
    extracted: value.extracted && typeof value.extracted === 'object' ? value.extracted : {},
    merged: value.merged && typeof value.merged === 'object' ? value.merged : {},
    discrepancies: list(value.discrepancies),
    confidence: Number.isFinite(Number(value.confidence)) ? Math.max(0, Math.min(1, Number(value.confidence))) : 0,
    evidenceParagraphIds: stringList(value.evidenceParagraphIds),
    status: ['verified', 'warning', 'blocking', 'skipped'].includes(value.status) ? value.status : 'skipped',
  };
}

function normalizeSourceUsageEvidence(value = {}) {
  return {
    sourceRef: text(value.sourceRef || value.ref),
    sceneId: text(value.sceneId),
    usedFor: text(value.usedFor || value.purpose),
    evidenceParagraphIds: stringList(value.evidenceParagraphIds),
    verified: value.verified === true,
  };
}

function normalizeResolvedChapterTarget(value = {}) {
  return {
    status: value.status === 'blocked' ? 'blocked' : 'resolved',
    name: text(value.name || value.fileName),
    fileName: text(value.fileName || value.name),
    displayName: text(value.displayName || value.titleHint || value.name),
    titleHint: text(value.titleHint || value.displayName || value.name),
    ordinal: Number.isInteger(Number(value.ordinal)) ? Number(value.ordinal) : null,
    source: text(value.source) || 'unknown',
    existing: value.existing === true,
    diagnostics: list(value.diagnostics).map(normalizeDiagnostic).filter(Boolean),
  };
}

function normalizeContextSpec(value = {}) {
  const budgets = value.budgets && typeof value.budgets === 'object' ? value.budgets : {};
  return {
    depth: enumValue(value.depth, CONTEXT_DEPTHS, 'auto'),
    required: stringList(value.required),
    optional: stringList(value.optional),
    budgets: Object.fromEntries(Object.entries(budgets).map(([key, raw]) => [
      key,
      Math.max(0, Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : 0),
    ])),
  };
}

function normalizeDiagnostic(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const message = text(value.message || value.summary || value.detail);
  if (!message) return null;
  return {
    code: text(value.code) || 'harness_diagnostic',
    severity: value.severity === 'blocking' ? 'blocking' : 'warning',
    message,
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
  };
}

function normalizeSceneContract(value = {}, index = 0) {
  return {
    sceneId: text(value.sceneId || value.id) || `scene-${index + 1}`,
    chapterRef: text(value.chapterRef),
    title: text(value.title),
    purpose: text(value.purpose || value.summary),
    pov: text(value.pov),
    when: text(value.when || value.time),
    location: text(value.location),
    setting: text(value.setting),
    appearingCharacterIds: stringList(value.appearingCharacterIds || value.characters),
    entryState: value.entryState && typeof value.entryState === 'object' ? value.entryState : {},
    mustHappen: stringList(value.mustHappen),
    mustNotHappen: stringList(value.mustNotHappen),
    informationBoundaries: stringList(value.informationBoundaries),
    creativeFreedom: stringList(value.creativeFreedom || value.allowedFreedom),
    expectedExitState: value.expectedExitState && typeof value.expectedExitState === 'object'
      ? value.expectedExitState
      : {},
    continuityFacts: stringList(value.continuityFacts),
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
  };
}

function normalizeConstraintAssertion(value = {}, index = 0) {
  const sourceRefs = list(value.sourceRefs).map(normalizeSourceRef).filter((item) => item.ref);
  const deterministic = value.deterministic === true || sourceRefs.some((item) => item.deterministic);
  const requestedSeverity = enumValue(value.severity, CONSTRAINT_SEVERITIES, 'advisory');
  return {
    constraintId: text(value.constraintId || value.id) || `constraint-${index + 1}`,
    type: text(value.type) || 'narrative',
    assertion: text(value.assertion || value.text || value.summary),
    severity: requestedSeverity === 'blocking' && deterministic ? 'blocking' : 'advisory',
    deterministic,
    sceneId: text(value.sceneId),
    sourceRefs,
  };
}

function normalizeDraftTrace(value = {}) {
  const modelCalls = list(value.modelCalls).map(normalizeModelCallTrace);
  const aggregatedUsage = modelCalls.reduce((sum, call) => ({
    inputTokens: sum.inputTokens + call.usage.inputTokens,
    outputTokens: sum.outputTokens + call.usage.outputTokens,
    totalTokens: sum.totalTokens + call.usage.totalTokens,
    cacheReadTokens: sum.cacheReadTokens + call.usage.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + call.usage.cacheWriteTokens,
    estimated: sum.estimated || call.usage.estimated,
  }), normalizeUsage({}));
  const suppliedUsage = normalizeUsage(value.usage || {});
  const usage = suppliedUsage.totalTokens || !modelCalls.length ? suppliedUsage : aggregatedUsage;
  return {
    traceId: text(value.traceId),
    harnessMode: enumValue(value.harnessMode, HARNESS_MODES, 'adaptive'),
    contextDepth: enumValue(value.contextDepth, CONTEXT_DEPTHS, 'auto'),
    sceneGeneration: enumValue(value.sceneGeneration, SCENE_GENERATION_MODES, 'auto'),
    verificationLevel: enumValue(value.verificationLevel, VERIFICATION_LEVELS, 'auto'),
    targetSource: text(value.targetSource),
    startedAt: text(value.startedAt),
    completedAt: text(value.completedAt),
    stages: list(value.stages).map((stage) => ({
      name: text(stage?.name),
      durationMs: Number.isFinite(Number(stage?.durationMs)) ? Math.max(0, Number(stage.durationMs)) : 0,
      status: text(stage?.status) || 'done',
      detail: stage?.detail && typeof stage.detail === 'object' ? stage.detail : {},
    })).filter((stage) => stage.name),
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
    diagnostics: list(value.diagnostics).map(normalizeDiagnostic).filter(Boolean),
    trimmed: stringList(value.trimmed),
    cacheHit: value.cacheHit === true,
    fallbackReason: text(value.fallbackReason),
    repairRounds: Number.isInteger(Number(value.repairRounds)) ? Math.max(0, Number(value.repairRounds)) : 0,
    promptVersions: value.promptVersions && typeof value.promptVersions === 'object' ? value.promptVersions : {},
    modelCalls,
    usage,
    riskProfile: normalizeRiskProfile(value.riskProfile || {}),
    stateSnapshot: value.stateSnapshot && typeof value.stateSnapshot === 'object' ? value.stateSnapshot : null,
    stateVerifications: list(value.stateVerifications).map(normalizeVerifiedStateDelta),
    constraintVerifications: list(value.constraintVerifications).map((item, index) => ({
      constraintId: text(item?.constraintId || item?.id) || `constraint-${index + 1}`,
      sceneId: text(item?.sceneId),
      status: enumValue(item?.status, new Set(['satisfied', 'violated', 'unclear']), 'unclear'),
      severity: enumValue(item?.severity, CONSTRAINT_SEVERITIES, 'advisory'),
      deterministic: item?.deterministic === true,
      assertion: text(item?.assertion),
      summary: text(item?.summary),
      confidence: Number.isFinite(Number(item?.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0,
      sourceRefs: stringList(item?.sourceRefs),
      evidenceParagraphIds: stringList(item?.evidenceParagraphIds),
      reviewIncomplete: item?.reviewIncomplete === true,
    })),
    sourceUsage: list(value.sourceUsage).map(normalizeSourceUsageEvidence).filter((item) => item.sourceRef),
    criticalSourceCoverage: value.criticalSourceCoverage && typeof value.criticalSourceCoverage === 'object'
      ? value.criticalSourceCoverage
      : { required: 0, used: 0, verified: 0, missing: [] },
    repairImpact: list(value.repairImpact),
  };
}

function normalizeChapterContextBundle(value = {}) {
  return {
    targetChapter: normalizeResolvedChapterTarget(value.targetChapter || {}),
    contextSpec: normalizeContextSpec(value.contextSpec || {}),
    continuity: value.continuity && typeof value.continuity === 'object' ? value.continuity : {},
    outlineIntent: value.outlineIntent && typeof value.outlineIntent === 'object' ? value.outlineIntent : {},
    sceneCharacterContexts: list(value.sceneCharacterContexts),
    nearbyTimeline: list(value.nearbyTimeline),
    stylePacket: value.stylePacket && typeof value.stylePacket === 'object' ? value.stylePacket : {},
    retrievedContext: value.retrievedContext && typeof value.retrievedContext === 'object' ? value.retrievedContext : null,
    hardConstraints: stringList(value.hardConstraints),
    softPreferences: stringList(value.softPreferences),
    sceneContracts: list(value.sceneContracts).map(normalizeSceneContract),
    assertions: list(value.assertions).map(normalizeConstraintAssertion).filter((item) => item.assertion),
    sourceRefs: list(value.sourceRefs).map(normalizeSourceRef),
    diagnostics: list(value.diagnostics).map(normalizeDiagnostic).filter(Boolean),
    trimmed: stringList(value.trimmed),
    cache: value.cache && typeof value.cache === 'object' ? value.cache : { hit: false },
    riskProfile: normalizeRiskProfile(value.riskProfile || {}),
    entryState: value.entryState ? normalizeChapterExitState(value.entryState) : null,
    criticalSourceRefs: list(value.criticalSourceRefs).map(normalizeSourceRef),
  };
}

module.exports = {
  CONTEXT_DEPTHS,
  HARNESS_MODES,
  SCENE_GENERATION_MODES,
  VERIFICATION_LEVELS,
  normalizeChapterExitState,
  normalizeChapterContextBundle,
  normalizeConstraintAssertion,
  normalizeContextSpec,
  normalizeDiagnostic,
  normalizeDraftTrace,
  normalizeKnowledgeFact,
  normalizeModelCallTrace,
  normalizeRiskProfile,
  normalizeSourceUsageEvidence,
  normalizeUsage,
  normalizeVerifiedStateDelta,
  normalizeResolvedChapterTarget,
  normalizeSceneContract,
  normalizeSourceRef,
};
