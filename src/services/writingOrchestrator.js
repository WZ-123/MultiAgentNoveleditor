import { createId } from '@/domain/ids.js';
import { joinParagraphs, splitIntoParagraphs } from '@/domain/text.js';
import { WRITING_PHASE } from '@/domain/types.js';
import {
  AGENT4_SYSTEM,
  AGENT5_SYSTEM,
  AGENT6_SYSTEM,
  CHAPTER_DRAFT_SYSTEM,
} from '@/services/agentPrompts.js';
import { parseJsonFromModelText } from '@/services/llmJson.js';
import { buildQualityReviewPayload, detectCrossParagraphQualityAnnotations } from '@/services/qualityReview.mjs';
import { createRemoteAIClient } from '@/services/remoteAI.js';
import { appendStyleMemory, loadStyleMemory } from '@/services/styleMemoryStore.js';

/**
 * @typedef {import('@/domain/types.js').WritingRequirements} WritingRequirements
 * @typedef {import('@/domain/types.js').ParagraphRef} ParagraphRef
 * @typedef {import('@/domain/types.js').StyleAnnotation} StyleAnnotation
 * @typedef {import('@/domain/types.js').QualityAnnotation} QualityAnnotation
 */

/**
 * @typedef {Object} WritingSessionState
 * @property {import('@/domain/types.js').WritingPhase} phase
 * @property {WritingRequirements | null} requirements
 * @property {string} outlineMarkdown
 * @property {import('@/domain/types.js').HierarchicalWritingContext|null} hierarchicalContext
 * @property {string|null} characterContext - 自动装配的角色上下文 JSON 字符串（AB混用的A方案）
 * @property {string} draftText
 * @property {ParagraphRef[]} paragraphs
 * @property {StyleAnnotation[]} styleAnnotations
 * @property {QualityAnnotation[]} qualityAnnotations
 * @property {Set<string>} qualityResolvedIds
 * @property {import('@/domain/types.js').PeekSession | null} peek
 * @property {string | null} agent6Summary
 * @property {string | null} agent6Supplement
 * @property {string | null} lastError
 */

/**
 * @param {string} outlineMarkdown
 * @returns {WritingSessionState}
 */
/**
 * @param {string} outlineMarkdown - 大纲 Markdown 文本
 * @param {import('@/domain/types.js').HierarchicalWritingContext} [hierarchicalContext] - 层级大纲上下文（可选）
 * @returns {WritingSessionState}
 */
export function createWritingSession(outlineMarkdown, hierarchicalContext, characterContext) {
  return {
    phase: WRITING_PHASE.IDLE,
    requirements: null,
    outlineMarkdown,
    hierarchicalContext: hierarchicalContext || null,
    characterContext: characterContext || null,
    draftText: '',
    paragraphs: [],
    styleAnnotations: [],
    qualityAnnotations: [],
    qualityResolvedIds: new Set(),
    peek: null,
    agent6Summary: null,
    agent6Supplement: null,
    lastError: null,
  };
}

/**
 * 从层级大纲读取指定章的大纲 Markdown 创建写作会话。
 * 注意：需调用方（UI/WorkflowPanel）通过 IPC 读取章大纲文件后传入 outlineMarkdown。
 * @param {string} chapterOutlineMarkdown - 章大纲 Markdown（从 outlines/volume-XXX/section-YYY/chapter-ZZZ.md 读取）
 * @param {HierarchicalWritingContext} context - 层级定位信息
 * @returns {WritingSessionState}
 */
export function createWritingSessionFromChapter(chapterOutlineMarkdown, context, characterContext) {
  return {
    phase: WRITING_PHASE.IDLE,
    requirements: null,
    outlineMarkdown: chapterOutlineMarkdown,
    hierarchicalContext: context,
    characterContext: characterContext || null,
    draftText: '',
    paragraphs: [],
    styleAnnotations: [],
    qualityAnnotations: [],
    qualityResolvedIds: new Set(),
    peek: null,
    agent6Summary: null,
    agent6Supplement: null,
    lastError: null,
  };
}

/**
 * @param {WritingSessionState} state
 * @param {WritingRequirements} requirements
 */
export function setWritingRequirements(state, requirements) {
  return { ...state, phase: WRITING_PHASE.REQUIREMENTS, requirements };
}

/**
 * @param {WritingSessionState} state
 */
export async function generateRemoteDraft(state) {
  const client = createRemoteAIClient();
  const style = loadStyleMemory();
  try {
    const userMsg = {
      outline: state.outlineMarkdown,
      requirements: state.requirements,
      styleMemory: style,
    };
    // 注入自动装配的角色上下文（AB混用A方案）
    if (state.characterContext) {
      userMsg.characterContext = state.characterContext;
    }
    const json = await client.completeForAgent(
      'chapter_draft',
      [
        { role: 'system', content: CHAPTER_DRAFT_SYSTEM },
        { role: 'user', content: JSON.stringify(userMsg) },
      ],
      { expectJson: true }
    );
    let draftText = json;
    try {
      const parsed = parseJsonFromModelText(json);
      draftText = typeof parsed.text === 'string' ? parsed.text : json;
    } catch {
      draftText = json;
    }
    const paragraphs = splitIntoParagraphs(draftText);
    return {
      ...state,
      phase: WRITING_PHASE.REMOTE_DRAFT,
      draftText,
      paragraphs,
      lastError: null,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...state, lastError: err };
  }
}

/**
 * @param {ParagraphRef[]} paragraphs
 * @param {unknown[]} raw
 * @returns {import('@/domain/types.js').StyleAnnotation[]}
 */
function normalizeStyleAnnotations(paragraphs, raw) {
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const a of raw) {
    const pid = String(a.paragraphId ?? '');
    const p = byId.get(pid);
    if (!p) continue;
    const len = p.text.length;
    let start = Math.max(0, Math.min(Number(a.start) || 0, len));
    let end = Math.max(0, Math.min(Number(a.end) ?? len, len));
    if (end < start) [start, end] = [end, start];
    out.push({
      id: createId('st'),
      paragraphId: p.id,
      start,
      end,
      reason: String(a.reason ?? ''),
    });
  }
  return out;
}

/**
 * @param {ParagraphRef[]} paragraphs
 * @param {unknown[]} raw
 * @returns {import('@/domain/types.js').QualityAnnotation[]}
 */
function normalizeQualityAnnotations(paragraphs, raw) {
  const ids = new Set(paragraphs.map((p) => p.id));
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const a of raw) {
    const paragraphIds = Array.isArray(a.paragraphIds)
      ? a.paragraphIds.map((pid) => String(pid || '')).filter((pid) => ids.has(pid))
      : [];
    const fallbackId = String(a.paragraphId ?? '');
    const targets = paragraphIds.length > 0
      ? paragraphIds
      : ids.has(fallbackId)
        ? [fallbackId]
        : [];
    for (const paragraphId of targets) {
      out.push({
        id: createId('ql'),
        paragraphId,
        kind: String(a.kind ?? 'other'),
        note: String(a.note ?? ''),
      });
    }
  }
  return out;
}

function mergeQualityAnnotations(primary, fallback) {
  const out = [];
  const seen = new Set();
  for (const annotation of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])]) {
    const key = `${annotation.paragraphId}::${annotation.kind}::${annotation.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(annotation);
  }
  return out;
}

/**
 * @param {WritingSessionState} state
 */
export async function runAgent4Style(state) {
  const client = createRemoteAIClient();
  const style = loadStyleMemory();
  if (state.paragraphs.length === 0) {
    return {
      ...state,
      phase: WRITING_PHASE.AGENT4,
      styleAnnotations: [],
    };
  }
  try {
    const raw = await client.completeForAgent(
      'agent4',
      [
        { role: 'system', content: AGENT4_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            styleMemory: style,
            paragraphs: state.paragraphs.map((p) => ({
              id: p.id,
              index: p.index,
              text: p.text,
            })),
          }),
        },
      ],
      { expectJson: true }
    );
    const data = parseJsonFromModelText(raw);
    const styleAnnotations = normalizeStyleAnnotations(
      state.paragraphs,
      data.annotations
    );
    return {
      ...state,
      phase: WRITING_PHASE.AGENT4,
      styleAnnotations,
      lastError: null,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...state, lastError: err };
  }
}

/**
 * @param {WritingSessionState} state
 * @param {string} annotationId
 * @param {import('@/domain/types.js').StyleUserAction} action
 * @param {string} [patch]
 */
export function applyStyleAction(state, annotationId, action, patch) {
  const ann = state.styleAnnotations.find((a) => a.id === annotationId);
  if (!ann) return state;
  let styleAnnotations = state.styleAnnotations.filter((a) => a.id !== annotationId);
  let paragraphs = state.paragraphs;

  if (action === 'unify_style') {
    const para = paragraphs.find((p) => p.id === ann.paragraphId);
    if (para) {
      const unified = `（文风已统一）${para.text}`;
      paragraphs = paragraphs.map((p) =>
        p.id === ann.paragraphId ? { ...p, text: unified } : p
      );
    }
  } else if (action === 'update_style_memory') {
    appendStyleMemory(patch ?? `例外：段落 ${ann.paragraphId} 采用口语化节奏。`);
  }

  return {
    ...state,
    paragraphs,
    styleAnnotations,
    draftText: joinParagraphs(paragraphs),
  };
}

/**
 * @param {WritingSessionState} state
 */
export async function runAgent5Quality(state) {
  const client = createRemoteAIClient();
  if (state.paragraphs.length === 0) {
    return {
      ...state,
      phase: WRITING_PHASE.AGENT5,
      qualityAnnotations: [],
    };
  }
  try {
    const raw = await client.completeForAgent(
      'agent5',
      [
        { role: 'system', content: AGENT5_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify(buildQualityReviewPayload(state.paragraphs)),
        },
      ],
      { expectJson: true }
    );
    const data = parseJsonFromModelText(raw);
    const modelAnnotations = normalizeQualityAnnotations(state.paragraphs, data.annotations);
    const crossParagraphAnnotations = detectCrossParagraphQualityAnnotations(state.paragraphs)
      .map((annotation) => ({ ...annotation, id: createId('ql') }));
    const qualityAnnotations = mergeQualityAnnotations(modelAnnotations, crossParagraphAnnotations);
    return {
      ...state,
      phase: WRITING_PHASE.AGENT5,
      qualityAnnotations,
      lastError: null,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...state, lastError: err };
  }
}

/**
 * @param {WritingSessionState} state
 * @param {string} paragraphId
 * @param {import('@/domain/types.js').QualityUserChoice} choice
 */
export function applyQualityChoice(state, paragraphId, choice) {
  if (choice === 'keep') {
    const next = new Set(state.qualityResolvedIds);
    next.add(paragraphId);
    return { ...state, qualityResolvedIds: next };
  }
  const para = state.paragraphs.find((p) => p.id === paragraphId);
  return {
    ...state,
    peek: {
      paragraphId,
      original: para?.text ?? '',
      candidate: '',
      status: 'pending',
    },
  };
}

/**
 * @param {WritingSessionState} state
 * @param {string} paragraphId
 */
export async function requestPeekRewrite(state, paragraphId) {
  const client = createRemoteAIClient();
  const para = state.paragraphs.find((p) => p.id === paragraphId);
  if (!para) return state;
  try {
    const text = await client.completeForAgent(
      'agent5',
      [
        { role: 'system', content: '重写下列段落，保持剧情，提升流畅度。避免「不是……，也不是……，而是……」与「不是……，不是……，是」这类 AI 套句；也不要写成「然后她笑了。」「然后他沉默了。」这种独立短反应句，更不要下一句再用「那是一个……」「那是一种……」去解释。能直叙就直叙，若确实需要保留转折，可改成「并非……抑或……而是……」。若输出为简体中文小说正文，标点必须使用全角中文标点（，。！？：；、“”‘’（）《》——），不要使用半角英文标点。只输出改写后的正文，不要解释。' },
        { role: 'user', content: para.text },
      ],
      { expectJson: false }
    );
    return {
      ...state,
      peek: {
        paragraphId,
        original: para.text,
        candidate: text,
        status: 'idle',
      },
      lastError: null,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...state, lastError: err };
  }
}

/**
 * @param {WritingSessionState} state
 * @param {'accept' | 'again' | 'discard'} action
 */
export function resolvePeek(state, action) {
  if (!state.peek) return state;
  if (action === 'discard') {
    return { ...state, peek: null };
  }
  if (action === 'again') {
    return { ...state, peek: { ...state.peek, status: 'pending' } };
  }
  const { paragraphId, candidate } = state.peek;
  const paragraphs = state.paragraphs.map((p) =>
    p.id === paragraphId ? { ...p, text: candidate } : p
  );
  return {
    ...state,
    paragraphs,
    draftText: joinParagraphs(paragraphs),
    peek: null,
  };
}

/**
 * @param {WritingSessionState} state
 */
export async function bulkRewriteUnresolved(state) {
  const client = createRemoteAIClient();
  const unresolved = state.qualityAnnotations.filter(
    (a) => !state.qualityResolvedIds.has(a.paragraphId)
  );
  const byPara = new Set(unresolved.map((a) => a.paragraphId));
  const nextParagraphs = [];
  for (const p of state.paragraphs) {
    if (!byPara.has(p.id)) {
      nextParagraphs.push(p);
      continue;
    }
    const text = await client.completeForAgent(
      'agent5',
      [
        {
          role: 'system',
          content: '重写下列段落：保持情节不变，提升流畅度。若输出为简体中文小说正文，标点必须使用全角中文标点（，。！？：；、“”‘’（）《》——），不要使用半角英文标点。只输出正文。',
        },
        { role: 'user', content: p.text },
      ],
      { expectJson: false }
    );
    nextParagraphs.push({ ...p, text });
  }
  return {
    ...state,
    paragraphs: nextParagraphs,
    draftText: joinParagraphs(nextParagraphs),
    qualityAnnotations: [],
  };
}

/**
 * @param {WritingSessionState} state
 */
export function markReadyToSave(state) {
  return { ...state, phase: WRITING_PHASE.READY_TO_SAVE };
}

/**
 * @param {WritingSessionState} state
 */
export function bulkKeepAllQuality(state) {
  const ids = new Set(state.qualityResolvedIds);
  state.qualityAnnotations.forEach((a) => ids.add(a.paragraphId));
  return { ...state, qualityResolvedIds: ids };
}

/**
 * @param {WritingSessionState} state
 */
export async function runAgent6ChapterSave(state) {
  const client = createRemoteAIClient();
  try {
    const raw = await client.completeForAgent(
      'agent6',
      [
        { role: 'system', content: AGENT6_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            outline: state.outlineMarkdown,
            paragraphCount: state.paragraphs.length,
            chapterText: joinParagraphs(state.paragraphs),
          }),
        },
      ],
      { expectJson: true }
    );
    const data = parseJsonFromModelText(raw);
    const summary =
      typeof data.summary === 'string' ? data.summary : '（无摘要）';
    const supplementMarkdown =
      typeof data.supplementMarkdown === 'string'
        ? data.supplementMarkdown
        : '';
    return {
      ...state,
      phase: WRITING_PHASE.AGENT6,
      agent6Summary: summary,
      agent6Supplement: supplementMarkdown,
      lastError: null,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...state, lastError: err };
  }
}

/**
 * @param {WritingSessionState} state
 */
export function finalizeChapter(state) {
  return { ...state, phase: WRITING_PHASE.DONE };
}

/**
 * 从 OutlineArtifact 的大纲节点中收集所有出现的角色ID，
 * 逐一读取角色卡，构建精简的角色上下文摘要字符串。
 * 这是 AB 混用中 A 方案（自动装配）的实现。
 * @param {import('@/domain/types.js').OutlineArtifact} artifact
 * @param {(id: string) => Promise<import('@/domain/types.js').Character|null>} readCharacter - 读取角色卡的异步函数（通过 IPC 调用 main process）
 * @returns {Promise<string|null>} JSON 字符串或 null
 */
export async function buildCharacterContextFromArtifact(artifact, readCharacter) {
  if (!artifact?.nodes?.length) return null;
  const ids = new Set();
  for (const n of artifact.nodes) {
    if (Array.isArray(n.characters)) {
      for (const cid of n.characters) ids.add(cid);
    }
  }
  if (ids.size === 0) return null;

  const profiles = [];
  for (const id of ids) {
    try {
      const ch = await readCharacter(id);
      if (!ch) continue;
      const p = {
        id: ch.id,
        name: ch.name,
        role: ch.role,
        faction: ch.faction,
        appearance: ch.appearance ? (ch.appearance.length > 300 ? ch.appearance.slice(0, 300) + '…' : ch.appearance) : undefined,
        personality: ch.personality ? (ch.personality.length > 200 ? ch.personality.slice(0, 200) + '…' : ch.personality) : undefined,
        hairColor: ch.hairColor,
        eyeColor: ch.eyeColor,
        height: ch.height,
        moeTraits: ch.moeTraits,
        quotes: ch.quotes,
      };
      profiles.push(p);
    } catch { /* skip unreadable */ }
  }
  if (profiles.length === 0) return null;
  return JSON.stringify(profiles, null, 2);
}
