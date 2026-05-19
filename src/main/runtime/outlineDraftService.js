'use strict';

const { randomUUID } = require('node:crypto');
const mcpClient = require('../mcp/mcpClientStdio');
const subagentsStore = require('../store/subagents');
const workflowOrchestrator = require('./workflowOrchestrator');
const { getActiveNovelContext } = require('./activeNovelContext');
const { runSubagent } = require('./runSubagent');

function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('大纲模型未返回内容');
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
    throw new Error('无法解析大纲 JSON');
  }
}

function buildDraftSystemPrompt(basePrompt) {
  return [
    String(basePrompt || '').trim(),
    '',
    '## Drafting Override',
    '- 当前任务只允许生成大纲草案，严禁调用 write_outline_nodes 或任何保存动作。',
    '- 直接输出 JSON 草案，等待用户确认后再保存。',
  ].join('\n');
}

function createDraftMcpClient() {
  return {
    async listTools() {
      const tools = await mcpClient.listTools();
      return (tools || []).filter((tool) => tool?.name !== 'write_outline_nodes');
    },
    async callTool(payload) {
      if (payload?.name === 'write_outline_nodes') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'write_outline_nodes 在草拟阶段已禁用，请直接输出 JSON 草案。' }],
        };
      }
      return mcpClient.callTool(payload);
    },
  };
}

function buildDraftInput({ mode, userText, pendingOutlineDraft }) {
  const lines = [
    `模式：${mode === 'user_outline' ? '已有大纲修订' : '剧情走向生成'}`,
    '要求：只生成结构化大纲草案，不要保存。',
    '',
    '用户需求：',
    userText,
  ];
  if (mode === 'user_outline' && pendingOutlineDraft?.rawMarkdown) {
    lines.push('', '当前草案：', pendingOutlineDraft.rawMarkdown);
  }
  return lines.join('\n');
}

function flattenOutlineScenes(hierarchy) {
  if (!hierarchy) return [];
  const scenes = [];
  for (const volume of hierarchy.volumes || []) {
    for (const section of volume.sections || []) {
      for (const chapter of section.chapterOutlines || []) {
        for (const scene of chapter.scenes || []) {
          scenes.push({
            ...scene,
            volumeIndex: volume.volumeIndex,
            sectionIndex: section.sectionIndex,
            chapterIndex: chapter.chapterIndex,
          });
        }
      }
    }
  }
  return scenes;
}

function buildReviewInput({ mode, userText, draft }) {
  const hierarchy = draft.hierarchy || { nodes: draft.nodes };
  const scenes = flattenOutlineScenes(hierarchy);
  return JSON.stringify({
    mode,
    userText,
    outline: hierarchy,
    scenes,
  }, null, 2);
}

function normalizeHierarchy(data) {
  const source = data?.outline && typeof data.outline === 'object' ? data.outline : data;
  if (!source || (!Array.isArray(source.volumes) && !Array.isArray(source.master))) return null;

  const masterByVolume = new Map();
  for (const item of Array.isArray(source.master) ? source.master : []) {
    if (item && item.volumeIndex != null) {
      masterByVolume.set(Number(item.volumeIndex), { ...item, volumeIndex: Number(item.volumeIndex) });
    }
  }

  const volumes = (Array.isArray(source.volumes) ? source.volumes : []).map((volume, volumeOffset) => {
    const volumeIndex = Number(volume?.volumeIndex ?? volume?.metadata?.volumeIndex ?? volumeOffset + 1);
    const fallbackMeta = masterByVolume.get(volumeIndex) || {};
    const metadata = {
      ...fallbackMeta,
      ...(volume?.metadata || {}),
      volumeIndex,
      id: volume?.metadata?.id || fallbackMeta.id || `vol-${volumeIndex}`,
      title: volume?.metadata?.title || fallbackMeta.title || `第${volumeIndex}卷`,
      summary: volume?.metadata?.summary || fallbackMeta.summary || '',
    };
    const sections = (Array.isArray(volume?.sections) ? volume.sections : []).map((section, sectionOffset) => {
      const sectionIndex = Number(section?.sectionIndex ?? section?.metadata?.sectionIndex ?? sectionOffset + 1);
      const sectionMeta = {
        ...(section?.metadata || {}),
        volumeIndex,
        sectionIndex,
        id: section?.metadata?.id || `sec-${volumeIndex}-${sectionIndex}`,
        title: section?.metadata?.title || `第${sectionIndex}节`,
        summary: section?.metadata?.summary || '',
      };
      const chapterOutlines = (Array.isArray(section?.chapterOutlines) ? section.chapterOutlines : []).map((chapter, chapterOffset) => ({
        chapterIndex: Number(chapter?.chapterIndex ?? chapterOffset + 1),
        title: chapter?.title || `第${chapterOffset + 1}章`,
        scenes: Array.isArray(chapter?.scenes) ? chapter.scenes.map((scene, sceneOffset) => ({
          ...scene,
          id: scene?.id || `scene-${volumeIndex}-${sectionIndex}-${chapterOffset + 1}-${sceneOffset + 1}`,
          title: scene?.title || `场景 ${sceneOffset + 1}`,
          summary: scene?.summary || '',
        })) : [],
        writingNotes: chapter?.writingNotes || '',
      }));
      return {
        sectionIndex,
        metadata: sectionMeta,
        chapterOutlines,
      };
    });
    return {
      volumeIndex,
      metadata,
      sections,
    };
  });

  const master = volumes.map((volume) => ({ ...volume.metadata }));
  return {
    id: source.id || `outline-${Date.now().toString(36)}`,
    version: Number(source.version || 1),
    master,
    volumes,
  };
}

function flattenHierarchy(hierarchy) {
  if (!hierarchy) return [];
  const nodes = [];
  for (const volume of hierarchy.volumes || []) {
    if (volume.metadata) {
      nodes.push({ ...volume.metadata, level: 1, volumeIndex: volume.volumeIndex });
    }
    for (const section of volume.sections || []) {
      if (section.metadata) {
        nodes.push({ ...section.metadata, level: 2, volumeIndex: volume.volumeIndex, sectionIndex: section.sectionIndex });
      }
      for (const chapter of section.chapterOutlines || []) {
        for (const scene of chapter.scenes || []) {
          nodes.push({
            ...scene,
            volumeIndex: volume.volumeIndex,
            sectionIndex: section.sectionIndex,
            chapterIndex: chapter.chapterIndex,
            chapterTitle: chapter.title,
            writingNotes: chapter.writingNotes || '',
          });
        }
      }
    }
  }
  return nodes;
}

function nodesToMarkdown(nodes) {
  const lines = ['# 总大纲'];
  for (const node of nodes || []) {
    if (node.level === 1) {
      lines.push('', `## 第${node.volumeIndex || 1}卷：${node.title || ''}`);
      if (node.summary) lines.push('', node.summary);
      continue;
    }
    if (node.level === 2) {
      lines.push('', `### 第${node.sectionIndex || 1}节：${node.title || ''}`);
      if (node.summary) lines.push('', node.summary);
      continue;
    }
    lines.push('', `- 第${node.chapterIndex || 1}章 / ${node.title || '场景'}`);
    if (node.summary) lines.push(`  ${node.summary}`);
  }
  return lines.join('\n').trim();
}

function hierarchyToMarkdown(hierarchy) {
  const lines = ['# 总大纲'];
  for (const volume of hierarchy?.volumes || []) {
    lines.push('', `## 第${volume.volumeIndex}卷：${volume.metadata?.title || ''}`);
    if (volume.metadata?.summary) lines.push('', volume.metadata.summary);
    for (const section of volume.sections || []) {
      lines.push('', `### 第${section.sectionIndex}节：${section.metadata?.title || ''}`);
      if (section.metadata?.summary) lines.push('', section.metadata.summary);
      for (const chapter of section.chapterOutlines || []) {
        lines.push('', `- 第${chapter.chapterIndex}章：${chapter.title || ''}`);
        if (chapter.writingNotes) lines.push(`  写作指导：${chapter.writingNotes}`);
        for (const scene of chapter.scenes || []) {
          lines.push(`  - ${scene.title || '场景'}：${scene.summary || ''}`.trimEnd());
        }
      }
    }
  }
  return lines.join('\n').trim();
}

function normalizeDraft(outputText) {
  const parsed = parseJsonFromText(outputText);
  const source = parsed?.outline && typeof parsed.outline === 'object' ? parsed.outline : parsed;

  if (Array.isArray(source)) {
    const nodes = source;
    return { hierarchy: null, nodes, rawMarkdown: nodesToMarkdown(nodes) };
  }

  if (Array.isArray(source?.nodes)) {
    const nodes = source.nodes;
    return { hierarchy: null, nodes, rawMarkdown: source.rawMarkdown || nodesToMarkdown(nodes) };
  }

  const hierarchy = normalizeHierarchy(source);
  if (!hierarchy) {
    throw new Error('大纲草案缺少可识别的节点结构');
  }
  const nodes = flattenHierarchy(hierarchy);
  if (!nodes.length) {
    throw new Error('大纲草案未生成可保存的节点');
  }
  return {
    hierarchy,
    nodes,
    rawMarkdown: hierarchyToMarkdown(hierarchy),
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

async function runReviewer(subagentId, input, sourceAgent, abortSignal) {
  const result = await runSubagent({
    subagentId,
    input,
    abortSignal,
    userLang: 'zh-CN',
    mcpClient,
  });
  const parsed = parseJsonFromText(result.output || '');
  return normalizeIssues(parsed?.issues, sourceAgent);
}

async function runReviewerViaWorkflow(subagentId, input, sourceAgent, abortSignal) {
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId,
    input,
    userLang: 'zh-CN',
    novelContext: getActiveNovelContext(mcpClient),
    abortSignal,
  });
  const parsed = parseJsonFromText(result.output || '');
  return normalizeIssues(parsed?.issues, sourceAgent);
}

async function runReviewerWithFallback(subagentId, input, sourceAgent, abortSignal) {
  try {
    return await runReviewer(subagentId, input, sourceAgent, abortSignal);
  } catch (primaryErr) {
    try {
      return await runReviewerViaWorkflow(subagentId, input, sourceAgent, abortSignal);
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
    lines.push('以下审查尚未完成，本轮草案不能视为已完整核对：');
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

function buildAssistantText({ mode, draft, blockingIssues }) {
  const intro = mode === 'user_outline'
    ? '我已按专用大纲流程基于当前草案重做了一版，先不写入项目。'
    : '我已按专用大纲流程生成了一版草案，先不写入项目。';
  const hasIncompleteReview = (blockingIssues || []).some((issue) => issue.reviewIncomplete);
  return [
    intro,
    '',
    '我现在先停在大纲审阅阶段，不进入正文写作。',
    '',
    '## 大纲草案',
    '',
    draft.rawMarkdown,
    '',
    '## 审查结果',
    '',
    formatIssues(blockingIssues),
    '',
    '## 请你决定下一步',
    '',
    hasIncompleteReview
      ? '如果你要我继续，请回复“重新审查一下大纲”或直接告诉我还想调整哪一章、哪条人物线。'
      : '如果你要继续修改，直接告诉我想调整的人物线、卷章结构或剧情走向。',
    hasIncompleteReview
      ? '等审查补齐后，我再让你确认是否写入项目。'
      : '如果你认可这版草案，再回复“确认写入大纲”或“保存这个大纲”。',
  ].join('\n');
}

async function runDraftViaWorkflow(input, abortSignal) {
  const subagent = await subagentsStore.getSubagent('sa-outline-drafter');
  const base = buildDraftSystemPrompt(subagent?.systemPrompt || '');
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId: 'sa-outline-drafter',
    systemPromptOverride: base,
    input,
    userLang: 'zh-CN',
    novelContext: getActiveNovelContext(mcpClient),
    abortSignal,
  });
  return result.output || '';
}

async function generateOutlineDraft({ mode, userText, pendingOutlineDraft, abortSignal }) {
  const input = buildDraftInput({ mode, userText, pendingOutlineDraft });
  const subagent = await subagentsStore.getSubagent('sa-outline-drafter');
  const draftSystemPrompt = buildDraftSystemPrompt(subagent?.systemPrompt || '');
  let draftOutput = '';
  try {
    draftOutput = (await runSubagent({
      subagentId: 'sa-outline-drafter',
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
    draftOutput = await runDraftViaWorkflow(input, abortSignal);
  }

  const draft = normalizeDraft(draftOutput);
  const reviewInput = buildReviewInput({ mode, userText, draft });
  const [characterIssues, timelineIssues] = await Promise.all([
    runReviewerWithFallback('sa-character-reviewer', reviewInput, 'character_world', abortSignal),
    runReviewerWithFallback('sa-timeline-guardian', reviewInput, 'timeline', abortSignal),
  ]);
  const blockingIssues = [...characterIssues, ...timelineIssues];

  return {
    draft,
    blockingIssues,
    assistantText: buildAssistantText({ mode, draft, blockingIssues }),
  };
}

module.exports = {
  generateOutlineDraft,
  _testBuildReviewInput: buildReviewInput,
  _testBuildAssistantText: buildAssistantText,
  _testBuildReviewFailureIssue: buildReviewFailureIssue,
};