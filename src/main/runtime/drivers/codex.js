'use strict';

/**
 * codex driver — Phase 5 stub.
 *
 * Reports unavailable until Phase 9 lands a best-effort implementation. Codex
 * does not ship real `.claude/agents` style sub-agent isolation, so we report
 * supportsSubagents: false — UI will gray out subagent-only DAG node types
 * when codex is the active driver.
 */

const id = 'codex';
const displayName = 'Codex';
const description = 'Run workflows through OpenAI Codex CLI. Phase 9 best-effort implementation.';

async function availability() {
  return {
    available: false,
    reason: 'Phase 9 — implementation pending. Stub registered for UI ordering.',
  };
}

function capabilities() {
  return {
    supportsSubagents: false,
    supportsPerSubagentModel: false,
    supportsMcp: true,
    supportsStreamingTokens: true,
    supportsHumanInLoop: false,
    supportsToolConfirmation: true,
    workflowExecution: 'autonomous',
    requires: ['codex>=0.x'],
  };
}

async function prepare() {
  throw new Error(`${id}: not implemented yet (Phase 9).`);
}

async function run() {
  throw new Error(`${id}: not implemented yet (Phase 9).`);
}

async function cancel() { /* no-op */ }
async function dispose() { /* no-op */ }

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
