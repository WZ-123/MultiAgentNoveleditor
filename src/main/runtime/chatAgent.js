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
const { getActiveNovelContext } = require('./activeNovelContext');
const skillsStore = require('../store/skills');
const chatHistoryStore = require('../store/chatHistory');
const { searchWeb, fetchWebPage, fetchBestPage } = require('../import/searchEngine');
const { generateOutlineDraft } = require('./outlineDraftService');
const { detectOutlineChatIntent, detectOutlineConfirmIntent } = require('./outlineIntent');
const chapterDraftService = require('./chapterDraftService');
const chapterRoleplayService = require('./chapterRoleplayService');
const { detectChapterChatIntent, detectChapterConfirmIntent } = require('./chapterIntent');
const { splitIntoParagraphs } = require('./chapterCharacterReview');
const { buildSystemTimePromptBlock, getSystemTimeInfo } = require('./systemTime');
const appConfig = require('../store/appConfig');
const { webContents } = require('electron');

// ---------- provider resolution ----------

function pickProvider(type) {
  if (type === 'anthropic') return require('./providers/anthropic');
  if (type === 'openai-compat') return require('./providers/openaiCompat');
  throw new Error(`Chat agent unsupported provider type: ${type}`);
}

async function resolveChatProvider() {
  const alias = await modelAliases.getAlias('opus');
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
      maxTokens: alias?.maxOutputTokens || 8192,
      temperature: alias?.temperature,
      ...(alias?.thinking ? { thinking: alias.thinking } : {}),
    },
    thinking: alias?.thinking
      ? { type: 'enabled', budget_tokens: alias.thinkingBudget || 16000 }
      : undefined,
  };
}

// ---------- tool lists ----------

const BUILTIN_BACKEND_TOOLS = [
  {
    name: 'set_workflow_phase',
    description: 'Change the current workflow phase for this chat session.',
    input_schema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'The next workflow phase',
          enum: ['idle', 'outline', 'writing', 'editing'],
        },
      },
      required: ['phase'],
    },
  },
  {
    name: 'confirm_outline',
    description: 'Confirm the current outline draft, save it, and switch the workflow to writing.',
    input_schema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'Optional outline nodes to save. Omit to use the pending outline draft stored in the session.',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
  },
  {
    name: 'spawn_subagent',
    description: 'Delegate a heavier task to a configured subagent and return its output.',
    input_schema: {
      type: 'object',
      properties: {
        subagentId: { type: 'string', description: 'The configured subagent identifier to run' },
        input: { type: 'string', description: 'The instruction or context passed to the subagent' },
      },
      required: ['subagentId'],
    },
  },
];

// Only renderer-executed editor actions belong here.
// isFrontendTool() uses this list to decide routing, so backend-only tools
// must stay in BUILTIN_BACKEND_TOOLS instead of being added here.
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
];

const WEB_TOOLS = [
  {
    name: 'WebSearch',
    description: 'Search the public web and return relevant results. If a wiki/encyclopedia page is found, its content is automatically fetched and included in the result. You do not need to call WebFetch separately for URLs returned by WebSearch.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        preferredEngine: {
          type: 'string',
          description: 'Optional source preference.',
          enum: ['auto', 'all', 'moegirl', 'wikipedia', 'bing', 'duckduckgo'],
        },
        maxResults: { type: 'number', description: 'Optional maximum number of results to return.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a public URL and return a cleaned plain-text excerpt.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        maxChars: { type: 'number', description: 'Optional maximum number of characters to return.' },
      },
      required: ['url'],
    },
  },
];

const DIRECT_API_CHAT_TOOLS = [...BUILTIN_BACKEND_TOOLS, ...FRONTEND_TOOLS, ...WEB_TOOLS];

function isFrontendTool(name) {
  return FRONTEND_TOOLS.some((t) => t.name === name);
}

function isWebTool(name) {
  return WEB_TOOLS.some((t) => t.name === name);
}

// ---------- sessions ----------

const sessions = new Map();

function sessionMessagesFromHistory(messages) {
  const sessionMessages = [];
  if (!Array.isArray(messages)) return sessionMessages;
  for (const m of messages) {
    if (m.role === 'user') {
      sessionMessages.push({
        role: 'user',
        content: [{ type: 'text', text: typeof m.text === 'string' ? m.text : String(m.text ?? '') }],
      });
    } else if (m.role === 'assistant') {
      const content = [{ type: 'text', text: typeof m.text === 'string' ? m.text : String(m.text ?? '') }];
      if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input || {},
          });
        }
      }
      sessionMessages.push({ role: 'assistant', content });
      // Reconstruct tool_result blocks immediately after the assistant message.
      // The API requires every tool_use to have a corresponding tool_result in
      // the very next message.
      if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        const toolResults = m.toolCalls.map((tc) => ({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result ?? ''),
          is_error: !!tc.isError,
        }));
        sessionMessages.push({ role: 'user', content: toolResults });
      }
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
    pendingOutlineDraft: null,
    pendingOutlineIssues: [],
    pendingChapterDraft: null,
    pendingChapterIssues: [],
    pendingRoleplayProfileGate: null,
    pendingRoleplayProfileProposal: null,
    pendingDeAiChapterReview: null,
    pendingWriteChapter: null, // { name, title, content, volumeIndex, sectionIndex, baseContent, toolUseId }
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

function generatePhaseRules(phase, { useDriver = false } = {}) {
  switch (phase) {
    case 'idle':
      return [
        '## Rules (Idle — No Active Novel)',
        '1. If the user wants to start a new novel, use the `create_novel` MCP tool to create the project.',
        '2. If the user wants to open an existing novel, use `list_novels` to browse and guide them.',
        useDriver
          ? '3. Once a novel is active, begin outlining directly; do not reference tools that are not actually exposed in this runtime.'
          : '3. Once a novel is active, use `set_workflow_phase({phase:"outline"})` to begin outlining.',
        '4. Respond in the same language as the user.',
      ];
    case 'outline':
      return [
        '## Rules (Outline Phase)',
        '1. Start by calling `read_outline_nodes` to check if an outline already exists.',
        '2. If a pending outline draft already exists in session, treat that draft as the current source of truth until the user discards or confirms it.',
        '3. If no outline exists, propose a complete outline with volumes/sections/chapters.',
        '4. Present your outline clearly and wait for the user to review and confirm it.',
        useDriver
          ? '5. When the user confirms, finalize the outline clearly in your reply. Do not mention `confirm_outline` unless that tool is actually available.'
          : '5. When the user confirms, call `confirm_outline`. If a pending outline draft exists in session, you may call it without reconstructing nodes from memory.',
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
        '6. To write a chapter, first present the chapter plan (name, title, approximate word count, key plot points) and explicitly ask: "确认要写入这一章吗？" You MUST wait for the user to click "确认写入" before making the write_chapter call.',
        '7. NEVER call `write_chapter` without explicit user confirmation. The write_chapter tool is gated and will be blocked until the user manually approves it.',
        useDriver
          ? '8. For chapters longer than ~2000 words, use the `Agent` tool (Claude Code 1.x may surface it as `Task`) to generate the full chapter text so it is not truncated by the chat turn token limit. Then call `write_chapter` with the generated result.'
          : '8. For chapters longer than ~2000 words, use `spawn_subagent` to generate the full chapter text so it is not truncated by the chat turn token limit. Then call `write_chapter` with the generated result.',
        '9. NEVER use write_outline_nodes for chapter content.',
        '10. AFTER `write_chapter` succeeds, the app automatically syncs summary, chapter-scoped timeline, outline write status, and runs `review_de_ai_style`; do not duplicate those automatic calls unless the user asks for a manual correction.',
        '   a. If you later correct timeline events manually, call `update_timeline` for existing ids instead of appending duplicates.',
        '   b. Call `update_character` only for durable character state changes that are not captured by the automatic chapter summary.',
        useDriver
          ? '   c. Call the `Agent` tool (Claude Code 1.x may surface it as `Task`) with subagent `sa-lore-updater` for comprehensive lore update.'
          : '   c. Call `spawn_subagent({subagentId:"sa-lore-updater", input:"Chapter written: <filename>\\n\\n<brief summary>"})` for comprehensive lore update.',
        '11. The chapter list will auto-refresh in the UI after write_chapter.',
        useDriver
          ? '12. Use the `Agent` tool for heavy writing or review tasks.'
          : '12. Use `spawn_subagent` for heavy writing or review tasks.',
        '13. Respond in the same language as the user.',
      ];
    case 'editing':
      return [
        '## Rules (Editing Phase)',
        '1. Use `list_chapters` and `read_chapter` to read existing chapters.',
        useDriver
          ? '2. If the user has explicitly selected text in the editor, treat that selection as authoritative context, but use chapter MCP tools such as `replace_chapter_text` or `apply_chapter_patch` because direct editor action tools are not exposed in this runtime.'
          : '2. If the user has explicitly selected text in the editor, use `replace_selected_text` or `insert_text_at_cursor` for targeted edits.',
        useDriver
          ? '2a. If the user asks to "去 AI 味" / "去套话" / "润色得更像人写" and Current Editor State includes `User selected text`, rewrite only that selected span and apply it with anchored chapter tools. Do not mention `replace_selected_text` unless it is actually available.'
          : '2a. If the user asks to "去 AI 味" / "去套话" / "润色得更像人写" and Current Editor State includes `User selected text`, prefer `de_ai_ify` on that selected text first, then apply the result with `replace_selected_text`.',
        '2b. If the user asks to check character consistency / OOC / 人设冲突 in the current chapter, prefer `review_character_consistency` first and report paragraph-level findings before making any edits.',
        '2c. If the user asks you to审查章节里的 AI 味 / 套话 / 八股 / 机翻腔, you must use `review_de_ai_style` first. Do not claim that you manually reviewed the chapter without calling the tool.',
        '3. If the user wants to revise an existing passage but has not selected text, first use `read_chapter`, then call `replace_chapter_text` with a sufficiently long snippet plus nearby `beforeContext`/`afterContext` from the same chapter so the edit stays anchored like an IDE patch.',
        useDriver
          ? '4. If `replace_chapter_text` reports multiple matches, tell the user to either select the exact target text or give nearby context, then retry with a longer anchored snippet. Do not reference editor-only tools that are not exposed here.'
          : '4. If `replace_chapter_text` reports multiple matches, tell the user to either select the exact target text or place the cursor next to the desired occurrence. Then use `replace_selected_text` or `replace_text_near_cursor` instead of guessing.',
        useDriver
          ? '5. When duplicate matches remain ambiguous in this runtime, ask for clearer nearby context and retry with a more specific anchored edit.'
          : '5. Use `replace_text_near_cursor` only after the user has manually moved the cursor near the intended occurrence.',
        '6. If you need multiple non-overlapping fixes in the same chapter, prefer `apply_chapter_patch` so every edit is resolved against one shared snapshot and written once.',
        '7. For review-style requests, do not batch many overlapping `replace_chapter_text` calls immediately after the audit. Review first; if multiple fixes are needed, prefer scoped selected-text edits, `apply_chapter_patch`, or one consolidated rewrite.',
        '8. For bulk rewrites, use `write_chapter` to update the full file, and include `baseContent` when rewriting an existing chapter from a prior read.',
        '9. For partial world-building changes, prefer `apply_world_patch`; use `update_world` only when replacing the whole lore block or the whole places array.',
        '10. For multiple asset grant/revoke changes, prefer `apply_asset_patch` so all authorization updates are resolved against one shared asset snapshot and written once. When working from a prior `read_asset`, include `baseGrantedTo` for that asset.',
        '11. Always use tools to inspect state before making changes.',
        '12. Respond in the same language as the user.',
      ];
    default:
      return [
        '## Rules',
        '1. Always use tools to inspect state before making changes. Do not guess.',
        '2. Respond in the same language as the user.',
      ];
  }
}

function buildAvailableToolLines({ useDriver = false, hasActiveNovel = false } = {}) {
  const lines = [];
  if (hasActiveNovel) {
    lines.push('- Character tools: list_characters, read_character, read_character_memory, patch_character_memory, enrich_character');
    lines.push('- Novel data: read_outline, read_outline_nodes, list_chapters, read_chapter, write_chapter, replace_chapter_text, apply_chapter_patch, query_world (preferred) / read_world (legacy alias), apply_world_patch, query_timeline, list_assets, read_asset, read_style_memory, read_skill, list_skills, read_skill_content, search_index');
    lines.push('- Review: review_character_consistency (inspect chapter paragraphs against character cards and report paragraph-level conflicts without editing), review_de_ai_style (inspect one or more chapters for AI-ish cliches and mechanical prose without editing)');
    lines.push('- Rewrite: de_ai_ify (rewrite a Chinese fiction passage to remove AI-ish cliches while preserving meaning)');
    lines.push('- Auto-write: grant_asset, revoke_asset, apply_asset_patch, append_timeline, update_timeline, dedupe_timeline, append_summary, append_style_memory');
    lines.push('- Write (requires confirmation): create_character, update_character, update_world, apply_world_patch, write_chapter, replace_chapter_text, apply_chapter_patch');
  } else {
    lines.push('- Bootstrap: create_novel, list_novels, read_skill, list_skills, read_skill_content, de_ai_ify');
  }
  lines.push('- Time: get_system_time (preferred whenever you need the current local date/time)');

  if (useDriver) {
    lines.push('- Delegate: Agent (Claude Code builtin subagent tool; Claude Code 1.x may surface it as Task)');
  } else {
    lines.push('- Editor: replace_selected_text, replace_text_near_cursor, insert_text_at_cursor, get_full_editor_content');
    lines.push('- Workflow: set_workflow_phase (change current phase)' + (hasActiveNovel ? ', confirm_outline (save outline and enter writing phase)' : ''));
    lines.push('- Delegate: spawn_subagent');
  }

  lines.push(`- Web: ${hasActiveNovel ? 'enrich_character, ' : ''}WebFetch (fetch a web page), WebSearch (search the web)`);
  return lines;
}

function buildCommonRules({ useDriver = false, hasActiveNovel = false } = {}) {
  const lines = [
    '## Common Rules',
    '1. NEVER use Write, Edit, or Bash to modify novel data files. Use MCP tools for writes.',
    useDriver
      ? '2. Use the `Agent` tool for heavy drafting or review tasks when delegation is needed.'
      : '2. Use `spawn_subagent` for heavy tasks (drafting, review). Subagents run through the active driver.',
    hasActiveNovel
      ? '3. Character info: call `list_characters` first, then `read_character` for details.'
      : '3. Without an active novel, do not reference chapter/character/world MCP tools that are not currently exposed. Bootstrap the project first.',
    hasActiveNovel
      ? '4. Web search: use `enrich_character` first when character enrichment is available. Otherwise use WebFetch/WebSearch directly.'
      : '4. Web search: use WebFetch/WebSearch directly in the no-project state; do not reference character-enrichment tools that are not currently exposed.',
    '5. Be systematic: break complex requests into steps, use tools to gather facts, then act.',
    '6. If the user asks to clean up historical duplicate timeline events, use `dedupe_timeline` instead of manually rewriting files.',
    useDriver
      ? '7. If Current Editor State includes `User selected text`, that selection metadata is authoritative. In this runtime, direct editor frontend tools are not exposed, so use anchored chapter MCP tools instead of claiming the selection is unavailable.'
      : '7. If Current Editor State includes `User selected text`, that selection metadata is authoritative. Do not tell the user that you cannot see the editor highlight or selection marker.',
  ];
  if (hasActiveNovel) {
    lines.push('8. For chapter-wide review requests, prefer explicit review tools first; do not jump straight into many sequential `replace_chapter_text` calls against overlapping snippets. If multiple concrete fixes are already known, prefer one `apply_chapter_patch` over many independent replaces.');
    lines.push('9. For chapter-wide 去 AI 味 / 去套话 audits, prefer `review_de_ai_style`; when several chapters are in scope, pass all chapter names in one tool call so the backend can review them in parallel.');
    lines.push('10. When auditing AI 味 / 套话 / 八股, do not say you manually reviewed the chapter(s). You must call `review_de_ai_style` before giving findings; if the user also wants a concrete rewrite sample, call `de_ai_ify` on one flagged excerpt.');
    lines.push('11. For world lore or place-table tweaks, prefer `apply_world_patch` over `update_world` unless you are intentionally replacing the whole world block.');
    lines.push('12. For multi-step asset handoff changes, prefer `apply_asset_patch` over many separate `grant_asset`/`revoke_asset` calls. When editing from a prior asset read, include that asset\'s `baseGrantedTo` snapshot.');
    lines.push('12b. When the user refers to chapters by ordinal display names (e.g. "第七章", "第3章", "前三章", "从第五章到第八章"), call `list_chapter_displays` FIRST to get the definitive mapping between display names and filenames. Do NOT infer the mapping from `list_chapters` + `get_chapter_naming_rule` alone — the file order may differ from the display order due to insertions, deletions, or custom naming.');
    lines.push('12c. When answering any question about chapter facts, plot continuity, what happened in a chapter, or how two chapters relate, read the relevant chapter text first via `list_chapter_displays` plus `read_chapter`. Do NOT answer from memory, previous tool previews, draft summaries, or conversation history alone. If you have not read the relevant chapter in this turn, say you need to read it first.');
  }
  lines.push('13. When given a research task (e.g., searching for character info, verifying facts), continue using tools until you have gathered sufficient information. Do not stop after a single search if the results are incomplete or ambiguous.');
  lines.push('14. WebSearch automatically fetches and includes page content from the best wiki/encyclopedia result. You do NOT need to call WebFetch for URLs returned by WebSearch unless you need content from a specific non-wiki URL.');
  lines.push('15. If the task depends on the current date or time, call `get_system_time` and treat that local system time as authoritative. Do not infer GMT/UTC on your own.');
  return lines;
}

async function buildSystemPrompt(editorContext, useDriver, mcpFallbackNovelId, workflowPhase, pendingOutlineDraft, pendingOutlineIssues) {
  const ctx = editorContext || {};
  const phase = workflowPhase || 'idle';
  const hasActiveNovel = !!(ctx.novelId || mcpFallbackNovelId);
  const lines = [
    'You are the interactive writing assistant for Multi-Agent Novel Assistant.',
    '',
    '## Current Editor State',
  ];
  if (ctx.title) {
    lines.push('- Open document: ' + (ctx.chapterDisplayName || ctx.title));
    lines.push('- Document type: ' + (ctx.type || 'unknown'));
  } else {
    lines.push('- No document is currently open.');
  }
  if (ctx.selectedText) {
    lines.push('- User selected text: """' + ctx.selectedText + '"""');
    if (typeof ctx.selectionStart === 'number' && typeof ctx.selectionEnd === 'number' && ctx.selectionEnd >= ctx.selectionStart) {
      lines.push('- Selection range: ' + ctx.selectionStart + '-' + ctx.selectionEnd);
    }
    lines.push('- Selection context: This selected text comes from the live editor state captured by the app. Treat it as the current user selection, even if chat input currently has focus. Do not claim that you cannot see the selection marker just because you lack direct visual access to the editor.');
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
  const systemTime = getSystemTimeInfo();
  lines.push(`- Local system time: ${systemTime.isoLocal} (${systemTime.timezone})`);
  lines.push('');

  if (pendingOutlineDraft?.rawMarkdown) {
    lines.push('## Pending Outline Draft');
    lines.push('A session-local outline draft exists but has NOT been saved yet. Treat it as the current working draft for review, revision, and confirmation.');
    lines.push('If the user asks to revise the outline, revise this draft instead of inventing a new one from scratch.');
    lines.push(useDriver
      ? 'If the user confirms saving, finalize the outline clearly without mentioning tools that are not actually exposed in this runtime.'
      : 'If the user confirms saving, call `confirm_outline` and let the app use the pending draft nodes.');
    lines.push('');
    lines.push(pendingOutlineDraft.rawMarkdown);
    if (Array.isArray(pendingOutlineIssues) && pendingOutlineIssues.length) {
      lines.push('');
      lines.push('Pending draft review notes:');
      for (const issue of pendingOutlineIssues) {
        lines.push(`- [${issue.sourceAgent === 'timeline' ? 'timeline' : 'character_world'}] ${issue.summary}`);
      }
    }
    lines.push('');
  }

  // Phase-specific rules
  const phaseRules = generatePhaseRules(phase, { useDriver });
  lines.push.apply(lines, phaseRules);

  // Common tool list
  lines.push('');
  lines.push('## Available Tools');
  lines.push(useDriver
    ? 'You can call the following tools in this driver-backed chat runtime:'
    : 'You can call the following tools directly in this chat runtime:');
  lines.push(...buildAvailableToolLines({ useDriver, hasActiveNovel }));

  // Common rules
  lines.push('');
  lines.push(...buildCommonRules({ useDriver, hasActiveNovel }));
  lines.push('');
  lines.push(buildSystemTimePromptBlock());

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

function trimMessage(message) {
  return safeStr(message).replace(/\s+/g, ' ').trim().slice(0, 160);
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

function clearPendingOutlineDraft(session) {
  session.pendingOutlineDraft = null;
  session.pendingOutlineIssues = [];
}

function clearPendingChapterDraft(session) {
  session.pendingChapterDraft = null;
  session.pendingChapterIssues = [];
}

function clearPendingRoleplayProfile(session) {
  session.pendingRoleplayProfileGate = null;
  session.pendingRoleplayProfileProposal = null;
}

function clearPendingDeAiChapterReview(session) {
  session.pendingDeAiChapterReview = null;
}

function clearPendingWriteChapter(session) {
  session.pendingWriteChapter = null;
}

function isChapterSnapshotMismatch(text) {
  return /chapter snapshot mismatch/i.test(safeStr(text));
}

function isForceOverwriteWriteIntent(text) {
  return /覆盖写入|强制写入|仍然写入|无视快照|覆盖最新版|直接覆盖/u.test(safeStr(text));
}

async function maybeHandleWriteChapterConfirmation(session, userText, sessionId) {
  const pending = session.pendingWriteChapter;
  if (!pending) return null;

  const text = (typeof userText === 'string' ? userText : String(userText ?? '')).trim();
  if (!text) return null;

  const confirmPattern = /^(?:确认写入|确认保存|开始写入|写入[这此]|保存[这此]|好的[，。,.\s]*(?:开始|继续)?写|可以[，。,.\s]*(?:开始|继续)?写|行[，。,.\s]*(?:开始|继续)?写|^(?:确认|好的|可以|行|嗯|OK|ok|yes|Yes)$)/u;
  const rejectPattern = /^(?:拒绝写入|不写|不写入|取消写入|别写|先不写|暂停写|等等[再先]写)/u;

  if (pending.staleSnapshotMismatch && !isForceOverwriteWriteIntent(text) && confirmPattern.test(text)) {
    return {
      text: [
        '这次写入请求仍然处于快照冲突状态：目标章节在 AI 读完后又发生过变化。',
        '',
        '为了避免覆盖你后来的修改，我不会因为普通“确认”就强行覆盖。',
        '如果你确实要用这版内容覆盖当前章节，请回复“覆盖写入”。如果想保留最新内容，请让我重新读取章节后再生成。'
      ].join('\n'),
      turns: 1,
      toolCalls: [],
    };
  }

  if (confirmPattern.test(text) || (pending.staleSnapshotMismatch && isForceOverwriteWriteIntent(text))) {
    // User confirmed — execute the pending write
    const writeArgs = {
      name: pending.name || undefined,
      title: pending.title || undefined,
      content: pending.content,
      volumeIndex: pending.volumeIndex,
      sectionIndex: pending.sectionIndex,
      insertAfter: pending.insertAfter || undefined,
    };
    if (!isForceOverwriteWriteIntent(text) && pending.baseContent) {
      writeArgs.baseContent = pending.baseContent;
    }
    const result = await callMcpTool('write_chapter', writeArgs);

    if (result.isError && isChapterSnapshotMismatch(result.text)) {
      session.pendingWriteChapter = {
        ...pending,
        staleSnapshotMismatch: true,
        lastError: result.text,
      };
      emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
        name: pending.name,
        title: pending.title,
        contentPreview: safeStr(pending.content).slice(0, 500),
        contentLength: safeStr(pending.content).length,
        warning: '目标章节在读取后发生过变化。可覆盖写入，或重新读取后再生成。',
      });
      return {
        text: [
          '章节写入被保护机制拦下：目标章节在 AI 读取后又发生过变化。',
          '',
          '我已保留这次待写入内容，没有丢掉。',
          '为了避免覆盖你后来的修改，请选择：',
          '- 回复“覆盖写入”：用这版内容覆盖当前章节。',
          '- 回复“重新读取后再写”：我重新读取最新章节，再按当前内容重做。',
          '- 回复“拒绝写入”：取消这次写入。'
        ].join('\n'),
        turns: 1,
        toolCalls: [{
          id: pending.toolUseId || 'write-chapter-confirmed',
          name: 'write_chapter',
          input: { name: pending.name, title: pending.title },
          status: 'done',
          result: result.text,
          isError: true,
        }],
      };
    }

    clearPendingWriteChapter(session);
    emitEvent(sessionId, 'write_chapter_resolved', { confirmed: true, isError: result.isError });

    const writePayload = parseTextJson(result.text) || {};
    const writtenName = safeStr(writePayload.name || pending.name).trim();
    const followupToolCalls = [];
    const followupNotes = [];

    if (!result.isError && writtenName) {
      try {
        const { persistChapterArtifacts } = require('./chapterPostWriteService');
        const postWrite = await persistChapterArtifacts({
          draft: {
            name: writtenName,
            displayName: pending.title || writtenName,
            title: pending.title || writtenName,
            summary: '',
            text: pending.content,
            volumeIndex: pending.volumeIndex,
            sectionIndex: pending.sectionIndex,
          },
          abortSignal: session.abortController?.signal || null,
        });
        followupToolCalls.push(...(Array.isArray(postWrite.toolCalls) ? postWrite.toolCalls : []));
        followupNotes.push(`写后同步：摘要${postWrite.summarySaved ? '已保存' : '未保存'}，时间线 ${postWrite.timelineCount || 0} 条，大纲节点 ${postWrite.outlineUpdated || 0} 个。`);
        if (Array.isArray(postWrite.warnings) && postWrite.warnings.length) {
          followupNotes.push(`写后警告：${postWrite.warnings.join('；')}`);
        }
      } catch (err) {
        followupNotes.push(`写后同步失败：${err?.message || String(err)}`);
      }

      try {
        const config = await appConfig.load();
        if (config?.writing?.characterMemoryUpdate === 'after_confirmed_write' && pending.roleplayContext) {
          const memoryResult = await chapterRoleplayService.updateCharacterMemoriesForChapter({
            draft: {
              name: writtenName,
              displayName: pending.title || writtenName,
              title: pending.title || writtenName,
              summary: '',
              text: pending.content,
            },
            outlineContext: pending.roleplayContext,
            abortSignal: session.abortController?.signal || null,
          });
          followupNotes.push(`角色记忆更新：${memoryResult.updated || 0} 个角色。`);
        }
      } catch (err) {
        followupNotes.push(`角色记忆更新失败：${err?.message || String(err)}`);
      }

      try {
        const reviewResult = await callMcpTool('review_de_ai_style', {
          chapterName: writtenName,
          focus: '写入后自动审查 AI 味、套话、机械行文和章末模板感',
        });
        followupToolCalls.push({
          id: `auto-de-ai-review-${Date.now().toString(36)}`,
          name: 'review_de_ai_style',
          input: { chapterName: writtenName },
          status: 'done',
          result: reviewResult.text,
          isError: reviewResult.isError,
        });
        if (reviewResult.isError) {
          followupNotes.push(`去 AI 味审查失败：${trimMessage(reviewResult.text)}`);
        } else {
          const reviewPayload = parseTextJson(reviewResult.text) || {};
          followupNotes.push(`去 AI 味审查完成：发现 ${reviewPayload.totalAnnotations || 0} 处可疑段落。`);
        }
      } catch (err) {
        followupNotes.push(`去 AI 味审查失败：${err?.message || String(err)}`);
      }
    }

    const displayName = pending.title || pending.name || '章节';
    const successText = result.isError
      ? `章节写入失败：${result.text}`
      : `已成功写入 ${displayName}。${followupNotes.length ? `\n\n${followupNotes.join('\n')}` : ''}`;

    return {
      text: successText,
      turns: 1,
      toolCalls: [
        {
          id: pending.toolUseId || 'write-chapter-confirmed',
          name: 'write_chapter',
          input: { name: pending.name, title: pending.title },
          status: 'done',
          result: result.text,
          isError: result.isError,
        },
        ...followupToolCalls,
      ],
    };
  }

  if (rejectPattern.test(text)) {
    let reason = '';
    const reasonMatch = text.match(/理由[是为]?[:：]\s*(.+)/u);
    if (reasonMatch) {
      reason = reasonMatch[1].trim();
    }

    clearPendingWriteChapter(session);
    emitEvent(sessionId, 'write_chapter_resolved', { confirmed: false, reason });

    const rejectText = reason
      ? `用户拒绝了章节写入请求。\n\n理由：${reason}\n\n请根据反馈调整后再试。`
      : '用户拒绝了章节写入请求。请根据反馈调整后再试。';

    return {
      text: rejectText,
      turns: 1,
      toolCalls: [{
        id: pending.toolUseId || 'write-chapter-rejected',
        name: 'write_chapter',
        input: { name: pending.name, title: pending.title },
        status: 'done',
        result: reason ? `User rejected with reason: ${reason}` : 'User rejected',
        isError: true,
      }],
    };
  }

  if (pending.staleSnapshotMismatch && /重新读取|重新生成|重新写|重做|保留最新/u.test(text)) {
    clearPendingWriteChapter(session);
    emitEvent(sessionId, 'write_chapter_resolved', { confirmed: false, reason: 'snapshot refresh requested' });
    return {
      text: '已取消这次旧快照写入请求。请重新提出写作/修改要求，我会先基于最新章节内容再生成，避免覆盖你后来的改动。',
      turns: 1,
      toolCalls: [],
    };
  }

  return null; // Not a confirmation/rejection — proceed to normal AI processing
}

function isRoleplayAutofillIntent(userText) {
  return /自动补全|补全角色|生成资料|生成角色资料|完善角色/u.test(safeStr(userText));
}

function isRoleplayIgnoreIntent(userText) {
  return /忽略.{0,12}(资料|缺失|不足)|跳过.{0,12}(资料|缺失|不足)|继续写|继续生成|先写/u.test(safeStr(userText));
}

function isRoleplayPatchConfirmIntent(userText) {
  return /确认.{0,8}(补全|应用|采用|写入)|应用.{0,8}(补全|patch|建议)|采用.{0,8}(补全|建议)|可以.{0,8}(写入|应用)|就按这个/u.test(safeStr(userText));
}

function isRoleplayPatchRejectIntent(userText) {
  return /拒绝|不要|不采用|不应用|取消|先别/u.test(safeStr(userText));
}

function summarizeProfileProposal(proposal) {
  const characterPatches = Array.isArray(proposal?.characterPatches) ? proposal.characterPatches : [];
  const memoryPatches = Array.isArray(proposal?.memoryPatches) ? proposal.memoryPatches : [];
  const notes = Array.isArray(proposal?.notes) ? proposal.notes : [];
  const lines = [
    '已生成角色资料补全建议，暂未写入项目。',
    '',
    `角色卡 patch：${characterPatches.length} 个；角色记忆 patch：${memoryPatches.length} 个。`,
  ];
  for (const item of characterPatches.slice(0, 6)) {
    lines.push(`- ${item.characterName || item.characterId}：${Object.keys(item.patch || {}).join('、') || '无字段'}`);
  }
  if (notes.length) {
    lines.push('', '补全说明：');
    for (const note of notes.slice(0, 6)) lines.push(`- ${safeStr(note)}`);
  }
  lines.push('', '请确认是否应用这些补全。你也可以回复“拒绝补全”，或说明要怎么继续修改。');
  return lines.join('\n');
}

async function rerunChapterDraftAfterRoleplayGate(session, sessionId, abortSignal, { ignoreProfileGate = false } = {}) {
  const gate = session.pendingRoleplayProfileGate || {};
  const originalUserText = gate.originalUserText || gate.userText || '继续生成章节草稿';
  const originalIntent = gate.originalIntent || detectChapterChatIntent(originalUserText, session);
  const draftResult = await chapterDraftService.generateChapterDraft({
    mode: originalIntent.mode || 'new',
    userText: originalUserText,
    pendingChapterDraft: session.pendingChapterDraft,
    editorContext: session.editorContext,
    abortSignal,
    roleplayOptions: { ignoreProfileGate },
  });
  if (draftResult.profileGateBlocked) {
    session.pendingRoleplayProfileGate = {
      ...draftResult.profileGate,
      originalUserText,
      originalIntent,
    };
    session.pendingRoleplayProfileProposal = null;
    emitEvent(sessionId, 'awaiting_character_profile_decision', draftResult.profileGate || {});
    return {
      text: draftResult.assistantText || '角色资料不足，等待你选择自动补全或忽略继续。',
      turns: 1,
      toolCalls: [],
    };
  }
  clearPendingRoleplayProfile(session);
  session.pendingChapterDraft = draftResult.draft || null;
  session.pendingChapterIssues = Array.isArray(draftResult.blockingIssues) ? draftResult.blockingIssues : [];
  session.workflowPhase = 'writing';
  emitEvent(sessionId, 'character_profile_gate_resolved', {});
  return {
    text: draftResult.assistantText || '已生成章节草稿，等待确认。',
    turns: 1,
    toolCalls: [],
  };
}

async function maybeHandleRoleplayProfilePending(session, userText, sessionId, abortSignal) {
  if (session.pendingRoleplayProfileProposal) {
    if (isRoleplayPatchConfirmIntent(userText)) {
      const applied = await chapterRoleplayService.applyProfileAutofill(session.pendingRoleplayProfileProposal);
      emitEvent(sessionId, 'character_profile_patch_resolved', { confirmed: true, applied });
      return rerunChapterDraftAfterRoleplayGate(session, sessionId, abortSignal, { ignoreProfileGate: false });
    }
    if (isRoleplayPatchRejectIntent(userText)) {
      session.pendingRoleplayProfileProposal = null;
      emitEvent(sessionId, 'character_profile_patch_resolved', { confirmed: false });
      return {
        text: '已拒绝这次角色资料补全建议，未写入任何角色卡或记忆。你可以要求我重新补全，或回复“忽略角色资料不足并继续写”。',
        turns: 1,
        toolCalls: [],
      };
    }
  }

  if (!session.pendingRoleplayProfileGate) return null;

  if (isRoleplayAutofillIntent(userText)) {
    const proposal = await chapterRoleplayService.proposeProfileAutofill(
      session.pendingRoleplayProfileGate,
      userText,
      abortSignal
    );
    session.pendingRoleplayProfileProposal = proposal;
    emitEvent(sessionId, 'awaiting_character_profile_patch_confirmation', proposal || {});
    return {
      text: summarizeProfileProposal(proposal),
      turns: 1,
      toolCalls: [],
    };
  }

  if (isRoleplayIgnoreIntent(userText)) {
    emitEvent(sessionId, 'character_profile_gate_resolved', { ignored: true });
    return rerunChapterDraftAfterRoleplayGate(session, sessionId, abortSignal, { ignoreProfileGate: true });
  }

  return null;
}

async function maybeHandleChapterDraftAutomation(session, userText, sessionId, abortSignal) {
  const activeNovelId = session.editorContext?.novelId || mcpClient.getActiveNovel();
  if (!activeNovelId) return null;

  const pendingRoleplay = await maybeHandleRoleplayProfilePending(session, userText, sessionId, abortSignal);
  if (pendingRoleplay) return pendingRoleplay;

  if (detectChapterConfirmIntent(userText, session)) {
    const incompleteReview = Array.isArray(session.pendingChapterIssues)
      && session.pendingChapterIssues.some((issue) => issue.reviewIncomplete);
    if (incompleteReview) {
      return {
        text: '当前章节草稿还有未完成的审查，先不写入。请回复“重新审查这一章”，或指出要调整的段落/时间线问题。',
        turns: 1,
        toolCalls: [],
      };
    }

    const draft = session.pendingChapterDraft;
    if (!draft?.text) return null;
    session.pendingWriteChapter = {
      name: draft.name || '',
      title: draft.title || '',
      content: draft.text || '',
      volumeIndex: draft.volumeIndex,
      sectionIndex: draft.sectionIndex,
      baseContent: draft.baseContent || '',
      insertAfter: draft.insertAfter || '',
      roleplayContext: draft.roleplayContext || null,
      toolUseId: 'write-chapter-draft-confirmed',
    };
    const result = await maybeHandleWriteChapterConfirmation(session, '确认写入', sessionId);
    if (result && !/^章节写入失败/.test(result.text || '')) {
      clearPendingChapterDraft(session);
    }
    return result;
  }

  const intent = detectChapterChatIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const draftResult = await chapterDraftService.generateChapterDraft({
    mode: intent.mode,
    userText,
    pendingChapterDraft: session.pendingChapterDraft,
    editorContext: session.editorContext,
    abortSignal,
  });
  if (draftResult.profileGateBlocked) {
    session.pendingRoleplayProfileGate = {
      ...draftResult.profileGate,
      originalUserText: userText,
      originalIntent: intent,
    };
    session.pendingRoleplayProfileProposal = null;
    emitEvent(sessionId, 'awaiting_character_profile_decision', draftResult.profileGate || {});
    session.workflowPhase = 'writing';
    return {
      text: draftResult.assistantText || '角色资料不足，等待你选择自动补全或忽略继续。',
      turns: 1,
      toolCalls: [],
    };
  }
  clearPendingRoleplayProfile(session);
  session.pendingChapterDraft = draftResult.draft || null;
  session.pendingChapterIssues = Array.isArray(draftResult.blockingIssues) ? draftResult.blockingIssues : [];
  session.workflowPhase = 'writing';

  return {
    text: draftResult.assistantText || '已生成章节草稿，等待确认。',
    turns: 1,
    toolCalls: [],
  };
}

function storePendingOutlineDraft(session, draft, issues) {
  session.pendingOutlineDraft = draft;
  session.pendingOutlineIssues = Array.isArray(issues) ? issues : [];
  session.workflowPhase = 'outline';
}

function storePendingDeAiChapterReview(session, payload, focus) {
  session.pendingDeAiChapterReview = {
    reviewPayload: payload || { chapters: [] },
    focus: safeStr(focus).trim(),
    createdAt: Date.now(),
  };
}

function parseTextJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function detectOpenChapterName(editorContext) {
  const candidates = [
    editorContext?.activeChapterName,
    editorContext?.chapterName,
    editorContext?.title,
    editorContext?.activeChapterTitle,
  ];
  for (const candidate of candidates) {
    const value = safeStr(candidate).trim();
    if (!value) continue;
    const matched = value.match(/chapter-[\w.-]+\.md/i);
    if (matched?.[0]) return matched[0];
    if (/\.md$/i.test(value)) return value;
  }
  return '';
}

function detectCharacterConsistencyReviewIntent(userText, session) {
  const text = safeStr(userText).trim();
  if (!text) return { shouldRoute: false };

  const mentionsCharacterConsistency = /人设|ooc|设定冲突|角色崩了|角色冲突|不符合人设|反应不对|口吻不对|说话方式不对/u.test(text);
  const looksLikeReview = /检查|审查|看看|有地方|哪里|不符合|冲突|对不上|漏检|找出/u.test(text);
  const looksLikeDirectRewrite = /修|改|替换|重写|润色|改写|统一改掉/u.test(text);
  const chapterName = detectOpenChapterName(session?.editorContext);

  if (!chapterName || !mentionsCharacterConsistency || !looksLikeReview || looksLikeDirectRewrite) {
    return { shouldRoute: false };
  }

  return {
    shouldRoute: true,
    chapterName,
    focus: text,
  };
}

function detectDeAiChatIntent(userText, session) {
  const text = safeStr(userText).trim();
  const selectedText = safeStr(session?.editorContext?.selectedText).trim();
  if (!text || !selectedText) return { shouldRoute: false };

  const looksLikeDeAiRequest = /去\s*a\s*i\s*味|去掉\s*a\s*i\s*味|润色去套话|去套话|去掉套话|去除套话|改得不那么像\s*a\s*i|改得更像人(?:写|说)|去掉八股|去掉机翻腔|去掉模型味/iu.test(text);
  if (!looksLikeDeAiRequest) return { shouldRoute: false };

  return {
    shouldRoute: true,
    sourceText: selectedText,
    guidance: text,
  };
}

function parseChapterOrdinal(token) {
  const text = safeStr(token).trim();
  if (!text) return NaN;
  if (/^\d+$/.test(text)) return Number(text);

  const digitMap = {
    '零': 0,
    '〇': 0,
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
  };
  const unitMap = { '十': 10, '百': 100, '千': 1000 };
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (Object.prototype.hasOwnProperty.call(digitMap, char)) {
      current = digitMap[char];
      continue;
    }
    const unit = unitMap[char];
    if (!unit) return NaN;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}

function extractRequestedChapterNames(text, chapterNames, displayList) {
  const source = safeStr(text);
  const list = Array.isArray(chapterNames) ? chapterNames : [];
  const ordered = list.slice().sort((left, right) => left.localeCompare(right, 'en'));
  const resolved = [];
  const addName = (chapterName) => {
    const value = safeStr(chapterName).trim();
    if (value && ordered.includes(value) && !resolved.includes(value)) resolved.push(value);
  };

  for (const match of source.matchAll(/chapter-[\w.-]+\.md/giu)) {
    addName(match[0]);
  }

  // Try display-name matching first when displayList is available.
  // This is more accurate than ordinal indexing when chapters have
  // been inserted, deleted, or filename order ≠ display order.
  if (Array.isArray(displayList) && displayList.length > 0) {
    const displayMap = new Map();
    for (const entry of displayList) {
      if (entry.name) displayMap.set(entry.name, entry);
    }

    // Build a lookup: for each ordinal (1-99), find the entry whose displayName
    // starts with "第X章" or "第{cn}章" — this captures both "第7章" and "第七章".
    const ordinalToName = new Map();
    for (const entry of displayList) {
      const dn = entry.displayName || '';
      // Match patterns like "第7章：" or "第七章：" or "第7章" or "第七章"
      const m = dn.match(/^第\s*([零〇一二两三四五六七八九十百千\d]+)\s*章/u);
      if (m) {
        const ordinal = parseChapterOrdinal(m[1]);
        if (Number.isFinite(ordinal) && ordinal > 0) {
          ordinalToName.set(ordinal, entry.name);
        }
      }
    }

    // Helper: resolve ordinal → name via displayList
    function resolveViaDisplayList(ordinal) {
      if (!Number.isFinite(ordinal) || ordinal < 1) return undefined;
      // First try ordinalToName (parsed from displayName)
      if (ordinalToName.has(ordinal)) {
        return ordinalToName.get(ordinal);
      }
      // Fallback: use seq field if it matches
      for (const entry of displayList) {
        if (entry.seq === ordinal && entry.name) return entry.name;
      }
      // Final fallback: ordinal index in the ordered filename list
      return ordered[ordinal - 1];
    }

    // Display-name-aware range & single matching for "第X章" patterns
    for (const match of source.matchAll(/第\s*([零〇一二两三四五六七八九十百千\d]+)\s*章\s*(?:到|至|[-~—–])\s*第?\s*([零〇一二两三四五六七八九十百千\d]+)\s*章/gu)) {
      const start = parseChapterOrdinal(match[1]);
      const end = parseChapterOrdinal(match[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const lower = Math.max(1, Math.min(start, end));
      const upper = Math.max(start, end);
      for (let index = lower; index <= upper; index += 1) {
        const name = resolveViaDisplayList(index);
        if (name) addName(name);
      }
    }

    for (const match of source.matchAll(/(?:第\s*)?([零〇一二两三四五六七八九十百千\d]+)\s*(?:章)?\s*(?:到|至|[-~—–])\s*(?:第\s*)?([零〇一二两三四五六七八九十百千\d]+)\s*章/gu)) {
      const start = parseChapterOrdinal(match[1]);
      const end = parseChapterOrdinal(match[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const lower = Math.max(1, Math.min(start, end));
      const upper = Math.max(start, end);
      for (let index = lower; index <= upper; index += 1) {
        const name = resolveViaDisplayList(index);
        if (name) addName(name);
      }
    }

    for (const match of source.matchAll(/第\s*([零〇一二两三四五六七八九十百千\d]+)\s*章/gu)) {
      const ordinal = parseChapterOrdinal(match[1]);
      if (!Number.isFinite(ordinal) || ordinal < 1) continue;
      const name = resolveViaDisplayList(ordinal);
      if (name) addName(name);
    }

    // If we found any results via display-list matching, return them
    // without falling through to the ordinal-index fallback.
    if (resolved.length > 0) return resolved;
  }

  // Fallback: ordinal-index matching (original logic)
  for (const match of source.matchAll(/第\s*([零〇一二两三四五六七八九十百千\d]+)\s*章\s*(?:到|至|[-~—–])\s*第?\s*([零〇一二两三四五六七八九十百千\d]+)\s*章/gu)) {
    const start = parseChapterOrdinal(match[1]);
    const end = parseChapterOrdinal(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const lower = Math.max(1, Math.min(start, end));
    const upper = Math.max(start, end);
    for (let index = lower; index <= upper; index += 1) {
      addName(ordered[index - 1]);
    }
  }

  for (const match of source.matchAll(/(?:第\s*)?([零〇一二两三四五六七八九十百千\d]+)\s*(?:章)?\s*(?:到|至|[-~—–])\s*(?:第\s*)?([零〇一二两三四五六七八九十百千\d]+)\s*章/gu)) {
    const start = parseChapterOrdinal(match[1]);
    const end = parseChapterOrdinal(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const lower = Math.max(1, Math.min(start, end));
    const upper = Math.max(start, end);
    for (let index = lower; index <= upper; index += 1) {
      addName(ordered[index - 1]);
    }
  }

  for (const match of source.matchAll(/第\s*([零〇一二两三四五六七八九十百千\d]+)\s*章/gu)) {
    const ordinal = parseChapterOrdinal(match[1]);
    if (!Number.isFinite(ordinal) || ordinal < 1) continue;
    addName(ordered[ordinal - 1]);
  }

  return resolved;
}

function detectDeAiChapterReviewIntent(userText, session) {
  const text = safeStr(userText).trim();
  if (!text) return { shouldRoute: false };

  const looksLikeDeAiRequest = /去\s*a\s*i\s*味|去掉\s*a\s*i\s*味|润色去套话|去套话|去掉套话|去除套话|改得不那么像\s*a\s*i|改得更像人(?:写|说)|去掉八股|去掉机翻腔|去掉模型味/iu.test(text);
  const mentionsDeAiProblems = /AI味|套话|八股|机翻腔|模型味|像AI|像模型写的/u.test(text);
  const looksLikeReview = /检查|审查|看看|有地方|哪里|问题|找出|盘一下|过一遍|AI味|套话|八股|机翻腔|模型味|机械|僵硬|不自然/u.test(text);
  const explicitlyRejectsRewrite = /(?:不要|别|先不要).{0,8}(?:直接改|直接处理|统一改掉|替换|重写|改写)/u.test(text);
  const looksLikeRewrite = /直接改|直接处理|统一改掉|替换|重写|改写|润色这一段|润色这句/u.test(text) && !explicitlyRejectsRewrite;
  const mentionsChapters = /章|chapter-/iu.test(text);

  if ((!looksLikeDeAiRequest && !mentionsDeAiProblems) || !looksLikeReview || looksLikeRewrite || !mentionsChapters) {
    return { shouldRoute: false };
  }

  return {
    shouldRoute: true,
    focus: text,
    fallbackChapterName: detectOpenChapterName(session?.editorContext),
  };
}

function detectChapterFactCheckIntent(userText, session) {
  const text = safeStr(userText).trim();
  if (!text) return { shouldRoute: false };
  const activeNovelId = session?.editorContext?.novelId || mcpClient.getActiveNovel();
  if (!activeNovelId) return { shouldRoute: false };
  const mentionsChapter = /chapter-[\w.-]+\.md|第\s*[零〇一二两三四五六七八九十百千\d]+\s*章|第[一二三四五六七八九十百千\d]+章/u.test(text);
  if (!mentionsChapter) return { shouldRoute: false };
  const looksLikeChallenge = /怎么|为什么|咋|哪来|哪里|对不上|矛盾|冲突|搞错|错了|不对|蠢|傻|胡说|乱说|混在一起|串了|记错|核对|确认|查一下|到底/u.test(text);
  const asksChapterFact = /写了什么|讲了什么|发生了什么|内容|剧情|桥段|情节|结尾|开头|中间|伏笔|设定|谁|在哪|什么时候|有没有|是不是|是否|关系|衔接|连续|前后|上一章|下一章|这一章|那一章|总结|概括|复盘|梳理/u.test(text);
  if (!looksLikeChallenge && !asksChapterFact) return { shouldRoute: false };
  return { shouldRoute: true, focus: text, isChallenge: looksLikeChallenge };
}

function extractDisplayTitle(displayName, name) {
  const text = safeStr(displayName || name).trim();
  return text
    .replace(/^第\s*[零〇一二两三四五六七八九十百千\d]+\s*章\s*[：:、\-\s]*/u, '')
    .replace(/^chapter-[\w.-]+\.md\s*[：:、\-\s]*/iu, '')
    .trim();
}

function extractChapterHeading(content, fallback) {
  const match = safeStr(content).match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback || '';
}

function snippetAround(content, keyword, maxLength = 180) {
  const text = safeStr(content).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const key = safeStr(keyword).trim();
  const index = key ? text.indexOf(key) : -1;
  if (index < 0) return text.slice(0, maxLength);
  const start = Math.max(0, index - Math.floor(maxLength / 2));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function buildChapterFactCheckReply({ focus, chapters, isChallenge }) {
  const lines = [
    isChallenge
      ? '你这个质疑是对的，不能靠我刚才那种“印象流”回答。'
      : '我先按章节映射读取原文，再回答这个章节事实问题。',
    '',
    '核对结果如下：',
  ];
  for (const chapter of chapters) {
    const display = chapter.displayName || chapter.name;
    const title = chapter.heading || chapter.title || '';
    lines.push('', `- ${display}${title && title !== display ? `：${title}` : ''}`);
    lines.push(`  证据片段：${chapter.snippet || '未读到可用正文片段'}`);
  }
  lines.push(
    '',
    isChallenge
      ? '结论：后续回答应以这些最新章节原文为准。若上一轮把两个章节的剧情混在一起，那是聊天模型没有重新读章节导致的错误；这类问题现在会走强制核对路径。'
      : '结论：后续回答应以这些最新章节原文为准；没有在原文中核到的内容，我不会当作事实继续发挥。'
  );
  if (focus) {
    lines.push('', `你刚才问的是：${focus}`);
  }
  return lines.join('\n');
}

async function maybeHandleChapterFactCheckAutomation(session, userText) {
  const intent = detectChapterFactCheckIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const toolCalls = [];
  const listResult = await callMcpTool('list_chapters', {});
  toolCalls.push({
    id: 'factcheck-list-chapters',
    name: 'list_chapters',
    input: {},
    status: 'done',
    result: listResult.text,
    isError: listResult.isError,
  });
  if (listResult.isError) {
    return {
      text: `章节核对失败：${listResult.text}`,
      turns: 1,
      toolCalls,
    };
  }
  const allChapterNames = Array.isArray(parseTextJson(listResult.text)) ? parseTextJson(listResult.text) : [];

  let displayList = null;
  const displayResult = await callMcpTool('list_chapter_displays', {});
  toolCalls.push({
    id: 'factcheck-list-chapter-displays',
    name: 'list_chapter_displays',
    input: {},
    status: 'done',
    result: displayResult.text,
    isError: displayResult.isError,
  });
  if (!displayResult.isError) {
    const parsed = parseTextJson(displayResult.text);
    if (Array.isArray(parsed)) displayList = parsed;
  }

  const requestedChapterNames = extractRequestedChapterNames(intent.focus, allChapterNames, displayList);
  if (!requestedChapterNames.length) return null;

  const displayByName = new Map((Array.isArray(displayList) ? displayList : []).map((entry) => [entry.name, entry]));
  const chapters = [];
  for (const chapterName of requestedChapterNames.slice(0, 4)) {
    const readResult = await callMcpTool('read_chapter', { name: chapterName });
    toolCalls.push({
      id: `factcheck-read-${chapterName}`,
      name: 'read_chapter',
      input: { name: chapterName },
      status: 'done',
      result: readResult.isError ? readResult.text : `Read ${chapterName}`,
      isError: readResult.isError,
    });
    const display = displayByName.get(chapterName) || {};
    const title = extractDisplayTitle(display.displayName, chapterName);
    const content = readResult.isError ? '' : readResult.text;
    chapters.push({
      name: chapterName,
      displayName: display.displayName || chapterName,
      title,
      heading: extractChapterHeading(content, title),
      snippet: snippetAround(content, title || chapterName),
    });
  }

  return {
    text: buildChapterFactCheckReply({ focus: intent.focus, chapters, isChallenge: intent.isChallenge }),
    turns: 1,
    toolCalls,
  };
}

function detectPendingDeAiChapterApplyIntent(userText, session) {
  if (!session?.pendingDeAiChapterReview) return { action: null };

  const text = safeStr(userText).trim();
  if (!text) return { action: null };

  if (/先别改|不要改|不用改|取消|算了|只看结果|先审查/u.test(text)) {
    return { action: 'cancel' };
  }

  if (/方案\s*[BbＢｂＣcＣｃ]/u.test(text)) {
    return { action: null };
  }

  const selectsPlanA = /(?:^|[\s，。,.！？!?])方案\s*[AaＡａ](?:$|[\s，。,.！？!?])/u.test(text)
    || /按.{0,8}方案\s*[AaＡａ]/u.test(text);
  const wantsApply = /(?:直接|开始|继续|批量|统一|全部|都|就按|照着|按这个|确认).{0,10}(?:改|修|处理|替换|应用|执行)|^(?:改吧|修吧|继续吧|开始吧|确认|可以改了)$/u.test(text);

  return { action: selectsPlanA || wantsApply ? 'apply' : null };
}

function compactPatchContext(text, maxLength = 120) {
  const value = safeStr(text).replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function collectReviewParagraphIndexes(annotations) {
  const indexes = [];
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    const paragraphIndexes = Array.isArray(annotation?.paragraphIndexes) && annotation.paragraphIndexes.length
      ? annotation.paragraphIndexes
      : [annotation?.paragraphIndex];
    for (const index of paragraphIndexes) {
      if (!Number.isInteger(index) || indexes.includes(index)) continue;
      indexes.push(index);
    }
  }
  return indexes.sort((left, right) => left - right);
}

async function buildDeAiPatchForChapter(chapterName, annotations, focus, toolCalls) {
  const readResult = await callMcpTool('read_chapter', { name: chapterName });
  toolCalls.push({
    id: `read-chapter-${chapterName}-${toolCalls.length + 1}`,
    name: 'read_chapter',
    input: { name: chapterName },
    status: 'done',
    result: readResult.isError ? readResult.text : `Read ${chapterName}`,
    isError: readResult.isError,
  });
  if (readResult.isError) {
    throw new Error(readResult.text || `read_chapter failed for ${chapterName}`);
  }

  const baseContent = safeStr(readResult.text);
  const paragraphs = splitIntoParagraphs(baseContent);
  const targetIndexes = collectReviewParagraphIndexes(annotations);
  const edits = [];

  for (const paragraphIndex of targetIndexes) {
    const paragraph = paragraphs.find((item) => item.index === paragraphIndex);
    if (!paragraph?.text) continue;

    const guidance = [
      safeStr(focus).trim(),
      '只重写这一段，去掉 AI 味、套话和八股感，保留原意、信息、情绪和人称，不要扩写剧情。',
    ].filter(Boolean).join('\n\n');

    const rewriteResult = await callMcpTool('de_ai_ify', {
      text: paragraph.text,
      guidance,
    });
    toolCalls.push({
      id: `de-ai-ify-${chapterName}-${paragraphIndex}-${toolCalls.length + 1}`,
      name: 'de_ai_ify',
      input: { text: paragraph.text, guidance },
      status: 'done',
      result: rewriteResult.text,
      isError: rewriteResult.isError,
    });
    if (rewriteResult.isError) {
      throw new Error(rewriteResult.text || `de_ai_ify failed for ${chapterName} 第${paragraphIndex + 1}段`);
    }

    const rewritePayload = parseTextJson(rewriteResult.text);
    const replacement = safeStr(rewritePayload?.revisedText || rewriteResult.text).trim();
    if (!replacement || replacement === paragraph.text.trim()) continue;

    edits.push({
      targetText: paragraph.text,
      replacement,
      beforeContext: compactPatchContext(paragraphs.find((item) => item.index === paragraphIndex - 1)?.text || ''),
      afterContext: compactPatchContext(paragraphs.find((item) => item.index === paragraphIndex + 1)?.text || ''),
    });
  }

  return { baseContent, edits };
}

async function maybeHandlePendingDeAiChapterApply(session, userText) {
  const pending = session.pendingDeAiChapterReview;
  if (!pending) return null;

  const intent = detectPendingDeAiChapterApplyIntent(userText, session);
  if (intent.action === 'cancel') {
    clearPendingDeAiChapterReview(session);
    return {
      text: '已保留这次去 AI 味审查结果，暂不自动修改正文。',
      turns: 1,
      toolCalls: [],
    };
  }
  if (intent.action !== 'apply') return null;

  const chapters = (Array.isArray(pending.reviewPayload?.chapters) ? pending.reviewPayload.chapters : [])
    .filter((chapter) => !chapter?.error)
    .filter((chapter) => Array.isArray(chapter?.annotations) && chapter.annotations.length > 0);
  if (!chapters.length) {
    clearPendingDeAiChapterReview(session);
    return {
      text: '上一次去 AI 味审查里没有可直接应用的段落，所以这次没有改动正文。',
      turns: 1,
      toolCalls: [],
    };
  }

  const applied = [];
  const failed = [];
  const toolCalls = [];

  for (const chapter of chapters) {
    let appliedPayload = null;
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const patch = await buildDeAiPatchForChapter(chapter.chapterName, chapter.annotations, pending.focus, toolCalls);
        if (!patch.edits.length) {
          appliedPayload = { replacedCount: 0, editCount: 0 };
          break;
        }

        const applyArgs = {
          name: chapter.chapterName,
          baseContent: patch.baseContent,
          edits: patch.edits,
        };
        const applyResult = await callMcpTool('apply_chapter_patch', applyArgs);
        toolCalls.push({
          id: `apply-chapter-patch-${chapter.chapterName}-${attempt}`,
          name: 'apply_chapter_patch',
          input: { name: chapter.chapterName, edits: patch.edits },
          status: 'done',
          result: applyResult.text,
          isError: applyResult.isError,
        });

        if (applyResult.isError) {
          lastError = applyResult.text || 'apply_chapter_patch failed';
          if (/snapshot mismatch/i.test(lastError) && attempt < 2) {
            continue;
          }
          throw new Error(lastError);
        }

        appliedPayload = parseTextJson(applyResult.text) || { editCount: patch.edits.length, replacedCount: patch.edits.length };
        break;
      } catch (err) {
        lastError = err?.message || String(err);
        if (!/snapshot mismatch/i.test(lastError) || attempt >= 2) {
          break;
        }
      }
    }

    if (appliedPayload) {
      applied.push({
        chapterName: chapter.chapterName,
        editCount: Number(appliedPayload.replacedCount ?? appliedPayload.editCount) || 0,
      });
    } else {
      failed.push({ chapterName: chapter.chapterName, error: lastError || '未能生成可应用补丁' });
    }
  }

  clearPendingDeAiChapterReview(session);

  const lines = [];
  if (applied.length) {
    const totalEdits = applied.reduce((sum, item) => sum + (item.editCount || 0), 0);
    lines.push(`已按上一次审查结果自动应用去 AI 味修改，共处理 ${applied.length} 章，落盘 ${totalEdits} 处：`);
    lines.push('');
    for (const item of applied) {
      lines.push(`- ${item.chapterName}：${item.editCount} 处`);
    }
  }
  if (failed.length) {
    if (lines.length) lines.push('');
    lines.push(`以下章节仍未处理成功：${failed.map((item) => `${item.chapterName}（${item.error}）`).join('；')}`);
  }
  if (!lines.length) {
    lines.push('这次没有生成可落盘的去 AI 味修改。');
  }

  return {
    text: lines.join('\n'),
    turns: 1,
    toolCalls,
  };
}

function formatDeAiChapterReviewReply(reviewPayload) {
  const chapters = Array.isArray(reviewPayload?.chapters) ? reviewPayload.chapters : [];
  const successful = chapters.filter((chapter) => !chapter?.error);
  const failed = chapters.filter((chapter) => chapter?.error);
  const totalAnnotations = Number(reviewPayload?.totalAnnotations) || 0;

  if (!successful.length && failed.length) {
    return `去 AI 味审查失败：${failed[0].error || '未返回可用结果'}`;
  }

  const lines = [];
  const label = successful.length > 1 ? `${successful.length} 章` : safeStr(successful[0]?.chapterName) || '当前章节';
  if (totalAnnotations <= 0) {
    lines.push(`我已并行审查 ${label} 的 AI 味和套话问题，目前没有发现明确需要处理的段落。`);
  } else {
    lines.push(`我已并行审查 ${label} 的 AI 味和套话问题，共发现 ${totalAnnotations} 处可疑段落：`);
    lines.push('');
    for (const chapter of successful) {
      const annotations = Array.isArray(chapter?.annotations) ? chapter.annotations : [];
      lines.push(`- ${chapter.chapterName}：${annotations.length} 处`);
      for (const annotation of annotations.slice(0, 3)) {
        const paragraphIndexes = Array.isArray(annotation?.paragraphIndexes) && annotation.paragraphIndexes.length
          ? annotation.paragraphIndexes.map((index) => `第${index + 1}段`).join(' / ')
          : `第${(annotation?.paragraphIndex || 0) + 1}段`;
        lines.push(`  ${paragraphIndexes}：${annotation.note || '发现 AI 味/套话问题'}`);
      }
    }
  }

  if (failed.length) {
    lines.push('');
    lines.push(`以下章节审查失败：${failed.map((chapter) => `${chapter.chapterName}（${chapter.error}）`).join('；')}`);
  }

  lines.push('');
  lines.push('这是审查结果，暂不自动改正文；如果你要我继续修，我会按你的确认逐章处理，或先汇总成 apply_chapter_patch。');
  return lines.join('\n');
}

async function maybeHandleDeAiChapterReviewAutomation(session, userText) {
  const activeNovelId = session.editorContext?.novelId || mcpClient.getActiveNovel();
  if (!activeNovelId) return null;

  const intent = detectDeAiChapterReviewIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const listResult = await callMcpTool('list_chapters', {});
  if (listResult.isError) {
    return {
      text: `去 AI 味审查失败：${listResult.text}`,
      turns: 1,
      toolCalls: [{
        id: 'list-chapters-de-ai-review-auto',
        name: 'list_chapters',
        input: {},
        status: 'done',
        result: listResult.text,
        isError: true,
      }],
    };
  }

  const allChapterNames = Array.isArray(parseTextJson(listResult.text)) ? parseTextJson(listResult.text) : [];

  // Fetch display names for more accurate ordinal → file mapping
  let displayList = null;
  const displayResult = await callMcpTool('list_chapter_displays', {});
  if (!displayResult.isError) {
    const parsed = parseTextJson(displayResult.text);
    if (Array.isArray(parsed)) displayList = parsed;
  }

  const requestedChapterNames = extractRequestedChapterNames(intent.focus, allChapterNames, displayList);
  if (!requestedChapterNames.length && intent.fallbackChapterName) {
    requestedChapterNames.push(intent.fallbackChapterName);
  }
  if (!requestedChapterNames.length) return null;

  const reviewResult = await callMcpTool('review_de_ai_style', {
    chapterNames: requestedChapterNames,
    focus: intent.focus,
  });
  if (reviewResult.isError) {
    return {
      text: `去 AI 味审查失败：${reviewResult.text}`,
      turns: 1,
      toolCalls: [
        {
          id: 'list-chapters-de-ai-review-auto',
          name: 'list_chapters',
          input: {},
          status: 'done',
          result: listResult.text,
          isError: false,
        },
        {
          id: 'review-de-ai-style-auto',
          name: 'review_de_ai_style',
          input: { chapterNames: requestedChapterNames, focus: intent.focus },
          status: 'done',
          result: reviewResult.text,
          isError: true,
        },
      ],
    };
  }

  const reviewPayload = parseTextJson(reviewResult.text) || {};
  storePendingDeAiChapterReview(session, reviewPayload, intent.focus);
  return {
    text: formatDeAiChapterReviewReply(reviewPayload),
    turns: 1,
    toolCalls: [
      {
        id: 'list-chapters-de-ai-review-auto',
        name: 'list_chapters',
        input: {},
        status: 'done',
        result: listResult.text,
        isError: false,
      },
      {
        id: 'review-de-ai-style-auto',
        name: 'review_de_ai_style',
        input: { chapterNames: requestedChapterNames, focus: intent.focus },
        status: 'done',
        result: reviewResult.text,
        isError: false,
      },
    ],
  };
}

async function persistAssistantTurn(session, result) {
  if (!session.threadId || (!result?.text && !(Array.isArray(result?.toolCalls) && result.toolCalls.length > 0))) {
    return;
  }
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
  } catch {
    // best-effort
  }
}

async function maybeHandleOutlineAutomation(session, userText, sessionId, abortSignal) {
  const activeNovelId = session.editorContext?.novelId || mcpClient.getActiveNovel();
  if (!activeNovelId) return null;

  if (detectOutlineConfirmIntent(userText, session)) {
    const incompleteReviewLabels = Array.isArray(session.pendingOutlineIssues)
      ? session.pendingOutlineIssues
          .filter((issue) => issue.reviewIncomplete)
          .map((issue) => (issue.sourceAgent === 'timeline' ? '时空校验' : '人设校验'))
      : [];
    if (incompleteReviewLabels.length) {
      return {
        text: `当前大纲还有未完成的审查：${Array.from(new Set(incompleteReviewLabels)).join('、')}。\n\n我先不建议直接写入。请回复“重新审查一下大纲”，或先继续调整草案。`,
        turns: 1,
        toolCalls: [],
      };
    }
    const nodes = session.pendingOutlineDraft?.nodes;
    if (!Array.isArray(nodes) || !nodes.length) {
      return {
        text: '当前没有可确认写入的大纲草案。',
        turns: 1,
        toolCalls: [],
      };
    }
    await callMcpTool('write_outline_nodes', { nodes });
    clearPendingOutlineDraft(session);
    session.workflowPhase = 'writing';
    const confirmToolCall = {
      id: 'confirm-outline-auto',
      name: 'confirm_outline',
      input: {},
      status: 'done',
      result: 'Outline confirmed and saved. Switched to writing phase.',
      isError: false,
    };
    const nextChapter = await maybeHandleChapterDraftAutomation(session, userText, sessionId, abortSignal);
    if (nextChapter) {
      return {
        text: [
          '已将当前大纲写入项目，并切换到写作阶段。',
          '',
          nextChapter.text || '',
        ].filter(Boolean).join('\n'),
        turns: 1 + (nextChapter.turns || 1),
        toolCalls: [
          confirmToolCall,
          ...(Array.isArray(nextChapter.toolCalls) ? nextChapter.toolCalls : []),
        ],
      };
    }
    return {
      text: '已将当前大纲写入项目，并切换到写作阶段。',
      turns: 1,
      toolCalls: [confirmToolCall],
    };
  }

  const intent = detectOutlineChatIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const generated = await generateOutlineDraft({
    mode: intent.mode,
    userText,
    pendingOutlineDraft: session.pendingOutlineDraft,
    abortSignal,
  });
  storePendingOutlineDraft(session, generated.draft, generated.blockingIssues);
  return {
    text: generated.assistantText,
    turns: 1,
    toolCalls: [],
  };
}

async function maybeHandleDeAiAutomation(session, sessionId, userText) {
  const intent = detectDeAiChatIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const rewriteResult = await callMcpTool('de_ai_ify', {
    text: intent.sourceText,
    guidance: intent.guidance,
  });
  if (rewriteResult.isError) {
    return {
      text: `去 AI 味改写失败：${rewriteResult.text}`,
      turns: 1,
      toolCalls: [
        {
          id: 'de-ai-ify-auto',
          name: 'de_ai_ify',
          input: { text: intent.sourceText, guidance: intent.guidance },
          status: 'done',
          result: rewriteResult.text,
          isError: true,
        },
      ],
    };
  }

  const rewritePayload = parseTextJson(rewriteResult.text);
  const replacement = safeStr(rewritePayload?.revisedText || rewriteResult.text).trim();
  if (!replacement) {
    throw new Error('de_ai_ify returned empty revisedText');
  }

  const replaceResult = await handleFrontendTool(session, {
    name: 'replace_selected_text',
    input: { replacement },
  });

  const replaceFailed = !!replaceResult?.isError;
  return {
    text: replaceFailed
      ? `去 AI 味改写已完成，但替换选中文本失败：${replaceResult.text}`
      : '已按你当前选中的内容去 AI 味改写，并替换回编辑器。',
    turns: 1,
    toolCalls: [
      {
        id: 'de-ai-ify-auto',
        name: 'de_ai_ify',
        input: { text: intent.sourceText, guidance: intent.guidance },
        status: 'done',
        result: rewriteResult.text,
        isError: false,
      },
      {
        id: 'replace-selected-auto',
        name: 'replace_selected_text',
        input: { replacement },
        status: 'done',
        result: replaceResult.text,
        isError: replaceFailed,
      },
    ],
  };
}

function formatCharacterConsistencyReviewReply(reviewPayload) {
  const characterNames = Array.isArray(reviewPayload?.reviewedCharacterNames) && reviewPayload.reviewedCharacterNames.length
    ? reviewPayload.reviewedCharacterNames.join('、')
    : '相关角色';
  const chapterName = safeStr(reviewPayload?.chapterName) || '当前章节';
  const annotations = Array.isArray(reviewPayload?.annotations) ? reviewPayload.annotations : [];

  if (!annotations.length) {
    return `我按段检查了 ${chapterName} 里与 ${characterNames} 相关的人设一致性，目前没有发现明确的硬冲突。\n\n这是审查结果，暂不自动改正文；如果你要我继续修，我会按你指定的段落逐处处理。`;
  }

  const lines = [`我按段检查了 ${chapterName} 里与 ${characterNames} 相关的人设一致性，发现 ${annotations.length} 处明确问题：`, ''];
  for (const annotation of annotations) {
    const paragraphIndexes = Array.isArray(annotation.paragraphIndexes) && annotation.paragraphIndexes.length
      ? annotation.paragraphIndexes.map((index) => `第${index + 1}段`).join(' / ')
      : `第${(annotation.paragraphIndex || 0) + 1}段`;
    lines.push(`- ${paragraphIndexes}：${annotation.note || '发现人设冲突'}`);
    if (annotation.characterName) lines.push(`  角色：${annotation.characterName}`);
    if (annotation.evidence) lines.push(`  依据：${annotation.evidence}`);
    if (annotation.excerpt) lines.push(`  摘录：${annotation.excerpt}`);
  }
  lines.push('');
  lines.push('这是审查结果，暂不自动批量改正文；如果你要修，我建议按选中段落逐处改，或先确认后用 apply_chapter_patch 一次提交多处非重叠修改；只有整章重写时才直接改整章，避免连续 replace_chapter_text 失配。');
  return lines.join('\n');
}

async function maybeHandleCharacterConsistencyReviewAutomation(session, userText) {
  const activeNovelId = session.editorContext?.novelId || mcpClient.getActiveNovel();
  if (!activeNovelId) return null;

  const intent = detectCharacterConsistencyReviewIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const reviewResult = await callMcpTool('review_character_consistency', {
    chapterName: intent.chapterName,
    focus: intent.focus,
  });
  if (reviewResult.isError) {
    return {
      text: `人设一致性审查失败：${reviewResult.text}`,
      turns: 1,
      toolCalls: [
        {
          id: 'review-character-consistency-auto',
          name: 'review_character_consistency',
          input: { chapterName: intent.chapterName, focus: intent.focus },
          status: 'done',
          result: reviewResult.text,
          isError: true,
        },
      ],
    };
  }

  const payload = parseTextJson(reviewResult.text) || { annotations: [] };
  return {
    text: formatCharacterConsistencyReviewReply(payload),
    turns: 1,
    toolCalls: [
      {
        id: 'review-character-consistency-auto',
        name: 'review_character_consistency',
        input: { chapterName: intent.chapterName, focus: intent.focus },
        status: 'done',
        result: reviewResult.text,
        isError: false,
      },
    ],
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
    novelContext: getActiveNovelContext(mcpClient),
  });
  const text = result.output || '';
  const suffix = result.truncated
    ? '\n\n（注意：子代理输出可能因模型长度上限未写完；请续写或再次调用 spawn_subagent，勿误以为工具结果被界面预览截断。）'
    : '';
  return { text: text + suffix, isError: false };
}

async function handleWebSearch(input, session) {
  const query = safeStr(input?.query).trim();
  if (!query) throw new Error('WebSearch: query required');
  const preferredEngine = safeStr(input?.preferredEngine).trim() || 'auto';
  const maxResults = Math.max(1, Number(input?.maxResults) || 5);
  const userLang = safeStr(session?.editorContext?.userLang || 'zh-CN') || 'zh-CN';
  const payload = await searchWeb({
    query,
    preferredEngine,
    userLang,
    fanworkSphere: 'global',
  });

  const results = (payload.results || []).slice(0, maxResults);
  let pageContent = '';
  let pageSource = '';
  let pageUrl = '';

  // Auto-fetch best page content from wiki/encyclopedia sources
  if (results.length > 0) {
    try {
      const bestPage = await fetchBestPage(results, userLang);
      const bestText = bestPage?.text || '';
      if (bestText && bestText.length > 200) {
        pageContent = bestText.slice(0, 6000);
        pageSource = `${bestPage.source || results[0]?.source || 'unknown'} | ${bestPage.title || results[0]?.title || ''}`;
        pageUrl = bestPage.url || results[0]?.url || '';
      }
    } catch (err) {
      console.error('[chatAgent] auto-fetch page failed:', err.message);
    }
  }

  const response = {
    query,
    preferredEngine,
    results,
    sources: payload.errors || [],
    sourceDetails: payload.sourceDetails || [],
  };

  if (pageContent) {
    response.fetchedPage = {
      source: pageSource,
      url: pageUrl,
      contentLength: pageContent.length,
      content: pageContent,
    };
    response.note = 'The fetched page content above is from the best wiki/encyclopedia result. You do NOT need to call WebFetch separately for this URL.';
  }

  return {
    text: JSON.stringify(response, null, 2),
    isError: false,
  };
}

async function handleWebFetch(input) {
  const url = safeStr(input?.url).trim();
  if (!url) throw new Error('WebFetch: url required');
  const maxChars = Math.max(256, Number(input?.maxChars) || 12000);
  const payload = await fetchWebPage(url, { maxChars });
  return {
    text: JSON.stringify(payload, null, 2),
    isError: !payload.ok,
  };
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
        const allowed = ['read_skill', 'list_skills', 'read_skill_content', 'de_ai_ify', 'create_novel', 'list_novels', 'get_system_time'];
        const filtered = mcpTools.filter((t) => allowed.includes(t.name));
        tools = [...filtered, ...DIRECT_API_CHAT_TOOLS];
      } else {
        tools = [...mcpTools, ...DIRECT_API_CHAT_TOOLS];
      }
      break; // success
    } catch (err) {
      if (retry === 0) {
        console.warn('[chatAgent] mcp.listTools failed, retrying...', err.message);
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.error('[chatAgent] mcp.listTools failed after retry', err);
        tools = [...DIRECT_API_CHAT_TOOLS];
      }
    }
  }

  const maxTurns = 12; // single user-query tool-use loop limit
  let turnIdx = 0;
  let lastText = '';
  const toolCalls = [];

  while (turnIdx < maxTurns) {
    if (abortSignal.aborted) throw new DOMException('aborted', 'AbortError');

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
    // Some Anthropic-compatible providers can emit tool_use blocks while
    // stopReason is missing or incorrectly reported as end_turn. Continue the
    // tool loop whenever tool_use blocks are present so we do not leave orphan
    // tool_use history that breaks the next request.
    if (!toolUses.length) {
      if (result.stopReason === 'max_tokens' && turnIdx < maxTurns - 1) {
        session.messages.push(userContent([{
          type: 'text',
          text: '[系统] 上一轮回复因输出长度达到模型上限而截断。请从断点继续完成，不要重复已写内容。',
        }]));
        turnIdx += 1;
        continue;
      }
      break;
    }

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
          if (phase && phase !== 'outline') clearPendingOutlineDraft(session);
          toolResult = { text: `Workflow phase changed to "${session.workflowPhase}".`, isError: false };
        } else if (use.name === 'confirm_outline') {
          const incompleteReview = Array.isArray(session.pendingOutlineIssues)
            && session.pendingOutlineIssues.some((issue) => issue.reviewIncomplete);
          if (incompleteReview) {
            throw new Error('Outline review is incomplete. Re-run review before confirmation.');
          }
          const nodes = Array.isArray(use.input?.nodes) && use.input.nodes.length
            ? use.input.nodes
            : session.pendingOutlineDraft?.nodes;
          if (Array.isArray(nodes) && nodes.length) {
            await callMcpTool('write_outline_nodes', { nodes });
          }
          clearPendingOutlineDraft(session);
          session.workflowPhase = 'writing';
          toolResult = { text: 'Outline confirmed and saved. Switched to writing phase.', isError: false };
        } else if (isFrontendTool(use.name)) {
          toolResult = await handleFrontendTool(session, use);
        } else if (use.name === 'WebSearch') {
          toolResult = await handleWebSearch(use.input, session);
        } else if (use.name === 'WebFetch') {
          toolResult = await handleWebFetch(use.input);
        } else if (use.name === 'spawn_subagent') {
          toolResult = await handleSpawnSubagent(use.input, session);
        } else if (use.name === 'write_chapter') {
          // Gate: write_chapter requires explicit user confirmation
          session.pendingWriteChapter = {
            name: use.input?.name || '',
            title: use.input?.title || '',
            content: use.input?.content || '',
            volumeIndex: use.input?.volumeIndex,
            sectionIndex: use.input?.sectionIndex,
            baseContent: use.input?.baseContent || '',
            insertAfter: use.input?.insertAfter || '',
            toolUseId: use.id,
          };
          emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
            name: session.pendingWriteChapter.name,
            title: session.pendingWriteChapter.title,
            contentPreview: session.pendingWriteChapter.content.slice(0, 500),
            contentLength: session.pendingWriteChapter.content.length,
          });
          toolResult = {
            text: '章节写入请求已收到，等待用户手动确认。请不要再调用其他工具，等待用户操作。',
            isError: false,
          };
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
      novelContext: getActiveNovelContext(mcpClient),
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

  session.messages.push(textContent(userText));

  emitEvent(sessionId, 'turn_start', { userText });

  try {
    const writeConfirmation = await maybeHandleWriteChapterConfirmation(session, userText, sessionId);
    if (writeConfirmation) {
      session.messages.push(assistantContent([{ type: 'text', text: writeConfirmation.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: writeConfirmation.text, turns: writeConfirmation.turns });
      await persistAssistantTurn(session, writeConfirmation);
      return;
    }

    const chapterAutomated = await maybeHandleChapterDraftAutomation(session, userText, sessionId, abortSignal);
    if (chapterAutomated) {
      session.messages.push(assistantContent([{ type: 'text', text: chapterAutomated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: chapterAutomated.text, turns: chapterAutomated.turns });
      await persistAssistantTurn(session, chapterAutomated);
      return;
    }

    const automated = await maybeHandleOutlineAutomation(session, userText, sessionId, abortSignal);
    if (automated) {
      session.messages.push(assistantContent([{ type: 'text', text: automated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: automated.text, turns: automated.turns });
      await persistAssistantTurn(session, automated);
      return;
    }

    const characterReviewAutomated = await maybeHandleCharacterConsistencyReviewAutomation(session, userText);
    if (characterReviewAutomated) {
      session.messages.push(assistantContent([{ type: 'text', text: characterReviewAutomated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: characterReviewAutomated.text, turns: characterReviewAutomated.turns });
      await persistAssistantTurn(session, characterReviewAutomated);
      return;
    }

    const chapterFactCheckAutomated = await maybeHandleChapterFactCheckAutomation(session, userText);
    if (chapterFactCheckAutomated) {
      session.messages.push(assistantContent([{ type: 'text', text: chapterFactCheckAutomated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: chapterFactCheckAutomated.text, turns: chapterFactCheckAutomated.turns });
      await persistAssistantTurn(session, chapterFactCheckAutomated);
      return;
    }

    const pendingDeAiApplyAutomated = await maybeHandlePendingDeAiChapterApply(session, userText);
    if (pendingDeAiApplyAutomated) {
      session.messages.push(assistantContent([{ type: 'text', text: pendingDeAiApplyAutomated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: pendingDeAiApplyAutomated.text, turns: pendingDeAiApplyAutomated.turns });
      await persistAssistantTurn(session, pendingDeAiApplyAutomated);
      return;
    }

    const deAiChapterReviewAutomated = await maybeHandleDeAiChapterReviewAutomation(session, userText);
    if (deAiChapterReviewAutomated) {
      session.messages.push(assistantContent([{ type: 'text', text: deAiChapterReviewAutomated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: deAiChapterReviewAutomated.text, turns: deAiChapterReviewAutomated.turns });
      await persistAssistantTurn(session, deAiChapterReviewAutomated);
      return;
    }

    const deAiAutomated = await maybeHandleDeAiAutomation(session, sessionId, userText);
    if (deAiAutomated) {
      session.messages.push(assistantContent([{ type: 'text', text: deAiAutomated.text || '' }]));
      emitEvent(sessionId, 'turn_done', { text: deAiAutomated.text, turns: deAiAutomated.turns });
      await persistAssistantTurn(session, deAiAutomated);
      return;
    }

    const system = await buildSystemPrompt(
      session.editorContext,
      useDriver,
      mcpClient.getActiveNovel(),
      session.workflowPhase,
      session.pendingOutlineDraft,
      session.pendingOutlineIssues
    );

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
    await persistAssistantTurn(session, result);
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
