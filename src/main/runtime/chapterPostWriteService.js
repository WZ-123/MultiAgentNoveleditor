'use strict';

const mcpClient = require('../mcp/mcpClientStdio');
const workflowOrchestrator = require('./workflowOrchestrator');
const { runSubagent } = require('./runSubagent');

function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('章节回写分析未返回内容');
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
    throw new Error('无法解析章节回写 JSON');
  }
}

function trimMessage(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .replace(/^Error:\s*/i, '')
    .trim()
    .slice(0, 160);
}

function pushUniqueWarning(list, message) {
  const text = String(message || '').trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function parseToolPayload(text) {
  try {
    return parseJsonFromText(text);
  } catch {
    return null;
  }
}

function collectTimelineValidationMessages(payload) {
  const warnings = [];
  const blockingWarnings = [];
  const payloadWarnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  const validation = payload?.validation && typeof payload.validation === 'object' ? payload.validation : null;

  if (Array.isArray(validation?.missingChapterRefs) && validation.missingChapterRefs.length) {
    blockingWarnings.push(`缺少时间线覆盖的章节: ${validation.missingChapterRefs.join(', ')}`);
  }
  if (Array.isArray(validation?.orphanChapterRefs) && validation.orphanChapterRefs.length) {
    blockingWarnings.push(`检测到残留或无效章节引用: ${validation.orphanChapterRefs.join(', ')}`);
  }

  for (const warning of payloadWarnings) {
    const text = String(warning || '').trim();
    if (!text) continue;
    if (/^检测到缺少时间线覆盖的章节:/.test(text)) continue;
    if (/^检测到残留或无效章节引用:/.test(text)) continue;
    warnings.push(text);
  }

  return { warnings, blockingWarnings };
}

function buildSystemPrompt(basePrompt) {
  return [
    String(basePrompt || '').trim(),
    '',
    '## Chapter Post-Write Override',
    '- 当前任务是对一章已经确认写入的正文做结构化回写准备。',
    '- 不要调用任何写工具，也不要要求用户确认。',
    '- 你必须只输出一个 JSON 对象：{"summary":"本章摘要","supplementMarkdown":"可写入 summaries 的补充 Markdown","timelineEvents":[{"when":"时间描述","where":"地点，可为空","participants":["参与者"],"description":"事件描述","physical":null,"communication":null}]}.',
    '- timelineEvents 里只保留本章中明确发生、且值得写入时间线的高置信事件；没有就返回空数组。',
    '- summary 要简洁准确，supplementMarkdown 只写新增设定补充，不要重复正文。',
  ].join('\n');
}

function buildInput(draft) {
  return JSON.stringify({
    chapter: {
      name: draft.name,
      displayName: draft.displayName,
      title: draft.title,
      summaryHint: draft.summary || '',
      text: draft.text,
    },
  }, null, 2);
}

function normalizeTimelineEvent(event, chapterRef) {
  const participants = Array.isArray(event?.participants)
    ? event.participants.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const where = event?.where == null
    ? undefined
    : (typeof event.where === 'string' ? event.where.trim() : event.where);
  const physical = event?.physical == null ? undefined : event.physical;
  const communication = event?.communication == null ? undefined : event.communication;
  const next = {
    chapterRef,
    when: String(event?.when || '').trim(),
    description: String(event?.description || '').trim(),
  };
  if (where) next.where = where;
  if (participants.length) next.participants = participants;
  if (physical !== undefined) next.physical = physical;
  if (communication !== undefined) next.communication = communication;
  return next;
}

function normalizeAnalysis(parsed, draft) {
  const fallbackSummary = String(draft.summary || `${draft.displayName || draft.name} 已写入项目。`).trim();
  const timelineEvents = (Array.isArray(parsed?.timelineEvents) ? parsed.timelineEvents : [])
    .map((event) => normalizeTimelineEvent(event, draft.name))
    .filter((event) => event.when && event.description);
  return {
    summary: String(parsed?.summary || fallbackSummary).trim() || fallbackSummary,
    supplementMarkdown: String(parsed?.supplementMarkdown || '').trim(),
    timelineEvents,
  };
}

async function callAutoTool(name, args) {
  try {
    const result = await mcpClient.callTool({ name, arguments: args || {}, autoConfirm: true });
    const text = Array.isArray(result?.content)
      ? result.content.map((item) => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n')
      : (typeof result === 'string' ? result : JSON.stringify(result ?? ''));
    return { text, isError: !!result?.isError };
  } catch (err) {
    return { text: err?.message || String(err), isError: true };
  }
}

async function runAnalysis(input, systemPrompt, abortSignal) {
  try {
    const result = await runSubagent({
      subagentId: 'sa-lore-updater',
      input,
      abortSignal,
      userLang: 'zh-CN',
      systemPromptOverride: systemPrompt,
    });
    return result.output || '';
  } catch (err) {
    const message = err?.message || String(err);
    if (!/没有可用的 AI 服务商|API Key 未设置|No provider configured|Provider API key is missing/.test(message)) {
      throw err;
    }
    const result = await workflowOrchestrator.runWorkflow({
      mode: 'subagent',
      subagentId: 'sa-lore-updater',
      input,
      userLang: 'zh-CN',
      systemPromptOverride: systemPrompt,
      abortSignal,
      novelContext: (() => {
        const ctx = mcpClient.getActiveNovelContext();
        return ctx?.id ? { novelId: ctx.id, novelDir: ctx.dir } : undefined;
      })(),
    });
    return result.output || '';
  }
}

async function persistChapterArtifacts({ draft, abortSignal }) {
  if (!draft?.name || !draft?.text) {
    throw new Error('persistChapterArtifacts requires chapter name and text');
  }

  const warnings = [];
  let analysis;
  try {
    const output = await runAnalysis(buildInput(draft), buildSystemPrompt(''), abortSignal);
    analysis = normalizeAnalysis(parseJsonFromText(output), draft);
  } catch (err) {
    warnings.push(`章节回写分析失败：${trimMessage(err?.message || String(err))}`);
    analysis = normalizeAnalysis({}, draft);
  }

  const toolCalls = [];
  const summaryResult = await callAutoTool('append_summary', {
    chapterRef: draft.name,
    summary: analysis.summary,
    supplementMarkdown: analysis.supplementMarkdown,
  });
  toolCalls.push({
    id: `auto-summary-${Date.now().toString(36)}`,
    name: 'append_summary',
    input: { chapterRef: draft.name },
    status: 'done',
    result: summaryResult.text,
    isError: summaryResult.isError,
  });
  if (summaryResult.isError) {
    warnings.push(`章节摘要写入失败：${trimMessage(summaryResult.text)}`);
  }

  let timelineSynced = 0;
  const blockingWarnings = [];
  const timelineResult = await callAutoTool('sync_chapter_timeline', {
    chapterRef: draft.name,
    events: analysis.timelineEvents,
  });
  toolCalls.push({
    id: `auto-timeline-sync-${Date.now().toString(36)}`,
    name: 'sync_chapter_timeline',
    input: { chapterRef: draft.name, events: analysis.timelineEvents },
    status: 'done',
    result: timelineResult.text,
    isError: timelineResult.isError,
  });
  if (timelineResult.isError) {
    warnings.push(`章节时间线同步失败：${trimMessage(timelineResult.text)}`);
  } else {
    const timelinePayload = parseToolPayload(timelineResult.text);
    const timelineMessages = collectTimelineValidationMessages(timelinePayload);
    for (const warning of timelineMessages.warnings) {
      pushUniqueWarning(warnings, warning);
    }
    for (const warning of timelineMessages.blockingWarnings) {
      blockingWarnings.push(warning);
      pushUniqueWarning(warnings, `时间线校验未通过：${warning}`);
    }
    timelineSynced = Number.isInteger(timelinePayload?.after)
      ? timelinePayload.after
      : analysis.timelineEvents.length;
  }

  return {
    summary: analysis.summary,
    summarySaved: !summaryResult.isError,
    timelineCount: timelineSynced,
    blockingWarnings,
    warnings,
    toolCalls,
  };
}

module.exports = {
  persistChapterArtifacts,
};