'use strict';

const { randomUUID } = require('node:crypto');
const mcpClient = require('../mcp/mcpClientStdio');
const subagentsStore = require('../store/subagents');
const workflowOrchestrator = require('./workflowOrchestrator');
const { getActiveNovelContext } = require('./activeNovelContext');
const { runSubagent } = require('./runSubagent');
const appConfig = require('../store/appConfig');
const chapterRoleplayService = require('./chapterRoleplayService');
const { splitIntoParagraphs } = require('./chapterCharacterReview');
const {
  formatReviewIssueLabel,
  getOpenReviewIssues,
  hasBlockingReviewIssues,
  isOpenReviewIssue,
  mergeReviewIssues,
  normalizeReviewIssues,
  reviewSourceLabel,
} = require('../../domain/chapterReview.cjs');

const MAX_AUTO_REVIEW_REVISIONS = 1;

function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('章节模型未返回内容');
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(raw);
  const body = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error('无法解析章节草稿 JSON');
  }
}

function extractFallbackTitle(text, fallbackTitle) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return fallbackTitle || '未命名章节';
  const heading = lines.find((line) => /^#+\s*/.test(line));
  if (heading) return heading.replace(/^#+\s*/, '').trim() || fallbackTitle || '未命名章节';
  return lines[0].slice(0, 30) || fallbackTitle || '未命名章节';
}

function buildDraftSystemPrompt(basePrompt) {
  return [
    String(basePrompt || '').trim(),
    '',
    '## Drafting Override',
    '- 当前任务只允许生成章节草稿，严禁调用 write_chapter、append_timeline、update_timeline 或任何保存动作。',
    '- 你必须只输出一个 JSON 对象：{"title":"章节标题","summary":"一句话摘要","text":"完整章节正文","eventLedger":{"events":[{"order":1,"when":"时间","where":"地点","participants":["角色"],"action":"事件动作","infoKnownBy":["知情者"],"communication":"信息传播/通信，可为空","uncertainty":"不确定点，可为空"}]}}。',
    '- eventLedger 只是审查辅助账本，不是正文；不得把 JSON、账本标题或说明写进 text。',
    '- 先保证时间线、人设、因果链自洽，再给出正文。',
    '- 当正文为简体中文小说语境时，标点符号必须使用全角中文标点（，。！？：；、“”‘’（）《》——），不要使用半角英文标点。',
  ].join('\n');
}

function normalizeEventLedger(value) {
  const events = Array.isArray(value?.events) ? value.events : [];
  return {
    events: events.map((event, index) => ({
      order: Number.isFinite(Number(event?.order)) ? Number(event.order) : index + 1,
      when: String(event?.when || '').trim(),
      where: String(event?.where || '').trim(),
      participants: Array.isArray(event?.participants)
        ? event.participants.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      action: String(event?.action || event?.description || '').trim(),
      infoKnownBy: Array.isArray(event?.infoKnownBy)
        ? event.infoKnownBy.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      communication: event?.communication == null ? '' : String(event.communication).trim(),
      uncertainty: event?.uncertainty == null ? '' : String(event.uncertainty).trim(),
    })).filter((event) => event.when || event.where || event.participants.length || event.action || event.communication || event.uncertainty),
  };
}

function createDraftMcpClient() {
  const blocked = new Set(['write_chapter', 'append_timeline', 'update_timeline', 'append_summary', 'grant_asset', 'revoke_asset', 'apply_asset_patch', 'update_character', 'create_character', 'update_world']);
  return {
    async listTools() {
      const tools = await mcpClient.listTools();
      return (tools || []).filter((tool) => !blocked.has(tool?.name));
    },
    async callTool(payload) {
      if (blocked.has(payload?.name)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `${payload.name} 在章节草拟阶段已禁用，请只输出 JSON 草稿。` }],
        };
      }
      return mcpClient.callTool(payload);
    },
  };
}

function parseToolText(result) {
  return Array.isArray(result?.content)
    ? result.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
    : (typeof result === 'string' ? result : JSON.stringify(result || {}));
}

function parseTargetChapterIndex(chapterName) {
  const match = String(chapterName || '').match(/chapter-(\d+)/i);
  return match ? Number(match[1]) : null;
}

function matchesTargetChapterNode(node, targetChapter) {
  const parsedChapterIndex = parseTargetChapterIndex(targetChapter?.name);
  if (node?.chapterRef && node.chapterRef === targetChapter.name) return true;
  if (node?.writtenChapterRef && node.writtenChapterRef === targetChapter.name) return true;
  if (parsedChapterIndex != null && Number(node?.chapterIndex) === parsedChapterIndex) return true;
  return false;
}

function normalizeSceneCharacterContext(value) {
  const characters = Array.isArray(value?.characters) ? value.characters : [];
  return {
    nodeId: value?.nodeId || '',
    title: value?.title || '',
    setting: value?.setting || '',
    location: value?.location || '',
    pov: value?.pov || '',
    outfit: value?.outfit || '',
    characters: characters.map((character) => ({
      contextMode: character?.contextMode || '',
      sourceRef: character?.sourceRef || '',
      id: character?.id || '',
      name: character?.name || '',
      role: character?.role || '',
      personality: character?.personality || '',
      appearance: character?.appearance || '',
      speechStyle: character?.speechStyle || '',
      currentOutfit: character?.currentOutfit || '',
      background: character?.background || undefined,
      skins: Array.isArray(character?.skins) ? character.skins : undefined,
      quotes: character?.quotes || undefined,
    })).filter((character) => character.id || character.name),
  };
}

async function buildSceneCharacterContexts(matchingNodes) {
  const contexts = [];
  for (const node of (Array.isArray(matchingNodes) ? matchingNodes : []).slice(0, 6)) {
    if (!node?.id) continue;
    try {
      const result = await mcpClient.callTool({
        name: 'assemble_scene_context',
        arguments: { nodeId: node.id },
        autoConfirm: true,
      });
      const parsed = parseJsonFromText(parseToolText(result));
      const normalized = normalizeSceneCharacterContext(parsed);
      if (normalized.characters.length) contexts.push(normalized);
    } catch {
      // Scene character context is a low-noise optimization; draft can continue
      // with outline/timeline context when a node or character card is missing.
    }
  }
  return contexts;
}

async function buildSceneCharacterContextForTargetChapter(targetChapter) {
  try {
    const outlineResult = await mcpClient.callTool({ name: 'read_outline_nodes', arguments: {}, autoConfirm: true });
    const outlinePayload = parseJsonFromText(parseToolText(outlineResult));
    const nodes = Array.isArray(outlinePayload?.nodes) ? outlinePayload.nodes : [];
    const matchingNodes = nodes
      .filter((node) => matchesTargetChapterNode(node, targetChapter))
      .slice(0, 8)
      .map((node) => ({
        id: node.id,
        title: node.title || '',
        summary: node.summary || '',
        characters: Array.isArray(node.characters) ? node.characters : [],
        location: node.location || '',
        setting: node.setting || '',
        pov: node.pov || '',
        chapterIndex: node.chapterIndex ?? null,
      }));
    if (matchingNodes.length) {
      const sceneCharacterContexts = await buildSceneCharacterContexts(matchingNodes);
      return {
        outlineNodes: matchingNodes,
        sceneCharacterContexts,
      };
    }
  } catch { /* scene character context is an optimization, not a blocker */ }
  return null;
}

function buildRetrievalQueryForTargetChapter(targetChapter, userText, context = {}) {
  const outlineBits = Array.isArray(context.outlineNodes)
    ? context.outlineNodes.flatMap((node) => [
      node?.title,
      node?.summary,
      node?.location,
      node?.setting,
      ...(Array.isArray(node?.characters) ? node.characters : []),
    ])
    : [];
  const sceneBits = Array.isArray(context.sceneCharacterContexts)
    ? context.sceneCharacterContexts.flatMap((scene) => [
      scene?.title,
      scene?.location,
      scene?.setting,
      scene?.pov,
      ...(Array.isArray(scene?.characters) ? scene.characters.flatMap((character) => [
        character?.name,
        character?.role,
        character?.personality,
      ]) : []),
    ])
    : [];
  return [
    targetChapter?.displayName,
    targetChapter?.titleHint,
    targetChapter?.name,
    userText,
    ...outlineBits,
    ...sceneBits,
  ].map((item) => String(item || '').trim()).filter(Boolean).join('\n');
}

async function buildRetrievedContextForTargetChapter(targetChapter, userText, context = {}) {
  const query = buildRetrievalQueryForTargetChapter(targetChapter, userText, context);
  if (!query.trim()) return null;
  try {
    const result = await mcpClient.callTool({
      name: 'retrieve_context',
      arguments: {
        query,
        focus: userText || targetChapter?.displayName || targetChapter?.name || '',
        chapterName: targetChapter?.name || '',
        maxItems: 12,
        maxChars: 10000,
      },
      autoConfirm: true,
    });
    const payload = parseJsonFromText(parseToolText(result));
    if (!payload?.contextText && !Array.isArray(payload?.items)) return null;
    return {
      query: payload.query || query,
      resultCount: Number(payload.resultCount) || 0,
      contextText: payload.contextText || '',
      items: Array.isArray(payload.items) ? payload.items : [],
      wasTrimmed: !!payload.wasTrimmed,
    };
  } catch {
    // Retrieval context is helpful but must not block drafting.
    return null;
  }
}

async function buildCompactWritingContext(targetChapter, userText = '') {
  const context = {};
  const sceneContext = await buildSceneCharacterContextForTargetChapter(targetChapter);
  if (sceneContext?.outlineNodes?.length) context.outlineNodes = sceneContext.outlineNodes;
  if (sceneContext?.sceneCharacterContexts?.length) context.sceneCharacterContexts = sceneContext.sceneCharacterContexts;

  try {
    const timelineResult = await mcpClient.callTool({ name: 'query_timeline', arguments: {}, autoConfirm: true });
    const timelinePayload = parseJsonFromText(parseToolText(timelineResult));
    const events = Array.isArray(timelinePayload?.events) ? timelinePayload.events : [];
    const targetIndex = parseTargetChapterIndex(targetChapter?.name);
    const relevantEvents = events
      .filter((event) => {
        if (!event?.chapterRef) return false;
        const eventIndex = parseTargetChapterIndex(event.chapterRef);
        if (targetIndex == null || eventIndex == null) return event.chapterRef === targetChapter.name;
        return eventIndex >= targetIndex - 2 && eventIndex <= targetIndex + 1;
      })
      .slice(-12)
      .map((event) => ({
        chapterRef: event.chapterRef,
        when: event.when || '',
        where: event.where || '',
        participants: Array.isArray(event.participants) ? event.participants : [],
        description: event.description || '',
      }));
    if (relevantEvents.length) context.nearbyTimeline = relevantEvents;
  } catch { /* compact context is an optimization, not a blocker */ }

  const retrievedContext = await buildRetrievedContextForTargetChapter(targetChapter, userText, context);
  if (retrievedContext?.contextText || retrievedContext?.items?.length) {
    context.retrievedContext = retrievedContext;
  }

  return Object.keys(context).length ? context : null;
}

function buildDraftInput({ mode, userText, pendingChapterDraft, targetChapter, editorContext, compactContext, roleplayPlan, profileWarnings }) {
  const lines = [
    `模式：${mode === 'revise' ? '已有章节草稿修订' : '新章节草稿生成'}`,
    `目标文件：${targetChapter.name}`,
    `显示名：${targetChapter.displayName}`,
    `建议标题：${targetChapter.titleHint || targetChapter.displayName}`,
    '要求：只生成章节草稿，不要保存。',
  ];
  if (editorContext?.type === 'chapter' && editorContext?.title) {
    lines.push(`当前编辑章节：${editorContext.title}`);
  }
  if (editorContext?.selectedText) {
    lines.push('', '当前选中文本：', editorContext.selectedText);
    lines.push('说明：这次修订必须围绕这段已划选正文展开，不要跳到别的章节，也不要直接落盘。');
  }
  if (compactContext) {
    lines.push('', '系统预装的紧凑写作上下文（优先使用，避免重复查询无关资料）：');
    const { sceneCharacterContexts, retrievedContext, ...compactWithoutSceneCharacters } = compactContext;
    lines.push(JSON.stringify(compactWithoutSceneCharacters, null, 2));
    if (Array.isArray(compactContext.sceneCharacterContexts) && compactContext.sceneCharacterContexts.length) {
      lines.push('', '场景角色上下文（系统已按大纲节点自动装配；请优先使用，不要重复读取完整角色卡）：');
      lines.push(JSON.stringify(compactContext.sceneCharacterContexts, null, 2));
    }
    if (compactContext.retrievedContext?.contextText) {
      lines.push('', '相关设定检索上下文（系统已按当前章/用户需求检索；优先用作世界观、人设、地点和时间线依据）：');
      lines.push(compactContext.retrievedContext.contextText);
    }
  }
  if (roleplayPlan) {
    lines.push('', '角色驱动写作计划（只采用 director approved beats，不要直接照搬 actor 原始提案）：');
    lines.push(JSON.stringify(roleplayPlan, null, 2));
    lines.push(
      '角色驱动约束：writer 只可润色、连缀、补足 approvedBeats 的叙事过渡；不得新增改变大纲结果的重大动机、行动或情报公开。'
    );
  }
  if (Array.isArray(profileWarnings) && profileWarnings.length) {
    lines.push('', '角色资料不足警告（用户已选择忽略继续；正文应采用保守写法，避免强行写死缺失信息）：');
    lines.push(JSON.stringify(profileWarnings, null, 2));
  }
  lines.push(
    '',
    '如果用户给的是剧情方向、人物关系推进、时空/因果约束或桥段要求，你要先产出一版完整修订草稿，再交给审查流程，不要直接做字面替换。',
    '',
    '用户需求：',
    userText,
  );
  if (mode === 'revise' && pendingChapterDraft?.text) {
    lines.push('', '当前草稿：', pendingChapterDraft.text);
  }
  return lines.join('\n');
}

function formatProfileGateText(profileGate) {
  const missing = Array.isArray(profileGate?.missingCharacters) ? profileGate.missingCharacters : [];
  const lines = [
    '角色驱动写作已暂停：当前出场角色资料不足。',
    '',
    '为了让 actor subagent 能稳定代入角色，需要先处理这些缺口：',
  ];
  if (!missing.length) {
    lines.push('- 未检测到可用的出场角色资料。');
  } else {
    for (const item of missing) {
      const fields = [
        ...(Array.isArray(item.missingFields) ? item.missingFields.map((field) => `${field} 缺失`) : []),
        ...(Array.isArray(item.weakFields) ? item.weakFields.map((field) => `${field} 过弱`) : []),
      ];
      lines.push(`- ${item.name || item.id}：${fields.join('、') || '资料不足'}`);
    }
  }
  lines.push(
    '',
    '你可以选择：',
    '1. 回复“自动补全角色资料”，我会只按当前场景生成可审阅 patch，不会直接写入。',
    '2. 回复“忽略角色资料不足并继续写”，我会带着警告进入保守的角色驱动写作。'
  );
  return lines.join('\n');
}

function normalizeDraft(outputText, targetChapter) {
  const raw = String(outputText || '').trim();
  if (!raw) throw new Error('章节草稿为空');
  let parsed = null;
  try {
    parsed = parseJsonFromText(raw);
  } catch {
    parsed = null;
  }
  const text = String(parsed?.text || raw).trim();
  if (!text) throw new Error('章节草稿缺少正文');
  return {
    name: targetChapter.name,
    displayName: targetChapter.displayName,
    title: String(parsed?.title || extractFallbackTitle(text, targetChapter.titleHint)).trim() || targetChapter.displayName,
    summary: String(parsed?.summary || '').trim(),
    text,
    eventLedger: normalizeEventLedger(parsed?.eventLedger || parsed?.eventsLedger || parsed?.ledger || {}),
  };
}

function normalizeIssues(list, sourceAgent) {
  return normalizeReviewIssues(
    (Array.isArray(list) ? list : []).map((issue, index) => ({
      ...issue,
      id: issue?.id || `${sourceAgent}-${index}-${randomUUID()}`,
      source: issue?.source || sourceAgent,
      sourceAgent,
      note: issue?.note || issue?.summary || issue?.detail || '',
    })),
    { source: sourceAgent, defaultSeverity: 'blocking' }
  );
}

function reviewLabel(sourceAgent) {
  return reviewSourceLabel(sourceAgent);
}

function trimErrorMessage(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .replace(/^Error:\s*/i, '')
    .trim()
    .slice(0, 120);
}

function buildReviewFailureIssue(sourceAgent, message) {
  return {
    id: `${sourceAgent}-review-incomplete-${randomUUID()}`,
    source: sourceAgent,
    sourceAgent,
    category: 'review_incomplete',
    severity: 'blocking',
    status: 'open',
    summary: `${reviewLabel(sourceAgent)}本轮未完成，请先重试后再确认写入。`,
    note: `${reviewLabel(sourceAgent)}本轮未完成，请先重试后再确认写入。`,
    detail: trimErrorMessage(message) || '调用失败',
    affectedOutlineNodeIds: [],
    paragraphIds: [],
    paragraphIndexes: [],
    reviewIncomplete: true,
  };
}

function buildReviewerSystemPrompt(basePrompt, sourceAgent) {
  const isTimeline = sourceAgent === 'timeline';
  const structureLine = isTimeline
    ? '结构：{ "issues": [ { "source": "timeline" 或 "event_ledger", "category": "mobility/information/event_ledger", "summary": "一句话", "detail": "可选", "evidence":"可选证据", "suggestedAction":"可选建议", "timelineKind": "mobility" 或 "information", "affectedOutlineNodeIds": [], "paragraphIds": ["可选：相关段落id"] } ] }'
    : '结构：{ "issues": [ { "source": "character_world", "category": "character/world/causality", "summary": "一句话问题", "detail": "可选细节", "evidence":"可选证据", "suggestedAction":"可选建议", "affectedOutlineNodeIds": [], "paragraphIds": ["可选：相关段落id"] } ] }';
  const focus = isTimeline
    ? [
        '- 当前任务是审查章节正文草稿，而不是大纲。',
        '- 重点检查：时间顺序、昼夜时段、人物移动距离、交通时间、消息传播先后、与既有 timeline/chapter 的冲突。',
        '- 输入若包含 eventLedger，它只代表 writer 的内部事件账本；审查以正文 text 为准，不得让账本覆盖正文。',
        '- 如果 eventLedger 与正文冲突或遗漏关键事件，请报告 source 为 event_ledger 的 issue；不要把 eventLedger 当作应同步的时间线。',
        '- 必要时使用 query_timeline、read_chapter、query_world 等工具交叉核对。',
      ]
    : [
        '- 当前任务是审查章节正文草稿，而不是大纲。',
        '- 重点检查：人物动机、关系、说话方式、既有状态、世界观硬设定是否冲突。',
        '- 必要时使用 list_characters、read_character、query_world、read_chapter 等工具交叉核对。',
      ];
  return [
    String(basePrompt || '').trim(),
    '',
    '## Chapter Review Override',
    ...focus,
    '- 只报告足以影响本章定稿的问题；没有问题就返回空 issues。',
    '- 若问题能定位到具体正文段落，请填写 paragraphIds；若跨段，请列出所有相关段落。',
    '- 只输出一个 JSON 对象，不要 Markdown 围栏。',
    structureLine,
  ].join('\n');
}

function buildReviewInput({ mode, userText, draft, retrievedContext }) {
  const paragraphs = splitIntoParagraphs(draft.text);
  return JSON.stringify({
    mode,
    userText,
    retrievedContext: retrievedContext || null,
    chapterDraft: {
      name: draft.name,
      displayName: draft.displayName,
      title: draft.title,
      summary: draft.summary,
      text: draft.text,
      eventLedger: draft.eventLedger || null,
    },
    eventLedger: draft.eventLedger || null,
    paragraphs: paragraphs.map((paragraph, index) => ({
      id: paragraph.id,
      index: paragraph.index,
      text: paragraph.text,
      prevParagraphId: index > 0 ? paragraphs[index - 1].id : null,
      prevText: index > 0 ? paragraphs[index - 1].text : '',
      nextParagraphId: index + 1 < paragraphs.length ? paragraphs[index + 1].id : null,
      nextText: index + 1 < paragraphs.length ? paragraphs[index + 1].text : '',
    })),
  }, null, 2);
}

function buildIssueRevisionInput({ mode, userText, draft, issues, revisionIndex }) {
  const issueLines = (Array.isArray(issues) ? issues : [])
    .filter((issue) => !issue.reviewIncomplete)
    .map((issue, index) => `${index + 1}. [${reviewLabel(issue.sourceAgent)}] ${issue.summary}${issue.detail ? `：${issue.detail}` : ''}`)
    .join('\n');
  const issueContext = buildIssueRevisionContext(draft, issues);
  return [
    `模式：${mode === 'revise' ? '已有章节草稿修订' : '新章节草稿生成'}`,
    `自动修订轮次：${revisionIndex}`,
    `目标文件：${draft.name}`,
    `显示名：${draft.displayName}`,
    '',
    '原始用户需求：',
    userText,
    '',
    '当前草稿：',
    draft.text,
    '',
    '审查发现的明确问题：',
    issueLines || '无',
    '',
    '审查定位上下文：',
    issueContext || '审查未给出段落定位；请先保持全章事实链稳定，只做解决硬伤所需的最小修订。',
    '',
    '修订要求：',
    '- 只针对上述人设/逻辑/时空硬伤做必要修订。',
    '- 保留原有章节标题、核心剧情、人物关系和叙事视角。',
    '- 优先修改审查定位段落及其相邻衔接；不要顺手重写无关段落。',
    '- 不要新增无关支线，不要为了修订反复查询完整人设卡；只有输入信息不足以修复硬伤时，才按需使用精简上下文工具。',
    '- 输出仍然只允许 JSON：{"title":"章节标题","summary":"一句话摘要","text":"完整章节正文"}。',
  ].join('\n');
}

function buildIssueRevisionContext(draft, issues) {
  const paragraphs = splitIntoParagraphs(draft.text);
  if (!paragraphs.length) return '';
  const byId = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const lines = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue?.reviewIncomplete) continue;
    const ids = Array.isArray(issue?.paragraphIds)
      ? issue.paragraphIds.filter((paragraphId) => byId.has(paragraphId))
      : [];
    if (!ids.length) continue;
    lines.push(`- [${reviewLabel(issue.sourceAgent)}] ${issue.summary}`);
    for (const paragraphId of ids.slice(0, 4)) {
      const paragraph = byId.get(paragraphId);
      if (!paragraph) continue;
      const prev = paragraphs[paragraph.index - 1]?.text || '';
      const next = paragraphs[paragraph.index + 1]?.text || '';
      if (prev) lines.push(`  上一段：${compactDraftExcerpt(prev)}`);
      lines.push(`  第${paragraph.index + 1}段：${compactDraftExcerpt(paragraph.text)}`);
      if (next) lines.push(`  下一段：${compactDraftExcerpt(next)}`);
    }
  }
  return lines.join('\n');
}

function compactDraftExcerpt(text, limit = 160) {
  const compacted = String(text || '').replace(/\s+/g, ' ').trim();
  return compacted.length > limit ? `${compacted.slice(0, limit)}...` : compacted;
}

function hasActionableReviewIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return list.some((issue) => !issue.reviewIncomplete && isOpenReviewIssue(issue));
}

async function runWriterDraft(input, draftSystemPrompt, abortSignal) {
  try {
    return ((await runSubagent({
      subagentId: 'sa-writer',
      input,
      abortSignal,
      userLang: 'zh-CN',
      mcpClient: createDraftMcpClient(),
      systemPromptOverride: draftSystemPrompt,
    })).output || '');
  } catch (err) {
    const message = err?.message || String(err);
    if (!/没有可用的 AI 服务商|API Key 未设置|No provider configured|Provider API key is missing/.test(message)) {
      throw err;
    }
    return runDraftViaWorkflow(input, draftSystemPrompt, abortSignal);
  }
}

async function runDraftViaWorkflow(input, draftSystemPrompt, abortSignal) {
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId: 'sa-writer',
    systemPromptOverride: draftSystemPrompt,
    input,
    userLang: 'zh-CN',
    novelContext: getActiveNovelContext(mcpClient),
    abortSignal,
  });
  return result.output || '';
}

async function runReviewer(subagentId, input, sourceAgent, systemPromptOverride, abortSignal) {
  const result = await runSubagent({
    subagentId,
    input,
    abortSignal,
    userLang: 'zh-CN',
    mcpClient,
    systemPromptOverride,
  });
  const parsed = parseJsonFromText(result.output || '');
  return normalizeIssues(parsed?.issues, sourceAgent);
}

async function runReviewerViaWorkflow(subagentId, input, sourceAgent, systemPromptOverride, abortSignal) {
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId,
    input,
    userLang: 'zh-CN',
    systemPromptOverride,
    novelContext: getActiveNovelContext(mcpClient),
    abortSignal,
  });
  const parsed = parseJsonFromText(result.output || '');
  return normalizeIssues(parsed?.issues, sourceAgent);
}

async function runReviewerWithFallback(subagentId, input, sourceAgent, systemPromptOverride, abortSignal) {
  try {
    return await runReviewer(subagentId, input, sourceAgent, systemPromptOverride, abortSignal);
  } catch (primaryErr) {
    try {
      return await runReviewerViaWorkflow(subagentId, input, sourceAgent, systemPromptOverride, abortSignal);
    } catch (fallbackErr) {
      const message = fallbackErr?.message || primaryErr?.message || String(fallbackErr || primaryErr);
      return [buildReviewFailureIssue(sourceAgent, message)];
    }
  }
}

function formatIssues(issues) {
  const allIssues = Array.isArray(issues) ? issues : [];
  const incomplete = allIssues.filter((issue) => issue.reviewIncomplete && isOpenReviewIssue(issue));
  const blocking = allIssues.filter((issue) => !issue.reviewIncomplete && isOpenReviewIssue(issue));

  if (!incomplete.length && !blocking.length) {
    return '已完成人设、时空、文风、AI 味和段落功能审查，当前没有 open 阻塞问题。';
  }

  const lines = [];
  if (incomplete.length) {
    lines.push('以下审查尚未完成，本轮草稿不能视为已完整核对：');
    incomplete.forEach((issue, index) => {
      lines.push(`${index + 1}. [${reviewLabel(issue.sourceAgent)}] ${issue.summary}${issue.detail ? `（${issue.detail}）` : ''}`);
    });
  }
  if (blocking.length) {
    if (lines.length) lines.push('');
    lines.push('发现以下 open 问题；在修复、忽略或标记通过前不能确认写入：');
    blocking.forEach((issue, index) => {
      lines.push(`${index + 1}. ${formatReviewIssueLabel(issue)} ${issue.summary || issue.note}${issue.detail ? `：${issue.detail}` : ''}`);
      if (issue.excerpt) lines.push(`   摘录：${issue.excerpt}`);
      if (issue.suggestedAction) lines.push(`   建议：${issue.suggestedAction}`);
    });
  }
  return lines.join('\n');
}

function normalizeAdvisoryAnnotations(paragraphs, rawAnnotations, sourceAgent) {
  const paragraphMap = new Map((Array.isArray(paragraphs) ? paragraphs : []).map((paragraph) => [paragraph.id, paragraph]));
  const validIds = new Set(paragraphMap.keys());
  const out = [];
  const seen = new Set();
  for (const annotation of Array.isArray(rawAnnotations) ? rawAnnotations : []) {
    const paragraphIds = Array.isArray(annotation?.paragraphIds)
      ? annotation.paragraphIds.map((item) => String(item || '').trim()).filter((item) => validIds.has(item))
      : [];
    const fallbackId = String(annotation?.paragraphId || '').trim();
    const targets = paragraphIds.length > 0
      ? paragraphIds
      : validIds.has(fallbackId)
        ? [fallbackId]
        : [];
    if (!targets.length) continue;
    const note = String(annotation?.note || annotation?.reason || '').replace(/\s+/g, ' ').trim();
    if (!note) continue;
    const key = `${sourceAgent}::${targets.join(',')}::${note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const firstParagraph = paragraphMap.get(targets[0]);
    out.push({
      id: `${sourceAgent}-${out.length}-${randomUUID()}`,
      source: sourceAgent,
      sourceAgent,
      category: annotation?.kind ? String(annotation.kind) : sourceAgent,
      severity: 'blocking',
      status: 'open',
      summary: note,
      note,
      detail: annotation?.kind ? String(annotation.kind) : undefined,
      paragraphIds: targets,
      paragraphIndexes: targets
        .map((paragraphId) => paragraphMap.get(paragraphId)?.index)
        .filter((index) => Number.isInteger(index)),
      paragraphIndex: Number.isInteger(firstParagraph?.index) ? firstParagraph.index : -1,
      suggestedAction: annotation?.suggestedAction ? String(annotation.suggestedAction) : '',
      excerpt: compactDraftExcerpt(firstParagraph?.text || '', 90),
      reviewIncomplete: annotation?.kind === 'review_incomplete',
    });
  }
  return normalizeReviewIssues(out, { paragraphs, source: sourceAgent, defaultSeverity: 'blocking' })
    .sort((left, right) => (left.paragraphIndex ?? left.paragraphIndexes?.[0] ?? 9999) - (right.paragraphIndex ?? right.paragraphIndexes?.[0] ?? 9999));
}

function mergeAdvisoryIssues(primary, fallback) {
  return mergeReviewIssues(primary, fallback)
    .sort((left, right) => (left.paragraphIndex ?? left.paragraphIndexes?.[0] ?? 9999) - (right.paragraphIndex ?? right.paragraphIndexes?.[0] ?? 9999));
}

async function loadQualityReviewHelpers() {
  const mod = await import('../../services/qualityReview.mjs');
  return {
    buildQualityReviewPayload: mod.buildQualityReviewPayload,
    buildParagraphFunctionReviewPayload: mod.buildParagraphFunctionReviewPayload,
    detectCrossParagraphQualityAnnotations: mod.detectCrossParagraphQualityAnnotations,
    detectParagraphFunctionAnnotations: mod.detectParagraphFunctionAnnotations,
  };
}

async function runAdvisoryReviewer({ subagentId, input, sourceAgent, abortSignal }) {
  try {
    const result = await runSubagent({
      subagentId,
      input,
      abortSignal,
      userLang: 'zh-CN',
      mcpClient,
    });
    const parsed = parseJsonFromText(result.output || '{}');
    return Array.isArray(parsed?.annotations) ? parsed.annotations : [];
  } catch (primaryErr) {
    try {
      const result = await workflowOrchestrator.runWorkflow({
        mode: 'subagent',
        subagentId,
        input,
        userLang: 'zh-CN',
        abortSignal,
        novelContext: getActiveNovelContext(mcpClient),
      });
      const parsed = parseJsonFromText(result.output || '{}');
      return Array.isArray(parsed?.annotations) ? parsed.annotations : [];
    } catch (fallbackErr) {
      return [{
        paragraphId: 'p-0',
        kind: 'review_incomplete',
        note: `${reviewLabel(sourceAgent)}预审本轮未完成：${trimErrorMessage(fallbackErr?.message || primaryErr?.message || String(fallbackErr || primaryErr))}`,
      }];
    }
  }
}

async function readStyleMemoryForAdvisory() {
  try {
    const result = await mcpClient.callTool({ name: 'read_style_memory', arguments: {}, autoConfirm: true });
    return Array.isArray(result?.content)
      ? result.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n').trim()
      : String(result || '').trim();
  } catch {
    return '';
  }
}

async function runDraftAdvisoryReviews(draft, abortSignal, onProgress) {
  const paragraphs = splitIntoParagraphs(draft.text);
  if (!paragraphs.length) return [];

  const {
    buildQualityReviewPayload,
    buildParagraphFunctionReviewPayload,
    detectCrossParagraphQualityAnnotations,
    detectParagraphFunctionAnnotations,
  } = await loadQualityReviewHelpers();
  const reviewPayload = buildQualityReviewPayload(paragraphs);
  const deterministic = normalizeAdvisoryAnnotations(
    paragraphs,
    detectCrossParagraphQualityAnnotations(paragraphs),
    'prose_quality'
  );
  const paragraphFunctionDeterministic = normalizeAdvisoryAnnotations(
    paragraphs,
    detectParagraphFunctionAnnotations(paragraphs).map((annotation) => ({
      ...annotation,
      suggestedAction: 'merge_paragraphs',
    })),
    'paragraph_function'
  );

  emitProgress(onProgress, '写作链：正在做文风、AI 味和段落功能审查。', { stage: 'chapter_advisory_review' });
  const proseRaw = await runAdvisoryReviewer({
    subagentId: 'sa-prose-quality',
    input: JSON.stringify(reviewPayload),
    sourceAgent: 'prose_quality',
    abortSignal,
  });
  const proseIssues = normalizeAdvisoryAnnotations(paragraphs, proseRaw, 'prose_quality');

  const styleMemory = await readStyleMemoryForAdvisory();
  let styleIssues = [];
  if (styleMemory) {
    const styleRaw = await runAdvisoryReviewer({
      subagentId: 'sa-style-checker',
      input: JSON.stringify({ styleMemory, paragraphs: reviewPayload.paragraphs }),
      sourceAgent: 'style',
      abortSignal,
    });
    styleIssues = normalizeAdvisoryAnnotations(paragraphs, styleRaw, 'style');
  }

  let paragraphFunctionIssues = [];
  const paragraphFunctionPayload = buildParagraphFunctionReviewPayload(paragraphs, '审查章节草稿的一句一段、机械拆段和自然段功能问题。');
  if (Array.isArray(paragraphFunctionPayload.candidates) && paragraphFunctionPayload.candidates.length) {
    const paragraphFunctionRaw = await runAdvisoryReviewer({
      subagentId: 'sa-paragraph-function-reviewer',
      input: JSON.stringify(paragraphFunctionPayload),
      sourceAgent: 'paragraph_function',
      abortSignal,
    });
    paragraphFunctionIssues = normalizeAdvisoryAnnotations(paragraphs, paragraphFunctionRaw, 'paragraph_function');
  }

  return mergeAdvisoryIssues(
    [...proseIssues, ...styleIssues, ...paragraphFunctionIssues],
    [...deterministic, ...paragraphFunctionDeterministic]
  );
}

function formatAdvisoryIssues(advisoryIssues) {
  const list = Array.isArray(advisoryIssues) ? advisoryIssues : [];
  if (!list.length) {
    return '文风、AI 味和段落功能审查未发现 open 问题。';
  }
  const lines = [`发现 ${getOpenReviewIssues(list).length || list.length} 处文风/行文/段落功能 open 问题；这些问题同样会阻塞写入：`];
  for (const issue of list.slice(0, 8)) {
    const indexText = Array.isArray(issue.paragraphIndexes) && issue.paragraphIndexes.length
      ? issue.paragraphIndexes.map((index) => `第${index + 1}段`).join(' / ')
      : Number.isInteger(issue.paragraphIndex) && issue.paragraphIndex >= 0
        ? `第${issue.paragraphIndex + 1}段`
        : '段落未定位';
    const label = reviewLabel(issue.sourceAgent);
    lines.push(`- [${label}] ${indexText}：${issue.summary || issue.note}`);
    if (issue.excerpt) lines.push(`  摘录：${issue.excerpt}`);
  }
  if (list.length > 8) lines.push(`- 另有 ${list.length - 8} 处已折叠。`);
  lines.push('可回复“预览修复第 N 条”“忽略第 N 条”或“全部标记通过”；局部修复会先给预览，不会直接覆盖。');
  return lines.join('\n');
}

function buildAssistantText({ mode, draft, blockingIssues, advisoryIssues, reviseFromSelection }) {
  const intro = mode === 'revise'
    ? (reviseFromSelection
        ? '我已按专用写作流程，先围绕你当前划选的正文位置做了一版修订草稿，先不写入项目。'
        : '我已按专用写作流程基于当前草稿重做了一版，先不写入项目。')
    : '我已按专用写作流程先产出一版章节草稿，先不写入项目。';
  const allIssues = mergeReviewIssues(blockingIssues, advisoryIssues);
  const hasIncompleteReview = allIssues.some((issue) => issue.reviewIncomplete && isOpenReviewIssue(issue));
  const hasOpenIssues = hasBlockingReviewIssues(allIssues);
  return [
    intro,
    '',
    '我现在先停在章节审阅阶段，不直接落盘。',
    '',
    `## 章节草稿：${draft.displayName}${draft.title ? `《${draft.title}》` : ''}`,
    '',
    draft.text,
    '',
    '## 审查结果',
    '',
    formatIssues(allIssues),
    '',
    '## 文风 / 行文预审',
    '',
    formatAdvisoryIssues(advisoryIssues),
    '',
    '## 请你决定下一步',
    '',
    hasIncompleteReview
      ? '如果你要我继续，请回复“重新审查这一章”或直接告诉我还要调整哪一段、哪条因果链。'
      : hasOpenIssues
        ? '可以回复“预览修复第 N 条”“修复全部可自动修复项”“忽略第 N 条”或“全部标记通过”。'
        : '如果你要继续修改，直接告诉我想调整的段落节奏、人物表现或时间线细节。',
    hasIncompleteReview
      ? '等审查补齐后，我再让你确认是否写入项目。'
      : hasOpenIssues
        ? '所有 open 问题关闭后，再回复“确认写入这一章”或“保存这个章节”。'
        : '如果你认可这版正文，再回复“确认写入这一章”或“保存这个章节”。',
  ].join('\n');
}

async function reviewExistingChapterDraft({ mode = 'review', userText = '', draft, retrievedContext, abortSignal, onProgress }) {
  if (!draft?.text) return { issues: [], blockingIssues: [], advisoryIssues: [] };
  const characterReviewer = await subagentsStore.getSubagent('sa-character-reviewer');
  const timelineReviewer = await subagentsStore.getSubagent('sa-timeline-guardian');
  emitProgress(onProgress, '写作链：正在复审修订后的受影响章节草稿。', { stage: 'chapter_review_rerun' });
  const reviewInput = buildReviewInput({ mode, userText, draft, retrievedContext: retrievedContext || null });
  const [characterIssues, timelineIssues, advisoryIssues] = await Promise.all([
    runReviewerWithFallback(
      'sa-character-reviewer',
      reviewInput,
      'character_world',
      buildReviewerSystemPrompt(characterReviewer?.systemPrompt || '', 'character_world'),
      abortSignal
    ),
    runReviewerWithFallback(
      'sa-timeline-guardian',
      reviewInput,
      'timeline',
      buildReviewerSystemPrompt(timelineReviewer?.systemPrompt || '', 'timeline'),
      abortSignal
    ),
    runDraftAdvisoryReviews(draft, abortSignal, onProgress),
  ]);
  const blockingIssues = mergeReviewIssues(characterIssues, timelineIssues, advisoryIssues);
  return { issues: blockingIssues, blockingIssues, advisoryIssues };
}

async function suggestTargetChapter(pendingChapterDraft, editorContext) {
  if (pendingChapterDraft?.name) {
    return {
      name: pendingChapterDraft.name,
      displayName: pendingChapterDraft.displayName || pendingChapterDraft.name,
      titleHint: pendingChapterDraft.title || pendingChapterDraft.displayName || pendingChapterDraft.name,
    };
  }
  if (editorContext?.type === 'chapter' && editorContext?.title) {
    const title = String(editorContext.title).trim();
    return {
      name: title,
      displayName: title,
      titleHint: title,
    };
  }
  const suggested = await mcpClient.callTool({ name: 'suggest_next_chapter_name', arguments: {}, autoConfirm: true });
  const parsed = parseJsonFromText(Array.isArray(suggested?.content)
    ? suggested.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
    : JSON.stringify(suggested || {}));
  return {
    name: String(parsed?.fileName || 'chapter-draft.md'),
    displayName: String(parsed?.displayName || parsed?.fileName || '下一章'),
    titleHint: String(parsed?.displayName || parsed?.fileName || '下一章'),
  };
}

function emitProgress(onProgress, message, detail = {}) {
  if (typeof onProgress !== 'function') return;
  try { onProgress({ message, ...detail }); } catch { /* progress is best-effort */ }
}

async function generateChapterDraft({ mode, userText, pendingChapterDraft, editorContext, abortSignal, roleplayOptions, onProgress }) {
  emitProgress(onProgress, mode === 'revise' ? '写作链：正在定位当前草稿和修订目标。' : '写作链：正在定位下一章目标。', { stage: 'chapter_target' });
  const targetChapter = await suggestTargetChapter(pendingChapterDraft, editorContext);
  emitProgress(onProgress, `写作链：目标章节为 ${targetChapter.displayName || targetChapter.name}，开始读取大纲和时间线。`, { stage: 'chapter_context', chapterName: targetChapter.name });
  const compactContext = await buildCompactWritingContext(targetChapter, userText);
  const config = await appConfig.load();
  const writingConfig = config?.writing || appConfig.DEFAULT_WRITING_CONFIG;
  let roleplayPlan = null;
  let profileWarnings = [];
  if (writingConfig.mode === 'roleplay_driven') {
    emitProgress(onProgress, '写作链：角色驱动模式已启用，进入 actor/director 规划。', { stage: 'roleplay_start' });
    const roleplayResult = await chapterRoleplayService.buildRoleplayPlan({
      targetChapter,
      compactContext,
      interactionLevel: writingConfig.roleplayInteractionLevel || 'director_mediated',
      maxInteractionRounds: writingConfig.roleplayMaxInteractionRounds,
      ignoreProfileGate: !!roleplayOptions?.ignoreProfileGate,
      userText,
      abortSignal,
      onProgress,
    });
    if (roleplayResult?.status === 'profile_gate_blocked') {
      return {
        draft: null,
        blockingIssues: [],
        profileGateBlocked: true,
        profileGate: roleplayResult.profileGate,
        assistantText: formatProfileGateText(roleplayResult.profileGate),
      };
    }
    roleplayPlan = roleplayResult?.roleplayPlan || null;
    profileWarnings = Array.isArray(roleplayResult?.profileWarnings) ? roleplayResult.profileWarnings : [];
  }
  const input = buildDraftInput({
    mode,
    userText,
    pendingChapterDraft,
    targetChapter,
    editorContext,
    compactContext,
    roleplayPlan,
    profileWarnings,
  });
  const writer = await subagentsStore.getSubagent('sa-writer');
  const draftSystemPrompt = buildDraftSystemPrompt(writer?.systemPrompt || '');
  emitProgress(onProgress, '写作链：writer 正在把规划扩写成章节草稿。', { stage: 'writer_drafting', chapterName: targetChapter.name });
  let draftOutput = await runWriterDraft(input, draftSystemPrompt, abortSignal);

  let draft = normalizeDraft(draftOutput, targetChapter);
  const characterReviewer = await subagentsStore.getSubagent('sa-character-reviewer');
  const timelineReviewer = await subagentsStore.getSubagent('sa-timeline-guardian');
  let blockingIssues = [];
  for (let revisionIndex = 0; revisionIndex <= MAX_AUTO_REVIEW_REVISIONS; revisionIndex += 1) {
    emitProgress(onProgress, `写作链：第 ${revisionIndex + 1} 轮人设/时空审查正在运行。`, {
      stage: 'chapter_review',
      revisionIndex,
    });
    const reviewInput = buildReviewInput({ mode, userText, draft, retrievedContext: compactContext?.retrievedContext || null });
    const [characterIssues, timelineIssues] = await Promise.all([
      runReviewerWithFallback(
        'sa-character-reviewer',
        reviewInput,
        'character_world',
        buildReviewerSystemPrompt(characterReviewer?.systemPrompt || '', 'character_world'),
        abortSignal
      ),
      runReviewerWithFallback(
        'sa-timeline-guardian',
        reviewInput,
        'timeline',
        buildReviewerSystemPrompt(timelineReviewer?.systemPrompt || '', 'timeline'),
        abortSignal
      ),
    ]);
    blockingIssues = [...characterIssues, ...timelineIssues];
    if (!hasActionableReviewIssues(blockingIssues) || revisionIndex >= MAX_AUTO_REVIEW_REVISIONS) break;
    emitProgress(onProgress, '写作链：审查发现硬伤，writer 正在自动修订一轮。', {
      stage: 'writer_revision',
      revisionIndex: revisionIndex + 1,
    });
    const revisionInput = buildIssueRevisionInput({
      mode,
      userText,
      draft,
      issues: blockingIssues,
      revisionIndex: revisionIndex + 1,
    });
    draftOutput = await runWriterDraft(revisionInput, draftSystemPrompt, abortSignal);
    draft = normalizeDraft(draftOutput, targetChapter);
  }
  const advisoryIssues = await runDraftAdvisoryReviews(draft, abortSignal, onProgress);
  const reviseFromSelection = mode === 'revise'
    && !pendingChapterDraft?.text
    && !!String(editorContext?.selectedText || '').trim();

  return {
    draft: {
      ...draft,
      roleplayContext: compactContext || null,
      roleplayPlan: roleplayPlan || null,
      profileWarnings,
      advisoryIssues,
    },
    blockingIssues,
    advisoryIssues,
    issues: mergeReviewIssues(blockingIssues, advisoryIssues),
    assistantText: buildAssistantText({ mode, draft, blockingIssues, advisoryIssues, reviseFromSelection }),
  };
}

module.exports = {
  generateChapterDraft,
  reviewExistingChapterDraft,
  buildSceneCharacterContextForTargetChapter,
  _testBuildChapterAssistantText: buildAssistantText,
  _testBuildChapterReviewFailureIssue: buildReviewFailureIssue,
  _testBuildIssueRevisionInput: buildIssueRevisionInput,
  _testFormatProfileGateText: formatProfileGateText,
  _testBuildCompactWritingContext: buildCompactWritingContext,
  _testBuildDraftInput: buildDraftInput,
  _testBuildReviewInput: buildReviewInput,
  _testBuildRetrievalQueryForTargetChapter: buildRetrievalQueryForTargetChapter,
};
