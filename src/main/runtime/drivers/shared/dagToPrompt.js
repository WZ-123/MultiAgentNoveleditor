'use strict';

/**
 * dagToPrompt — turn a DagSpec into a natural-language workflow guideline
 * appended to Claude Code's system prompt via `--append-system-prompt`.
 *
 * Why a guideline (not a strict program): autonomous drivers (Claude Code
 * family) hand the DAG to the LLM and let it decide whether to follow each
 * step. The LLM is more reliable when the structure is plain English than
 * when it's encoded as machine instructions, especially around edge cases
 * (a reviewer reports issues → revise OR proceed?).
 *
 * The output deliberately includes the line:
 *   "(you may follow strictly or deviate when sensible — but stay within the spirit)"
 * to give the LLM permission to be flexible. This matches the user's
 * stated intent that the app provides workflow guidance to Claude Code,
 * not a rigid execution plan.
 */

// Claude Code 2.x renamed the sub-agent dispatcher from `Task` to `Agent`.
// The prose still mentions both names so older Claude Code builds aren't
// confused; the parser and allowedTools whitelist accept either.
const TASK_TOOL = 'Agent';
const MCP_PREFIX = 'mcp__novel-tools__';

/**
 * @param {object} dag           DagSpec
 * @param {object[]} subagents   Resolved SubagentSpec[] referenced by the DAG.
 *                                Only entries referenced by `kind:'subagent'`
 *                                nodes need to be present.
 * @param {object=} opts
 * @param {string=} opts.cwd               Tmpdir where .claude/agents/ lives.
 * @param {string=} opts.userLang          Default 'zh-CN'.
 * @param {string=} opts.mcpServer         Default 'novel-tools'.
 * @returns {string}
 */
function dagToPrompt(dag, subagents = [], opts = {}) {
  if (!dag || !Array.isArray(dag.nodes)) {
    throw new Error('dagToPrompt: dag.nodes required');
  }
  const cwd = opts.cwd || '<working directory>';
  const userLang = opts.userLang || 'zh-CN';
  const mcpServer = opts.mcpServer || 'novel-tools';
  const mcpPrefix = `mcp__${mcpServer}__`;

  // Index helpers
  const nodesById = new Map(dag.nodes.map((n) => [n.id, n]));
  const subagentByName = new Map();
  const subagentById = new Map();
  for (const sa of subagents || []) {
    if (!sa) continue;
    if (sa.name) subagentByName.set(sa.name, sa);
    if (sa.id) subagentById.set(sa.id, sa);
  }

  // For the `subagent` node kind, the spec field is `subagentId`. Built-in
  // subagent ids match their `name` field today (e.g. 'sa-outline-drafter')
  // but we still resolve via id-first then name as a fallback.
  function resolveSubagentForNode(node) {
    if (!node || node.kind !== 'subagent') return null;
    return subagentById.get(node.subagentId)
      || subagentByName.get(node.subagentId)
      || null;
  }

  // Collect all subagent nodes used in the DAG (for the "Available sub-agents" block).
  const usedSubagents = new Map(); // name → SubagentSpec
  for (const node of dag.nodes) {
    if (node.kind !== 'subagent') continue;
    const sa = resolveSubagentForNode(node);
    if (!sa) continue;
    if (!usedSubagents.has(sa.name || sa.id)) {
      usedSubagents.set(sa.name || sa.id, sa);
    }
  }

  // ---------- header ----------
  const stage = dag.stage || 'workflow';
  const lines = [];
  lines.push(`You are orchestrating a novel ${stage} workflow ("${dag.name || dag.id}").`);
  lines.push('');

  // ---------- available sub-agents ----------
  if (usedSubagents.size > 0) {
    lines.push('Available sub-agents — call each via the `Agent` tool (Claude Code 1.x: `Task`) with `subagent_type: <name>`:');
    for (const sa of usedSubagents.values()) {
      const desc = (sa.displayName || sa.name || '').replace(/\s+/g, ' ').trim();
      const tools = Array.isArray(sa.allowedTools) && sa.allowedTools.length
        ? sa.allowedTools.map((t) => mcpPrefix + t).join(', ')
        : '(no MCP tools)';
      const tierHint = sa.tier ? ` [tier=${sa.tier}]` : '';
      lines.push(`- \`${sa.name || sa.id}\`${tierHint}: ${desc || '(no description)'}`);
      lines.push(`    allowed MCP tools: ${tools}`);
    }
    lines.push('');
  }

  // ---------- workflow guideline (numbered, derived from DAG topology) ----------
  const guideline = renderGuideline(dag, nodesById, resolveSubagentForNode);
  if (guideline.length > 0) {
    lines.push('Workflow guideline (you may follow strictly or deviate when sensible — but stay within the spirit):');
    for (let i = 0; i < guideline.length; i += 1) {
      lines.push(`${i + 1}. ${guideline[i]}`);
    }
    lines.push('');
  }

  // ---------- maxRevisions cap ----------
  const maxRevisions = dag?.config?.maxRevisions;
  if (maxRevisions != null) {
    lines.push(`Revision cap: at most ${maxRevisions} revision cycles per gate. After that, pass through and let the user decide.`);
    lines.push('');
  }

  // ---------- tools ----------
  lines.push('Tools you may use:');
  lines.push(`- \`${TASK_TOOL}\` — to spawn the sub-agents listed above`);
  lines.push(`- \`${mcpPrefix}*\` — MCP tools for the novel data store (timeline, characters, world, outline, etc.)`);
  lines.push('- `Read`, `Grep` — filesystem helpers within the working directory');
  lines.push('');

  // ---------- environment ----------
  lines.push(`You are running with cwd = ${cwd}. Sub-agent definitions live in \`.claude/agents/*.md\` inside this cwd.`);
  lines.push('Each sub-agent declares its allowed tools in its own frontmatter — respect those scopes.');
  lines.push('');

  // ---------- language hint ----------
  lines.push(`Default response language: ${userLang}. Match the user's input language when it differs.`);

  return lines.join('\n');
}

/**
 * Best-effort topological walk to produce numbered workflow steps.
 * - subagent → "Call sub-agent X (...)"
 * - parallel → "In parallel, dispatch via Task: Y, Z"
 * - gate    → "Gate (no_issues): if reviewers report no issues, proceed; otherwise revise"
 * - human   → "Pause and present current state to the user; await their direction"
 * - output  → "Present the final result to the user"
 *
 * If the DAG has cycles (revision loops), we follow forward edges and skip
 * back-edges — the maxRevisions cap is mentioned separately above.
 */
function renderGuideline(dag, nodesById, resolveSubagentForNode) {
  const out = [];
  const visited = new Set();
  const entries = Array.isArray(dag.entryNodeIds) && dag.entryNodeIds.length
    ? dag.entryNodeIds
    : [dag.nodes[0]?.id].filter(Boolean);

  // Build adjacency
  const adj = new Map(); // nodeId -> [{to, when}]
  for (const e of dag.edges || []) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push({ to: e.to, when: e.when || null });
  }

  // BFS
  const queue = [...entries];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodesById.get(id);
    if (!node) continue;

    out.push(describeNode(node, dag, nodesById, resolveSubagentForNode));

    const outs = adj.get(id) || [];
    for (const e of outs) {
      // Skip pure back-edges (revision loops). The maxRevisions footer covers
      // that mechanic; including back-edges in the linear narrative is
      // confusing.
      if (visited.has(e.to)) continue;
      queue.push(e.to);
    }
  }
  return out;
}

function describeNode(node, dag, nodesById, resolveSubagentForNode) {
  switch (node.kind) {
    case 'subagent': {
      const sa = resolveSubagentForNode(node);
      const name = sa?.name || node.subagentId || '(unknown)';
      const desc = sa?.displayName || node.label || '';
      const tier = node.tierOverride || sa?.tier;
      const tierTxt = tier ? ` (tier=${tier})` : '';
      return `Call sub-agent \`${name}\`${tierTxt} via the \`${TASK_TOOL}\` tool. Purpose: ${desc || 'see frontmatter'}.`;
    }
    case 'parallel': {
      const children = (node.children || []).map((cid) => {
        const child = nodesById.get(cid);
        if (!child || child.kind !== 'subagent') return null;
        const sa = resolveSubagentForNode(child);
        return sa?.name || child.subagentId || cid;
      }).filter(Boolean);
      if (children.length === 0) return `Parallel step ${node.id} (no resolvable children).`;
      return `In parallel, dispatch via \`${TASK_TOOL}\`: ${children.map((c) => `\`${c}\``).join(', ')}. Wait for all to return before proceeding.`;
    }
    case 'gate': {
      if (node.expr === 'no_issues') {
        return 'Gate: if every upstream reviewer returned an empty `issues` array (or equivalent ok-signal), proceed. Otherwise, send the issues back to the prior drafter for revision.';
      }
      return `Gate (${node.expr || 'custom'}): evaluate the upstream output and branch accordingly.`;
    }
    case 'human':
      return 'Pause and present the current state in plain text. Wait for the user to confirm or redirect before continuing.';
    case 'output':
      return 'Present the final result to the user via your normal text output. Include any reviewer reports as appendix sections.';
    default:
      return `Step ${node.id} (${node.kind || 'unknown'}): ${node.label || ''}`.trim();
  }
}

module.exports = {
  dagToPrompt,
  // exported for testing
  renderGuideline,
  describeNode,
};
