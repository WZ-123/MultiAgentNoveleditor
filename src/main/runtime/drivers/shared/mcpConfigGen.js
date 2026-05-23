'use strict';

/**
 * mcpConfigGen — produce the `mcp-config.json` file that Claude Code (CLI or
 * VSCode bundled CLI) consumes via `--mcp-config <path>`.
 *
 * Shape (from Anthropic docs — keep field names verbatim, Claude Code parses
 * this JSON strictly):
 *
 *   {
 *     "mcpServers": {
 *       "novel-tools": {
 *         "type": "stdio",
 *         "command": "<exe>",
 *         "args":    ["mcp-server-entry.js", "--run-id", "...", ...],
 *         "env":     { "ELECTRON_RUN_AS_NODE": "1", ... }
 *       }
 *     }
 *   }
 *
 * Why we need this file (and not just inline config): `claude --print` does
 * not accept inline JSON — only `--mcp-config <file>`. So every run writes a
 * fresh config to its tmpdir.
 *
 * The args / env list here MUST line up with `mcp-server-entry.js`'s
 * parseArgs and the env vars it reads (MANA_USER_DATA_ROOT, MANA_MAIN_PORT,
 * MANA_RUN_ID, MANA_ACTIVE_NOVEL_ID/DIR). When that contract changes, change
 * here too.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// ---- Constants kept in lockstep with serverManager.js / mcp-server-entry.js ----
const DEFAULT_SERVER_NAME = 'novel-tools';

/**
 * Resolve the absolute path to `mcp-server-entry.js`.
 *
 * In the packaged Electron build, this file lives at the asar-unpacked root
 * (see package.json `build.asarUnpack`). In dev (`npm run start`), it sits at
 * the repo root. Both cases resolve via `__dirname` walk-up because this
 * module is at `src/main/runtime/drivers/shared/`.
 */
function defaultEntryScript() {
  // src/main/runtime/drivers/shared/  →  five levels up to repo root
  let entry = path.resolve(__dirname, '..', '..', '..', '..', '..', 'mcp-server-entry.js');
  // In a packaged build, the file is asar-unpacked.  Redirect accordingly.
  if (entry.includes('.asar') && !entry.includes('.asar.unpacked')) {
    const unpacked = entry.replace(/\.asar([\\/])/, '.asar.unpacked$1');
    try {
      const fs = require('node:fs');
      if (fs.existsSync(unpacked)) return unpacked;
    } catch { /* fall through */ }
  }
  return entry;
}

/**
 * Resolve the binary that should run `mcp-server-entry.js`.
 *
 * - In an Electron main process, `process.execPath` is the Electron binary;
 *   coupled with `ELECTRON_RUN_AS_NODE=1` it behaves like plain Node.
 * - In dev (`electron .`), still works the same way.
 * - In a non-Electron Node test harness, `process.execPath` is `node` itself
 *   and ELECTRON_RUN_AS_NODE is harmless (Node ignores unknown env).
 *
 * Callers may override via opts.command if they want to force `/usr/local/bin/node`.
 */
function defaultCommand() {
  return process.execPath;
}

/**
 * Build the args array for `command`.
 *
 * Order matters only for the entry script position (must be argv[0] so the
 * inner parseArgs sees nothing before it).
 *
 * @param {object} p
 * @param {string} p.entryScript      Absolute path to mcp-server-entry.js
 * @param {string=} p.runId
 * @param {string=} p.novelId
 * @param {string=} p.novelDir
 * @param {string=} p.userDataRoot
 * @param {number|string=} p.mainPort
 * @returns {string[]}
 */
function buildArgs(p) {
  const args = [p.entryScript];
  if (p.userDataRoot) args.push('--user-data-root', p.userDataRoot);
  if (p.runId)        args.push('--run-id', String(p.runId));
  if (p.novelId)      args.push('--novel-id', String(p.novelId));
  if (p.novelDir)     args.push('--novel-dir', p.novelDir);
  if (p.mainPort)     args.push('--main-port', String(p.mainPort));
  return args;
}

/**
 * Build the env block. Only env vars the entry script and server.js read.
 * Caller-provided `extraEnv` is merged last and may override defaults.
 */
function buildEnv(p, extraEnv = {}) {
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (p.userDataRoot)  env.MANA_USER_DATA_ROOT = p.userDataRoot;
  if (p.runId)         env.MANA_RUN_ID = String(p.runId);
  if (p.mainPort)      env.MANA_MAIN_PORT = String(p.mainPort);
  // Active-novel context for the external-spawn case (no IPC channel from
  // parent), as documented in mcp-server-entry.js comments.
  if (p.novelId)       env.MANA_ACTIVE_NOVEL_ID = String(p.novelId);
  if (p.novelDir)      env.MANA_ACTIVE_NOVEL_DIR = p.novelDir;
  return { ...env, ...extraEnv };
}

/**
 * Render the full config object.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string=} opts.novelId
 * @param {string=} opts.novelDir
 * @param {string=} opts.userDataRoot
 * @param {number|string=} opts.mainPort  TCP port for confirmation socket
 * @param {string=} opts.entryScript      Override path to mcp-server-entry.js
 * @param {string=} opts.command          Override binary that runs entry
 * @param {string=} opts.serverName       Default 'novel-tools'
 * @param {object=} opts.extraEnv         Additional env vars
 * @returns {object}                      JSON-serializable config
 */
function renderConfig(opts = {}) {
  if (!opts.runId) throw new Error('renderConfig: runId required');
  const entryScript = opts.entryScript || defaultEntryScript();
  const command = opts.command || defaultCommand();
  const serverName = opts.serverName || DEFAULT_SERVER_NAME;
  const args = buildArgs({ ...opts, entryScript });
  const env = buildEnv(opts, opts.extraEnv);

  return {
    mcpServers: {
      [serverName]: {
        type: 'stdio',
        command,
        args,
        env,
      },
    },
  };
}

/**
 * Write the config to disk. Returns the absolute file path.
 *
 * @param {string} filePath  Absolute path (typically `<tmpdir>/mcp-config.json`)
 * @param {object} opts      Forwarded to renderConfig
 * @returns {Promise<{path: string, config: object}>}
 */
async function writeConfig(filePath, opts) {
  const config = renderConfig(opts);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
  return { path: filePath, config };
}

module.exports = {
  DEFAULT_SERVER_NAME,
  defaultEntryScript,
  defaultCommand,
  buildArgs,
  buildEnv,
  renderConfig,
  writeConfig,
};
