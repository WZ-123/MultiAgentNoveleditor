'use strict';

/**
 * workflowOrchestrator — single IPC entry for runtime operations.
 *
 * Responsibilities:
 *   1. Select active driver via registry (defaults to 'direct-api').
 *   2. Generate a stable runId / pipelineRunId before driver.prepare so that
 *      the orchestrator can track handles (driver-internal id generation
 *      happens inside runSubagent/runPipeline today; we override it).
 *   3. Track in-flight handles in a Map keyed by run id, so cancelWorkflow can
 *      resolve the right handle without relying on the driver-internal
 *      activeRuns map.
 *   4. Re-export driver registry methods for IPC consumers.
 *
 * The orchestrator does NOT relay events. Drivers call eventBus.emit /
 * emitPipeline directly, so the renderer's existing 'agent:event' /
 * 'pipeline:event' subscriptions Just Work as long as drivers respect the
 * AgentEvent shape contract.
 */

const registry = require('./drivers/registry');
const eventBus = require('./eventBus');
const { generateId } = require('../store/paths');
const { resumePipeline, listActivePipelines } = require('./runPipeline');

/** runId | pipelineRunId  ->  { driverId, handle, mode } */
const activeHandles = new Map();

/**
 * Run a workflow with the active driver.
 *
 * @param {object} payload
 * @param {'subagent'|'pipeline'} payload.mode
 * @param {string=} payload.subagentId  Required for mode='subagent'
 * @param {object=} payload.dag         Required for mode='pipeline' (full DagSpec)
 * @param {string=} payload.dagId       Optional convenience for mode='pipeline'
 * @param {*}      payload.input        User input (string for subagent; userInput for pipeline)
 * @param {object=} payload.presetOverride
 * @param {string=} payload.tierOverride
 * @param {string=} payload.systemPromptOverride  Override the subagent's stored system prompt
 * @param {string=} payload.userLang
 * @param {object=} payload.novelContext
 * @param {string=} payload.driverId    Force a specific driver (else uses active)
 * @returns {Promise<{runId: string, output: *, [k:string]: any}>}
 */
async function runWorkflow(payload = {}) {
  const { mode, driverId: explicitDriverId, ...rest } = payload;
  // Renderer historically sends `userInput` (PipelineRunnerPanel); orchestrator
  // and drivers want `input`. Accept either, prefer explicit `input`.
  const input = rest.input != null ? rest.input : rest.userInput;
  if (mode !== 'subagent' && mode !== 'pipeline') {
    throw new Error(`runWorkflow: invalid mode '${mode}'`);
  }

  let driver;
  if (explicitDriverId) {
    driver = registry.get(explicitDriverId);
    if (!driver) throw new Error(`unknown driver: ${explicitDriverId}`);
  } else {
    driver = await registry.getActive();
    if (!driver) throw new Error('no driver registered');
  }

  // Reserve a stable id so we can track the handle before driver.run returns.
  const runId = mode === 'pipeline'
    ? (rest.pipelineRunId || generateId('pipeline'))
    : (rest.runId || eventBus.ensureRunId());

  // For pipeline mode, callers may pass `dagId` only (the renderer always
  // does — it doesn't have the full DagSpec, just the id). Drivers want the
  // resolved DagSpec, so look it up here once instead of forcing every
  // driver to grow a store dependency.
  let resolvedDag = rest.dag;
  if (mode === 'pipeline' && !resolvedDag && rest.dagId) {
    const dagsStore = require('../store/dags');
    resolvedDag = await dagsStore.getDag(rest.dagId);
    if (!resolvedDag) throw new Error(`DAG not found: ${rest.dagId}`);
  }

  const spec = {
    mode,
    runId,
    ...rest,
    ...(mode === 'pipeline' ? { pipelineRunId: runId, dag: resolvedDag } : {}),
  };

  const handle = await driver.prepare(spec);
  // Driver may have updated runId inside prepare; trust the handle if it set it.
  const trackKey = handle.runId || runId;
  activeHandles.set(trackKey, { driverId: driver.id, handle, mode });

  try {
    const result = await driver.run(handle, { input });
    const finalKey = handle.runId || result.runId || result.pipelineRunId || trackKey;
    return {
      runId: finalKey,
      ...result,
    };
  } finally {
    activeHandles.delete(trackKey);
    if (handle.runId && handle.runId !== trackKey) activeHandles.delete(handle.runId);
    try { await driver.dispose?.(handle); } catch (err) {
      console.error('[workflowOrchestrator] dispose failed', err);
    }
  }
}

/**
 * Cancel an in-flight workflow by its tracking id (runId for subagent, pipelineRunId for pipeline).
 */
async function cancelWorkflow(runId) {
  const entry = activeHandles.get(runId);
  if (!entry) {
    // Fall back to direct-api's pipeline cancel — covers the case where
    // the run was started before the orchestrator existed (defensive).
    try {
      const { cancelPipeline } = require('./runPipeline');
      cancelPipeline(runId);
    } catch { /* ignore */ }
    try {
      const { cancel } = require('./runSubagent');
      cancel(runId);
    } catch { /* ignore */ }
    return false;
  }
  const driver = registry.get(entry.driverId);
  if (driver) {
    try { await driver.cancel(entry.handle); } catch (err) {
      console.error('[workflowOrchestrator] driver.cancel threw', err);
    }
  }
  return true;
}

/**
 * Resume a pipeline that paused on a 'human' node.
 *
 * Only meaningful for drivers with capabilities.supportsHumanInLoop = true
 * (currently only direct-api). Other drivers will report an error.
 */
function resumeWorkflow(pipelineRunId, nodeId, payload) {
  // direct-api owns the pendingHuman map inside runPipeline.js — delegate.
  return resumePipeline(pipelineRunId, nodeId, payload);
}

function listActiveWorkflows() {
  // Combine: direct-api pipelines (via runPipeline) + any orchestrator-tracked.
  const direct = listActivePipelines();
  const tracked = Array.from(activeHandles.entries()).map(([runId, e]) => ({
    runId, driverId: e.driverId, mode: e.mode,
  }));
  return { direct, tracked };
}

async function autoDetectDriverBinPath(id) {
  const driver = registry.get(id);
  if (!driver) throw new Error(`unknown driver: ${id}`);
  if (typeof driver._autoDetectBinPath !== 'function') {
    return { detected: false, reason: `${id} does not support auto-detect` };
  }
  const path = await driver._autoDetectBinPath();
  return path ? { detected: true, path } : { detected: false, reason: 'no installation found' };
}

module.exports = {
  runWorkflow,
  cancelWorkflow,
  resumeWorkflow,
  listActiveWorkflows,
  // Re-export registry surface for IPC convenience.
  listDrivers: () => registry.listInfoAsync(),
  getActiveDriverId: () => registry.getActiveId(),
  setActiveDriverId: (id) => registry.setActive(id),
  driverCapabilities: (id) => registry.capabilities(id),
  driverAvailability: (id) => registry.availability(id),
  autoDetectDriverBinPath,
  bootstrap: () => registry.bootstrap(),
  setWebContents: (wc) => registry.setWebContents(wc),
};
