'use strict';

const crypto = require('node:crypto');
const novelData = require('../store/novelData');
const mcpClient = require('../mcp/mcpClientStdio');
const { getActiveNovelContext } = require('./activeNovelContext');
const { runSubagent } = require('./runSubagent');
const { parseJsonText } = require('./jsonText');

const REQUIRED_FIELDS = ['personality', 'speechStyle', 'appearance', 'relationships', 'storyArc'];
const WEAK_TEXT_LENGTH = 24;
const EVENT_TEXT_LIMIT = 220;
const MEMORY_ARRAY_FIELDS = ['factsKnown', 'emotionalMemory', 'relationshipDeltas', 'unresolvedIntentions', 'privateMisbeliefs'];

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeMemoryPatchId(chapterRef, characterId, field, item) {
  return `${field}-${crypto.createHash('sha1').update(`${chapterRef}|${characterId}|${field}|${stableSerialize(item)}`).digest('hex').slice(0, 16)}`;
}

function makeIdempotentMemoryPatch(patch, chapterRef, characterId) {
  const next = { ...(patch && typeof patch === 'object' ? patch : {}) };
  next.lastUpdatedChapterRef = chapterRef || next.lastUpdatedChapterRef || '';
  for (const field of MEMORY_ARRAY_FIELDS) {
    if (!Array.isArray(next[field])) continue;
    next[field] = next[field].filter((item) => item && typeof item === 'object').map((item) => ({
      ...item,
      id: item.id || makeMemoryPatchId(chapterRef, characterId, field, item),
      sourceChapterRef: item.sourceChapterRef || chapterRef || '',
    }));
  }
  return next;
}

function parseJsonFromText(text, fallback = null) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    return parseJsonText(raw);
  } catch {
    return fallback;
  }
}

function activeNovelDir() {
  const ctx = getActiveNovelContext(mcpClient);
  return ctx?.novelDir || null;
}

function compact(value, max = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function trimForEvent(value, max = EVENT_TEXT_LIMIT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactCandidateList(value, maxItems = 2) {
  return normalizeList(value).slice(0, maxItems).map((item, index) => ({
    index,
    text: trimForEvent(item?.text || item?.content || item),
    tone: trimForEvent(item?.tone || '', 80),
    intent: trimForEvent(item?.intent || '', 120),
  })).filter((item) => item.text || item.intent || item.tone);
}

function compactRiskList(value, maxItems = 4) {
  return normalizeList(value).slice(0, maxItems).map((item) => {
    if (typeof item === 'string') return trimForEvent(item);
    return {
      type: trimForEvent(item?.type || item?.category || '', 80),
      note: trimForEvent(item?.note || item?.summary || item?.detail || item?.reason || item, 180),
    };
  });
}

function makeRoleplayEvent(type, payload = {}) {
  return {
    eventId: `roleplay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    chapterRef: payload.chapterRef || '',
    sceneId: payload.sceneId || '',
    title: trimForEvent(payload.title || '', 140),
    actor: payload.actor || null,
    summary: trimForEvent(payload.summary || '', 260),
    details: payload.details && typeof payload.details === 'object' ? payload.details : {},
    riskLevel: payload.riskLevel || 'none',
    ts: Date.now(),
  };
}

function emitRoleplayEvent(onRoleplayEvent, type, payload = {}) {
  if (typeof onRoleplayEvent !== 'function') return null;
  const event = makeRoleplayEvent(type, payload);
  try { onRoleplayEvent(event); } catch { /* roleplay UI events are best-effort */ }
  return event;
}

function compactActorProposal(proposal, character) {
  return {
    characterId: proposal?.characterId || character?.id || '',
    characterName: character?.name || proposal?.characterName || proposal?.characterId || '',
    currentObjective: trimForEvent(proposal?.currentObjective || proposal?.objective || '', 160),
    emotionalState: trimForEvent(proposal?.emotionalState || '', 160),
    speechCandidates: compactCandidateList(proposal?.speechCandidates),
    actionCandidates: compactCandidateList(proposal?.actionCandidates),
    innerStateCandidates: compactCandidateList(proposal?.innerStateCandidates),
    wouldResistOutline: !!proposal?.wouldResistOutline,
    resistanceReason: trimForEvent(proposal?.resistanceReason || '', 180),
    outlineSafeAlternative: trimForEvent(proposal?.outlineSafeAlternative || '', 180),
    risks: compactRiskList(proposal?.risks),
  };
}

function compactDirectorDecision(decision) {
  const approvedBeats = normalizeList(decision?.approvedBeats).slice(0, 8).map((beat, index) => ({
    order: beat?.order ?? index + 1,
    type: trimForEvent(beat?.type || '', 60),
    characterId: trimForEvent(beat?.characterId || '', 80),
    content: trimForEvent(beat?.content || beat?.text || '', 220),
  }));
  const rejectedProposals = normalizeList(decision?.rejectedProposals).slice(0, 6).map((item) => ({
    sourceProposal: trimForEvent(item?.sourceProposal || item?.id || '', 100),
    reason: trimForEvent(item?.reason || item?.note || item, 180),
  }));
  return {
    sceneId: decision?.sceneId || '',
    outlineCompliance: trimForEvent(decision?.outlineCompliance || 'risk', 40),
    approvedBeats,
    rejectedProposals,
    directorNotesForWriter: normalizeList(decision?.directorNotesForWriter).slice(0, 6).map((item) => trimForEvent(item, 180)),
    remainingRisks: compactRiskList(decision?.remainingRisks),
  };
}

function hasDirectorRisk(decision) {
  if (!decision) return false;
  const compliance = String(decision.outlineCompliance || '').trim().toLowerCase();
  if (compliance && compliance !== 'pass') return true;
  return normalizeList(decision.remainingRisks).length > 0;
}

function textFieldQuality(character, field) {
  const value = character?.[field];
  if (field === 'relationships') {
    const rel = character?.relationships || character?.relationship;
    if (Array.isArray(rel)) return rel.length ? 'ok' : 'missing';
    if (rel && typeof rel === 'object') return Object.keys(rel).length ? 'ok' : 'missing';
    return 'missing';
  }
  const text = String(value || '').trim();
  if (!text) return 'missing';
  if (text.length < WEAK_TEXT_LENGTH) return 'weak';
  return 'ok';
}

function summarizeCharacter(character) {
  return {
    id: character.id,
    name: character.name,
    aliases: normalizeList(character.aliases),
    role: character.role || '',
    faction: character.faction || '',
    appearance: compact(character.appearance, 500),
    personality: compact(character.personality, 500),
    speechStyle: compact(character.speechStyle || character.quotes || '', 400),
    quotes: compact(character.quotes, 300),
    relationships: character.relationships || character.relationship || {},
    storyArc: compact(character.storyArc || character.arc?.status || '', 400),
  };
}

function summarizeMemory(memory) {
  return {
    characterId: memory.characterId,
    lastUpdatedChapterRef: memory.lastUpdatedChapterRef || '',
    factsKnown: normalizeList(memory.factsKnown).slice(-8),
    emotionalMemory: normalizeList(memory.emotionalMemory).slice(-8),
    relationshipDeltas: normalizeList(memory.relationshipDeltas).slice(-8),
    unresolvedIntentions: normalizeList(memory.unresolvedIntentions).slice(-6),
    privateMisbeliefs: normalizeList(memory.privateMisbeliefs).slice(-6),
  };
}

function scenePacketsFromContext(targetChapter, compactContext) {
  const preparedScenes = Array.isArray(compactContext?.sceneContracts) ? compactContext.sceneContracts : [];
  if (preparedScenes.length) {
    return preparedScenes.map((scene, index) => ({
      sceneId: scene.sceneId || `scene-${index + 1}`,
      chapterRef: targetChapter.name,
      title: scene.title || targetChapter.displayName || targetChapter.name,
      location: scene.location || '',
      setting: scene.setting || '',
      pov: scene.pov || '',
      appearingCharacterIds: normalizeList(scene.appearingCharacterIds).filter(Boolean),
      mustHappen: normalizeList(scene.mustHappen),
      mustNotHappen: normalizeList(scene.mustNotHappen),
      allowedFreedom: normalizeList(scene.creativeFreedom || scene.allowedFreedom),
      continuityFacts: normalizeList(scene.continuityFacts),
      entryState: scene.entryState || {},
      expectedExitState: scene.expectedExitState || {},
      informationBoundaries: normalizeList(scene.informationBoundaries),
    }));
  }
  const nodes = Array.isArray(compactContext?.outlineNodes) ? compactContext.outlineNodes : [];
  return nodes.map((node, index) => ({
    sceneId: node.id || `scene-${index + 1}`,
    chapterRef: targetChapter.name,
    title: node.title || targetChapter.displayName || targetChapter.name,
    location: node.location || '',
    setting: node.setting || '',
    pov: node.pov || '',
    appearingCharacterIds: normalizeList(node.characters).filter(Boolean),
    mustHappen: [node.summary || node.title || '遵循当前大纲场景推进'].filter(Boolean),
    mustNotHappen: [
      '不得改变本章大纲要求的关键结果。',
      '不得提前揭示大纲未要求公开的信息。',
      '不得改写后续场景的地点、时间线或人物关系结局。',
    ],
    allowedFreedom: [
      '可增加符合人设的动作、台词、心理和沉默。',
      '可调整表达方式，但必须保留场景结果。',
    ],
    continuityFacts: normalizeList(compactContext?.nearbyTimeline).slice(-6),
  }));
}

async function buildProfileGate({ targetChapter, compactContext }) {
  const dir = activeNovelDir();
  if (!dir) return null;
  const scenes = scenePacketsFromContext(targetChapter, compactContext);
  const characterIds = Array.from(new Set(scenes.flatMap((scene) => scene.appearingCharacterIds))).slice(0, 8);
  const missingCharacters = [];
  const characters = [];
  const memories = [];

  for (const id of characterIds) {
    const character = await novelData.readCharacter(dir, id);
    if (!character) continue;
    const memory = await novelData.readCharacterMemory(dir, character.id);
    characters.push(character);
    memories.push(memory);
    const missingFields = [];
    const weakFields = [];
    for (const field of REQUIRED_FIELDS) {
      const quality = textFieldQuality(character, field);
      if (quality === 'missing') missingFields.push(field);
      if (quality === 'weak') weakFields.push(field);
    }
    const hasMemory = normalizeList(memory.factsKnown).length
      || normalizeList(memory.emotionalMemory).length
      || normalizeList(memory.relationshipDeltas).length
      || normalizeList(memory.unresolvedIntentions).length
      || normalizeList(memory.privateMisbeliefs).length;
    if (!hasMemory) missingFields.push('characterMemory');
    if (missingFields.length || weakFields.length) {
      missingCharacters.push({
        id: character.id,
        name: character.name,
        missingFields,
        weakFields,
      });
    }
  }

  if (!missingCharacters.length) return null;
  return {
    targetChapter,
    scenes,
    characters: characters.map(summarizeCharacter),
    memories: memories.map(summarizeMemory),
    missingCharacters,
  };
}

async function proposeProfileAutofill(profileGate, userText, abortSignal) {
  const input = JSON.stringify({
    userText,
    targetChapter: profileGate?.targetChapter,
    scenes: profileGate?.scenes,
    characters: profileGate?.characters,
    memories: profileGate?.memories,
    missingCharacters: profileGate?.missingCharacters,
    instruction: '只生成服务当前场景的角色卡/记忆 patch。可补空字段，也可改写明显过短、空泛、不可用于写作的弱字段。不要直接写入。',
  }, null, 2);
  const result = await runSubagent({
    subagentId: 'sa-character-profile-autofiller',
    input,
    userLang: 'zh-CN',
    abortSignal,
  });
  return parseJsonFromText(result.output || '', { characterPatches: [], memoryPatches: [], notes: [] });
}

async function applyProfileAutofill(proposal) {
  const dir = activeNovelDir();
  if (!dir) throw new Error('No active novel for profile autofill');
  const applied = { characters: 0, memories: 0 };
  for (const item of normalizeList(proposal?.characterPatches)) {
    if (!item?.characterId || !item.patch || typeof item.patch !== 'object') continue;
    await novelData.patchCharacter(dir, item.characterId, item.patch);
    applied.characters += 1;
  }
  for (const item of normalizeList(proposal?.memoryPatches)) {
    if (!item?.characterId || !item.patch || typeof item.patch !== 'object') continue;
    await novelData.patchCharacterMemory(dir, item.characterId, item.patch);
    applied.memories += 1;
  }
  return applied;
}

function buildActorInput(scene, character, memory, roundContext) {
  return JSON.stringify({
    scene,
    targetCharacter: summarizeCharacter(character),
    characterMemory: summarizeMemory(memory),
    interactionContext: roundContext || null,
  }, null, 2);
}

async function runActor(scene, character, memory, roundContext, abortSignal) {
  const result = await runSubagent({
    subagentId: 'sa-character-actor',
    input: buildActorInput(scene, character, memory, roundContext),
    userLang: 'zh-CN',
    abortSignal,
    mcpClient,
  });
  return parseJsonFromText(result.output || '', {
    characterId: character.id,
    sceneId: scene.sceneId,
    speechCandidates: [],
    actionCandidates: [],
    innerStateCandidates: [],
    risks: [],
  });
}

async function runDirector(scene, proposals, interactionResponses, abortSignal) {
  const result = await runSubagent({
    subagentId: 'sa-scene-director',
    input: JSON.stringify({ scene, proposals, interactionResponses }, null, 2),
    userLang: 'zh-CN',
    abortSignal,
    mcpClient,
  });
  return parseJsonFromText(result.output || '', {
    sceneId: scene.sceneId,
    outlineCompliance: 'risk',
    approvedBeats: [],
    rejectedProposals: [],
    directorNotesForWriter: ['导演仲裁未返回有效 JSON，writer 应保守遵循大纲。'],
    remainingRisks: ['director_parse_failed'],
  });
}

function clampInteractionRounds(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 3;
  return Math.min(99, Math.max(0, Math.trunc(raw)));
}

function emitProgress(onProgress, message, detail = {}) {
  if (typeof onProgress !== 'function') return;
  try { onProgress({ message, ...detail }); } catch { /* progress is best-effort */ }
}

async function buildRoleplayPlan({ targetChapter, compactContext, interactionLevel, maxInteractionRounds, ignoreProfileGate, pauseOnRisk, userText, abortSignal, onProgress, onRoleplayEvent }) {
  const dir = activeNovelDir();
  if (!dir) return { status: 'skipped', reason: 'no_active_novel' };
  const initialScenes = scenePacketsFromContext(targetChapter, compactContext);
  const roleplayScenes = initialScenes.filter((scene) => scene.appearingCharacterIds.length);
  emitRoleplayEvent(onRoleplayEvent, 'session_start', {
    chapterRef: targetChapter.name,
    title: targetChapter.displayName || targetChapter.name,
    summary: `角色驱动写作开始：${targetChapter.displayName || targetChapter.name}，${initialScenes.length} 个场景。`,
    details: {
      interactionLevel,
      maxInteractionRounds: clampInteractionRounds(maxInteractionRounds),
      sceneCount: initialScenes.length,
      roleplaySceneCount: roleplayScenes.length,
    },
  });
  emitProgress(onProgress, '角色驱动：检查出场角色资料。', { stage: 'roleplay_profile_gate' });
  const profileGate = await buildProfileGate({ targetChapter, compactContext });
  if (profileGate && !ignoreProfileGate) {
    return { status: 'profile_gate_blocked', profileGate };
  }

  const scenes = roleplayScenes;
  if (!scenes.length) {
    emitRoleplayEvent(onRoleplayEvent, 'plan_ready', {
      chapterRef: targetChapter.name,
      title: targetChapter.displayName || targetChapter.name,
      summary: '当前章节未找到可调度的出场角色，跳过角色驱动规划。',
      details: { status: 'no_scene_characters' },
    });
    return {
      status: 'ready',
      roleplayPlan: null,
      profileWarnings: profileGate?.missingCharacters || [],
      reason: 'no_scene_characters',
    };
  }

  const scenePlans = [];
  const configuredRounds = clampInteractionRounds(maxInteractionRounds);
  for (const scene of scenes.slice(0, 6)) {
    emitProgress(onProgress, `导演视角：进入场景「${scene.title || scene.sceneId}」，召集出场角色。`, {
      stage: 'roleplay_scene_start',
      sceneId: scene.sceneId,
      sceneTitle: scene.title || '',
    });
    const actorIds = scene.appearingCharacterIds.slice(0, 4);
    const actors = [];
    for (const id of actorIds) {
      const character = await novelData.readCharacter(dir, id);
      if (!character) continue;
      const memory = await novelData.readCharacterMemory(dir, character.id);
      actors.push({ character, memory });
    }
    emitRoleplayEvent(onRoleplayEvent, 'scene_start', {
      chapterRef: targetChapter.name,
      sceneId: scene.sceneId,
      title: scene.title || scene.sceneId,
      summary: `场景「${scene.title || scene.sceneId}」：${actors.map(({ character }) => character.name || character.id).join('、') || '角色'} 出场。`,
      details: {
        location: scene.location || '',
        setting: scene.setting || '',
        pov: scene.pov || '',
        actors: actors.map(({ character }) => ({ id: character.id, name: character.name || character.id })),
        mustHappen: normalizeList(scene.mustHappen).slice(0, 4).map((item) => trimForEvent(item, 180)),
        mustNotHappen: normalizeList(scene.mustNotHappen).slice(0, 4).map((item) => trimForEvent(item, 180)),
      },
    });
    emitProgress(onProgress, `导演视角：${actors.map(({ character }) => character.name || character.id).join('、') || '角色'} 正在提出动作、台词和内心反应。`, {
      stage: 'roleplay_actor_proposals',
      sceneId: scene.sceneId,
      actors: actors.map(({ character }) => character.name || character.id),
    });
    const proposals = await Promise.all(actors.map(({ character, memory }) => runActor(scene, character, memory, null, abortSignal)));
    proposals.forEach((proposal, index) => {
      const actor = actors[index]?.character || {};
      const compactProposal = compactActorProposal(proposal, actor);
      emitRoleplayEvent(onRoleplayEvent, 'actor_proposal', {
        chapterRef: targetChapter.name,
        sceneId: scene.sceneId,
        title: scene.title || scene.sceneId,
        actor: { id: compactProposal.characterId, name: compactProposal.characterName },
        summary: `${compactProposal.characterName || compactProposal.characterId} 提出角色反应${compactProposal.wouldResistOutline ? '，并抵触当前大纲安排' : ''}。`,
        details: compactProposal,
        riskLevel: compactProposal.wouldResistOutline || compactProposal.risks.length ? 'medium' : 'none',
      });
    });
    emitProgress(onProgress, `导演视角：正在仲裁「${scene.title || scene.sceneId}」的第一版角色反应。`, {
      stage: 'roleplay_director_review',
      sceneId: scene.sceneId,
      round: 0,
    });
    let firstDirector = await runDirector(scene, proposals, [], abortSignal);
    emitRoleplayEvent(onRoleplayEvent, 'director_decision', {
      chapterRef: targetChapter.name,
      sceneId: scene.sceneId,
      title: scene.title || scene.sceneId,
      summary: `导演完成「${scene.title || scene.sceneId}」第一版仲裁。`,
      details: { round: 0, ...compactDirectorDecision(firstDirector) },
      riskLevel: hasDirectorRisk(firstDirector) ? 'high' : 'none',
    });
    const interactionResponses = [];
    const rounds = interactionLevel === 'deep_interaction' ? configuredRounds : interactionLevel === 'director_mediated' ? 1 : 0;
    let currentDirector = firstDirector;
    for (let round = 0; round < rounds; round += 1) {
      const approvedSummary = normalizeList(currentDirector.approvedBeats)
        .slice(0, 8)
        .map((beat) => `${beat.characterId || ''}:${beat.type || ''}:${beat.content || ''}`)
        .join('\n');
      if (!approvedSummary) break;
      emitProgress(onProgress, `导演视角：第 ${round + 1}/${rounds} 轮互动，角色根据已批准动作继续回应。`, {
        stage: 'roleplay_interaction_round',
        sceneId: scene.sceneId,
        round: round + 1,
        totalRounds: rounds,
      });
      const roundResponses = await Promise.all(actors.slice(0, 3).map(({ character, memory }) => runActor(
        scene,
        character,
        memory,
        { round: round + 1, approvedInteractionSoFar: approvedSummary },
        abortSignal
      )));
      interactionResponses.push(...roundResponses);
      roundResponses.forEach((proposal, index) => {
        const actor = actors[index]?.character || {};
        const compactProposal = compactActorProposal(proposal, actor);
        emitRoleplayEvent(onRoleplayEvent, 'actor_proposal', {
          chapterRef: targetChapter.name,
          sceneId: scene.sceneId,
          title: scene.title || scene.sceneId,
          actor: { id: compactProposal.characterId, name: compactProposal.characterName },
          summary: `${compactProposal.characterName || compactProposal.characterId} 在第 ${round + 1} 轮互动后继续回应。`,
          details: { round: round + 1, ...compactProposal },
          riskLevel: compactProposal.wouldResistOutline || compactProposal.risks.length ? 'medium' : 'none',
        });
      });
      emitProgress(onProgress, `导演视角：第 ${round + 1} 轮回应完成，导演正在筛选可写入 beats。`, {
        stage: 'roleplay_director_review',
        sceneId: scene.sceneId,
        round: round + 1,
      });
      currentDirector = await runDirector(scene, proposals, interactionResponses, abortSignal);
      emitRoleplayEvent(onRoleplayEvent, 'director_decision', {
        chapterRef: targetChapter.name,
        sceneId: scene.sceneId,
        title: scene.title || scene.sceneId,
        summary: `导演完成「${scene.title || scene.sceneId}」第 ${round + 1} 轮仲裁。`,
        details: { round: round + 1, ...compactDirectorDecision(currentDirector) },
        riskLevel: hasDirectorRisk(currentDirector) ? 'high' : 'none',
      });
    }
    emitProgress(onProgress, `导演视角：场景「${scene.title || scene.sceneId}」完成，已交给 writer 使用。`, {
      stage: 'roleplay_scene_done',
      sceneId: scene.sceneId,
      approvedBeatCount: normalizeList(currentDirector.approvedBeats).length,
    });
    scenePlans.push(currentDirector);
  }

  const roleplayPlan = {
    chapterRef: targetChapter.name,
    interactionLevel,
    maxInteractionRounds: configuredRounds,
    scenePlans,
    profileWarnings: profileGate?.missingCharacters || [],
    globalWriterNotes: [
      '角色反应已由导演层筛选。writer 必须遵循 approvedBeats，不得新增改变大纲结果的重大动机或行动。',
    ],
  };
  const riskyScenes = scenePlans
    .filter(hasDirectorRisk)
    .map((decision) => compactDirectorDecision(decision));
  emitRoleplayEvent(onRoleplayEvent, 'plan_ready', {
    chapterRef: targetChapter.name,
    title: targetChapter.displayName || targetChapter.name,
    summary: riskyScenes.length
      ? `角色驱动规划完成，但 ${riskyScenes.length} 个场景存在大纲风险。`
      : '角色驱动规划完成，准备交给 writer 成文。',
    details: {
      sceneCount: scenePlans.length,
      riskySceneCount: riskyScenes.length,
      riskyScenes,
    },
    riskLevel: riskyScenes.length ? 'high' : 'none',
  });

  if (pauseOnRisk && riskyScenes.length) {
    return {
      status: 'risk_blocked',
      roleplayPlan,
      profileWarnings: profileGate?.missingCharacters || [],
      riskDecision: {
        chapterRef: targetChapter.name,
        title: targetChapter.displayName || targetChapter.name,
        riskyScenes,
      },
    };
  }

  return {
    status: 'ready',
    roleplayPlan,
  };
}

async function updateCharacterMemoriesForChapter({ draft, outlineContext, abortSignal }) {
  const dir = activeNovelDir();
  if (!dir || !draft?.text || !draft?.name) return { updated: 0 };
  const characterIds = Array.from(new Set((normalizeList(outlineContext?.outlineNodes)
    .flatMap((node) => normalizeList(node.characters))))).slice(0, 8);
  if (!characterIds.length) return { updated: 0 };
  const characters = [];
  const memories = [];
  for (const id of characterIds) {
    const character = await novelData.readCharacter(dir, id);
    if (!character) continue;
    characters.push(summarizeCharacter(character));
    memories.push(summarizeMemory(await novelData.readCharacterMemory(dir, character.id)));
  }
  if (!characters.length) return { updated: 0 };
  const result = await runSubagent({
    subagentId: 'sa-character-memory-updater',
    input: JSON.stringify({ chapter: draft, characters, memories }, null, 2),
    userLang: 'zh-CN',
    abortSignal,
  });
  const parsed = parseJsonFromText(result.output || '', { memoryPatches: [] });
  let updated = 0;
  for (const item of normalizeList(parsed?.memoryPatches)) {
    if (!item?.characterId || !item.patch || typeof item.patch !== 'object') continue;
    await novelData.patchCharacterMemory(
      dir,
      item.characterId,
      makeIdempotentMemoryPatch(item.patch, draft.name, item.characterId)
    );
    updated += 1;
  }
  return { updated };
}

module.exports = {
  buildRoleplayPlan,
  buildProfileGate,
  proposeProfileAutofill,
  applyProfileAutofill,
  updateCharacterMemoriesForChapter,
  _testScenePacketsFromContext: scenePacketsFromContext,
  _testTextFieldQuality: textFieldQuality,
  _testCompactActorProposal: compactActorProposal,
  _testCompactDirectorDecision: compactDirectorDecision,
  _testHasDirectorRisk: hasDirectorRisk,
  _testMakeIdempotentMemoryPatch: makeIdempotentMemoryPatch,
};
