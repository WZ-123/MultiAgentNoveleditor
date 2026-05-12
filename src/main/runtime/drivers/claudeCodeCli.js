'use strict';

/**
 * claude-code-cli driver — Phase 5 stub.
 *
 * Reports unavailable until Phase 8 lands the real implementation. Will share
 * Phase 7's helpers (agentMdWriter, mcpConfigGen, streamJsonParser, dagToPrompt,
 * claudeProcess) — only differs in binPath detection (PATH lookup vs VSCode
 * extension dir scan).
 */

const id = 'claude-code-cli';
const displayName = 'Claude Code (Standalone CLI)';
const description = 'Run workflows through the standalone `claude` CLI on your $PATH. Phase 8 implementation.';

async function availability() {
  return {
    available: false,
    reason: 'Phase 8 — implementation pending. Stub registered for UI ordering.',
  };
}

function capabilities() {
  return {
    supportsSubagents: true,
    supportsPerSubagentModel: true,
    supportsMcp: true,
    supportsStreamingTokens: true,
    supportsHumanInLoop: false,
    supportsToolConfirmation: true,
    workflowExecution: 'autonomous',
    requires: ['claude>=1.5'],
  };
}

async function prepare() {
  throw new Error(`${id}: not implemented yet (Phase 8).`);
}

async function run() {
  throw new Error(`${id}: not implemented yet (Phase 8).`);
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
