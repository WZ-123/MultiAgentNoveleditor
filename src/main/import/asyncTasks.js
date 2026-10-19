'use strict';
function assertNotAborted(signal) { if (signal?.aborted) throw signal.reason || new DOMException('aborted', 'AbortError'); }
async function runLimited(tasks, limit = 3, signal) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      assertNotAborted(signal);
      const index = cursor++;
      results[index] = await tasks[index]();
      assertNotAborted(signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(tasks.length, Math.max(1, Math.min(6, Number(limit) || 3))) }, worker));
  return results;
}
async function retry(operation, attempts = 2, _label, signal) {
  let failure;
  for (let index = 0; index < attempts; index++) {
    assertNotAborted(signal);
    try { return await operation(); } catch (error) { failure = error; assertNotAborted(signal); }
  }
  throw failure;
}
module.exports = { runLimited, retry, assertNotAborted };
