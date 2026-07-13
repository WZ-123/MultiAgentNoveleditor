'use strict';

const { normalizeVerifiedStateDelta } = require('../../domain/chapterHarness.cjs');
const { splitIntoParagraphs } = require('./chapterCharacterReview');
const { parseJsonText } = require('./jsonText');

const SYSTEM_PROMPT = `你是章节场景状态抽取器。你独立核对正文实际发生的状态变化，不采信 writer 的自我声明。
只输出 JSON：{"extracted":{},"discrepancies":[{"path":"字段路径","conflictType":"direct|absence|inference","comparisonSource":"deterministic_context|writer_declaration|inference","severity":"blocking|advisory","summary":"差异","confidence":0.0,"evidenceParagraphIds":["p-0"],"deterministicSourceRef":"可为空"}],"confidence":0.0,"evidenceParagraphIds":["p-0"],"sourceUsage":[{"sourceRef":"来源","usedFor":"用途","evidenceParagraphIds":["p-0"]}]}。
extracted 只记录本场景相对入场状态发生的增量，可包含 characters、assets、worldState、unresolvedThreads、events；不要复述正文，不要抄写整份入场状态。每个数组最多 8 项，每个字符串最多 80 字。sourceContext 给出关键来源及其内容；sourceUsage 必须列出正文实际体现且能由 evidenceParagraphIds 定位的关键 sourceRef。只有 comparisonSource=deterministic_context，且正文与确定性来源给出了可同时成立或不成立的相反事实时，conflictType 才能是 direct，且才可标 blocking。writer_declaration 仅表示 writer 的 stateDelta 与正文不一致，必须 advisory；应以正文抽取出的状态为准。来源未列出某个字段、正文没有明说、状态抽取无法确定、或仅凭常识推测，都必须标为 absence 或 inference，并且只能 advisory。不要把“缺少记录”当作“状态不存在”。不要输出 Markdown。`;

function shouldVerifyScene({ verificationLevel, riskLevel } = {}) {
  if (verificationLevel === 'strict') return true;
  if (verificationLevel === 'fast') return false;
  return riskLevel === 'high' || riskLevel === 'medium';
}

function normalizeDiscrepancies(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    path: String(item?.path || '').trim(),
    conflictType: ['direct', 'absence', 'inference'].includes(String(item?.conflictType || '').trim())
      ? String(item.conflictType).trim()
      : /(?:直接冲突|直接矛盾|相反事实|direct conflict|direct contradiction)/iu.test(String(item?.summary || item?.message || ''))
        ? 'direct'
        : 'inference',
    comparisonSource: ['deterministic_context', 'writer_declaration', 'inference'].includes(String(item?.comparisonSource || '').trim())
      ? String(item.comparisonSource).trim()
      : /(?:确定性来源|入场状态|场景硬约束|时间线|前章状态|deterministic context)/iu.test(String(item?.summary || item?.message || ''))
        ? 'deterministic_context'
        : 'inference',
    severity: item?.severity === 'blocking' ? 'blocking' : 'advisory',
    summary: String(item?.summary || item?.message || '').trim(),
    confidence: Number.isFinite(Number(item?.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0,
    evidenceParagraphIds: Array.isArray(item?.evidenceParagraphIds)
      ? item.evidenceParagraphIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
    deterministicSourceRef: String(item?.deterministicSourceRef || '').trim(),
  })).filter((item) => item.summary);
}

function knownDeterministicRefs({ sceneContract, entryState, sourceContext } = {}) {
  const refs = [
    ...(Array.isArray(sceneContract?.sourceRefs) ? sceneContract.sourceRefs : []),
    ...(Array.isArray(entryState?.sourceRefs) ? entryState.sourceRefs : []),
    ...(Array.isArray(sourceContext?.criticalSourceRefs) ? sourceContext.criticalSourceRefs : []),
  ];
  return new Set(refs
    .filter((item) => item?.deterministic !== false)
    .map((item) => String(item?.ref || item?.sourceRef || '').trim())
    .filter(Boolean));
}

function isBlockingDiscrepancy(discrepancy, deterministicRefs) {
  return discrepancy?.conflictType === 'direct'
    && discrepancy?.comparisonSource === 'deterministic_context'
    && discrepancy?.confidence >= 0.85
    && Array.isArray(discrepancy?.evidenceParagraphIds)
    && discrepancy.evidenceParagraphIds.length > 0
    && deterministicRefs.has(discrepancy?.deterministicSourceRef);
}

async function verifySceneState({ sceneDraft, sceneContract, entryState, sourceContext, modelRuntime, abortSignal } = {}) {
  const paragraphs = splitIntoParagraphs(sceneDraft?.text || '').map((paragraph) => ({ id: paragraph.id, text: paragraph.text }));
  const input = JSON.stringify({
    sceneId: sceneDraft?.sceneId || sceneContract?.sceneId || '',
    entryState: entryState || {},
    sceneContract: sceneContract || {},
    writerDeclared: sceneDraft?.stateDelta || {},
    sourceContext: sourceContext || {},
    paragraphs,
  }, null, 2);
  try {
    const result = await modelRuntime.invoke({
      subagentId: 'sa-harness-state-extractor',
      input,
      abortSignal,
      userLang: 'zh-CN',
      systemPromptOverride: SYSTEM_PROMPT,
    }, { role: 'state_extractor', promptVersion: 'scene-state-extractor-v4' });
    const raw = String(result?.output || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
    const parsed = parseJsonText(raw);
    const discrepancies = normalizeDiscrepancies(parsed?.discrepancies);
    const confidence = Number.isFinite(Number(parsed?.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0;
    const deterministicRefs = knownDeterministicRefs({ sceneContract, entryState, sourceContext });
    const reconciledDiscrepancies = discrepancies.map((item) => (
      isBlockingDiscrepancy(item, deterministicRefs)
        ? { ...item, severity: 'blocking' }
        : { ...item, severity: 'advisory' }
    ));
    const blocking = reconciledDiscrepancies.some((item) => item.severity === 'blocking');
    const extracted = parsed?.extracted && typeof parsed.extracted === 'object' ? parsed.extracted : {};
    return {
      verification: normalizeVerifiedStateDelta({
        sceneId: sceneDraft?.sceneId,
        writerDeclared: sceneDraft?.stateDelta || {},
        extracted,
        merged: confidence >= 0.7 ? extracted : sceneDraft?.stateDelta || {},
        discrepancies: reconciledDiscrepancies,
        confidence,
        evidenceParagraphIds: parsed?.evidenceParagraphIds || [],
        status: blocking ? 'blocking' : reconciledDiscrepancies.length ? 'warning' : 'verified',
      }),
      sourceUsage: Array.isArray(parsed?.sourceUsage) ? parsed.sourceUsage : [],
    };
  } catch (err) {
    return {
      verification: normalizeVerifiedStateDelta({
        sceneId: sceneDraft?.sceneId,
        writerDeclared: sceneDraft?.stateDelta || {},
        merged: sceneDraft?.stateDelta || {},
        discrepancies: [{ severity: 'advisory', summary: `独立状态抽取未完成：${err?.message || String(err)}`, confidence: 0 }],
        confidence: 0,
        status: 'warning',
      }),
      sourceUsage: [],
    };
  }
}

module.exports = {
  shouldVerifyScene,
  verifySceneState,
  _systemPrompt: SYSTEM_PROMPT,
  _testIsBlockingDiscrepancy: isBlockingDiscrepancy,
  _testKnownDeterministicRefs: knownDeterministicRefs,
};
