'use strict';

const { randomUUID } = require('node:crypto');
const mcpClient = require('../mcp/mcpClientStdio');
const subagentsStore = require('../store/subagents');
const workflowOrchestrator = require('./workflowOrchestrator');
const { runSubagent } = require('./runSubagent');

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
  ].join('\n');
}

function createDraftMcpClient() {
  const blocked = new Set(['write_chapter', 'append_timeline', 'update_timeline', 'append_summary', 'grant_asset', 'revoke_asset', 'update_character', 'create_character', 'update_world']);
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

function buildDraftInput({ mode, userText, pendingChapterDraft, targetChapter, editorContext }) {
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

async function runDraftViaWorkflow(input, draftSystemPrompt, abortSignal) {
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId: 'sa-writer',
    systemPromptOverride: draftSystemPrompt,
    input,
    userLang: 'zh-CN',
    novelContext: (() => {
      const ctx = mcpClient.getActiveNovelContext();
      return ctx?.id ? { novelId: ctx.id, novelDir: ctx.dir } : undefined;
    })(),
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

async function generateChapterDraft({ mode, userText, pendingChapterDraft, editorContext, abortSignal }) {
  const targetChapter = await suggestTargetChapter(pendingChapterDraft, editorContext);
  const input = buildDraftInput({ mode, userText, pendingChapterDraft, targetChapter, editorContext });
  const writer = await subagentsStore.getSubagent('sa-writer');
  const draftSystemPrompt = buildDraftSystemPrompt(writer?.systemPrompt || '');
  let draftOutput = '';
  try {
    draftOutput = (await runSubagent({
      subagentId: 'sa-writer',
      input,
      abortSignal,
      userLang: 'zh-CN',
      mcpClient: createDraftMcpClient(),
      systemPromptOverride: draftSystemPrompt,
    })).output || '';
  } catch (err) {
    const message = err?.message || String(err);
    if (!/没有可用的 AI 服务商|API Key 未设置|No provider configured|Provider API key is missing/.test(message)) {
      throw err;
    }
    draftOutput = await runDraftViaWorkflow(input, draftSystemPrompt, abortSignal);
  }

  const draft = normalizeDraft(draftOutput, targetChapter);
  const reviewInput = buildReviewInput({ mode, userText, draft });
  const characterReviewer = await subagentsStore.getSubagent('sa-character-reviewer');
  const timelineReviewer = await subagentsStore.getSubagent('sa-timeline-guardian');
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
  const blockingIssues = [...characterIssues, ...timelineIssues];
  const reviseFromSelection = mode === 'revise'
    && !pendingChapterDraft?.text
    && !!String(editorContext?.selectedText || '').trim();

  return {
    draft,
    blockingIssues,
    assistantText: buildAssistantText({ mode, draft, blockingIssues, reviseFromSelection }),
  };
}

module.exports = {
  generateChapterDraft,
  _testBuildChapterAssistantText: buildAssistantText,
  _testBuildChapterReviewFailureIssue: buildReviewFailureIssue,
};