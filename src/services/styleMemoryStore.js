const KEY = 'mana-style-memory-v1';
const THRESHOLD_KEY = 'mana-style-memory-threshold-v1';
const ARCHIVE_KEY = 'mana-style-memory-archive-v1';
const DEFAULT_THRESHOLD = 12000;
const MAX_ARCHIVE_ITEMS = 30;

function getPromptFn() {
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    return window.prompt.bind(window);
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.prompt === 'function') {
    return globalThis.prompt.bind(globalThis);
  }
  return null;
}

/**
 * @returns {string}
 */
export function loadStyleMemory() {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * @returns {number}
 */
export function loadMemoryThreshold() {
  try {
    const raw = localStorage.getItem(THRESHOLD_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

/**
 * @param {number} threshold
 */
function saveMemoryThreshold(threshold) {
  try {
    localStorage.setItem(THRESHOLD_KEY, String(threshold));
  } catch {
    /* ignore */
  }
}

/**
 * @returns {Array<{ timestamp: string, length: number, reason: string, content: string }>}
 */
export function loadStyleMemoryArchive() {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} reason
 * @param {string} content
 */
function pushArchive(reason, content) {
  const nextItem = {
    timestamp: new Date().toISOString(),
    length: content.length,
    reason,
    content,
  };
  const archive = loadStyleMemoryArchive();
  const nextArchive = [nextItem, ...archive].slice(0, MAX_ARCHIVE_ITEMS);
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(nextArchive));
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function shorten(text, max) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {string} text
 * @param {number} threshold
 * @returns {string}
 */
function buildCompressedSummary(text, threshold) {
  const blocks = text
    .split(/\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const early = blocks.slice(0, 4).map((b, i) => `- 早期要点 ${i + 1}: ${shorten(b, 120)}`);
  const recent = blocks
    .slice(Math.max(0, blocks.length - 6))
    .map((b, i) => `- 最近片段 ${i + 1}: ${shorten(b, 220)}`);
  const assembled = [
    '# 文风记忆压缩摘要',
    `- 原始长度: ${text.length}`,
    `- 压缩时间: ${new Date().toISOString()}`,
    '',
    '## 早期记忆摘要',
    ...(early.length > 0 ? early : ['- 无']),
    '',
    '## 最近记忆保留',
    ...(recent.length > 0 ? recent : ['- 无']),
  ].join('\n');

  if (assembled.length <= threshold) return assembled;
  return assembled.slice(0, Math.max(0, threshold - 1)) + '…';
}

/**
 * @param {string} text
 * @param {number} threshold
 * @returns {string}
 */
function keepTailWithinThreshold(text, threshold) {
  if (text.length <= threshold) return text;
  const marker = '# 文风记忆（拆章后保留最近上下文）\n\n';
  const budget = Math.max(500, threshold - marker.length);
  const tail = text.slice(-budget).trim();
  return `${marker}${tail}`;
}

/**
 * @param {number} nextLength
 * @param {number} threshold
 * @returns {'compress' | 'split' | 'raise' | 'expand' | 'cancel'}
 */
function askOverflowAction(nextLength, threshold) {
  const promptFn = getPromptFn();
  if (!promptFn) {
    // 无法弹窗询问时，保守处理为取消，避免在未确认时隐式扩张记忆。
    return 'cancel';
  }
  const message = [
    '文风记忆过长，需要你的选择：',
    `当前长度: ${nextLength} 字符`,
    `当前阈值: ${threshold} 字符`,
    '',
    '1 = 压缩摘要',
    '2 = 拆章存档（保留最近上下文）',
    '3 = 调高阈值',
    '4 = 允许继续扩张本次记忆',
    '取消 = 不保存本次变更',
  ].join('\n');
  const raw = promptFn(message, '1');
  if (raw === null) return 'cancel';
  const choice = raw.trim();
  if (choice === '1') return 'compress';
  if (choice === '2') return 'split';
  if (choice === '3') return 'raise';
  if (choice === '4') return 'expand';
  return 'cancel';
}

/**
 * @param {string} prevText
 * @param {string} nextText
 * @returns {{ saved: boolean, action: 'normal' | 'compress' | 'split' | 'raise' | 'expand' | 'cancel', text: string, threshold: number }}
 */
function resolveMemoryOverflow(prevText, nextText) {
  const threshold = loadMemoryThreshold();
  if (nextText.length <= threshold) {
    return { saved: true, action: 'normal', text: nextText, threshold };
  }

  const action = askOverflowAction(nextText.length, threshold);
  if (action === 'cancel') {
    return { saved: false, action: 'cancel', text: prevText, threshold };
  }

  if (action === 'compress') {
    pushArchive('compress-source', nextText);
    const compressed = buildCompressedSummary(nextText, threshold);
    return { saved: true, action, text: compressed, threshold };
  }

  if (action === 'split') {
    pushArchive('split-source', nextText);
    const trimmed = keepTailWithinThreshold(nextText, threshold);
    return { saved: true, action, text: trimmed, threshold };
  }

  if (action === 'raise') {
    const promptFn = getPromptFn();
    const suggested = Math.max(nextText.length, Math.round(threshold * 1.5));
    const raw =
      promptFn?.(
        `请输入新的记忆阈值（建议 >= ${suggested}，当前 ${threshold}）：`,
        String(suggested)
      ) ?? null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= threshold) {
      return { saved: false, action: 'cancel', text: prevText, threshold };
    }
    saveMemoryThreshold(parsed);
    return { saved: true, action, text: nextText, threshold: parsed };
  }

  // expand：仅本次允许扩张，不改阈值。
  return { saved: true, action, text: nextText, threshold };
}

/**
 * @param {string} text
 * @returns {{ saved: boolean, action: 'normal' | 'compress' | 'split' | 'raise' | 'expand' | 'cancel', length: number, threshold: number }}
 */
export function saveStyleMemory(text) {
  const nextText = String(text ?? '');
  const prevText = loadStyleMemory();
  const result = resolveMemoryOverflow(prevText, nextText);
  if (!result.saved) {
    return {
      saved: false,
      action: result.action,
      length: prevText.length,
      threshold: result.threshold,
    };
  }
  try {
    localStorage.setItem(KEY, result.text);
  } catch {
    return {
      saved: false,
      action: 'cancel',
      length: prevText.length,
      threshold: result.threshold,
    };
  }
  return {
    saved: true,
    action: result.action,
    length: result.text.length,
    threshold: result.threshold,
  };
}

/**
 * @param {string} patch
 * @returns {{ saved: boolean, action: 'normal' | 'compress' | 'split' | 'raise' | 'expand' | 'cancel', length: number, threshold: number }}
 */
export function appendStyleMemory(patch) {
  const cur = loadStyleMemory();
  const next = cur ? `${cur.trim()}\n\n${String(patch ?? '').trim()}` : String(patch ?? '').trim();
  return saveStyleMemory(next);
}
