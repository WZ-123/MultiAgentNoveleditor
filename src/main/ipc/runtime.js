'use strict';

const { ipcMain } = require('electron');
const path = require('node:path');
const { paths } = require('../store/paths');
const { readJsonl, listJsonFiles } = require('../store/jsonStore');
const orchestrator = require('../runtime/workflowOrchestrator');
const { withActiveNovelContext } = require('../runtime/activeNovelContext');
// Phase 6: stdio MCP server (forked child) by default; the adapter falls back
// to in-process client when MANA_USE_STDIO_MCP=0 for rollback safety.
const mcpClient = require('../mcp/mcpClientStdio');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
}

function registerRuntimeIpc() {
  // ---------- Workflow execution (routed through orchestrator → active driver) ----------

  ipcMain.handle('mana:runtime:runSubagent', safeIpc(async (_e, payload) => {
    const result = await orchestrator.runWorkflow({
      mode: 'subagent',
      ...withActiveNovelContext(payload, mcpClient),
    });
    return { runId: result.runId, output: result.output };
  }));

  ipcMain.handle('mana:runtime:cancel', safeIpc(async (_e, { runId }) => {
    await orchestrator.cancelWorkflow(runId);
    return true;
  }));

  ipcMain.handle('mana:runtime:listRuns', safeIpc(async () => {
    const files = await listJsonFiles(paths().logs);
    const runs = files
      .map((f) => path.basename(f, '.json'))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.replace(/\.jsonl$/, ''));
    return runs;
  }));

  ipcMain.handle('mana:runtime:getRunEvents', safeIpc(async (_e, { runId }) => {
    const file = path.join(paths().logs, `${runId}.jsonl`);
    return readJsonl(file);
  }));

  // Tool-confirmation control plane (used by UI when sa* asks to write
  // protected resources like update_character / update_world).
  // Phase 6: served by the stdio MCP server child; the adapter forwards to the
  // legacy in-process client when MANA_USE_STDIO_MCP=0.
  ipcMain.handle(
    'mana:runtime:resolveToolConfirmation',
    safeIpc(async (_e, { runId, toolUseId, decision }) => {
      return mcpClient.resolveConfirmation(runId, toolUseId, decision);
    })
  );

  ipcMain.handle(
    'mana:runtime:listPendingConfirmations',
    safeIpc(async () => mcpClient.listPendingConfirmations())
  );

  // Pipelines (DAGs)
  ipcMain.handle('mana:runtime:runPipeline', safeIpc(async (_e, payload) => {
    const result = await orchestrator.runWorkflow({
      mode: 'pipeline',
      ...withActiveNovelContext(payload, mcpClient),
    });
    return {
      pipelineRunId: result.pipelineRunId || result.runId,
      output: result.output,
      nodeStatus: result.nodeStatus,
    };
  }));

  ipcMain.handle('mana:runtime:cancelPipeline', safeIpc(async (_e, { pipelineRunId }) => {
    await orchestrator.cancelWorkflow(pipelineRunId);
    return true;
  }));

  ipcMain.handle('mana:runtime:resumePipeline', safeIpc(async (_e, { pipelineRunId, nodeId, payload }) => {
    return orchestrator.resumeWorkflow(pipelineRunId, nodeId, payload);
  }));

  ipcMain.handle('mana:runtime:listActivePipelines', safeIpc(async () => {
    const r = orchestrator.listActiveWorkflows();
    return r.direct;
  }));

  // ---------- Driver management ----------

  ipcMain.handle('mana:runtime:listDrivers', safeIpc(async () => {
    return orchestrator.listDrivers();
  }));

  ipcMain.handle('mana:runtime:getActiveDriver', safeIpc(async () => {
    return orchestrator.getActiveDriverId();
  }));

  ipcMain.handle('mana:runtime:setActiveDriver', safeIpc(async (_e, { id }) => {
    return orchestrator.setActiveDriverId(id);
  }));

  ipcMain.handle('mana:runtime:getDriverCapabilities', safeIpc(async (_e, { id }) => {
    return orchestrator.driverCapabilities(id);
  }));

  ipcMain.handle('mana:runtime:driverAvailability', safeIpc(async (_e, { id }) => {
    return orchestrator.driverAvailability(id);
  }));

  ipcMain.handle('mana:runtime:autoDetectDriverBinPath', safeIpc(async (_e, { id }) => {
    return orchestrator.autoDetectDriverBinPath(id);
  }));
}

module.exports = { registerRuntimeIpc };
