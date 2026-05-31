'use strict';

/**
 * MCP tool definitions. Each tool entry:
 *   {
 *     name, description, inputSchema (JSON Schema),
 *     requiresConfirmation: boolean,
 *     handler: async (args, ctx) -> { content: [{type:'text', text}] }
 *   }
 *
 * ctx = { novelDir, paths, novel, runId, subagentId, fs }
 */

const path = require('node:path');
const fs = require('node:fs').promises;
const novelData = require('../store/novelData');
const { paths: globalPaths } = require('../store/paths');
const { readJson } = require('../store/jsonStore');
const { checkFeasibility, placesToMap, distanceBetweenPlaceNames, SPEED_KMH } = require('./feasibility');
const characterEnricher = require('../import/characterEnricher');
const stagingProject = require('../import/stagingProject');
const {
  buildCharacterConsistencyReviewPayload,
  enrichCharacterConsistencyAnnotations,
  resolveTargetCharacters,
  splitIntoParagraphs,
} = require('../runtime/chapterCharacterReview');
const { getSystemTimeInfo } = require('../runtime/systemTime');

function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text }] };
}

function notifyChapterChanged(name, action, title) {
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send('mana:chapter:changed', { name, action, title: title || null }); } catch {}
    }
  } catch {
    // ignore renderer sync failures
  }
}

function requireNovel(ctx) {
  if (!ctx?.novelDir) {
    throw new Error('No active novel: this tool requires an open novel.');
  }
  return ctx.novelDir;
}

function _hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function _cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function _parseObjectArg(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function _mergeRawArgs(args, action, canProceedWithoutRaw) {
  const direct = args && typeof args === 'object' ? { ...args } : {};
  const hadRaw = Object.prototype.hasOwnProperty.call(direct, '__raw');
  const raw = _parseObjectArg(direct.__raw);
  delete direct.__raw;
  if (hadRaw && !raw && !canProceedWithoutRaw(direct)) {
    throw new Error(`${action} received invalid __raw JSON object`);
  }
  return raw ? { ...raw, ...direct } : direct;
}

function _coerceRelationships(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return undefined;
  if ('target' in value || 'with' in value || 'type' in value || 'description' in value) {
    return [value];
  }
  const out = [];
  for (const [target, relation] of Object.entries(value)) {
    const safeTarget = _cleanText(target);
    if (!safeTarget) continue;
    if (typeof relation === 'string') {
      const description = relation.trim();
      out.push({ target: safeTarget, type: '', description });
      continue;
    }
    if (relation && typeof relation === 'object' && !Array.isArray(relation)) {
      out.push({ target: safeTarget, ...relation });
    }
  }
  return out.length ? out : undefined;
}

function _parseJsonText(text, fallback = null) {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function _compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function _excerptParagraph(text) {
  const compacted = _compactText(text);
  return compacted.length > 80 ? `${compacted.slice(0, 80)}...` : compacted;
}

function _normalizeQualityAnnotations(paragraphs, rawAnnotations) {
  const paragraphMap = new Map((Array.isArray(paragraphs) ? paragraphs : []).map((paragraph) => [paragraph.id, paragraph]));
  const validIds = new Set(paragraphMap.keys());
  const annotations = [];
  const seen = new Set();

  for (const annotation of Array.isArray(rawAnnotations) ? rawAnnotations : []) {
    const paragraphIds = Array.isArray(annotation?.paragraphIds)
      ? annotation.paragraphIds.map((item) => _compactText(item)).filter((item) => validIds.has(item))
      : [];
    const fallbackId = _compactText(annotation?.paragraphId);
    const targets = paragraphIds.length > 0
      ? paragraphIds
      : validIds.has(fallbackId)
        ? [fallbackId]
        : [];
    if (!targets.length) continue;

    const note = _compactText(annotation?.note);
    const kind = _compactText(annotation?.kind) || 'other';
    const key = `${targets.join(',')}::${kind}::${note}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const firstParagraph = paragraphMap.get(targets[0]);
    const paragraphIndexes = targets
      .map((paragraphId) => paragraphMap.get(paragraphId)?.index)
      .filter((index) => Number.isInteger(index));

    annotations.push({
      paragraphId: targets[0],
      paragraphIds: targets,
      paragraphIndex: Number.isInteger(firstParagraph?.index) ? firstParagraph.index : -1,
      paragraphIndexes,
      excerpt: _excerptParagraph(firstParagraph?.text || ''),
      kind,
      note,
    });
  }

  return annotations.sort((left, right) => left.paragraphIndex - right.paragraphIndex);
}

async function _loadQualityReviewHelpers() {
  const mod = await import(path.join(__dirname, '..', '..', 'services', 'qualityReview.mjs'));
  return {
    buildQualityReviewPayload: mod.buildQualityReviewPayload,
    detectCrossParagraphQualityAnnotations: mod.detectCrossParagraphQualityAnnotations,
  };
}

async function _reviewChapterDeAiStyle(chapterName, focus, ctx) {
  const dir = requireNovel(ctx);
  const chapterText = await novelData.readChapter(dir, chapterName);
  if (!_cleanText(chapterText)) {
    throw new Error(`chapter is empty or missing: ${chapterName}`);
  }

  const paragraphs = splitIntoParagraphs(chapterText);
  const { buildQualityReviewPayload, detectCrossParagraphQualityAnnotations } = await _loadQualityReviewHelpers();
  const payload = buildQualityReviewPayload(paragraphs);
  payload.chapterName = chapterName;
  payload.focus = _cleanText(focus);

  const workflowOrchestrator = require('../runtime/workflowOrchestrator');
  const result = await workflowOrchestrator.runWorkflow({
    mode: 'subagent',
    subagentId: 'sa-prose-quality',
    input: JSON.stringify(payload),
    novelContext: ctx?.novel
      ? { novelId: ctx.novel.id || null, novelDir: ctx.novelDir || null }
      : undefined,
  });

  const parsed = _parseJsonText(String(result.output || ''), { annotations: [] });
  const modelAnnotations = _normalizeQualityAnnotations(paragraphs, parsed?.annotations);
  const crossParagraphAnnotations = _normalizeQualityAnnotations(
    paragraphs,
    detectCrossParagraphQualityAnnotations(paragraphs)
  );
  const merged = [];
  const seen = new Set();
  for (const annotation of [...modelAnnotations, ...crossParagraphAnnotations]) {
    const key = `${annotation.paragraphId}::${annotation.kind}::${annotation.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(annotation);
  }

  return {
    chapterName,
    annotations: merged.sort((left, right) => left.paragraphIndex - right.paragraphIndex),
  };
}

function _coerceChapterPatchArgs(args) {
  const payload = args && typeof args === 'object' ? { ...args } : {};
  const parsedEdits = Array.isArray(payload.edits)
    ? payload.edits
    : _parseJsonText(payload.edits, null);
  payload.edits = Array.isArray(parsedEdits) ? parsedEdits : [];
  payload.baseContent = typeof payload.baseContent === 'string' ? payload.baseContent : '';
  if (!_cleanText(payload.name)) {
    throw new Error('apply_chapter_patch requires a valid chapter name');
  }
  if (!payload.edits.length) {
    throw new Error('apply_chapter_patch requires a non-empty edits array');
  }
  return payload;
}

function _coerceCreateCharacterArgs(args) {
  const payload = _mergeRawArgs(args, 'create_character', (direct) => !!_cleanText(direct.name));
  if (!payload.relationships && payload.relationship) {
    payload.relationships = _coerceRelationships(payload.relationship);
  }
  delete payload.relationship;
  if (!_cleanText(payload.name)) {
    throw new Error('create_character requires a valid name');
  }
  return payload;
}

function _coerceUpdateCharacterArgs(args) {
  const payload = _mergeRawArgs(args, 'update_character', (direct) => {
    return !!_cleanText(direct.id || direct.characterId);
  });
  const id = _cleanText(payload.id || payload.characterId);
  let patch = _parseObjectArg(payload.patch) || (payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch) ? payload.patch : null);

  if (!patch) {
    const inferred = { ...payload };
    delete inferred.id;
    delete inferred.characterId;
    delete inferred.patch;
    patch = inferred;
  }

  if (patch && Object.prototype.hasOwnProperty.call(patch, '__raw')) {
    const rawPatch = _parseObjectArg(patch.__raw);
    if (!rawPatch) throw new Error('update_character received invalid patch.__raw JSON object');
    patch = { ...rawPatch, ...patch };
    delete patch.__raw;
  }

  if (!patch.relationships && patch.relationship) {
    patch.relationships = _coerceRelationships(patch.relationship);
  }
  delete patch.relationship;

  if (!id) throw new Error('update_character requires a valid id');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('update_character requires a patch object');
  }

  return { id, patch };
}

function _coerceDeleteCharacterArgs(args) {
  const payload = _mergeRawArgs(args, 'delete_character', (direct) => {
    return !!_cleanText(direct.id || direct.characterId);
  });
  const id = _cleanText(payload.id || payload.characterId);
  if (!id) throw new Error('delete_character requires a valid id');
  return { id };
}

function _coerceWorldWriteArgs(args, action = 'update_world') {
  const payload = args && typeof args === 'object' ? { ...args } : {};
  const hadPlaces = _hasOwn(payload, 'places');
  const parsedPlaces = Array.isArray(payload.places) ? payload.places : _parseJsonText(payload.places, null);
  if (hadPlaces && !Array.isArray(parsedPlaces)) {
    throw new Error(`${action} requires places to be an array when provided`);
  }
  if (hadPlaces) payload.places = parsedPlaces;

  const hadBasePlaces = _hasOwn(payload, 'basePlaces');
  const parsedBasePlaces = Array.isArray(payload.basePlaces) ? payload.basePlaces : _parseJsonText(payload.basePlaces, null);
  if (hadBasePlaces && !Array.isArray(parsedBasePlaces)) {
    throw new Error(`${action} requires basePlaces to be an array when provided`);
  }
  if (hadBasePlaces) payload.basePlaces = parsedBasePlaces;

  if (_hasOwn(payload, 'lore') && typeof payload.lore !== 'string') {
    throw new Error(`${action} requires lore to be a string when provided`);
  }
  if (_hasOwn(payload, 'baseLore') && typeof payload.baseLore !== 'string') {
    throw new Error(`${action} requires baseLore to be a string when provided`);
  }
  return payload;
}

function _coerceWorldPatchArgs(args) {
  const payload = _coerceWorldWriteArgs(args, 'apply_world_patch');

  const hadLoreEdits = _hasOwn(payload, 'loreEdits');
  const parsedLoreEdits = Array.isArray(payload.loreEdits) ? payload.loreEdits : _parseJsonText(payload.loreEdits, null);
  if (hadLoreEdits && !Array.isArray(parsedLoreEdits)) {
    throw new Error('apply_world_patch requires loreEdits to be an array when provided');
  }
  payload.loreEdits = Array.isArray(parsedLoreEdits) ? parsedLoreEdits : [];

  const hadPlaceUpserts = _hasOwn(payload, 'placeUpserts');
  const parsedPlaceUpserts = Array.isArray(payload.placeUpserts) ? payload.placeUpserts : _parseJsonText(payload.placeUpserts, null);
  if (hadPlaceUpserts && !Array.isArray(parsedPlaceUpserts)) {
    throw new Error('apply_world_patch requires placeUpserts to be an array when provided');
  }
  payload.placeUpserts = Array.isArray(parsedPlaceUpserts) ? parsedPlaceUpserts : [];

  const hadPlaceDeletes = _hasOwn(payload, 'placeDeletes');
  const parsedPlaceDeletes = Array.isArray(payload.placeDeletes) ? payload.placeDeletes : _parseJsonText(payload.placeDeletes, null);
  if (hadPlaceDeletes && !Array.isArray(parsedPlaceDeletes)) {
    throw new Error('apply_world_patch requires placeDeletes to be an array when provided');
  }
  payload.placeDeletes = Array.isArray(parsedPlaceDeletes)
    ? parsedPlaceDeletes.map((item) => (typeof item === 'string' ? item : item?.name)).map((item) => _cleanText(item)).filter(Boolean)
    : [];

  if (_hasOwn(payload, 'loreReplacement') && typeof payload.loreReplacement !== 'string') {
    throw new Error('apply_world_patch requires loreReplacement to be a string when provided');
  }

  if (!_hasOwn(payload, 'loreReplacement') && !payload.loreEdits.length && !payload.placeUpserts.length && !payload.placeDeletes.length) {
    throw new Error('apply_world_patch requires at least one lore or place edit');
  }

  return payload;
}

function _coerceAssetAuthArgs(args, action) {
  const payload = args && typeof args === 'object' ? { ...args } : {};
  const assetId = _cleanText(payload.assetId || payload.id);
  const charId = _cleanText(payload.charId || payload.characterId);
  if (!assetId) throw new Error(`${action} requires a valid assetId`);
  if (!charId) throw new Error(`${action} requires a valid charId`);
  if (_hasOwn(payload, 'chapterRef') && typeof payload.chapterRef !== 'string') {
    throw new Error(`${action} requires chapterRef to be a string when provided`);
  }
  if (_hasOwn(payload, 'note') && typeof payload.note !== 'string') {
    throw new Error(`${action} requires note to be a string when provided`);
  }
  if (_hasOwn(payload, 'at') && typeof payload.at !== 'string') {
    throw new Error(`${action} requires at to be a string when provided`);
  }
  if (_hasOwn(payload, 'baseGrantedTo')) {
    const parsedBaseGrantedTo = Array.isArray(payload.baseGrantedTo) ? payload.baseGrantedTo : _parseJsonText(payload.baseGrantedTo, null);
    if (!Array.isArray(parsedBaseGrantedTo)) {
      throw new Error(`${action} requires baseGrantedTo to be an array when provided`);
    }
    payload.baseGrantedTo = parsedBaseGrantedTo;
  }
  return {
    assetId,
    charId,
    ...(_hasOwn(payload, 'chapterRef') ? { chapterRef: payload.chapterRef } : {}),
    ...(_hasOwn(payload, 'note') ? { note: payload.note } : {}),
    ...(_hasOwn(payload, 'at') ? { at: payload.at } : {}),
    ...(_hasOwn(payload, 'baseGrantedTo') ? { baseGrantedTo: payload.baseGrantedTo } : {}),
  };
}

function _coerceAssetPatchArgs(args) {
  const payload = args && typeof args === 'object' ? { ...args } : {};
  const parsedEdits = Array.isArray(payload.edits) ? payload.edits : _parseJsonText(payload.edits, null);
  if (!Array.isArray(parsedEdits) || !parsedEdits.length) {
    throw new Error('apply_asset_patch requires a non-empty edits array');
  }
  payload.edits = parsedEdits.map((edit, index) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      throw new Error(`apply_asset_patch edit ${index + 1} must be an object`);
    }
    const assetId = _cleanText(edit.assetId || edit.id);
    if (!assetId) throw new Error(`apply_asset_patch edit ${index + 1} requires assetId`);

    const nextEdit = { assetId };
    if (_hasOwn(edit, 'baseGrantedTo')) {
      const parsedBaseGrantedTo = Array.isArray(edit.baseGrantedTo) ? edit.baseGrantedTo : _parseJsonText(edit.baseGrantedTo, null);
      if (!Array.isArray(parsedBaseGrantedTo)) {
        throw new Error(`apply_asset_patch edit ${index + 1} requires baseGrantedTo to be an array when provided`);
      }
      nextEdit.baseGrantedTo = parsedBaseGrantedTo;
    }

    const parsedOperations = Array.isArray(edit.operations) ? edit.operations : _parseJsonText(edit.operations, null);
    if (!Array.isArray(parsedOperations) || !parsedOperations.length) {
      throw new Error(`apply_asset_patch edit ${index + 1} requires a non-empty operations array`);
    }

    nextEdit.operations = parsedOperations.map((operation, opIndex) => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        throw new Error(`apply_asset_patch operation ${opIndex + 1} for ${assetId} must be an object`);
      }
      const action = _cleanText(operation.action).toLowerCase();
      if (action !== 'grant' && action !== 'revoke') {
        throw new Error(`apply_asset_patch operation ${opIndex + 1} for ${assetId} requires action "grant" or "revoke"`);
      }
      const charId = _cleanText(operation.charId || operation.characterId);
      if (!charId) {
        throw new Error(`apply_asset_patch operation ${opIndex + 1} for ${assetId} requires charId`);
      }
      if (_hasOwn(operation, 'chapterRef') && typeof operation.chapterRef !== 'string') {
        throw new Error(`apply_asset_patch operation ${opIndex + 1} for ${assetId} requires chapterRef to be a string when provided`);
      }
      if (_hasOwn(operation, 'note') && typeof operation.note !== 'string') {
        throw new Error(`apply_asset_patch operation ${opIndex + 1} for ${assetId} requires note to be a string when provided`);
      }
      if (_hasOwn(operation, 'at') && typeof operation.at !== 'string') {
        throw new Error(`apply_asset_patch operation ${opIndex + 1} for ${assetId} requires at to be a string when provided`);
      }
      return {
        action,
        charId,
        ...(_hasOwn(operation, 'chapterRef') ? { chapterRef: operation.chapterRef } : {}),
        ...(_hasOwn(operation, 'note') ? { note: operation.note } : {}),
        ...(_hasOwn(operation, 'at') ? { at: operation.at } : {}),
      };
    });

    return nextEdit;
  });
  return payload;
}

// ── Character context filtering for scene-aware writing (AB hybrid) ──

function _condense(str, maxLen) {
  if (!str) return '';
  const s = String(str).trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

function _matchSkin(skins, outfitHint) {
  if (!Array.isArray(skins) || !outfitHint) return null;
  const hint = String(outfitHint).toLowerCase();
  // Exact or partial match on skin name
  return skins.find((s) => s.name && (
    s.name.toLowerCase() === hint ||
    s.name.toLowerCase().includes(hint) ||
    hint.includes(s.name.toLowerCase())
  )) || null;
}

function filterCharacterContext(char, { needBackground, outfit } = {}) {
  const result = {
    id: char.id,
    name: char.name,
    aliases: char.aliases,
    role: char.role,
    faction: char.faction,
  };

  // Tier 1: always include (condensed)
  if (char.personality) result.personality = _condense(char.personality, 300);
  if (char.appearance) result.appearance = _condense(char.appearance, 400);

  // Physical traits (short, always)
  if (char.hairColor) result.hairColor = char.hairColor;
  if (char.eyeColor) result.eyeColor = char.eyeColor;
  if (char.height) result.height = char.height;
  if (char.figure) result.figure = char.figure;
  if (char.moeTraits) result.moeTraits = char.moeTraits;
  if (char.quotes) result.quotes = char.quotes;

  // Tier 2: conditional
  if (needBackground && char.background) {
    result.background = _condense(char.background, 600);
  }

  // Skins: if outfit hint provided, return only the matching skin + currentOutfit marker
  if (Array.isArray(char.skins) && char.skins.length > 0) {
    if (outfit) {
      const matched = _matchSkin(char.skins, outfit);
      if (matched) {
        result.skins = [matched];
        result.currentOutfit = matched.name;
      }
    }
    // If no outfit hint or no match, omit skins to avoid hallucination
  }

  return result;
}

const TOOLS = [
  // ---------------- READ ----------------
  {
    name: 'list_characters',
    description: '列出当前小说中所有角色卡（id/name/aliases/role/faction）摘要。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      const list = await novelData.listCharacters(dir);
      const slim = list.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, role: c.role, faction: c.faction }));
      return textResult({ characters: slim });
    },
  },
  {
    name: 'read_character',
    description: '读取单个角色的完整信息。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const c = await novelData.readCharacter(dir, args.id);
      if (!c) throw new Error(`character not found: ${args.id}`);
      return textResult(c);
    },
  },
  {
    name: 'read_character_context',
    description: '读取单个角色的「场景过滤版」信息。根据当前场景需要，只返回相关的角色字段，避免一次性注入完整人设卡导致AI幻觉。参数可指定是否需要背景故事、当前穿着的皮肤/服装。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '角色ID' },
        sceneContext: { type: 'string', description: '当前场景描述（可选，用于判断需要哪些信息）' },
        needBackground: { type: 'boolean', description: '是否需要包含角色背景故事' },
        outfit: { type: 'string', description: '当前场景中的着装/皮肤名称（如"泳装-夏日"），匹配到则返回该皮肤的妆造和故事' },
      },
      required: ['id'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const c = await novelData.readCharacter(dir, args.id);
      if (!c) throw new Error(`character not found: ${args.id}`);
      const filtered = filterCharacterContext(c, {
        needBackground: args.needBackground,
        outfit: args.outfit,
      });
      return textResult(filtered);
    },
  },
  {
    name: 'read_outline_nodes',
    description: '读取结构化大纲节点列表（含场景元数据）。level=1 卷, level=2 节, level=3 章。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      const data = await novelData.readOutlineNodes(dir);
      return textResult(data || { schemaVersion: 1, nodes: [] });
    },
  },
  {
    name: 'assemble_scene_context',
    description: '根据大纲节点ID自动装配场景角色上下文。读取该节点的元数据（characters/outfit/setting/needBackground），为每个角色调用过滤后的上下文并合并输出。这是「A方案」自动装配入口。',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '大纲节点ID' },
      },
      required: ['nodeId'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const data = await novelData.readOutlineNodes(dir);
      const nodes = data?.nodes || [];
      const node = nodes.find((n) => n.id === args.nodeId);
      if (!node) throw new Error(`outline node not found: ${args.nodeId}`);

      const results = [];
      if (Array.isArray(node.characters)) {
        for (const charId of node.characters) {
          const c = await novelData.readCharacter(dir, charId);
          if (!c) continue;
          const filtered = filterCharacterContext(c, {
            needBackground: node.needBackground,
            outfit: node.outfit,
          });
          results.push(filtered);
        }
      }

      return textResult({
        nodeId: node.id,
        title: node.title,
        setting: node.setting || '',
        location: node.location || '',
        pov: node.pov || '',
        outfit: node.outfit || '',
        characters: results,
      });
    },
  },
  {
    name: 'list_assets',
    description: '列出当前小说全部物品/资源资产。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      return textResult({ assets: await novelData.listAssets(dir) });
    },
  },
  {
    name: 'read_asset',
    description: '读取单个资产详情。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const a = await novelData.readAsset(dir, args.id);
      if (!a) throw new Error(`asset not found: ${args.id}`);
      return textResult(a);
    },
  },
  {
    name: 'query_timeline',
    description: '查询时间线事件，可按角色/章节/时间范围过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        participant: { type: 'string' },
        chapterRef: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const events = await novelData.queryTimeline(dir, args || {});
      return textResult({ events });
    },
  },
  {
    name: 'check_timeline_feasibility',
    description: '基于角色出场时空对，估算能否合理通行（参数:characterId, transport）。',
    inputSchema: {
      type: 'object',
      properties: {
        characterId: { type: 'string' },
        transport: { type: 'string', description: 'walk|run|horse|car|train|plane|magic' },
      },
      required: ['characterId'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const events = await novelData.queryTimeline(dir, { participant: args.characterId });
      events.sort((a, b) => new Date(a.when) - new Date(b.when));
      const issues = [];
      for (let i = 1; i < events.length; i += 1) {
        const r = checkFeasibility(events[i - 1], events[i], { transport: args.transport });
        if (!r.feasible) {
          issues.push({ from: events[i - 1].id, to: events[i].id, ...r });
        }
      }
      return textResult({ characterId: args.characterId, issues, sampled: events.length });
    },
  },
  {
    name: 'check_outline_scene_feasibility',
    description: '基于大纲场景节点校验角色移动可行性（大纲阶段专用）。分析角色在连续场景间的位置变化，用地名坐标估算距离，用章节序号估算时间窗，判断移动是否合理。不会查询或修改已保存的时间线事件。',
    inputSchema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          description: '扁平场景节点数组。每条必须包含 id, characters, location, chapterIndex，可选 volumeIndex/sectionIndex。从 outline.volumes[].sections[].chapterOutlines[].scenes 构建。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '场景ID' },
              title: { type: 'string', description: '场景标题' },
              characters: { type: 'array', items: { type: 'string' }, description: '出场角色 ID 列表' },
              location: { type: 'string', description: '地点名称，应与 places.json 中的 name 匹配' },
              chapterIndex: { type: 'number', description: '章索引（从1开始）' },
              volumeIndex: { type: 'number', description: '卷索引（从1开始）' },
              sectionIndex: { type: 'number', description: '节索引（从1开始）' },
            },
            required: ['id', 'characters', 'location', 'chapterIndex'],
          },
        },
        transport: {
          type: 'string',
          description: '默认交通方式：walk(5km/h) | run(15) | horse(30) | car(60) | train(200) | plane(800) | magic(instant)。默认 walk',
          default: 'walk',
        },
        hoursPerChapter: {
          type: 'number',
          description: '每章估算时长（小时），默认 6。用于将 chapterIndex 差值估算为可用时间窗。古代徒步一章约12h，现代交通一章约3h，奇幻传送阵可用 magic+1h',
          default: 6,
        },
      },
      required: ['scenes'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const world = await novelData.readWorld(dir);
      const placesMap = placesToMap(world.places || []);
      const scenes = args.scenes || [];
      const transport = args.transport || 'walk';
      const speed = SPEED_KMH[transport] ?? SPEED_KMH.walk;
      const hpChapter = (typeof args.hoursPerChapter === 'number') ? args.hoursPerChapter : 6;

      // 1. Group scenes by character
      const charScenes = {};
      for (const scene of scenes) {
        for (const charId of (scene.characters || [])) {
          if (!charScenes[charId]) charScenes[charId] = [];
          charScenes[charId].push(scene);
        }
      }

      // 2. Per character: sort by hierarchical index
      const characterPairs = [];
      for (const [charId, rawList] of Object.entries(charScenes)) {
        const sorted = [...rawList].sort((a, b) => {
          const va = a.volumeIndex || 0;
          const vb = b.volumeIndex || 0;
          if (va !== vb) return va - vb;
          const sa = a.sectionIndex || 0;
          const sb = b.sectionIndex || 0;
          if (sa !== sb) return sa - sb;
          return (a.chapterIndex || 0) - (b.chapterIndex || 0);
        });

        const issues = [];
        let checkedCount = 0;
        for (let i = 1; i < sorted.length; i++) {
          const from = sorted[i - 1];
          const to = sorted[i];
          const dist = distanceBetweenPlaceNames(from.location, to.location, placesMap);
          if (dist == null) continue;

          checkedCount++;
          if (dist === 0) continue;

          const chapterDiff = (to.chapterIndex || 0) - (from.chapterIndex || 0);
          const elapsedHours = Math.max(chapterDiff * hpChapter, 0.5);
          const neededHours = dist / speed;

          if (neededHours > elapsedHours + 1e-6) {
            issues.push({
              characterId: charId,
              fromSceneId: from.id,
              fromSceneTitle: from.title || '',
              fromLocation: from.location,
              fromChapterIndex: from.chapterIndex,
              toSceneId: to.id,
              toSceneTitle: to.title || '',
              toLocation: to.location,
              toChapterIndex: to.chapterIndex,
              chapterGap: chapterDiff,
              distanceKm: Math.round(dist * 10) / 10,
              elapsedHours: Math.round(elapsedHours * 10) / 10,
              neededHours: Math.round(neededHours * 10) / 10,
              transport,
              feasible: false,
              reason: `从【${from.location}】到【${to.location}】直线距离约${Math.round(dist)}km，${transport}需要约${Math.round(neededHours)}h，场景间隔${chapterDiff}章（约${Math.round(elapsedHours)}h），无法到达。`,
            });
          }
        }

        characterPairs.push({ characterId: charId, checkedPairs: checkedCount, issues });
      }

      const knownPlaces = Object.keys(placesMap);

      return textResult({
        tool: 'check_outline_scene_feasibility',
        checksPerformed: true,
        charactersChecked: Object.keys(charScenes).length,
        totalScenePairsChecked: characterPairs.reduce((s, c) => s + c.checkedPairs, 0),
        knownPlacesCount: knownPlaces.length,
        defaultTransport: transport,
        hoursPerChapter: hpChapter,
        characterPairs: characterPairs.filter(c => c.issues.length > 0 || c.checkedPairs > 0),
        issues: characterPairs.flatMap(c => c.issues),
      });
    },
  },
  {
    name: 'get_system_time',
    description: '读取当前系统本地时间与时区。时间相关判断应优先使用这个结果，不要默认按 GMT/UTC 推断。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => textResult(getSystemTimeInfo()),
  },
  {
    name: 'query_world',
    description: '读取世界观长文 lore.md 与地名/坐标 places.json。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      return textResult(await novelData.readWorld(dir));
    },
  },
  {
    name: 'read_world',
    description: '兼容旧工具名。等同于 query_world，用于读取世界观 lore.md 与地名/坐标 places.json。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      return textResult(await novelData.readWorld(dir));
    },
  },
  {
    name: 'read_outline',
    description: '读取大纲 Markdown 文件，name 默认 "outline"（总大纲）。可按层级读取：name="outline.md" 总大纲, "volume-001/outline.md" 卷大纲, "volume-001/section-001/outline.md" 节大纲, "volume-001/section-001/chapter-001.md" 章大纲。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const np = ctx.paths;
      const rawName = (args.name || 'outline.md').replace(/\.md$/i, ''); // strip trailing .md if present
      const file = path.join(np.outlines, `${rawName.replace(/[^\w.\-\/]/g, '_')}.md`);
      try {
        const text = await fs.readFile(file, 'utf8');
        return textResult(text);
      } catch (err) {
        if (err.code === 'ENOENT') return textResult('');
        throw err;
      }
    },
  },
  {
    name: 'list_chapters',
    description: '列出当前小说所有章节文件（按字母序）。返回文件名数组如 ["chapter-001.md","chapter-002.md"]。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      const chapters = await novelData.listChapters(dir);
      return textResult(chapters.map((c) => c.name));
    },
  },
  {
    name: 'read_chapter',
    description: '读取某章正文，name 形如 "chapter-001.md"。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      return textResult(await novelData.readChapter(dir, args.name));
    },
  },
  {
    name: 'replace_chapter_text',
    description: '在指定章节中替换正文内容。优先按精确原文片段匹配；如果提供 beforeContext/afterContext，会像 IDE patch 一样结合上下文锚点和规范化匹配（兼容 CRLF、全角/半角、不可见空白）来定位目标。默认要求只命中 1 处。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '章节文件名，如 "chapter-002.md"' },
        targetText: { type: 'string', description: '要被替换的原始正文片段，建议提供足够长的唯一片段' },
        replacement: { type: 'string', description: '替换后的新文本' },
        expectedMatchCount: { type: 'number', description: '预期命中次数。默认 1；若与实际不符则失败。' },
        beforeContext: { type: 'string', description: '可选。targetText 前方附近的一小段原文上下文，用于像 IDE patch 一样锚定目标位置。' },
        afterContext: { type: 'string', description: '可选。targetText 后方附近的一小段原文上下文，用于像 IDE patch 一样锚定目标位置。' },
      },
      required: ['name', 'targetText', 'replacement'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const result = await novelData.replaceChapterText(dir, args.name, args.targetText, args.replacement, {
        expectedMatchCount: Number.isInteger(args.expectedMatchCount) ? args.expectedMatchCount : 1,
        beforeContext: typeof args.beforeContext === 'string' ? args.beforeContext : '',
        afterContext: typeof args.afterContext === 'string' ? args.afterContext : '',
      });
      const title = result.metadata?.title || null;
      notifyChapterChanged(result.name, 'updated', title);
      return textResult({ ok: true, name: result.name, replacedCount: result.replacedCount, matchCount: result.matchCount, matchStrategy: result.matchStrategy });
    },
  },
  {
    name: 'apply_chapter_patch',
    description: '在同一章节快照上一次性应用多处正文修改。每条 edit 都支持 targetText/replacement 以及 beforeContext/afterContext 锚点；工具会先检测重叠冲突，再只写盘一次，避免连续 replace_chapter_text 彼此打坏。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '章节文件名，如 "chapter-002.md"' },
        baseContent: { type: 'string', description: '可选。最近一次 read_chapter 得到的整章正文。若当前文件已变更，工具会拒绝应用，避免把旧快照 patch 打到新内容上。' },
        edits: {
          type: 'array',
          description: '同一章内要一次性应用的多处编辑。每条 edit 都基于同一份原文快照定位。',
          items: {
            type: 'object',
            properties: {
              targetText: { type: 'string', description: '原文片段' },
              replacement: { type: 'string', description: '替换后的文本' },
              expectedMatchCount: { type: 'number', description: '预期命中次数，默认 1' },
              beforeContext: { type: 'string', description: '可选。targetText 前方附近原文，用于锚定位置。' },
              afterContext: { type: 'string', description: '可选。targetText 后方附近原文，用于锚定位置。' },
            },
            required: ['targetText', 'replacement'],
          },
        },
      },
      required: ['name', 'edits'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceChapterPatchArgs(args);
      const result = await novelData.applyChapterPatch(dir, payload.name, payload.edits, {
        baseContent: payload.baseContent,
      });
      const title = result.metadata?.title || null;
      notifyChapterChanged(result.name, 'updated', title);
      return textResult({
        ok: true,
        name: result.name,
        editCount: result.editCount,
        replacedCount: result.replacedCount,
        edits: result.edits,
      });
    },
  },
  {
    name: 'read_style_memory',
    description: '读取本小说累积的「文风记忆」内容。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      return textResult(await novelData.readStyleMemory(dir));
    },
  },
  {
    name: 'read_skill',
    description: '读取全局 skill.md（写作助手参考文档）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const file = globalPaths().skillsMain;
      try {
        const text = await fs.readFile(file, 'utf8');
        return textResult(text);
      } catch (err) {
        if (err.code === 'ENOENT') return textResult('');
        throw err;
      }
    },
  },
  {
    name: 'search_index',
    description: '在 .mana/index.json 中按关键字粗略搜索（name/key/章节出场）。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const np = ctx.paths;
      const idx = await readJson(np.manaIndex, { entries: [] });
      const q = (args.query || '').toLowerCase();
      const hits = (idx.entries || []).filter((e) =>
        JSON.stringify(e).toLowerCase().includes(q)
      );
      return textResult({ hits });
    },
  },

  // ---------------- WRITE (auto) ----------------
  {
    name: 'write_outline_nodes',
    description: '保存结构化大纲节点列表（覆盖写）。若节点含 volumeIndex/sectionIndex/chapterIndex 路由字段，自动按层级分发到 outlines/volume-XXX/section-YYY/chapter-ZZZ.md 等文件。每条可含 title/summary/characters/setting/location/pov/outfit/needBackground/pov 及路由字段。',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: { type: 'array', description: 'OutlineNode 数组。含路由字段(volumeIndex/sectionIndex/chapterIndex)则自动分层，否则平坦写入 nodes.json', items: { type: 'object' } },
      },
      required: ['nodes'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      await novelData.writeOutlineNodesToHierarchy(dir, args.nodes);
      return textResult({ ok: true });
    },
  },
  // ---------------- 层级大纲工具 (Hierarchical Outline) ----------------
  {
    name: 'read_outline_chapter',
    description: '按卷/节/章索引读取单章详细大纲 Markdown（含场景级 nodes 和写作指导）。',
    inputSchema: {
      type: 'object',
      properties: {
        volumeIndex: { type: 'number', description: '卷索引（从1开始）' },
        sectionIndex: { type: 'number', description: '节索引（从1开始）' },
        chapterIndex: { type: 'number', description: '章索引（从1开始）' },
      },
      required: ['volumeIndex', 'sectionIndex', 'chapterIndex'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const text = await novelData.readOutlineChapter(dir, args.volumeIndex, args.sectionIndex, args.chapterIndex);
      return textResult(text || '(空)');
    },
  },
  {
    name: 'read_outline_section',
    description: '按卷/节索引读取节大纲 Markdown。',
    inputSchema: {
      type: 'object',
      properties: {
        volumeIndex: { type: 'number', description: '卷索引（从1开始）' },
        sectionIndex: { type: 'number', description: '节索引（从1开始）' },
      },
      required: ['volumeIndex', 'sectionIndex'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const text = await novelData.readOutlineSection(dir, args.volumeIndex, args.sectionIndex);
      return textResult(text || '(空)');
    },
  },
  {
    name: 'read_outline_volume',
    description: '按卷索引读取卷大纲 Markdown。',
    inputSchema: {
      type: 'object',
      properties: {
        volumeIndex: { type: 'number', description: '卷索引（从1开始）' },
      },
      required: ['volumeIndex'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const text = await novelData.readOutlineVolume(dir, args.volumeIndex);
      return textResult(text || '(空)');
    },
  },
  {
    name: 'write_outline_chapter',
    description: '写入单章大纲（增量更新）。写入 chapter-XXX.md 并同步追加到 nodes.json。',
    inputSchema: {
      type: 'object',
      properties: {
        volumeIndex: { type: 'number', description: '卷索引（从1开始）' },
        sectionIndex: { type: 'number', description: '节索引（从1开始）' },
        chapterIndex: { type: 'number', description: '章索引（从1开始）' },
        title: { type: 'string', description: '章标题' },
        scenes: { type: 'array', description: '场景级 OutlineNode 数组', items: { type: 'object' } },
        writingNotes: { type: 'string', description: '写作指导（可选）' },
      },
      required: ['volumeIndex', 'sectionIndex', 'chapterIndex', 'scenes'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const { volumeIndex, sectionIndex, chapterIndex, title, scenes, writingNotes } = args;
      // Merge with existing nodes.json to avoid data loss
      const existing = await novelData.readOutlineNodes(dir);
      const existingNodes = (existing?.nodes || []).filter(n =>
        !(n.volumeIndex === volumeIndex && n.sectionIndex === sectionIndex && n.chapterIndex === chapterIndex)
      );
      const newNodes = (Array.isArray(scenes) ? scenes : []).map(s => ({
        ...s,
        volumeIndex,
        sectionIndex,
        chapterIndex,
      }));
      const mergedNodes = [...existingNodes, ...newNodes];
      await novelData.writeOutlineNodesToHierarchy(dir, mergedNodes);
      return textResult({ ok: true, sceneCount: (scenes || []).length });
    },
  },
  {
    name: 'write_chapter',
    description: '写入章节内容到 chapters/ 目录。content 为 Markdown 正文（不含 frontmatter）。可选 title/volumeIndex/sectionIndex 写入 frontmatter。可选 baseContent 作为最近一次 read_chapter 的原文快照；若当前章节已变化，写入会拒绝，避免旧全文覆盖新内容。可选 insertAfter 在指定章节后插入新章节，自动计算文件名（如 chapter-001a.md）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名，如 "chapter-003.md"。不传时若指定 insertAfter 则自动计算' },
        content: { type: 'string', description: 'Markdown 正文（不含 frontmatter，frontmatter 自动生成）' },
        baseContent: { type: 'string', description: '可选。最近一次 read_chapter 读到的整章正文。若当前文件已变化，工具会拒绝写入。' },
        title: { type: 'string', description: '章节标题，写入 frontmatter' },
        volumeIndex: { type: 'number', description: '所属卷索引，写入 frontmatter' },
        sectionIndex: { type: 'number', description: '所属节索引，写入 frontmatter' },
        insertAfter: { type: 'string', description: '在指定文件后插入，自动计算文件名。如 insertAfter="chapter-001.md" → 新文件 chapter-001a.md' },
      },
      required: ['content'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      let name = args.name;
      if (!name && args.insertAfter) {
        name = await novelData.computeNextInsertNameForNovel(dir, args.insertAfter);
      }
      if (!name) throw new Error('name or insertAfter required');
      const meta = {};
      if (args.title) meta.title = args.title;
      if (args.volumeIndex != null) meta.volume = args.volumeIndex;
      if (args.sectionIndex != null) meta.section = args.sectionIndex;
      const metaObj = Object.keys(meta).length > 0 ? meta : null;
      const writeOptions = _hasOwn(args, 'baseContent')
        ? { baseContent: typeof args.baseContent === 'string' ? args.baseContent : '' }
        : undefined;
      await novelData.writeChapterWithMeta(dir, name, args.content, metaObj, writeOptions);
      notifyChapterChanged(name, 'created', args.title || null);
      return textResult({ ok: true, name });
    },
  },
  // ---------------- 章节命名规则 (Chapter Naming) ----------------
  {
    name: 'get_chapter_naming_rule',
    description: '读取当前小说的章节命名规则。返回 { rule: "第{n}章", separator: "：", displayExample: "第一章" }。\n{n}=阿拉伯数字, {cn}=中文数字, 如 "第{n}章" → 第1章, "Chapter {n}" → Chapter 1。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const dir = requireNovel(ctx);
      if (!ctx?.novel?.id) throw new Error('No active novel');
      const novelsStore = require('../store/novels');
      const cfg = await novelsStore.getChapterNamingRule(ctx.novel.id);
      return textResult({
        ...cfg,
        displayExample: cfg.rule.replace('{n}', '1').replace('{cn}', '一') + cfg.separator + '示例标题',
      });
    },
  },
  {
    name: 'set_chapter_naming_rule',
    description: '设置当前小说的章节命名规则。rule 中 {n}=阿拉伯数字, {cn}=中文数字。例如：rule="第{n}章" → 第1章, rule="Chapter {n}" → Chapter 1, rule="第{cn}章" → 第一章。',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: '命名规则模板，如 "第{n}章"、"Chapter {n}"、"第{cn}章"' },
        separator: { type: 'string', description: '章节名与标题之间的分隔符，默认 "："' },
      },
      required: ['rule'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      if (!ctx?.novel?.id) throw new Error('No active novel');
      const novelsStore = require('../store/novels');
      const cfg = await novelsStore.setChapterNamingRule(ctx.novel.id, args.rule, args.separator);
      return textResult({ ok: true, ...cfg });
    },
  },
  {
    name: 'suggest_next_chapter_name',
    description: '返回下一个章节的建议文件名和显示名。如指定 insertAfter 则在某章后插入（如 insertAfter="chapter-001.md" → 文件名 chapter-001a.md），否则追加到末尾。',
    inputSchema: {
      type: 'object',
      properties: {
        insertAfter: { type: 'string', description: '可选，在此文件后插入，自动计算插入名（如 "chapter-001.md" → "chapter-001a.md"）' },
      },
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      if (!ctx?.novel?.id) throw new Error('No active novel');
      const novelsStore = require('../store/novels');
      const cfg = await novelsStore.getChapterNamingRule(ctx.novel.id);
      let fileName;
      let seq;
      if (args.insertAfter) {
        fileName = await novelData.computeNextInsertNameForNovel(dir, args.insertAfter);
        const chapters = await novelData.listChapters(dir);
        const sorted = chapters.map((c) => c.name).sort((a, b) => a.localeCompare(b));
        const insertIdx = sorted.indexOf(args.insertAfter);
        seq = insertIdx >= 0 ? insertIdx + 2 : sorted.length + 1;
      } else {
        const chapters = await novelData.listChapters(dir);
        seq = (chapters || []).length + 1;
        fileName = `chapter-${String(seq).padStart(3, '0')}.md`;
      }
      const displayName = novelData.computeChapterDisplayName(cfg.rule, seq, cfg.separator);
      return textResult({ seq, fileName, displayName });
    },
  },
  {
    name: 'de_ai_ify',
    description: '调用专门的去 AI 味改写器，对给定中文小说片段做去套话、去八股、保留原意的自然化改写。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '需要去 AI 味改写的正文片段' },
        guidance: { type: 'string', description: '可选，额外改写要求，例如保留语气、压缩字数、维持冷淡口吻' },
      },
      required: ['text'],
    },
    handler: async (args, ctx) => {
      const sourceText = _cleanText(args.text);
      if (!sourceText) throw new Error('de_ai_ify requires non-empty text');

      const workflowOrchestrator = require('../runtime/workflowOrchestrator');
      const prompt = [
        '请对下面这段中文小说正文去 AI 味改写。',
        '要求：保留情节事实、人物关系、时态、视角、专有名词；去掉 AI 八股和套话；输出自然的中文小说表达。',
        args.guidance ? `额外要求：${String(args.guidance).trim()}` : '',
        '',
        '原文：',
        sourceText,
      ].filter(Boolean).join('\n');

      const result = await workflowOrchestrator.runWorkflow({
        mode: 'subagent',
        subagentId: 'sa-de-ai-ifier',
        input: prompt,
        novelContext: ctx?.novel
          ? { novelId: ctx.novel.id || null, novelDir: ctx.novelDir || null }
          : undefined,
      });

      return textResult({
        revisedText: String(result.output || '').trim(),
        subagentId: 'sa-de-ai-ifier',
      });
    },
  },
  {
    name: 'review_character_consistency',
    description: '按段审查章节正文与角色卡是否冲突，返回段落级人设/设定不一致问题，不直接改正文。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterName: { type: 'string', description: '章节文件名，如 "chapter-005.md"' },
        focus: { type: 'string', description: '可选，用户对本次审查的补充说明或关注角色名，例如“检查信浓是否 OOC”' },
        characterIds: { type: 'array', items: { type: 'string' }, description: '可选，指定要重点审查的角色 ID 列表' },
      },
      required: ['chapterName'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const chapterName = _cleanText(args.chapterName);
      if (!chapterName) throw new Error('review_character_consistency requires chapterName');

      const chapterText = await novelData.readChapter(dir, chapterName);
      if (!_cleanText(chapterText)) {
        throw new Error(`chapter is empty or missing: ${chapterName}`);
      }

      const allCharacters = await novelData.listCharacters(dir);
      const targetCharacters = resolveTargetCharacters(allCharacters, {
        focus: _cleanText(args.focus),
        characterIds: Array.isArray(args.characterIds) ? args.characterIds : [],
        chapterText,
      });
      if (!targetCharacters.length) {
        throw new Error('review_character_consistency could not resolve any target characters; specify characterIds or mention a character name in focus');
      }

      const payload = buildCharacterConsistencyReviewPayload({
        chapterName,
        chapterText,
        focus: _cleanText(args.focus),
        characters: targetCharacters,
      });
      const workflowOrchestrator = require('../runtime/workflowOrchestrator');
      const result = await workflowOrchestrator.runWorkflow({
        mode: 'subagent',
        subagentId: 'sa-character-consistency-reviewer',
        input: JSON.stringify(payload),
        novelContext: ctx?.novel
          ? { novelId: ctx.novel.id || null, novelDir: ctx.novelDir || null }
          : undefined,
      });
      const parsed = _parseJsonText(String(result.output || ''), { annotations: [] });
      const annotations = enrichCharacterConsistencyAnnotations(
        parsed?.annotations,
        payload.paragraphs,
        targetCharacters
      );

      return textResult({
        chapterName,
        reviewedCharacterIds: targetCharacters.map((character) => character.id),
        reviewedCharacterNames: targetCharacters.map((character) => character.name),
        annotations,
      });
    },
  },
  {
    name: 'review_de_ai_style',
    description: '按段审查一个或多个章节中的 AI 味、套话和机械行文问题，不直接改正文。传多个 chapterNames 时会在后端并行审查。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterName: { type: 'string', description: '单章审查时的章节文件名，如 "chapter-005.md"' },
        chapterNames: {
          type: 'array',
          description: '多章节并行审查时的章节文件名数组，如 ["chapter-001.md","chapter-002.md"]',
          items: { type: 'string' },
        },
        focus: { type: 'string', description: '可选，用户对本次审查的补充说明，例如“重点找 AI 套话和短反应句”' },
      },
    },
    handler: async (args, ctx) => {
      requireNovel(ctx);
      const requested = [
        _cleanText(args.chapterName),
        ...(Array.isArray(args.chapterNames) ? args.chapterNames.map((item) => _cleanText(item)) : []),
      ].filter((item, index, list) => item && list.indexOf(item) === index);

      if (!requested.length) {
        throw new Error('review_de_ai_style requires chapterName or chapterNames');
      }

      const focus = _cleanText(args.focus);
      const chapters = await Promise.all(requested.map(async (chapterName) => {
        try {
          return await _reviewChapterDeAiStyle(chapterName, focus, ctx);
        } catch (err) {
          return {
            chapterName,
            annotations: [],
            error: err?.message || String(err),
          };
        }
      }));

      if (chapters.every((chapter) => chapter.error)) {
        throw new Error(chapters[0]?.error || 'review_de_ai_style failed');
      }

      return textResult({
        reviewedWith: 'sa-prose-quality',
        focus,
        chapterCount: chapters.length,
        totalAnnotations: chapters.reduce((sum, chapter) => sum + (chapter.annotations?.length || 0), 0),
        chapters,
      });
    },
  },
  // ---------------- 技能管理 (Skill Management) ----------------
  {
    name: 'list_skills',
    description: '列出所有技能（id/name/description/tags），不含正文。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const skillsStore = require('../store/skills');
      const list = await skillsStore.listSkills();
      return textResult({ skills: list });
    },
  },
  {
    name: 'read_skill_content',
    description: '按技能 id 读取技能 Markdown 正文（不含元数据）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '技能 ID' } },
      required: ['id'],
    },
    handler: async (args, ctx) => {
      const skillsStore = require('../store/skills');
      const skill = await skillsStore.getSkill(args.id);
      if (!skill) throw new Error(`skill not found: ${args.id}`);
      return textResult(skill.content || '(空)');
    },
  },
  {
    name: 'create_skill',
    description: '创建新技能。id 为唯一标识，name 为显示名，content 为 Markdown 正文。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '技能唯一标识' },
        name: { type: 'string', description: '显示名' },
        description: { type: 'string', description: '描述' },
        content: { type: 'string', description: 'Markdown 正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '分类标签' },
      },
      required: ['id', 'name', 'content'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const skillsStore = require('../store/skills');
      const result = await skillsStore.saveSkill({
        id: args.id, name: args.name, description: args.description || '',
        content: args.content, tags: args.tags || [],
      });
      return textResult({ ok: true, skill: result });
    },
  },
  {
    name: 'update_skill',
    description: '更新技能内容或元数据。只传需要更新的字段即可。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '技能 ID' },
        name: { type: 'string', description: '显示名' },
        description: { type: 'string', description: '描述' },
        content: { type: 'string', description: 'Markdown 正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '分类标签' },
      },
      required: ['id'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const skillsStore = require('../store/skills');
      const existing = await skillsStore.getSkill(args.id);
      if (!existing) throw new Error(`skill not found: ${args.id}`);
      const merged = { ...existing, ...args };
      const result = await skillsStore.saveSkill(merged);
      return textResult({ ok: true, skill: result });
    },
  },
  {
    name: 'delete_skill',
    description: '删除一个技能。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '技能 ID' } },
      required: ['id'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const skillsStore = require('../store/skills');
      await skillsStore.deleteSkill(args.id);
      return textResult({ ok: true });
    },
  },
  {
    name: 'assign_skill_to_subagent',
    description: '将技能关联到某个 subagent。关联后该 subagent 启动时自动注入技能内容。',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能 ID' },
        subagentId: { type: 'string', description: 'Subagent ID' },
      },
      required: ['skillId', 'subagentId'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const skillsStore = require('../store/skills');
      await skillsStore.assignSkillToSubagent(args.skillId, args.subagentId);
      return textResult({ ok: true });
    },
  },
  {
    name: 'unassign_skill_from_subagent',
    description: '解除技能与 subagent 的关联。',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能 ID' },
        subagentId: { type: 'string', description: 'Subagent ID' },
      },
      required: ['skillId', 'subagentId'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const skillsStore = require('../store/skills');
      await skillsStore.unassignSkillFromSubagent(args.skillId, args.subagentId);
      return textResult({ ok: true });
    },
  },
  {
    name: 'grant_asset',
    description: '把资产授予某角色（直接落盘）。可选传 baseGrantedTo 做快照校验，避免基于旧授权状态继续写。',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string' }, charId: { type: 'string' },
        chapterRef: { type: 'string' }, note: { type: 'string' },
        baseGrantedTo: { type: 'array', items: { type: 'object' }, description: '可选。最近一次读取到的 grantedTo 快照。' },
      },
      required: ['assetId', 'charId'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceAssetAuthArgs(args || {}, 'grant_asset');
      const updated = await novelData.grantAsset(dir, payload);
      return textResult({ ok: true, asset: updated });
    },
  },
  {
    name: 'revoke_asset',
    description: '撤销某资产对某角色的授予（追加 revoked 记录）。可选传 baseGrantedTo 做快照校验，避免基于旧授权状态继续写。',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string' }, charId: { type: 'string' },
        chapterRef: { type: 'string' }, note: { type: 'string' },
        baseGrantedTo: { type: 'array', items: { type: 'object' }, description: '可选。最近一次读取到的 grantedTo 快照。' },
      },
      required: ['assetId', 'charId'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceAssetAuthArgs(args || {}, 'revoke_asset');
      const updated = await novelData.revokeAsset(dir, payload);
      return textResult({ ok: true, asset: updated });
    },
  },
  {
    name: 'apply_asset_patch',
    description: '在一次写入中批量处理多个资产的授权变更。每个 edit 针对一个 assetId，支持按 operations 顺序执行 grant/revoke，并可选传 baseGrantedTo 快照防止旧状态覆盖新授权。',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetId: { type: 'string' },
              baseGrantedTo: { type: 'array', items: { type: 'object' }, description: '可选。该资产最近一次读取到的 grantedTo 快照。' },
              operations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['grant', 'revoke'] },
                    charId: { type: 'string' },
                    chapterRef: { type: 'string' },
                    note: { type: 'string' },
                    at: { type: 'string' },
                  },
                  required: ['action', 'charId'],
                },
              },
            },
            required: ['assetId', 'operations'],
          },
        },
      },
      required: ['edits'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceAssetPatchArgs(args || {});
      const result = await novelData.applyAssetPatch(dir, payload);
      return textResult({ ok: true, ...result });
    },
  },
  {
    name: 'append_timeline',
    description: '追加一条时间线事件（直接落盘）。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterRef: { type: 'string' },
        when: { type: 'string' }, where: {},
        participants: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        physical: {}, communication: {},
      },
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const ev = await novelData.appendTimelineEvent(dir, args || {});
      return textResult({ ok: true, event: ev });
    },
  },
  {
    name: 'update_timeline',
    description: '按 id 修改一条已存在的时间线事件。用于修正已有事件，避免重复追加。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            chapterRef: { type: 'string' },
            when: { type: 'string' },
            where: {},
            participants: { type: 'array', items: { type: 'string' } },
            description: { type: 'string' },
            physical: {},
            communication: {},
          },
        },
      },
      required: ['id', 'patch'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const ev = await novelData.updateTimelineEvent(dir, args.id, args.patch || {});
      return textResult({ ok: true, event: ev });
    },
  },
  {
    name: 'sync_chapter_timeline',
    description: '用指定章节的最新高置信事件替换该章节旧时间线事件，并校验章节覆盖缺口和残留 chapterRef。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterRef: { type: 'string' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              when: { type: 'string' },
              where: {},
              participants: { type: 'array', items: { type: 'string' } },
              description: { type: 'string' },
              physical: {},
              communication: {},
            },
          },
        },
      },
      required: ['chapterRef', 'events'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const summary = await novelData.syncTimelineEventsForChapter(dir, args.chapterRef, args.events || []);
      const warnings = [];
      if (summary.validation?.missingChapterRefs?.length) {
        warnings.push(`检测到缺少时间线覆盖的章节: ${summary.validation.missingChapterRefs.join(', ')}`);
      }
      if (summary.validation?.orphanChapterRefs?.length) {
        warnings.push(`检测到残留或无效章节引用: ${summary.validation.orphanChapterRefs.join(', ')}`);
      }
      return textResult({ ok: true, ...summary, warnings });
    },
  },
  {
    name: 'dedupe_timeline',
    description: '清理时间线中的历史重复事件。默认保留最后一条，按 id 和语义重复一起去重。',
    inputSchema: {
      type: 'object',
      properties: {
        keep: { type: 'string', enum: ['first', 'last'] },
      },
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const summary = await novelData.dedupeTimeline(dir, args || {});
      return textResult({ ok: true, ...summary });
    },
  },
  {
    name: 'append_summary',
    description: '为某章追加摘要 + 设定补充 markdown（直接落盘）。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterRef: { type: 'string' }, summary: { type: 'string' },
        supplementMarkdown: { type: 'string' },
      },
      required: ['chapterRef', 'summary'],
    },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const r = await novelData.appendSummary(dir, args || {});
      return textResult({ ok: true, ...r });
    },
  },
  {
    name: 'append_style_memory',
    description: '把一段文风/风格学习追加到 style/memory.md（直接落盘）。',
    inputSchema: { type: 'object', properties: { delta: { type: 'string' } }, required: ['delta'] },
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const r = await novelData.appendStyleMemory(dir, args || {});
      return textResult({ ok: true, ...r });
    },
  },

  // ---------------- WRITE (require confirmation) ----------------
  {
    name: 'create_character',
    description: '创建一个新角色卡（需用户确认）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
        faction: { type: 'string' }, role: { type: 'string' },
        attributes: {}, relationships: {}, arc: {}, bio: { type: 'string' },
      },
      required: ['name'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceCreateCharacterArgs(args);
      const id = payload.id || `char-${Date.now().toString(36)}`;
      const c = { id, ...payload };
      const written = await novelData.writeCharacter(dir, c);
      return textResult({ ok: true, character: written });
    },
  },
  {
    name: 'update_character',
    description: '修改某个角色卡的字段（需用户确认）。patch 对嵌套对象执行 deep merge，未提到的子字段会保留；数组仍按整数组替换。若要删除某层对象里的字段，可在该层 patch 中传 __delete: ["字段名"]。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, patch: {} },
      required: ['id', 'patch'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceUpdateCharacterArgs(args);
      const written = await novelData.patchCharacter(dir, payload.id, payload.patch || {});
      return textResult({ ok: true, character: written });
    },
  },
  {
    name: 'delete_character',
    description: '删除一个角色卡（需用户确认）。会先确认角色存在，再删除 characters/{id}.json。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '角色ID。也兼容 characterId。' },
        characterId: { type: 'string', description: '角色ID别名。' },
      },
      required: ['id'],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceDeleteCharacterArgs(args);
      const existing = await novelData.deleteCharacter(dir, payload.id);
      if (!existing) throw new Error(`character not found: ${payload.id}`);
      return textResult({
        ok: true,
        deleted: {
          id: existing.id,
          name: existing.name,
          aliases: existing.aliases,
          role: existing.role,
          faction: existing.faction,
        },
      });
    },
  },
  {
    name: 'update_world',
    description: '整体覆盖世界观 lore 或地名表（需用户确认）。如果只是改几处 lore 文本或增删改少量地点，优先使用 apply_world_patch；若传 baseLore/basePlaces，则会先校验快照，避免旧数据覆盖新数据。',
    inputSchema: {
      type: 'object',
      properties: {
        lore: { type: 'string' },
        places: { type: 'array', items: { type: 'object' } },
        baseLore: { type: 'string', description: '可选。最近一次读取到的 lore 原文快照。' },
        basePlaces: { type: 'array', items: { type: 'object' }, description: '可选。最近一次读取到的 places 快照。' },
      },
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceWorldWriteArgs(args || {}, 'update_world');
      const result = await novelData.writeWorld(dir, payload || {}, {
        ...(_hasOwn(payload, 'baseLore') ? { baseLore: payload.baseLore } : {}),
        ...(_hasOwn(payload, 'basePlaces') ? { basePlaces: payload.basePlaces } : {}),
      });
      return textResult({ ok: true, world: result });
    },
  },
  {
    name: 'apply_world_patch',
    description: '在同一份世界观快照上增量修改 lore 和地点表。支持 loreReplacement 全量替换，或用 loreEdits 做带前后文锚点的局部修补；地点支持 placeUpserts 和 placeDeletes。工具会先校验 baseLore/basePlaces 快照，避免把旧 patch 打到新世界观上。',
    inputSchema: {
      type: 'object',
      properties: {
        baseLore: { type: 'string', description: '可选。最近一次读取到的 lore 原文快照。' },
        basePlaces: { type: 'array', items: { type: 'object' }, description: '可选。最近一次读取到的 places 快照。' },
        loreReplacement: { type: 'string', description: '可选。直接整段替换 lore。与 loreEdits 二选一。' },
        loreEdits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              targetText: { type: 'string' },
              replacement: { type: 'string' },
              expectedMatchCount: { type: 'number' },
              beforeContext: { type: 'string' },
              afterContext: { type: 'string' },
            },
            required: ['targetText', 'replacement'],
          },
        },
        placeUpserts: { type: 'array', items: { type: 'object' }, description: '可选。按 name 或 matchName 定位地点并 deep merge；不存在则创建。' },
        placeDeletes: { type: 'array', items: { type: 'string' }, description: '可选。按地点名删除。' },
      },
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const payload = _coerceWorldPatchArgs(args || {});
      const result = await novelData.applyWorldPatch(dir, payload);
      return textResult({ ok: true, ...result });
    },
  },
  {
    name: "create_novel",
    description: "Create a new novel project. Returns the novel id, title, and directory.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Novel title" },
        dir: { type: "string", description: "Optional directory path. If omitted, a default path under userData/novels/ is used." },
      },
      required: ["title"],
    },
    handler: async (args, _ctx) => {
      const novelsStore = require("../store/novels");
      const { paths: globalPaths } = require("../store/paths");
      const path = require("node:path");
      const fs = require("node:fs").promises;
      const title = args.title || "Untitled";
      let dir = args.dir;
      if (!dir) {
        const safeTitle = title.replace(/[^\w\-\u4e00-\u9fff]+/g, "_").slice(0, 50);
        dir = path.join(globalPaths().root, "novels", safeTitle);
      }
      await fs.mkdir(path.dirname(dir), { recursive: true });
      const result = await novelsStore.createNovel({ title, dir });
      return textResult({ ok: true, novel: result });
    },
  },
  {
    name: "list_novels",
    description: "List all novel projects with their id, title, and directory.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, _ctx) => {
      const novelsStore = require("../store/novels");
      const list = await novelsStore.listNovels();
      return textResult({ novels: list || [] });
    },
  },

  // ---------------- STAGING / IMPORT ----------------
  {
    name: "list_staging_projects",
    description: "List all active staging (import-in-progress) projects with their id, title, and import metadata.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, _ctx) => {
      const list = await stagingProject.listStagingProjects();
      return textResult({ projects: list || [] });
    },
  },
  {
    name: "get_staging_project",
    description: "Get full data of a staging project by importId (chapters, characters, world, outline, styleMemory, fanwork metadata).",
    inputSchema: {
      type: "object",
      properties: { importId: { type: "string", description: "Staging project ID" } },
      required: ["importId"],
    },
    handler: async (args, _ctx) => {
      const proj = await stagingProject.getStagingProject(args.importId);
      if (!proj) throw new Error(`Staging project not found: ${args.importId}`);
      return textResult(proj);
    },
  },
  {
    name: "get_staging_characters",
    description: "Read characters from a staging project. Returns all character cards extracted during import analysis.",
    inputSchema: {
      type: "object",
      properties: { importId: { type: "string", description: "Staging project ID" } },
      required: ["importId"],
    },
    handler: async (args, _ctx) => {
      const proj = await stagingProject.getStagingProject(args.importId);
      if (!proj) throw new Error(`Staging project not found: ${args.importId}`);
      return textResult({ characters: proj.characters || [] });
    },
  },
  {
    name: "save_staging_characters",
    description: "Write character cards back to a staging project (updates isOriginal, sourceWork, originalName, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string", description: "Staging project ID" },
        characters: { type: "array", description: "Full character JSON objects to overwrite", items: { type: "object" } },
      },
      required: ["importId", "characters"],
    },
    requiresConfirmation: true,
    handler: async (args, _ctx) => {
      const { paths: appPaths } = require("../store/paths");
      const fs = require("node:fs").promises;
      const path = require("node:path");
      const charsDir = path.join(appPaths().root, "import-staging", args.importId, "characters");
      await fs.mkdir(charsDir, { recursive: true });
      for (const ch of (args.characters || [])) {
        const safeId = String(ch.id || ch.name || "char").replace(/[^\w\-.]/g, "_");
        await fs.writeFile(path.join(charsDir, `${safeId}.json`), JSON.stringify(ch, null, 2), "utf8");
      }
      return textResult({ saved: (args.characters || []).length });
    },
  },
  {
    name: "enrich_staging_characters",
    description: "Trigger web enrichment for selected characters in a staging project. Characters are grouped by sourceWork and enriched per-group. Requires a configured AI provider for extraction.",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string", description: "Staging project ID" },
        characterIds: { type: "array", items: { type: "string" }, description: "IDs of characters to enrich (only non-original characters are processed)" },
        fanworkNameOverride: { type: "string", description: "Override the fanwork name for all selected characters (optional, uses per-character sourceWork if omitted)" },
      },
      required: ["importId", "characterIds"],
    },
    requiresConfirmation: true,
    handler: async (args, _ctx) => {
      const { paths: appPaths } = require("../store/paths");
      const fs = require("node:fs").promises;
      const path = require("node:path");
      const charsDir = path.join(appPaths().root, "import-staging", args.importId, "characters");

      const files = await fs.readdir(charsDir).catch(() => []);
      const allChars = [];
      for (const f of files.filter((x) => x.endsWith(".json"))) {
        const obj = await fs.readFile(path.join(charsDir, f), "utf8").then(JSON.parse).catch(() => null);
        if (obj) allChars.push(obj);
      }

      const selectedIds = new Set(args.characterIds || []);
      const toEnrich = allChars.filter((c) => selectedIds.has(c.id) && c.isOriginal !== true);
      if (!toEnrich.length) {
        return textResult({ enriched: 0, skipped: args.characterIds?.length || 0, message: "No eligible characters (all are original or not found)" });
      }

      const results = [];
      if (args.fanworkNameOverride) {
        const enriched = await characterEnricher.enrichCharacters(
          toEnrich, null, "zh-CN", { fanworkNameOverride: args.fanworkNameOverride }
        );
        for (const ch of enriched) {
          const safeId = String(ch.id || "char").replace(/[^\w\-.]/g, "_");
          await fs.writeFile(path.join(charsDir, `${safeId}.json`), JSON.stringify(ch, null, 2), "utf8");
        }
        results.push({ workName: args.fanworkNameOverride, count: enriched.length });
      } else {
        const byWork = {};
        for (const c of toEnrich) {
          const work = c.sourceWork || "未知作品";
          if (!byWork[work]) byWork[work] = [];
          byWork[work].push(c);
        }
        for (const [workName, group] of Object.entries(byWork)) {
          const enriched = await characterEnricher.enrichCharacters(
            group, null, "zh-CN", { fanworkNameOverride: workName }
          );
          for (const ch of enriched) {
            const safeId = String(ch.id || "char").replace(/[^\w\-.]/g, "_");
            await fs.writeFile(path.join(charsDir, `${safeId}.json`), JSON.stringify(ch, null, 2), "utf8");
          }
          results.push({ workName, count: group.length });
        }
      }

      return textResult({ enriched: toEnrich.length, results });
    },
  },
  {
    name: "promote_staging_to_novel",
    description: "Promote a staging project to a real novel project. Copies all data from staging to the novels directory.",
    inputSchema: {
      type: "object",
      properties: {
        importId: { type: "string", description: "Staging project ID" },
        title: { type: "string", description: "Novel title (defaults to staging title)" },
        dir: { type: "string", description: "Target directory (optional, auto-generated if omitted)" },
      },
      required: ["importId"],
    },
    requiresConfirmation: true,
    handler: async (args, _ctx) => {
      const result = await stagingProject.promoteToNovel(args.importId, {
        title: args.title,
        dir: args.dir,
      });
      return textResult({ ok: true, novel: result });
    },
  },
  {
    name: "enrich_character",
    description: "Perform web enrichment for a single character card in the active novel. Searches the web for the character's official info from the original work (fanwork), extracts structured fields (appearance, hairColor, eyeColor, personality, background, etc.), and merges them into the character card. Skipped for original (non-fanwork) characters. Enrichment compares web results against existing data and preserves novel values where they differ.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Character ID to enrich (get from read_character or list_characters)" },
        fanworkName: { type: "string", description: "Override the source work name for web search (optional, uses character's sourceWork field if omitted)" },
      },
      required: ["id"],
    },
    requiresConfirmation: true,
    handler: async (args, ctx) => {
      const dir = requireNovel(ctx);
      const character = await novelData.readCharacter(dir, args.id);
      if (!character) throw new Error(`Character not found: ${args.id}`);

      if (character.isOriginal) {
        return textResult({ enriched: false, reason: "Original character (isOriginal=true) — enrichment only works for fanwork characters" });
      }

      if (character._enrichmentStatus === 'success') {
        return textResult({ enriched: false, reason: "Character already enriched (_enrichmentStatus=success) — enrichment skipped" });
      }

      const results = await characterEnricher.enrichCharacters(
        [character],
        null,
        'zh-CN',
        { fanworkNameOverride: args.fanworkName || character.sourceWork || undefined }
      );

      const enriched = results[0];
      if (!enriched) {
        return textResult({ enriched: false, reason: "Enrichment returned no data" });
      }

      // Calculate which fields changed
      const changed = {};
      const fields = ['name', 'aliases', 'role', 'faction', 'appearance', 'hairColor', 'eyeColor', 'height', 'figure', 'personality', 'background', 'moeTraits', 'quotes', 'skins', 'sourceWork', 'originalName'];
      for (const f of fields) {
        const before = character[f];
        const after = enriched[f];
        const bStr = Array.isArray(before) ? JSON.stringify(before) : String(before ?? '');
        const aStr = Array.isArray(after) ? JSON.stringify(after) : String(after ?? '');
        if (bStr !== aStr) {
          changed[f] = { before: before ?? null, after: after ?? null };
        }
      }

      if (enriched._enrichmentStatus === 'success') {
        await novelData.writeCharacter(dir, enriched);
      }

      return textResult({
        ok: enriched._enrichmentStatus === 'success',
        status: enriched._enrichmentStatus,
        characterId: args.id,
        changed: Object.keys(changed).length > 0 ? changed : undefined,
        message: enriched._enrichmentStatus === 'success'
          ? `Character enriched successfully. ${Object.keys(changed).length} field(s) updated.`
          : `Enrichment status: ${enriched._enrichmentStatus}`,
      });
    },
  },
];

function getToolByName(name) {
  return TOOLS.find((t) => t.name === name);
}

module.exports = { TOOLS, getToolByName };
