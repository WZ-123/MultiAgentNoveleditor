'use strict';

const { classifyChatTaskContract } = require('./chatToolRegistry');

const DEFAULT_TOOL_RESULT_CHAR_LIMIT = 12000;
const DEFAULT_ERROR_TOOL_RESULT_CHAR_LIMIT = 20000;
const DEFAULT_SKILL_BLOCK_CHAR_LIMIT = 24000;
const TRIM_NOTICE_PREFIX = '[Context trimmed for model]';

function safeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function estimateTokens(value) {
  const text = safeString(value);
  if (!text) return 0;
  // Conservative, dependency-free approximation for mixed Chinese/English.
  return Math.ceil(text.length / 2);
}

function fitTextForModel(value, options = {}) {
  const text = safeString(value);
  const maxChars = Math.max(256, Number(options.maxChars) || DEFAULT_TOOL_RESULT_CHAR_LIMIT);
  const sourceRef = safeString(options.sourceRef || '');
  const label = safeString(options.label || 'context');
  const kind = safeString(options.kind || 'context');
  if (text.length <= maxChars) {
    return {
      text,
      wasTrimmed: false,
      originalLength: text.length,
      modelLength: text.length,
      omittedLength: 0,
      sourceRef,
      manifestItem: {
        kind,
        sourceRef,
        label,
        originalLength: text.length,
        modelLength: text.length,
        reason: 'within_budget',
      },
    };
  }

  const notice = [
    TRIM_NOTICE_PREFIX,
    `label=${label}`,
    sourceRef ? `sourceRef=${sourceRef}` : '',
    `originalLength=${text.length}`,
    `modelCharLimit=${maxChars}`,
    'The middle of this content was omitted. Re-read the source/tool if exact omitted details are required.',
  ].filter(Boolean).join('\n');
  const footer = `[End trimmed context: ${label}${sourceRef ? ` ${sourceRef}` : ''}]`;
  const available = Math.max(128, maxChars - notice.length - footer.length - 8);
  const headLen = Math.max(64, Math.floor(available * 0.6));
  const tailLen = Math.max(64, available - headLen);
  const head = text.slice(0, headLen);
  const tail = text.slice(Math.max(headLen, text.length - tailLen));
  const fitted = `${notice}\n\n${head}\n\n[... omitted ${text.length - head.length - tail.length} chars ...]\n\n${tail}\n${footer}`;

  return {
    text: fitted,
    wasTrimmed: true,
    originalLength: text.length,
    modelLength: fitted.length,
    omittedLength: Math.max(0, text.length - head.length - tail.length),
    sourceRef,
    manifestItem: {
      kind,
      sourceRef,
      label,
      originalLength: text.length,
      modelLength: fitted.length,
      reason: 'trimmed_for_model',
    },
  };
}

function fitToolResultForModel({ toolName, toolUseId, content, isError } = {}) {
  const displayContent = safeString(content);
  const sourceRef = `tool:${safeString(toolName || 'unknown')}#${safeString(toolUseId || 'unknown')}`;
  const maxChars = isError ? DEFAULT_ERROR_TOOL_RESULT_CHAR_LIMIT : DEFAULT_TOOL_RESULT_CHAR_LIMIT;
  const fitted = fitTextForModel(displayContent, {
    maxChars,
    sourceRef,
    label: `tool_result:${safeString(toolName || 'unknown')}`,
  });
  return {
    modelContent: fitted.text,
    displayContent,
    wasTrimmed: fitted.wasTrimmed,
    stats: {
      sourceRef,
      originalLength: fitted.originalLength,
      modelLength: fitted.modelLength,
      omittedLength: fitted.omittedLength,
      estimatedOriginalTokens: estimateTokens(displayContent),
      estimatedModelTokens: estimateTokens(fitted.text),
    },
    manifestItem: {
      ...fitted.manifestItem,
      kind: 'tool_result',
      toolName: safeString(toolName || 'unknown'),
      toolUseId: safeString(toolUseId || 'unknown'),
    },
  };
}

function buildSystemWithSkillBlocks(baseSystem, skillBlocks, options = {}) {
  const base = safeString(baseSystem);
  const blocks = Array.isArray(skillBlocks) ? skillBlocks : [];
  if (!blocks.length) {
    return {
      system: base,
      stats: {
        skillBlockCount: 0,
        skillBlocksTrimmed: 0,
        skillOriginalChars: 0,
        skillModelChars: 0,
      },
    };
  }

  const maxChars = Math.max(1024, Number(options.maxSkillChars) || DEFAULT_SKILL_BLOCK_CHAR_LIMIT);
  const normalized = blocks.map((block, index) => {
    const name = safeString(block?.name || `skill-${index + 1}`);
    const content = safeString(block?.content);
    return {
      name,
      raw: `## References: ${name}\n\n${content}`,
      originalLength: content.length,
    };
  });
  const totalRaw = normalized.reduce((sum, block) => sum + block.raw.length, 0);
  let trimmed = 0;
  let rendered;
  if (totalRaw <= maxChars) {
    rendered = normalized.map((block) => block.raw);
  } else {
    const perBlock = Math.max(1024, Math.floor(maxChars / normalized.length));
    rendered = normalized.map((block) => {
      const fitted = fitTextForModel(block.raw, {
        maxChars: perBlock,
        sourceRef: `skill:${block.name}`,
        label: `skill:${block.name}`,
      });
      if (fitted.wasTrimmed) trimmed += 1;
      return fitted.text;
    });
  }

  const skillText = rendered.join('\n\n---\n');
  return {
    system: `${base}\n\n---\n${skillText}`,
    stats: {
      skillBlockCount: normalized.length,
      skillBlocksTrimmed: trimmed,
      skillOriginalChars: totalRaw,
      skillModelChars: skillText.length,
    },
  };
}

function countMessageChars(messages) {
  let chars = 0;
  let toolResultChars = 0;
  let toolResultCount = 0;
  let trimmedToolResultCount = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (!block) continue;
      if (block.type === 'text' || block.type === 'thinking') {
        chars += safeString(block.text).length;
      } else if (block.type === 'tool_result') {
        const content = safeString(block.content);
        const len = content.length;
        chars += len;
        toolResultChars += len;
        toolResultCount += 1;
        if (content.includes(TRIM_NOTICE_PREFIX)) trimmedToolResultCount += 1;
      } else if (block.type === 'tool_use') {
        chars += safeString(block.name).length + safeString(block.input).length;
      } else {
        chars += safeString(block).length;
      }
    }
  }
  return { chars, toolResultChars, toolResultCount, trimmedToolResultCount };
}

function countToolChars(tools) {
  return (Array.isArray(tools) ? tools : []).reduce((sum, tool) => {
    return sum + safeString(tool?.name).length + safeString(tool?.description).length + safeString(tool?.input_schema || tool?.inputSchema).length;
  }, 0);
}

function messageHasBlock(message, type) {
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === type);
}

function fitMessagesToContext(messages, { contextWindow, maxOutputTokens, fixedTokens } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const windowTokens = Number(contextWindow) || 0;
  if (!windowTokens) return { messages: source, omittedMessages: 0 };
  const availableTokens = Math.max(1024, windowTokens - (Number(maxOutputTokens) || 4096) - (Number(fixedTokens) || 0) - 1024);
  const out = source.slice();
  let omittedMessages = 0;
  while (out.length > 1 && estimateTokens(out) > availableTokens) {
    out.shift();
    omittedMessages += 1;
    // Never begin with an orphan tool result or assistant tool call.
    while (out.length > 1 && (messageHasBlock(out[0], 'tool_result') || messageHasBlock(out[0], 'tool_use'))) {
      out.shift();
      omittedMessages += 1;
    }
  }
  return { messages: out, omittedMessages };
}

function assembleProviderContext({ system, messages, tools, runtime = {}, manifest = {}, toolPolicy = null, modelLimits = null } = {}) {
  const systemText = safeString(system);
  const nextTools = Array.isArray(tools) ? tools : undefined;
  const toolChars = countToolChars(nextTools);
  const fittedMessages = fitMessagesToContext(messages, {
    contextWindow: modelLimits?.contextWindow,
    maxOutputTokens: modelLimits?.maxOutputTokens,
    fixedTokens: estimateTokens(systemText) + Math.ceil(toolChars / 2),
  });
  const nextMessages = fittedMessages.messages;
  const messageCounts = countMessageChars(nextMessages);
  const stats = {
    runtime,
    systemChars: systemText.length,
    messageChars: messageCounts.chars,
    toolResultChars: messageCounts.toolResultChars,
    toolResultCount: messageCounts.toolResultCount,
    trimmedToolResultCount: messageCounts.trimmedToolResultCount,
    toolsChars: toolChars,
    toolCount: Array.isArray(nextTools) ? nextTools.length : 0,
    estimatedInputTokens: Math.ceil((systemText.length + messageCounts.chars + toolChars) / 2),
    trimmedCount: messageCounts.trimmedToolResultCount + fittedMessages.omittedMessages,
    omittedMessages: fittedMessages.omittedMessages,
    contextWindow: Number(modelLimits?.contextWindow) || null,
    maxOutputTokens: Number(modelLimits?.maxOutputTokens) || null,
  };
  return {
    system: systemText,
    messages: nextMessages,
    tools: nextTools,
    stats,
    manifest: buildContextManifest({
      runtime,
      stats,
      included: manifest.included,
      trimmed: manifest.trimmed,
      omitted: manifest.omitted,
      cached: manifest.cached,
      toolPolicy,
    }),
  };
}

function stableJson(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function toolCacheKey(toolName, args) {
  return `${safeString(toolName || 'unknown')}::${stableJson(args || {})}`;
}

function isCacheableToolName(name) {
  const tool = safeString(name);
  return /^(list_|read_|query_|check_)/.test(tool)
    || ['search_index', 'search_novel', 'retrieve_context', 'get_system_time', 'WebFetch', 'WebSearch'].includes(tool);
}

function createToolResultCache() {
  const cache = new Map();
  return {
    get(toolName, args) {
      const cacheKey = toolCacheKey(toolName, args);
      return cache.get(cacheKey) || null;
    },
    set(toolName, args, value) {
      const cacheKey = toolCacheKey(toolName, args);
      cache.set(cacheKey, { ...value, cacheKey });
      return cacheKey;
    },
    has(toolName, args) {
      return cache.has(toolCacheKey(toolName, args));
    },
  };
}

function buildContextManifest({ runtime = {}, stats = {}, included, trimmed, omitted, cached, toolPolicy } = {}) {
  const trimList = Array.isArray(trimmed) ? trimmed : [];
  const cacheList = Array.isArray(cached) ? cached : [];
  return {
    schemaVersion: 1,
    runKind: runtime.kind || runtime.runKind || 'unknown',
    turnIdx: runtime.turnIdx ?? null,
    included: Array.isArray(included) ? included : [],
    trimmed: trimList,
    omitted: Array.isArray(omitted) ? omitted : [],
    cached: cacheList,
    toolPolicy: toolPolicy || null,
    stats: {
      ...stats,
      manifestTrimmedCount: trimList.length,
      manifestCachedCount: cacheList.length,
    },
  };
}

function classifyChatToolPolicy(userText, session = {}) {
  return classifyChatTaskContract(userText, session);
}

function classifyCharacterContextPolicy(userText, session = {}, chatToolPolicy = null) {
  const editorContext = session?.editorContext || {};
  const text = safeString(userText).toLowerCase();
  const contract = chatToolPolicy || classifyChatToolPolicy(userText, session);
  const policyId = contract.id;
  const policyLabels = Array.isArray(contract.labels) ? contract.labels : [policyId];
  const hasActiveNovel = !!(editorContext?.novelId || session?.activeNovelId);
  if (!hasActiveNovel) {
    return { id: 'none', shouldPreload: false, reason: 'no-active-novel' };
  }
  if (!policyLabels.some((label) => label === 'writing' || label === 'review')) {
    return { id: 'none', shouldPreload: false, reason: `tool-policy-${policyId}` };
  }
  const isChapterEditor = editorContext?.type === 'chapter' && !!(editorContext?.chapterFileName || editorContext?.title);
  const hasSelection = !!safeString(editorContext?.selectedText).trim();
  const mentionsCurrentChapter = /当前章节|这一章|本章|当前这章|当前正文|选中文本|selection|chapter-\d+\.md/.test(text);
  if (!isChapterEditor && !hasSelection && !mentionsCurrentChapter) {
    return { id: 'none', shouldPreload: false, reason: 'no-current-chapter-target' };
  }
  return {
    id: policyLabels.includes('review') ? 'review_scene_characters' : 'writing_scene_characters',
    shouldPreload: true,
    reason: policyLabels.includes('review') ? 'review-needs-scene-character-context' : 'writing-needs-scene-character-context',
    maxChars: policyLabels.includes('review') ? 14000 : 18000,
  };
}

function classifyRetrievalContextPolicy(userText, session = {}, chatToolPolicy = null) {
  const editorContext = session?.editorContext || {};
  const contract = chatToolPolicy || classifyChatToolPolicy(userText, session);
  const policyId = contract.id;
  const policyLabels = Array.isArray(contract.labels) ? contract.labels : [policyId];
  const hasActiveNovel = !!(editorContext?.novelId || session?.activeNovelId);
  if (!hasActiveNovel) {
    return { id: 'none', shouldPreload: false, reason: 'no-active-novel' };
  }
  if (!policyLabels.some((label) => label === 'writing' || label === 'review')) {
    return { id: 'none', shouldPreload: false, reason: `tool-policy-${policyId}` };
  }
  const isChapterEditor = editorContext?.type === 'chapter' && !!(editorContext?.chapterFileName || editorContext?.title);
  const hasSelection = !!safeString(editorContext?.selectedText).trim();
  const text = safeString(userText).toLowerCase();
  const mentionsCurrentChapter = /当前章节|这一章|本章|当前这章|当前正文|选中文本|selection|chapter-\d+\.md/.test(text);
  if (!isChapterEditor && !hasSelection && !mentionsCurrentChapter) {
    return { id: 'none', shouldPreload: false, reason: 'no-current-chapter-target' };
  }
  return {
    id: policyLabels.includes('review') ? 'review_retrieved_context' : 'writing_retrieved_context',
    shouldPreload: true,
    reason: policyLabels.includes('review') ? 'review-needs-retrieved-context' : 'writing-needs-retrieved-context',
    maxChars: policyLabels.includes('review') ? 12000 : 14000,
    maxItems: policyLabels.includes('review') ? 10 : 12,
  };
}

const TOOL_POLICY_ALLOWLISTS = {
  writing: new Set([
    'list_characters', 'read_character_context', 'read_character_memory', 'assemble_scene_context',
    'read_outline', 'read_outline_nodes', 'read_outline_chapter', 'read_outline_section', 'read_outline_volume',
    'list_chapters', 'list_chapter_displays', 'read_chapter', 'read_chapter_summary', 'write_chapter',
    'suggest_next_chapter_name', 'get_chapter_naming_rule',
    'query_world', 'query_timeline', 'check_timeline_feasibility', 'check_outline_scene_feasibility',
    'read_style_memory', 'append_style_memory', 'append_summary',
    'review_character_consistency', 'review_de_ai_style', 'review_paragraph_function', 'de_ai_ify',
    'replace_selected_text', 'replace_text_near_cursor', 'insert_text_at_cursor', 'get_full_editor_content',
    'replace_chapter_text', 'apply_chapter_patch',
    'set_workflow_phase', 'confirm_outline', 'spawn_subagent',
    'get_system_time', 'WebSearch', 'WebFetch', 'search_index', 'search_novel', 'retrieve_context',
  ]),
  review: new Set([
    'list_characters', 'read_character_context', 'read_character_memory',
    'list_chapters', 'list_chapter_displays', 'read_chapter', 'read_chapter_summary',
    'read_outline', 'read_outline_nodes', 'query_world', 'query_timeline',
    'review_character_consistency', 'review_de_ai_style', 'review_paragraph_function', 'de_ai_ify',
    'replace_selected_text', 'replace_text_near_cursor', 'insert_text_at_cursor', 'get_full_editor_content',
    'replace_chapter_text', 'apply_chapter_patch',
    'spawn_subagent', 'get_system_time', 'WebSearch', 'WebFetch', 'search_index', 'search_novel', 'retrieve_context',
  ]),
  character_edit: new Set([
    'list_characters', 'read_character', 'read_character_context', 'read_character_memory', 'patch_character_memory',
    'create_character', 'update_character', 'delete_character', 'enrich_character',
    'read_outline_nodes', 'read_chapter', 'query_world', 'query_timeline',
    'spawn_subagent', 'get_system_time', 'WebSearch', 'WebFetch', 'search_index', 'search_novel', 'retrieve_context',
  ]),
  world_edit: new Set([
    'query_world', 'read_world', 'update_world', 'apply_world_patch',
    'read_outline', 'read_outline_nodes', 'list_chapters', 'read_chapter',
    'list_characters', 'query_timeline',
    'spawn_subagent', 'get_system_time', 'WebSearch', 'WebFetch', 'search_index', 'search_novel', 'retrieve_context',
  ]),
  asset_edit: new Set([
    'list_assets', 'read_asset', 'query_assets', 'grant_asset', 'revoke_asset', 'apply_asset_patch',
    'list_characters', 'read_character_context', 'read_character_memory',
    'list_chapters', 'list_chapter_displays', 'read_chapter', 'read_chapter_summary',
    'query_timeline', 'search_index', 'search_novel', 'retrieve_context',
    'spawn_subagent', 'get_system_time', 'WebSearch', 'WebFetch',
  ]),
  project_setup: new Set([
    'create_novel', 'list_novels', 'list_staging_projects', 'get_staging_project',
    'read_skill', 'list_skills', 'read_skill_content', 'get_system_time', 'WebSearch', 'WebFetch',
  ]),
  general: new Set([
    'list_characters', 'read_character_context',
    'list_chapters', 'list_chapter_displays', 'read_outline', 'read_outline_nodes', 'read_chapter', 'read_chapter_summary',
    'query_world', 'query_timeline', 'read_style_memory', 'read_skill', 'list_skills', 'read_skill_content',
    'search_index', 'search_novel', 'retrieve_context',
    'get_full_editor_content',
    'list_novels',
    'spawn_subagent', 'get_system_time', 'WebSearch', 'WebFetch',
  ]),
};

function applyToolPolicy(tools, policy) {
  const list = Array.isArray(tools) ? tools : [];
  const policyId = policy?.id || 'general';
  const policyLabels = Array.isArray(policy?.labels) && policy.labels.length ? policy.labels : [policyId];
  const allow = new Set();
  for (const label of policyLabels) {
    for (const name of TOOL_POLICY_ALLOWLISTS[label] || TOOL_POLICY_ALLOWLISTS.general) allow.add(name);
  }
  const filtered = list.filter((tool) => allow.has(tool?.name));
  return {
    tools: filtered,
    summary: {
      id: policyId,
      labels: policyLabels,
      operation: policy?.operation || 'read',
      risk: policy?.risk || 'low',
      phaseHint: policy?.phaseHint || '',
      reason: policy?.reason || '',
      beforeCount: list.length,
      afterCount: filtered.length,
      omittedToolNames: list.map((tool) => tool?.name).filter((name) => name && !allow.has(name)),
    },
  };
}

module.exports = {
  DEFAULT_TOOL_RESULT_CHAR_LIMIT,
  DEFAULT_ERROR_TOOL_RESULT_CHAR_LIMIT,
  DEFAULT_SKILL_BLOCK_CHAR_LIMIT,
  TRIM_NOTICE_PREFIX,
  safeString,
  estimateTokens,
  stableJson,
  toolCacheKey,
  isCacheableToolName,
  createToolResultCache,
  buildContextManifest,
  classifyChatToolPolicy,
  classifyCharacterContextPolicy,
  classifyRetrievalContextPolicy,
  applyToolPolicy,
  fitTextForModel,
  fitToolResultForModel,
  buildSystemWithSkillBlocks,
  assembleProviderContext,
};
