'use strict';

/**
 * AgentRuntimeDriver — pluggable runtime contract.
 *
 * This file is JSDoc-only; importing it has no runtime effect (empty exports).
 * Driver implementations live alongside this file (directApi.js, claudeCodeVscode.js,
 * claudeCodeCli.js, codex.js). The registry (registry.js) holds the active set;
 * the workflow orchestrator (../workflowOrchestrator.js) is the single entry that
 * IPC handlers call into.
 *
 * Stability contract: spec objects (SubagentSpec, DagSpec, McpServerSpec, PresetSpec)
 * are driver-agnostic. A driver receives a `WorkflowRunSpec` snapshot and is
 * responsible for materializing whatever local resources it needs (tmpdir,
 * agent.md files, mcp-config.json) inside `prepare()`. `run()` MUST emit only
 * `AgentEvent` shaped payloads — never internal stream-json or provider-specific
 * frames.
 */

/**
 * @typedef {object} DriverCapabilities
 * @property {boolean} supportsSubagents          True if the driver can spawn
 *   sub-agents (.claude/agents/*.md or Task spawn). DirectApi is false because
 *   it executes pipeline nodes itself rather than spawning agents.
 * @property {boolean} supportsPerSubagentModel   True if a different model can
 *   be selected per subagent. Claude Code drivers map subagent.tier to the
 *   `model:` frontmatter; DirectApi maps to preset.tiers[tier].model.
 * @property {boolean} supportsMcp                True if stdio MCP servers can
 *   be wired. All current drivers should set true.
 * @property {boolean} supportsStreamingTokens    True if text deltas are
 *   streamed during run (vs. full message at end).
 * @property {boolean} supportsHumanInLoop        True if the run can pause for
 *   user input mid-flight. DirectApi supports via pipeline `human` node;
 *   Claude Code drivers do not (single CLI invocation).
 * @property {boolean} supportsToolConfirmation   True if `tool_use` can be
 *   intercepted for approval before executing. With external drivers this
 *   relies on the MCP server child process intercepting and round-tripping
 *   `awaiting_confirmation` to the main process.
 * @property {'spec'|'autonomous'|'hybrid'} workflowExecution
 *   - 'spec': driver executes the DAG step-by-step (DirectApi).
 *   - 'autonomous': driver hands DAG to LLM as a natural-language guideline;
 *     the LLM self-orchestrates (Claude Code drivers).
 *   - 'hybrid': both modes available depending on options.
 * @property {string[]} requires                  Free-form requirement strings
 *   (e.g. ['claude>=1.5']) — informational only.
 */

/**
 * @typedef {object} AgentEvent
 * @property {string} runId                       Per-run identifier (DAG nodes
 *   share the same runId via pipelineRunId).
 * @property {string=} pipelineRunId              Pipeline run id (DAG mode).
 * @property {string=} nodeId                     DAG node id (DAG mode).
 * @property {string=} subagentId                 Spec-level subagent id.
 * @property {string=} parentToolUseId            For events emitted inside a
 *   sub-agent invocation, the Task tool_use_id of the parent.
 * @property {('queued'|'running'|'text'|'tool_use'|'tool_result'|
 *   'sub_agent_start'|'sub_agent_done'|'awaiting_confirmation'|'awaiting_human'|
 *   'output'|'done'|'error'|'cost'|'gate_decision'|'gate_max_revisions'|
 *   'pipeline_started'|'pipeline_done'|'pipeline_error'|'pipeline_output'|
 *   'node_started'|'node_done'|'node_error')} kind
 * @property {object} data                        Event-shape payload (see kind).
 * @property {number=} ts                         Wall-clock epoch ms (set by
 *   eventBus on emit if not provided).
 */

/**
 * @typedef {object} WorkflowRunSpec
 * @property {string} runId
 * @property {('subagent'|'pipeline')} mode
 * @property {string=} subagentId                 Required when mode='subagent'.
 * @property {object=} dag                        Required when mode='pipeline'.
 *   The full DagSpec snapshot (not just an id) so the driver can run without
 *   re-querying storage mid-flight.
 * @property {object[]=} subagents                Resolved SubagentSpec[] for
 *   every subagent referenced by the DAG (pre-resolved by the orchestrator).
 * @property {object[]=} mcpServers               McpServerSpec[] (defaults to
 *   the built-in 'novel-tools' server).
 * @property {object=} novelContext               { novelId, novelDir } if a
 *   novel is active; null otherwise.
 * @property {string=} userLang                   For systemPrompt template
 *   substitution.
 * @property {object=} presetOverride             Preset to use instead of the
 *   active app preset (DirectApi only).
 * @property {string=} tierOverride               Tier override for single-
 *   subagent mode (e.g. 'opus' to upgrade for one call).
 */

/**
 * @typedef {object} DriverHandle
 * @property {string} driverId                    Owning driver's id.
 * @property {string} runId                       Run id, mirrored.
 * @property {AbortController} abortController    Used by cancel().
 * @property {object=} resources                  Driver-private materialized
 *   resources (tmpdir paths, child handles). Opaque to callers.
 */

/**
 * @typedef {object} DriverInfo
 * @property {string} id
 * @property {string} displayName
 * @property {string} description
 */

/**
 * @typedef {object} AgentRuntimeDriver
 * @property {string} id                          'claude-code-vscode' |
 *   'claude-code-cli' | 'codex' | 'direct-api'
 * @property {string} displayName
 * @property {string} description
 * @property {() => Promise<{available: boolean, reason?: string, version?: string, binPath?: string}>} availability
 * @property {() => DriverCapabilities} capabilities
 * @property {(spec: WorkflowRunSpec) => Promise<DriverHandle>} prepare
 * @property {(handle: DriverHandle, opts: object) => Promise<{output: any, transcript?: any}>} run
 *   The driver MUST emit AgentEvent payloads via eventBus during `run`. The
 *   resolved value is the final output (string for subagent mode, object for
 *   pipeline mode mirroring runPipeline's shape).
 * @property {(handle: DriverHandle) => Promise<void>} cancel
 * @property {(handle: DriverHandle) => Promise<void>=} dispose Optional cleanup
 *   (tmp files, child processes). Orchestrator calls this after `run` returns
 *   or throws.
 */

module.exports = {};
