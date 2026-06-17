const DEFAULT_MAX_LINES = 3;
const DEFAULT_MAX_CHARS = 220;

function splitLines(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/);
}

function pluralLine(count) {
  return `${count} 行`;
}

function lineRangeLabel(startIndex, count) {
  if (count <= 0) return '';
  const startLine = startIndex + 1;
  const endLine = startIndex + count;
  return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`;
}

export function compactChangeSnippet(lines, options = {}) {
  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const visibleLines = (lines || [])
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, maxLines);
  let text = visibleLines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}...`;
  if ((lines || []).filter((line) => String(line || '').trim()).length > visibleLines.length) {
    text = `${text}${text ? '\n' : ''}...`;
  }
  return text;
}

export function buildChapterChangePreview(beforeContent, afterContent) {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);

  if (beforeLines.join('\n') === afterLines.join('\n')) {
    return {
      summary: '内容无变化',
      beforeSnippet: '',
      afterSnippet: '',
    };
  }

  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedLines = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedLines = afterLines.slice(prefix, afterLines.length - suffix);
  const removedCount = removedLines.length;
  const addedCount = addedLines.length;

  let summary;
  if (beforeLines.length === 0 && afterLines.length > 0) {
    summary = `新建章节：新增 ${pluralLine(afterLines.length)}`;
  } else if (beforeLines.length > 0 && afterLines.length === 0) {
    summary = `删除章节：移除 ${pluralLine(beforeLines.length)}`;
  } else if (removedCount > 0 && addedCount > 0) {
    const range = lineRangeLabel(prefix, Math.max(removedCount, addedCount));
    summary = `${range}：改写 ${pluralLine(removedCount)}，变为 ${pluralLine(addedCount)}`;
  } else if (addedCount > 0) {
    const range = lineRangeLabel(prefix, addedCount);
    summary = `${range}：新增 ${pluralLine(addedCount)}`;
  } else {
    const range = lineRangeLabel(prefix, removedCount);
    summary = `${range}：删除 ${pluralLine(removedCount)}`;
  }

  return {
    summary,
    beforeSnippet: compactChangeSnippet(removedLines),
    afterSnippet: compactChangeSnippet(addedLines),
    removedCount,
    addedCount,
  };
}
