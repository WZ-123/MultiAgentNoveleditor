'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const mcpClient = require('../mcp/mcpClientStdio');
const { getActiveNovelContext } = require('./activeNovelContext');
const {
  normalizeChapterContextBundle,
  normalizeContextSpec,
  normalizeSceneContract,
} = require('../../domain/chapterHarness.cjs');
const { parseJsonText } = require('./jsonText');
const chapterHarnessState = require('../store/chapterHarnessState');
const { buildChapterRiskProfile, resolveAdaptivePolicy } = require('./chapterRiskProfile');

const contextCache = new Map();

const DEPTH_BUDGETS = {
  compact: { continuity: 3200, outline: 4200, characters: 4800, timeline: 2200, style: 1600, retrieval: 4000 },
  auto: { continuity: 5200, outline: 6500, characters: 7600, timeline: 3200, style: 2600, retrieval: 7000 },
  deep: { continuity: 9000, outline: 11000, characters: 14000, timeline: 5200, style: 5000, retrieval: 12000 },
};

function parseToolText(result) {
  return Array.isArray(result?.content)
    ? result.content.map((item) => item?.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
    : (typeof result === 'string' ? result : JSON.stringify(result || {}));
}

function parseToolJson(result) {
  const raw = parseToolText(result).trim();
  if (!raw) return null;
  try { return parseJsonText(raw); } catch { return null; }
}

async function callTool(callToolFn, name, args = {}) {
  const result = await callToolFn({ name, arguments: args, autoConfirm: true });
  if (result?.isError) throw new Error(parseToolText(result) || `${name} failed`);
  return result;
}

async function callJson(callToolFn, name, args = {}) {
  return parseToolJson(await callTool(callToolFn, name, args));
}

function parseChapterIndex(name) {
  const match = /chapter-(\d+)/iu.exec(String(name || ''));
  return match ? Number(match[1]) : null;
}

function matchesTargetChapterNode(node, targetChapter) {
  const targetName = String(targetChapter?.name || targetChapter?.fileName || '').trim();
  const ordinal = Number.isInteger(Number(targetChapter?.ordinal))
    ? Number(targetChapter.ordinal)
    : parseChapterIndex(targetName);
  if (targetName && (node?.chapterRef === targetName || node?.writtenChapterRef === targetName)) return true;
  return ordinal != null && Number(node?.chapterIndex) === ordinal;
}

function truncateText(value, maxChars, fromEnd = false) {
  const raw = String(value || '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || raw.length <= maxChars) return { text: raw, trimmed: false };
  const marker = '\n[Context trimmed for model]\n';
  const keep = Math.max(0, maxChars - marker.length);
  return {
    text: fromEnd ? `${marker}${raw.slice(-keep)}` : `${raw.slice(0, keep)}${marker}`,
    trimmed: true,
  };
}

function paragraphEnding(text, maxChars) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const paragraphs = normalized.split(/\n\s*\n/u).filter(Boolean);
  const selected = [];
  let used = 0;
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const next = paragraphs[index];
    if (selected.length && used + next.length + 2 > maxChars) break;
    selected.unshift(next);
    used += next.length + 2;
  }
  return truncateText(selected.join('\n\n') || normalized, maxChars, true).text;
}

function pruneStructured(value, stringLimit, arrayLimit) {
  if (typeof value === 'string') return truncateText(value, stringLimit).text;
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map((item) => pruneStructured(item, stringLimit, arrayLimit));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pruneStructured(item, stringLimit, arrayLimit)]));
  }
  return value;
}

function fitStructuredValue(value, maxChars) {
  const originalLength = JSON.stringify(value || null).length;
  if (originalLength <= maxChars) return { value, trimmed: false };
  let stringLimit = Math.max(120, Math.min(1200, Math.trunc(maxChars / 4)));
  let arrayLimit = 8;
  let fitted = pruneStructured(value, stringLimit, arrayLimit);
  while (JSON.stringify(fitted).length > maxChars && (stringLimit > 120 || arrayLimit > 2)) {
    stringLimit = Math.max(120, Math.trunc(stringLimit * 0.7));
    arrayLimit = Math.max(2, Math.trunc(arrayLimit * 0.7));
    fitted = pruneStructured(value, stringLimit, arrayLimit);
  }
  return { value: fitted, trimmed: true };
}

function planContextRequirements({ settings = {}, mode = 'create', hasSelection = false } = {}) {
  const depth = ['compact', 'deep'].includes(settings.contextDepth) ? settings.contextDepth : 'auto';
  const required = ['chapter_target', 'outline_hierarchy', 'previous_chapter_exit', 'scene_characters', 'style_memory'];
  if (mode === 'revise') required.push('current_draft');
  if (hasSelection) required.push('selected_text_scope');
  return normalizeContextSpec({
    depth,
    required,
    optional: ['nearby_timeline', 'semantic_retrieval'],
    budgets: DEPTH_BUDGETS[depth],
  });
}

function sourceRef(ref, type, priority, deterministic = true, criticality = '') {
  return {
    ref,
    type,
    priority,
    deterministic,
    criticality: criticality || (priority <= 2 ? 'critical' : priority <= 4 ? 'required' : 'optional'),
  };
}

function selectPreviousChapter(displays, targetChapter) {
  const list = Array.isArray(displays) ? displays : [];
  const targetName = String(targetChapter?.name || '').trim();
  let index = list.findIndex((item) => String(item?.name || item?.fileName || '').trim() === targetName);
  const ordinal = Number.isInteger(Number(targetChapter?.ordinal)) ? Number(targetChapter.ordinal) : null;
  if (index < 0 && ordinal != null) {
    const bySequence = list.find((item, itemIndex) => Number(item?.seq || itemIndex + 1) === ordinal - 1);
    if (bySequence) return bySequence;
    index = ordinal - 1;
  }
  const previousIndex = index - 1;
  return previousIndex >= 0 && previousIndex < list.length ? list[previousIndex] : null;
}

function normalizeOutlineNode(node) {
  return {
    id: node?.id || '',
    type: node?.type || node?.level || 'scene',
    title: node?.title || '',
    summary: node?.summary || '',
    characters: Array.isArray(node?.characters) ? node.characters : [],
    location: node?.location || '',
    setting: node?.setting || '',
    when: node?.when || node?.time || '',
    pov: node?.pov || '',
    volumeIndex: node?.volumeIndex ?? null,
    sectionIndex: node?.sectionIndex ?? null,
    chapterIndex: node?.chapterIndex ?? null,
    chapterRef: node?.chapterRef || node?.writtenChapterRef || '',
    mustHappen: Array.isArray(node?.mustHappen) ? node.mustHappen : [],
    mustNotHappen: Array.isArray(node?.mustNotHappen) ? node.mustNotHappen : [],
    informationBoundaries: Array.isArray(node?.informationBoundaries) ? node.informationBoundaries : [],
  };
}

function sceneContractsFromOutline(targetChapter, nodes, nearbyTimeline = []) {
  const normalizedNodes = (Array.isArray(nodes) ? nodes : []).map(normalizeOutlineNode);
  const sourceFacts = (Array.isArray(nearbyTimeline) ? nearbyTimeline : []).slice(-6).map((event) => (
    [event.when, event.where, event.description].filter(Boolean).join('：')
  )).filter(Boolean);
  const baseNodes = normalizedNodes.length ? normalizedNodes : [normalizeOutlineNode({
    id: `scene-${targetChapter?.ordinal || 1}`,
    title: targetChapter?.titleHint || targetChapter?.displayName || targetChapter?.name,
    summary: '',
    characters: [],
    location: '',
    setting: '',
    pov: '',
  })];
  return baseNodes.map((node, index) => normalizeSceneContract({
    sceneId: node.id || `scene-${index + 1}`,
    chapterRef: targetChapter?.name,
    title: node.title || targetChapter?.displayName || targetChapter?.name,
    purpose: node.summary || node.title || '遵循用户需求推进本章',
    pov: node.pov,
    when: node.when,
    location: node.location,
    setting: node.setting,
    appearingCharacterIds: node.characters,
    mustHappen: node.mustHappen.length ? node.mustHappen : [node.summary || node.title].filter(Boolean),
    mustNotHappen: [
      ...node.mustNotHappen,
      '不得改变本章大纲要求的关键结果。',
      '不得提前公开当前场景未允许披露的信息。',
    ],
    informationBoundaries: node.informationBoundaries,
    creativeFreedom: [
      '可增加符合人设的动作、台词、心理与沉默。',
      '可调整表达和过渡，但必须保留场景结果。',
    ],
    continuityFacts: sourceFacts,
    sourceRefs: [
      sourceRef('harness:scene-defaults', 'harness', 1, true),
      ...(node.id ? [sourceRef(`outline:${node.id}`, 'outline', 2, true)] : []),
    ],
  }, index));
}

function buildAssertions(sceneContracts) {
  const assertions = [];
  for (const scene of sceneContracts) {
    for (const [index, statement] of scene.mustHappen.entries()) {
      if (!statement) continue;
      assertions.push({
        constraintId: `${scene.sceneId}-must-${index + 1}`,
        type: 'required_event',
        assertion: statement,
        severity: 'blocking',
        deterministic: true,
        sceneId: scene.sceneId,
        sourceRefs: scene.sourceRefs,
      });
    }
    for (const [index, statement] of scene.mustNotHappen.entries()) {
      assertions.push({
        constraintId: `${scene.sceneId}-forbid-${index + 1}`,
        type: 'forbidden_event',
        assertion: statement,
        severity: 'blocking',
        deterministic: true,
        sceneId: scene.sceneId,
        sourceRefs: scene.sourceRefs,
      });
    }
    for (const [index, statement] of scene.informationBoundaries.entries()) {
      assertions.push({
        constraintId: `${scene.sceneId}-knowledge-${index + 1}`,
        type: 'knowledge_boundary',
        assertion: statement,
        severity: 'blocking',
        deterministic: true,
        sceneId: scene.sceneId,
        sourceRefs: scene.sourceRefs,
      });
    }
  }
  return assertions;
}

async function collectFileStats(root, relative = '') {
  const current = path.join(root, relative);
  let entries;
  try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectFileStats(root, childRelative));
    } else if (entry.isFile()) {
      const stat = await fs.stat(path.join(root, childRelative));
      out.push(`${childRelative}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    }
  }
  return out;
}

async function computeNovelFingerprint(novelDir) {
  if (!novelDir) return '';
  const roots = ['chapters', 'summaries', 'outlines', 'characters', 'timeline', 'style', '.mana/harness-state'];
  const groups = await Promise.all(roots.map((relative) => collectFileStats(novelDir, relative)));
  return crypto.createHash('sha256').update(groups.flat().join('\n')).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cacheKeyFor({ novelDir, targetChapter, contextSpec, userText, fingerprint }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    novelDir,
    target: targetChapter?.name,
    ordinal: targetChapter?.ordinal,
    depth: contextSpec.depth,
    userText: String(userText || '').trim(),
    fingerprint,
  })).digest('hex');
}

function findDuplicateOutlineConflicts(nodes) {
  const diagnostics = [];
  const byId = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node?.id) continue;
    const prior = byId.get(node.id);
    if (!prior) {
      byId.set(node.id, node);
      continue;
    }
    const fields = ['title', 'summary', 'location', 'setting', 'pov'];
    const conflicts = fields.filter((field) => prior[field] && node[field] && prior[field] !== node[field]);
    if (conflicts.length) {
      diagnostics.push({
        code: 'outline_source_conflict',
        severity: 'blocking',
        message: `大纲节点 ${node.id} 在 ${conflicts.join('、')} 字段上存在冲突。`,
        sourceRefs: [sourceRef(`outline:${node.id}`, 'outline', 2, true)],
      });
    }
  }
  return diagnostics;
}

async function loadOutlineHierarchy(callToolFn, matchingNodes, budget, trimmed) {
  const first = matchingNodes[0] || {};
  const volumeIndex = Number(first.volumeIndex);
  const sectionIndex = Number(first.sectionIndex);
  const chapterIndex = Number(first.chapterIndex);
  const requests = [{ key: 'master', name: 'outline.md' }];
  if (Number.isInteger(volumeIndex) && volumeIndex > 0) {
    requests.push({ key: 'volume', name: `volume-${String(volumeIndex).padStart(3, '0')}/outline.md` });
  }
  if (Number.isInteger(volumeIndex) && volumeIndex > 0 && Number.isInteger(sectionIndex) && sectionIndex > 0) {
    requests.push({ key: 'section', name: `volume-${String(volumeIndex).padStart(3, '0')}/section-${String(sectionIndex).padStart(3, '0')}/outline.md` });
  }
  if (Number.isInteger(volumeIndex) && volumeIndex > 0 && Number.isInteger(sectionIndex) && sectionIndex > 0 && Number.isInteger(chapterIndex) && chapterIndex > 0) {
    requests.push({ key: 'chapter', name: `volume-${String(volumeIndex).padStart(3, '0')}/section-${String(sectionIndex).padStart(3, '0')}/chapter-${String(chapterIndex).padStart(3, '0')}.md` });
  }
  const perItem = Math.max(500, Math.trunc(budget / requests.length));
  const hierarchy = {};
  const sourceRefs = [];
  await Promise.all(requests.map(async (request) => {
    try {
      const raw = parseToolText(await callTool(callToolFn, 'read_outline', { name: request.name }));
      const fitted = truncateText(raw, perItem);
      hierarchy[request.key] = fitted.text;
      if (fitted.trimmed) trimmed.push(`outline.${request.key}`);
      if (raw) sourceRefs.push(sourceRef(`outline-file:${request.name}`, 'outline', request.key === 'chapter' ? 2 : 3, true));
    } catch {
      hierarchy[request.key] = '';
    }
  }));
  hierarchy.matchingNodes = matchingNodes;
  return { hierarchy, sourceRefs };
}

async function loadSceneCharacterContexts(callToolFn, matchingNodes, maxScenes) {
  const out = [];
  await Promise.all((Array.isArray(matchingNodes) ? matchingNodes : []).slice(0, maxScenes).map(async (node) => {
    if (!node?.id) return;
    try {
      const payload = await callJson(callToolFn, 'assemble_scene_context', { nodeId: node.id });
      if (payload) out.push({ ...payload, sourceRef: payload.sourceRef || `outline:${node.id}` });
    } catch { /* diagnostic is added by caller when every context is missing */ }
  }));
  const order = new Map(matchingNodes.map((node, index) => [node.id, index]));
  return out.sort((left, right) => (order.get(left.nodeId) ?? 999) - (order.get(right.nodeId) ?? 999));
}

function relevantTimeline(events, targetChapter) {
  const targetIndex = Number.isInteger(Number(targetChapter?.ordinal))
    ? Number(targetChapter.ordinal)
    : parseChapterIndex(targetChapter?.name);
  return (Array.isArray(events) ? events : []).filter((event) => {
    const eventIndex = parseChapterIndex(event?.chapterRef);
    if (targetIndex == null || eventIndex == null) return event?.chapterRef === targetChapter?.name;
    return eventIndex >= targetIndex - 2 && eventIndex <= targetIndex + 1;
  }).slice(-16).map((event) => ({
    chapterRef: event.chapterRef,
    when: event.when || '',
    where: event.where || '',
    participants: Array.isArray(event.participants) ? event.participants : [],
    description: event.description || event.action || '',
    sourceRef: `timeline:${event.id || event.chapterRef || 'event'}`,
  }));
}

function buildRetrievalQuery(targetChapter, userText, matchingNodes, sceneCharacterContexts) {
  return [
    targetChapter?.displayName,
    targetChapter?.titleHint,
    targetChapter?.name,
    userText,
    ...matchingNodes.flatMap((node) => [node.title, node.summary, node.location, node.setting, ...(node.characters || [])]),
    ...sceneCharacterContexts.flatMap((scene) => [scene.title, scene.location, scene.setting, scene.pov]),
  ].map((item) => String(item || '').trim()).filter(Boolean).join('\n');
}

async function compileChapterContext({
  targetChapter,
  userText = '',
  mode = 'create',
  editorContext = null,
  settings = {},
  callTool: injectedCallTool = null,
  novelDir: injectedNovelDir = null,
} = {}) {
  const callToolFn = injectedCallTool || ((payload) => mcpClient.callTool(payload));
  let contextSpec = planContextRequirements({
    settings,
    mode,
    hasSelection: !!String(editorContext?.selectedText || '').trim(),
  });
  const novelDir = injectedNovelDir || getActiveNovelContext(mcpClient)?.novelDir || '';
  const fingerprint = await computeNovelFingerprint(novelDir);
  const cacheKey = fingerprint ? cacheKeyFor({ novelDir, targetChapter, contextSpec, userText, fingerprint }) : '';
  if (cacheKey && contextCache.has(cacheKey)) {
    const cached = clone(contextCache.get(cacheKey));
    cached.cache = { hit: true, fingerprint, key: cacheKey };
    return normalizeChapterContextBundle(cached);
  }

  const diagnostics = [];
  const trimmed = [];
  const sourceRefs = [sourceRef(`chapter:${targetChapter?.name}`, 'target', 1, true, 'required')];
  const [displayPayload, outlinePayload, timelinePayload, styleResult] = await Promise.all([
    callJson(callToolFn, 'list_chapter_displays', {}).catch((err) => {
      diagnostics.push({ code: 'chapter_displays_missing', severity: 'warning', message: `无法读取章节显示顺序：${err.message}` });
      return [];
    }),
    callJson(callToolFn, 'read_outline_nodes', {}).catch((err) => {
      diagnostics.push({ code: 'outline_missing', severity: 'warning', message: `未找到可用大纲，将按用户需求自由写作：${err.message}` });
      return { nodes: [] };
    }),
    callJson(callToolFn, 'query_timeline', {}).catch((err) => {
      diagnostics.push({ code: 'timeline_missing', severity: 'warning', message: `无法读取邻近时间线：${err.message}` });
      return { events: [] };
    }),
    callTool(callToolFn, 'read_style_memory', {}).then(parseToolText).catch((err) => {
      diagnostics.push({ code: 'style_memory_missing', severity: 'warning', message: `无法读取文风记忆：${err.message}` });
      return '';
    }),
  ]);

  const displays = Array.isArray(displayPayload) ? displayPayload : [];
  const allNodes = Array.isArray(outlinePayload?.nodes) ? outlinePayload.nodes : [];
  const matchingNodes = allNodes.filter((node) => matchesTargetChapterNode(node, targetChapter)).map(normalizeOutlineNode);
  diagnostics.push(...findDuplicateOutlineConflicts(matchingNodes));
  if (!matchingNodes.length) diagnostics.push({ code: 'target_outline_missing', severity: 'warning', message: '未找到目标章对应的大纲节点，将保留自由写作。' });

  const previous = selectPreviousChapter(displays, targetChapter);
  let previousSummary = '';
  let previousText = '';
  let entryState = null;
  if (previous) {
    const previousName = String(previous.name || previous.fileName || '').trim();
    [previousSummary, previousText] = await Promise.all([
      callTool(callToolFn, 'read_chapter_summary', { name: previousName }).then(parseToolText).catch(() => ''),
      callTool(callToolFn, 'read_chapter', { name: previousName }).then(parseToolText).catch((err) => {
        diagnostics.push({ code: 'previous_chapter_missing', severity: 'warning', message: `无法读取前一章正文：${err.message}` });
        return '';
      }),
    ]);
    if (previousSummary) sourceRefs.push(sourceRef(`summary:${previousName}`, 'summary', 3, true));
    if (previousText) sourceRefs.push(sourceRef(`chapter:${previousName}`, 'chapter', 2, true));
    if (novelDir) {
      entryState = await chapterHarnessState.readChapterState(novelDir, previousName, { expectedContent: previousText }).catch(() => null);
      if (entryState) {
        sourceRefs.push(sourceRef(`harness-state:${previousName}`, 'chapter_state', 2, true));
        if (entryState.status === 'stale') {
          diagnostics.push({
            code: 'previous_state_stale',
            severity: 'warning',
            message: '上一章状态快照与当前正文不一致，本轮将提高校验强度并把快照仅作参考。',
            sourceRefs: [sourceRef(`harness-state:${previousName}`, 'chapter_state', 2, true)],
          });
        }
      }
    }
    if (!entryState) {
      const previousEvents = (Array.isArray(timelinePayload?.events) ? timelinePayload.events : [])
        .filter((event) => event?.chapterRef === previousName)
        .map((event) => ({
          when: event.when || '',
          where: event.where || '',
          participants: Array.isArray(event.participants) ? event.participants : [],
          description: event.description || event.action || '',
          sourceRef: `timeline:${event.id || previousName}`,
        }));
      if (previousEvents.length) {
        entryState = {
          schemaVersion: 1,
          chapterRef: previousName,
          status: 'valid',
          extractedAt: '',
          characters: [],
          assets: [],
          worldState: {
            continuityFacts: previousEvents.map((event) => event.description).filter(Boolean),
            deterministicFacts: previousEvents.map((event) => ({
              fact: event.description,
              sourceRef: event.sourceRef,
              when: event.when,
              where: event.where,
              participants: event.participants,
            })).filter((fact) => fact.fact),
          },
          unresolvedThreads: [],
          events: previousEvents,
          evidence: [],
          sourceRefs: previousEvents.map((event) => sourceRef(event.sourceRef, 'timeline', 2, true)),
        };
        sourceRefs.push(...entryState.sourceRefs);
      }
    }
  }

  const preliminaryRisk = buildChapterRiskProfile({
    targetChapter,
    mode,
    editorContext,
    matchingNodes,
    diagnostics,
    entryState,
  });
  const adaptivePolicy = resolveAdaptivePolicy({ riskProfile: preliminaryRisk, settings });
  if (!['compact', 'deep'].includes(settings.contextDepth) && adaptivePolicy.contextDepth !== contextSpec.depth) {
    contextSpec = planContextRequirements({
      settings: { ...settings, contextDepth: adaptivePolicy.contextDepth },
      mode,
      hasSelection: !!String(editorContext?.selectedText || '').trim(),
    });
  }

  const continuityBudget = contextSpec.budgets.continuity;
  const fittedSummary = truncateText(previousSummary, Math.trunc(continuityBudget * 0.55));
  if (fittedSummary.trimmed) trimmed.push('continuity.previousSummary');
  const endingExcerpt = paragraphEnding(previousText, Math.trunc(continuityBudget * 0.45));
  const continuity = previous ? {
    previousChapter: {
      name: previous.name || previous.fileName,
      displayName: previous.displayName || previous.name || previous.fileName,
      summary: fittedSummary.text,
      endingExcerpt,
      summaryFallbackUsed: !previousSummary && !!endingExcerpt,
      exitState: entryState,
    },
  } : {};

  const outlineLoaded = await loadOutlineHierarchy(callToolFn, matchingNodes, contextSpec.budgets.outline, trimmed);
  sourceRefs.push(...outlineLoaded.sourceRefs);
  for (const node of matchingNodes) {
    if (node.id) sourceRefs.push(sourceRef(`outline:${node.id}`, 'outline', 2, true));
  }

  const timelineFit = fitStructuredValue(relevantTimeline(timelinePayload?.events, targetChapter), contextSpec.budgets.timeline);
  const nearbyTimeline = timelineFit.value;
  if (timelineFit.trimmed) trimmed.push('nearbyTimeline');
  if (nearbyTimeline.length) sourceRefs.push(sourceRef('timeline:nearby', 'timeline', 4, true));
  const maxScenes = contextSpec.depth === 'compact' ? 4 : contextSpec.depth === 'deep' ? 12 : 8;
  const loadedSceneCharacterContexts = await loadSceneCharacterContexts(callToolFn, matchingNodes, maxScenes);
  const characterFit = fitStructuredValue(loadedSceneCharacterContexts, contextSpec.budgets.characters);
  const sceneCharacterContexts = characterFit.value;
  if (characterFit.trimmed) trimmed.push('sceneCharacterContexts');
  if (matchingNodes.some((node) => node.characters.length) && !sceneCharacterContexts.length) {
    diagnostics.push({ code: 'scene_character_context_missing', severity: 'warning', message: '大纲已标注出场角色，但未装配到可用角色上下文。' });
  }
  for (const scene of sceneCharacterContexts) {
    sourceRefs.push(sourceRef(scene.sourceRef || `scene:${scene.nodeId || 'unknown'}`, 'character', 3, true));
  }

  const styleFit = truncateText(styleResult, contextSpec.budgets.style);
  if (styleFit.trimmed) trimmed.push('stylePacket.memory');
  if (styleResult) sourceRefs.push(sourceRef('style:memory', 'style', 5, true));

  let retrievedContext = null;
  const retrievalQuery = buildRetrievalQuery(targetChapter, userText, matchingNodes, sceneCharacterContexts);
  if (retrievalQuery) {
    try {
      const payload = await callJson(callToolFn, 'retrieve_context', {
        query: retrievalQuery,
        focus: userText || targetChapter?.displayName || targetChapter?.name || '',
        chapterName: targetChapter?.name || '',
        maxItems: contextSpec.depth === 'compact' ? 8 : contextSpec.depth === 'deep' ? 18 : 12,
        maxChars: contextSpec.budgets.retrieval,
      });
      const fitted = truncateText(payload?.contextText || '', contextSpec.budgets.retrieval);
      if (fitted.trimmed || payload?.wasTrimmed) trimmed.push('retrievedContext');
      retrievedContext = payload ? { ...payload, contextText: fitted.text } : null;
      if (retrievedContext?.contextText) sourceRefs.push(sourceRef('retrieval:semantic', 'retrieval', 6, false));
    } catch (err) {
      diagnostics.push({ code: 'semantic_retrieval_missing', severity: 'warning', message: `语义检索不可用：${err.message}` });
    }
  }

  const sceneContracts = sceneContractsFromOutline(targetChapter, matchingNodes, nearbyTimeline);
  const assertions = buildAssertions(sceneContracts);
  const criticalSourceRefs = sourceRefs.filter((item) => item.criticality === 'critical');
  const bundle = normalizeChapterContextBundle({
    targetChapter,
    contextSpec,
    continuity,
    outlineIntent: outlineLoaded.hierarchy,
    sceneCharacterContexts,
    nearbyTimeline,
    stylePacket: { memory: styleFit.text, sourceRef: styleResult ? 'style:memory' : '' },
    retrievedContext,
    hardConstraints: assertions.filter((item) => item.severity === 'blocking').map((item) => item.assertion),
    softPreferences: styleFit.text ? ['按文风记忆保持叙事节奏、句式与用词习惯。'] : [],
    sceneContracts,
    assertions,
    sourceRefs,
    diagnostics,
    trimmed,
    cache: { hit: false, fingerprint, key: cacheKey },
    riskProfile: preliminaryRisk,
    entryState,
    criticalSourceRefs,
  });
  if (cacheKey && !bundle.diagnostics.some((item) => item.severity === 'blocking')) contextCache.set(cacheKey, clone(bundle));
  return bundle;
}

function clearChapterContextCache() {
  contextCache.clear();
}

module.exports = {
  buildAssertions,
  clearChapterContextCache,
  compileChapterContext,
  computeNovelFingerprint,
  matchesTargetChapterNode,
  planContextRequirements,
  sceneContractsFromOutline,
  _testCache: contextCache,
};
