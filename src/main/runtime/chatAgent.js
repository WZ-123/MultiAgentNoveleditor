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
const { generateOutlineDraft } = require('./outlineDraftService');
const { detectOutlineChatIntent, detectOutlineConfirmIntent } = require('./outlineIntent');
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

const BUILTIN_CHAT_TOOLS = [...BUILTIN_BACKEND_TOOLS, ...FRONTEND_TOOLS];

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
    pendingOutlineDraft: null,
    pendingOutlineIssues: [],
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
        '2. If a pending outline draft already exists in session, treat that draft as the current source of truth until the user discards or confirms it.',
        '3. If no outline exists, propose a complete outline with volumes/sections/chapters.',
        '4. Present your outline clearly and wait for the user to review and confirm it.',
        '5. When the user confirms, call `confirm_outline`. If a pending outline draft exists in session, you may call it without reconstructing nodes from memory.',
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
        '6. Call `write_chapter({name:"...", content:"...", title:"..."})` to write the chapter. If you are rewriting an existing chapter after reading it, include `baseContent` from the latest `read_chapter` result so stale drafts do not overwrite newer text.',
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
        '2a. If the user asks to "去 AI 味" / "去套话" / "润色得更像人写" and Current Editor State includes `User selected text`, prefer `de_ai_ify` on that selected text first, then apply the result with `replace_selected_text`.',
        '2b. If the user asks to check character consistency / OOC / 人设冲突 in the current chapter, prefer `review_character_consistency` first and report paragraph-level findings before making any edits.',
        '3. If the user wants to revise an existing passage but has not selected text, first use `read_chapter`, then call `replace_chapter_text` with a sufficiently long snippet plus nearby `beforeContext`/`afterContext` from the same chapter so the edit stays anchored like an IDE patch.',
        '4. If `replace_chapter_text` reports multiple matches, tell the user to either select the exact target text or place the cursor next to the desired occurrence. Then use `replace_selected_text` or `replace_text_near_cursor` instead of guessing.',
        '5. Use `replace_text_near_cursor` only after the user has manually moved the cursor near the intended occurrence.',
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

async function buildSystemPrompt(editorContext, useDriver, mcpFallbackNovelId, workflowPhase, pendingOutlineDraft, pendingOutlineIssues) {
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
  lines.push('');

  if (pendingOutlineDraft?.rawMarkdown) {
    lines.push('## Pending Outline Draft');
    lines.push('A session-local outline draft exists but has NOT been saved yet. Treat it as the current working draft for review, revision, and confirmation.');
    lines.push('If the user asks to revise the outline, revise this draft instead of inventing a new one from scratch.');
    lines.push('If the user confirms saving, call `confirm_outline` and let the app use the pending draft nodes.');
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
  const phaseRules = generatePhaseRules(phase);
  lines.push.apply(lines, phaseRules);

  // Common tool list
  lines.push('');
  lines.push('## Available Tools');
  lines.push('You can call tools to read/write novel data and manipulate the editor:');
  lines.push('- Character tools: list_characters, read_character, enrich_character');
  lines.push('- Novel data: read_outline, read_outline_nodes, list_chapters, read_chapter, write_chapter, replace_chapter_text, apply_chapter_patch, query_world, apply_world_patch, query_timeline, list_assets, read_asset, read_style_memory, read_skill, list_skills, read_skill_content, search_index');
  lines.push('- Review: review_character_consistency (inspect chapter paragraphs against character cards and report paragraph-level conflicts without editing)');
  lines.push('- Rewrite: de_ai_ify (rewrite a Chinese fiction passage to remove AI-ish cliches while preserving meaning)');
  lines.push('- Auto-write: grant_asset, revoke_asset, apply_asset_patch, append_timeline, update_timeline, dedupe_timeline, append_summary, append_style_memory');
  lines.push('- Write (requires confirmation): create_character, update_character, update_world, apply_world_patch, write_chapter, replace_chapter_text, apply_chapter_patch');
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
  lines.push('7. If Current Editor State includes `User selected text`, that selection metadata is authoritative. Do not tell the user that you cannot see the editor highlight or selection marker.');
  lines.push('8. For chapter-wide review requests, prefer explicit review tools first; do not jump straight into many sequential `replace_chapter_text` calls against overlapping snippets. If multiple concrete fixes are already known, prefer one `apply_chapter_patch` over many independent replaces.');
  lines.push('9. For world lore or place-table tweaks, prefer `apply_world_patch` over `update_world` unless you are intentionally replacing the whole world block.');
  lines.push('10. For multi-step asset handoff changes, prefer `apply_asset_patch` over many separate `grant_asset`/`revoke_asset` calls. When editing from a prior asset read, include that asset\'s `baseGrantedTo` snapshot.');

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

function clearPendingOutlineDraft(session) {
  session.pendingOutlineDraft = null;
  session.pendingOutlineIssues = [];
}

function storePendingOutlineDraft(session, draft, issues) {
  session.pendingOutlineDraft = draft;
  session.pendingOutlineIssues = Array.isArray(issues) ? issues : [];
  session.workflowPhase = 'outline';
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

async function maybeHandleOutlineAutomation(session, userText, abortSignal) {
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
    return {
      text: '已将当前大纲写入项目，并切换到写作阶段。',
      turns: 1,
      toolCalls: [
        {
          id: 'confirm-outline-auto',
          name: 'confirm_outline',
          input: {},
          status: 'done',
          result: 'Outline confirmed and saved. Switched to writing phase.',
          isError: false,
        },
      ],
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
        const allowed = ['read_skill', 'list_skills', 'read_skill_content', 'de_ai_ify', 'create_novel', 'list_novels'];
        const filtered = mcpTools.filter((t) => allowed.includes(t.name));
        tools = [...filtered, ...BUILTIN_CHAT_TOOLS];
      } else {
        tools = [...mcpTools, ...BUILTIN_CHAT_TOOLS];
      }
      break; // success
    } catch (err) {
      if (retry === 0) {
        console.warn('[chatAgent] mcp.listTools failed, retrying...', err.message);
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.error('[chatAgent] mcp.listTools failed after retry', err);
        tools = [...BUILTIN_CHAT_TOOLS];
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
    const automated = await maybeHandleOutlineAutomation(session, userText, abortSignal);
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
