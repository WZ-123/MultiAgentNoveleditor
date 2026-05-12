'use strict';

/**
 * Chat Agent — built-in agent loop for the AI chat panel.
 *
 * Each chat session maintains its own message history and runs a multi-turn
 * tool-use loop similar to runSubagent.js, but with:
 *   - Dynamic system prompt (editor context injected each turn)
 *   - All MCP tools available (no allowedTools filter)
 *   - Frontend action tools (replace_selected_text, insert_text_at_cursor)
 *   - Subagent delegation (spawn_subagent)
 *
 * Events are emitted via a dedicated IPC channel so the renderer can show
 * streaming text, tool calls, and thinking blocks live.
 */

const { randomUUID } = require('node:crypto');
const providerManager = require('../providerManager');
const modelAliases = require('../modelAliases');
const mcpClient = require('../mcp/mcpClientStdio');
const workflowOrchestrator = require('./workflowOrchestrator');
const eventBus = require('./eventBus');
const skillsStore = require('../store/skills');
const chatHistoryStore = require('../store/chatHistory');
const { webContents } = require('electron');

// ---------- provider resolution ----------

function pickProvider(type) {
  if (type === 'anthropic') return require('./providers/anthropic');
  if (type === 'openai-compat') return require('./providers/openaiCompat');
  throw new Error(`Chat agent unsupported provider type: ${type}`);
}

async function resolveChatProvider() {
  const alias = await modelAliases.getAlias('sonnet');
  const providerId = alias?.providerId || null;
  const provider = providerId
    ? await providerManager.getProvider(providerId)
    : await providerManager.getActiveProvider();
  if (!provider) throw new Error('No provider configured for chat');

  const apiKey = provider.apiKey || '';
  if (!apiKey) throw new Error('Provider API key is missing');

  const modelId = alias?.modelId || provider.models?.[0]?.id || '';
  if (!modelId) throw new Error('No model configured for chat');

  const type = provider.type || 'anthropic';
  return {
    type,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    model: modelId,
    apiKey,
    extra: {
      maxTokens: alias?.maxOutputTokens || 4096,
      temperature: alias?.temperature,
      ...(alias?.thinking ? { thinking: alias.thinking } : {}),
    },
    thinking: alias?.thinking
      ? { type: 'enabled', budget_tokens: alias.thinkingBudget || 16000 }
      : undefined,
  };
}

// ---------- tool lists ----------

const FRONTEND_TOOLS = [
  {
    name: 'replace_selected_text',
    description: 'Replace the text currently selected by the user in the editor with new content.',
    input_schema: {
      type: 'object',
      properties: { replacement: { type: 'string', description: 'The text to insert in place of the selection' } },
      required: ['replacement'],
    },
  },
  {
    name: 'insert_text_at_cursor',
    description: 'Insert text at the current cursor position in the editor.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to insert' } },
      required: ['text'],
    },
  },
  {
    name: 'replace_text_near_cursor',
    description: 'Replace the occurrence of targetText that is closest to the user\'s current cursor position or active selection in the editor. Use this after the user manually places the cursor near the desired occurrence when the same text appears multiple times.',
    input_schema: {
      type: 'object',
      properties: {
        targetText: { type: 'string', description: 'The exact text to replace near the current cursor position' },
        replacement: { type: 'string', description: 'The replacement text' },
      },
      required: ['targetText', 'replacement'],
    },
  },
  {
    name: 'get_full_editor_content',
    description: 'Get the full content of the currently open editor document.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'spawn_subagent',
    description: 'Delegate a task to a specialized subagent (e.g. sa-writer, sa-character-reviewer). The subagent runs with the active runtime driver and returns its output.',
    input_schema: {
      type: 'object',
      properties: {
        subagentId: { type: 'string', description: 'Subagent ID, e.g. sa-writer' },
        input: { type: 'string', description: 'Task description to pass to the subagent' },
      },
      required: ['subagentId', 'input'],
    },
  },
  {
    name: 'set_workflow_phase',
    description: 'Set the current workflow phase. Phases: idle (no project), outline (planning/confirming outline), writing (writing chapters based on confirmed outline), editing (revising existing chapters).',
    input_schema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['idle', 'outline', 'writing', 'editing'] },
        reason: { type: 'string', description: 'Why this phase change' },
      },
      required: ['phase'],
    },
  },
  {
    name: 'confirm_outline',
    description: 'Save the current outline as confirmed and transition to writing phase. Call this AFTER the user has reviewed and confirmed the outline. Saves outline nodes via write_outline_nodes MCP tool.',
    input_schema: {
      type: 'object',
      properties: {
        nodes: { type: 'array', description: 'The outline nodes to save and confirm' },
      },
    },
  },
];

function isFrontendTool(name) {
  return FRONTEND_TOOLS.some((t) => t.name === name);
}

// ---------- sessions ----------

const sessions = new Map();

function sessionMessagesFromHistory(messages) {
  const sessionMessages = [];
  if (!Array.isArray(messages)) return sessionMessages;
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      sessionMessages.push({
        role: m.role,
        content: [{ type: 'text', text: typeof m.text === 'string' ? m.text : String(m.text ?? '') }],
      });
    }
  }
  return sessionMessages;
}

chatHistoryStore.subscribe((event) => {
  if (!event || (event.type !== 'edit' && event.type !== 'revert')) return;
  const branch = chatHistoryStore.getBranch(event.thread);
  const nextMessages = sessionMessagesFromHistory(branch);
  for (const session of sessions.values()) {
    if (session.threadId === event.threadId) {
      session.messages = nextMessages.map((m) => ({
        role: m.role,
        content: m.content.map((block) => ({ ...block })),
      }));
    }
  }
});

function generateId() {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function generatePhase(editorContext) {
  const ctx = editorContext || {};
  if (!ctx.novelId) return 'idle';
  if (ctx.workflowPhase) return ctx.workflowPhase;
  if (ctx.chapterCount > 0) return 'writing';
  if (ctx.hasOutline) return 'outline';
  return 'idle';
}

function createSession({ editorContext, messages, threadId }) {
  const sessionId = generateId();
  const session = {
    sessionId,
    threadId: threadId || null,
    editorContext: editorContext || null,
    workflowPhase: generatePhase(editorContext),
    messages: [],
    abortController: null,
    pendingFrontendAction: null, // { actionId, resolve, reject }
  };
  // Pre-populate from thread history so the AI has conversation context
  session.messages = sessionMessagesFromHistory(messages);
  sessions.set(sessionId, session);
  return sessionId;
}

function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    if (s.abortController) {
      try { s.abortController.abort(); } catch { /* ignore */ }
    }
    sessions.delete(sessionId);
  }
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

// ---------- event emission ----------

function emitEvent(sessionId, kind, data) {
  // Broadcast to all webContents. Renderer filters by sessionId.
  const payload = { sessionId, kind, data, ts: Date.now() };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send('chatAgent:event', payload);
    } catch {
      // renderer may be gone
    }
  }
}

// ---------- phase-aware system prompt ----------

async function loadPhaseSkills(workflowPhase) {
  const phaseSkillIds = {
    outline: ['writing-reference', 'outline-cleanup'],
    writing: ['writing-reference', 'outline-cleanup', 'de-ai-ify'],
    editing: ['writing-reference', 'de-ai-ify'],
  };
  const needed = phaseSkillIds[workflowPhase];
  if (!needed || !needed.length) return '';
  try {
    const all = await skillsStore.listSkills();
    const lines = [];
    for (const skill of all) {
      if (!skill.assignedSubagentIds || !skill.assignedSubagentIds.includes('sa-chat')) continue;
      if (!needed.includes(skill.id)) continue;
      const full = await skillsStore.getSkill(skill.id);
      if (full && full.content) {
        lines.push('');
        lines.push('### ' + full.name);
        lines.push(full.content);
      }
    }
    if (!lines.length) return '';
    return '\n---\n## Reference Materials\n' + lines.join('\n');
  } catch (err) {
    console.error('[chatAgent] skill injection failed:', err.message);
    return '';
  }
}

function generatePhaseRules(phase) {
  switch (phase) {
    case 'idle':
      return [
        '## Rules (Idle — No Active Novel)',
        '1. If the user wants to start a new novel, use the `create_novel` MCP tool to create the project.',
        '2. If the user wants to open an existing novel, use `list_novels` to browse and guide them.',
        '3. Once a novel is active, use `set_workflow_phase({phase:"outline"})` to begin outlining.',
        '4. Respond in the same language as the user.',
      ];
    case 'outline':
      return [
        '## Rules (Outline Phase)',
        '1. Start by calling `read_outline_nodes` to check if an outline already exists.',
        '2. If no outline exists, propose a complete outline with volumes/sections/chapters.',
        '3. Present your outline clearly and wait for the user to review and confirm it.',
        '4. When the user confirms, call `confirm_outline` with the nodes array to save and transition to writing phase.',
        '5. Level field in outline nodes: level=1 for volume, level=2 for section, level=3 for chapter.',
        '6. DO NOT write chapter content in this phase. Only outline planning.',
        '7. Always use tools to inspect state before making changes. Do not guess.',
        '8. Respond in the same language as the user.',
      ];
    case 'writing':
      return [
        '## Rules (Writing Phase — Use Confirmed Outline)',
        '1. Always call `read_outline_nodes` first to see the confirmed outline.',
        '2. Call `get_chapter_naming_rule` to see the naming convention (e.g. "section 3 chapter").',
        '3. Call `suggest_next_chapter_name` to get the next filename and display name.',
        '4. Call `list_chapters` to see existing chapters.',
        '5. Read character context via `read_outline_nodes`, then `read_character` only for needed characters.',
        '6. Call `write_chapter({name:"...", content:"...", title:"..."})` to write the chapter.',
        '7. NEVER use write_outline_nodes for chapter content.',
        '8. AFTER writing each chapter, you MUST do the following in order:',
        '   a. For new timeline events, call `append_timeline`; if you are correcting an existing event by id, call `update_timeline` instead of appending a duplicate.',
        '   b. Call `update_character` for characters whose state changed.',
        '   c. Call `spawn_subagent({subagentId:"sa-lore-updater", input:"Chapter written: <filename>\\n\\n<brief summary>"})` for comprehensive lore update.',
        '9. The chapter list will auto-refresh in the UI after write_chapter.',
        '10. Use `spawn_subagent` for heavy writing or review tasks.',
        '11. Respond in the same language as the user.',
      ];
    case 'editing':
      return [
        '## Rules (Editing Phase)',
        '1. Use `list_chapters` and `read_chapter` to read existing chapters.',
        '2. If the user has explicitly selected text in the editor, use `replace_selected_text` or `insert_text_at_cursor` for targeted edits.',
        '3. If the user wants to revise an existing passage but has not selected text, first use `read_chapter`, then call `replace_chapter_text` with a sufficiently long unique snippet from the chapter.',
        '4. If `replace_chapter_text` reports multiple matches, tell the user to either select the exact target text or place the cursor next to the desired occurrence. Then use `replace_selected_text` or `replace_text_near_cursor` instead of guessing.',
        '5. Use `replace_text_near_cursor` only after the user has manually moved the cursor near the intended occurrence.',
        '6. For bulk rewrites, use `write_chapter` to update the full file.',
        '7. Always use tools to inspect state before making changes.',
        '8. Respond in the same language as the user.',
      ];
    default:
      return [
        '## Rules',
        '1. Always use tools to inspect state before making changes. Do not guess.',
        '2. Respond in the same language as the user.',
      ];
  }
}

async function buildSystemPrompt(editorContext, useDriver, mcpFallbackNovelId, workflowPhase) {
  const ctx = editorContext || {};
  const phase = workflowPhase || 'idle';
  const lines = [
    'You are the interactive writing assistant for Multi-Agent Novel Assistant.',
    '',
    '## Current Editor State',
  ];
  if (ctx.title) {
    lines.push('- Open document: ' + ctx.title);
    lines.push('- Document type: ' + (ctx.type || 'unknown'));
  } else {
    lines.push('- No document is currently open.');
  }
  if (ctx.selectedText) {
    lines.push('- User selected text: """' + ctx.selectedText + '"""');
  }
  if (ctx.novelTitle) {
    lines.push('- Project: ' + ctx.novelTitle);
  }
  if (typeof ctx.chapterCount === 'number') {
    lines.push('- Written chapters: ' + ctx.chapterCount);
  }
  const displayNovelId = ctx.novelId || mcpFallbackNovelId;
  if (displayNovelId) {
    lines.push('- Novel ID: ' + displayNovelId);
  }
  lines.push('- Workflow phase: ' + phase);
  lines.push('');

  // Phase-specific rules
  const phaseRules = generatePhaseRules(phase);
  lines.push.apply(lines, phaseRules);

  // Common tool list
  lines.push('');
  lines.push('## Available Tools');
  lines.push('You can call tools to read/write novel data and manipulate the editor:');
  lines.push('- Character tools: list_characters, read_character, enrich_character');
  lines.push('- Novel data: read_outline, read_outline_nodes, list_chapters, read_chapter, write_chapter, replace_chapter_text, query_world, query_timeline, list_assets, read_asset, read_style_memory, read_skill, search_index');
  lines.push('- Auto-write: grant_asset, revoke_asset, append_timeline, update_timeline, dedupe_timeline, append_summary, append_style_memory');
  lines.push('- Write (requires confirmation): create_character, update_character, update_world, write_chapter, replace_chapter_text');
  lines.push('- Editor: replace_selected_text, replace_text_near_cursor, insert_text_at_cursor, get_full_editor_content');
  lines.push('- Workflow: set_workflow_phase (change current phase), confirm_outline (save outline and enter writing phase)');
  lines.push('- Delegate: spawn_subagent');
  lines.push('- Web: enrich_character (search web for fanwork character info)');
  if (useDriver) {
    lines.push('- Web: WebFetch (fetch a web page), WebSearch (search the web) — via Claude Code driver');
  }

  // Common rules
  lines.push('');
  lines.push('## Common Rules');
  lines.push('1. NEVER use Write, Edit, or Bash to modify novel data files. Use MCP tools for writes.');
  lines.push('2. Use `spawn_subagent` for heavy tasks (drafting, review). Subagents run through the active driver.');
  lines.push('3. Character info: call `list_characters` first, then `read_character` for details.');
  lines.push('4. Web search: use `enrich_character` first. Only use WebFetch/WebSearch as fallback.');
  lines.push('5. Be systematic: break complex requests into steps, use tools to gather facts, then act.');
  lines.push('6. If the user asks to clean up historical duplicate timeline events, use `dedupe_timeline` instead of manually rewriting files.');

  // Inject phase-relevant skills
  const skillBlock = await loadPhaseSkills(phase);
  if (skillBlock) lines.push(skillBlock);

  return lines.join('\n');
}

// ---------- message helpers ----------

function safeStr(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function textContent(text) {
  return { role: 'user', content: [{ type: 'text', text: safeStr(text) }] };
}

function assistantContent(contentBlocks) {
  // Ensure every text block has a string text field
  const blocks = (contentBlocks || []).map((b) => {
    if (b && b.type === 'text') return { ...b, text: safeStr(b.text) };
    return b;
  });
  return { role: 'assistant', content: blocks };
}

function toolResultContent(toolUseId, resultText, isError) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: resultText,
    is_error: !!isError,
  };
}

// ---------- tool execution ----------

async function callMcpTool(name, args) {
  // autoConfirm=true so write tools (update_character, update_world, etc.)
  // proceed without requiring a user confirmation dialog in the chat context.
  const result = await mcpClient.callTool({ name, arguments: args || {}, autoConfirm: true });
  const text = Array.isArray(result?.content)
    ? result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
    : (typeof result === 'string' ? result : JSON.stringify(result ?? ''));
  return { text, isError: !!result?.isError };
}

async function handleFrontendTool(session, toolUse) {
  return new Promise((resolve, reject) => {
    const actionId = `fa-${Date.now().toString(36)}`;
    session.pendingFrontendAction = { actionId, resolve, reject };

    // Notify renderer to execute the action
    emitEvent(session.sessionId, 'frontend_action', {
      actionId,
      name: toolUse.name,
      input: toolUse.input || {},
    });

    // Timeout after 10 min (renderer may be suspended during screen lock)
    const timer = setTimeout(() => {
      if (session.pendingFrontendAction?.actionId === actionId) {
        session.pendingFrontendAction = null;
        reject(new Error('Frontend action timed out'));
      }
    }, 600000);

    // Wrap resolve/reject to clear timer
    const origResolve = resolve;
    const origReject = reject;
    resolve = (v) => { clearTimeout(timer); origResolve(v); };
    reject = (e) => { clearTimeout(timer); origReject(e); };
    session.pendingFrontendAction.resolve = resolve;
    session.pendingFrontendAction.reject = reject;
  });
}

async function handleSpawnSubagent(input, session) {
  const { subagentId, input: subagentInput } = input || {};
  if (!subagentId) throw new Error('spawn_subagent: subagentId required');

  // Route through workflowOrchestrator so the active driver (claude-code or direct-api) is used.
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId,
    input: subagentInput || '',
    novelContext: (() => {
      const ctx = mcpClient.getActiveNovelContext();
      return ctx?.id ? { novelId: ctx.id, novelDir: ctx.dir } : undefined;
    })(),
  });
  return { text: result.output || '', isError: false };
}

// ---------- main turn loop ----------

/**
 * Provider path — the current multi-turn direct-API loop.
 * Used when active driver is 'direct-api' or unavailable.
 */
async function _runTurnViaProvider(session, sessionId, system, userText, abortSignal) {
  const tier = await resolveChatProvider();
  const provider = pickProvider(tier.type);

  let tools;
  for (let retry = 0; retry < 2; retry++) {
    try {
      const allMcp = await mcpClient.listTools();
      const mcpTools = (allMcp || []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
      }));
      // Query MCP server for active novel as fallback (editorContext may be stale
      // due to polling delay between WorkspaceSwitcher and App.jsx state).
      const activeNovelId = session.editorContext?.novelId || mcpClient.getActiveNovel();
      if (!activeNovelId) {
        const allowed = ["read_skill", "create_novel", "list_novels"];
        const filtered = mcpTools.filter((t) => allowed.includes(t.name));
        tools = [...filtered, ...FRONTEND_TOOLS];
      } else {
        tools = [...mcpTools, ...FRONTEND_TOOLS];
      }
      break; // success
    } catch (err) {
      if (retry === 0) {
        console.warn('[chatAgent] mcp.listTools failed, retrying...', err.message);
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.error('[chatAgent] mcp.listTools failed after retry', err);
        tools = [...FRONTEND_TOOLS];
      }
    }
  }

  const maxTurns = 6;
  let turnIdx = 0;
  let lastText = '';
  const toolCalls = [];

  while (turnIdx < maxTurns) {
    if (abortSignal.aborted) throw new DOMException('aborted', 'AbortError');

    // DIAG: log EXACT messages the AI receives
    const diagSlice = session.messages.slice(-3).map(m => ({
      role: m.role,
      text: JSON.stringify(m.content?.[0]?.text ?? '').slice(0, 300),
      contentLen: m.content?.length || 0,
    }));
    console.log('[chatAgent:diag] msgs to AI:', JSON.stringify(diagSlice));

    const result = await provider.sendMessage({
      system,
      messages: session.messages,
      tools,
      tier,
      abortSignal,
      onEvent: (ev) => {
        if (ev.kind === 'text' && ev.data?.delta) {
          emitEvent(sessionId, 'text_delta', { delta: ev.data.delta });
        } else if (ev.kind === 'thinking' && ev.data?.delta) {
          emitEvent(sessionId, 'thinking_delta', { delta: ev.data.delta });
        } else if (ev.kind === 'tool_use') {
          emitEvent(sessionId, 'tool_use', { name: ev.data.name, input: ev.data.input, id: ev.data.id });
        }
      },
    });

    const assistantBlocks = [];
    for (const block of result.content || []) {
      if (block.type === 'text') {
        assistantBlocks.push(block);
        if (block.text) lastText = safeStr(block.text);
      } else if (block.type === 'thinking') {
        assistantBlocks.push(block);
      } else if (block.type === 'tool_use') {
        assistantBlocks.push(block);
      }
    }

    session.messages.push(assistantContent(assistantBlocks));

    const toolUses = (result.content || []).filter((b) => b.type === 'tool_use');
    if (result.stopReason !== 'tool_use' || !toolUses.length) break;

    const toolResults = [];
    for (const use of toolUses) {
      const toolCall = {
        id: use.id,
        name: use.name,
        input: use.input,
        status: 'running',
      };
      let toolResult;
      let isError = false;
      try {
        if (use.name === 'set_workflow_phase') {
          const phase = use.input?.phase;
          if (phase) { session.workflowPhase = phase; }
          toolResult = { text: `Workflow phase changed to "${session.workflowPhase}".`, isError: false };
        } else if (use.name === 'confirm_outline') {
          const nodes = use.input?.nodes;
          if (Array.isArray(nodes) && nodes.length) {
            await callMcpTool('write_outline_nodes', { nodes });
          }
          session.workflowPhase = 'writing';
          toolResult = { text: 'Outline confirmed and saved. Switched to writing phase.', isError: false };
        } else if (isFrontendTool(use.name)) {
          toolResult = await handleFrontendTool(session, use);
        } else if (use.name === 'spawn_subagent') {
          toolResult = await handleSpawnSubagent(use.input, session);
        } else {
          toolResult = await callMcpTool(use.name, use.input);
        }
      } catch (err) {
        toolResult = { text: err.message || String(err), isError: true };
        isError = true;
      }

      emitEvent(sessionId, 'tool_result', {
        name: use.name, text: toolResult.text, isError: toolResult.isError || isError, id: use.id,
      });

      toolCall.status = 'done';
      toolCall.result = toolResult.text;
      toolCall.isError = toolResult.isError || isError;
      toolCalls.push(toolCall);

      toolResults.push(toolResultContent(use.id, toolResult.text, toolResult.isError || isError));
    }

    session.messages.push({ role: 'user', content: toolResults });
    turnIdx += 1;
  }

  return { text: lastText, turns: turnIdx + 1, toolCalls };
}

/**
 * Driver path — route the turn through the active runtime driver.
 * The subagent receives the full conversation history and handles MCP tools
 * internally. Frontend tools are NOT available in this path (the subagent
 * only sees MCP tools registered on the novel-tools server).
 */
async function _runTurnViaDriver(session, sessionId, system, userText, abortSignal) {
  let lastText = '';
  const runId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const toolCallMap = new Map();

  // Subscribe to eventBus events for streaming and forward to renderer
  const unsub = runId ? eventBus.subscribe(runId, (payload) => {
    try {
      if (payload.kind === 'text') {
        // Handle both {delta: '...'} (Anthropic provider) and {text: '...'}
        // (claude-code NDJSON) event formats. Forward as text_delta.
        const delta = safeStr(payload.data?.delta || payload.data?.text || '');
        if (delta) {
          emitEvent(sessionId, 'text_delta', { delta });
          if (payload.data?.text) lastText = safeStr(payload.data.text);
        }
      } else if (payload.kind === 'thinking') {
        emitEvent(sessionId, 'thinking_delta', { delta: payload.data.delta });
      } else if (payload.kind === 'tool_use') {
        const toolId = payload.data?.id || payload.data?.toolUseId || null;
        const toolInput = payload.data?.input ?? payload.data?.arguments;
        const key = toolId || `tool-${toolCallMap.size + 1}`;
        const existing = toolCallMap.get(key) || { id: key };
        toolCallMap.set(key, {
          ...existing,
          id: key,
          name: payload.data.name,
          input: toolInput,
          status: 'running',
        });
        emitEvent(sessionId, 'tool_use', { name: payload.data.name, input: toolInput, id: key });
      } else if (payload.kind === 'output') {
        if (typeof payload.data === 'string') lastText = payload.data;
        else if (payload.data?.text) lastText = safeStr(payload.data.text);
      } else if (payload.kind === 'tool_result') {
        const key = payload.data?.id || payload.data?.toolUseId || `tool-${toolCallMap.size + 1}`;
        const existing = toolCallMap.get(key) || { id: key, name: payload.data?.name || payload.subagentId, input: undefined };
        toolCallMap.set(key, {
          ...existing,
          id: key,
          name: payload.data?.name || existing.name,
          input: existing.input,
          result: typeof payload.data === 'string' ? payload.data : (payload.data?.text || ''),
          isError: !!(payload.data?.isError),
          status: 'done',
        });
        emitEvent(sessionId, 'tool_result', {
          name: payload.data?.name || payload.subagentId,
          text: typeof payload.data === 'string' ? payload.data : (payload.data?.text || ''),
          isError: !!(payload.data?.isError),
          id: key,
        });
      }
    } catch { /* ignore forwarding errors */ }
  }) : () => {};

  // Build a single text prompt from the conversation history.
  // The claude-code driver only accepts string input (buildUserMessage does
  // String(input) which produces '[object Object]' for objects).
  const conversationInput = session.messages.length > 1
    ? session.messages.map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const text = m.content?.[0]?.text || '';
        return `${role}: ${text}`;
      }).join('\n') + '\n---\n' + userText
    : userText;

  try {
    const result = await workflowOrchestrator.runWorkflow({
      mode: 'subagent',
      subagentId: 'sa-chat',
      systemPromptOverride: system,
      input: conversationInput,
      runId,
      novelContext: (() => {
        const ctx = mcpClient.getActiveNovelContext();
        return ctx?.id ? { novelId: ctx.id, novelDir: ctx.dir } : undefined;
      })(),
    });

    lastText = safeStr(result?.output) || lastText;
    return { text: lastText, turns: 1, toolCalls: Array.from(toolCallMap.values()) };
  } finally {
    unsub();
  }
}

async function runTurn(sessionId, userText) {
  const session = getSession(sessionId);
  if (!session) throw new Error('Chat session not found');

  // Defensive: ensure userText is a string.
  if (typeof userText !== 'string') {
    console.error('[chatAgent] runTurn got non-string userText:', typeof userText, userText);
    if (userText && typeof userText === 'object') {
      userText = safeStr(userText);
    } else {
      userText = String(userText ?? '');
    }
  } else if (userText === '[object Object]' || userText === '[object Object]') {
    // Diagnostic: log session state when the infamous [object Object] arrives
    console.error('[chatAgent] DIAG: userText is "[object Object]"', {
      sessionId,
      msgCount: session.messages.length,
      lastMsg: session.messages.length > 0
        ? JSON.stringify(session.messages[session.messages.length - 1]).slice(0, 200)
        : 'none',
    });
  }

  if (session.abortController) {
    try { session.abortController.abort(); } catch { /* ignore */ }
  }
  session.abortController = new AbortController();
  const abortSignal = session.abortController.signal;

  // Auto-detect: use driver path if a non-direct-api driver is active
  let driverId = null;
  try { driverId = await workflowOrchestrator.getActiveDriverId(); } catch { /* ignore */ }
  const useDriver = !!driverId && driverId !== 'direct-api';
  const system = await buildSystemPrompt(session.editorContext, useDriver, mcpClient.getActiveNovel(), session.workflowPhase);

  session.messages.push(textContent(userText));

  emitEvent(sessionId, 'turn_start', { userText });

  try {
    let result;
    if (useDriver) {
      // Driver path: agent runs through Claude Code with WebFetch/WebSearch built-in tools.
      // Novel data MCP tools are available via the novel-tools MCP server.
      result = await _runTurnViaDriver(session, sessionId, system, userText, abortSignal);
      session.messages.push(assistantContent([{ type: 'text', text: result.text || '' }]));
    } else {
      // Direct-API path: provider manages the multi-turn loop and pushes
      // assistant + tool messages directly into session.messages.
      // MCP tools and frontend tools are both available.
      result = await _runTurnViaProvider(session, sessionId, system, userText, abortSignal);
    }

    emitEvent(sessionId, 'turn_done', { text: result.text, turns: result.turns });

    // Persist to chat history from main process (await — ensure on disk
    // before this turn completes, so panel remounts always find the data).
    if (session.threadId && (result.text || (Array.isArray(result.toolCalls) && result.toolCalls.length > 0))) {
      try {
        await chatHistoryStore.appendMessage(session.threadId, {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          text: result.text || '',
          timestamp: Date.now(),
          isStreaming: false,
          edited: false,
          toolCalls: Array.isArray(result.toolCalls) && result.toolCalls.length > 0 ? result.toolCalls : null,
        });
      } catch { /* best-effort */ }
    }
  } catch (err) {
    const msg = err?.message || String(err);
    emitEvent(sessionId, 'error', { message: msg });
    throw err;
  } finally {
    session.abortController = null;
  }
}

// ---------- frontend action resolution ----------

function resolveFrontendAction(sessionId, actionId, result) {
  const session = getSession(sessionId);
  if (!session) return false;
  const pending = session.pendingFrontendAction;
  if (!pending || pending.actionId !== actionId) return false;
  session.pendingFrontendAction = null;
  let text = '';
  let isError = false;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    text = typeof result.text === 'string' ? result.text : JSON.stringify(result.text ?? result);
    isError = !!result.isError;
  } else {
    text = typeof result === 'string' ? result : JSON.stringify(result);
    isError = typeof text === 'string' && text.startsWith('Frontend action failed:');
  }
  pending.resolve({ text, isError });
  return true;
}

// ---------- cancel ----------

function cancelTurn(sessionId) {
  const session = getSession(sessionId);
  if (session?.abortController) {
    try { session.abortController.abort(); } catch { /* ignore */ }
  }
}

module.exports = {
  createSession,
  closeSession,
  getSession,
  runTurn,
  cancelTurn,
  resolveFrontendAction,
};
