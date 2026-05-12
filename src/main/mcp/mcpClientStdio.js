'use strict';

/**
 * Stdio-backed MCP client adapter.
 *
 * Exposes the same surface as the legacy in-process `mcp/client.js`
 * (`listTools` / `callTool` / `setActiveNovel` / `getActiveNovel` /
 *  `resolveConfirmation` / `listPendingConfirmations`) but routes everything
 * through the forked stdio MCP server managed by `./serverManager.js`.
 *
 * If env `MANA_USE_STDIO_MCP=0` (or `false`), falls back to the original
 * in-process client. This switch exists for Phase 6 → 5 rollback safety
 * during transition; once Phase 6 is verified, the flag becomes informational.
 *
 * Why a thin adapter instead of letting callers import serverManager directly?
 *   - Lets Phase 5 callers (runSubagent.js + ipc/runtime.js) keep their
 *     `require('../mcp/client')` style import; they import this file and get
 *     the same shape regardless of in-process vs. stdio.
 *   - Centralizes the feature flag.
 */

function _stdioEnabled() {
  const v = process.env.MANA_USE_STDIO_MCP;
  if (v === undefined || v === null || v === '') return true; // default ON in Phase 6
  const s = String(v).toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

const useStdio = _stdioEnabled();
const backend = useStdio
  ? require('./serverManager')
  : require('./client');

module.exports = {
  listTools: (...a) => backend.listTools(...a),
  callTool: (...a) => backend.callTool(...a),
  setActiveNovel: (...a) => backend.setActiveNovel(...a),
  getActiveNovel: (...a) => backend.getActiveNovel(...a),
  // {id, dir} pair — falls back to {id, dir:null} for the legacy client which
  // resolves dir lazily from the novels store at callTool time.
  getActiveNovelContext: backend.getActiveNovelContext
    ? (...a) => backend.getActiveNovelContext(...a)
    : () => ({ id: backend.getActiveNovel() || null, dir: null }),
  resolveConfirmation: (...a) => backend.resolveConfirmation(...a),
  listPendingConfirmations: (...a) => backend.listPendingConfirmations(...a),
  dispose: backend.dispose ? (...a) => backend.dispose(...a) : async () => {},
  _backend: useStdio ? 'stdio' : 'in-process',
};
