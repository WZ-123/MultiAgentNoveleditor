export function normalizeThreadNovelId(novelId) {
  return novelId ? String(novelId) : '';
}

export function isThreadInNovel(thread, novelId) {
  return normalizeThreadNovelId(thread?.novelId) === normalizeThreadNovelId(novelId);
}

export function splitThreadsByNovel(threads, novelId) {
  const currentThreads = [];
  const otherThreads = [];
  for (const thread of threads || []) {
    if (isThreadInNovel(thread, novelId)) currentThreads.push(thread);
    else otherThreads.push(thread);
  }
  return { currentThreads, otherThreads };
}

export function buildNovelTitleMap(novels) {
  const result = new Map();
  for (const novel of novels || []) {
    const id = normalizeThreadNovelId(novel?.id);
    if (!id) continue;
    result.set(id, novel?.title || id);
  }
  return result;
}

export function getThreadNovelLabel(thread, novelTitleMap) {
  const novelId = normalizeThreadNovelId(thread?.novelId);
  if (!novelId) return '空白项目';
  return novelTitleMap?.get?.(novelId) || '其他项目';
}

export function shouldConfirmThreadProjectSwitch(thread, currentNovelId) {
  return !isThreadInNovel(thread, currentNovelId);
}