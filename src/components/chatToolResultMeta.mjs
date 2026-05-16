function tryParseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return { ...metadata };
}

function normalizeChangedFile(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const chapterName = typeof entry.chapterName === 'string' && entry.chapterName ? entry.chapterName : '';
  const label = typeof entry.label === 'string' && entry.label ? entry.label : (chapterName || '未命名内容');
  return {
    kind: entry.kind === 'chapter' ? 'chapter' : 'unknown',
    novelId: typeof entry.novelId === 'string' && entry.novelId ? entry.novelId : null,
    chapterName: chapterName || null,
    label,
    beforeContent: typeof entry.beforeContent === 'string' ? entry.beforeContent : '',
    afterContent: typeof entry.afterContent === 'string' ? entry.afterContent : '',
    beforeMetadata: normalizeMetadata(entry.beforeMetadata),
    afterMetadata: normalizeMetadata(entry.afterMetadata),
    restoreMode: entry.restoreMode === 'delete' ? 'delete' : 'write',
  };
}

function normalizeCheckpoint(entry) {
  const file = normalizeChangedFile(entry);
  if (!file || file.kind !== 'chapter' || !file.chapterName || !file.novelId) return null;
  return {
    ...file,
    source: typeof entry.source === 'string' && entry.source ? entry.source : 'unknown',
  };
}

export function parseToolResultMeta(resultText) {
  const payload = tryParseJsonObject(resultText);
  const changedFiles = Array.isArray(payload?.changedFiles)
    ? payload.changedFiles.map(normalizeChangedFile).filter(Boolean)
    : [];
  const checkpoint = normalizeCheckpoint(payload?.checkpoint);
  const summary = typeof payload?.message === 'string' && payload.message
    ? payload.message
    : typeof payload?.text === 'string' && payload.text
      ? payload.text
      : typeof resultText === 'string'
        ? resultText
        : '';
  return {
    payload,
    summary,
    changedFiles,
    checkpoint,
  };
}
