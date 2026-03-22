const KEY = 'mana-style-memory-v1';

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
 * @param {string} text
 */
export function saveStyleMemory(text) {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} patch
 */
export function appendStyleMemory(patch) {
  const cur = loadStyleMemory();
  const next = cur ? `${cur.trim()}\n\n${patch.trim()}` : patch.trim();
  saveStyleMemory(next);
}
