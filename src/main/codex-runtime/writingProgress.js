'use strict';

const { paths } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');

let queue = Promise.resolve();

function keyFor(novelId, conversationId) {
  return `${String(novelId || '')}:${String(conversationId || '')}`;
}

async function load() {
  const value = await readJson(paths().codexWritingProgress, { schemaVersion: 1, entries: {} });
  return value?.schemaVersion === 1 && value.entries && typeof value.entries === 'object'
    ? value
    : { schemaVersion: 1, entries: {} };
}

function saveProgress(progress) {
  const operation = queue.then(async () => {
    const store = await load();
    store.entries[keyFor(progress.novelId, progress.conversationId)] = progress;
    await writeJson(paths().codexWritingProgress, store, { mode: 0o600 });
    return progress;
  });
  queue = operation.catch(() => {});
  return operation;
}

async function getProgress({ novelId, conversationId } = {}) {
  const store = await load();
  if (novelId && conversationId) return store.entries[keyFor(novelId, conversationId)] || null;
  const candidates = Object.values(store.entries).filter((entry) => !novelId || entry.novelId === String(novelId));
  return candidates.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
}

module.exports = { getProgress, keyFor, saveProgress };
