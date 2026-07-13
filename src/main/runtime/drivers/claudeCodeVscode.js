'use strict';

/**
 * claude-code-vscode driver — Phase 7 implementation.
 *
 * Runs workflows by spawning the `claude` CLI bundled with the Claude Code
 * VSCode (or VSCode Insiders / Cursor) extension. Materializes a per-run
 * tmpdir containing:
 *   - .claude/agents/<name>.md   — sub-agent definitions for `Task`
 *   - mcp-config.json            — points Claude Code at our stdio MCP server
 *
 * Then spawns:
 *   <binPath> --print
 *     --input-format stream-json --output-format stream-json --verbose
 *     --include-partial-messages
 *     --append-system-prompt <DAG-as-prose>
 *     --mcp-config <path>
 *     --allowedTools "mcp__novel-tools__*,Task,Read,Grep"
 *     --permission-mode default
 *
 * stdin gets the user's input as a single NDJSON envelope. stdout NDJSON is
 * normalized to AgentEvents and emitted via eventBus, mirroring the events
 * the directApi driver produces — so the renderer doesn't need a code path
 * per driver.
 *
 * Limitations (Phase 7 first-ship; tracked in spicy-napping-book.md risk #5):
 *   - tool confirmation: the MCP server child spawned by Claude Code has no
 *     parent IPC channel back to our main process. In that path the MCP server
 *     uses a localhost TCP relay back to the main process so confirmation
 *     prompts can still flow through the normal UI.
 *   - human-in-loop: not supported (single CLI invocation).
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const fg = require('fast-glob');

const eventBus = require('../eventBus');
const { generateId, paths: appPaths } = require('../../store/paths');
const subagentsStore = require('../../store/subagents');
const appConfig = require('../../store/appConfig');
const providerManager = require('../../providerManager');
const modelConfig = require('../../modelConfig');
const mcpClient = require('../../mcp/mcpClientStdio');

const { writeAgentsDir } = require('./shared/agentMdWriter');
const { writeConfig: writeMcpConfig } = require('./shared/mcpConfigGen');
const { dagToPrompt } = require('./shared/dagToPrompt');
const {
  spawnClaude, buildClaudeArgs, buildUserMessage,
} = require('./shared/claudeProcess');
const { createStreamParser } = require('./shared/streamJsonParser');

const id = 'claude-code-vscode';
const displayName = 'Claude Code (VSCode Extension)';
const description = 'Run workflows through the Claude Code extension bundled with VSCode / Cursor / VSCode Insiders.';
const PREAPPROVED_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit'];
const DEFAULT_ALLOWED_TOOLS = ['mcp__novel-tools__*', 'Task', 'Agent', ...PREAPPROVED_TOOLS];

// ---------- binPath auto-detection ----------

function _candidateGlobs() {
  const home = os.homedir();
  // The extension publisher id changed at one point ('Anthropic.claude-code'
  // vs 'anthropic.claude-code'). VSCode normalizes ids to lowercase on disk,
  // so the lowercase glob covers both. Cursor + Insiders mirror VSCode's
  // extensions layout.
  //
  // Binary layout has changed across versions:
  //   - <=2.0.x:  <extDir>/cli/claude
  //   - >=2.1.x:  <extDir>/resources/native-binary/claude  (platform-suffixed dir, e.g.
  //               anthropic.claude-code-2.1.126-darwin-arm64/resources/native-binary/claude)
  // Windows ships `claude.exe`; cover both filename forms in each layout.
  const ides = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'];
  const layouts = [
    ['cli', 'claude'],
    ['cli', 'claude.exe'],
    ['resources', 'native-binary', 'claude'],
    ['resources', 'native-binary', 'claude.exe'],
  ];
  const out = [];
  for (const ide of ides) {
    for (const tail of layouts) {
      out.push(path.join(home, ide, 'extensions', 'anthropic.claude-code-*', ...tail));
    }
  }
  return out;
}

async function _autoDetectBinPath() {
  const matches = await fg(_candidateGlobs(), {
    onlyFiles: true,
    suppressErrors: true,
    dot: true,
  });
  if (!matches.length) return null;
  // Prefer the highest version directory (string sort works for SemVer-ish).
  matches.sort();
  return matches[matches.length - 1];
}

function _probeVersion(binPath) {
  try {
    const r = spawnSync(binPath, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (r.status !== 0) return null;
    const m = String(r.stdout || '').match(/\d+\.\d+(?:\.\d+)?/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function availability() {
  let cfg = null;
  try { cfg = await appConfig.load(); } catch { /* ignore */ }
  const driverCfg = cfg?.drivers?.[id] || {};
  let binPath = (driverCfg.binPath && String(driverCfg.binPath).trim()) || '';
  let detected = false;
  if (!binPath) {
    const found = await _autoDetectBinPath();
    if (found) { binPath = found; detected = true; }
  } else if (!fsSync.existsSync(binPath)) {
    // Stored binPath is stale (extension was updated). Re-autodetect.
    const found = await _autoDetectBinPath();
    if (found) { binPath = found; detected = true; }
  }
  if (!binPath) {
    return {
      available: false,
      reason: 'Claude Code VSCode extension not found. Install it, or set binPath manually in driver settings.',
    };
  }
  if (!fsSync.existsSync(binPath)) {
    return {
      available: false,
      reason: `binPath does not exist: ${binPath}`,
      binPath,
      suggested: '(re-run auto-detection after extension update)',
    };
  }
  const version = _probeVersion(binPath);
  if (!version) {
    return {
      available: false,
      reason: `binPath exists but failed to report version: ${binPath}`,
      binPath,
    };
  }
  // Cache detected path back to appConfig so subsequent loads avoid the glob.
  if (detected) {
    try {
      await appConfig.save({
        drivers: {
          [id]: { ...driverCfg, autoDetectedPath: binPath },
        },
      });
    } catch { /* ignore */ }
  }
  return { available: true, version, binPath };
}

function capabilities() {
  return {
    supportsSubagents: true,
    supportsPerSubagentModel: true,
    supportsMcp: true,
    supportsStreamingTokens: true,
    supportsHumanInLoop: false,
    supportsToolConfirmation: true,
    supportedAdapterIds: ['anthropic-messages'],
    supportsCustomProvider: true,
    supportedProfileParameters: ['effortLevel'],
    workflowExecution: 'autonomous',
    requires: ['claude>=1.5'],
  };
}

// ---------- subagent resolution ----------

async function _resolveSubagentsForDag(dag) {
  if (!dag || !Array.isArray(dag.nodes)) return [];
  const ids = new Set();
  for (const n of dag.nodes) {
    if (n?.kind === 'subagent' && n.subagentId) ids.add(n.subagentId);
  }
  if (ids.size === 0) return [];
  const out = [];
  for (const sid of ids) {
    try {
      const sa = await subagentsStore.getSubagent(sid);
      if (sa) out.push(sa);
    } catch { /* ignore */ }
  }
  return out;
}

// ---------- prepare / run / cancel / dispose ----------

async function prepare(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('claudeCodeVscode.prepare: spec required');
  }
  const { mode, runId: specRunId } = spec;
  if (mode !== 'pipeline' && mode !== 'subagent') {
    throw new Error(`claudeCodeVscode.prepare: unknown mode '${mode}'`);
  }
  if (mode === 'pipeline' && (!spec.dag || !Array.isArray(spec.dag.nodes))) {
    throw new Error('claudeCodeVscode.prepare: pipeline mode requires resolved dag');
  }

  // 0. Verify availability (re-uses cached path when present)
  const av = await availability();
  if (!av.available) {
    throw new Error(`claudeCodeVscode unavailable: ${av.reason}`);
  }
  const binPath = av.binPath;

  const runId = specRunId || generateId('run');

  // 1. Tmpdir at <userData>/runtime-tmp/<runId>/
  const ud = appPaths();
  const tmpdir = path.join(ud.root, 'runtime-tmp', runId);
  await fs.mkdir(tmpdir, { recursive: true });
  const agentsDir = path.join(tmpdir, '.claude', 'agents');

  // 2. Resolve subagents — caller may pass them via spec.subagents (preferred);
  //    otherwise derive from the DAG.
  let subagents = Array.isArray(spec.subagents) && spec.subagents.length
    ? spec.subagents
    : await _resolveSubagentsForDag(spec.dag);

  // For subagent mode, we need exactly that one subagent.
  if (mode === 'subagent') {
    if (subagents.find((s) => s.id === spec.subagentId || s.name === spec.subagentId)) {
      // already present
    } else {
      try {
        const sa = await subagentsStore.getSubagent(spec.subagentId);
        if (sa) subagents = [sa];
      } catch { /* ignore */ }
    }
  }

  // 3. Write .claude/agents/*.md
  const agentsResult = await writeAgentsDir(agentsDir, subagents, {
    userLang: spec.userLang || 'zh-CN',
    driverId: id,
    modelProfileId: spec.modelProfileId,
  });

  // 4. Write .claude/settings.json — pre-approve the non-interactive built-in
  //    tools we rely on so Claude Code doesn't stop on permission prompts in
  //    headless --print mode.
  const settingsPath = path.join(tmpdir, '.claude', 'settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    permissions: { allow: PREAPPROVED_TOOLS },
  }, null, 2), 'utf8');

  // 5. Write mcp-config.json
  const mcpConfigPath = path.join(tmpdir, 'mcp-config.json');
  const novelId = spec.novelContext?.novelId || null;
  const novelDir = spec.novelContext?.novelDir || null;
  let mainPort = null;
  try {
    const relay = await mcpClient.ensureConfirmationRelay?.();
    mainPort = relay?.port || null;
  } catch (err) {
    console.error('[claudeCodeVscode] confirmation relay unavailable', err);
  }
  await writeMcpConfig(mcpConfigPath, {
    runId,
    novelId,
    novelDir,
    userDataRoot: ud.root,
    mainPort,
  });

  // 6. Subagent-mode per-alias env injection.
  let aliasEnv = null;
  if (mode === 'subagent') {
    const sa = subagents.find((s) => s.id === spec.subagentId || s.name === spec.subagentId);
    if (sa?.tier) {
      const targets = await modelConfig.resolveTargets({
        driverId: id,
        subagentId: sa.id,
        modelProfileId: spec.modelProfileId,
        legacyTier: spec.tierOverride || sa.tier,
      });
      const resolved = targets[0];
      if (resolved) {
        const globalEnv = providerManager.getActiveEnv() || {};
        aliasEnv = {};
        // If alias points to a different provider, swap the endpoint.
        const provider = resolved.provider;
        if (provider) {
          if (provider.adapterId !== 'anthropic-messages') {
            throw new Error(`模型档案「${resolved.profileName}」为 Claude Code 配置了不兼容的 Provider 协议`);
          }
          if (provider.baseUrl) aliasEnv.ANTHROPIC_BASE_URL = provider.baseUrl;
          if (provider.apiKey) {
            aliasEnv.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
            aliasEnv.ANTHROPIC_API_KEY = provider.apiKey;
          }
        }
        if (resolved.target.modelId) aliasEnv.ANTHROPIC_MODEL = resolved.target.modelId;
        if (resolved.target.params?.effortLevel) aliasEnv.CLAUDE_CODE_EFFORT_LEVEL = resolved.target.params.effortLevel;
        // Only inject if we actually changed something.
        if (Object.keys(aliasEnv).length === 0) aliasEnv = null;
      }
    }
  }

  // 7. Compose system prompt: dagToPrompt for pipeline; bare instruction for subagent.
  let appendSystemPrompt = '';
  if (mode === 'pipeline') {
    appendSystemPrompt = dagToPrompt(spec.dag, subagents, {
      cwd: tmpdir,
      userLang: spec.userLang || 'zh-CN',
      mcpServer: 'novel-tools',
    });
  } else {
    const sa = subagents.find((s) => s.id === spec.subagentId || s.name === spec.subagentId);
    const name = sa?.name || spec.subagentId;
    appendSystemPrompt = [
      `Single-subagent task. Invoke the sub-agent \`${name}\` via the \`Agent\` tool (Claude Code 1.x: \`Task\`) with the user's input as the prompt.`,
      `Sub-agent definition lives in \`.claude/agents/${name}.md\` inside cwd ${tmpdir}.`,
      `After it returns, present its output verbatim to the user.`,
      `Default response language: ${spec.userLang || 'zh-CN'}.`,
    ].join('\n');
  }

  // 8. Compose handle
  // Allow both `Task` (Claude Code v1.x) and `Agent` (v2.x renamed it) so the
  // sub-agent dispatcher isn't blocked across versions.
  const allowedTools = DEFAULT_ALLOWED_TOOLS;
  return {
    driverId: id,
    runId,
    abortController: new AbortController(),
    resources: {
      spec,
      mode,
      tmpdir,
      agentsDir,
      mcpConfigPath,
      binPath,
      appendSystemPrompt,
      allowedTools,
      novelContext: { novelId, novelDir },
      writtenAgents: agentsResult.written,
      aliasEnv,
    },
  };
}

async function run(handle, opts = {}) {
  if (!handle || handle.driverId !== id) {
    throw new Error('claudeCodeVscode.run: invalid handle');
  }
  const r = handle.resources || {};
  const runId = handle.runId;
  const pipelineRunId = r.mode === 'pipeline' ? runId : null;

  // pipeline_started event so the renderer's PipelineRunnerPanel can show
  // node statuses; for autonomous mode there's no per-node lifecycle, but the
  // existing UI subscribes to this event to flip into "running" state.
  if (r.mode === 'pipeline') {
    try {
      await eventBus.emitPipeline({
        pipelineRunId,
        dagId: r.spec.dag?.id || null,
        kind: 'pipeline_started',
        data: {
          autonomous: true,
          driverId: id,
          name: r.spec.dag?.name || null,
          stage: r.spec.dag?.stage || null,
        },
      });
    } catch { /* ignore */ }
  }

  // Build the spawn args.
  const claudeArgs = buildClaudeArgs({
    appendSystemPrompt: r.appendSystemPrompt,
    mcpConfigPath: r.mcpConfigPath,
    allowedTools: r.allowedTools,
    permissionMode: 'default',
    includePartialMessages: true,
  });

  // Spawn. providerManager.getActiveEnv() returns the user's currently-selected
  // provider (~/.ccs/current-env.json) or null — in which case the spawned
  // `claude` falls back to its own login state. Merging here means switching
  // provider in-app immediately routes future runs through the new endpoint
  // without restarting Electron.
  const baseEnv = { ELECTRON_RUN_AS_NODE: '1', ...(providerManager.getActiveEnv() || {}) };
  const proc = spawnClaude({
    binPath: r.binPath,
    args: claudeArgs,
    cwd: r.tmpdir,
    env: r.aliasEnv ? { ...baseEnv, ...r.aliasEnv } : baseEnv,
    killGraceMs: 5000,
  });

  // Track child handle on the driver handle for cancel().
  r.proc = proc;

  // Stream-json parser bound to this run.
  const parser = createStreamParser({
    runId,
    pipelineRunId,
    nodeId: r.mode === 'pipeline' ? null : r.spec.nodeId || null,
  });

  // Stream stdout NDJSON → AgentEvents.
  let fullOutputText = '';
  proc.onLine((line) => {
    const events = parser.parseLine(line);
    for (const ev of events) {
      // Accumulate user-visible text for the final `output` payload.
      if (ev.kind === 'text' && !ev.data?.thinking && !ev.data?.parentToolUseId) {
        fullOutputText += ev.data.text || '';
      }
      try { eventBus.emit(ev); } catch (err) {
        console.error('[claudeCodeVscode] emit failed', err);
      }
    }
  });

  // stderr → log only (and a single 'error' event if Claude blows up early).
  let stderrTrail = '';
  proc.onStderr((chunk) => {
    stderrTrail += chunk;
    if (stderrTrail.length > 8192) stderrTrail = stderrTrail.slice(-8192);
  });

  // Send the user input as a single NDJSON envelope.
  const input = opts.input != null ? opts.input : (r.spec.input || '');
  proc.writeStdin(buildUserMessage(input));
  proc.endStdin();

  // Wait for the child to exit.
  const closeInfo = await proc.waitClose();

  // Drain any synthesized closing events.
  for (const ev of parser.finish(closeInfo.exitCode ?? 0)) {
    try { await eventBus.emit(ev); } catch { /* ignore */ }
  }

  if (closeInfo.error || (closeInfo.exitCode != null && closeInfo.exitCode !== 0)) {
    const msg = closeInfo.error?.message
      || `Claude Code exited with code ${closeInfo.exitCode}${stderrTrail ? `: ${stderrTrail.trim().slice(-500)}` : ''}`;
    if (r.mode === 'pipeline') {
      try {
        await eventBus.emitPipeline({
          pipelineRunId, dagId: r.spec.dag?.id || null,
          kind: 'pipeline_error', data: { message: msg },
        });
      } catch { /* ignore */ }
    }
    throw new Error(msg);
  }

  // pipeline_done so the renderer hides the running indicator.
  if (r.mode === 'pipeline') {
    try {
      await eventBus.emitPipeline({
        pipelineRunId, dagId: r.spec.dag?.id || null,
        kind: 'pipeline_done', data: { output: fullOutputText },
      });
    } catch { /* ignore */ }
  }

  return r.mode === 'pipeline'
    ? { output: fullOutputText, pipelineRunId, runId }
    : { output: fullOutputText, runId };
}

async function cancel(handle) {
  if (!handle || handle.driverId !== id) return;
  const r = handle.resources || {};
  try { r.proc?.cancel?.('user-cancel'); } catch { /* ignore */ }
  try { handle.abortController?.abort(); } catch { /* ignore */ }
}

async function dispose(handle) {
  if (!handle || handle.driverId !== id) return;
  const r = handle.resources || {};
  // Safety: only rm tmpdirs that are inside our runtime-tmp root.
  const tmpdir = r.tmpdir;
  if (!tmpdir) return;
  try {
    const ud = appPaths();
    const expected = path.join(ud.root, 'runtime-tmp');
    if (!path.resolve(tmpdir).startsWith(path.resolve(expected) + path.sep)) {
      return; // refuse to delete anything outside runtime-tmp/
    }
    await fs.rm(tmpdir, { recursive: true, force: true });
  } catch (err) {
    console.error('[claudeCodeVscode] dispose tmpdir cleanup failed', err);
  }
}

module.exports = {
  id,
  displayName,
  description,
  PREAPPROVED_TOOLS,
  DEFAULT_ALLOWED_TOOLS,
  availability,
  capabilities,
  prepare,
  run,
  cancel,
  dispose,
  // exported for tests
  _autoDetectBinPath,
  _candidateGlobs,
  _probeVersion,
};
