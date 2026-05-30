'use strict';

const mcpClient = require('../mcp/mcpClientStdio');
const workflowOrchestrator = require('./workflowOrchestrator');
const { getActiveNovelContext } = require('./activeNovelContext');
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
    '- 你必须只输出一个 JSON 对象，不要围栏、不要解释文字。',
    '- JSON 结构：{"summary":"本章详细摘要","outlineActualSummary":"写回大纲的实际进展","outlineUpdates":[{"nodeId":"大纲节点ID","actualSummary":"该节点对应正文实际进展","actualBeats":["关键动作/转折"]}],"supplementMarkdown":"可写入 summaries 的补充 Markdown","timelineEvents":[{"when":"时间描述","where":"地点，可为空","participants":["参与者"],"description":"具体事件描述","physical":null,"communication":null}],"timelineShouldClear":false}.',
    '- summary 写 150-300 字，覆盖开局状态、关键转折、角色决定、关系变化、结尾悬念；不要只写一句概括。',
    '- outlineActualSummary 写 80-180 字，面向大纲维护，说明本章实际完成了哪些剧情推进、人物状态变化和未解决伏笔。',
    '- 如果输入里提供了 outlineContext.matchingNodes，请为每个相关节点生成 outlineUpdates；actualSummary 不要复述原大纲，要写正文实际发生后的结果。',
    '- timelineEvents 应按本章内发生顺序列出具体事件。普通剧情章通常需要 2-6 条；只有纯内心独白/无可定位事件时才返回空数组。',
    '- 若 existingTimeline 里有旧事件且正文仍支持这些事件，请保留或改写为新的 timelineEvents；不要因为不确定就返回空数组。',
    '- 只有确认本章不应保留任何时间线事件时，才将 timelineShouldClear 设为 true。',
    '- supplementMarkdown 只写新增设定补充，不要重复正文；没有新增设定则为空字符串。',
  ].join('\n');
}

function buildInput(draft, context = {}) {
  return JSON.stringify({
    chapter: {
      name: draft.name,
      displayName: draft.displayName,
      title: draft.title,
      summaryHint: draft.summary || '',
      text: draft.text,
    },
    outlineContext: context.outlineContext || null,
    existingTimeline: Array.isArray(context.existingTimeline) ? context.existingTimeline : [],
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
  const outlineUpdates = (Array.isArray(parsed?.outlineUpdates) ? parsed.outlineUpdates : [])
    .map((item) => ({
      nodeId: String(item?.nodeId || item?.id || '').trim(),
      actualSummary: String(item?.actualSummary || '').trim(),
      actualBeats: Array.isArray(item?.actualBeats)
        ? item.actualBeats.map((beat) => String(beat || '').trim()).filter(Boolean)
        : [],
    }))
    .filter((item) => item.nodeId && item.actualSummary);
  const timelineEvents = (Array.isArray(parsed?.timelineEvents) ? parsed.timelineEvents : [])
    .map((event) => normalizeTimelineEvent(event, draft.name))
    .filter((event) => event.when && event.description);
  return {
    summary: String(parsed?.summary || fallbackSummary).trim() || fallbackSummary,
    outlineActualSummary: String(parsed?.outlineActualSummary || parsed?.actualSummary || '').trim(),
    outlineUpdates,
    supplementMarkdown: String(parsed?.supplementMarkdown || '').trim(),
    timelineEvents,
    timelineShouldClear: parsed?.timelineShouldClear === true,
  };
}

function parseChapterIndex(chapterName) {
  const match = String(chapterName || '').match(/chapter-(\d+)/i);
  return match ? Number(match[1]) : null;
}

function matchesDraftChapter(node, draft) {
  const parsedChapterIndex = parseChapterIndex(draft.name);
  if (draft.volumeIndex != null && node.volumeIndex != null && Number(node.volumeIndex) !== Number(draft.volumeIndex)) return false;
  if (draft.sectionIndex != null && node.sectionIndex != null && Number(node.sectionIndex) !== Number(draft.sectionIndex)) return false;
  if (node.chapterRef && node.chapterRef === draft.name) return true;
  if (node.writtenChapterRef && node.writtenChapterRef === draft.name) return true;
  if (parsedChapterIndex != null && Number(node.chapterIndex) === parsedChapterIndex) return true;
  return false;
}

async function updateOutlineAfterWrite(draft, analysis) {
  const readResult = await callAutoTool('read_outline_nodes', {});
  if (readResult.isError) return { toolCalls: [{
    id: `auto-outline-read-${Date.now().toString(36)}`,
    name: 'read_outline_nodes',
    input: {},
    status: 'done',
    result: readResult.text,
    isError: true,
  }], updated: 0, warning: `大纲读取失败：${trimMessage(readResult.text)}` };

  const payload = parseToolPayload(readResult.text);
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  if (!nodes.length) return { toolCalls: [], updated: 0, warning: '' };

  let updated = 0;
  const stamp = new Date().toISOString();
  const updatesById = new Map();
  for (const update of Array.isArray(analysis.outlineUpdates) ? analysis.outlineUpdates : []) {
    updatesById.set(update.nodeId, update);
  }
  const fallbackActualSummary = analysis.outlineActualSummary || analysis.summary;
  const nextNodes = nodes.map((node) => {
    if (!matchesDraftChapter(node, draft)) return node;
    updated += 1;
    const nodeUpdate = updatesById.get(node.id);
    return {
      ...node,
      status: 'written',
      writtenChapterRef: draft.name,
      writtenTitle: draft.title || draft.displayName || node.writtenTitle || node.title,
      writtenAt: stamp,
      actualSummary: nodeUpdate?.actualSummary || fallbackActualSummary,
      ...(nodeUpdate?.actualBeats?.length ? { actualBeats: nodeUpdate.actualBeats } : {}),
    };
  });

  if (!updated) return { toolCalls: [], updated: 0, warning: `未找到可关联的大纲节点：${draft.name}` };

  const writeResult = await callAutoTool('write_outline_nodes', { nodes: nextNodes });
  return {
    toolCalls: [{
      id: `auto-outline-update-${Date.now().toString(36)}`,
      name: 'write_outline_nodes',
      input: { updated, chapterRef: draft.name },
      status: 'done',
      result: writeResult.text,
      isError: writeResult.isError,
    }],
    updated,
    warning: writeResult.isError ? `大纲状态更新失败：${trimMessage(writeResult.text)}` : '',
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
    const result = await workflowOrchestrator.runWorkflow({
      mode: 'subagent',
      subagentId: 'sa-lore-updater',
      input,
      userLang: 'zh-CN',
      systemPromptOverride: systemPrompt,
      abortSignal,
      novelContext: getActiveNovelContext(mcpClient),
    });
    return result.output || '';
  }
}

function pickOutlineContext(nodes, draft) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const matchingNodes = nodeList
    .filter((node) => matchesDraftChapter(node, draft))
    .map((node) => ({
      id: node.id,
      title: node.title || '',
      summary: node.summary || '',
      characters: Array.isArray(node.characters) ? node.characters : [],
      setting: node.setting || '',
      location: node.location || '',
      pov: node.pov || '',
      volumeIndex: node.volumeIndex ?? null,
      sectionIndex: node.sectionIndex ?? null,
      chapterIndex: node.chapterIndex ?? null,
    }));
  if (!matchingNodes.length) return null;
  return {
    matchingNodes,
    totalNodeCount: nodeList.length,
  };
}

async function persistChapterArtifacts({ draft, abortSignal }) {
  if (!draft?.name || !draft?.text) {
    throw new Error('persistChapterArtifacts requires chapter name and text');
  }

  const warnings = [];
  const context = { outlineContext: null, existingTimeline: [] };
  const outlineContextRead = await callAutoTool('read_outline_nodes', {});
  if (!outlineContextRead.isError) {
    const outlinePayload = parseToolPayload(outlineContextRead.text);
    context.outlineContext = pickOutlineContext(outlinePayload?.nodes, draft);
  }
  const timelineContextRead = await callAutoTool('query_timeline', { chapterRef: draft.name });
  if (!timelineContextRead.isError) {
    const timelinePayload = parseToolPayload(timelineContextRead.text);
    context.existingTimeline = Array.isArray(timelinePayload?.events) ? timelinePayload.events : [];
  }

  let analysis;
  let analysisReliable = true;
  try {
    const output = await runAnalysis(buildInput(draft, context), buildSystemPrompt(''), abortSignal);
    analysis = normalizeAnalysis(parseJsonFromText(output), draft);
  } catch (err) {
    warnings.push(`章节回写分析失败：${trimMessage(err?.message || String(err))}`);
    analysisReliable = false;
    analysis = normalizeAnalysis({}, draft);
  }

  const toolCalls = [];
  let summarySaved = false;
  if (analysisReliable) {
    const summaryResult = await callAutoTool('append_summary', {
      chapterRef: draft.name,
      summary: analysis.summary,
      supplementMarkdown: analysis.supplementMarkdown,
    });
    summarySaved = !summaryResult.isError;
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
  } else {
    pushUniqueWarning(warnings, 'AI 分析失败，已跳过摘要写入以避免用兜底短句覆盖旧摘要。');
  }

  let timelineSynced = 0;
  let outlineUpdated = 0;
  const blockingWarnings = [];
  if (!analysisReliable) {
    pushUniqueWarning(warnings, 'AI 分析失败，已跳过时间线和大纲回写以避免覆盖旧数据。');
  } else if (!analysis.timelineEvents.length && context.existingTimeline.length && !analysis.timelineShouldClear) {
    timelineSynced = context.existingTimeline.length;
    pushUniqueWarning(warnings, 'AI 未返回新的时间线事件，已保留本章原有时间线。');
  } else {
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
      timelineSynced = Number.isInteger(timelinePayload?.synced)
        ? timelinePayload.synced
        : analysis.timelineEvents.length;
    }
  }

  if (analysisReliable) {
    const outlineResult = await updateOutlineAfterWrite(draft, analysis);
    toolCalls.push(...outlineResult.toolCalls);
    outlineUpdated = outlineResult.updated || 0;
    if (outlineResult.warning) {
      pushUniqueWarning(warnings, outlineResult.warning);
    }
  }

  return {
    summary: analysis.summary,
    summarySaved,
    timelineCount: timelineSynced,
    outlineUpdated,
    blockingWarnings,
    warnings,
    toolCalls,
  };
}

module.exports = {
  persistChapterArtifacts,
};
