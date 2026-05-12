'use strict';

/**
 * Per-novel domain stores: characters, assets, timeline, summaries, styleMemory,
 * chapters, outlines, world/lore. All operate on a novelDir path.
 */

const path = require('node:path');
const fs = require('node:fs').promises;
const fastGlob = require('fast-glob');
const lockfile = require('proper-lockfile');
const { novelPaths, ensureNovelLayout, generateId, outlineVolumePath, outlineSectionPath, outlineChapterPath, outlineVolumeDir, outlineSectionDir } = require('./paths');
const { parseFrontmatter, serializeFrontmatter, readFrontmatterFromFile, computeNextInsertName } = require('./frontmatter');
const { readJson, writeJson, listJsonFiles, deleteFile, appendJsonl, readJsonl } = require('./jsonStore');

// Global mutex per file path for jsonl writes (in-process serialization)
const _mutex = new Map();
async function withMutex(key, fn) {
  const prev = _mutex.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  _mutex.set(key, prev.then(() => next));
  try { await prev; return await fn(); }
  finally { release(); if (_mutex.get(key) === next) _mutex.delete(key); }
}

function _cleanStr(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return '';
}

function _isGeneratedCharacterId(value) {
  return /^char(?:-[a-z0-9]+)+$/i.test(_cleanStr(value));
}

function _slugifyCharacterId(value) {
  const raw = _cleanStr(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw || generateId('char');
}

function _parseRawCharacter(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            const parsed = JSON.parse(value.slice(start, i + 1));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
          } catch {
            start = -1;
          }
        }
      }
    }
    return null;
  }
}

function _mergeStringArrays(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const text = _cleanStr(item);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function _pickFirstString(...values) {
  for (const value of values) {
    const text = _cleanStr(value);
    if (text) return text;
  }
  return '';
}

function _pickRicherString(primary, secondary) {
  const left = _cleanStr(primary);
  const right = _cleanStr(secondary);
  if (!left) return right;
  if (!right) return left;
  if (right.length > left.length + 20) return right;
  return left;
}

function _extractQuotesFromText(text) {
  const source = _cleanStr(text);
  if (!source) return '';
  const matches = [];
  const patterns = [/[“\"]([^”\"\n]{2,80})[”\"]/g, /「([^」\n]{2,80})」/g, /'([^'\n]{2,80})'/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const quote = _cleanStr(match[1]);
      if (quote && !matches.includes(quote)) matches.push(quote);
      if (matches.length >= 3) break;
    }
    if (matches.length >= 3) break;
  }
  return matches.join('；');
}

function _normalizeAttributesMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = _cleanStr(key);
    const safeValue = _cleanStr(raw);
    if (safeKey && safeValue) out[safeKey] = safeValue;
  }
  return out;
}

function _attributesToSummary(attributes, preferredKeys) {
  const parts = [];
  for (const key of preferredKeys) {
    const value = _cleanStr(attributes[key]);
    if (!value) continue;
    parts.push(`${key}：${value}`);
  }
  return parts.join('；');
}

function normalizeCharacter(character) {
  if (!character || typeof character !== 'object' || Array.isArray(character)) return null;

  const raw = _parseRawCharacter(character.__raw);
  const next = { ...(raw || {}), ...character };
  const rawAttributes = _normalizeAttributesMap(raw?.attributes);
  const attributes = _normalizeAttributesMap(next.attributes);
  const mergedAttributes = { ...rawAttributes, ...attributes };
  const aliasList = _mergeStringArrays(raw?.aliases, next.aliases);
  const explicitName = _pickFirstString(next.name, raw?.name);
  const originalName = _pickFirstString(next.originalName, raw?.originalName);
  const safeId = _pickFirstString(character.id, raw?.id, next.id);
  const derivedName = explicitName
    || originalName
    || aliasList[0]
    || (!_isGeneratedCharacterId(safeId) ? safeId : '')
    || '未命名角色';

  next.aliases = aliasList;
  next.attributes = mergedAttributes;
  next.name = derivedName;
  next.id = safeId || _slugifyCharacterId(derivedName);
  next.role = _pickFirstString(next.role, raw?.role, mergedAttributes.定位, mergedAttributes.身份, mergedAttributes.职务, next.faction, raw?.faction);
  next.faction = _pickFirstString(next.faction, raw?.faction);
  next.gender = _pickFirstString(next.gender, raw?.gender, raw?.sex, mergedAttributes.性别);
  next.age = _pickFirstString(next.age, raw?.age, mergedAttributes.年龄);
  next.sourceWork = _pickFirstString(next.sourceWork, raw?.sourceWork);
  next.originalName = originalName;
  next.bio = _pickRicherString(next.bio, raw?.bio);
  next.appearance = _pickFirstString(
    next.appearance,
    raw?.appearance,
    mergedAttributes.外貌,
    mergedAttributes.外形,
    mergedAttributes.形象,
    _attributesToSummary(mergedAttributes, ['年龄', '职业', '籍贯', '驻所'])
  );
  next.personality = _pickFirstString(
    next.personality,
    raw?.personality,
    mergedAttributes.性格,
    mergedAttributes.特点,
    mergedAttributes.人设,
    mergedAttributes.战斗风格,
    mergedAttributes.语言特点
  );
  next.background = _pickFirstString(
    next.background,
    raw?.background,
    next.bio,
    mergedAttributes.生前身份,
    mergedAttributes.死亡原因,
    mergedAttributes.现存形态
  );
  next.quotes = _pickFirstString(
    next.quotes,
    raw?.quotes,
    mergedAttributes.自称,
    _extractQuotesFromText(next.bio)
  );

  return next;
}

// ---------------- Characters ----------------

async function listCharacters(novelDir) {
  const np = novelPaths(novelDir);
  const files = await listJsonFiles(np.characters);
  const out = [];
  for (const f of files) {
    const obj = normalizeCharacter(await readJson(f, null));
    if (obj) out.push(obj);
  }
  return out;
}

async function readCharacter(novelDir, id) {
  const np = novelPaths(novelDir);
  return normalizeCharacter(await readJson(path.join(np.characters, `${id}.json`), null));
}

async function writeCharacter(novelDir, character) {
  const normalized = normalizeCharacter(character);
  if (!normalized?.id) throw new Error('character.id required');
  const np = ensureNovelLayout(novelDir);
  const file = path.join(np.characters, `${normalized.id}.json`);
  await writeJson(file, { schemaVersion: 1, ...normalized });
  return normalized;
}

async function deleteCharacter(novelDir, id) {
  const np = novelPaths(novelDir);
  await deleteFile(path.join(np.characters, `${id}.json`));
}

// ---------------- Assets ----------------

function emptyAssets() { return { schemaVersion: 1, assets: [] }; }

async function readAssetsFile(novelDir) {
  const np = novelPaths(novelDir);
  const data = await readJson(np.assetsMain, null);
  return data && typeof data === 'object' ? data : emptyAssets();
}

async function writeAssetsFile(novelDir, data) {
  const np = ensureNovelLayout(novelDir);
  await writeJson(np.assetsMain, data);
}

async function listAssets(novelDir) {
  const data = await readAssetsFile(novelDir);
  return Array.isArray(data.assets) ? data.assets : [];
}

async function readAsset(novelDir, id) {
  const list = await listAssets(novelDir);
  return list.find((a) => a.id === id) || null;
}

async function upsertAsset(novelDir, asset) {
  if (!asset?.id) throw new Error('asset.id required');
  const np = ensureNovelLayout(novelDir);
  return withMutex(np.assetsMain, async () => {
    const data = await readAssetsFile(novelDir);
    const idx = data.assets.findIndex((a) => a.id === asset.id);
    if (idx >= 0) data.assets[idx] = { ...data.assets[idx], ...asset };
    else data.assets.push({ schemaVersion: 1, grantedTo: [], ...asset });
    await writeAssetsFile(novelDir, data);
    return asset;
  });
}

async function grantAsset(novelDir, { assetId, charId, chapterRef, note }) {
  const np = ensureNovelLayout(novelDir);
  return withMutex(np.assetsMain, async () => {
    const data = await readAssetsFile(novelDir);
    const idx = data.assets.findIndex((a) => a.id === assetId);
    if (idx < 0) throw new Error(`asset not found: ${assetId}`);
    const granted = data.assets[idx].grantedTo || [];
    granted.push({ charId, chapterRef: chapterRef || null, at: new Date().toISOString(), note: note || '' });
    data.assets[idx].grantedTo = granted;
    await writeAssetsFile(novelDir, data);
    return data.assets[idx];
  });
}

async function revokeAsset(novelDir, { assetId, charId, chapterRef, note }) {
  const np = ensureNovelLayout(novelDir);
  return withMutex(np.assetsMain, async () => {
    const data = await readAssetsFile(novelDir);
    const idx = data.assets.findIndex((a) => a.id === assetId);
    if (idx < 0) throw new Error(`asset not found: ${assetId}`);
    const granted = data.assets[idx].grantedTo || [];
    const filtered = granted.filter((g) => g.charId !== charId);
    filtered.push({ charId, chapterRef: chapterRef || null, at: new Date().toISOString(), note: `(revoked) ${note || ''}`, revoked: true });
    data.assets[idx].grantedTo = filtered;
    await writeAssetsFile(novelDir, data);
    return data.assets[idx];
  });
}

// ---------------- Timeline ----------------

function normalizeTimelineEvent(event, fallback = {}) {
  return {
    schemaVersion: 1,
    id: event?.id || fallback.id || generateId('evt'),
    chapterRef: event?.chapterRef ?? fallback.chapterRef ?? null,
    when: event?.when ?? fallback.when ?? null,
    where: event?.where ?? fallback.where ?? null,
    participants: Array.isArray(event?.participants) ? event.participants : (Array.isArray(fallback.participants) ? fallback.participants : []),
    description: event?.description ?? fallback.description ?? '',
    physical: event?.physical ?? fallback.physical ?? null,
    communication: event?.communication ?? fallback.communication ?? null,
    ts: event?.ts || fallback.ts || new Date().toISOString(),
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function timelineSemanticKey(event) {
  const normalized = normalizeTimelineEvent(event, event || {});
  return stableSerialize({
    chapterRef: normalized.chapterRef || null,
    when: normalized.when || null,
    where: normalized.where || null,
    participants: Array.isArray(normalized.participants)
      ? normalized.participants.map((item) => String(item || '').trim()).filter(Boolean).sort()
      : [],
    description: String(normalized.description || '').trim(),
    physical: normalized.physical ?? null,
    communication: normalized.communication ?? null,
  });
}

async function listTimeline(novelDir) {
  const np = novelPaths(novelDir);
  return readJsonl(np.timelineEvents);
}

async function appendTimelineEvent(novelDir, event) {
  const np = ensureNovelLayout(novelDir);
  const ev = normalizeTimelineEvent(event);
  return withMutex(np.timelineEvents, async () => {
    if (event?.id) {
      const existing = await readJsonl(np.timelineEvents);
      if (existing.some((item) => item?.id === event.id)) {
        throw new Error(`timeline event already exists: ${event.id}; use update_timeline`);
      }
    }
    await appendJsonl(np.timelineEvents, ev);
    return ev;
  });
}

async function updateTimelineEvent(novelDir, id, patch) {
  const np = ensureNovelLayout(novelDir);
  if (!id) throw new Error('timeline id required');
  return withMutex(np.timelineEvents, async () => {
    const events = await readJsonl(np.timelineEvents);
    const index = events.findIndex((event) => event?.id === id);
    if (index < 0) throw new Error(`timeline event not found: ${id}`);
    const current = events[index] || {};
    const next = normalizeTimelineEvent({ ...(patch || {}), id }, current);
    events[index] = next;
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    await fs.mkdir(path.dirname(np.timelineEvents), { recursive: true });
    await fs.writeFile(np.timelineEvents, content ? `${content}\n` : '', 'utf8');
    return next;
  });
}

async function replaceTimeline(novelDir, events) {
  const np = ensureNovelLayout(novelDir);
  if (!Array.isArray(events)) throw new Error('timeline must be an array');
  const normalized = events.map((event) => normalizeTimelineEvent(event));

  return withMutex(np.timelineEvents, async () => {
    await fs.mkdir(path.dirname(np.timelineEvents), { recursive: true });
    const content = normalized.map((event) => JSON.stringify(event)).join('\n');
    await fs.writeFile(np.timelineEvents, content ? `${content}\n` : '', 'utf8');
    return normalized;
  });
}

async function dedupeTimeline(novelDir, options = {}) {
  const np = ensureNovelLayout(novelDir);
  const keep = options?.keep === 'first' ? 'first' : 'last';
  return withMutex(np.timelineEvents, async () => {
    const existing = await readJsonl(np.timelineEvents);
    const source = keep === 'last' ? [...existing].reverse() : [...existing];
    const kept = [];
    const removed = [];
    const seenIds = new Set();
    const seenSemanticKeys = new Set();

    for (const rawEvent of source) {
      const event = normalizeTimelineEvent(rawEvent, rawEvent || {});
      if (event.id && seenIds.has(event.id)) {
        removed.push({ reason: 'id', event });
        continue;
      }
      const semanticKey = timelineSemanticKey(event);
      if (seenSemanticKeys.has(semanticKey)) {
        removed.push({ reason: 'semantic', event });
        continue;
      }
      if (event.id) seenIds.add(event.id);
      seenSemanticKeys.add(semanticKey);
      kept.push(event);
    }

    const deduped = keep === 'last' ? kept.reverse() : kept;
    const content = deduped.map((event) => JSON.stringify(event)).join('\n');
    await fs.mkdir(path.dirname(np.timelineEvents), { recursive: true });
    await fs.writeFile(np.timelineEvents, content ? `${content}\n` : '', 'utf8');
    return {
      before: existing.length,
      after: deduped.length,
      removed: removed.length,
      removedIds: removed.map((entry) => entry.event.id).filter(Boolean),
      deduped,
    };
  });
}

async function queryTimeline(novelDir, { participant, chapterRef, since, until } = {}) {
  const all = await listTimeline(novelDir);
  return all.filter((e) => {
    if (participant && !(e.participants || []).includes(participant)) return false;
    if (chapterRef && e.chapterRef !== chapterRef) return false;
    if (since && new Date(e.when) < new Date(since)) return false;
    if (until && new Date(e.when) > new Date(until)) return false;
    return true;
  });
}

// ---------------- Summaries ----------------

async function appendSummary(novelDir, { chapterRef, summary, supplementMarkdown }) {
  const np = ensureNovelLayout(novelDir);
  const safe = String(chapterRef || 'unknown').replace(/[^\w.-]/g, '_');
  const file = path.join(np.summaries, `${safe}.md`);
  const block = [
    `# ${chapterRef || 'Chapter'} Summary`,
    '',
    summary || '',
    '',
    supplementMarkdown ? `## Supplement\n\n${supplementMarkdown}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, block, 'utf8');
  return { file, chapterRef };
}

async function readSummary(novelDir, chapterRef) {
  const np = novelPaths(novelDir);
  const safe = String(chapterRef).replace(/[^\w.-]/g, '_');
  try { return await fs.readFile(path.join(np.summaries, `${safe}.md`), 'utf8'); }
  catch { return ''; }
}

// ---------------- Style memory ----------------

async function readStyleMemory(novelDir) {
  const np = novelPaths(novelDir);
  try {
    const text = await fs.readFile(np.styleMemory, 'utf8');
    return text;
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function appendStyleMemory(novelDir, { delta }) {
  const np = ensureNovelLayout(novelDir);
  return withMutex(np.styleMemory, async () => {
    let prev = '';
    try { prev = await fs.readFile(np.styleMemory, 'utf8'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const stamp = new Date().toISOString();
    const next = `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}\n<!-- ${stamp} -->\n${delta || ''}\n`;
    await fs.mkdir(path.dirname(np.styleMemory), { recursive: true });
    await fs.writeFile(np.styleMemory, next, 'utf8');
    return { length: next.length };
  });
}

async function writeStyleMemory(novelDir, text) {
  const np = ensureNovelLayout(novelDir);
  return withMutex(np.styleMemory, async () => {
    await fs.mkdir(path.dirname(np.styleMemory), { recursive: true });
    await fs.writeFile(np.styleMemory, String(text || ''), 'utf8');
    return { length: (text || '').length };
  });
}

// ---------------- Outlines (structured nodes) ----------------

async function readOutlineNodes(novelDir) {
  const np = novelPaths(novelDir);
  const data = await readJson(np.outlineNodes, null);
  if (!data || !Array.isArray(data.nodes)) return null;
  return data;
}

function _headingLevel(level) {
  // level 1=卷 → #, 2=节 → ##, 3=章 → ###, default=章
  if (level === 1) return '#';
  if (level === 2) return '##';
  return '###';
}

async function writeOutlineNodes(novelDir, nodes) {
  const np = ensureNovelLayout(novelDir);
  const nodeList = Array.isArray(nodes) ? nodes : [];
  // Write structured JSON (for MCP tools like read_outline_nodes)
  await writeJson(np.outlineNodes, { schemaVersion: 1, nodes: nodeList });

  // Also write readable Markdown to main.md for the App UI to display.
  // Nodes with level field: 1=卷, 2=节, 3=章 (default). Generates hierarchical
  // headings so the outline is browsable in the sidebar and DataTabContent.
  let mdLines = [];
  for (let i = 0; i < nodeList.length; i++) {
    const n = nodeList[i];
    const heading = _headingLevel(n.level);
    const title = n.title || `节点 ${i + 1}`;
    const chars = Array.isArray(n.characters) && n.characters.length ? `  \n- 角色：${n.characters.join('、')}` : '';
    const setting = n.setting ? `\n- 场景：${n.setting}` : '';
    const location = n.location ? `\n- 地点：${n.location}` : '';
    const pov = n.pov ? `\n- 视角：${n.pov}` : '';
    const summary = n.summary ? `\n\n${n.summary}` : '';
    mdLines.push(`${heading} ${title}${chars}${setting}${location}${pov}${summary}`);
  }
  const mdContent = `# 总大纲\n\n${mdLines.join('\n\n')}\n`;
  await fs.writeFile(np.outlineMain, mdContent, 'utf8');
  return { ok: true };
}

/**
 * 将带有 volumeIndex/sectionIndex/chapterIndex 路由字段的扁平节点列表
 * 转为 HierarchicalOutline 结构，再调用 writeHierarchicalOutline 写入层级文件。
 * 若节点无路由字段，与 writeOutlineNodes 行为一致（平坦写入）。
 * @param {string} novelDir
 * @param {object[]} nodes - OutlineNode[]
 */
async function writeOutlineNodesToHierarchy(novelDir, nodes) {
  const nodeList = Array.isArray(nodes) ? nodes : [];

  // 检查是否有路由字段
  const hasRouting = nodeList.some(n => n.volumeIndex != null);
  if (!hasRouting) {
    // Fall back to flat write
    return writeOutlineNodes(novelDir, nodes);
  }

  // Group nodes by (volumeIndex, sectionIndex, chapterIndex)
  const chapters = {};
  const sectionMeta = {};
  const volumeMeta = {};

  for (const n of nodeList) {
    const v = n.volumeIndex;
    const s = n.sectionIndex;
    const c = n.chapterIndex;

    if (c != null && s != null && v != null) {
      const key = `${v}-${s}-${c}`;
      if (!chapters[key]) {
        chapters[key] = {
          chapterIndex: c,
          title: n.chapterTitle || `第${c}章`,
          scenes: [],
          writingNotes: n.writingNotes || '',
        };
      }
      chapters[key].scenes.push(n);
    } else if (s != null && v != null && c == null) {
      const key = `${v}-${s}`;
      if (!sectionMeta[key]) {
        sectionMeta[key] = { ...n, volumeIndex: v, sectionIndex: s };
      }
    } else if (v != null && s == null) {
      if (!volumeMeta[v]) {
        volumeMeta[v] = { ...n, volumeIndex: v };
      }
    }
  }

  // Build master items from volumeMeta (preserve all fields)
  const master = Object.values(volumeMeta).map(vm => ({ ...vm }));

  // Build volumes from grouped chapters and section metadata
  const volumeMap = {};
  for (const [key, ch] of Object.entries(chapters)) {
    const [v, s] = key.split('-').map(Number);
    if (!volumeMap[v]) volumeMap[v] = { volumeIndex: v, metadata: null, sections: {} };
    if (!volumeMap[v].sections[s]) {
      const smKey = `${v}-${s}`;
      const sm = sectionMeta[smKey];
      volumeMap[v].sections[s] = {
        sectionIndex: s,
        metadata: sm ? { ...sm, volumeIndex: v, sectionIndex: s } : { id: `sec-${v}-${s}`, title: `第${s}节`, summary: '', volumeIndex: v, sectionIndex: s },
        chapterOutlines: [],
      };
    }
    const existing = volumeMap[v].sections[s].chapterOutlines.find(x => x.chapterIndex === ch.chapterIndex);
    if (!existing) {
      volumeMap[v].sections[s].chapterOutlines.push(ch);
    }
  }

  // Merge section-only entries
  for (const [key, sm] of Object.entries(sectionMeta)) {
    const [v, s] = key.split('-').map(Number);
    if (!volumeMap[v]) volumeMap[v] = { volumeIndex: v, metadata: null, sections: {} };
    if (!volumeMap[v].sections[s]) {
      volumeMap[v].sections[s] = {
        sectionIndex: s,
        metadata: { ...sm, volumeIndex: v, sectionIndex: s },
        chapterOutlines: [],
      };
    }
  }

  // Attach volume metadata (preserve all fields)
  for (const vm of Object.values(volumeMeta)) {
    if (volumeMap[vm.volumeIndex]) {
      volumeMap[vm.volumeIndex].metadata = { ...vm, volumeIndex: vm.volumeIndex };
    }
  }

  // Convert to arrays
  const volumes = Object.values(volumeMap)
    .sort((a, b) => a.volumeIndex - b.volumeIndex)
    .map(v => ({
      ...v,
      metadata: v.metadata || { id: `vol-${v.volumeIndex}`, title: `第${v.volumeIndex}卷`, summary: '', volumeIndex: v.volumeIndex },
      sections: Object.values(v.sections)
        .sort((a, b) => a.sectionIndex - b.sectionIndex)
        .map(s => ({
          ...s,
          chapterOutlines: (s.chapterOutlines || []).sort((a, b) => a.chapterIndex - b.chapterIndex),
        })),
    }));

  return writeHierarchicalOutline(novelDir, {
    id: 'hier-' + Date.now().toString(36),
    version: 1,
    master,
    volumes,
  });
}

// ---------------- Hierarchical Outlines (多文件层级大纲) ----------------

function _sceneNodeToMd(node, i) {
  const title = node.title || `场景 ${i + 1}`;
  const lines = [`## ${title}`];
  const meta = [];
  if (Array.isArray(node.characters) && node.characters.length) {
    meta.push(`- 角色：${node.characters.join('、')}`);
  }
  if (node.setting) meta.push(`- 场景：${node.setting}`);
  if (node.location) meta.push(`- 地点：${node.location}`);
  if (node.pov) meta.push(`- 视角：${node.pov}`);
  if (node.outfit) meta.push(`- 着装：${node.outfit}`);
  if (node.needBackground) meta.push(`- 需背景`); // terse: no extra space
  if (meta.length) lines.push(...meta);
  if (node.summary) lines.push('', node.summary);
  return lines.join('\n');
}

function _chapterOutlineToMd(chapter, chIdx) {
  const lines = [`# 第${chIdx}章：${chapter.title || ''}`];
  if (chapter.writingNotes) {
    lines.push('', '## 写作指导', '', chapter.writingNotes);
  }
  lines.push('');
  if (Array.isArray(chapter.scenes)) {
    for (let i = 0; i < chapter.scenes.length; i++) {
      lines.push(_sceneNodeToMd(chapter.scenes[i], i));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function _sectionOutlineToMd(section, secIdx) {
  const m = section.metadata || {};
  const lines = [`# 第${secIdx}节：${m.title || ''}`];
  const meta = [];
  if (Array.isArray(m.characters) && m.characters.length) meta.push(`- 角色：${m.characters.join('、')}`);
  if (m.setting) meta.push(`- 场景：${m.setting}`);
  if (m.location) meta.push(`- 地点：${m.location}`);
  if (m.pov) meta.push(`- 视角：${m.pov}`);
  if (meta.length) lines.push(...meta);
  if (m.summary) lines.push('', m.summary);
  lines.push('');
  if (Array.isArray(section.chapterOutlines)) {
    for (const ch of section.chapterOutlines) {
      const ci = ch.chapterIndex;
      lines.push(`## 第${ci}章：${ch.title || ''}`);
      if (ch.writingNotes) lines.push('', ch.writingNotes);
      if (Array.isArray(ch.scenes)) {
        lines.push(`\n- 场景数：${ch.scenes.length}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function _volumeOutlineToMd(volume, volIdx) {
  const m = volume.metadata || {};
  const lines = [`# 第${volIdx}卷：${m.title || ''}`];
  const meta = [];
  if (Array.isArray(m.characters) && m.characters.length) meta.push(`- 角色：${m.characters.join('、')}`);
  if (m.setting) meta.push(`- 场景：${m.setting}`);
  if (m.location) meta.push(`- 地点：${m.location}`);
  if (m.pov) meta.push(`- 视角：${m.pov}`);
  if (meta.length) lines.push(...meta);
  if (m.summary) lines.push('', m.summary);
  lines.push('');
  if (Array.isArray(volume.sections)) {
    for (const sec of volume.sections) {
      const si = sec.sectionIndex;
      lines.push(`## 第${si}节：${sec.metadata?.title || ''}`);
      if (sec.metadata?.summary) lines.push('', sec.metadata.summary);
      if (Array.isArray(sec.chapterOutlines)) {
        for (const ch of sec.chapterOutlines) {
          lines.push(`### 第${ch.chapterIndex}章：${ch.title || ''}`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function _masterToMd(masterItems) {
  const lines = ['# 总大纲'];
  if (Array.isArray(masterItems)) {
    for (const item of masterItems) {
      lines.push(`## 第${item.volumeIndex}卷：${item.title || ''}`);
      const meta = [];
      if (Array.isArray(item.characters) && item.characters.length) meta.push(`- 角色：${item.characters.join('、')}`);
      if (item.setting) meta.push(`- 场景：${item.setting}`);
      if (item.location) meta.push(`- 地点：${item.location}`);
      if (item.pov) meta.push(`- 视角：${item.pov}`);
      if (meta.length) lines.push(...meta);
      if (item.summary) lines.push('', item.summary);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function _pad(n) {
  return String(n).padStart(3, '0');
}

/**
 * 将 HierarchicalOutline 按层级拆分写入多文件：
 * - outlines/outline.md — 总大纲（卷级摘要）
 * - outlines/volume-XXX/outline.md — 卷大纲
 * - outlines/volume-XXX/section-YYY/outline.md — 节大纲
 * - outlines/volume-XXX/section-YYY/chapter-ZZZ.md — 章大纲（最详细，含场景级 nodes + writingNotes）
 * 同时写回 nodes.json 作为聚合缓存（供 MCP read_outline_nodes 使用）
 * 同时写回 main.md 保持旧 UI 兼容
 * @param {string} novelDir
 * @param {object} hierarchy - HierarchicalOutline
 */
async function writeHierarchicalOutline(novelDir, hierarchy) {
  const np = ensureNovelLayout(novelDir);
  const allNodes = [];

  if (!hierarchy || !Array.isArray(hierarchy.volumes)) {
    // Write empty master outline
    await fs.writeFile(np.outlineMaster, '# 总大纲\n', 'utf8');
    await fs.writeFile(np.outlineMain, '# 总大纲\n', 'utf8');
    await writeJson(np.outlineNodes, { schemaVersion: 1, nodes: [] });
    return { ok: true, nodeCount: 0 };
  }

  for (const vol of hierarchy.volumes) {
    const volIdx = vol.volumeIndex;
    const volDir = outlineVolumeDir(novelDir, volIdx);
    await fs.mkdir(volDir, { recursive: true });

    await fs.writeFile(
      outlineVolumePath(novelDir, volIdx),
      _volumeOutlineToMd(vol, volIdx),
      'utf8'
    );

    // Add volume node to flat nodes.json (preserve all fields)
    if (vol.metadata) {
      allNodes.push({ ...vol.metadata, level: 1 });
    }

    if (!Array.isArray(vol.sections)) continue;
    for (const sec of vol.sections) {
      const secIdx = sec.sectionIndex;
      const secDir = outlineSectionDir(novelDir, volIdx, secIdx);
      await fs.mkdir(secDir, { recursive: true });

      await fs.writeFile(
        outlineSectionPath(novelDir, volIdx, secIdx),
        _sectionOutlineToMd(sec, secIdx),
        'utf8'
      );

      // Add section node to flat nodes.json (preserve all fields)
      if (sec.metadata) {
        allNodes.push({ ...sec.metadata, level: 2 });
      }

      if (!Array.isArray(sec.chapterOutlines)) continue;
      for (const ch of sec.chapterOutlines) {
        const chIdx = ch.chapterIndex;

        await fs.writeFile(
          outlineChapterPath(novelDir, volIdx, secIdx, chIdx),
          _chapterOutlineToMd(ch, chIdx),
          'utf8'
        );

        if (Array.isArray(ch.scenes)) {
          for (const scene of ch.scenes) {
            allNodes.push({
              ...scene,
              volumeIndex: volIdx,
              sectionIndex: secIdx,
              chapterIndex: chIdx,
            });
          }
        }
      }
    }
  }

  // Write master outline
  const masterMd = _masterToMd(hierarchy.master || []);
  await fs.writeFile(np.outlineMaster, masterMd, 'utf8');

  // Write aggregated nodes.json (MCP backward compat)
  await writeJson(np.outlineNodes, { schemaVersion: 1, nodes: allNodes });

  // Write main.md (legacy UI compat)
  await fs.writeFile(np.outlineMain, masterMd, 'utf8');

  return { ok: true, nodeCount: allNodes.length };
}

/**
 * 读取总大纲 Markdown
 * @param {string} novelDir
 * @returns {Promise<string>}
 */
async function readOutlineMaster(novelDir) {
  const np = novelPaths(novelDir);
  try { return await fs.readFile(np.outlineMaster, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

/**
 * 读取卷大纲 Markdown
 * @param {string} novelDir
 * @param {number} volIdx
 * @returns {Promise<string>}
 */
async function readOutlineVolume(novelDir, volIdx) {
  try { return await fs.readFile(outlineVolumePath(novelDir, volIdx), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

/**
 * 读取节大纲 Markdown
 * @param {string} novelDir
 * @param {number} volIdx
 * @param {number} secIdx
 * @returns {Promise<string>}
 */
async function readOutlineSection(novelDir, volIdx, secIdx) {
  try { return await fs.readFile(outlineSectionPath(novelDir, volIdx, secIdx), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

/**
 * 读取章大纲 Markdown（最详细，含场景级 nodes + writingNotes）
 * @param {string} novelDir
 * @param {number} volIdx
 * @param {number} secIdx
 * @param {number} chIdx
 * @returns {Promise<string>}
 */
async function readOutlineChapter(novelDir, volIdx, secIdx, chIdx) {
  try { return await fs.readFile(outlineChapterPath(novelDir, volIdx, secIdx, chIdx), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

/**
 * 在 outlines/ 下列出已存在的层级目录和文件（供 UI 使用）
 * @param {string} novelDir
 * @returns {Promise<{volumes: number[], sections: {volIdx:number, secIdx:number}[], chapters: {volIdx:number, secIdx:number, chIdx:number}[]}>}
 */
async function listOutlineHierarchy(novelDir) {
  const outlinesDir = path.join(novelDir, 'outlines');
  const result = { volumes: [], sections: [], chapters: [] };

  try {
    const volDirs = await fs.readdir(outlinesDir, { withFileTypes: true });
    for (const d of volDirs) {
      if (!d.isDirectory()) continue;
      const match = d.name.match(/^volume-(\d+)$/);
      if (!match) continue;
      const volIdx = parseInt(match[1], 10);
      result.volumes.push(volIdx);

      const secDirs = await fs.readdir(path.join(outlinesDir, d.name), { withFileTypes: true });
      for (const sd of secDirs) {
        if (!sd.isDirectory()) continue;
        const secMatch = sd.name.match(/^section-(\d+)$/);
        if (!secMatch) continue;
        const secIdx = parseInt(secMatch[1], 10);
        result.sections.push({ volIdx, secIdx });

        const chFiles = await fs.readdir(path.join(outlinesDir, d.name, sd.name), { withFileTypes: true });
        for (const cf of chFiles) {
          if (!cf.isFile()) continue;
          const chMatch = cf.name.match(/^chapter-(\d+)\.md$/);
          if (!chMatch) continue;
          result.chapters.push({ volIdx, secIdx, chIdx: parseInt(chMatch[1], 10) });
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  return result;
}

// ---------------- Chapters (Markdown) ----------------

async function listChapters(novelDir) {
  const np = ensureNovelLayout(novelDir);
  const files = await fastGlob('chapter-*.md', { cwd: np.chapters, absolute: false });
  files.sort();
  return files.map((name) => ({
    name,
    path: path.join(np.chapters, name),
  }));
}

async function readChapter(novelDir, name) {
  const np = novelPaths(novelDir);
  try {
    const raw = await fs.readFile(path.join(np.chapters, name), 'utf8');
    const { body } = parseFrontmatter(raw);
    return body || raw;
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Read raw chapter file content (including frontmatter, if any).
 * Used by character regeneration and other processes that need the original text.
 */
async function readChapterRaw(novelDir, name) {
  const np = novelPaths(novelDir);
  try {
    return await fs.readFile(path.join(np.chapters, name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Read chapter and return both content (body without frontmatter) and metadata.
 * @returns {{ content: string, metadata: object|null }}
 */
async function readChapterWithMeta(novelDir, name) {
  const np = novelPaths(novelDir);
  try {
    const raw = await fs.readFile(path.join(np.chapters, name), 'utf8');
    const { metadata, body } = parseFrontmatter(raw);
    return { content: body || raw, metadata };
  } catch (err) {
    if (err.code === 'ENOENT') return { content: '', metadata: null };
    throw err;
  }
}

/**
 * Read only frontmatter of a chapter file (reads first 2KB).
 * @returns {{ metadata: object|null, fileName: string }|null}
 */
async function readChapterMeta(novelDir, name) {
  const np = novelPaths(novelDir);
  const fm = await readFrontmatterFromFile(path.join(np.chapters, name));
  if (fm) return { metadata: fm.metadata, fileName: name };
  return null;
}

async function writeChapter(novelDir, name, content) {
  const np = ensureNovelLayout(novelDir);
  const safe = String(name).replace(/[^\w.\-]/g, '_');
  const file = path.join(np.chapters, safe);
  await fs.writeFile(file, content || '', 'utf8');
  return { name: safe, path: file };
}

/**
 * Write chapter with frontmatter metadata. Content should NOT include frontmatter;
 * it will be wrapped with frontmatter automatically.
 * @param {string} novelDir
 * @param {string} name - filename like "chapter-001.md"
 * @param {string} content - markdown body (without frontmatter)
 * @param {object} [metadata] - frontmatter fields like { title, volume, section }
 */
async function writeChapterWithMeta(novelDir, name, content, metadata) {
  const np = ensureNovelLayout(novelDir);
  const safe = String(name).replace(/[^\w.\-]/g, '_');
  const file = path.join(np.chapters, safe);
  const output = serializeFrontmatter(metadata || {}, content || '');
  await fs.writeFile(file, output, 'utf8');
  return { name: safe, path: file };
}

async function replaceChapterText(novelDir, name, targetText, replacementText, options = {}) {
  const safeName = String(name || '').replace(/[^\w.\-]/g, '_');
  const search = typeof targetText === 'string' ? targetText : '';
  if (!safeName) throw new Error('chapter name is required');
  if (!search) throw new Error('targetText is required');

  const { content, metadata } = await readChapterWithMeta(novelDir, safeName);
  const current = content || '';
  const replacement = typeof replacementText === 'string' ? replacementText : '';

  let matchCount = 0;
  let cursor = 0;
  while (cursor <= current.length) {
    const index = current.indexOf(search, cursor);
    if (index < 0) break;
    matchCount += 1;
    cursor = index + search.length;
    if (!search.length) break;
  }

  const expectedMatchCount = Number.isInteger(options.expectedMatchCount)
    ? options.expectedMatchCount
    : 1;

  if (matchCount === 0) {
    throw new Error('targetText not found in chapter content');
  }
  if (matchCount !== expectedMatchCount) {
    throw new Error(`targetText matched ${matchCount} times; expected ${expectedMatchCount}. Ask the user to select the exact occurrence, or place the cursor next to it and then use replace_text_near_cursor.`);
  }

  const nextContent = current.split(search).join(replacement);
  await writeChapterWithMeta(novelDir, safeName, nextContent, metadata || null);
  return {
    name: safeName,
    matchCount,
    replacedCount: matchCount,
    content: nextContent,
    metadata: metadata || null,
  };
}

/**
 * Compute the next available insertion filename between two chapters.
 * @param {string} novelDir
 * @param {string} afterFileName - insert after this filename
 * @returns {string}
 */
async function computeNextInsertNameForNovel(novelDir, afterFileName) {
  const chapters = await listChapters(novelDir);
  const files = chapters.map((c) => c.name);
  const idx = files.indexOf(afterFileName);
  if (idx < 0) {
    // Append to end
    const seq = files.length + 1;
    return `chapter-${String(seq).padStart(3, '0')}.md`;
  }
  return computeNextInsertName(files, idx);
}

// ---------------- World / lore ----------------

async function readWorld(novelDir) {
  const np = novelPaths(novelDir);
  let lore = '';
  try { lore = await fs.readFile(np.worldLore, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  let places = [];
  try {
    const data = await readJson(np.worldPlaces, null);
    if (data?.places) places = data.places;
  } catch { /* ignore */ }
  return { lore, places };
}

async function readWorldMeta(novelDir) {
  const np = novelPaths(novelDir);
  try {
    const meta = await readJson(np.worldMeta, null);
    return meta || {};
  } catch { return {}; }
}

async function writeWorld(novelDir, { lore, places }) {
  const np = ensureNovelLayout(novelDir);
  if (typeof lore === 'string') {
    await fs.writeFile(np.worldLore, lore, 'utf8');
  }
  if (Array.isArray(places)) {
    await writeJson(np.worldPlaces, { schemaVersion: 1, places });
  }
}

// ---------------- 章节命名规则 ----------------

const CN_NUMS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 数字转中文数字（支持 1~99）
 * @param {number} n
 * @returns {string}
 */
function toChineseNum(n) {
  if (n <= 10) return CN_NUMS[n];
  if (n < 20) return '十' + (n % 10 > 0 ? CN_NUMS[n % 10] : '');
  const tens = Math.floor(n / 10);
  const rem = n % 10;
  return CN_NUMS[tens] + '十' + (rem > 0 ? CN_NUMS[rem] : '');
}

/**
 * 根据命名规则和序号、标题计算章节显示名。
 * @param {string} rule - 如 "第{n}章"、"Chapter {n}"、"第{cn}章"
 * @param {number} seq - 序号（从1开始）
 * @param {string} [separator] - 分隔符，默认 "："
 * @param {string} [title] - 章节标题
 * @returns {string}
 */
function computeChapterDisplayName(rule, seq, separator, title) {
  const sep = separator || '：';
  let name = rule
    .replace(/\{cn\}/g, toChineseNum(seq))
    .replace(/\{n\}/g, String(seq));
  if (title) name += sep + title;
  return name;
}

/**
 * 读取章节命名配置并按 seq 计算显示名。
 * 用于接入 novel.json 中的 per-novel 配置。
 * @param {string} novelDir
 * @param {number} seq - 序号
 * @param {string} [title] - 标题
 * @returns {Promise<string>}
 */
async function computeDisplayNameForNovel(novelDir, seq, title) {
  const np = novelPaths(novelDir);
  const meta = await readJson(np.novelMeta, null);
  const cfg = meta?.chapterNaming;
  const rule = (cfg && cfg.rule) ? cfg.rule : '第{n}章';
  const sep = (cfg && cfg.separator) ? cfg.separator : '：';
  return computeChapterDisplayName(rule, seq, sep, title);
}

/**
 * 扩展 listChapters，为每章计算 displayName。
 * @param {string} novelDir
 * @returns {Promise<Array<{name: string, path: string, displayName: string}>>}
 */
async function listChaptersWithDisplay(novelDir) {
  const chapters = await listChapters(novelDir);
  if (chapters.length === 0) return chapters;
  const np = novelPaths(novelDir);
  const meta = await readJson(np.novelMeta, null);
  const cfg = meta?.chapterNaming;
  const rule = (cfg && cfg.rule) ? cfg.rule : '第{n}章';
  const sep = (cfg && cfg.separator) ? cfg.separator : '：';

  return chapters.map((ch, idx) => {
    const seq = idx + 1;
    // Try to read title from file content
    let title = '';
    try {
      const content = require('node:fs').readFileSync(ch.path, 'utf8');
      const m = content.match(/^#\s+(.+)/m);
      if (m) title = m[1].trim();
    } catch {}
    return {
      ...ch,
      displayName: computeChapterDisplayName(rule, seq, sep, title),
    };
  });
}

module.exports = {
  // characters
  normalizeCharacter,
  listCharacters, readCharacter, writeCharacter, deleteCharacter,
  // assets
  listAssets, readAsset, upsertAsset, grantAsset, revokeAsset,
  // timeline
  listTimeline, appendTimelineEvent, updateTimelineEvent, replaceTimeline, dedupeTimeline, queryTimeline,
  // summaries
  appendSummary, readSummary,
  // style
  readStyleMemory, appendStyleMemory, writeStyleMemory,
  // chapters
  listChapters, readChapter, readChapterRaw, readChapterWithMeta, readChapterMeta,
  writeChapter, writeChapterWithMeta, replaceChapterText, computeNextInsertNameForNovel,
  // outlines
  readOutlineNodes, writeOutlineNodes, writeOutlineNodesToHierarchy,
  writeHierarchicalOutline,
  readOutlineMaster, readOutlineVolume, readOutlineSection, readOutlineChapter,
  listOutlineHierarchy,
  // chapter naming
  computeChapterDisplayName, computeDisplayNameForNovel, toChineseNum,
  listChaptersWithDisplay,
  // world
  readWorld, writeWorld, readWorldMeta,
};
