'use strict';

/**
 * agentMdWriter — serialize SubagentSpec[] into Claude Code's
 * `.claude/agents/<name>.md` format.
 *
 * Each file has YAML frontmatter understood by Claude Code:
 *   ---
 *   name: <subagent.name>
 *   description: <subagent.displayName>
 *   tools: <comma-separated allowed tools, MCP-prefixed>
 *   model: <claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5-20251001>
 *   ---
 *   <subagent.systemPrompt with {{userLang}} substituted>
 *
 * Filename = `<subagent.name>.md`. We trust the name field; SubagentEditor
 * already validates that it matches /^[a-z][a-z0-9-]*$/ via builtIn lock.
 *
 * The function is pure-ish: it writes files into `agentsDir`, returns the
 * absolute paths that were written. Idempotent — overwrites stale files.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const modelConfig = require('../../../modelConfig');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ---- MCP server name (must match mcpConfigGen.js) ----
const MCP_SERVER_NAME = 'novel-tools';

// ---- Built-in Claude Code tools the orchestrator agents typically need ----
//
// 'Task' is required for sub-agent spawning in autonomous mode (the parent
// agent uses Task to delegate to leaf sub-agents). Read/Grep are convenience
// helpers for inspecting the working tmpdir. We do NOT include Bash, Write,
// or Edit by default — those would let the LLM modify files outside the
// MCP store, defeating the workflow's structure.
// Claude Code built-in tools available to agents in driver mode.
// WebSearch/WebFetch are pre-approved via .claude/settings.json (written by
// the driver before spawning Claude Code), so they don't need user interaction.
const DEFAULT_BUILTIN_TOOLS = ['Read', 'Grep', 'WebFetch', 'WebSearch'];

async function mapTierToModel(tier, opts = {}) {
  try {
    const targets = await modelConfig.resolveTargets({
      driverId: opts.driverId || 'claude-code-vscode',
      subagentId: opts.subagentId,
      modelProfileId: opts.modelProfileId,
      legacyTier: tier,
    });
    return targets[0]?.target?.modelId || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/**
 * Build the comma-separated tools list for the frontmatter.
 *
 * @param {string[]} allowedTools  Bare MCP tool names from SubagentSpec.allowedTools
 * @param {object} opts
 * @param {string=} opts.mcpServer  Override MCP server name (default 'novel-tools')
 * @param {string[]=} opts.builtins  Override built-in Claude Code tools list
 * @returns {string}
 */
function buildToolsList(allowedTools, opts = {}) {
  const server = opts.mcpServer || MCP_SERVER_NAME;
  const builtins = opts.builtins || DEFAULT_BUILTIN_TOOLS;
  const mcpTools = (allowedTools || []).map((t) => `mcp__${server}__${t}`);
  // Order: built-ins first (the user reading the file expects familiar names
  // up front), then MCP tools alphabetized for stable diffs across runs.
  const merged = [...builtins, ...mcpTools.sort()];
  return merged.join(', ');
}

/**
 * Substitute template variables in systemPrompt:
 *   {{userLang}} → 'zh-CN' (or whatever was passed)
 *
 * Keep the substitution conservative — only the well-known placeholders
 * are replaced, so a stray `{{x}}` in the prompt body doesn't disappear.
 */
function applyTemplate(systemPrompt, vars) {
  if (!systemPrompt) return '';
  let out = String(systemPrompt);
  out = out.replace(/\{\{userLang\}\}/g, vars.userLang || 'zh-CN');
  return out;
}

/**
 * Render a single SubagentSpec to agent.md content.
 *
 * @param {object} subagent SubagentSpec
 * @param {object} opts
 * @param {string=} opts.userLang
 * @param {string=} opts.mcpServer
 * @param {string[]=} opts.builtins
 * @returns {string} Full file contents
 */
async function renderAgentMd(subagent, opts = {}) {
  if (!subagent || !subagent.name) {
    throw new Error('renderAgentMd: subagent.name required');
  }
  const description = subagent.displayName || subagent.name;
  const tools = buildToolsList(subagent.allowedTools, opts);
  const model = await mapTierToModel(subagent.tier, {
    driverId: opts.driverId,
    subagentId: subagent.id,
    modelProfileId: opts.modelProfileId,
  });
  const body = applyTemplate(subagent.systemPrompt, { userLang: opts.userLang });

  // YAML frontmatter — keep field order stable for diff readability.
  const lines = [
    '---',
    `name: ${subagent.name}`,
    // description must be a single line — fold any newline into a space.
    `description: ${String(description).replace(/\s*\n\s*/g, ' ')}`,
  ];
  if (tools) lines.push(`tools: ${tools}`);
  lines.push(`model: ${model}`);
  lines.push('---', '');
  lines.push(body);
  return lines.join('\n');
}

/**
 * Write all subagents into `<agentsDir>/<name>.md`. Creates the directory
 * if missing. Removes stale files in agentsDir that no longer match any
 * subagent in the current set (so a removed subagent stops being injected
 * on the next run).
 *
 * @param {string} agentsDir  Absolute path; should typically be `<tmpdir>/.claude/agents`.
 * @param {object[]} subagents
 * @param {object=} opts  Forwarded to renderAgentMd.
 * @returns {Promise<{written: string[], removed: string[]}>}
 */
async function writeAgentsDir(agentsDir, subagents, opts = {}) {
  await fs.mkdir(agentsDir, { recursive: true });

  const desiredNames = new Set();
  const written = [];
  for (const sa of subagents || []) {
    if (!sa || !sa.name) continue;
    const file = path.join(agentsDir, `${sa.name}.md`);
    const content = await renderAgentMd(sa, opts);
    await fs.writeFile(file, content, 'utf8');
    written.push(file);
    desiredNames.add(`${sa.name}.md`);
  }

  // Sweep stale .md files. Only touch *.md so we don't accidentally remove
  // a user's hand-written agent that happens to live in this dir (unlikely
  // since it's a tmpdir, but be defensive).
  const removed = [];
  let entries = [];
  try { entries = await fs.readdir(agentsDir); } catch { /* dir empty */ }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (desiredNames.has(name)) continue;
    try {
      await fs.unlink(path.join(agentsDir, name));
      removed.push(path.join(agentsDir, name));
    } catch { /* ignore */ }
  }

  return { written, removed };
}

module.exports = {
  DEFAULT_MODEL,
  MCP_SERVER_NAME,
  DEFAULT_BUILTIN_TOOLS,
  mapTierToModel,
  buildToolsList,
  applyTemplate,
  renderAgentMd,
  writeAgentsDir,
};
