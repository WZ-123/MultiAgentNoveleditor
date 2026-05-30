'use strict';

/**
 * directApi driver — fallback runtime using built-in providers.
 *
 * Wraps the existing self-built runtime (runSubagent.js / runPipeline.js) as an
 * AgentRuntimeDriver. This is the only driver guaranteed to be available — it
 * does not require any external CLI or IDE integration. UI defaults to it when
 * no Claude Code installation is detected.
 *
 * Capabilities (vs Claude Code drivers):
 *   - workflowExecution: 'spec'  — we execute the DAG ourselves; subagents are
 *     pipeline nodes, not real Task-spawned agents.
 *   - supportsSubagents: false   — same reason above; per-subagent model is
 *     still supported (preset.tiers slot), but they're not isolated agents.
 *   - supportsHumanInLoop: true  — pipeline 'human' node + resumePipeline.
 *   - supportsToolConfirmation: true — via the stdio MCP server child process
 *     (Phase 6); the legacy in-process mcp/client remains as a rollback target
 *     behind MANA_USE_STDIO_MCP=0.
 *
 * Lifecycle:
 *   prepare(spec) — light validation; returns a handle carrying spec + a fresh
 *                   AbortController. No tmpdir, no child processes.
 *   run(handle)   — dispatches to runSubagent or runPipeline based on spec.mode.
 *                   Events are emitted via the existing eventBus to renderer
 *                   listeners — the driver does not relay them.
 *   cancel(h)     — calls runSubagent.cancel(runId) or
 *                   runPipeline.cancelPipeline(pipelineRunId), then aborts the
 *                   handle's AbortController as a belt-and-suspenders measure.
 *   dispose(h)    — no-op (no allocated resources).
 */

const { runSubagent, cancel: cancelSubagent } = require('../runSubagent');
const { runPipeline, cancelPipeline } = require('../runPipeline');
// Phase 6: stdio MCP server (forked child) by default; falls back to in-process
// client when MANA_USE_STDIO_MCP=0 for rollback safety.
const mcpClient = require('../../mcp/mcpClientStdio');

const id = 'direct-api';
const displayName = 'Direct API';
const description = 'Built-in runtime using configured LLM provider (Anthropic / OpenAI-compat). Always available.';

async function availability() {
  return { available: true, version: 'built-in' };
}

function capabilities() {
  return {
    supportsSubagents: false,
    supportsPerSubagentModel: true,
    supportsMcp: true,
    supportsStreamingTokens: true,
    supportsHumanInLoop: true,
    supportsToolConfirmation: true,
    workflowExecution: 'spec',
    requires: [],
  };
}

async function prepare(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('directApi.prepare: spec is required');
  }
  const { mode, runId, subagentId, dag } = spec;
  if (mode !== 'subagent' && mode !== 'pipeline') {
    throw new Error(`directApi.prepare: unknown mode '${mode}'`);
  }
  if (mode === 'subagent' && !subagentId) {
    throw new Error('directApi.prepare: subagentId required for subagent mode');
  }
  if (mode === 'pipeline' && !dag) {
    throw new Error('directApi.prepare: dag required for pipeline mode');
  }
  const abortController = new AbortController();
  return {
    driverId: id,
    runId: runId || null,
    abortController,
    resources: { spec },
  };
}

async function run(handle, opts = {}) {
  if (!handle || handle.driverId !== id) {
    throw new Error('directApi.run: invalid handle');
  }
  const { spec } = handle.resources || {};
  const { abortController } = handle;
  const input = opts.input;

  if (spec.mode === 'subagent') {
    const r = await runSubagent({
      subagentId: spec.subagentId,
      input,
      systemPromptOverride: spec.systemPromptOverride,
      presetOverride: spec.presetOverride,
      tierOverride: spec.tierOverride,
      runId: handle.runId || spec.runId,
      pipelineRunId: spec.pipelineRunId,
      nodeId: spec.nodeId,
      userLang: spec.userLang,
      mcpClient,
      abortSignal: abortController.signal,
    });
    handle.runId = r.runId;
    return {
      output: r.output,
      transcript: r.transcript,
      runId: r.runId,
      stopReason: r.stopReason,
      truncated: r.truncated,
    };
  }

  // pipeline mode
  const r = await runPipeline({
    dag: spec.dag,
    dagId: spec.dag?.id,
    userInput: input,
    presetOverride: spec.presetOverride,
    userLang: spec.userLang,
    mcpClient,
    pipelineRunId: spec.pipelineRunId || spec.runId,
  });
  handle.runId = r.pipelineRunId;
  return {
    output: r.output,
    pipelineRunId: r.pipelineRunId,
    nodeOutputs: r.nodeOutputs,
    nodeStatus: r.nodeStatus,
  };
}

async function cancel(handle) {
  if (!handle || handle.driverId !== id) return;
  const { spec } = handle.resources || {};
  try {
    if (spec?.mode === 'pipeline') {
      cancelPipeline(handle.runId || spec.pipelineRunId || spec.runId);
    } else if (spec?.mode === 'subagent') {
      cancelSubagent(handle.runId || spec.runId);
    }
  } catch (err) {
    console.error('[directApi] cancel failed', err);
  }
  try { handle.abortController?.abort(); } catch { /* ignore */ }
}

async function dispose() { /* nothing to clean up */ }

module.exports = {
  id,
  displayName,
  description,
  availability,
  capabilities,
  prepare,
  run,
  cancel,
  dispose,
};
