'use strict';

const { splitIntoParagraphs } = require('./chapterCharacterReview');
const { parseJsonText } = require('./jsonText');
const chapterConstraintValidator = require('./chapterConstraintValidator');

const SYSTEM_PROMPT = `你是章节逐约束独立验证器。你不采信 writer 的 constraintCoverage、sourceUsage 或自评结论，只依据 assertions 与正文段落逐条判定。
只输出 JSON：{"checks":[{"constraintId":"原样返回","status":"satisfied|violated|unclear","summary":"判定理由","confidence":0.0,"evidenceParagraphIds":["p-0"],"sourceRefs":["来源"]}]}。
必须为每个 assertion 输出且仅输出一条 check。satisfied/violated 都必须引用输入中真实存在的 paragraph id；无法定位或信息不足时输出 unclear。mustNotHappen 一类约束也要引用覆盖相关场景的段落作为核验范围。不要输出 severity，最终严重性由程序依据原 assertion 计算。不要 Markdown。`;

function normalizeModelChecks(parsed, assertions, paragraphs) {
  const paragraphIds = new Set(paragraphs.map((paragraph) => paragraph.id));
  const byConstraint = new Map();
  for (const item of Array.isArray(parsed?.checks) ? parsed.checks : []) {
    const constraintId = String(item?.constraintId || '').trim();
    if (!constraintId || byConstraint.has(constraintId)) continue;
    byConstraint.set(constraintId, item);
  }
  return assertions.map((assertion) => {
    const raw = byConstraint.get(assertion.constraintId);
    const rawStatus = String(raw?.status || '').trim();
    const suppliedIds = Array.isArray(raw?.evidenceParagraphIds)
      ? raw.evidenceParagraphIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const validEvidenceParagraphIds = suppliedIds.filter((id) => paragraphIds.has(id));
    const evidenceValid = validEvidenceParagraphIds.length > 0 && validEvidenceParagraphIds.length === suppliedIds.length;
    const status = raw && ['satisfied', 'violated', 'unclear'].includes(rawStatus) && (rawStatus === 'unclear' || evidenceValid)
      ? rawStatus
      : 'unclear';
    const severity = assertion.severity === 'blocking' && status !== 'satisfied' ? 'blocking' : 'advisory';
    return {
      constraintId: assertion.constraintId,
      sceneId: assertion.sceneId || '',
      status,
      severity,
      deterministic: assertion.deterministic === true,
      assertion: assertion.assertion || '',
      summary: String(raw?.summary || (!raw ? '验证器未返回该约束的判定。' : !evidenceValid && rawStatus !== 'unclear' ? '验证证据段落无效。' : '约束无法确定。')).trim(),
      confidence: Number.isFinite(Number(raw?.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
      sourceRefs: Array.isArray(assertion.sourceRefs)
        ? assertion.sourceRefs.map((source) => String(source?.ref || source?.sourceRef || source || '').trim()).filter(Boolean)
        : [],
      evidenceParagraphIds: validEvidenceParagraphIds,
      reviewIncomplete: status === 'unclear',
    };
  });
}

function checksToIssues(checks) {
  return (Array.isArray(checks) ? checks : [])
    .filter((check) => check.status !== 'satisfied')
    .map((check, index) => ({
      id: `constraint-${check.constraintId || index + 1}`,
      constraintId: check.constraintId,
      sceneId: check.sceneId || '',
      source: 'constraint_verifier',
      sourceAgent: 'constraint_verifier',
      category: 'constraint_verification',
      severity: check.severity,
      status: 'open',
      summary: check.summary || (check.status === 'violated' ? '正文违反章节约束。' : '章节约束尚未完成验证。'),
      note: check.assertion || '',
      evidence: (check.sourceRefs || []).join('、'),
      paragraphIds: check.evidenceParagraphIds || [],
      paragraphIndexes: [],
      reviewIncomplete: check.reviewIncomplete === true,
    }));
}

async function verifyChapterConstraints({ draft, assertions, modelRuntime, abortSignal } = {}) {
  const packet = chapterConstraintValidator.buildConstraintReviewPacket(draft, assertions || draft?.assertions || []);
  const normalizedAssertions = packet.assertions || [];
  const paragraphs = splitIntoParagraphs(draft?.text || '').map((paragraph) => ({ id: paragraph.id, text: paragraph.text }));
  if (!normalizedAssertions.length) {
    return { status: 'passed', checks: [], issues: [] };
  }
  try {
    const result = await modelRuntime.invoke({
      subagentId: 'sa-harness-state-extractor',
      input: JSON.stringify({ assertions: normalizedAssertions, scenes: packet.scenes || [], paragraphs }, null, 2),
      abortSignal,
      userLang: 'zh-CN',
      systemPromptOverride: SYSTEM_PROMPT,
    }, { role: 'constraint_verifier', promptVersion: 'chapter-constraint-verifier-v1' });
    const parsed = parseJsonText(String(result?.output || '').trim());
    const checks = normalizeModelChecks(parsed, normalizedAssertions, paragraphs);
    const issues = checksToIssues(checks);
    const blocked = issues.some((issue) => issue.severity === 'blocking');
    return { status: blocked ? 'blocked' : 'passed', checks, issues };
  } catch (err) {
    const checks = normalizedAssertions.map((assertion) => ({
      constraintId: assertion.constraintId,
      sceneId: assertion.sceneId || '',
      status: 'unclear',
      severity: assertion.severity === 'blocking' ? 'blocking' : 'advisory',
      deterministic: assertion.deterministic === true,
      assertion: assertion.assertion || '',
      summary: `独立约束验证未完成：${err?.message || String(err)}`,
      confidence: 0,
      sourceRefs: Array.isArray(assertion.sourceRefs) ? assertion.sourceRefs.map((source) => source?.ref || source).filter(Boolean) : [],
      evidenceParagraphIds: [],
      reviewIncomplete: true,
    }));
    return { status: 'blocked', checks, issues: checksToIssues(checks), error: err?.message || String(err) };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  checksToIssues,
  normalizeModelChecks,
  verifyChapterConstraints,
};
