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

const { createHash, randomUUID } = require('node:crypto');
const modelConfig = require('../modelConfig');
const { resolveDirectCandidates } = require('./modelResolver');
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
const chapterPostWriteCoordinator = require('./chapterPostWriteCoordinator');
const chapterPostWriteJobs = require('../store/chapterPostWriteJobs');
const { detectChapterChatIntent, detectChapterConfirmIntent } = require('./chapterIntent');
const { splitIntoParagraphs } = require('./chapterCharacterReview');
const {
  formatReviewIssueLabel,
  getOpenReviewIssues,
  hasBlockingReviewIssues,
  isOpenReviewIssue,
  mergeReviewIssues,
  reviewSourceLabel,
  setReviewIssueStatus,
} = require('../../domain/chapterReview.cjs');
const { buildSystemTimePromptBlock, getSystemTimeInfo } = require('./systemTime');
const {
  applyToolPolicy,
  assembleProviderContext,
  classifyCharacterContextPolicy,
  classifyChatToolPolicy,
  classifyRetrievalContextPolicy,
  createToolResultCache,
  fitTextForModel,
  fitToolResultForModel,
  isCacheableToolName,
  toolCacheKey,
} = require('./contextAssembler');
const appConfig = require('../store/appConfig');
const clientEvents = require('./clientEvents');
const { webContents } = require('electron');
const { parseJsonText } = require('./jsonText');
const { resolveAnchoredTextMatches } = require('../../domain/textMatch.cjs');
const { createExecutionTraceAccumulator } = require('./executionTrace');
const { getToolCapability } = require('./chatToolRegistry');
const { serializeConversationForDriver } = require('./chatConversationHistory');

// ---------- provider resolution ----------

function pickProvider(type) {
  if (type === 'anthropic') return require('./providers/anthropic');
  if (type === 'openai-compat') return require('./providers/openaiCompat');
  throw new Error(`Chat agent unsupported provider type: ${type}`);
}

async function resolveChatProvider() {
  const candidates = await resolveDirectCandidates({ systemTask: 'chat', legacyTier: 'opus' });
  if (!candidates.length) throw new Error('主聊天没有配置可用模型档案');
  return candidates[0].tier;
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

const SPAWN_SUBAGENT_ALIASES = {
  writer: 'sa-writer',
  'chapter-writer': 'sa-writer',
  chapter_writer: 'sa-writer',
  chapter_draft: 'sa-writer',
  drafter: 'sa-outline-drafter',
  outline: 'sa-outline-drafter',
  lore: 'sa-lore-updater',
  lore_updater: 'sa-lore-updater',
  memory: 'sa-character-memory-updater',
};

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
          content: fitToolResultForModel({
            toolName: tc.name,
            toolUseId: tc.id,
            content: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result ?? ''),
            isError: !!tc.isError,
          }).modelContent,
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
    pendingChapterAdvisoryIssues: [],
    pendingChapterFixPreview: null,
    pendingRoleplayProfileGate: null,
    pendingRoleplayProfileProposal: null,
    pendingRoleplayRiskGate: null,
    pendingDeAiChapterReview: null,
    pendingDeAiChapterPatchPreview: null,
    pendingWriteChapter: null, // { name, title, content, volumeIndex, sectionIndex, baseContent, toolUseId }
    pendingPostWriteJobId: null,
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

function broadcastEvent(sessionId, kind, data) {
  const session = sessions.get(sessionId);
  const payload = { sessionId, threadId: session?.threadId || null, kind, data, ts: Date.now() };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send('chatAgent:event', payload);
    } catch {
      // renderer may be gone
    }
  }
  clientEvents.emit('chatAgent:event', payload);
  return payload;
}

function recordExecutionEvent(session, kind, data) {
  const trace = session?.activeExecutionTrace;
  if (!trace || kind === 'execution_trace_update') return;
  if (kind === 'progress') {
    const stageKey = [data?.stage || 'progress', data?.sceneId, data?.revisionIndex, data?.attempt]
      .filter((item) => item !== undefined && item !== null && item !== '')
      .join('-');
    trace.upsertStage(stageKey, {
      kind: data?.stage || 'process',
      label: data?.message || data?.stage || '执行中',
      summary: data?.message || '',
      status: /失败|暂停|阻塞/u.test(data?.message || '') ? 'blocked' : 'running',
    });
    trace.addProcess(data?.message || '');
    if (data?.harnessTrace) trace.mergeHarness(data.harnessTrace);
  } else if (kind === 'context_manifest') {
    trace.setContextManifest(data || {});
    trace.upsertStage(`context-${data?.turnIdx ?? 0}`, {
      kind: 'context', label: '装配上下文', status: 'completed', summary: `第 ${(data?.turnIdx ?? 0) + 1} 轮上下文已装配`,
    });
  } else if (kind === 'context_stats') {
    trace.upsertStage(`context-stats-${data?.turnIdx ?? 0}`, {
      kind: 'context', label: '上下文预算', status: 'completed', summary: `预计输入 ${Number(data?.estimatedInputTokens) || 0} tokens`,
    });
  } else if (kind === 'tool_use') {
    const capability = getToolCapability(data?.name);
    trace.upsertTool({ ...capability, ...data, status: 'running' });
  } else if (kind === 'tool_result') {
    const capability = getToolCapability(data?.name);
    trace.upsertTool({ ...capability, ...data, status: data?.isError ? 'failed' : 'done', result: data?.text });
  } else if (kind === 'model_selected') {
    trace.setRuntime({ model: data?.provenance || '' });
  } else if (kind === 'model_fallback') {
    trace.addFallback(data || {});
  } else if (/^awaiting_/u.test(kind)) {
    trace.addDecision({ kind, status: 'pending', summary: data?.message || data?.summary || kind });
  } else if (/_resolved$/u.test(kind)) {
    trace.addDecision({ kind, status: data?.confirmed === false || data?.cancelled ? 'rejected' : 'resolved', summary: kind });
  } else if (kind === 'error') {
    trace.addProcess(`执行失败：${data?.message || '未知错误'}`);
  }
}

function emitEvent(sessionId, kind, data) {
  // Broadcast to all webContents. Renderer filters by sessionId.
  const session = sessions.get(sessionId);
  recordExecutionEvent(session, kind, data);
  return broadcastEvent(sessionId, kind, data);
}

function emitProgressEvent(sessionId, message, detail = {}) {
  if (!message) return;
  emitEvent(sessionId, 'progress', {
    message: safeStr(message),
    ...detail,
  });
}

function emitRoleplayEvent(sessionId, event, sink) {
  if (!event || typeof event !== 'object') return null;
  const normalized = {
    eventId: event.eventId || `roleplay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type: safeStr(event.type || 'unknown'),
    chapterRef: safeStr(event.chapterRef || ''),
    sceneId: safeStr(event.sceneId || ''),
    title: safeStr(event.title || ''),
    actor: event.actor && typeof event.actor === 'object' ? event.actor : null,
    summary: safeStr(event.summary || ''),
    details: event.details && typeof event.details === 'object' ? event.details : {},
    riskLevel: safeStr(event.riskLevel || 'none'),
    ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
  };
  if (Array.isArray(sink)) sink.push(normalized);
  emitEvent(sessionId, 'roleplay_event', normalized);
  return normalized;
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
          : '8. For chapters longer than ~2000 words, use `spawn_subagent({subagentId:"sa-writer", input:"..."})` to generate the full chapter text so it is not truncated by the chat turn token limit. Do not use `writer` as the subagentId. Then call `write_chapter` with the generated result.',
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
    lines.push('- Review: review_character_consistency (inspect chapter paragraphs against character cards and report paragraph-level conflicts without editing), review_de_ai_style (inspect one or more chapters for AI-ish cliches and mechanical prose without editing), review_paragraph_function (second-pass review for one-sentence paragraphs and paragraph-function problems without editing)');
    lines.push('- Rewrite: de_ai_ify (rewrite a Chinese fiction passage to remove AI-ish cliches while preserving meaning)');
    lines.push('- Auto-write: grant_asset, revoke_asset, apply_asset_patch, append_timeline, update_timeline, dedupe_timeline, append_summary, append_style_memory');
    lines.push('- Write (requires confirmation): create_character, update_character, update_world, apply_world_patch, write_chapter, replace_chapter_text, apply_chapter_patch');
  } else {
    lines.push('- Bootstrap discovery: list_novels, read_skill, list_skills, read_skill_content, de_ai_ify. `create_novel` is exposed only for an explicit project-creation request.');
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
      : '2. Use `spawn_subagent` for heavy tasks (drafting, review). Subagents run through the active driver. For chapter drafting, the subagentId is `sa-writer`.',
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
    lines.push('12d. Every chapter mutation is preview-only on first call. The app runs strict verification and asks the user to confirm the verified preview; never claim the file was written before that confirmation.');
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

function normalizeChineseIntentText(value) {
  return safeStr(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function chapterContentHash(value) {
  return createHash('sha256').update(safeStr(value).replace(/\r\n/gu, '\n').trim()).digest('hex').slice(0, 16);
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
  session.pendingChapterAdvisoryIssues = [];
  session.pendingChapterFixPreview = null;
}

function clearPendingRoleplayProfile(session) {
  session.pendingRoleplayProfileGate = null;
  session.pendingRoleplayProfileProposal = null;
}

function clearPendingRoleplayRisk(session) {
  session.pendingRoleplayRiskGate = null;
}

function clearPendingDeAiChapterReview(session) {
  session.pendingDeAiChapterReview = null;
  session.pendingDeAiChapterPatchPreview = null;
}

function clearPendingWriteChapter(session) {
  session.pendingWriteChapter = null;
}

function getPendingChapterIssues(session) {
  return mergeReviewIssues(
    session?.pendingChapterIssues || [],
    session?.pendingChapterAdvisoryIssues || [],
    session?.pendingChapterDraft?.advisoryIssues || []
  );
}

function storePendingChapterIssues(session, issues) {
  const merged = mergeReviewIssues(issues || []);
  session.pendingChapterIssues = merged;
  session.pendingChapterAdvisoryIssues = merged.filter((issue) => (
    issue?.source === 'style'
    || issue?.source === 'prose_quality'
    || issue?.source === 'paragraph_function'
  ));
  if (session.pendingChapterDraft) {
    session.pendingChapterDraft.advisoryIssues = session.pendingChapterAdvisoryIssues;
  }
}

function storePendingChapterDraftResult(session, draftResult) {
  session.pendingChapterDraft = draftResult.draft || null;
  storePendingChapterIssues(
    session,
    draftResult.issues || draftResult.blockingIssues || []
  );
  session.workflowPhase = 'writing';
}

function formatPendingChapterOpenIssues(issues, { prefix = '当前章节草稿仍有 open 审查问题，先不写入。' } = {}) {
  const openIssues = getOpenReviewIssues(issues);
  const lines = [prefix];
  if (!openIssues.length) return `${prefix}\n\n当前没有 open 问题。`;
  lines.push('');
  openIssues.slice(0, 12).forEach((issue, index) => {
    const note = issue.summary || issue.note || issue.detail || '未命名问题';
    lines.push(`${index + 1}. ${formatReviewIssueLabel(issue)} ${note}`);
    if (issue.excerpt) lines.push(`   摘录：${issue.excerpt}`);
  });
  if (openIssues.length > 12) lines.push(`...另有 ${openIssues.length - 12} 条未展开。`);
  lines.push('');
  lines.push('可以回复“预览修复第 N 条”“修复全部可自动修复项”“忽略第 N 条”或“全部标记通过”。');
  return lines.join('\n');
}

function parseIssueOrdinalFromText(text) {
  const source = safeStr(text);
  const match = source.match(/第\s*([零〇一二两三四五六七八九十百千\d]+)\s*条/u)
    || source.match(/(?:修复|忽略|通过|处理|看)\s*([零〇一二两三四五六七八九十百千\d]+)\s*(?:条)?/u);
  if (!match) return NaN;
  return parseChapterOrdinal(match[1]);
}

function detectPendingChapterIssueDecisionIntent(userText, session) {
  if (!session?.pendingChapterDraft?.text) return { action: null };
  const text = safeStr(userText).trim();
  if (!text) return { action: null };
  if (/全部(?:标记)?通过|全部忽略|忽略全部|都(?:标记)?通过|都忽略/u.test(text)) {
    return {
      action: /忽略/u.test(text) ? 'ignored' : 'passed',
      all: true,
    };
  }
  if (/忽略第\s*[零〇一二两三四五六七八九十百千\d]+\s*条|第\s*[零〇一二两三四五六七八九十百千\d]+\s*条.{0,8}忽略/u.test(text)) {
    return { action: 'ignored', ordinal: parseIssueOrdinalFromText(text) };
  }
  if (/(?:标记)?通过第\s*[零〇一二两三四五六七八九十百千\d]+\s*条|第\s*[零〇一二两三四五六七八九十百千\d]+\s*条.{0,8}(?:通过|没问题)/u.test(text)) {
    return { action: 'passed', ordinal: parseIssueOrdinalFromText(text) };
  }
  return { action: null };
}

function maybeHandlePendingChapterIssueDecision(session, userText) {
  const intent = detectPendingChapterIssueDecisionIntent(userText, session);
  if (!intent.action) return null;

  const issues = getPendingChapterIssues(session);
  const openIssues = getOpenReviewIssues(issues);
  if (!openIssues.length) {
    return {
      text: '当前章节草稿没有 open 审查问题；如果认可这版正文，可以回复“确认写入这一章”。',
      turns: 1,
      toolCalls: [],
    };
  }

  let targetIds = [];
  if (intent.all) {
    targetIds = openIssues
      .filter((issue) => !issue.reviewIncomplete)
      .map((issue) => issue.id);
  } else {
    const index = intent.ordinal - 1;
    const issue = openIssues[index];
    if (!issue) {
      return {
        text: `没有找到第 ${intent.ordinal || '?'} 条 open 问题。`,
        turns: 1,
        toolCalls: [],
      };
    }
    if (issue.reviewIncomplete) {
      return {
        text: '这条是“审查未完成”阻塞，不能直接忽略或标记通过。请回复“重新审查这一章”，或先继续修改草稿后再审。',
        turns: 1,
        toolCalls: [],
      };
    }
    targetIds = [issue.id];
  }

  if (!targetIds.length) {
    return {
      text: '当前 open 问题里只有审查未完成项，不能用“全部通过/忽略”绕过。请先重新审查。',
      turns: 1,
      toolCalls: [],
    };
  }

  const nextIssues = setReviewIssueStatus(
    issues,
    (issue) => targetIds.includes(issue.id),
    intent.action
  );
  storePendingChapterIssues(session, nextIssues);
  session.pendingChapterFixPreview = null;
  const remaining = getOpenReviewIssues(nextIssues);
  return {
    text: remaining.length
      ? formatPendingChapterOpenIssues(nextIssues, { prefix: `已将 ${targetIds.length} 条问题标记为 ${intent.action === 'ignored' ? 'ignored' : 'passed'}，但仍有 open 项。` })
      : '所有审查问题都已关闭；如果认可这版正文，可以回复“确认写入这一章”。',
    turns: 1,
    toolCalls: [],
  };
}

function isPendingChapterFixPreviewIntent(userText) {
  const text = safeStr(userText);
  return /预览修复|修复第\s*[零〇一二两三四五六七八九十百千\d]+\s*条|修复全部可自动修复项|自动修复|修一下第/u.test(text);
}

function isPendingChapterFixApplyIntent(userText) {
  return /应用修复|确认应用|应用这个|采用预览|就按这个修|确认修复/u.test(safeStr(userText));
}

function isPendingChapterFixCancelIntent(userText) {
  return /取消修复|放弃修复|不要应用|先别应用|撤销预览/u.test(safeStr(userText));
}

function isDraftIssueAutoFixable(issue) {
  return ['style', 'prose_quality', 'paragraph_function'].includes(issue?.source || issue?.sourceAgent);
}

function issueParagraphIndexes(issue, paragraphs) {
  const byId = new Map((paragraphs || []).map((paragraph) => [paragraph.id, paragraph]));
  const indexes = [];
  const add = (value) => {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= paragraphs.length || indexes.includes(index)) return;
    indexes.push(index);
  };
  if (Array.isArray(issue?.paragraphIndexes)) issue.paragraphIndexes.forEach(add);
  if (Number.isInteger(issue?.paragraphIndex)) add(issue.paragraphIndex);
  if (Array.isArray(issue?.paragraphIds)) {
    issue.paragraphIds.forEach((id) => add(byId.get(id)?.index));
  }
  return indexes.sort((left, right) => left - right);
}

function groupContiguousIndexes(indexes) {
  const sorted = Array.from(new Set(indexes)).sort((left, right) => left - right);
  const groups = [];
  let current = [];
  for (const index of sorted) {
    if (!current.length || index === current[current.length - 1] + 1) {
      current.push(index);
    } else {
      groups.push(current);
      current = [index];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function buildFixGuidanceForIssues(issues) {
  const lines = ['只处理下列审查问题对应的段落，保留事实、人称、人物关系和时空链，不要扩写新剧情。'];
  for (const issue of issues) {
    lines.push(`- [${reviewSourceLabel(issue.source)}] ${issue.summary || issue.note || issue.detail || ''}`);
    if (issue.suggestedAction) lines.push(`  建议动作：${issue.suggestedAction}`);
  }
  return lines.join('\n');
}

function buildFixPreviewText(preview) {
  const lines = [
    '已生成局部修复预览，尚未应用到草稿。',
    '',
    `影响段落：${preview.affectedParagraphIndexes.map((index) => `第${index + 1}段`).join(' / ') || '未定位'}`,
  ];
  if (preview.risk) lines.push(`风险提示：${preview.risk}`);
  lines.push('', '变更预览：');
  for (const edit of preview.edits.slice(0, 8)) {
    lines.push(`- 第${edit.paragraphIndex + 1}段`);
    lines.push(`  原文：${compactPatchContext(edit.original, 180)}`);
    lines.push(`  新文：${compactPatchContext(edit.replacement, 180)}`);
  }
  if (preview.edits.length > 8) lines.push(`- 另有 ${preview.edits.length - 8} 处变更未展开。`);
  lines.push('', '确认后回复“应用修复”；不想用这版可回复“取消修复”。');
  return lines.join('\n');
}

async function buildAutoFixPreviewForDraft(session, selectedIssues) {
  const draft = session.pendingChapterDraft;
  const paragraphs = splitIntoParagraphs(draft.text || '');
  if (!paragraphs.length) throw new Error('当前草稿没有可定位段落');

  const allIssues = getPendingChapterIssues(session);
  const expandedIssues = [];
  for (const issue of selectedIssues) {
    expandedIssues.push(issue);
    if ((issue.source || issue.sourceAgent) === 'paragraph_function') {
      const currentIndexes = issueParagraphIndexes(issue, paragraphs);
      for (const other of allIssues) {
        if ((other.source || other.sourceAgent) !== 'paragraph_function' || other.id === issue.id || !isOpenReviewIssue(other)) continue;
        const otherIndexes = issueParagraphIndexes(other, paragraphs);
        if (currentIndexes.some((index) => otherIndexes.some((otherIndex) => Math.abs(otherIndex - index) <= 1))) {
          expandedIssues.push(other);
        }
      }
    }
  }
  const targetIssues = mergeReviewIssues(expandedIssues);
  const targetIndexes = Array.from(new Set(targetIssues.flatMap((issue) => issueParagraphIndexes(issue, paragraphs))))
    .sort((left, right) => left - right);
  if (!targetIndexes.length) throw new Error('这条问题缺少段落定位，不能安全做段落级自动修复；请先让我按你的指示人工修订，或要求生成整章修订预览。');

  const replacements = new Map();
  const skipIndexes = new Set();
  const consumed = new Set();
  const toolCalls = [];
  const paragraphFunctionIndexes = targetIssues
    .filter((issue) => (issue.source || issue.sourceAgent) === 'paragraph_function')
    .flatMap((issue) => issueParagraphIndexes(issue, paragraphs));
  const mergeGroups = groupContiguousIndexes(paragraphFunctionIndexes).filter((group) => group.length >= 2);

  for (const group of mergeGroups) {
    const sourceText = group.map((index) => paragraphs[index]?.text || '').filter(Boolean).join('\n\n');
    if (!sourceText) continue;
    const guidance = [
      buildFixGuidanceForIssues(targetIssues),
      '这组相邻段落主要问题是机械拆段/一句一段。请把它们按自然段功能合并或重写为更顺的段落组；如果仍需停顿，只保留真正承担节奏落点的短段。',
    ].join('\n');
    const rewriteArgs = {
      text: sourceText,
      guidance,
      chapterName: draft.name || '',
      targetParagraphIndexes: group,
      referenceSamples: buildNearbyDeAiReferenceSamples(paragraphs, targetIndexes, group),
      problemEvidence: targetIssues.map((issue) => issue.evidence || issue.summary || issue.note).filter(Boolean),
      preserveConstraints: ['只处理已标注问题', '不得添加原文没有的动作、对白、景物、心理、感官或比喻'],
    };
    const rewriteResult = await callMcpTool('de_ai_ify', rewriteArgs);
    toolCalls.push({
      id: `pending-draft-de-ai-merge-${group[0]}-${Date.now().toString(36)}`,
      name: 'de_ai_ify',
      input: { ...rewriteArgs, paragraphIndexes: group },
      status: 'done',
      result: rewriteResult.text,
      isError: rewriteResult.isError,
    });
    if (rewriteResult.isError) throw new Error(rewriteResult.text || 'de_ai_ify failed');
    const payload = parseTextJson(rewriteResult.text);
    const replacement = safeStr(payload?.revisedText || rewriteResult.text).trim();
    if (!replacement) continue;
    replacements.set(group[0], replacement);
    consumed.add(group[0]);
    for (const index of group.slice(1)) {
      skipIndexes.add(index);
      consumed.add(index);
    }
  }

  for (const index of targetIndexes) {
    if (consumed.has(index)) continue;
    const paragraph = paragraphs[index];
    if (!paragraph?.text) continue;
    const related = targetIssues.filter((issue) => issueParagraphIndexes(issue, paragraphs).includes(index));
    const guidance = buildFixGuidanceForIssues(related.length ? related : targetIssues);
    const rewriteArgs = {
      text: paragraph.text,
      guidance,
      chapterName: draft.name || '',
      targetParagraphIndexes: [index],
      referenceSamples: buildNearbyDeAiReferenceSamples(paragraphs, targetIndexes, [index]),
      problemEvidence: (related.length ? related : targetIssues).map((issue) => issue.evidence || issue.summary || issue.note).filter(Boolean),
      preserveConstraints: ['只处理已标注问题', '不得添加原文没有的动作、对白、景物、心理、感官或比喻', '保留原有短句、停顿和段落节奏'],
    };
    const rewriteResult = await callMcpTool('de_ai_ify', rewriteArgs);
    toolCalls.push({
      id: `pending-draft-de-ai-${index}-${Date.now().toString(36)}`,
      name: 'de_ai_ify',
      input: { ...rewriteArgs, paragraphIndex: index },
      status: 'done',
      result: rewriteResult.text,
      isError: rewriteResult.isError,
    });
    if (rewriteResult.isError) throw new Error(rewriteResult.text || 'de_ai_ify failed');
    const payload = parseTextJson(rewriteResult.text);
    const replacement = safeStr(payload?.revisedText || rewriteResult.text).trim();
    if (replacement && replacement !== paragraph.text.trim()) replacements.set(index, replacement);
  }

  const nextParagraphs = [];
  const edits = [];
  paragraphs.forEach((paragraph, index) => {
    if (skipIndexes.has(index)) return;
    const replacement = replacements.get(index);
    if (replacement) {
      nextParagraphs.push({ ...paragraph, text: replacement });
      edits.push({
        paragraphIndex: index,
        paragraphId: paragraph.id,
        original: paragraph.text,
        replacement,
      });
    } else {
      nextParagraphs.push(paragraph);
    }
  });
  if (!edits.length) throw new Error('修复器没有生成有效改动；草稿保持不变。');

  return {
    kind: 'pending_draft',
    issueIds: targetIssues.map((issue) => issue.id),
    beforeText: draft.text,
    afterText: nextParagraphs.map((paragraph) => paragraph.text).join('\n\n'),
    affectedParagraphIds: targetIndexes.map((index) => paragraphs[index]?.id).filter(Boolean),
    affectedParagraphIndexes: targetIndexes,
    edits,
    toolCalls,
    risk: '仅改动定位段落及必要相邻短段；应用后会触发复审。',
    createdAt: Date.now(),
  };
}

async function buildHardIssuePreviewForDraft(session, selectedIssues, userText, sessionId, abortSignal) {
  const draft = session.pendingChapterDraft;
  const issueLines = selectedIssues.map((issue, index) => {
    const paragraphs = Array.isArray(issue.paragraphIndexes) && issue.paragraphIndexes.length
      ? `（${issue.paragraphIndexes.map((item) => `第${item + 1}段`).join(' / ')}）`
      : '';
    return `${index + 1}. [${reviewSourceLabel(issue.source)}]${paragraphs} ${issue.summary || issue.note || issue.detail || ''}`;
  }).join('\n');
  const repairPrompt = [
    '请基于当前草稿生成“最小范围修订预览”，只修复以下审查问题。',
    '不要写入项目，不要调用保存工具；保留原章节核心剧情、叙事视角和未涉及段落。',
    '',
    issueLines,
    '',
    userText ? `用户补充：${safeStr(userText)}` : '',
  ].filter(Boolean).join('\n');
  const result = await chapterDraftService.generateChapterDraft({
    mode: 'revise',
    userText: repairPrompt,
    pendingChapterDraft: draft,
    editorContext: session.editorContext,
    abortSignal,
    onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
  });
  if (!result?.draft?.text) throw new Error('writer 没有生成可预览的修订草稿');
  return {
    kind: 'pending_draft',
    issueIds: selectedIssues.map((issue) => issue.id),
    beforeText: draft.text,
    afterText: result.draft.text,
    candidateDraft: result.draft,
    affectedParagraphIds: selectedIssues.flatMap((issue) => issue.paragraphIds || []),
    affectedParagraphIndexes: selectedIssues.flatMap((issue) => issue.paragraphIndexes || []),
    edits: [{
      paragraphIndex: selectedIssues[0]?.paragraphIndexes?.[0] ?? 0,
      paragraphId: selectedIssues[0]?.paragraphIds?.[0] || 'whole-draft-preview',
      original: draft.text,
      replacement: result.draft.text,
    }],
    toolCalls: [],
    risk: '这条属于人设/时空/事件账本硬审问题，预览可能涉及跨段衔接；不会自动应用，需你确认。',
    createdAt: Date.now(),
  };
}

async function maybeHandlePendingChapterFixPreview(session, userText, sessionId, abortSignal) {
  if (!session?.pendingChapterDraft?.text) return null;

  if (session.pendingChapterFixPreview && isPendingChapterFixCancelIntent(userText)) {
    session.pendingChapterFixPreview = null;
    return { text: '已取消这次修复预览，草稿没有变化。', turns: 1, toolCalls: [] };
  }

  if (session.pendingChapterFixPreview && isPendingChapterFixApplyIntent(userText)) {
    const preview = session.pendingChapterFixPreview;
    const beforeIssues = getPendingChapterIssues(session);
    const baseDraft = session.pendingChapterDraft || {};
    session.pendingChapterDraft = {
      ...baseDraft,
      ...(preview.candidateDraft || {}),
      text: preview.afterText,
    };
    let nextIssues = setReviewIssueStatus(beforeIssues, (issue) => preview.issueIds.includes(issue.id), 'fixed');
    let reviewWarning = '';
    try {
      const reviewResult = await chapterDraftService.reviewExistingChapterDraft({
        mode: 'review',
        userText: [
          '小范围复审：刚应用了局部修复预览。',
          preview.affectedParagraphIndexes.length
            ? `重点复查这些段落及前后衔接：${preview.affectedParagraphIndexes.map((index) => `第${index + 1}段`).join('、')}`
            : '重点复查本次改动区域及前后衔接。',
        ].join('\n'),
        draft: session.pendingChapterDraft,
        retrievedContext: baseDraft.roleplayContext?.retrievedContext || null,
        abortSignal,
        onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
      });
      const rerunIssues = mergeReviewIssues(reviewResult?.issues || reviewResult?.blockingIssues || []);
      const preservedClosed = nextIssues.filter((issue) => !isOpenReviewIssue(issue) && !preview.issueIds.includes(issue.id));
      const fixedTargets = nextIssues.filter((issue) => preview.issueIds.includes(issue.id));
      nextIssues = mergeReviewIssues(rerunIssues, preservedClosed, fixedTargets);
    } catch (err) {
      reviewWarning = `\n\n复审暂未完成：${trimMessage(err?.message || String(err))}。为安全起见，写入前仍建议重新审查。`;
    }
    storePendingChapterIssues(session, nextIssues);
    session.pendingChapterFixPreview = null;
    const remaining = getOpenReviewIssues(nextIssues);
    return {
      text: remaining.length
        ? `${formatPendingChapterOpenIssues(nextIssues, { prefix: '修复已应用到待确认草稿，并完成复审；当前仍有 open 问题。' })}${reviewWarning}`
        : `修复已应用到待确认草稿，复审未发现 open 问题；现在可以回复“确认写入这一章”。${reviewWarning}`,
      turns: 1,
      toolCalls: Array.isArray(preview.toolCalls) ? preview.toolCalls : [],
    };
  }

  if (!isPendingChapterFixPreviewIntent(userText)) return null;

  const issues = getPendingChapterIssues(session);
  const openIssues = getOpenReviewIssues(issues);
  if (!openIssues.length) {
    return { text: '当前没有 open 问题需要修复；如果认可这版正文，可以确认写入。', turns: 1, toolCalls: [] };
  }

  const wantsAllAuto = /全部可自动修复项|自动修复|全部修复/u.test(safeStr(userText));
  let selectedIssues = [];
  if (wantsAllAuto) {
    selectedIssues = openIssues.filter((issue) => !issue.reviewIncomplete && isDraftIssueAutoFixable(issue));
  } else {
    const ordinal = parseIssueOrdinalFromText(userText);
    const issue = openIssues[ordinal - 1];
    if (!issue) {
      return { text: `没有找到第 ${ordinal || '?'} 条 open 问题。`, turns: 1, toolCalls: [] };
    }
    if (issue.reviewIncomplete) {
      return { text: '这条是审查未完成项，不能生成修复预览。请先回复“重新审查这一章”。', turns: 1, toolCalls: [] };
    }
    selectedIssues = [issue];
  }

  if (!selectedIssues.length) {
    return {
      text: '当前没有可自动修复的 open 项。人设/时空硬审问题请回复“预览修复第 N 条”，我会生成单条最小修订预览。',
      turns: 1,
      toolCalls: [],
    };
  }

  try {
    const preview = selectedIssues.every(isDraftIssueAutoFixable)
      ? await buildAutoFixPreviewForDraft(session, selectedIssues)
      : await buildHardIssuePreviewForDraft(session, selectedIssues, userText, sessionId, abortSignal);
    session.pendingChapterFixPreview = preview;
    return {
      text: buildFixPreviewText(preview),
      turns: 1,
      toolCalls: Array.isArray(preview.toolCalls) ? preview.toolCalls : [],
    };
  } catch (err) {
    return {
      text: `生成修复预览失败：${err?.message || String(err)}\n\n草稿没有变化。你可以改为指定段落手动修订，或先忽略/标记通过该问题。`,
      turns: 1,
      toolCalls: [],
    };
  }
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

  if (confirmPattern.test(text) || isForceOverwriteWriteIntent(text)) {
    session.activeExecutionTrace?.setVerification({
      status: pending.verification?.status || 'blocked',
      checks: pending.verification?.checks || [],
    });
  }

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

  if ((confirmPattern.test(text) || isForceOverwriteWriteIntent(text)) && pending.verification?.status !== 'passed') {
    const issues = getPendingChapterIssues(session);
    return {
      text: formatPendingChapterOpenIssues(issues, { prefix: '章节变更尚未通过严格验证，因此不能写入。草稿仍已保留。' }),
      turns: 1,
      toolCalls: [],
      executionTrace: session.activeExecutionTrace?.snapshot?.() || null,
    };
  }

  if ((confirmPattern.test(text) || isForceOverwriteWriteIntent(text))
    && pending.verification?.contentHash !== chapterContentHash(pending.content || '')) {
    session.pendingWriteChapter = {
      ...pending,
      verification: { ...(pending.verification || {}), status: 'blocked' },
    };
    return {
      text: '待写入正文在验证后发生了变化，旧验证记录已经失效。为了避免写入未验证内容，请重新生成或重新验证。草稿仍已保留。',
      turns: 1,
      toolCalls: [],
    };
  }

  if (confirmPattern.test(text) || (pending.staleSnapshotMismatch && isForceOverwriteWriteIntent(text))) {
    if (pending.kind === 'chapter_mutation' && pending.mutationTool) {
      const mutationArgs = {
        ...(pending.mutationArgs || {}),
        previewOnly: false,
        verifiedContentHash: pending.verification.contentHash,
      };
      if (pending.baseContent) mutationArgs.baseContent = pending.baseContent;
      let result;
      if (pending.mutationExecution === 'frontend') {
        const currentEditor = await handleFrontendTool(session, {
          id: `${pending.toolUseId || 'frontend'}-snapshot`,
          name: 'get_full_editor_content',
          input: {},
        });
        if (currentEditor.isError || safeStr(currentEditor.text) !== safeStr(pending.baseContent)) {
          result = { text: currentEditor.isError ? currentEditor.text : 'chapter snapshot mismatch: editor content changed after preview', isError: true };
        } else {
          result = await handleFrontendTool(session, { id: pending.toolUseId, name: pending.mutationTool, input: pending.mutationArgs || {} });
        }
      } else {
        result = await callMcpTool(pending.mutationTool, mutationArgs);
      }
      if (result.isError) {
        return {
          text: `章节变更提交失败：${result.text}\n\n预览仍已保留，没有通过其他路径覆盖文件。`,
          turns: 1,
          toolCalls: [{ id: pending.toolUseId, name: pending.mutationTool, input: { name: pending.name }, status: 'done', result: result.text, isError: true }],
        };
      }
      clearPendingWriteChapter(session);
      emitEvent(sessionId, 'write_chapter_resolved', { confirmed: true, mutationTool: pending.mutationTool, isError: false });
      return {
        text: `已提交并写入 ${pending.title || pending.name || '章节'} 的严格验证变更。`,
        turns: 1,
        toolCalls: [{ id: pending.toolUseId, name: pending.mutationTool, input: { name: pending.name }, status: 'done', result: result.text, isError: false }],
      };
    }
    // User confirmed — execute the pending write
    const draftId = pending.draftId || randomUUID();
    const pendingDraftPayload = {
      name: pending.name || '',
      displayName: pending.title || pending.name || '',
      title: pending.title || pending.name || '',
      summary: pending.summary || '',
      text: pending.content || '',
      volumeIndex: pending.volumeIndex,
      sectionIndex: pending.sectionIndex,
      contextBundle: pending.contextBundle || null,
      sceneContracts: pending.sceneContracts || [],
      assertions: pending.assertions || [],
      pendingStateDelta: pending.pendingStateDelta || {},
      harnessTrace: pending.harnessTrace || null,
      stateVerifications: pending.stateVerifications || pending.harnessTrace?.stateVerifications || [],
      sourceUsage: pending.sourceUsage || pending.harnessTrace?.sourceUsage || [],
    };
    let postWriteJobReady = false;
    try {
      await chapterPostWriteJobs.ensureJob({
        draftId,
        draft: pendingDraftPayload,
        roleplayContext: pending.roleplayContext || null,
      });
      await chapterPostWriteJobs.updateStep(draftId, 'chapterWrite', 'running');
      postWriteJobReady = true;
    } catch {
      // The chapter write remains available even if the auxiliary ledger is temporarily unavailable.
    }
    const writeArgs = {
      name: pending.name || undefined,
      title: pending.title || undefined,
      content: pending.content,
      verifiedContentHash: pending.verification.contentHash,
      volumeIndex: pending.volumeIndex,
      sectionIndex: pending.sectionIndex,
      insertAfter: pending.insertAfter || undefined,
    };
    if (!isForceOverwriteWriteIntent(text) && pending.baseContent) {
      writeArgs.baseContent = pending.baseContent;
    }
    const result = await callMcpTool('write_chapter', writeArgs);

    if (result.isError && isChapterSnapshotMismatch(result.text)) {
      if (postWriteJobReady) {
        await chapterPostWriteJobs.updateStep(draftId, 'chapterWrite', 'failed', { error: result.text }).catch(() => {});
      }
      session.pendingWriteChapter = {
        ...pending,
        draftId,
        staleSnapshotMismatch: true,
        lastError: result.text,
      };
      emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
        name: pending.name,
        title: pending.title,
        contentPreview: safeStr(pending.content).slice(0, 500),
        contentLength: safeStr(pending.content).length,
        warning: '目标章节在读取后发生过变化。可覆盖写入，或重新读取后再生成。',
        verificationStatus: pending.verification?.status || 'blocked',
        blockingIssues: [],
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
      if (postWriteJobReady) {
        const writtenDraft = { ...pendingDraftPayload, name: writtenName };
        await chapterPostWriteJobs.ensureJob({
          draftId,
          draft: writtenDraft,
          roleplayContext: pending.roleplayContext || null,
        });
        await chapterPostWriteJobs.updateStep(draftId, 'chapterWrite', 'done', { result: { name: writtenName } });
      }
      try {
        if (!postWriteJobReady) throw new Error('写后任务账本暂不可用');
        const postWrite = await chapterPostWriteCoordinator.runPostWriteJob({
          draftId,
          abortSignal: session.abortController?.signal || null,
          onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
        });
        followupToolCalls.push(...(Array.isArray(postWrite.toolCalls) ? postWrite.toolCalls : []));
        const failedSteps = Object.entries(postWrite.job?.steps || {})
          .filter(([, step]) => step?.status === 'failed')
          .map(([name]) => name);
        if (failedSteps.length) {
          session.pendingPostWriteJobId = draftId;
          followupNotes.push(`写后同步仍有失败步骤：${failedSteps.join('、')}。可回复“重试写后同步”。`);
        } else {
          session.pendingPostWriteJobId = null;
          followupNotes.push('写后同步已完成：摘要、时间线、大纲、角色记忆和行文审查均已处理。');
        }
        if (Array.isArray(postWrite.warnings) && postWrite.warnings.length) {
          followupNotes.push(`写后警告：${postWrite.warnings.join('；')}`);
        }
        const totalAnnotations = Number(postWrite.deAiPayload?.totalAnnotations) || 0;
        if (totalAnnotations > 0) {
          storePendingDeAiChapterReview(session, postWrite.deAiPayload, '写入后自动审查 AI 味、套话、机械行文和章末模板感');
          followupNotes.push(`去 AI 味审查发现 ${totalAnnotations} 处可疑段落，已保留局部修改入口。`);
        }
      } catch (err) {
        session.pendingPostWriteJobId = postWriteJobReady ? draftId : null;
        followupNotes.push(`写后同步失败：${err?.message || String(err)}${postWriteJobReady ? '。可回复“重试写后同步”。' : ''}`);
      }
    } else if (postWriteJobReady) {
      await chapterPostWriteJobs.updateStep(draftId, 'chapterWrite', 'failed', { error: result.text }).catch(() => {});
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
      harnessTrace: pending.harnessTrace || null,
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

function isPostWriteRetryIntent(userText) {
  return /(?:重试|继续|恢复).{0,8}(?:写后同步|摘要同步|时间线同步|大纲回写|角色记忆更新)/u.test(safeStr(userText));
}

async function maybeHandlePostWriteRetry(session, userText, sessionId) {
  if (!isPostWriteRetryIntent(userText)) return null;
  const job = session.pendingPostWriteJobId
    ? await chapterPostWriteJobs.getJob(session.pendingPostWriteJobId)
    : await chapterPostWriteJobs.getLatestRetryableJob();
  if (!job) {
    return { text: '当前没有需要重试的写后同步任务。', turns: 1, toolCalls: [] };
  }
  const result = await chapterPostWriteCoordinator.runPostWriteJob({
    draftId: job.draftId,
    abortSignal: session.abortController?.signal || null,
    onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
  });
  const failedSteps = Object.entries(result.job?.steps || {})
    .filter(([, step]) => step?.status === 'failed')
    .map(([name]) => name);
  if (failedSteps.length) {
    session.pendingPostWriteJobId = job.draftId;
  } else {
    session.pendingPostWriteJobId = null;
  }
  const totalAnnotations = Number(result.deAiPayload?.totalAnnotations) || 0;
  if (totalAnnotations > 0) {
    storePendingDeAiChapterReview(session, result.deAiPayload, '写入后自动审查 AI 味、套话、机械行文和章末模板感');
  }
  return {
    text: failedSteps.length
      ? `写后同步已重试，但仍有失败步骤：${failedSteps.join('、')}。正文保持不变，可以稍后再次重试。`
      : '写后同步重试完成，所有待处理步骤均已结束。',
    turns: 1,
    toolCalls: result.toolCalls || [],
    harnessTrace: job.draft?.harnessTrace || null,
  };
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

function isRoleplayRiskKeepOutlineIntent(userText) {
  return /保大纲继续|沿用导演|按导演|继续角色驱动|继续按角色|保守成文|继续写/u.test(safeStr(userText));
}

function isRoleplayRiskSkipIntent(userText) {
  return /跳过角色驱动|不用角色驱动|普通写|命令驱动|回到普通/u.test(safeStr(userText));
}

function isRoleplayRiskOutlineSuggestionIntent(userText) {
  return /按角色方向|调整大纲建议|改大纲|顺角色|角色方向/u.test(safeStr(userText));
}

function isRoleplayRiskCancelIntent(userText) {
  return /取消本轮|取消写作|先不写|停止这次|取消生成/u.test(safeStr(userText));
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

async function rerunChapterDraftAfterRoleplayGate(session, sessionId, abortSignal, { ignoreProfileGate = false, roleplayEventSink = null } = {}) {
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
    onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
    onRoleplayEvent: (event) => emitRoleplayEvent(sessionId, event, roleplayEventSink),
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
      roleplayEvents: roleplayEventSink || [],
    };
  }
  if (draftResult.roleplayRiskBlocked) {
    session.pendingRoleplayRiskGate = {
      ...draftResult.roleplayRisk,
      roleplayPlan: draftResult.roleplayPlan || null,
      profileWarnings: draftResult.profileWarnings || [],
      originalUserText,
      originalIntent,
    };
    session.pendingRoleplayProfileProposal = null;
    emitEvent(sessionId, 'awaiting_roleplay_risk_decision', session.pendingRoleplayRiskGate || {});
    return {
      text: draftResult.assistantText || '角色驱动规划存在风险，等待你选择下一步。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
    };
  }
  if (draftResult.harnessBlocked) {
    return {
      text: draftResult.assistantText || '写作上下文存在冲突，本轮已暂停。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
      harnessTrace: draftResult.harnessTrace || null,
    };
  }
  if (draftResult.draftGenerationFailed) {
    clearPendingRoleplayProfile(session);
    clearPendingRoleplayRisk(session);
    emitEvent(sessionId, 'character_profile_gate_resolved', {});
    emitEvent(sessionId, 'roleplay_risk_resolved', {});
    return {
      text: draftResult.assistantText || '章节草稿没有生成成功，writer 没有返回可用正文。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
      harnessTrace: draftResult.harnessTrace || null,
    };
  }
  clearPendingRoleplayProfile(session);
  clearPendingRoleplayRisk(session);
  storePendingChapterDraftResult(session, draftResult);
  emitEvent(sessionId, 'character_profile_gate_resolved', {});
  emitEvent(sessionId, 'roleplay_risk_resolved', {});
  return {
    text: draftResult.assistantText || '已生成章节草稿，等待确认。',
    turns: 1,
    toolCalls: [],
    roleplayEvents: roleplayEventSink || [],
    harnessTrace: draftResult.harnessTrace || null,
  };
}

function formatRoleplayOutlineSuggestion(gate) {
  const riskyScenes = Array.isArray(gate?.riskyScenes) ? gate.riskyScenes : [];
  const lines = [
    '可以，先不写正文。我把“顺角色方向调整大纲”的建议整理成可讨论版本：',
    '',
  ];
  if (!riskyScenes.length) {
    lines.push('- 当前没有具体风险条目，只能建议重新梳理该章的 mustHappen / mustNotHappen。');
  } else {
    riskyScenes.slice(0, 6).forEach((scene, index) => {
      const title = scene.title || scene.sceneId || `场景 ${index + 1}`;
      const risks = Array.isArray(scene.remainingRisks) ? scene.remainingRisks : [];
      const notes = Array.isArray(scene.directorNotesForWriter) ? scene.directorNotesForWriter : [];
      lines.push(`${index + 1}. ${title}`);
      if (risks.length) {
        risks.slice(0, 3).forEach((risk) => {
          const note = typeof risk === 'string' ? risk : (risk?.note || risk?.type || '');
          if (note) lines.push(`   - 角色阻力：${note}`);
        });
      }
      if (notes.length) {
        notes.slice(0, 2).forEach((note) => lines.push(`   - 可保留：${safeStr(note)}`));
      }
      lines.push('   - 建议：把大纲结果保留为终点，但允许角色用沉默、回避、试探或延迟爆发来抵达；不要强行让角色立刻顺从。');
    });
  }
  lines.push('', '如果你认可这些方向，可以让我“按这个方向改大纲”，或者回复“保大纲继续”先生成草稿。');
  return lines.join('\n');
}

async function continueChapterDraftAfterRoleplayRisk(session, userText, sessionId, abortSignal, { mode, roleplayEventSink = null } = {}) {
  const gate = session.pendingRoleplayRiskGate || {};
  const originalUserText = gate.originalUserText || '继续生成章节草稿';
  const originalIntent = gate.originalIntent || detectChapterChatIntent(originalUserText, session);
  const roleplayOptions = mode === 'skip_roleplay'
    ? { disableRoleplay: true }
    : {
        prebuiltRoleplayPlan: gate.roleplayPlan || null,
        profileWarnings: Array.isArray(gate.profileWarnings) ? gate.profileWarnings : [],
        ignoreRiskGate: true,
      };
  const draftResult = await chapterDraftService.generateChapterDraft({
    mode: originalIntent.mode || 'new',
    userText: [
      originalUserText,
      mode === 'skip_roleplay'
        ? '用户选择：跳过角色驱动，使用普通写作链路继续。'
        : '用户选择：保大纲继续，沿用导演已筛选的角色驱动 beats 保守成文。',
      userText ? `本轮确认文本：${safeStr(userText)}` : '',
    ].filter(Boolean).join('\n'),
    pendingChapterDraft: session.pendingChapterDraft,
    editorContext: session.editorContext,
    abortSignal,
    roleplayOptions,
    onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
    onRoleplayEvent: (event) => emitRoleplayEvent(sessionId, event, roleplayEventSink),
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
      roleplayEvents: roleplayEventSink || [],
    };
  }
  if (draftResult.roleplayRiskBlocked) {
    session.pendingRoleplayRiskGate = {
      ...draftResult.roleplayRisk,
      roleplayPlan: draftResult.roleplayPlan || null,
      profileWarnings: draftResult.profileWarnings || [],
      originalUserText,
      originalIntent,
    };
    emitEvent(sessionId, 'awaiting_roleplay_risk_decision', session.pendingRoleplayRiskGate || {});
    return {
      text: draftResult.assistantText || '角色驱动规划存在风险，等待你选择下一步。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
    };
  }
  if (draftResult.harnessBlocked) {
    return {
      text: draftResult.assistantText || '写作上下文存在冲突，本轮已暂停。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
      harnessTrace: draftResult.harnessTrace || null,
    };
  }
  if (draftResult.draftGenerationFailed) {
    clearPendingRoleplayRisk(session);
    clearPendingRoleplayProfile(session);
    emitEvent(sessionId, 'roleplay_risk_resolved', {});
    emitEvent(sessionId, 'character_profile_gate_resolved', {});
    return {
      text: draftResult.assistantText || '章节草稿没有生成成功，writer 没有返回可用正文。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
      harnessTrace: draftResult.harnessTrace || null,
    };
  }
  clearPendingRoleplayRisk(session);
  clearPendingRoleplayProfile(session);
  emitEvent(sessionId, 'roleplay_risk_resolved', {});
  emitEvent(sessionId, 'character_profile_gate_resolved', {});
  storePendingChapterDraftResult(session, draftResult);
  return {
    text: draftResult.assistantText || '已生成章节草稿，等待确认。',
    turns: 1,
    toolCalls: [],
    roleplayEvents: roleplayEventSink || [],
    harnessTrace: draftResult.harnessTrace || null,
  };
}

async function maybeHandleRoleplayRiskPending(session, userText, sessionId, abortSignal, roleplayEventSink) {
  if (!session.pendingRoleplayRiskGate) return null;
  if (isRoleplayRiskCancelIntent(userText)) {
    clearPendingRoleplayRisk(session);
    emitEvent(sessionId, 'roleplay_risk_resolved', { cancelled: true });
    return { text: '已取消这次角色驱动写作，本轮没有生成或写入章节。', turns: 1, toolCalls: [], roleplayEvents: roleplayEventSink || [] };
  }
  if (isRoleplayRiskOutlineSuggestionIntent(userText)) {
    return { text: formatRoleplayOutlineSuggestion(session.pendingRoleplayRiskGate), turns: 1, toolCalls: [], roleplayEvents: roleplayEventSink || [] };
  }
  if (isRoleplayRiskSkipIntent(userText)) {
    return continueChapterDraftAfterRoleplayRisk(session, userText, sessionId, abortSignal, { mode: 'skip_roleplay', roleplayEventSink });
  }
  if (isRoleplayRiskKeepOutlineIntent(userText)) {
    return continueChapterDraftAfterRoleplayRisk(session, userText, sessionId, abortSignal, { mode: 'use_plan', roleplayEventSink });
  }
  return null;
}

async function maybeHandleRoleplayProfilePending(session, userText, sessionId, abortSignal, roleplayEventSink) {
  if (session.pendingRoleplayProfileProposal) {
    if (isRoleplayPatchConfirmIntent(userText)) {
      const applied = await chapterRoleplayService.applyProfileAutofill(session.pendingRoleplayProfileProposal);
      emitEvent(sessionId, 'character_profile_patch_resolved', { confirmed: true, applied });
      return rerunChapterDraftAfterRoleplayGate(session, sessionId, abortSignal, { ignoreProfileGate: false, roleplayEventSink });
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
    return rerunChapterDraftAfterRoleplayGate(session, sessionId, abortSignal, { ignoreProfileGate: true, roleplayEventSink });
  }

  return null;
}

async function maybeHandleChapterDraftAutomation(session, userText, sessionId, abortSignal, roleplayEventSink) {
  const activeNovelId = session.editorContext?.novelId || mcpClient.getActiveNovel();
  if (!activeNovelId) return null;

  const pendingRoleplayRisk = await maybeHandleRoleplayRiskPending(session, userText, sessionId, abortSignal, roleplayEventSink);
  if (pendingRoleplayRisk) return pendingRoleplayRisk;

  const pendingRoleplay = await maybeHandleRoleplayProfilePending(session, userText, sessionId, abortSignal, roleplayEventSink);
  if (pendingRoleplay) return pendingRoleplay;

  const pendingIssueDecision = maybeHandlePendingChapterIssueDecision(session, userText);
  if (pendingIssueDecision) return pendingIssueDecision;

  const pendingFixPreview = await maybeHandlePendingChapterFixPreview(session, userText, sessionId, abortSignal);
  if (pendingFixPreview) return pendingFixPreview;

  if (detectChapterConfirmIntent(userText, session)) {
    const issues = getPendingChapterIssues(session);
    if (hasBlockingReviewIssues(issues)) {
      return {
        text: formatPendingChapterOpenIssues(issues),
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
      summary: draft.summary || '',
      volumeIndex: draft.volumeIndex,
      sectionIndex: draft.sectionIndex,
      baseContent: draft.baseContent || '',
      insertAfter: draft.insertAfter || '',
      roleplayContext: draft.roleplayContext || null,
      draftId: draft.draftId || '',
      contextBundle: draft.contextBundle || null,
      sceneContracts: draft.sceneContracts || [],
      assertions: draft.assertions || [],
      harnessTrace: draft.harnessTrace || null,
      pendingStateDelta: draft.pendingStateDelta || {},
      stateVerifications: draft.stateVerifications || draft.harnessTrace?.stateVerifications || [],
      sourceUsage: draft.sourceUsage || draft.harnessTrace?.sourceUsage || [],
      verification: draft.verification || {
        status: hasBlockingReviewIssues(getPendingChapterIssues(session)) ? 'blocked' : 'passed',
        contentHash: chapterContentHash(draft.text || ''),
        checks: draft.constraintVerifications || draft.harnessTrace?.constraintVerifications || [],
      },
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
    onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
    onRoleplayEvent: (event) => emitRoleplayEvent(sessionId, event, roleplayEventSink),
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
      roleplayEvents: roleplayEventSink || [],
    };
  }
  if (draftResult.roleplayRiskBlocked) {
    session.pendingRoleplayRiskGate = {
      ...draftResult.roleplayRisk,
      roleplayPlan: draftResult.roleplayPlan || null,
      profileWarnings: draftResult.profileWarnings || [],
      originalUserText: userText,
      originalIntent: intent,
    };
    session.pendingRoleplayProfileProposal = null;
    emitEvent(sessionId, 'awaiting_roleplay_risk_decision', session.pendingRoleplayRiskGate || {});
    session.workflowPhase = 'writing';
    return {
      text: draftResult.assistantText || '角色驱动规划存在风险，等待你选择下一步。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
    };
  }
  if (draftResult.harnessBlocked) {
    return {
      text: draftResult.assistantText || '写作上下文存在冲突，本轮已暂停。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
      harnessTrace: draftResult.harnessTrace || null,
    };
  }
  if (draftResult.draftGenerationFailed) {
    clearPendingRoleplayProfile(session);
    clearPendingRoleplayRisk(session);
    emitEvent(sessionId, 'character_profile_gate_resolved', {});
    emitEvent(sessionId, 'roleplay_risk_resolved', {});
    return {
      text: draftResult.assistantText || '章节草稿没有生成成功，writer 没有返回可用正文。',
      turns: 1,
      toolCalls: [],
      roleplayEvents: roleplayEventSink || [],
      harnessTrace: draftResult.harnessTrace || null,
    };
  }
  clearPendingRoleplayProfile(session);
  clearPendingRoleplayRisk(session);
  storePendingChapterDraftResult(session, draftResult);
  emitEvent(sessionId, 'roleplay_risk_resolved', {});

  return {
    text: draftResult.assistantText || '已生成章节草稿，等待确认。',
    turns: 1,
    toolCalls: [],
    roleplayEvents: roleplayEventSink || [],
    harnessTrace: draftResult.harnessTrace || null,
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
  try { return parseJsonText(text); } catch { return null; }
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
  const text = normalizeChineseIntentText(userText);
  const selectedText = safeStr(session?.editorContext?.selectedText).trim();
  if (!text || !selectedText) return { shouldRoute: false };

  const looksLikeDeAiRequest = /去\s*a\s*i\s*味|去掉\s*a\s*i\s*味|润色去套话|去套话|去掉套话|去除套话|改得不那么像\s*a\s*i|改得更像人(?:写|说)|去掉八股|去掉机翻腔|去掉模型味/u.test(text);
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
  const text = normalizeChineseIntentText(userText);
  if (!text) return { shouldRoute: false };

  const looksLikeDeAiRequest = /去\s*a\s*i\s*味|去掉\s*a\s*i\s*味|润色去套话|去套话|去掉套话|去除套话|改得不那么像\s*a\s*i|改得更像人(?:写|说)|去掉八股|去掉机翻腔|去掉模型味/u.test(text);
  const mentionsDeAiProblems = /ai\s*味|套话|八股|机翻腔|模型味|像\s*ai|像模型写的/u.test(text);
  const looksLikeReview = /检查|审查|看看|有地方|哪里|问题|找出|盘一下|过一遍|ai味|套话|八股|机翻腔|模型味|机械|僵硬|不自然/u.test(text);
  const explicitlyRejectsRewrite = /(?:不要|别|先不要).{0,8}(?:直接改|直接处理|统一改掉|替换|重写|改写)/u.test(text);
  const looksLikeRewrite = /直接改|直接处理|统一改掉|替换|重写|改写|润色这一段|润色这句/u.test(text) && !explicitlyRejectsRewrite;
  const mentionsChapters = /章|chapter-/iu.test(text);

  if ((!looksLikeDeAiRequest && !mentionsDeAiProblems) || !looksLikeReview || looksLikeRewrite || !mentionsChapters) {
    return { shouldRoute: false };
  }

  return {
    shouldRoute: true,
    focus: text,
    sensitivity: /保守|少误报|严格命中/u.test(text)
      ? 'conservative'
      : /激进|高灵敏|更灵敏|尽量找全|宁可多报/u.test(text)
        ? 'aggressive'
        : 'balanced',
    fallbackChapterName: detectOpenChapterName(session?.editorContext),
  };
}

function detectChapterFactCheckIntent(userText, session) {
  const text = normalizeChineseIntentText(userText);
  if (!text) return { shouldRoute: false };
  if (/ai\s*味|套话|八股|机翻腔|模型味|像\s*ai|像模型写的/u.test(text)) {
    return { shouldRoute: false };
  }
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

function buildNearbyDeAiReferenceSamples(paragraphs, excludedIndexes = [], focusIndexes = [], maxSamples = 4) {
  const excluded = new Set((Array.isArray(excludedIndexes) ? excludedIndexes : []).filter(Number.isInteger));
  const focus = (Array.isArray(focusIndexes) ? focusIndexes : []).filter(Number.isInteger);
  return (Array.isArray(paragraphs) ? paragraphs : [])
    .filter((paragraph) => Number.isInteger(paragraph?.index)
      && !excluded.has(paragraph.index)
      && safeStr(paragraph.text).trim().length >= 12
      && !/^#{1,6}\s/u.test(safeStr(paragraph.text).trim()))
    .map((paragraph) => ({
      text: safeStr(paragraph.text).trim(),
      index: paragraph.index,
      distance: focus.length ? Math.min(...focus.map((index) => Math.abs(index - paragraph.index))) : paragraph.index,
    }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .slice(0, maxSamples)
    .map((item) => item.text);
}

function buildEditorDeAiReferenceSamples(editorContext, maxSamples = 4) {
  const content = safeStr(editorContext?.content);
  const start = Number.isFinite(Number(editorContext?.selectionStart)) ? Number(editorContext.selectionStart) : -1;
  const end = Number.isFinite(Number(editorContext?.selectionEnd)) ? Number(editorContext.selectionEnd) : start;
  if (!content || start < 0 || end < start) return [];
  const before = splitIntoParagraphs(content.slice(0, start)).map((paragraph) => paragraph.text).filter(Boolean).slice(-2);
  const after = splitIntoParagraphs(content.slice(end)).map((paragraph) => paragraph.text).filter(Boolean).slice(0, 2);
  return [...before, ...after]
    .map((item) => safeStr(item).trim())
    .filter((item, index, list) => item.length >= 12 && !/^#{1,6}\s/u.test(item) && list.indexOf(item) === index)
    .slice(0, maxSamples);
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(list[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function groupAdjacentParagraphIndexes(indexes) {
  const groups = [];
  for (const index of Array.isArray(indexes) ? indexes : []) {
    const current = groups[groups.length - 1];
    if (!current || index > current[current.length - 1] + 1) groups.push([index]);
    else current.push(index);
  }
  return groups;
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

function isParagraphFunctionAnnotation(annotation) {
  const note = safeStr(annotation?.note);
  const suggestedAction = safeStr(annotation?.suggestedAction);
  return /段落功能审查|机械的一句一段|单句段|一句一段|自然段/u.test(note)
    || suggestedAction === 'merge_paragraphs';
}

function getParagraphFunctionRiskChapters(reviewPayload) {
  const chapters = Array.isArray(reviewPayload?.chapters) ? reviewPayload.chapters : [];
  return chapters
    .filter((chapter) => !chapter?.error)
    .map((chapter) => ({
      chapterName: chapter.chapterName,
      annotations: (Array.isArray(chapter.annotations) ? chapter.annotations : []).filter(isParagraphFunctionAnnotation),
    }))
    .filter((chapter) => chapter.chapterName && chapter.annotations.length > 0);
}

function formatParagraphFunctionReviewReply(reviewPayload) {
  const chapters = Array.isArray(reviewPayload?.chapters) ? reviewPayload.chapters : [];
  const successful = chapters.filter((chapter) => !chapter?.error);
  const failed = chapters.filter((chapter) => chapter?.error);
  const totalAnnotations = Number(reviewPayload?.totalAnnotations) || 0;

  const lines = [];
  if (!successful.length && failed.length) {
    return `段落功能审查失败：${failed[0].error || '未返回可用结果'}`;
  }

  if (totalAnnotations <= 0) {
    lines.push('段落功能复核完成：没有发现明确需要合并的一句一段问题。');
  } else {
    lines.push(`段落功能复核完成：发现 ${totalAnnotations} 组需要关注的一句一段/自然段组织问题：`);
    lines.push('');
    for (const chapter of successful) {
      const annotations = Array.isArray(chapter.annotations) ? chapter.annotations : [];
      if (!annotations.length) continue;
      lines.push(`- ${chapter.chapterName}：${annotations.length} 组`);
      for (const annotation of annotations.slice(0, 3)) {
        const paragraphIndexes = Array.isArray(annotation?.paragraphIndexes) && annotation.paragraphIndexes.length
          ? annotation.paragraphIndexes.map((index) => `第${index + 1}段`).join(' / ')
          : `第${(annotation?.paragraphIndex || 0) + 1}段`;
        const severity = annotation.severity ? ` [${annotation.severity}]` : '';
        lines.push(`  ${paragraphIndexes}${severity}：${annotation.note || '相邻单句段可能应合并为自然段'}`);
      }
    }
  }

  if (failed.length) {
    lines.push('');
    lines.push(`以下章节段落功能审查失败：${failed.map((chapter) => `${chapter.chapterName}（${chapter.error}）`).join('；')}`);
  }

  lines.push('');
  lines.push('这一步只复核段落功能，不自动合并正文；如果你确认，我再按组生成 apply_chapter_patch。');
  return lines.join('\n');
}

async function runParagraphFunctionReviewForPending(chapterNames, focus, toolCalls) {
  const requested = Array.isArray(chapterNames) ? chapterNames.filter(Boolean) : [];
  if (!requested.length) return null;
  const reviewResult = await callMcpTool('review_paragraph_function', {
    chapterNames: requested,
    focus: [
      safeStr(focus).trim(),
      '这是 AI 味段落处理后的第二轮审查：请专门复核一句一段/段落功能问题，不要泛泛重复普通 AI 味审查。',
    ].filter(Boolean).join('\n'),
  });
  toolCalls.push({
    id: `review-paragraph-function-${Date.now().toString(36)}`,
    name: 'review_paragraph_function',
    input: { chapterNames: requested, focus },
    status: 'done',
    result: reviewResult.text,
    isError: reviewResult.isError,
  });
  if (reviewResult.isError) {
    return { text: `段落功能审查失败：${reviewResult.text}`, payload: null };
  }
  const payload = parseTextJson(reviewResult.text) || {};
  return { text: formatParagraphFunctionReviewReply(payload), payload };
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
  const targetGroups = groupAdjacentParagraphIndexes(targetIndexes);
  const edits = [];

  const settled = await mapWithConcurrency(targetGroups, 3, async (group) => {
    const firstIndex = group[0];
    const lastIndex = group[group.length - 1];
    const targetParagraphs = group
      .map((paragraphIndex) => paragraphs.find((item) => item.index === paragraphIndex))
      .filter((paragraph) => paragraph?.text);
    if (!targetParagraphs.length) return null;
    const targetText = targetParagraphs.map((paragraph) => paragraph.text).join('\n\n');
    const beforeContext = paragraphs.find((item) => item.index === firstIndex - 1)?.text || '';
    const afterContext = paragraphs.find((item) => item.index === lastIndex + 1)?.text || '';
    const relatedAnnotations = (Array.isArray(annotations) ? annotations : []).filter((annotation) => {
      const indexes = Array.isArray(annotation?.paragraphIndexes) && annotation.paragraphIndexes.length
        ? annotation.paragraphIndexes
        : [annotation?.paragraphIndex];
      return indexes.some((index) => group.includes(index));
    });
    const guidance = [
      safeStr(focus).trim(),
      group.length > 1
        ? '这些相邻段落属于同一问题窗口，但仍须保持原有分段、短句、停顿和留白；分别修掉命中的套话即可。只输出目标窗口，不要复制前后文。'
        : '只处理审查命中的问题句，保留目标段内其余正常措辞、粗粝感、短句、停顿和留白。不要扩写，不要新增动作、对白、景物、感官、心理、比喻或情绪解释。',
    ].filter(Boolean).join('\n\n');
    const args = {
      text: targetText,
      guidance,
      beforeContext,
      afterContext,
      chapterName,
      targetParagraphIndexes: group,
      problemEvidence: relatedAnnotations.map((annotation) => annotation.evidence || annotation.excerpt).filter(Boolean),
      preserveConstraints: [
        '不得新增或删除剧情事实',
        '保持人物称呼、叙事视角、时态和否定含义',
        '不得凭空增加动作、对白、景物、感官、心理、比喻或情绪解释',
        '只修改审查命中的问题句，其他句子保持原样',
      ],
    };
    const rewriteResult = await callMcpTool('de_ai_ify', args);
    const toolCall = {
      id: `de-ai-ify-${chapterName}-${firstIndex}-${lastIndex}`,
      name: 'de_ai_ify',
      input: args,
      status: 'done',
      result: rewriteResult.text,
      isError: rewriteResult.isError,
    };
    if (rewriteResult.isError) {
      throw Object.assign(new Error(rewriteResult.text || `de_ai_ify failed for ${chapterName} 第${firstIndex + 1}段`), { toolCall });
    }
    const rewritePayload = parseTextJson(rewriteResult.text);
    const replacement = safeStr(rewritePayload?.revisedText || rewriteResult.text).trim();
    return {
      toolCall,
      edit: !replacement || replacement === targetText.trim()
        ? null
        : {
          targetText,
          replacement,
          beforeContext: compactPatchContext(beforeContext),
          afterContext: compactPatchContext(afterContext),
        },
    };
  });

  const failures = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value?.toolCall) toolCalls.push(result.value.toolCall);
      if (result.value?.edit) edits.push(result.value.edit);
    } else {
      if (result.reason?.toolCall) toolCalls.push(result.reason.toolCall);
      failures.push(result.reason?.message || String(result.reason));
    }
  }
  if (!edits.length && failures.length) throw new Error(failures[0]);

  return { baseContent, edits, failures };
}

function formatDeAiPatchPreviewReply(preview) {
  const patches = Array.isArray(preview?.patches) ? preview.patches : [];
  const failed = Array.isArray(preview?.failed) ? preview.failed : [];
  const lines = ['已生成去 AI 味 patch 预览，尚未写入正文。'];
  if (patches.length) {
    const totalEdits = patches.reduce((sum, patch) => sum + (Array.isArray(patch.edits) ? patch.edits.length : 0), 0);
    lines.push('', `可应用章节：${patches.length} 章，共 ${totalEdits} 处段落级修改。`);
    for (const patch of patches) {
      lines.push(`- ${patch.chapterName}：${patch.edits.length} 处`);
      for (const edit of patch.edits.slice(0, 2)) {
        lines.push(`  原文：${compactPatchContext(edit.targetText, 140)}`);
        lines.push(`  新文：${compactPatchContext(edit.replacement, 140)}`);
      }
      if (patch.edits.length > 2) lines.push(`  另有 ${patch.edits.length - 2} 处未展开。`);
      if (Array.isArray(patch.warnings) && patch.warnings.length) {
        lines.push(`  ${patch.warnings.length} 个改写窗口失败，可单独重试；其余预览仍可审阅。`);
      }
    }
  } else {
    lines.push('', '没有生成可应用的普通去 AI 味段落修改。');
  }
  if (failed.length) {
    lines.push('', `以下章节生成预览失败：${failed.map((item) => `${item.chapterName}（${item.error}）`).join('；')}`);
  }
  if (Array.isArray(preview?.paragraphFunctionChapterNames) && preview.paragraphFunctionChapterNames.length) {
    lines.push('', '另有段落功能风险会在普通去 AI 味 patch 应用后再跑专门复审，不会在这次预览里直接当套话改掉。');
  }
  lines.push('', '确认使用这版 patch 请回复“确认应用”；如果目标章节已被你改过，应用时会因 baseContent 快照冲突而停止，不会覆盖新内容。');
  return lines.join('\n');
}

async function applyDeAiPatchPreview(session, toolCalls) {
  const preview = session.pendingDeAiChapterPatchPreview;
  if (!preview) return null;
  const applied = [];
  const failed = [];
  for (const patch of Array.isArray(preview.patches) ? preview.patches : []) {
    if (!patch?.chapterName || !Array.isArray(patch.edits) || !patch.edits.length) continue;
    const mutationArgs = {
      name: patch.chapterName,
      baseContent: patch.baseContent,
      edits: patch.edits,
    };
    const dryRun = await callMcpTool('apply_chapter_patch', { ...mutationArgs, previewOnly: true });
    const dryPayload = parseTextJson(dryRun.text) || {};
    const afterContent = safeStr(dryPayload.afterContent || dryPayload.changedFiles?.[0]?.afterContent || '');
    let applyResult = dryRun;
    if (!dryRun.isError && afterContent) {
      const strictVerification = await chapterDraftService.verifyChapterContentStrict({
        name: patch.chapterName,
        displayName: patch.chapterName,
        text: afterContent,
        userText: preview.focus || '去 AI 味局部修改',
        editorContext: session.editorContext,
        abortSignal: session.abortController?.signal || null,
      });
      session.activeExecutionTrace?.setVerification({ status: strictVerification.status, checks: strictVerification.checks || [] });
      if (strictVerification.status === 'passed') {
        applyResult = await callMcpTool('apply_chapter_patch', {
          ...mutationArgs,
          verifiedContentHash: strictVerification.contentHash,
        });
      } else {
        applyResult = {
          isError: true,
          text: `strict verification blocked: ${(strictVerification.issues || []).map((issue) => issue.summary).filter(Boolean).join('；')}`,
        };
      }
    }
    toolCalls.push({
      id: `apply-chapter-patch-${patch.chapterName}-${toolCalls.length + 1}`,
      name: 'apply_chapter_patch',
      input: { name: patch.chapterName, edits: patch.edits },
      status: 'done',
      result: applyResult.text,
      isError: applyResult.isError,
    });
    if (applyResult.isError) {
      failed.push({
        chapterName: patch.chapterName,
        error: applyResult.text || 'apply_chapter_patch failed',
        snapshotMismatch: /snapshot mismatch/i.test(applyResult.text || ''),
      });
      continue;
    }
    const payload = parseTextJson(applyResult.text) || { editCount: patch.edits.length, replacedCount: patch.edits.length };
    applied.push({
      chapterName: patch.chapterName,
      editCount: Number(payload.replacedCount ?? payload.editCount) || 0,
    });
  }

  const paragraphReview = preview.paragraphFunctionChapterNames?.length && applied.length
    ? await runParagraphFunctionReviewForPending(preview.paragraphFunctionChapterNames, preview.focus, toolCalls)
    : null;

  return { applied, failed, paragraphReview };
}

async function maybeHandlePendingDeAiChapterApply(session, userText) {
  const pending = session.pendingDeAiChapterReview;
  if (!pending && !session.pendingDeAiChapterPatchPreview) return null;

  const intent = detectPendingDeAiChapterApplyIntent(userText, session);
  if (intent.action === 'cancel') {
    clearPendingDeAiChapterReview(session);
    return {
      text: '已取消这次去 AI 味修改流程，正文没有变化。',
      turns: 1,
      toolCalls: [],
    };
  }
  if (intent.action !== 'apply') return null;

  if (session.pendingDeAiChapterPatchPreview) {
    const toolCalls = [];
    const result = await applyDeAiPatchPreview(session, toolCalls);
    const lines = [];
    if (result?.applied?.length) {
      const totalEdits = result.applied.reduce((sum, item) => sum + (item.editCount || 0), 0);
      lines.push(`已按预览应用去 AI 味修改，共处理 ${result.applied.length} 章，落盘 ${totalEdits} 处：`);
      lines.push('');
      for (const item of result.applied) lines.push(`- ${item.chapterName}：${item.editCount} 处`);
    }
    if (result?.failed?.length) {
      if (lines.length) lines.push('');
      lines.push(`以下章节未应用成功：${result.failed.map((item) => `${item.chapterName}（${item.snapshotMismatch ? '章节已变化，请重新生成预览' : item.error}）`).join('；')}`);
    }
    if (!lines.length) lines.push('这次没有应用任何去 AI 味修改。');
    if (result?.paragraphReview) {
      lines.push('');
      lines.push('普通 AI 味段落处理完毕后，我已调用段落功能审查 subagent 复核一句一段问题：');
      lines.push('');
      lines.push(result.paragraphReview.text);
    }
    if (result?.failed?.some((item) => item.snapshotMismatch)) {
      session.pendingDeAiChapterPatchPreview = null;
      return {
        text: `${lines.join('\n')}\n\n我已丢弃这版旧快照预览；如需继续，请重新回复“方案A”生成基于最新正文的新预览。`,
        turns: 1,
        toolCalls,
      };
    }
    clearPendingDeAiChapterReview(session);
    return { text: lines.join('\n'), turns: 1, toolCalls };
  }

  const allReviewedChapters = (Array.isArray(pending.reviewPayload?.chapters) ? pending.reviewPayload.chapters : [])
    .filter((chapter) => !chapter?.error)
    .filter((chapter) => Array.isArray(chapter?.annotations) && chapter.annotations.length > 0);
  const paragraphFunctionRiskChapters = getParagraphFunctionRiskChapters(pending.reviewPayload);
  const paragraphFunctionChapterNames = paragraphFunctionRiskChapters.map((chapter) => chapter.chapterName);
  const chapters = allReviewedChapters
    .map((chapter) => ({
      ...chapter,
      annotations: (Array.isArray(chapter.annotations) ? chapter.annotations : []).filter((annotation) => !isParagraphFunctionAnnotation(annotation)),
    }))
    .filter((chapter) => Array.isArray(chapter.annotations) && chapter.annotations.length > 0);
  if (!chapters.length) {
    const toolCalls = [];
    const paragraphReview = paragraphFunctionChapterNames.length
      ? await runParagraphFunctionReviewForPending(paragraphFunctionChapterNames, pending.focus, toolCalls)
      : null;
    clearPendingDeAiChapterReview(session);
    return {
      text: paragraphReview
        ? [
          '上一次去 AI 味审查里没有普通套话段落需要直接改写；我已转入第二轮段落功能审查。',
          '',
          paragraphReview.text,
        ].join('\n')
        : '上一次去 AI 味审查里没有可直接应用的段落，所以这次没有改动正文。',
      turns: 1,
      toolCalls,
    };
  }

  const applied = [];
  const failed = [];
  const toolCalls = [];

  for (const chapter of chapters) {
    try {
      const patch = await buildDeAiPatchForChapter(chapter.chapterName, chapter.annotations, pending.focus, toolCalls);
      if (patch.edits.length) {
        applied.push({
          chapterName: chapter.chapterName,
          baseContent: patch.baseContent,
          edits: patch.edits,
          warnings: patch.failures || [],
        });
      }
    } catch (err) {
      failed.push({ chapterName: chapter.chapterName, error: err?.message || String(err) });
    }
  }

  session.pendingDeAiChapterPatchPreview = {
    patches: applied,
    failed,
    paragraphFunctionChapterNames,
    focus: pending.focus,
    createdAt: Date.now(),
  };

  return {
    text: formatDeAiPatchPreviewReply(session.pendingDeAiChapterPatchPreview),
    turns: 1,
    toolCalls,
  };
}

function formatDeAiChapterReviewReply(reviewPayload) {
  const chapters = Array.isArray(reviewPayload?.chapters) ? reviewPayload.chapters : [];
  const successful = chapters.filter((chapter) => !chapter?.error);
  const failed = chapters.filter((chapter) => chapter?.error);
  const totalAnnotations = Number(reviewPayload?.totalAnnotations) || 0;
  const paragraphFunctionRisks = getParagraphFunctionRiskChapters(reviewPayload);
  const paragraphFunctionRiskCount = paragraphFunctionRisks.reduce((sum, chapter) => sum + chapter.annotations.length, 0);

  if (!successful.length && failed.length) {
    return `去 AI 味审查失败：${failed[0].error || '未返回可用结果'}`;
  }

  const lines = [];
  const sensitivityLabel = ({ conservative: '保守', balanced: '均衡', aggressive: '高灵敏' })[reviewPayload?.sensitivity] || '均衡';
  const shardLabel = Number(reviewPayload?.shardCount) > 0 ? `，${Number(reviewPayload.shardCount)} 个重叠分片` : '';
  const label = successful.length > 1 ? `${successful.length} 章` : safeStr(successful[0]?.chapterName) || '当前章节';
  if (totalAnnotations <= 0) {
    lines.push(`我已按${sensitivityLabel}灵敏度并行审查 ${label}${shardLabel}，目前没有发现明确需要处理的 AI 味或套话段落。`);
  } else {
    lines.push(`我已按${sensitivityLabel}灵敏度并行审查 ${label}${shardLabel}，共发现 ${totalAnnotations} 处可疑段落：`);
    lines.push('');
    for (const chapter of successful) {
      const annotations = Array.isArray(chapter?.annotations) ? chapter.annotations : [];
      lines.push(`- ${chapter.chapterName}：${annotations.length} 处`);
      for (const annotation of annotations.slice(0, 3)) {
        const paragraphIndexes = Array.isArray(annotation?.paragraphIndexes) && annotation.paragraphIndexes.length
          ? annotation.paragraphIndexes.map((index) => `第${index + 1}段`).join(' / ')
          : `第${(annotation?.paragraphIndex || 0) + 1}段`;
        const confidence = Number.isFinite(Number(annotation?.confidence))
          ? `，置信度 ${Math.round(Number(annotation.confidence) * 100)}%`
          : '';
        const severity = annotation?.severity ? ` [${annotation.severity}${confidence}]` : (confidence ? ` [${confidence.slice(1)}]` : '');
        lines.push(`  ${paragraphIndexes}${severity}：${annotation.note || '发现 AI 味/套话问题'}`);
        if (annotation.evidence || annotation.excerpt) lines.push(`    命中：${compactPatchContext(annotation.evidence || annotation.excerpt, 160)}`);
      }
    }
  }

  const failedShardCount = Number(reviewPayload?.failedShardCount) || 0;
  if (failedShardCount > 0) {
    lines.push('', `有 ${failedShardCount} 个审查分片未完成，现有结果已保留；失败分片可重试，不能据此宣称全章无问题。`);
  }

  if (failed.length) {
    lines.push('');
    lines.push(`以下章节审查失败：${failed.map((chapter) => `${chapter.chapterName}（${chapter.error}）`).join('；')}`);
  }

  if (paragraphFunctionRiskCount > 0) {
    lines.push('');
    lines.push(`另外，精简审查清单注意到 ${paragraphFunctionRiskCount} 处可能的“一句话一段/段落功能”风险。我会先把普通 AI 味段落处理完；如果你确认继续修，再自动调用段落功能审查 subagent 逐段复核这些单句段，不会把它们直接当普通套话改掉。`);
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
    sensitivity: intent.sensitivity,
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
  if (!session.threadId || (!result?.text
    && !(Array.isArray(result?.toolCalls) && result.toolCalls.length > 0)
    && !result?.executionTrace)) {
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
      roleplayEvents: Array.isArray(result.roleplayEvents) && result.roleplayEvents.length > 0 ? result.roleplayEvents : undefined,
      harnessTrace: result.harnessTrace || undefined,
      executionTrace: result.executionTrace || undefined,
    });
  } catch {
    // best-effort
  }
}

async function maybeHandleOutlineAutomation(session, userText, sessionId, abortSignal, roleplayEventSink) {
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
    let nextChapter = await maybeHandleChapterDraftAutomation(session, userText, sessionId, abortSignal, roleplayEventSink);
    if (!nextChapter) {
      emitProgressEvent(sessionId, '自动续跑：大纲已确认，开始按大纲生成下一章草稿。', { stage: 'auto_continue_after_outline' });
      nextChapter = await maybeHandleChapterDraftAutomation(session, '继续写下一章，先生成草稿并等待我确认写入。', sessionId, abortSignal, roleplayEventSink);
    }
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

async function maybeHandleDeAiAutomation(session, sessionId, userText, abortSignal) {
  const intent = detectDeAiChatIntent(userText, session);
  if (!intent.shouldRoute) return null;

  const rewriteArgs = {
    text: intent.sourceText,
    guidance: intent.guidance,
    chapterName: detectOpenChapterName(session?.editorContext),
    referenceSamples: buildEditorDeAiReferenceSamples(session?.editorContext),
    preserveConstraints: [
      '只修改用户选中的目标文本',
      '不得新增动作、对白、景物、感官、心理、比喻或情绪解释',
      '保留原有短句、停顿、留白、粗粝感和不规则节奏',
    ],
  };
  const rewriteResult = await callMcpTool('de_ai_ify', rewriteArgs);
  if (rewriteResult.isError) {
    return {
      text: `去 AI 味改写失败：${rewriteResult.text}`,
      turns: 1,
      toolCalls: [
        {
          id: 'de-ai-ify-auto',
          name: 'de_ai_ify',
          input: rewriteArgs,
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

  const preview = buildFrontendChapterMutationPreview(session, {
    name: 'replace_selected_text',
    input: { replacement },
  });
  const strictVerification = await chapterDraftService.verifyChapterContentStrict({
    name: preview.name,
    displayName: preview.displayName,
    text: preview.afterContent,
    userText,
    editorContext: session.editorContext,
    abortSignal,
    onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
  });
  storePendingChapterIssues(session, strictVerification.issues || []);
  session.activeExecutionTrace?.setVerification({ status: strictVerification.status, checks: strictVerification.checks || [] });
  session.pendingWriteChapter = {
    kind: 'chapter_mutation',
    mutationTool: 'replace_selected_text',
    mutationExecution: 'frontend',
    mutationArgs: preview.mutationArgs,
    name: preview.name,
    title: preview.displayName || preview.name,
    content: preview.afterContent,
    baseContent: preview.beforeContent,
    verification: {
      status: strictVerification.status,
      contentHash: strictVerification.contentHash,
      checks: strictVerification.checks || [],
    },
    toolUseId: 'de-ai-selection-preview',
  };
  emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
    kind: 'chapter_mutation',
    mutationTool: 'replace_selected_text',
    name: preview.name,
    title: preview.displayName,
    contentPreview: replacement.slice(0, 500),
    contentLength: replacement.length,
    verificationStatus: strictVerification.status,
    blockingIssues: (strictVerification.issues || []).filter((issue) => issue.severity === 'blocking').map((issue) => issue.summary).slice(0, 8),
  });

  return {
    text: strictVerification.status === 'passed'
      ? [
        '已生成选区去 AI 味改写预览并通过严格验证，编辑器尚未修改。',
        '',
        `原文：${compactPatchContext(intent.sourceText, 180)}`,
        `新文：${compactPatchContext(replacement, 180)}`,
        '',
        '确认采用请回复“确认写入”；不采用请回复“取消写入”。',
      ].join('\n')
      : '已生成选区去 AI 味改写预览，但严格验证未通过，因此不会写入。你可以查看阻塞问题后重新生成。',
    turns: 1,
    toolCalls: [
      {
          id: 'de-ai-ify-auto',
          name: 'de_ai_ify',
          input: rewriteArgs,
        status: 'done',
        result: rewriteResult.text,
        isError: false,
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

function buildFrontendChapterMutationPreview(session, toolUse) {
  const context = session?.editorContext || {};
  const current = safeStr(context.content || '');
  if (!current) throw new Error('当前编辑器没有可供预览的章节正文');
  const input = toolUse?.input || {};
  const name = toolUse?.name || '';
  let start = Number.isFinite(Number(context.selectionStart)) ? Number(context.selectionStart) : -1;
  let end = Number.isFinite(Number(context.selectionEnd)) ? Number(context.selectionEnd) : start;
  let replacement = '';
  if (name === 'replace_selected_text') {
    replacement = safeStr(input.replacement);
    const selectedText = safeStr(context.selectedText);
    if (!selectedText || start < 0 || end <= start || current.slice(start, end) !== selectedText) {
      const selected = selectedText;
      const first = selected ? current.indexOf(selected) : -1;
      const second = first >= 0 ? current.indexOf(selected, first + selected.length) : -1;
      if (first < 0 || second >= 0) throw new Error('当前选区已变化或无法唯一定位，请重新选择后再试');
      start = first;
      end = first + selected.length;
    }
  } else if (name === 'replace_text_near_cursor') {
    const targetText = safeStr(input.targetText);
    replacement = safeStr(input.replacement);
    const resolved = resolveAnchoredTextMatches(current, targetText, { expectedMatchCount: 1 });
    if (!resolved.matches.length) throw new Error('光标附近没有找到要替换的文本');
    const cursor = start >= 0 ? start : 0;
    const distanceToRange = (range) => {
      if (cursor >= range.start && cursor <= range.end) return 0;
      return Math.min(Math.abs(cursor - range.start), Math.abs(cursor - range.end));
    };
    const ranked = resolved.matches
      .map((range) => ({ ...range, distance: distanceToRange(range) }))
      .sort((left, right) => left.distance - right.distance || left.start - right.start);
    const match = ranked[0];
    if (ranked[1] && ranked[1].distance === match.distance) {
      throw new Error('当前光标附近仍有多个等距命中，请再把光标放近一点，或直接手动选中文本');
    }
    start = match.start;
    end = match.end;
  } else if (name === 'insert_text_at_cursor') {
    replacement = safeStr(input.text);
    start = end >= 0 ? end : current.length;
    end = start;
  } else {
    throw new Error(`Unsupported frontend chapter mutation preview: ${name}`);
  }
  if (start < 0 || end < start || end > current.length) throw new Error('编辑器选区范围无效，无法生成安全预览');
  return {
    name: safeStr(context.chapterFileName || context.title || ''),
    displayName: safeStr(context.chapterDisplayName || context.title || ''),
    beforeContent: current,
    afterContent: `${current.slice(0, start)}${replacement}${current.slice(end)}`,
    mutationArgs: {
      ...input,
      expectedStart: start,
      expectedEnd: end,
      expectedText: current.slice(start, end),
    },
  };
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
  const { input: subagentInput } = input || {};
  const rawSubagentId = safeStr(input?.subagentId).trim();
  const subagentId = SPAWN_SUBAGENT_ALIASES[rawSubagentId] || rawSubagentId;
  if (!subagentId) throw new Error('spawn_subagent: subagentId required');

  // Route through workflowOrchestrator so the active driver (claude-code or direct-api) is used.
  let result;
  try {
    result = await workflowOrchestrator.runWorkflow({
      mode: 'subagent',
      subagentId,
      input: subagentInput || '',
      novelContext: getActiveNovelContext(mcpClient),
    });
  } catch (err) {
    const message = err?.message || String(err);
    if (/subagent not found/i.test(message)) {
      throw new Error(`subagent not found: ${rawSubagentId || subagentId}. For chapter drafting use subagentId "sa-writer"; known alias "writer" is accepted by this runtime.`);
    }
    throw err;
  }
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
  const tierCandidates = await resolveDirectCandidates({ systemTask: 'chat', legacyTier: 'opus' });
  if (!tierCandidates.length) throw new Error('主聊天没有配置可用模型档案');
  let tierCandidateIndex = 0;
  let tier = tierCandidates[0].tier;
  emitEvent(sessionId, 'model_selected', { provenance: tier.provenance });

  let tools;
  const policy = classifyChatToolPolicy(userText, session);
  let toolPolicySummary = null;
  let activeNovelId = session.editorContext?.novelId || '';
  try { activeNovelId = activeNovelId || mcpClient.getActiveNovel(); } catch { /* active novel is best-effort */ }
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
      if (!activeNovelId) {
        const allowed = ['read_skill', 'list_skills', 'read_skill_content', 'de_ai_ify', 'create_novel', 'list_novels', 'get_system_time'];
        const filtered = mcpTools.filter((t) => allowed.includes(t.name));
        tools = [...filtered, ...DIRECT_API_CHAT_TOOLS];
      } else {
        tools = [...mcpTools, ...DIRECT_API_CHAT_TOOLS];
      }
      const policyResult = applyToolPolicy(tools, policy);
      tools = policyResult.tools;
      toolPolicySummary = policyResult.summary;
      break; // success
    } catch (err) {
      if (retry === 0) {
        console.warn('[chatAgent] mcp.listTools failed, retrying...', err.message);
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.error('[chatAgent] mcp.listTools failed after retry', err);
        tools = [...DIRECT_API_CHAT_TOOLS];
        const policyResult = applyToolPolicy(tools, policy);
        tools = policyResult.tools;
        toolPolicySummary = policyResult.summary;
      }
    }
  }

  const maxTurns = 12; // single user-query tool-use loop limit
  let turnIdx = 0;
  let lastText = '';
  const toolCalls = [];
  let toolResultTrimmedCount = 0;
  const toolResultCache = createToolResultCache();
  let systemForProvider = system;
  const manifestState = {
    included: [],
    trimmed: [],
    omitted: [],
    cached: [],
  };
  const preparedChatContext = await prepareChatTurnContext({
    session,
    userText,
    chatToolPolicy: toolPolicySummary || policy,
    activeNovelId,
  });
  if (preparedChatContext.systemBlock) systemForProvider = `${systemForProvider}\n\n---\n${preparedChatContext.systemBlock}`;
  manifestState.included.push(...preparedChatContext.manifest.included);
  manifestState.trimmed.push(...preparedChatContext.manifest.trimmed);
  manifestState.omitted.push(...preparedChatContext.manifest.omitted);

  while (turnIdx < maxTurns) {
    if (abortSignal.aborted) throw new DOMException('aborted', 'AbortError');

    const assembledContext = assembleProviderContext({
      system: systemForProvider,
      messages: session.messages,
      tools,
      runtime: { kind: 'chatAgent', sessionId, turnIdx },
      manifest: manifestState,
      toolPolicy: toolPolicySummary,
      modelLimits: {
        contextWindow: Math.min(...tierCandidates.slice(tierCandidateIndex).map((item) => Number(item.tier.contextWindow) || 128000)),
        maxOutputTokens: Math.max(...tierCandidates.slice(tierCandidateIndex).map((item) => Number(item.tier.extra?.maxTokens) || 4096)),
      },
    });
    assembledContext.stats.toolResultsTrimmedSoFar = toolResultTrimmedCount;
    assembledContext.manifest.stats = { ...assembledContext.stats };
    emitEvent(sessionId, 'context_stats', { turnIdx, ...assembledContext.stats });
    emitEvent(sessionId, 'context_manifest', assembledContext.manifest);

    let result;
    while (true) {
      const candidate = tierCandidates[tierCandidateIndex];
      tier = candidate.tier;
      const provider = pickProvider(tier.type);
      let observable = false;
      try {
        result = await provider.sendMessage({
          system: assembledContext.system,
          messages: assembledContext.messages,
          tools: assembledContext.tools,
          tier,
          abortSignal,
          onEvent: (ev) => {
            if (['text', 'thinking', 'tool_use', 'tool_result'].includes(ev?.kind)) observable = true;
            if (ev.kind === 'text' && ev.data?.delta) {
              emitEvent(sessionId, 'text_delta', { delta: ev.data.delta });
            } else if (ev.kind === 'thinking' && ev.data?.delta) {
              emitEvent(sessionId, 'thinking_delta', { delta: ev.data.delta });
            } else if (ev.kind === 'tool_use') {
              emitEvent(sessionId, 'tool_use', { name: ev.data.name, input: ev.data.input, id: ev.data.id });
            }
          },
        });
        session.activeExecutionTrace?.addModelCall({
          role: 'chat',
          model: result?.model || tier.model,
          requestId: result?.requestId || '',
          stopReason: result?.stopReason || '',
          usage: result?.usage || {},
        });
        break;
      } catch (err) {
        const next = tierCandidates[tierCandidateIndex + 1];
        if (turnIdx > 0 || observable || !next || !modelConfig.shouldFallback(err)) throw err;
        const from = tier.provenance;
        tierCandidateIndex += 1;
        tier = next.tier;
        emitEvent(sessionId, 'model_fallback', { from, to: tier.provenance, reason: err.message || String(err), fallbackIndex: tierCandidateIndex });
      }
    }

    const assistantBlocks = [];
    for (const block of result.content || []) {
      if (block.type === 'text') {
        assistantBlocks.push(block);
        if (block.text) lastText = safeStr(block.text);
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
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
    const parallelReadResults = new Map();
    const readPromisesByKey = new Map();
    const parallelReadUses = toolUses.filter((use) => getToolCapability(use.name).parallelSafe && !toolResultCache.get(use.name, use.input || {}));
    if (parallelReadUses.length > 1) {
      await Promise.all(parallelReadUses.map(async (use) => {
        const key = toolCacheKey(use.name, use.input || {});
        if (!readPromisesByKey.has(key)) {
          readPromisesByKey.set(key, (async () => {
            try {
              if (use.name === 'WebSearch') return await handleWebSearch(use.input, session);
              if (use.name === 'WebFetch') return await handleWebFetch(use.input);
              return await callMcpTool(use.name, use.input);
            } catch (err) {
              return { text: err?.message || String(err), isError: true };
            }
          })());
        }
        parallelReadResults.set(use.id, await readPromisesByKey.get(key));
      }));
    }
    for (const use of toolUses) {
      const toolCall = {
        id: use.id,
        name: use.name,
        input: use.input,
        status: 'running',
      };
      let toolResult;
      let isError = false;
      const args = use.input || {};
      const cacheable = isCacheableToolName(use.name);
      const cacheKey = toolCacheKey(use.name, args);
      let fittedToolResult;
      let cached = false;
      const cachedResult = cacheable ? toolResultCache.get(use.name, args) : null;
      try {
        if (parallelReadResults.has(use.id)) {
          toolResult = parallelReadResults.get(use.id);
        } else if (cachedResult) {
          cached = true;
          toolResult = { text: cachedResult.displayContent, isError: !!cachedResult.isError };
        } else if (use.name === 'set_workflow_phase') {
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
        } else if (isFrontendTool(use.name) && getToolCapability(use.name).chapterMutation) {
          const preview = buildFrontendChapterMutationPreview(session, use);
          const strictVerification = await chapterDraftService.verifyChapterContentStrict({
            name: preview.name,
            displayName: preview.displayName,
            text: preview.afterContent,
            userText,
            editorContext: session.editorContext,
            abortSignal,
            onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
          });
          storePendingChapterIssues(session, strictVerification.issues || []);
          session.activeExecutionTrace?.setVerification({ status: strictVerification.status, checks: strictVerification.checks || [] });
          session.pendingWriteChapter = {
            kind: 'chapter_mutation',
            mutationTool: use.name,
            mutationExecution: 'frontend',
            mutationArgs: preview.mutationArgs,
            name: preview.name,
            title: preview.displayName || preview.name,
            content: preview.afterContent,
            baseContent: preview.beforeContent,
            verification: {
              status: strictVerification.status,
              contentHash: strictVerification.contentHash,
              checks: strictVerification.checks || [],
            },
            toolUseId: use.id,
          };
          emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
            kind: 'chapter_mutation',
            mutationTool: use.name,
            name: preview.name,
            title: preview.displayName,
            contentPreview: preview.afterContent.slice(0, 500),
            contentLength: preview.afterContent.length,
            verificationStatus: strictVerification.status,
            blockingIssues: (strictVerification.issues || []).filter((issue) => issue.severity === 'blocking').map((issue) => issue.summary).slice(0, 8),
          });
          toolResult = {
            text: strictVerification.status === 'passed'
              ? `${use.name} 已生成预览并通过严格验证，等待用户确认；编辑器尚未修改。`
              : `${use.name} 预览未通过严格验证；编辑器尚未修改。`,
            isError: false,
          };
        } else if (isFrontendTool(use.name)) {
          toolResult = await handleFrontendTool(session, use);
        } else if (use.name === 'WebSearch') {
          toolResult = await handleWebSearch(use.input, session);
        } else if (use.name === 'WebFetch') {
          toolResult = await handleWebFetch(use.input);
        } else if (use.name === 'spawn_subagent') {
          toolResult = await handleSpawnSubagent(use.input, session);
        } else if (use.name === 'replace_chapter_text' || use.name === 'apply_chapter_patch') {
          const previewResult = await callMcpTool(use.name, { ...(use.input || {}), previewOnly: true });
          if (previewResult.isError) throw new Error(previewResult.text || `${use.name} preview failed`);
          const previewPayload = parseTextJson(previewResult.text) || {};
          const afterContent = safeStr(previewPayload.afterContent || previewPayload.changedFiles?.[0]?.afterContent || '');
          const beforeContent = safeStr(previewPayload.baseContent || previewPayload.changedFiles?.[0]?.beforeContent || '');
          if (!afterContent) throw new Error(`${use.name} preview did not return afterContent`);
          const strictVerification = await chapterDraftService.verifyChapterContentStrict({
            name: use.input?.name || previewPayload.name || '',
            displayName: use.input?.name || previewPayload.name || '',
            text: afterContent,
            userText,
            editorContext: session.editorContext,
            abortSignal,
            onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
          });
          storePendingChapterIssues(session, strictVerification.issues || []);
          session.activeExecutionTrace?.setVerification({ status: strictVerification.status, checks: strictVerification.checks || [] });
          session.pendingWriteChapter = {
            kind: 'chapter_mutation',
            mutationTool: use.name,
            mutationExecution: 'mcp',
            mutationArgs: { ...(use.input || {}) },
            name: use.input?.name || previewPayload.name || '',
            title: use.input?.name || previewPayload.name || '',
            content: afterContent,
            baseContent: beforeContent,
            verification: {
              status: strictVerification.status,
              contentHash: strictVerification.contentHash,
              checks: strictVerification.checks || [],
            },
            toolUseId: use.id,
          };
          emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
            kind: 'chapter_mutation',
            mutationTool: use.name,
            name: session.pendingWriteChapter.name,
            title: session.pendingWriteChapter.title,
            contentPreview: afterContent.slice(0, 500),
            contentLength: afterContent.length,
            verificationStatus: strictVerification.status,
            blockingIssues: (strictVerification.issues || []).filter((issue) => issue.severity === 'blocking').map((issue) => issue.summary).slice(0, 8),
          });
          toolResult = {
            text: strictVerification.status === 'passed'
              ? `${use.name} 已生成预览并通过严格验证，等待用户确认后提交。`
              : `${use.name} 已生成预览，但严格验证存在阻塞；没有修改章节文件。`,
            isError: false,
          };
        } else if (use.name === 'write_chapter') {
          const pendingIssues = getPendingChapterIssues(session);
          if (hasBlockingReviewIssues(pendingIssues)) {
            throw new Error(formatPendingChapterOpenIssues(pendingIssues, { prefix: '章节写入被审查门槛拦截：仍有 open 问题。' }));
          }
          const strictVerification = await chapterDraftService.verifyChapterContentStrict({
            name: use.input?.name || use.input?.insertAfter || 'new-chapter.md',
            displayName: use.input?.title || use.input?.name || use.input?.insertAfter || '新章节',
            title: use.input?.title || '',
            text: use.input?.content || '',
            userText,
            editorContext: session.editorContext,
            abortSignal,
            onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
          });
          storePendingChapterIssues(session, strictVerification.issues || []);
          session.activeExecutionTrace?.setVerification({
            status: strictVerification.status,
            checks: strictVerification.checks || [],
          });
          // Gate: write_chapter requires strict verification and explicit user confirmation.
          session.pendingWriteChapter = {
            name: use.input?.name || '',
            title: use.input?.title || '',
            content: use.input?.content || '',
            summary: use.input?.summary || '',
            volumeIndex: use.input?.volumeIndex,
            sectionIndex: use.input?.sectionIndex,
            baseContent: use.input?.baseContent || '',
            insertAfter: use.input?.insertAfter || '',
            contextBundle: strictVerification.draft?.contextBundle || null,
            assertions: strictVerification.draft?.assertions || [],
            stateVerifications: strictVerification.draft?.stateVerifications || [],
            verification: {
              status: strictVerification.status,
              contentHash: strictVerification.contentHash,
              checks: strictVerification.checks || [],
            },
            toolUseId: use.id,
          };
          emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
            name: session.pendingWriteChapter.name,
            title: session.pendingWriteChapter.title,
            contentPreview: session.pendingWriteChapter.content.slice(0, 500),
            contentLength: session.pendingWriteChapter.content.length,
            verificationStatus: strictVerification.status,
            blockingIssues: (strictVerification.issues || []).filter((issue) => issue.severity === 'blocking').map((issue) => issue.summary).slice(0, 8),
          });
          toolResult = {
            text: strictVerification.status === 'passed'
              ? '章节写入请求已通过严格验证，等待用户手动确认。请不要再调用其他工具，等待用户操作。'
              : '章节写入请求未通过严格验证。草稿已保留但禁止写入，请先处理阻塞问题。',
            isError: false,
          };
        } else {
          toolResult = await callMcpTool(use.name, use.input);
        }
      } catch (err) {
        const message = err.message || String(err);
        toolResult = { text: isFrontendTool(use.name) ? `Frontend action failed: ${message}` : message, isError: true };
        isError = true;
      }

      if (cachedResult) {
        fittedToolResult = fitToolResultForModel({
          toolName: use.name,
          toolUseId: use.id,
          content: cachedResult.displayContent,
          isError: !!cachedResult.isError,
        });
      } else {
        fittedToolResult = fitToolResultForModel({
          toolName: use.name,
          toolUseId: use.id,
          content: toolResult.text,
          isError: toolResult.isError || isError,
        });
        if (cacheable && !(toolResult.isError || isError)) {
          toolResultCache.set(use.name, args, {
            modelContent: fittedToolResult.modelContent,
            displayContent: fittedToolResult.displayContent,
            wasTrimmed: fittedToolResult.wasTrimmed,
            stats: fittedToolResult.stats,
            manifestItem: fittedToolResult.manifestItem,
            isError: !!(toolResult.isError || isError),
          });
        }
      }
      if (fittedToolResult.wasTrimmed) toolResultTrimmedCount += 1;
      const sourceRef = `tool:${use.name}#${use.id}`;
      const manifestItem = {
        ...(fittedToolResult.manifestItem || {}),
        sourceRef,
        toolName: use.name,
        toolUseId: use.id,
        cacheKey,
      };
      manifestState.included.push({
        kind: 'tool_result',
        sourceRef,
        toolName: use.name,
        toolUseId: use.id,
        cacheKey,
        cached,
      });
      if (fittedToolResult.wasTrimmed) manifestState.trimmed.push(manifestItem);
      if (cached) {
        manifestState.cached.push({
          kind: 'tool_result',
          sourceRef,
          toolName: use.name,
          toolUseId: use.id,
          cacheKey,
        });
      }

      emitEvent(sessionId, 'tool_result', {
        name: use.name,
        text: fittedToolResult.displayContent,
        isError: toolResult.isError || isError,
        id: use.id,
        modelContentTrimmed: fittedToolResult.wasTrimmed,
        originalLength: fittedToolResult.stats.originalLength,
        modelLength: fittedToolResult.stats.modelLength,
        cached,
        cacheKey,
        sourceRef,
      });

      toolCall.status = 'done';
      toolCall.result = fittedToolResult.displayContent;
      toolCall.isError = toolResult.isError || isError;
      toolCall.cached = cached;
      toolCall.cacheKey = cacheKey;
      toolCall.sourceRef = sourceRef;
      toolCall.modelContentTrimmed = fittedToolResult.wasTrimmed;
      toolCall.originalLength = fittedToolResult.stats.originalLength;
      toolCall.modelLength = fittedToolResult.stats.modelLength;
      toolCalls.push(toolCall);

      toolResults.push(toolResultContent(use.id, fittedToolResult.modelContent, toolResult.isError || isError));
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
        emitEvent(sessionId, 'tool_use', { name: payload.data.name, input: toolInput, id: key, execution: 'runtime_managed' });
      } else if (payload.kind === 'awaiting_confirmation') {
        const confirmation = payload.data || {};
        const toolName = confirmation.tool || confirmation.name || '';
        const capability = getToolCapability(toolName);
        if (capability.chapterMutation) {
          stageDriverChapterMutation({
            session,
            sessionId,
            runId: payload.runId || runId,
            toolUseId: confirmation.toolUseId,
            toolName,
            args: confirmation.arguments || {},
            userText,
            abortSignal,
          }).catch((error) => {
            session.activeExecutionTrace?.addProcess(`Driver 章节变更预览失败：${error?.message || String(error)}`);
            mcpClient.resolveConfirmation(payload.runId || runId, confirmation.toolUseId, {
              accept: false,
              reason: 'chapter mutation preview or strict verification failed',
            });
          });
        } else {
          emitEvent(sessionId, 'awaiting_runtime_tool_confirmation', {
            ...confirmation,
            execution: 'runtime_managed',
          });
        }
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
          execution: 'runtime_managed',
        });
      }
    } catch { /* ignore forwarding errors */ }
  }) : () => {};

  // Build a single text prompt from canonical content blocks. Raw thinking is
  // intentionally omitted, while tool calls/results are retained as bounded
  // summaries so driver-backed chat can resume the same factual conversation.
  const conversationInput = session.messages.length > 1
    ? serializeConversationForDriver(session.messages) + '\n---\n' + userText
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

    session.activeExecutionTrace?.addModelCall({
      role: 'chat_driver',
      model: result?.telemetry?.model || result?.model || '',
      requestId: result?.runId || runId,
      stopReason: result?.stopReason || 'completed',
      usage: result?.telemetry?.usage || result?.usage || {},
    });

    lastText = safeStr(result?.output) || lastText;
    return { text: lastText, turns: 1, toolCalls: Array.from(toolCallMap.values()) };
  } finally {
    unsub();
  }
}

async function stageDriverChapterMutation({ session, sessionId, runId, toolUseId, toolName, args, userText, abortSignal }) {
  try {
    if (session.pendingWriteChapter) {
      throw new Error('已有章节变更正在等待用户确认');
    }
    let afterContent = '';
    let beforeContent = safeStr(args?.baseContent || '');
    let resolvedName = safeStr(args?.name || '');
    if (toolName === 'replace_chapter_text' || toolName === 'apply_chapter_patch') {
      const previewResult = await callMcpTool(toolName, { ...(args || {}), previewOnly: true });
      if (previewResult.isError) throw new Error(previewResult.text || `${toolName} preview failed`);
      const previewPayload = parseTextJson(previewResult.text) || {};
      afterContent = safeStr(previewPayload.afterContent || previewPayload.changedFiles?.[0]?.afterContent || '');
      beforeContent = safeStr(previewPayload.baseContent || previewPayload.changedFiles?.[0]?.beforeContent || beforeContent);
      resolvedName = resolvedName || safeStr(previewPayload.name || '');
    } else if (toolName === 'write_chapter') {
      afterContent = safeStr(args?.content || '');
    } else {
      throw new Error(`Unsupported driver chapter mutation: ${toolName}`);
    }
    if (!afterContent.trim()) throw new Error(`${toolName} preview did not provide chapter content`);
    const verificationName = resolvedName || safeStr(args?.insertAfter || '') || 'new-chapter.md';
    const strictVerification = await chapterDraftService.verifyChapterContentStrict({
      name: verificationName,
      displayName: safeStr(args?.title || resolvedName || verificationName),
      title: safeStr(args?.title || ''),
      text: afterContent,
      userText,
      editorContext: session.editorContext,
      abortSignal,
      onProgress: (event) => emitProgressEvent(sessionId, event.message, event),
    });
    storePendingChapterIssues(session, strictVerification.issues || []);
    session.activeExecutionTrace?.setVerification({ status: strictVerification.status, checks: strictVerification.checks || [] });
    session.pendingWriteChapter = {
      kind: toolName === 'write_chapter' ? 'chapter_write' : 'chapter_mutation',
      mutationTool: toolName === 'write_chapter' ? null : toolName,
      mutationExecution: toolName === 'write_chapter' ? null : 'mcp',
      mutationArgs: toolName === 'write_chapter' ? null : { ...(args || {}) },
      name: resolvedName,
      title: safeStr(args?.title || resolvedName || verificationName),
      content: afterContent,
      baseContent: beforeContent,
      insertAfter: safeStr(args?.insertAfter || ''),
      volumeIndex: args?.volumeIndex,
      sectionIndex: args?.sectionIndex,
      verification: {
        status: strictVerification.status,
        contentHash: strictVerification.contentHash,
        checks: strictVerification.checks || [],
      },
      contextBundle: strictVerification.draft?.contextBundle || null,
      assertions: strictVerification.draft?.assertions || [],
      stateVerifications: strictVerification.draft?.stateVerifications || [],
      toolUseId,
      driverRunId: runId,
    };
    emitEvent(sessionId, 'awaiting_write_chapter_confirmation', {
      kind: session.pendingWriteChapter.kind,
      mutationTool: toolName,
      name: resolvedName,
      title: session.pendingWriteChapter.title,
      contentPreview: afterContent.slice(0, 500),
      contentLength: afterContent.length,
      verificationStatus: strictVerification.status,
      blockingIssues: (strictVerification.issues || []).filter((issue) => issue.severity === 'blocking').map((issue) => issue.summary).slice(0, 8),
      execution: 'runtime_managed',
    });
  } finally {
    mcpClient.resolveConfirmation(runId, toolUseId, {
      accept: false,
      reason: 'chapter mutation captured as preview; explicit verified commit is handled by the chat harness',
    });
  }
}

function resolveCharacterContextTargetChapter(session) {
  const ctx = session?.editorContext || {};
  const pending = session?.pendingChapterDraft || {};
  const name = safeStr(
    pending.name
    || ctx.chapterFileName
    || (ctx.type === 'chapter' ? ctx.title : '')
  ).trim();
  if (!name) return null;
  const displayName = safeStr(
    pending.displayName
    || ctx.chapterDisplayName
    || ctx.title
    || name
  ).trim() || name;
  return {
    name,
    displayName,
    titleHint: safeStr(pending.title || ctx.chapterDisplayName || displayName).trim() || displayName,
  };
}

async function buildChatCharacterContextForProvider({ session, userText, chatToolPolicy, activeNovelId }) {
  const policy = classifyCharacterContextPolicy(userText, { ...session, activeNovelId }, chatToolPolicy);
  const baseItem = {
    kind: 'character_context',
    policyId: policy.id,
    reason: policy.reason,
  };
  if (!policy.shouldPreload) {
    return { policy, omittedItem: baseItem };
  }

  const targetChapter = resolveCharacterContextTargetChapter(session);
  if (!targetChapter) {
    return { policy, omittedItem: { ...baseItem, reason: 'no-target-chapter' } };
  }

  const sceneContext = await chapterDraftService.buildSceneCharacterContextForTargetChapter(targetChapter);
  const sceneCharacterContexts = Array.isArray(sceneContext?.sceneCharacterContexts)
    ? sceneContext.sceneCharacterContexts
    : [];
  if (!sceneCharacterContexts.length) {
    return {
      policy,
      omittedItem: {
        ...baseItem,
        sourceRef: `character-context:${targetChapter.name}`,
        targetChapter: targetChapter.name,
        reason: 'no-scene-character-context',
      },
    };
  }

  const payload = {
    targetChapter,
    sceneCharacterContexts,
  };
  const sourceRef = `character-context:${targetChapter.name}`;
  const fitted = fitTextForModel(JSON.stringify(payload, null, 2), {
    maxChars: policy.maxChars,
    sourceRef,
    label: 'chat_scene_character_context',
    kind: 'character_context',
  });
  const characterCount = sceneCharacterContexts.reduce((sum, context) => {
    return sum + (Array.isArray(context?.characters) ? context.characters.length : 0);
  }, 0);
  const manifestItem = {
    ...(fitted.manifestItem || {}),
    sourceRef,
    policyId: policy.id,
    targetChapter: targetChapter.name,
    nodeCount: sceneCharacterContexts.length,
    characterCount,
  };
  return {
    policy,
    systemBlock: [
      '## Preloaded Scene Character Context',
      'The harness assembled this low-noise context for the current writing/review turn. Use it before calling character tools. Do not call read_character for full cards unless an exact missing detail is necessary.',
      fitted.text,
    ].join('\n\n'),
    includedItem: manifestItem,
    trimmedItem: fitted.wasTrimmed ? manifestItem : null,
    stats: {
      sourceRef,
      originalLength: fitted.originalLength,
      modelLength: fitted.modelLength,
      wasTrimmed: fitted.wasTrimmed,
      nodeCount: sceneCharacterContexts.length,
      characterCount,
    },
  };
}

function buildChatRetrievalQuery({ targetChapter, userText, session }) {
  const ctx = session?.editorContext || {};
  return [
    targetChapter?.displayName,
    targetChapter?.titleHint,
    targetChapter?.name,
    ctx.selectedText,
    userText,
  ].map((item) => safeStr(item).trim()).filter(Boolean).join('\n');
}

async function buildChatRetrievalContextForProvider({ session, userText, chatToolPolicy, activeNovelId }) {
  const policy = classifyRetrievalContextPolicy(userText, { ...session, activeNovelId }, chatToolPolicy);
  const baseItem = {
    kind: 'rag_context',
    policyId: policy.id,
    reason: policy.reason,
  };
  if (!policy.shouldPreload) {
    return { policy, omittedItem: baseItem };
  }

  const targetChapter = resolveCharacterContextTargetChapter(session);
  if (!targetChapter) {
    return { policy, omittedItem: { ...baseItem, reason: 'no-target-chapter' } };
  }

  const query = buildChatRetrievalQuery({ targetChapter, userText, session });
  if (!query.trim()) {
    return { policy, omittedItem: { ...baseItem, targetChapter: targetChapter.name, reason: 'empty-query' } };
  }

  let payload = null;
  try {
    const result = await mcpClient.callTool({
      name: 'retrieve_context',
      arguments: {
        query,
        focus: userText,
        chapterName: targetChapter.name,
        maxItems: policy.maxItems,
        maxChars: policy.maxChars,
      },
      autoConfirm: true,
    });
    const text = Array.isArray(result?.content)
      ? result.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
      : safeStr(result);
    payload = parseTextJson(text);
  } catch {
    payload = null;
  }

  const contextText = safeStr(payload?.contextText).trim();
  if (!contextText) {
    return {
      policy,
      omittedItem: {
        ...baseItem,
        sourceRef: `rag-context:${targetChapter.name}`,
        targetChapter: targetChapter.name,
        reason: 'no-retrieved-context',
      },
    };
  }

  const sourceRef = `rag-context:${targetChapter.name}`;
  const fitted = fitTextForModel(contextText, {
    maxChars: policy.maxChars,
    sourceRef,
    label: 'chat_retrieved_context',
    kind: 'rag_context',
  });
  const itemCount = Array.isArray(payload?.items) ? payload.items.length : Number(payload?.resultCount) || 0;
  const manifestItem = {
    ...(fitted.manifestItem || {}),
    kind: 'rag_context',
    sourceRef,
    policyId: policy.id,
    targetChapter: targetChapter.name,
    itemCount,
  };
  const wasTrimmed = fitted.wasTrimmed || !!payload?.wasTrimmed;
  return {
    policy,
    systemBlock: [
      '## Preloaded Retrieval Context',
      'The harness retrieved bounded world/persona/place/timeline context for this writing/review turn. Use it as supporting evidence before calling broad read tools.',
      fitted.text,
    ].join('\n\n'),
    includedItem: manifestItem,
    trimmedItem: wasTrimmed ? manifestItem : null,
    stats: {
      sourceRef,
      originalLength: fitted.originalLength,
      modelLength: fitted.modelLength,
      wasTrimmed,
      itemCount,
    },
  };
}

async function prepareChatTurnContext({ session, userText, chatToolPolicy, activeNovelId }) {
  const [characterContext, retrievalContext] = await Promise.all([
    buildChatCharacterContextForProvider({ session, userText, chatToolPolicy, activeNovelId }),
    buildChatRetrievalContextForProvider({ session, userText, chatToolPolicy, activeNovelId }),
  ]);
  const systemBlocks = [];
  const manifest = { included: [], trimmed: [], omitted: [], cached: [] };
  for (const item of [characterContext, retrievalContext]) {
    if (item?.systemBlock) systemBlocks.push(item.systemBlock);
    if (item?.includedItem) manifest.included.push(item.includedItem);
    if (item?.trimmedItem) manifest.trimmed.push(item.trimmedItem);
    if (item?.omittedItem) manifest.omitted.push(item.omittedItem);
  }
  return { systemBlock: systemBlocks.join('\n\n---\n'), manifest };
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

  const initialToolPolicy = classifyChatToolPolicy(userText, session);
  session.activeExecutionTrace = createExecutionTraceAccumulator({
    driverId: driverId || 'direct-api',
    path: useDriver ? 'driver' : 'direct-api',
    intent: initialToolPolicy.id,
    toolPolicy: initialToolPolicy,
    onUpdate: (update) => broadcastEvent(sessionId, 'execution_trace_update', update),
  });
  session.activeExecutionTrace.upsertStage('route', {
    kind: 'route',
    label: '选择执行路径',
    status: 'completed',
    summary: `${useDriver ? 'Driver' : 'Direct API'} · ${initialToolPolicy.labels?.join(' + ') || initialToolPolicy.id}`,
  });
  session.activeExecutionTrace.addProcess(`已识别任务：${initialToolPolicy.labels?.join('、') || initialToolPolicy.id}`);

  session.messages.push(textContent(userText));

  const roleplayEvents = [];
  const withRoleplayEvents = (result) => ({
    ...(result || {}),
    roleplayEvents: Array.isArray(result?.roleplayEvents) && result.roleplayEvents.length
      ? result.roleplayEvents
      : roleplayEvents,
  });
  const emitTurnDone = (result) => {
    if (result?.harnessTrace) session.activeExecutionTrace?.mergeHarness(result.harnessTrace);
    for (const toolCall of Array.isArray(result?.toolCalls) ? result.toolCalls : []) {
      const capability = getToolCapability(toolCall?.name);
      session.activeExecutionTrace?.upsertTool({
        ...capability,
        ...toolCall,
        status: toolCall?.isError ? 'failed' : 'done',
        result: toolCall?.result,
      });
    }
    const pendingDecision = !!(
      session.pendingWriteChapter
      || session.pendingChapterDraft
      || session.pendingOutlineDraft
      || session.pendingRoleplayRiskGate
      || session.pendingRoleplayProfileGate
      || session.pendingRoleplayProfileProposal
    );
    const blocked = result?.harnessBlocked === true
      || (Array.isArray(result?.harnessTrace?.diagnostics) && result.harnessTrace.diagnostics.some((item) => item?.severity === 'blocking'))
      || session.activeExecutionTrace?.snapshot()?.verification?.status === 'blocked';
    const failed = (Array.isArray(result?.toolCalls) && result.toolCalls.some((tool) => tool?.isError))
      || /^章节(?:变更提交|写入)失败/u.test(result?.text || '');
    const traceStatus = blocked ? 'blocked' : failed ? 'failed' : pendingDecision ? 'awaiting_confirmation' : 'completed';
    const executionTrace = session.activeExecutionTrace?.complete(traceStatus) || result?.executionTrace || null;
    if (result && typeof result === 'object') result.executionTrace = executionTrace;
    emitEvent(sessionId, 'turn_done', {
      text: result?.text || '',
      turns: result?.turns || 1,
      roleplayEvents: Array.isArray(result?.roleplayEvents) ? result.roleplayEvents : [],
      harnessTrace: result?.harnessTrace || null,
      executionTrace,
    });
  };

  emitEvent(sessionId, 'turn_start', { userText });

  try {
    const postWriteRetry = await maybeHandlePostWriteRetry(session, userText, sessionId);
    if (postWriteRetry) {
      const finalResult = withRoleplayEvents(postWriteRetry);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }
    const writeConfirmation = await maybeHandleWriteChapterConfirmation(session, userText, sessionId);
    if (writeConfirmation) {
      const finalResult = withRoleplayEvents(writeConfirmation);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const chapterAutomated = await maybeHandleChapterDraftAutomation(session, userText, sessionId, abortSignal, roleplayEvents);
    if (chapterAutomated) {
      const finalResult = withRoleplayEvents(chapterAutomated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const automated = await maybeHandleOutlineAutomation(session, userText, sessionId, abortSignal, roleplayEvents);
    if (automated) {
      const finalResult = withRoleplayEvents(automated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const characterReviewAutomated = await maybeHandleCharacterConsistencyReviewAutomation(session, userText);
    if (characterReviewAutomated) {
      const finalResult = withRoleplayEvents(characterReviewAutomated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const chapterFactCheckAutomated = await maybeHandleChapterFactCheckAutomation(session, userText);
    if (chapterFactCheckAutomated) {
      const finalResult = withRoleplayEvents(chapterFactCheckAutomated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const pendingDeAiApplyAutomated = await maybeHandlePendingDeAiChapterApply(session, userText);
    if (pendingDeAiApplyAutomated) {
      const finalResult = withRoleplayEvents(pendingDeAiApplyAutomated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const deAiChapterReviewAutomated = await maybeHandleDeAiChapterReviewAutomation(session, userText);
    if (deAiChapterReviewAutomated) {
      const finalResult = withRoleplayEvents(deAiChapterReviewAutomated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    const deAiAutomated = await maybeHandleDeAiAutomation(session, sessionId, userText, abortSignal);
    if (deAiAutomated) {
      const finalResult = withRoleplayEvents(deAiAutomated);
      session.messages.push(assistantContent([{ type: 'text', text: finalResult.text || '' }]));
      emitTurnDone(finalResult);
      await persistAssistantTurn(session, finalResult);
      return;
    }

    let system = await buildSystemPrompt(
      session.editorContext,
      useDriver,
      mcpClient.getActiveNovel(),
      session.workflowPhase,
      session.pendingOutlineDraft,
      session.pendingOutlineIssues
    );

    let result;
    if (useDriver) {
      const driverPolicy = classifyChatToolPolicy(userText, session);
      let activeNovelId = session.editorContext?.novelId || '';
      try { activeNovelId = activeNovelId || mcpClient.getActiveNovel(); } catch { /* best effort */ }
      const prepared = await prepareChatTurnContext({ session, userText, chatToolPolicy: driverPolicy, activeNovelId });
      if (prepared.systemBlock) system = `${system}\n\n---\n${prepared.systemBlock}`;
      emitEvent(sessionId, 'context_manifest', {
        schemaVersion: 1,
        runKind: 'chatAgent-driver',
        turnIdx: 0,
        ...prepared.manifest,
        toolPolicy: driverPolicy,
        stats: { manifestTrimmedCount: prepared.manifest.trimmed.length, manifestCachedCount: 0 },
      });
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

    const finalResult = withRoleplayEvents(result);
    emitTurnDone(finalResult);
    await persistAssistantTurn(session, finalResult);
  } catch (err) {
    const msg = err?.message || String(err);
    session.activeExecutionTrace?.addProcess(`执行失败：${msg}`);
    const cancelled = err?.name === 'AbortError' || /aborted|cancelled|canceled/iu.test(msg);
    const executionTrace = session.activeExecutionTrace?.complete(cancelled ? 'cancelled' : 'failed') || null;
    emitEvent(sessionId, 'error', { message: msg, executionTrace });
    if (executionTrace) {
      await persistAssistantTurn(session, { text: '', turns: 1, toolCalls: [], executionTrace }).catch(() => {});
    }
    throw err;
  } finally {
    session.abortController = null;
    session.activeExecutionTrace = null;
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
