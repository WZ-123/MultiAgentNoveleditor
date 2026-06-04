'use strict';

const novelData = require('../store/novelData');
const mcpClient = require('../mcp/mcpClientStdio');
const { getActiveNovelContext } = require('./activeNovelContext');
const { runSubagent } = require('./runSubagent');

const REQUIRED_FIELDS = ['personality', 'speechStyle', 'appearance', 'relationships', 'storyArc'];
const WEAK_TEXT_LENGTH = 24;

function parseJsonFromText(text, fallback = null) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ }
    }
  }
  return fallback;
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
  })).filter((scene) => scene.appearingCharacterIds.length);
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

async function buildRoleplayPlan({ targetChapter, compactContext, interactionLevel, ignoreProfileGate, userText, abortSignal }) {
  const dir = activeNovelDir();
  if (!dir) return { status: 'skipped', reason: 'no_active_novel' };
  const profileGate = await buildProfileGate({ targetChapter, compactContext });
  if (profileGate && !ignoreProfileGate) {
    return { status: 'profile_gate_blocked', profileGate };
  }

  const scenes = scenePacketsFromContext(targetChapter, compactContext);
  if (!scenes.length) {
    return {
      status: 'ready',
      roleplayPlan: null,
      profileWarnings: profileGate?.missingCharacters || [],
      reason: 'no_scene_characters',
    };
  }

  const scenePlans = [];
  for (const scene of scenes.slice(0, 6)) {
    const actorIds = scene.appearingCharacterIds.slice(0, 4);
    const actors = [];
    for (const id of actorIds) {
      const character = await novelData.readCharacter(dir, id);
      if (!character) continue;
      const memory = await novelData.readCharacterMemory(dir, character.id);
      actors.push({ character, memory });
    }
    const proposals = await Promise.all(actors.map(({ character, memory }) => runActor(scene, character, memory, null, abortSignal)));
    let firstDirector = await runDirector(scene, proposals, [], abortSignal);
    const interactionResponses = [];
    const rounds = interactionLevel === 'deep_interaction' ? 2 : interactionLevel === 'director_mediated' ? 1 : 0;
    let currentDirector = firstDirector;
    for (let round = 0; round < rounds; round += 1) {
      const approvedSummary = normalizeList(currentDirector.approvedBeats)
        .slice(0, 8)
        .map((beat) => `${beat.characterId || ''}:${beat.type || ''}:${beat.content || ''}`)
        .join('\n');
      if (!approvedSummary) break;
      const roundResponses = await Promise.all(actors.slice(0, 3).map(({ character, memory }) => runActor(
        scene,
        character,
        memory,
        { round: round + 1, approvedInteractionSoFar: approvedSummary },
        abortSignal
      )));
      interactionResponses.push(...roundResponses);
      currentDirector = await runDirector(scene, proposals, interactionResponses, abortSignal);
    }
    scenePlans.push(currentDirector);
  }

  return {
    status: 'ready',
    roleplayPlan: {
      chapterRef: targetChapter.name,
      interactionLevel,
      scenePlans,
      profileWarnings: profileGate?.missingCharacters || [],
      globalWriterNotes: [
        '角色反应已由导演层筛选。writer 必须遵循 approvedBeats，不得新增改变大纲结果的重大动机或行动。',
      ],
    },
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
    await novelData.patchCharacterMemory(dir, item.characterId, item.patch);
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
};
