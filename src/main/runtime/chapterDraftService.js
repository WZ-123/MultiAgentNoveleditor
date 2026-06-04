'use strict';

const { randomUUID } = require('node:crypto');
const mcpClient = require('../mcp/mcpClientStdio');
const subagentsStore = require('../store/subagents');
const workflowOrchestrator = require('./workflowOrchestrator');
const { getActiveNovelContext } = require('./activeNovelContext');
const { runSubagent } = require('./runSubagent');
const appConfig = require('../store/appConfig');
const chapterRoleplayService = require('./chapterRoleplayService');

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
    '- 你必须只输出一个 JSON 对象：{"title":"章节标题","summary":"一句话摘要","text":"完整章节正文"}。',
    '- 先保证时间线、人设、因果链自洽，再给出正文。',
    '- 当正文为简体中文小说语境时，标点符号必须使用全角中文标点（，。！？：；、“”‘’（）《》——），不要使用半角英文标点。',
  ].join('\n');
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

async function buildCompactWritingContext(targetChapter) {
  const context = {};
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
    if (matchingNodes.length) context.outlineNodes = matchingNodes;
  } catch { /* compact context is an optimization, not a blocker */ }

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
    lines.push(JSON.stringify(compactContext, null, 2));
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
  };
}

function normalizeIssues(list, sourceAgent) {
  return (Array.isArray(list) ? list : [])
    .filter((issue) => String(issue?.summary || '').trim())
    .map((issue, index) => ({
      id: issue.id || `${sourceAgent}-${index}-${randomUUID()}`,
      sourceAgent,
      summary: String(issue.summary),
      detail: issue.detail != null ? String(issue.detail) : undefined,
      timelineKind: issue.timelineKind != null ? String(issue.timelineKind) : undefined,
      affectedOutlineNodeIds: Array.isArray(issue.affectedOutlineNodeIds) ? issue.affectedOutlineNodeIds.map(String) : [],
      reviewIncomplete: !!issue.reviewIncomplete,
    }));
}

function reviewLabel(sourceAgent) {
  return sourceAgent === 'timeline' ? '时空校验' : '人设校验';
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
    sourceAgent,
    summary: `${reviewLabel(sourceAgent)}本轮未完成，请先重试后再确认写入。`,
    detail: trimErrorMessage(message) || '调用失败',
    affectedOutlineNodeIds: [],
    reviewIncomplete: true,
  };
}

function buildReviewerSystemPrompt(basePrompt, sourceAgent) {
  const isTimeline = sourceAgent === 'timeline';
  const structureLine = isTimeline
    ? '结构：{ "issues": [ { "summary": "一句话", "detail": "可选", "timelineKind": "mobility" 或 "information", "affectedOutlineNodeIds": [] } ] }'
    : '结构：{ "issues": [ { "summary": "一句话问题", "detail": "可选细节", "affectedOutlineNodeIds": [] } ] }';
  const focus = isTimeline
    ? [
        '- 当前任务是审查章节正文草稿，而不是大纲。',
        '- 重点检查：时间顺序、昼夜时段、人物移动距离、交通时间、消息传播先后、与既有 timeline/chapter 的冲突。',
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
    '- 只输出一个 JSON 对象，不要 Markdown 围栏。',
    structureLine,
  ].join('\n');
}

function buildReviewInput({ mode, userText, draft }) {
  return JSON.stringify({
    mode,
    userText,
    chapterDraft: {
      name: draft.name,
      displayName: draft.displayName,
      title: draft.title,
      summary: draft.summary,
      text: draft.text,
    },
  }, null, 2);
}

function buildIssueRevisionInput({ mode, userText, draft, issues, revisionIndex }) {
  const issueLines = (Array.isArray(issues) ? issues : [])
    .filter((issue) => !issue.reviewIncomplete)
    .map((issue, index) => `${index + 1}. [${reviewLabel(issue.sourceAgent)}] ${issue.summary}${issue.detail ? `：${issue.detail}` : ''}`)
    .join('\n');
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
    '修订要求：',
    '- 只针对上述人设/逻辑/时空硬伤做必要修订。',
    '- 保留原有章节标题、核心剧情、人物关系和叙事视角。',
    '- 不要新增无关支线，不要为了修订反复查询完整人设卡；只有输入信息不足以修复硬伤时，才按需使用精简上下文工具。',
    '- 输出仍然只允许 JSON：{"title":"章节标题","summary":"一句话摘要","text":"完整章节正文"}。',
  ].join('\n');
}

function hasActionableReviewIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return list.some((issue) => !issue.reviewIncomplete);
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
  const incomplete = allIssues.filter((issue) => issue.reviewIncomplete);
  const blocking = allIssues.filter((issue) => !issue.reviewIncomplete);

  if (!incomplete.length && !blocking.length) {
    return '已完成人设与时空合理性检查，当前没有发现明显阻塞问题。';
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
    lines.push('发现以下需要你决定是否调整的问题：');
    blocking.forEach((issue, index) => {
      lines.push(`${index + 1}. [${reviewLabel(issue.sourceAgent)}] ${issue.summary}${issue.detail ? `：${issue.detail}` : ''}`);
    });
  }
  return lines.join('\n');
}

function buildAssistantText({ mode, draft, blockingIssues, reviseFromSelection }) {
  const intro = mode === 'revise'
    ? (reviseFromSelection
        ? '我已按专用写作流程，先围绕你当前划选的正文位置做了一版修订草稿，先不写入项目。'
        : '我已按专用写作流程基于当前草稿重做了一版，先不写入项目。')
    : '我已按专用写作流程先产出一版章节草稿，先不写入项目。';
  const hasIncompleteReview = (blockingIssues || []).some((issue) => issue.reviewIncomplete);
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
    formatIssues(blockingIssues),
    '',
    '## 请你决定下一步',
    '',
    hasIncompleteReview
      ? '如果你要我继续，请回复“重新审查这一章”或直接告诉我还要调整哪一段、哪条因果链。'
      : '如果你要继续修改，直接告诉我想调整的段落节奏、人物表现或时间线细节。',
    hasIncompleteReview
      ? '等审查补齐后，我再让你确认是否写入项目。'
      : '如果你认可这版正文，再回复“确认写入这一章”或“保存这个章节”。',
  ].join('\n');
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

async function generateChapterDraft({ mode, userText, pendingChapterDraft, editorContext, abortSignal, roleplayOptions }) {
  const targetChapter = await suggestTargetChapter(pendingChapterDraft, editorContext);
  const compactContext = await buildCompactWritingContext(targetChapter);
  const config = await appConfig.load();
  const writingConfig = config?.writing || appConfig.DEFAULT_WRITING_CONFIG;
  let roleplayPlan = null;
  let profileWarnings = [];
  if (writingConfig.mode === 'roleplay_driven') {
    const roleplayResult = await chapterRoleplayService.buildRoleplayPlan({
      targetChapter,
      compactContext,
      interactionLevel: writingConfig.roleplayInteractionLevel || 'director_mediated',
      ignoreProfileGate: !!roleplayOptions?.ignoreProfileGate,
      userText,
      abortSignal,
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
  let draftOutput = await runWriterDraft(input, draftSystemPrompt, abortSignal);

  let draft = normalizeDraft(draftOutput, targetChapter);
  const characterReviewer = await subagentsStore.getSubagent('sa-character-reviewer');
  const timelineReviewer = await subagentsStore.getSubagent('sa-timeline-guardian');
  let blockingIssues = [];
  for (let revisionIndex = 0; revisionIndex <= MAX_AUTO_REVIEW_REVISIONS; revisionIndex += 1) {
    const reviewInput = buildReviewInput({ mode, userText, draft });
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
  const reviseFromSelection = mode === 'revise'
    && !pendingChapterDraft?.text
    && !!String(editorContext?.selectedText || '').trim();

  return {
    draft: {
      ...draft,
      roleplayContext: compactContext || null,
      roleplayPlan: roleplayPlan || null,
      profileWarnings,
    },
    blockingIssues,
    assistantText: buildAssistantText({ mode, draft, blockingIssues, reviseFromSelection }),
  };
}

module.exports = {
  generateChapterDraft,
  _testBuildChapterAssistantText: buildAssistantText,
  _testBuildChapterReviewFailureIssue: buildReviewFailureIssue,
  _testBuildIssueRevisionInput: buildIssueRevisionInput,
  _testFormatProfileGateText: formatProfileGateText,
};
