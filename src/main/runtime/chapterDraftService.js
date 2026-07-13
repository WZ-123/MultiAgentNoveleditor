'use strict';

const { createHash, randomUUID } = require('node:crypto');
const mcpClient = require('../mcp/mcpClientStdio');
const subagentsStore = require('../store/subagents');
const workflowOrchestrator = require('./workflowOrchestrator');
const { getActiveNovelContext } = require('./activeNovelContext');
const { runSubagent } = require('./runSubagent');
const appConfig = require('../store/appConfig');
const chapterRoleplayService = require('./chapterRoleplayService');
const chapterTargetResolver = require('./chapterTargetResolver');
const chapterContextCompiler = require('./chapterContextCompiler');
const chapterConstraintValidator = require('./chapterConstraintValidator');
const chapterConstraintVerifier = require('./chapterConstraintVerifier');
const chapterStateVerifier = require('./chapterStateVerifier');
const { resolveAdaptivePolicy } = require('./chapterRiskProfile');
const { parseJsonText } = require('./jsonText');
const { splitIntoParagraphs } = require('./chapterCharacterReview');
const { normalizeDraftTrace } = require('../../domain/chapterHarness.cjs');
const {
  formatReviewIssueLabel,
  getOpenReviewIssues,
  hasBlockingReviewIssues,
  isOpenReviewIssue,
  mergeReviewIssues,
  normalizeReviewIssues,
  reviewSourceLabel,
} = require('../../domain/chapterReview.cjs');

const MAX_AUTO_REVIEW_REVISIONS = 2;
const PROMPT_VERSIONS = Object.freeze({
  chapter: 'chapter-draft-v2',
  scene: 'scene-draft-v2',
  review: 'chapter-constraint-review-v3',
  repair: 'local-repair-v2',
  advisory: 'chapter-advisory-v1',
  stateExtractor: 'scene-state-extractor-v4',
  constraintVerifier: 'chapter-constraint-verifier-v1',
});

function promptHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function chapterContentHash(value) {
  return createHash('sha256').update(String(value || '').replace(/\r\n/gu, '\n').trim()).digest('hex').slice(0, 16);
}

function createHarnessModelRuntime(override = {}) {
  const calls = [];
  const invokeOverride = typeof override?.invoke === 'function' ? override.invoke.bind(override) : null;
  const runner = typeof override?.runSubagent === 'function' ? override.runSubagent : runSubagent;
  return {
    calls,
    async invoke(options, meta = {}) {
      const startedAt = Date.now();
      let callOptions = options;
      if (!String(options?.systemPromptOverride || '').trim() && options?.subagentId) {
        const subagent = await subagentsStore.getSubagent(options.subagentId).catch(() => null);
        if (subagent?.systemPrompt) callOptions = { ...options, systemPromptOverride: subagent.systemPrompt };
      }
      const result = invokeOverride ? await invokeOverride(callOptions, meta) : await runner(callOptions);
      const telemetry = result?.telemetry || {};
      calls.push({
        callId: result?.runId || randomUUID(),
        role: meta.role || options?.subagentId || 'unknown',
        model: telemetry.model || '',
        providerType: telemetry.providerType || '',
        requestId: telemetry.providerCalls?.at?.(-1)?.requestId || '',
        durationMs: telemetry.durationMs || Date.now() - startedAt,
        turns: telemetry.turns || 1,
        usage: telemetry.usage || {},
        promptVersion: meta.promptVersion || '',
        promptHash: promptHash(callOptions?.systemPromptOverride || ''),
        status: 'done',
      });
      return result;
    },
  };
}

function parseJsonFromText(text) {
  try {
    return parseJsonText(text);
  } catch (error) {
    if (!String(text || '').trim()) throw new Error('章节模型未返回内容');
    throw error;
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
    '- 你必须只输出一个 JSON 对象：{"title":"章节标题","summary":"一句话摘要","text":"完整章节正文","eventLedger":{"events":[{"order":1,"when":"时间","where":"地点","participants":["角色"],"action":"事件动作","infoKnownBy":["知情者"],"communication":"信息传播/通信，可为空","uncertainty":"不确定点，可为空"}]},"stateDelta":{},"constraintCoverage":[],"sourceUsage":[{"sourceRef":"来源引用","usedFor":"用途","evidenceParagraphIds":[]}]}。',
    '- eventLedger 只是审查辅助账本，不是正文；不得把 JSON、账本标题或说明写进 text。',
    '- text 字段只能包含小说正文。严禁把设定校对、前文纠错、章节备注、工具调用结果、审查意见、角色卡说明、大纲说明或“之前章节写成/这里该改”等编辑性句子写入 text。',
    '- 若需要记录设定纠错或一致性风险，只能写入 summary 或 eventLedger，不得混入小说段落。',
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
  const blocked = new Set(['write_chapter', 'append_timeline', 'update_timeline', 'append_summary', 'grant_asset', 'revoke_asset', 'apply_asset_patch', 'update_character', 'create_character', 'update_world', 'rebuild_chapter_harness_state']);
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

function buildDraftInput({ mode, userText, pendingChapterDraft, targetChapter, editorContext, compactContext, contextBundle, roleplayPlan, profileWarnings }) {
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
  if (contextBundle) {
    lines.push(
      '',
      '## 自适应写作上下文',
      '以下上下文已经由系统按来源优先级编译。硬约束高于软偏好；语义检索不得覆盖确定性事实。',
      '',
      '### 前情与上一章出口状态',
      JSON.stringify(contextBundle.continuity || {}, null, 2),
      '',
      '### 总纲 / 卷纲 / 节纲 / 本章大纲',
      JSON.stringify(contextBundle.outlineIntent || {}, null, 2),
      '',
      '### 场景契约',
      JSON.stringify(contextBundle.sceneContracts || [], null, 2),
      '',
      '### 场景角色上下文',
      JSON.stringify(contextBundle.sceneCharacterContexts || [], null, 2),
      '',
      '### 邻近时间线',
      JSON.stringify(contextBundle.nearbyTimeline || [], null, 2),
      '',
      '### 文风上下文',
      JSON.stringify(contextBundle.stylePacket || {}, null, 2),
      '',
      '### 硬约束',
      JSON.stringify(contextBundle.hardConstraints || [], null, 2),
      '',
      '### 软偏好',
      JSON.stringify(contextBundle.softPreferences || [], null, 2)
    );
    if (contextBundle.retrievedContext?.contextText) {
      lines.push('', '### 语义检索补充（仅作低优先级参考）', contextBundle.retrievedContext.contextText);
    }
    lines.push(
      '',
      '### 来源与诊断',
      JSON.stringify({
        sourceRefs: contextBundle.sourceRefs || [],
        diagnostics: contextBundle.diagnostics || [],
        trimmed: contextBundle.trimmed || [],
      }, null, 2)
    );
  } else if (compactContext) {
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

function formatRoleplayRiskText(riskDecision) {
  const riskyScenes = Array.isArray(riskDecision?.riskyScenes) ? riskDecision.riskyScenes : [];
  const lines = [
    '角色驱动写作已暂停：导演仲裁发现大纲风险。',
    '',
    '这不是错误，通常说明角色按自身记忆和动机反应时，可能会把剧情推向大纲之外。',
  ];
  if (!riskyScenes.length) {
    lines.push('', '- 未收到具体风险条目。');
  } else {
    lines.push('');
    riskyScenes.slice(0, 6).forEach((scene, index) => {
      const title = scene.title || scene.sceneId || `场景 ${index + 1}`;
      lines.push(`${index + 1}. ${title}：${scene.outlineCompliance || 'risk'}`);
      const risks = Array.isArray(scene.remainingRisks) ? scene.remainingRisks : [];
      risks.slice(0, 3).forEach((risk) => {
        if (typeof risk === 'string') {
          lines.push(`   - ${risk}`);
        } else if (risk?.note || risk?.type) {
          lines.push(`   - ${risk.type ? `${risk.type}：` : ''}${risk.note || ''}`);
        }
      });
      const rejected = Array.isArray(scene.rejectedProposals) ? scene.rejectedProposals : [];
      rejected.slice(0, 2).forEach((item) => {
        if (item?.reason) lines.push(`   - 拒绝项：${item.reason}`);
      });
    });
  }
  lines.push(
    '',
    '请在聊天窗口选择下一步：',
    '1. 保大纲继续：沿用导演已筛选的 beats，让 writer 保守成文。',
    '2. 按角色方向调整大纲建议：先输出大纲调整建议，不写正文。',
    '3. 跳过角色驱动继续：回到普通写作链路生成草稿。',
    '4. 取消本轮：停止这次章节生成。'
  );
  return lines.join('\n');
}

function formatDraftGenerationFailureText(error, targetChapter) {
  const detail = String(error?.message || error || '').replace(/^Error:\s*/i, '').trim();
  return [
    `这次章节草稿没有生成成功：${detail || 'writer 没有返回正文'}`,
    '',
    `目标章节：${targetChapter?.displayName || targetChapter?.name || '当前章节'}`,
    '',
    '我没有写入任何章节，也没有更新角色记忆或时间线。',
    '你可以直接回复“重新生成这一章”，或者把要求缩小到更明确的场景、字数和角色互动。'
  ].join('\n');
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
  const text = stripDraftTextWrappers(String(parsed?.text || raw).trim());
  if (!text) throw new Error('章节草稿缺少正文');
  const contamination = detectDraftTextContamination(text);
  if (contamination) {
    throw new Error(`章节草稿包含非小说内容：${contamination}`);
  }
  return {
    name: targetChapter.name,
    displayName: targetChapter.displayName,
    title: String(parsed?.title || extractFallbackTitle(text, targetChapter.titleHint)).trim() || targetChapter.displayName,
    summary: String(parsed?.summary || '').trim(),
    text,
    eventLedger: normalizeEventLedger(parsed?.eventLedger || parsed?.eventsLedger || parsed?.ledger || {}),
    pendingStateDelta: parsed?.stateDelta && typeof parsed.stateDelta === 'object' ? { chapter: parsed.stateDelta } : {},
    constraintCoverage: Array.isArray(parsed?.constraintCoverage) ? parsed.constraintCoverage.map((item) => String(item || '').trim()).filter(Boolean) : [],
    sourceUsage: Array.isArray(parsed?.sourceUsage)
      ? parsed.sourceUsage.map((item) => ({
          sourceRef: String(item?.sourceRef || item?.ref || '').trim(),
          sceneId: String(item?.sceneId || 'chapter').trim(),
          usedFor: String(item?.usedFor || item?.purpose || '').trim(),
          evidenceParagraphIds: Array.isArray(item?.evidenceParagraphIds) ? item.evidenceParagraphIds.map((id) => String(id || '').trim()).filter(Boolean) : [],
        })).filter((item) => item.sourceRef)
      : [],
  };
}

function stripDraftTextWrappers(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```(?:json|markdown|md|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
  out = out.replace(/^(?:以下是|下面是)?(?:完整)?(?:章节)?(?:小说)?正文[：:]\s*/u, '').trim();
  return out;
}

function detectDraftTextContamination(text) {
  const body = String(text || '');
  const normalized = body.replace(/\r/g, '\n');
  const hardPatterns = [
    /(?:之前|前文|上一章|前一章|本章|当前章|章节)\s*(?:里|中)?\s*(?:写成|写作|设为|用了|出现|提到)[^。！？\n]{0,80}(?:该改|要改|应改|改成|修正|纠正)/u,
    /(?:确实|这里|此处|这一段|这段|本段)[^。！？\n]{0,60}(?:之前|前文|上一章|章节)[^。！？\n]{0,80}(?:该改|要改|应改|修正|纠正|改成)/u,
    /(?:按|根据)(?:角色卡|设定|大纲|导演|actor|director|writer|用户需求)[^。！？\n]{0,80}(?:这里|此处|应该|需要|必须|不能|不要)/iu,
    /(?:工具调用|调用结果|审查结果|风险提示|写作链|roleplay_event|eventLedger|JSON|schema|payload|metadata)[^。！？\n]{0,80}(?:如下|显示|返回|结果|内容|失败|成功)/iu,
  ];
  const hit = hardPatterns.find((pattern) => pattern.test(normalized));
  if (hit) {
    const excerpt = extractContaminationExcerpt(normalized, hit);
    return excerpt || '检测到编辑备注、工具结果或设定校对句混入正文';
  }
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const labelLine = lines.find((line) => /^(?:备注|说明|修订说明|设定校对|一致性检查|审查意见|工具结果|导演意见|角色提案|大纲风险)[：:]/u.test(line));
  if (labelLine) return compactDraftExcerpt(labelLine, 80);
  return '';
}

function extractContaminationExcerpt(text, pattern) {
  const match = String(text || '').match(pattern);
  if (!match) return '';
  const index = Math.max(0, match.index || 0);
  const start = Math.max(0, text.lastIndexOf('\n', index), text.lastIndexOf('。', index), text.lastIndexOf('！', index), text.lastIndexOf('？', index));
  const endCandidates = ['。', '！', '？', '\n']
    .map((token) => text.indexOf(token, index + match[0].length))
    .filter((pos) => pos >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) + 1 : Math.min(text.length, index + 120);
  return compactDraftExcerpt(text.slice(start, end).trim(), 100);
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
    ? '结构：{ "issues": [ { "constraintId":"相关断言ID，可为空", "sceneId":"相关场景ID，可为空", "source": "timeline" 或 "event_ledger", "category": "mobility/information/event_ledger", "severity":"blocking 或 advisory", "summary": "一句话", "detail": "可选", "evidence":"正文证据", "repairInstruction":"最小修复要求", "timelineKind": "mobility" 或 "information", "affectedOutlineNodeIds": [], "paragraphIds": ["相关段落id"] } ] }'
    : '结构：{ "issues": [ { "constraintId":"相关断言ID，可为空", "sceneId":"相关场景ID，可为空", "source": "character_world", "category": "character/world/causality", "severity":"blocking 或 advisory", "summary": "一句话问题", "detail": "可选细节", "evidence":"正文证据", "repairInstruction":"最小修复要求", "affectedOutlineNodeIds": [], "paragraphIds": ["相关段落id"] } ] }';
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
    '- 输入中的 assertions 是可判定约束。必须逐条核对；只有 severity=blocking 的失败才作为硬问题，advisory 失败保持 advisory。',
    '- reviewContext 是编译后的确定性审查包，应优先于 retrievedContext 的补充检索；检索材料无法确认时不得推断成硬冲突。',
    '- 输入中的 sourceUsage 是 writer 的来源使用声明，criticalSourceRefs 是关键来源。必须核对正文是否真的体现相关事实；只缺声明时报告 advisory，只有正文实际违背对应硬断言时才能 blocking。',
    '- 若问题能定位到具体正文段落，请填写 paragraphIds；若跨段，请列出所有相关段落。',
    '- 关联断言时必须原样返回 constraintId，并填写 sceneId、evidence 和 repairInstruction。',
    '- 只输出一个 JSON 对象，不要 Markdown 围栏。',
    structureLine,
  ].join('\n');
}

function trimReviewText(value, limit = 2400) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 48))}\n[review context truncated]`;
}

function compactReviewValue(value, limit = 700) {
  if (value == null) return value;
  const serialized = JSON.stringify(value);
  return serialized.length <= limit ? value : trimReviewText(serialized, limit);
}

function compactReviewStrings(values, maxItems = 8, maxChars = 260) {
  return (Array.isArray(values) ? values : []).slice(0, maxItems)
    .map((value) => trimReviewText(value, maxChars))
    .filter(Boolean);
}

function compactReviewKnowledge(values) {
  return (Array.isArray(values) ? values : []).slice(0, 10).map((fact) => ({
    factId: trimReviewText(fact?.factId || fact?.id || '', 100),
    proposition: trimReviewText(fact?.proposition || fact?.fact || '', 280),
    state: trimReviewText(fact?.state || '', 40),
  })).filter((fact) => fact.factId || fact.proposition);
}

function buildReviewContext(contextBundle) {
  const bundle = contextBundle && typeof contextBundle === 'object' ? contextBundle : {};
  const entryState = bundle.entryState && typeof bundle.entryState === 'object' ? bundle.entryState : null;
  const characterContexts = (Array.isArray(bundle.sceneCharacterContexts) ? bundle.sceneCharacterContexts : [])
    .flatMap((scene) => Array.isArray(scene?.characters) ? scene.characters : [])
    .slice(0, 12)
    .map((character) => ({
      id: character?.id || '',
      name: character?.name || '',
      personality: trimReviewText(character?.personality || '', 360),
      speechStyle: trimReviewText(character?.speechStyle || '', 360),
      currentOutfit: trimReviewText(character?.currentOutfit || '', 180),
    }));
  return {
    entryState: entryState ? {
      chapterRef: entryState.chapterRef || '',
      status: entryState.status || '',
      characters: (Array.isArray(entryState.characters) ? entryState.characters : []).slice(0, 12).map((character) => ({
        id: character?.id || '', name: character?.name || '', location: trimReviewText(character?.location || '', 180), physicalState: compactReviewStrings(character?.physicalState), emotionalState: compactReviewStrings(character?.emotionalState), knowledge: compactReviewKnowledge(character?.knowledge),
      })),
      assets: compactReviewValue((Array.isArray(entryState.assets) ? entryState.assets : []).slice(0, 16)),
      worldState: compactReviewValue(entryState.worldState || {}),
      unresolvedThreads: compactReviewValue((Array.isArray(entryState.unresolvedThreads) ? entryState.unresolvedThreads : []).slice(0, 12)),
    } : null,
    sceneContracts: (Array.isArray(bundle.sceneContracts) ? bundle.sceneContracts : []).slice(0, 12).map((scene) => ({
      sceneId: scene?.sceneId || '', pov: trimReviewText(scene?.pov || '', 100), when: trimReviewText(scene?.when || '', 140), location: trimReviewText(scene?.location || '', 180), mustHappen: compactReviewStrings(scene?.mustHappen), mustNotHappen: compactReviewStrings(scene?.mustNotHappen), informationBoundaries: compactReviewStrings(scene?.informationBoundaries),
    })),
    characters: characterContexts,
    nearbyTimeline: (Array.isArray(bundle.nearbyTimeline) ? bundle.nearbyTimeline : []).slice(-10).map((event) => ({
      when: trimReviewText(event?.when || '', 140), where: trimReviewText(event?.where || '', 180), participants: compactReviewStrings(event?.participants, 8, 100), description: trimReviewText(event?.description || event?.action || '', 420),
    })),
  };
}

function compactRetrievedContextForReview(retrievedContext) {
  if (!retrievedContext || typeof retrievedContext !== 'object') return null;
  const contextText = trimReviewText(retrievedContext.contextText || '', 2400);
  if (!contextText) return null;
  return {
    query: trimReviewText(retrievedContext.query || '', 360),
    contextText,
    wasTrimmed: retrievedContext.wasTrimmed === true || contextText !== String(retrievedContext.contextText || '').trim(),
  };
}

function buildReviewInput({ mode, userText, draft, retrievedContext, assertions }) {
  const paragraphs = splitIntoParagraphs(draft.text);
  const constraintPacket = chapterConstraintValidator.buildConstraintReviewPacket(draft, assertions || draft.assertions || []);
  return JSON.stringify({
    mode,
    userText,
    reviewContext: buildReviewContext(draft.contextBundle),
    retrievedContext: compactRetrievedContextForReview(retrievedContext),
    chapterDraft: {
      name: draft.name,
      displayName: draft.displayName,
      title: draft.title,
      summary: draft.summary,
      text: draft.text,
      eventLedger: draft.eventLedger || null,
    },
    eventLedger: draft.eventLedger || null,
    sourceUsage: draft.sourceUsage || [],
    criticalSourceRefs: draft.contextBundle?.criticalSourceRefs || [],
    stateVerifications: draft.stateVerifications || [],
    assertions: constraintPacket.assertions,
    scenes: constraintPacket.scenes,
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
  return list.some((issue) => !issue.reviewIncomplete && issue?.severity !== 'advisory' && isOpenReviewIssue(issue));
}

async function runWriterDraft(input, draftSystemPrompt, abortSignal, modelRuntime = createHarnessModelRuntime(), promptVersion = PROMPT_VERSIONS.chapter) {
  try {
    return ((await modelRuntime.invoke({
      subagentId: 'sa-writer',
      input,
      abortSignal,
      userLang: 'zh-CN',
      mcpClient: createDraftMcpClient(),
      systemPromptOverride: draftSystemPrompt,
    }, { role: 'writer', promptVersion })).output || '');
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

function buildSceneSystemPrompt(basePrompt) {
  return [
    String(basePrompt || '').trim(),
    '',
    '## Scene Drafting Override',
    '- 当前任务只写输入指定的一个场景，不得扩写其他场景，不得调用任何保存工具。',
    '- 只输出 JSON：{"sceneId":"场景ID","text":"场景小说正文","eventLedger":{"events":[]},"stateDelta":{},"constraintCoverage":["已满足的 constraintId"],"sourceUsage":[{"sourceRef":"来源引用","usedFor":"用途","evidenceParagraphIds":[]}]}。',
    '- text 只能包含小说正文，不要标题、解释、备注、审查意见、角色卡或工具结果。',
    '- 严格遵守 mustHappen、mustNotHappen、informationBoundaries 和上一场景出口状态。',
    '- 正文使用简体中文小说语境的全角标点。',
  ].join('\n');
}

function normalizeSceneDraft(outputText, sceneContract) {
  const parsed = parseJsonFromText(String(outputText || ''));
  const text = stripDraftTextWrappers(String(parsed?.text || '').trim());
  if (!text) throw new Error(`场景 ${sceneContract?.sceneId || ''} 缺少正文`);
  const contamination = detectDraftTextContamination(text);
  if (contamination) throw new Error(`场景正文包含非小说内容：${contamination}`);
  return {
    sceneId: String(parsed?.sceneId || sceneContract?.sceneId || '').trim(),
    title: sceneContract?.title || '',
    text,
    eventLedger: normalizeEventLedger(parsed?.eventLedger || {}),
    stateDelta: parsed?.stateDelta && typeof parsed.stateDelta === 'object' ? parsed.stateDelta : {},
    constraintCoverage: Array.isArray(parsed?.constraintCoverage)
      ? parsed.constraintCoverage.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    sourceUsage: Array.isArray(parsed?.sourceUsage)
      ? parsed.sourceUsage.map((item) => ({
          sourceRef: String(item?.sourceRef || item?.ref || '').trim(),
          sceneId: String(parsed?.sceneId || sceneContract?.sceneId || '').trim(),
          usedFor: String(item?.usedFor || item?.purpose || '').trim(),
          evidenceParagraphIds: Array.isArray(item?.evidenceParagraphIds)
            ? item.evidenceParagraphIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [],
        })).filter((item) => item.sourceRef)
      : [],
  };
}

function endingExcerpt(text, maxChars = 1200) {
  const value = String(text || '').trim();
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function sceneRoleplayPlan(roleplayPlan, sceneId) {
  return (Array.isArray(roleplayPlan?.scenePlans) ? roleplayPlan.scenePlans : [])
    .find((scene) => scene?.sceneId === sceneId) || null;
}

function buildSceneDraftInput({ targetChapter, userText, contextBundle, sceneContract, sceneIndex, sceneCount, previousScene, rollingState, roleplayPlan }) {
  const characterIds = new Set(sceneContract.appearingCharacterIds || []);
  const sceneCharacters = (Array.isArray(contextBundle?.sceneCharacterContexts) ? contextBundle.sceneCharacterContexts : [])
    .filter((scene) => scene?.nodeId === sceneContract.sceneId || (Array.isArray(scene?.characters) && scene.characters.some((character) => characterIds.has(character?.id))));
  const assertions = (Array.isArray(contextBundle?.assertions) ? contextBundle.assertions : [])
    .filter((assertion) => !assertion.sceneId || assertion.sceneId === sceneContract.sceneId);
  return JSON.stringify({
    task: 'draft_single_scene',
    targetChapter,
    userText,
    sceneIndex,
    sceneCount,
    sceneContract,
    assertions,
    continuity: sceneIndex === 0 ? contextBundle?.continuity || {} : {},
    previousScene: previousScene ? {
      sceneId: previousScene.sceneId,
      endingExcerpt: endingExcerpt(previousScene.text),
      stateDelta: previousScene.stateDelta || {},
    } : null,
    rollingState: rollingState || {},
    criticalSourceRefs: contextBundle?.criticalSourceRefs || [],
    characters: sceneCharacters,
    stylePacket: contextBundle?.stylePacket || {},
    roleplayPlan: sceneRoleplayPlan(roleplayPlan, sceneContract.sceneId),
    instruction: '只写当前场景并返回指定 JSON；不得越过下一个场景的边界。必须在动作、身体反应、信息边界或环境后果中落实 rollingState 与 continuityFacts，并在 sourceUsage 原样列出实际使用的关键 sourceRef。',
  }, null, 2);
}

function mergeStateDelta(rollingState, sceneId, stateDelta) {
  const merge = (base, patch) => {
    if (Array.isArray(patch)) return patch;
    if (!patch || typeof patch !== 'object') return patch == null ? base : patch;
    const next = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) next[key] = merge(next[key], value);
    return next;
  };
  const delta = stateDelta && typeof stateDelta === 'object' ? stateDelta : {};
  const merged = merge(rollingState && typeof rollingState === 'object' ? rollingState : {}, delta);
  merged._sceneDeltas = {
    ...(rollingState?._sceneDeltas || {}),
    [sceneId]: delta,
  };
  return merged;
}

function assembleSceneDrafts(sceneDrafts, targetChapter, contextBundle) {
  let paragraphOffset = 0;
  const prepared = sceneDrafts.map((scene) => {
    const paragraphs = splitIntoParagraphs(scene.text);
    const startOffset = paragraphOffset;
    const paragraphIds = paragraphs.map((_paragraph, index) => `p-${startOffset + index}`);
    const remapIds = (ids) => (Array.isArray(ids) ? ids : []).map((id) => {
      const match = /^p-(\d+)$/u.exec(String(id || ''));
      return match ? `p-${startOffset + Number(match[1])}` : String(id || '');
    }).filter(Boolean);
    paragraphOffset += paragraphs.length;
    const sourceUsage = (scene.sourceUsage || []).map((item) => ({ ...item, evidenceParagraphIds: remapIds(item.evidenceParagraphIds) }));
    const verifiedStateDelta = scene.verifiedStateDelta ? {
      ...scene.verifiedStateDelta,
      evidenceParagraphIds: remapIds(scene.verifiedStateDelta.evidenceParagraphIds),
      discrepancies: (scene.verifiedStateDelta.discrepancies || []).map((item) => ({ ...item, evidenceParagraphIds: remapIds(item.evidenceParagraphIds) })),
    } : null;
    return { ...scene, paragraphIds, sourceUsage, verifiedStateDelta };
  });
  const events = [];
  for (const scene of prepared) {
    for (const event of scene.eventLedger?.events || []) {
      events.push({ ...event, order: events.length + 1 });
    }
  }
  const purposes = (contextBundle?.sceneContracts || []).map((scene) => scene.purpose).filter(Boolean);
  return {
    name: targetChapter.name,
    displayName: targetChapter.displayName,
    title: targetChapter.titleHint || targetChapter.displayName,
    summary: purposes.slice(0, 4).join('；'),
    text: prepared.map((scene) => scene.text).join('\n\n'),
    eventLedger: { events },
    sceneDrafts: prepared,
    constraintCoverage: Array.from(new Set(prepared.flatMap((scene) => scene.constraintCoverage || []))),
    pendingStateDelta: Object.fromEntries(prepared.map((scene) => [scene.sceneId, scene.stateDelta || {}])),
    sourceUsage: prepared.flatMap((scene) => scene.sourceUsage || []),
    stateVerifications: prepared.map((scene) => scene.verifiedStateDelta).filter(Boolean),
  };
}

function shouldUseSceneGeneration({ settings, mode, editorContext, sceneContracts, riskProfile }) {
  if (mode === 'revise' && String(editorContext?.selectedText || '').trim()) return false;
  if (settings?.sceneGeneration === 'chapter') return false;
  if (settings?.sceneGeneration === 'scene') return true;
  if (settings?.mode === 'roleplay_driven') return true;
  if (riskProfile?.level === 'high' || riskProfile?.level === 'medium') return true;
  return Array.isArray(sceneContracts) && sceneContracts.length >= 2;
}

async function runSceneDrafts({ targetChapter, userText, contextBundle, roleplayPlan, writerSystemPrompt, abortSignal, onProgress, modelRuntime, verificationLevel }) {
  const sceneContracts = Array.isArray(contextBundle?.sceneContracts) ? contextBundle.sceneContracts : [];
  if (!sceneContracts.length) return null;
  const sceneSystemPrompt = buildSceneSystemPrompt(writerSystemPrompt);
  const drafts = [];
  let rollingState = contextBundle?.entryState || {};
  for (let index = 0; index < sceneContracts.length; index += 1) {
    const scene = sceneContracts[index];
    emitProgress(onProgress, `写作链：正在生成场景 ${index + 1}/${sceneContracts.length}「${scene.title || scene.sceneId}」。`, {
      stage: 'writer_scene_drafting',
      sceneId: scene.sceneId,
      sceneIndex: index,
      sceneCount: sceneContracts.length,
    });
    let parsed = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const input = buildSceneDraftInput({
          targetChapter,
          userText,
          contextBundle,
          sceneContract: scene,
          sceneIndex: index,
          sceneCount: sceneContracts.length,
          previousScene: drafts[drafts.length - 1] || null,
          rollingState,
          roleplayPlan,
        });
        parsed = normalizeSceneDraft(await runWriterDraft(input, sceneSystemPrompt, abortSignal, modelRuntime, PROMPT_VERSIONS.scene), scene);
        break;
      } catch (err) {
        lastError = err;
        emitProgress(onProgress, `写作链：场景「${scene.title || scene.sceneId}」生成失败，${attempt === 0 ? '正在重试。' : '准备退回整章生成。'}`, {
          stage: 'writer_scene_retry',
          sceneId: scene.sceneId,
          attempt: attempt + 1,
          error: err?.message || String(err),
        });
      }
    }
    if (!parsed) return { draft: null, error: lastError || new Error('scene generation failed'), completedScenes: drafts.length };
    if (chapterStateVerifier.shouldVerifyScene({
      verificationLevel,
      riskLevel: contextBundle?.riskProfile?.level,
    })) {
      emitProgress(onProgress, `写作链：正在独立核对场景 ${index + 1} 的出口状态。`, {
        stage: 'scene_state_verification',
        sceneId: scene.sceneId,
      });
      const verified = await chapterStateVerifier.verifySceneState({
        sceneDraft: parsed,
        sceneContract: scene,
        entryState: rollingState,
        sourceContext: { continuity: contextBundle?.continuity || {}, criticalSourceRefs: contextBundle?.criticalSourceRefs || [] },
        modelRuntime,
        abortSignal,
      });
      parsed.verifiedStateDelta = verified.verification;
      parsed.stateDelta = verified.verification.merged || parsed.stateDelta;
      parsed.sourceUsage = [...(parsed.sourceUsage || []), ...(verified.sourceUsage || []).map((item) => ({ ...item, verified: true }))];
    }
    drafts.push(parsed);
    rollingState = mergeStateDelta(rollingState, parsed.sceneId, parsed.stateDelta);
  }
  return {
    draft: assembleSceneDrafts(drafts, targetChapter, contextBundle),
    error: null,
    completedScenes: drafts.length,
  };
}

function stateVerificationIssues(draft) {
  const out = [];
  for (const verification of Array.isArray(draft?.stateVerifications) ? draft.stateVerifications : []) {
    for (const discrepancy of Array.isArray(verification?.discrepancies) ? verification.discrepancies : []) {
      if (verification.status !== 'blocking' || discrepancy?.severity !== 'blocking') continue;
      out.push({
        id: `state-${verification.sceneId || 'scene'}-${out.length}-${randomUUID()}`,
        constraintId: `state-${verification.sceneId || 'scene'}-${out.length + 1}`,
        source: 'state_verifier',
        sourceAgent: 'state_verifier',
        category: 'state_consistency',
        severity: 'blocking',
        status: 'open',
        sceneId: verification.sceneId || '',
        summary: discrepancy.summary || '场景出口状态与确定性上下文冲突',
        note: discrepancy.summary || '场景出口状态与确定性上下文冲突',
        evidence: discrepancy.deterministicSourceRef || '',
        paragraphIds: discrepancy.evidenceParagraphIds || [],
        reviewIncomplete: false,
      });
    }
  }
  return out;
}

function computeCriticalSourceCoverage(contextBundle, sourceUsage, draft) {
  const required = Array.isArray(contextBundle?.criticalSourceRefs) ? contextBundle.criticalSourceRefs : [];
  const used = new Set((Array.isArray(sourceUsage) ? sourceUsage : []).map((item) => String(item?.sourceRef || '').trim()).filter(Boolean));
  const verified = new Set((Array.isArray(sourceUsage) ? sourceUsage : [])
    .filter((item) => item?.verified === true && Array.isArray(item?.evidenceParagraphIds) && item.evidenceParagraphIds.length)
    .map((item) => String(item?.sourceRef || '').trim()).filter(Boolean));
  const coveredConstraints = new Set(Array.isArray(draft?.constraintCoverage) ? draft.constraintCoverage : []);
  for (const assertion of Array.isArray(contextBundle?.assertions) ? contextBundle.assertions : []) {
    if (!coveredConstraints.has(assertion.constraintId)) continue;
    for (const ref of Array.isArray(assertion.sourceRefs) ? assertion.sourceRefs : []) {
      if (!ref?.ref) continue;
      used.add(ref.ref);
    }
  }
  const stateVerified = (Array.isArray(draft?.stateVerifications) ? draft.stateVerifications : [])
    .some((item) => item?.status === 'verified' && Number(item?.confidence) >= 0.7 && Array.isArray(item?.evidenceParagraphIds) && item.evidenceParagraphIds.length);
  if (stateVerified) {
    for (const ref of Array.isArray(contextBundle?.entryState?.sourceRefs) ? contextBundle.entryState.sourceRefs : []) {
      if (!ref?.ref) continue;
      used.add(ref.ref);
      verified.add(ref.ref);
    }
    if (contextBundle?.entryState?.chapterRef) {
      const chapterRef = `chapter:${contextBundle.entryState.chapterRef}`;
      used.add(chapterRef);
      verified.add(chapterRef);
    }
  }
  const missing = required.map((item) => item.ref).filter((ref) => ref && !used.has(ref));
  return { required: required.length, used: required.length - missing.length, verified: required.filter((item) => verified.has(item.ref)).length, missing };
}

async function reverifyRepairedDraftState({ draft, contextBundle, modelRuntime, abortSignal }) {
  if (!Array.isArray(draft?.stateVerifications) || !draft.stateVerifications.length) return draft;
  const combinedContract = {
    sceneId: 'chapter',
    chapterRef: draft.name,
    mustHappen: (contextBundle?.sceneContracts || []).flatMap((scene) => scene.mustHappen || []),
    mustNotHappen: (contextBundle?.sceneContracts || []).flatMap((scene) => scene.mustNotHappen || []),
    informationBoundaries: (contextBundle?.sceneContracts || []).flatMap((scene) => scene.informationBoundaries || []),
    continuityFacts: (contextBundle?.sceneContracts || []).flatMap((scene) => scene.continuityFacts || []),
    sourceRefs: contextBundle?.criticalSourceRefs || [],
  };
  const declared = Object.values(draft.pendingStateDelta || {}).reduce((merged, item) => ({
    ...merged,
    ...(item && typeof item === 'object' ? item : {}),
  }), {});
  const verified = await chapterStateVerifier.verifySceneState({
    sceneDraft: { sceneId: 'chapter', text: draft.text, stateDelta: declared },
    sceneContract: combinedContract,
    entryState: contextBundle?.entryState || {},
    sourceContext: { continuity: contextBundle?.continuity || {}, criticalSourceRefs: contextBundle?.criticalSourceRefs || [] },
    modelRuntime,
    abortSignal,
  });
  return {
    ...draft,
    stateVerifications: [verified.verification],
    pendingStateDelta: { chapter: verified.verification.merged || declared },
    sourceUsage: [...(draft.sourceUsage || []), ...(verified.sourceUsage || []).map((item) => ({ ...item, verified: true }))],
  };
}

function buildLocalRepairSystemPrompt(basePrompt) {
  return [
    String(basePrompt || '').trim(),
    '',
    '## Local Repair Override',
    '- 只修复输入 targets 中列出的段落，不得重写整章，不得修改未列出的段落。',
    '- 只输出 JSON：{"replacements":[{"paragraphId":"p-N","text":"修复后的完整段落"}]}。',
    '- 若无法安全局部修复，返回空 replacements，不要臆造。',
    '- replacement text 只能是小说正文，不得包含解释、备注或工具结果。',
  ].join('\n');
}

async function runLocalIssueRepair({ draft, issues, repairRound, writerBasePrompt, abortSignal, modelRuntime }) {
  const request = chapterConstraintValidator.buildLocalRepairRequest({ draft, issues, repairRound });
  if (!request.targets.length) return { draft, applied: 0, reason: 'no_scoped_paragraphs' };
  let parsed;
  try {
    const output = await runWriterDraft(
      JSON.stringify(request, null, 2),
      buildLocalRepairSystemPrompt(writerBasePrompt),
      abortSignal,
      modelRuntime,
      PROMPT_VERSIONS.repair
    );
    parsed = parseJsonFromText(output);
  } catch (err) {
    return { draft, applied: 0, reason: err?.message || String(err) };
  }
  const replacements = Array.isArray(parsed?.replacements) ? parsed.replacements : [];
  for (const replacement of replacements) {
    if (/\n\s*\n/u.test(String(replacement?.text || replacement?.replacement || ''))) {
      return { draft, applied: 0, reason: '局部修复返回了多个段落，已拒绝以保护段落边界' };
    }
    const contamination = detectDraftTextContamination(replacement?.text || replacement?.replacement || '');
    if (contamination) return { draft, applied: 0, reason: `局部修复包含非小说内容：${contamination}` };
  }
  return chapterConstraintValidator.applyParagraphReplacements(draft, replacements, { targets: request.targets });
}

async function runReviewer(subagentId, input, sourceAgent, systemPromptOverride, abortSignal, modelRuntime) {
  const result = await modelRuntime.invoke({
    subagentId,
    input,
    abortSignal,
    userLang: 'zh-CN',
    mcpClient,
    systemPromptOverride,
  }, { role: sourceAgent, promptVersion: PROMPT_VERSIONS.review });
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
  const normalized = normalizeIssues(parsed?.issues, sourceAgent);
  let hardConstraintIds = new Set();
  try {
    const packet = JSON.parse(input);
    hardConstraintIds = new Set((packet.assertions || [])
      .filter((assertion) => assertion?.severity === 'blocking' && assertion?.deterministic === true)
      .map((assertion) => assertion.constraintId));
  } catch { /* malformed review input is handled by the reviewer path */ }
  return normalized.map((issue) => {
    if (issue.reviewIncomplete || issue.severity !== 'blocking') return issue;
    return hardConstraintIds.has(issue.constraintId)
      ? issue
      : { ...issue, severity: 'advisory', category: issue.category || 'model_inferred' };
  });
}

async function runReviewerWithFallback(subagentId, input, sourceAgent, systemPromptOverride, abortSignal, modelRuntime) {
  try {
    return await runReviewer(subagentId, input, sourceAgent, systemPromptOverride, abortSignal, modelRuntime);
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
  const blocking = allIssues.filter((issue) => !issue.reviewIncomplete && issue?.severity !== 'advisory' && isOpenReviewIssue(issue));
  const advisory = allIssues.filter((issue) => !issue.reviewIncomplete && issue?.severity === 'advisory' && isOpenReviewIssue(issue));

  if (!incomplete.length && !blocking.length && !advisory.length) {
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
  if (advisory.length) {
    if (lines.length) lines.push('');
    lines.push('以下是非阻塞建议，可按需要处理：');
    advisory.forEach((issue, index) => {
      lines.push(`${index + 1}. ${formatReviewIssueLabel(issue)} ${issue.summary || issue.note}${issue.detail ? `：${issue.detail}` : ''}`);
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
    const reviewIncomplete = annotation?.kind === 'review_incomplete';
    const explicitBlocking = String(annotation?.severity || '').trim() === 'blocking';
    const confidence = Number.isFinite(Number(annotation?.confidence))
      ? Math.max(0, Math.min(1, Number(annotation.confidence)))
      : undefined;
    out.push({
      id: `${sourceAgent}-${out.length}-${randomUUID()}`,
      source: sourceAgent,
      sourceAgent,
      category: annotation?.kind ? String(annotation.kind) : sourceAgent,
      severity: reviewIncomplete || explicitBlocking ? 'blocking' : 'advisory',
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
      confidence,
      evidence: annotation?.evidence ? String(annotation.evidence) : undefined,
      excerpt: compactDraftExcerpt(firstParagraph?.text || '', 90),
      reviewIncomplete,
    });
  }
  return normalizeReviewIssues(out, { paragraphs, source: sourceAgent, defaultSeverity: 'advisory' })
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

async function runAdvisoryReviewer({ subagentId, input, sourceAgent, abortSignal, modelRuntime }) {
  try {
    const result = await modelRuntime.invoke({
      subagentId,
      input,
      abortSignal,
      userLang: 'zh-CN',
      mcpClient,
    }, { role: sourceAgent, promptVersion: PROMPT_VERSIONS.advisory });
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

async function runDraftAdvisoryReviews(draft, abortSignal, onProgress, modelRuntime, options = {}) {
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
  const proseTask = runAdvisoryReviewer({
    subagentId: 'sa-prose-quality',
    input: JSON.stringify(reviewPayload),
    sourceAgent: 'prose_quality',
    abortSignal,
    modelRuntime,
  });
  const readStyleMemory = typeof options.readStyleMemory === 'function'
    ? options.readStyleMemory
    : readStyleMemoryForAdvisory;
  const styleMemoryTask = readStyleMemory();
  const paragraphFunctionPayload = buildParagraphFunctionReviewPayload(paragraphs, '审查章节草稿的一句一段、机械拆段和自然段功能问题。');
  const paragraphFunctionTask = Array.isArray(paragraphFunctionPayload.candidates) && paragraphFunctionPayload.candidates.length
    ? runAdvisoryReviewer({
      subagentId: 'sa-paragraph-function-reviewer',
      input: JSON.stringify(paragraphFunctionPayload),
      sourceAgent: 'paragraph_function',
      abortSignal,
      modelRuntime,
    })
    : Promise.resolve([]);
  const styleMemory = await styleMemoryTask;
  const styleTask = styleMemory
    ? runAdvisoryReviewer({
      subagentId: 'sa-style-checker',
      input: JSON.stringify({ styleMemory, paragraphs: reviewPayload.paragraphs }),
      sourceAgent: 'style',
      abortSignal,
      modelRuntime,
    })
    : Promise.resolve([]);
  const [proseRaw, styleRaw, paragraphFunctionRaw] = await Promise.all([proseTask, styleTask, paragraphFunctionTask]);
  const proseIssues = normalizeAdvisoryAnnotations(paragraphs, proseRaw, 'prose_quality');
  const styleIssues = normalizeAdvisoryAnnotations(paragraphs, styleRaw, 'style');
  const paragraphFunctionIssues = normalizeAdvisoryAnnotations(paragraphs, paragraphFunctionRaw, 'paragraph_function');

  return mergeAdvisoryIssues(
    [...proseIssues, ...styleIssues, ...paragraphFunctionIssues],
    [...deterministic, ...paragraphFunctionDeterministic]
  );
}

function formatAdvisoryIssues(advisoryIssues) {
  const list = Array.isArray(advisoryIssues) ? advisoryIssues : [];
  if (!list.length) {
    return '文风、AI 味和段落功能审查未发现建议项。';
  }
  const blockingCount = list.filter((issue) => issue.severity !== 'advisory').length;
  const lines = [blockingCount > 0
    ? `发现 ${list.length} 处文风/行文/段落功能问题，其中 ${blockingCount} 处阻塞写入：`
    : `发现 ${list.length} 处文风/行文/段落功能建议；它们不会阻塞写入，可按需要处理：`];
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

async function reviewExistingChapterDraft({ mode = 'review', userText = '', draft, retrievedContext, abortSignal, onProgress, modelRuntime: modelRuntimeOverride }) {
  if (!draft?.text) return { issues: [], blockingIssues: [], advisoryIssues: [] };
  const modelRuntime = createHarnessModelRuntime(modelRuntimeOverride);
  const characterReviewer = await subagentsStore.getSubagent('sa-character-reviewer');
  const timelineReviewer = await subagentsStore.getSubagent('sa-timeline-guardian');
  emitProgress(onProgress, '写作链：正在复审修订后的受影响章节草稿。', { stage: 'chapter_review_rerun' });
  const reviewInput = buildReviewInput({
    mode,
    userText,
    draft,
    retrievedContext: retrievedContext || null,
    assertions: draft.assertions || [],
  });
  const [constraintVerification, characterIssues, timelineIssues, advisoryIssues] = await Promise.all([
    chapterConstraintVerifier.verifyChapterConstraints({
      draft,
      assertions: draft.assertions || [],
      modelRuntime,
      abortSignal,
    }),
    runReviewerWithFallback(
      'sa-character-reviewer',
      reviewInput,
      'character_world',
      buildReviewerSystemPrompt(characterReviewer?.systemPrompt || '', 'character_world'),
      abortSignal,
      modelRuntime
    ),
    runReviewerWithFallback(
      'sa-timeline-guardian',
      reviewInput,
      'timeline',
      buildReviewerSystemPrompt(timelineReviewer?.systemPrompt || '', 'timeline'),
      abortSignal,
      modelRuntime
    ),
    runDraftAdvisoryReviews(draft, abortSignal, onProgress, modelRuntime),
  ]);
  draft.constraintVerifications = constraintVerification.checks || [];
  const blockingIssues = mergeReviewIssues(constraintVerification.issues || [], characterIssues, timelineIssues, advisoryIssues);
  return {
    issues: blockingIssues,
    blockingIssues,
    advisoryIssues,
    constraintVerifications: constraintVerification.checks || [],
    verificationStatus: constraintVerification.status || 'blocked',
  };
}

async function verifyChapterContentStrict({ name, displayName, title, text, userText = '', editorContext = null, abortSignal, onProgress, runtimeDeps = {} } = {}) {
  const chapterName = String(name || '').trim();
  const chapterText = String(text || '');
  if (!chapterName || !chapterText.trim()) {
    return {
      status: 'blocked',
      contentHash: chapterContentHash(chapterText),
      checks: [],
      issues: [buildReviewFailureIssue('constraint_verifier', '严格验证缺少章节文件名或正文。')],
      draft: null,
    };
  }
  emitProgress(onProgress, '写作链：正在为章节变更编译严格验证上下文。', { stage: 'strict_write_context' });
  const targetChapter = {
    name: chapterName,
    displayName: String(displayName || title || chapterName),
    titleHint: String(title || displayName || chapterName),
    status: 'resolved',
    source: 'strict_write_gate',
  };
  const callTool = runtimeDeps.callTool || ((payload) => mcpClient.callTool(payload));
  let contextBundle;
  try {
    contextBundle = await chapterContextCompiler.compileChapterContext({
      targetChapter,
      userText,
      mode: 'revise',
      editorContext,
      settings: { harnessMode: 'adaptive', contextDepth: 'auto', sceneGeneration: 'chapter', verificationLevel: 'strict' },
      callTool,
      novelDir: runtimeDeps.novelDir || null,
    });
  } catch (err) {
    return {
      status: 'blocked',
      contentHash: chapterContentHash(chapterText),
      checks: [],
      issues: [buildReviewFailureIssue('constraint_verifier', `严格验证上下文编译失败：${err?.message || String(err)}`)],
      draft: { name: chapterName, displayName: targetChapter.displayName, title: targetChapter.titleHint, text: chapterText },
    };
  }
  const modelRuntime = createHarnessModelRuntime(runtimeDeps.modelRuntime || {});
  let draft = {
    name: chapterName,
    displayName: targetChapter.displayName,
    title: targetChapter.titleHint,
    summary: '',
    text: chapterText,
    contextBundle,
    sceneContracts: contextBundle.sceneContracts || [],
    assertions: contextBundle.assertions || [],
    pendingStateDelta: {},
    stateVerifications: [],
    sourceUsage: [],
  };
  emitProgress(onProgress, '写作链：正在独立核对章节变更后的状态与逐条约束。', { stage: 'strict_write_verification' });
  const stateVerified = await chapterStateVerifier.verifySceneState({
    sceneDraft: { sceneId: 'chapter', text: chapterText, stateDelta: {} },
    sceneContract: {
      sceneId: 'chapter',
      sourceRefs: contextBundle.criticalSourceRefs || [],
      mustHappen: (contextBundle.sceneContracts || []).flatMap((scene) => scene.mustHappen || []),
      mustNotHappen: (contextBundle.sceneContracts || []).flatMap((scene) => scene.mustNotHappen || []),
      informationBoundaries: (contextBundle.sceneContracts || []).flatMap((scene) => scene.informationBoundaries || []),
    },
    entryState: contextBundle.entryState || {},
    sourceContext: { continuity: contextBundle.continuity || {}, criticalSourceRefs: contextBundle.criticalSourceRefs || [] },
    modelRuntime,
    abortSignal,
  });
  draft.stateVerifications = [stateVerified.verification];
  draft.sourceUsage = (stateVerified.sourceUsage || []).map((item) => ({ ...item, verified: true }));
  const reviewed = await reviewExistingChapterDraft({
    mode: 'strict_write',
    userText,
    draft,
    retrievedContext: contextBundle.retrievedContext || null,
    abortSignal,
    onProgress,
    modelRuntime,
  });
  const issues = mergeReviewIssues(stateVerificationIssues(draft), reviewed.issues || []);
  const blocked = hasBlockingReviewIssues(issues);
  return {
    status: blocked ? 'blocked' : 'passed',
    contentHash: chapterContentHash(chapterText),
    checks: reviewed.constraintVerifications || [],
    issues,
    draft,
    modelCalls: modelRuntime.calls,
  };
}

async function suggestLegacyTargetChapter(pendingChapterDraft, editorContext) {
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

function toRoleplayContext(contextBundle) {
  if (!contextBundle) return null;
  return {
    ...contextBundle,
    outlineNodes: Array.isArray(contextBundle?.outlineIntent?.matchingNodes)
      ? contextBundle.outlineIntent.matchingNodes
      : [],
    sceneContracts: Array.isArray(contextBundle.sceneContracts) ? contextBundle.sceneContracts : [],
    sceneCharacterContexts: Array.isArray(contextBundle.sceneCharacterContexts) ? contextBundle.sceneCharacterContexts : [],
    nearbyTimeline: Array.isArray(contextBundle.nearbyTimeline) ? contextBundle.nearbyTimeline : [],
    retrievedContext: contextBundle.retrievedContext || null,
  };
}

function formatHarnessBlockedText(targetChapter, diagnostics) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];
  const lines = [
    '自适应写作链已暂停：继续生成可能会写错章节或违反确定性资料。',
    '',
  ];
  for (const item of items.slice(0, 8)) lines.push(`- ${item.message || item.code || '未命名问题'}`);
  if (targetChapter?.displayName || targetChapter?.name) {
    lines.push('', `当前解析目标：${targetChapter.displayName || targetChapter.name}`);
  }
  lines.push('', '本轮没有生成或写入正文，也没有更新摘要、时间线或角色记忆。');
  return lines.join('\n');
}

function createHarnessTrace(writingConfig) {
  return {
    traceId: randomUUID(),
    harnessMode: writingConfig?.harnessMode === 'legacy' ? 'legacy' : 'adaptive',
    contextDepth: writingConfig?.contextDepth || 'auto',
    sceneGeneration: writingConfig?.sceneGeneration || 'auto',
    verificationLevel: writingConfig?.verificationLevel || 'auto',
    startedAt: new Date().toISOString(),
    stages: [],
    sourceRefs: [],
    diagnostics: [],
    trimmed: [],
    cacheHit: false,
    fallbackReason: '',
    repairRounds: 0,
    promptVersions: { ...PROMPT_VERSIONS },
    modelCalls: [],
    usage: {},
    riskProfile: {},
    stateVerifications: [],
    sourceUsage: [],
    repairImpact: [],
  };
}

function addTraceStage(trace, name, startedAt, status = 'done', detail = {}) {
  trace.stages.push({ name, durationMs: Math.max(0, Date.now() - startedAt), status, detail });
}

function finishHarnessTrace(trace) {
  return normalizeDraftTrace({ ...trace, completedAt: new Date().toISOString() });
}

function emitProgress(onProgress, message, detail = {}) {
  if (typeof onProgress !== 'function') return;
  try { onProgress({ message, ...detail }); } catch { /* progress is best-effort */ }
}

async function generateChapterDraft({ mode, userText, pendingChapterDraft, editorContext, abortSignal, roleplayOptions, onProgress, onRoleplayEvent, modelRuntime: modelRuntimeOverride, runtimeDeps = {} }) {
  const config = await appConfig.load();
  const writingConfig = { ...(config?.writing || appConfig.DEFAULT_WRITING_CONFIG), ...(runtimeDeps.writingConfig || {}) };
  const adaptive = writingConfig.harnessMode !== 'legacy';
  const modelRuntime = createHarnessModelRuntime(modelRuntimeOverride);
  const harnessCallTool = runtimeDeps.callTool || ((payload) => mcpClient.callTool(payload));
  const trace = createHarnessTrace(writingConfig);
  trace.modelCalls = modelRuntime.calls;
  emitProgress(onProgress, mode === 'revise' ? '写作链：正在定位当前草稿和修订目标。' : '写作链：正在定位下一章目标。', { stage: 'chapter_target' });
  const targetStartedAt = Date.now();
  const targetChapter = adaptive
    ? await chapterTargetResolver.resolveChapterTarget({
        mode,
        userText,
        pendingChapterDraft,
        editorContext,
        callTool: harnessCallTool,
      })
    : await suggestLegacyTargetChapter(pendingChapterDraft, editorContext);
  trace.targetSource = targetChapter?.source || (adaptive ? 'adaptive_unknown' : 'legacy');
  addTraceStage(trace, 'chapter_target', targetStartedAt, targetChapter?.status === 'blocked' ? 'blocked' : 'done', {
    source: trace.targetSource,
    chapterName: targetChapter?.name || '',
  });
  if (targetChapter?.status === 'blocked') {
    trace.diagnostics.push(...(targetChapter.diagnostics || []));
    const harnessTrace = finishHarnessTrace(trace);
    emitProgress(onProgress, '写作链：目标章节存在冲突，已暂停。', { stage: 'harness_trace', harnessTrace });
    return {
      draft: null,
      blockingIssues: [],
      advisoryIssues: [],
      issues: [],
      harnessBlocked: true,
      targetResolution: targetChapter,
      harnessTrace,
      assistantText: formatHarnessBlockedText(targetChapter, targetChapter.diagnostics),
    };
  }
  emitProgress(onProgress, `写作链：目标章节为 ${targetChapter.displayName || targetChapter.name}，开始读取大纲和时间线。`, { stage: 'chapter_context', chapterName: targetChapter.name });
  const contextStartedAt = Date.now();
  let contextBundle = null;
  let compactContext = null;
  if (adaptive) {
    try {
      contextBundle = await chapterContextCompiler.compileChapterContext({
        targetChapter,
        userText,
        mode,
        editorContext,
        settings: writingConfig,
        callTool: harnessCallTool,
        novelDir: runtimeDeps.novelDir || null,
      });
      compactContext = toRoleplayContext(contextBundle);
      trace.sourceRefs = contextBundle.sourceRefs || [];
      trace.riskProfile = contextBundle.riskProfile || {};
      trace.contextDepth = contextBundle.contextSpec?.depth || trace.contextDepth;
      trace.stateSnapshot = contextBundle.entryState
        ? { chapterRef: contextBundle.entryState.chapterRef || '', status: contextBundle.entryState.status || 'valid' }
        : { chapterRef: '', status: 'missing' };
      trace.diagnostics.push(...(contextBundle.diagnostics || []));
      trace.trimmed = contextBundle.trimmed || [];
      trace.cacheHit = contextBundle.cache?.hit === true;
      addTraceStage(trace, 'context_compile', contextStartedAt, 'done', {
        cacheHit: trace.cacheHit,
        sourceCount: trace.sourceRefs.length,
        sceneCount: contextBundle.sceneContracts?.length || 0,
      });
    } catch (err) {
      trace.fallbackReason = `context_compile_failed: ${err?.message || String(err)}`;
      addTraceStage(trace, 'context_compile', contextStartedAt, 'fallback', { error: err?.message || String(err) });
      emitProgress(onProgress, '写作链：自适应上下文编译失败，正在使用兼容写作上下文。', { stage: 'context_fallback' });
      compactContext = await buildCompactWritingContext(targetChapter, userText);
    }
  } else {
    compactContext = await buildCompactWritingContext(targetChapter, userText);
    addTraceStage(trace, 'context_compile', contextStartedAt, 'legacy', {});
  }
  const blockingContextDiagnostics = (contextBundle?.diagnostics || []).filter((item) => item.severity === 'blocking');
  if (blockingContextDiagnostics.length) {
    const harnessTrace = finishHarnessTrace(trace);
    emitProgress(onProgress, '写作链：确定性上下文存在冲突，已暂停。', { stage: 'harness_trace', harnessTrace });
    return {
      draft: null,
      blockingIssues: [],
      advisoryIssues: [],
      issues: [],
      harnessBlocked: true,
      contextBundle,
      harnessTrace,
      assistantText: formatHarnessBlockedText(targetChapter, blockingContextDiagnostics),
    };
  }
  let roleplayPlan = null;
  let profileWarnings = [];
  if (writingConfig.mode === 'roleplay_driven' && !roleplayOptions?.disableRoleplay) {
    if (roleplayOptions?.prebuiltRoleplayPlan) {
      roleplayPlan = roleplayOptions.prebuiltRoleplayPlan;
      profileWarnings = Array.isArray(roleplayOptions?.profileWarnings) ? roleplayOptions.profileWarnings : [];
      emitProgress(onProgress, '写作链：继续使用已审阅的角色驱动规划。', { stage: 'roleplay_resume' });
    } else {
      emitProgress(onProgress, '写作链：角色驱动模式已启用，进入 actor/director 规划。', { stage: 'roleplay_start' });
      const roleplayResult = await chapterRoleplayService.buildRoleplayPlan({
        targetChapter,
        compactContext,
        interactionLevel: writingConfig.roleplayInteractionLevel || 'director_mediated',
        maxInteractionRounds: writingConfig.roleplayMaxInteractionRounds,
        ignoreProfileGate: !!roleplayOptions?.ignoreProfileGate,
        pauseOnRisk: writingConfig.roleplayPauseOnRisk !== false && !roleplayOptions?.ignoreRiskGate,
        userText,
        abortSignal,
        onProgress,
        onRoleplayEvent,
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
      if (roleplayResult?.status === 'risk_blocked') {
        return {
          draft: null,
          blockingIssues: [],
          roleplayRiskBlocked: true,
          roleplayRisk: roleplayResult.riskDecision,
          roleplayPlan: roleplayResult.roleplayPlan || null,
          profileWarnings: Array.isArray(roleplayResult.profileWarnings) ? roleplayResult.profileWarnings : [],
          assistantText: formatRoleplayRiskText(roleplayResult.riskDecision),
        };
      }
      roleplayPlan = roleplayResult?.roleplayPlan || null;
      profileWarnings = Array.isArray(roleplayResult?.profileWarnings) ? roleplayResult.profileWarnings : [];
    }
  }
  const input = buildDraftInput({
    mode,
    userText,
    pendingChapterDraft,
    targetChapter,
    editorContext,
    compactContext,
    contextBundle,
    roleplayPlan,
    profileWarnings,
  });
  const writer = await subagentsStore.getSubagent('sa-writer');
  const draftSystemPrompt = buildDraftSystemPrompt(writer?.systemPrompt || '');
  const generationStartedAt = Date.now();
  const useSceneGeneration = adaptive && contextBundle && shouldUseSceneGeneration({
    settings: writingConfig,
    mode,
    editorContext,
    sceneContracts: contextBundle.sceneContracts,
    riskProfile: contextBundle.riskProfile,
  });
  const adaptivePolicy = resolveAdaptivePolicy({ riskProfile: contextBundle?.riskProfile, settings: writingConfig });
  trace.verificationLevel = adaptivePolicy.verificationLevel;
  trace.sceneGeneration = writingConfig.sceneGeneration === 'auto' ? adaptivePolicy.sceneGeneration : writingConfig.sceneGeneration;
  let draftOutput = '';
  let draft;
  let generationError = null;
  if (useSceneGeneration) {
    const sceneResult = await runSceneDrafts({
      targetChapter,
      userText,
      contextBundle,
      roleplayPlan,
      writerSystemPrompt: writer?.systemPrompt || '',
      abortSignal,
      onProgress,
      modelRuntime,
      verificationLevel: adaptivePolicy.verificationLevel,
    });
    draft = sceneResult?.draft || null;
    generationError = sceneResult?.error || null;
    if (!draft) {
      trace.fallbackReason = `scene_generation_failed: ${generationError?.message || 'unknown'}`;
      emitProgress(onProgress, '写作链：逐场景生成未完成，正在使用同一份上下文退回整章生成。', { stage: 'writer_scene_fallback' });
    }
  }
  if (!draft) {
    emitProgress(onProgress, '写作链：writer 正在把规划扩写成章节草稿。', { stage: 'writer_drafting', chapterName: targetChapter.name });
    try {
      draftOutput = await runWriterDraft(input, draftSystemPrompt, abortSignal, modelRuntime);
      draft = normalizeDraft(draftOutput, targetChapter);
    } catch (err) {
      generationError = err;
    }
  }
  if (!draft) {
    addTraceStage(trace, 'writer_generation', generationStartedAt, 'failed', { error: generationError?.message || String(generationError || '') });
    const harnessTrace = finishHarnessTrace(trace);
    return {
      draft: null,
      blockingIssues: [],
      advisoryIssues: [],
      issues: [],
      draftGenerationFailed: true,
      draftGenerationError: generationError?.message || String(generationError || ''),
      harnessTrace,
      assistantText: formatDraftGenerationFailureText(generationError, targetChapter),
    };
  }
  addTraceStage(trace, 'writer_generation', generationStartedAt, 'done', {
    mode: useSceneGeneration && draft.sceneDrafts ? 'scene' : 'chapter',
    sceneCount: draft.sceneDrafts?.length || 0,
  });
  draft = {
    ...draft,
    draftId: pendingChapterDraft?.draftId || randomUUID(),
    baseContent: pendingChapterDraft?.baseContent || (mode === 'revise' ? String(editorContext?.content || '') : ''),
    contextBundle: contextBundle || null,
    sceneContracts: contextBundle?.sceneContracts || [],
    assertions: contextBundle?.assertions || [],
    pendingStateDelta: draft.pendingStateDelta || {},
  };
  if (!draft.sceneDrafts && chapterStateVerifier.shouldVerifyScene({
    verificationLevel: adaptivePolicy.verificationLevel,
    riskLevel: contextBundle?.riskProfile?.level,
  })) {
    emitProgress(onProgress, '写作链：正在独立核对整章出口状态。', { stage: 'chapter_state_verification' });
    const verified = await chapterStateVerifier.verifySceneState({
      sceneDraft: {
        sceneId: 'chapter',
        text: draft.text,
        stateDelta: draft.pendingStateDelta?.chapter || {},
      },
      sceneContract: contextBundle?.sceneContracts?.[0] || { sceneId: 'chapter' },
      entryState: contextBundle?.entryState || {},
      sourceContext: { continuity: contextBundle?.continuity || {}, criticalSourceRefs: contextBundle?.criticalSourceRefs || [] },
      modelRuntime,
      abortSignal,
    });
    draft.stateVerifications = [verified.verification];
    draft.pendingStateDelta = { chapter: verified.verification.merged || draft.pendingStateDelta?.chapter || {} };
    draft.sourceUsage = [...(draft.sourceUsage || []), ...(verified.sourceUsage || []).map((item) => ({ ...item, verified: true }))];
  }
  const characterReviewer = await subagentsStore.getSubagent('sa-character-reviewer');
  const timelineReviewer = await subagentsStore.getSubagent('sa-timeline-guardian');
  let blockingIssues = [];
  for (let revisionIndex = 0; revisionIndex <= MAX_AUTO_REVIEW_REVISIONS; revisionIndex += 1) {
    emitProgress(onProgress, `写作链：第 ${revisionIndex + 1} 轮人设/时空审查正在运行。`, {
      stage: 'chapter_review',
      revisionIndex,
    });
    const reviewInput = buildReviewInput({
      mode,
      userText,
      draft,
      retrievedContext: compactContext?.retrievedContext || null,
      assertions: draft.assertions || [],
    });
    const [constraintVerification, characterIssues, timelineIssues] = await Promise.all([
      chapterConstraintVerifier.verifyChapterConstraints({
        draft,
        assertions: draft.assertions || [],
        modelRuntime,
        abortSignal,
      }),
      runReviewerWithFallback(
        'sa-character-reviewer',
        reviewInput,
        'character_world',
        buildReviewerSystemPrompt(characterReviewer?.systemPrompt || '', 'character_world'),
        abortSignal,
        modelRuntime
      ),
      runReviewerWithFallback(
        'sa-timeline-guardian',
        reviewInput,
        'timeline',
        buildReviewerSystemPrompt(timelineReviewer?.systemPrompt || '', 'timeline'),
        abortSignal,
        modelRuntime
      ),
    ]);
    draft.constraintVerifications = constraintVerification.checks || [];
    blockingIssues = [
      ...stateVerificationIssues(draft),
      ...(constraintVerification.issues || []),
      ...characterIssues,
      ...timelineIssues,
    ];
    if (!hasActionableReviewIssues(blockingIssues) || revisionIndex >= MAX_AUTO_REVIEW_REVISIONS) break;
    emitProgress(onProgress, '写作链：审查发现硬伤，writer 正在自动修订一轮。', {
      stage: 'writer_revision',
      revisionIndex: revisionIndex + 1,
    });
    const repairResult = await runLocalIssueRepair({
      draft,
      issues: blockingIssues,
      repairRound: revisionIndex + 1,
      writerBasePrompt: writer?.systemPrompt || '',
      abortSignal,
      modelRuntime,
    });
    if (!repairResult.applied) {
      emitProgress(onProgress, '写作链：硬问题缺少可靠段落定位，已停止自动改写并保留问题供审阅。', {
        stage: 'writer_revision_skipped',
        reason: repairResult.reason || 'no_replacements',
      });
      break;
    }
    draft = repairResult.draft;
    draft = await reverifyRepairedDraftState({ draft, contextBundle, modelRuntime, abortSignal });
    trace.repairRounds = revisionIndex + 1;
    if (repairResult.impact) trace.repairImpact.push({ round: revisionIndex + 1, ...repairResult.impact });
  }
  trace.sourceUsage = Array.isArray(draft.sourceUsage) ? draft.sourceUsage : [];
  trace.stateVerifications = Array.isArray(draft.stateVerifications) ? draft.stateVerifications : [];
  trace.constraintVerifications = Array.isArray(draft.constraintVerifications) ? draft.constraintVerifications : [];
  trace.criticalSourceCoverage = computeCriticalSourceCoverage(contextBundle, trace.sourceUsage, draft);
  const advisoryIssues = await runDraftAdvisoryReviews(draft, abortSignal, onProgress, modelRuntime);
  const reviseFromSelection = mode === 'revise'
    && !pendingChapterDraft?.text
    && !!String(editorContext?.selectedText || '').trim();

  const harnessTrace = finishHarnessTrace(trace);
  emitProgress(onProgress, '写作链：自适应 Harness 追踪已完成。', { stage: 'harness_trace', harnessTrace });
  const finalIssues = mergeReviewIssues(blockingIssues, advisoryIssues);
  const finalDraft = {
      ...draft,
      roleplayContext: compactContext || null,
      roleplayPlan: roleplayPlan || null,
      profileWarnings,
      advisoryIssues,
      verification: {
        status: hasBlockingReviewIssues(finalIssues) ? 'blocked' : 'passed',
        contentHash: chapterContentHash(draft.text),
        checks: Array.isArray(draft.constraintVerifications) ? draft.constraintVerifications : [],
      },
      harnessTrace,
    };
  return {
    draft: finalDraft,
    blockingIssues,
    advisoryIssues,
    issues: finalIssues,
    harnessTrace,
    assistantText: buildAssistantText({ mode, draft: finalDraft, blockingIssues, advisoryIssues, reviseFromSelection }),
  };
}

module.exports = {
  generateChapterDraft,
  reviewExistingChapterDraft,
  verifyChapterContentStrict,
  buildSceneCharacterContextForTargetChapter,
  _testBuildChapterAssistantText: buildAssistantText,
  _testBuildChapterReviewFailureIssue: buildReviewFailureIssue,
  _testBuildIssueRevisionInput: buildIssueRevisionInput,
  _testFormatProfileGateText: formatProfileGateText,
  _testFormatRoleplayRiskText: formatRoleplayRiskText,
  _testFormatDraftGenerationFailureText: formatDraftGenerationFailureText,
  _testNormalizeDraft: normalizeDraft,
  _testDetectDraftTextContamination: detectDraftTextContamination,
  _testBuildCompactWritingContext: buildCompactWritingContext,
  _testBuildDraftInput: buildDraftInput,
  _testBuildReviewInput: buildReviewInput,
  _testBuildRetrievalQueryForTargetChapter: buildRetrievalQueryForTargetChapter,
  _testAssembleSceneDrafts: assembleSceneDrafts,
  _testNormalizeSceneDraft: normalizeSceneDraft,
  _testShouldUseSceneGeneration: shouldUseSceneGeneration,
  _testRunLocalIssueRepair: runLocalIssueRepair,
  _testCreateHarnessModelRuntime: createHarnessModelRuntime,
  _testComputeCriticalSourceCoverage: computeCriticalSourceCoverage,
  _testRunDraftAdvisoryReviews: runDraftAdvisoryReviews,
  PROMPT_VERSIONS,
};
