'use strict';

const { normalizeResolvedChapterTarget } = require('../../domain/chapterHarness.cjs');
const { parseJsonText } = require('./jsonText');

const CHINESE_DIGITS = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};

const CHINESE_UNITS = { '十': 10, '百': 100, '千': 1000 };

function parseToolText(result) {
  return Array.isArray(result?.content)
    ? result.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
    : (typeof result === 'string' ? result : JSON.stringify(result || {}));
}

function parseToolJson(result) {
  const raw = parseToolText(result).trim();
  if (!raw) return null;
  try { return parseJsonText(raw); } catch { return null; }
}

function chineseNumberToInteger(value) {
  const normalized = String(value || '').normalize('NFKC').trim();
  if (!normalized) return null;
  if (/^\d+$/u.test(normalized)) return Number(normalized);
  if (!/^[零〇一二两三四五六七八九十百千]+$/u.test(normalized)) return null;
  if (!/[十百千]/u.test(normalized)) {
    return Number(Array.from(normalized).map((char) => CHINESE_DIGITS[char]).join(''));
  }
  let total = 0;
  let digit = 0;
  let sawValue = false;
  for (const char of normalized) {
    if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, char)) {
      digit = CHINESE_DIGITS[char];
      sawValue = true;
      continue;
    }
    const unit = CHINESE_UNITS[char];
    if (!unit) return null;
    total += (digit || 1) * unit;
    digit = 0;
    sawValue = true;
  }
  return sawValue ? total + digit : null;
}

function extractExplicitChapterTarget(userText) {
  const normalized = String(userText || '').normalize('NFKC');
  const withOrdinalMarker = /第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*章(?:\s*[:：]\s*([^\n，。！？]+))?/u.exec(normalized);
  const bareOrdinal = /(?:^|[^\p{L}\p{N}])([0-9零〇一二两三四五六七八九十百千]+)\s*章(?:\s*[:：]\s*([^\n，。！？]+))?/u.exec(normalized);
  const match = withOrdinalMarker || bareOrdinal;
  if (!match) return null;
  const ordinal = chineseNumberToInteger(match[1]);
  if (!Number.isInteger(ordinal) || ordinal <= 0) return null;
  return {
    ordinal,
    raw: match[0].trim(),
    titleHint: String(match[2] || '').trim(),
  };
}

function targetName(value) {
  return String(value?.name || value?.fileName || '').trim();
}

function sameTarget(left, right) {
  const leftName = targetName(left);
  const rightName = targetName(right);
  return !!leftName && !!rightName && leftName === rightName;
}

function targetFromDraft(draft, source) {
  if (!targetName(draft)) return null;
  return normalizeResolvedChapterTarget({
    name: targetName(draft),
    displayName: draft.displayName || draft.title || targetName(draft),
    titleHint: draft.title || draft.displayName || targetName(draft),
    source,
    existing: !!draft.baseContent,
  });
}

function findEditorTarget(editorContext, displays) {
  if (editorContext?.type !== 'chapter') return null;
  const candidates = [editorContext.name, editorContext.fileName, editorContext.chapterFileName, editorContext.title]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  for (const item of displays) {
    if (candidates.includes(targetName(item)) || candidates.includes(String(item.displayName || '').trim())) {
      return normalizeResolvedChapterTarget({
        ...item,
        name: targetName(item),
        source: 'editor',
        existing: true,
      });
    }
  }
  const fileName = candidates.find((item) => /\.md$/iu.test(item));
  return fileName ? normalizeResolvedChapterTarget({ name: fileName, displayName: editorContext.title || fileName, source: 'editor', existing: true }) : null;
}

function blocked(code, message, diagnostics = []) {
  return normalizeResolvedChapterTarget({
    status: 'blocked',
    diagnostics: [{ code, severity: 'blocking', message }, ...diagnostics],
  });
}

async function callJson(callTool, name, args = {}) {
  const result = await callTool({ name, arguments: args, autoConfirm: true });
  if (result?.isError) throw new Error(parseToolText(result) || `${name} failed`);
  return parseToolJson(result);
}

async function resolveExplicitTarget(explicit, displays, callTool) {
  const existing = displays.find((item, index) => Number(item?.seq || index + 1) === explicit.ordinal);
  if (existing) {
    return normalizeResolvedChapterTarget({
      ...existing,
      name: targetName(existing),
      ordinal: explicit.ordinal,
      titleHint: explicit.titleHint || existing.displayName || targetName(existing),
      source: 'explicit_existing',
      existing: true,
    });
  }

  const outlinePayload = await callJson(callTool, 'read_outline_nodes', {}).catch(() => ({ nodes: [] }));
  const outlineNodes = Array.isArray(outlinePayload?.nodes) ? outlinePayload.nodes : [];
  const outlineNode = outlineNodes.find((node) => Number(node?.chapterIndex) === explicit.ordinal);
  const outlineRef = String(outlineNode?.chapterRef || outlineNode?.writtenChapterRef || '').trim();
  if (outlineRef) {
    return normalizeResolvedChapterTarget({
      name: outlineRef,
      displayName: outlineNode.title || `第${explicit.ordinal}章`,
      titleHint: explicit.titleHint || outlineNode.title || `第${explicit.ordinal}章`,
      ordinal: explicit.ordinal,
      source: 'explicit_outline',
      existing: displays.some((item) => targetName(item) === outlineRef),
    });
  }

  if (explicit.ordinal === displays.length + 1) {
    const suggested = await callJson(callTool, 'suggest_next_chapter_name', {});
    return normalizeResolvedChapterTarget({
      name: suggested?.fileName || 'chapter-draft.md',
      displayName: suggested?.displayName || `第${explicit.ordinal}章`,
      titleHint: explicit.titleHint || outlineNode?.title || suggested?.displayName || `第${explicit.ordinal}章`,
      ordinal: explicit.ordinal,
      source: outlineNode ? 'explicit_next_outline' : 'explicit_next',
      existing: false,
    });
  }

  return blocked(
    'chapter_target_unresolved',
    `无法安全确定第${explicit.ordinal}章对应的章节文件。请先在大纲节点中设置 chapterRef，或先补齐前序章节。`
  );
}

async function resolveChapterTarget({ mode, userText, pendingChapterDraft, editorContext, callTool }) {
  if (typeof callTool !== 'function') throw new Error('resolveChapterTarget requires callTool');
  let displays;
  try {
    const payload = await callJson(callTool, 'list_chapter_displays', {});
    displays = Array.isArray(payload) ? payload : [];
  } catch (err) {
    return blocked('chapter_display_lookup_failed', `读取章节显示顺序失败：${err?.message || String(err)}`);
  }

  const explicit = extractExplicitChapterTarget(userText);
  const pendingTarget = targetFromDraft(pendingChapterDraft, 'pending_draft');
  const editorTarget = findEditorTarget(editorContext, displays);
  let explicitTarget = null;
  if (explicit) {
    try {
      explicitTarget = await resolveExplicitTarget(explicit, displays, callTool);
    } catch (err) {
      return blocked('chapter_target_lookup_failed', `解析目标章节失败：${err?.message || String(err)}`);
    }
    if (explicitTarget.status === 'blocked') return explicitTarget;
  }

  if (mode === 'revise') {
    const boundTarget = pendingTarget || editorTarget;
    if (!boundTarget) return blocked('revision_target_missing', '修订模式没有绑定章节草稿或当前编辑章节。');
    if (explicitTarget && !sameTarget(explicitTarget, boundTarget)) {
      return blocked('revision_target_conflict', `修订对象是“${boundTarget.displayName}”，但请求指定了“${explicitTarget.displayName}”。请先明确要修订哪一章。`);
    }
    return normalizeResolvedChapterTarget({ ...boundTarget, ordinal: explicit?.ordinal ?? boundTarget.ordinal });
  }

  if (pendingTarget) {
    if (explicitTarget && !sameTarget(explicitTarget, pendingTarget)) {
      return blocked('pending_draft_target_conflict', `当前仍有“${pendingTarget.displayName}”草稿待确认，不能静默改写为“${explicitTarget.displayName}”。请先保存或放弃当前草稿。`);
    }
    return explicitTarget || pendingTarget;
  }
  if (explicitTarget) return explicitTarget;
  if (editorTarget && !/下一章/u.test(String(userText || ''))) return editorTarget;

  try {
    const suggested = await callJson(callTool, 'suggest_next_chapter_name', {});
    return normalizeResolvedChapterTarget({
      name: suggested?.fileName || 'chapter-draft.md',
      displayName: suggested?.displayName || suggested?.fileName || '下一章',
      titleHint: suggested?.displayName || suggested?.fileName || '下一章',
      ordinal: Number.isInteger(Number(suggested?.seq)) ? Number(suggested.seq) : displays.length + 1,
      source: 'suggest_next',
      existing: false,
    });
  } catch (err) {
    return blocked('chapter_suggestion_failed', `无法确定下一章：${err?.message || String(err)}`);
  }
}

module.exports = {
  chineseNumberToInteger,
  extractExplicitChapterTarget,
  resolveChapterTarget,
};
