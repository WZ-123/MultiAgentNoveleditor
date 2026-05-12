'use strict';

/**
 * Merge Engine — manages a merge session between an imported (staging) project
 * and an existing novel project.
 *
 * Each merge session tracks conflicts by item, user decisions, and finalization.
 *
 * mergeSession = {
 *   id, stagingId, novelId, novelDir,
 *   items: [
 *     { id, type, severity, label, leftContent, rightContent,
 *       resolution: null|'left'|'right'|'edited'|'ai_merged',
 *       resolvedContent, userNote, status: 'pending'|'resolved'|'disputed' }
 *   ],
 *   createdAt, updatedAt
 * }
 */

const path = require('node:path');
const fs = require('node:fs').promises;
const { readJson, writeJson, listJsonFiles } = require('../store/jsonStore');
const { novelPaths } = require('../store/paths');

// In-memory sessions (keyed by sessionId)
const _sessions = new Map();

function generateId() {
  return `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// TTL: remove sessions older than 30 min, keep at most 10.
const MAX_SESSIONS = 10;
const SESSION_TTL_MS = 30 * 60 * 1000;

function _enforceLimits() {
  if (_sessions.size <= MAX_SESSIONS) return;
  const entries = [..._sessions.entries()].sort((a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt));
  for (let i = 0; i < entries.length - MAX_SESSIONS; i++) {
    _sessions.delete(entries[i][0]);
    console.error('[mergeEngine] evicted old session:', entries[i][0]);
  }
}

// ---------- Load data from staging and existing novel ----------

async function _loadStagingCharacters(stagingDir) {
  const charsDir = path.join(stagingDir, 'characters');
  const chars = [];
  try {
    const files = await fs.readdir(charsDir);
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue;
      const c = await readJson(path.join(charsDir, f), null);
      if (c) chars.push(c);
    }
  } catch { /* ignore */ }
  return chars;
}

async function _loadNovelCharacters(novelDir) {
  const np = novelPaths(novelDir);
  try {
    return await listJsonFiles(np.characters);
  } catch { return []; }
}

async function _loadStagingWorld(stagingDir) {
  let lore = '', places = [];
  try {
    lore = await fs.readFile(path.join(stagingDir, 'world', 'lore.md'), 'utf8');
  } catch { /* ignore */ }
  try {
    const p = await readJson(path.join(stagingDir, 'world', 'places.json'), { places: [] });
    places = p.places || [];
  } catch { /* ignore */ }
  return { lore, places };
}

async function _loadNovelWorld(novelDir) {
  const np = novelPaths(novelDir);
  let lore = '', places = [];
  try { lore = await fs.readFile(path.join(np.world, 'lore.md'), 'utf8'); } catch { /* ignore */ }
  try {
    const p = await readJson(path.join(np.world, 'places.json'), { places: [] });
    places = p.places || [];
  } catch { /* ignore */ }
  return { lore, places };
}

async function _loadOutline(stagingDir, novelDir) {
  let stagingOutline = '', novelOutline = '';
  try {
    const files = (await fs.readdir(path.join(stagingDir, 'outlines'))).filter((f) => f.endsWith('.md')).sort();
    if (files[0]) stagingOutline = await fs.readFile(path.join(stagingDir, 'outlines', files[0]), 'utf8');
  } catch { /* ignore */ }
  const np = novelPaths(novelDir);
  try {
    const files = (await fs.readdir(np.outlines)).filter((f) => f.endsWith('.md')).sort();
    if (files[0]) novelOutline = await fs.readFile(path.join(np.outlines, files[0]), 'utf8');
  } catch { /* ignore */ }
  return { stagingOutline, novelOutline };
}

async function _loadStyleMemory(stagingDir, novelDir) {
  let stagingStyle = '', novelStyle = '';
  try { stagingStyle = await fs.readFile(path.join(stagingDir, 'style', 'memory.md'), 'utf8'); } catch { /* ignore */ }
  const np = novelPaths(novelDir);
  try { novelStyle = await fs.readFile(path.join(np.style, 'memory.md'), 'utf8'); } catch { /* ignore */ }
  return { stagingStyle, novelStyle };
}

// ---------- Conflict generation from staging vs novel ----------

function _gradeCharConflict(localChar, importedChar) {
  const ln = (localChar.name || '').toLowerCase().trim();
  const in_ = (importedChar.name || '').toLowerCase().trim();
  if (ln === in_) return 'critical';
  return 'minor';
}

function _itemLabel(localChar, importedChar) {
  return (importedChar.name || '?') + (localChar.name !== importedChar.name ? ` / ${localChar.name}` : '');
}

function _buildItems(stagingDir, novelDir, stagingData, novelData) {
  const items = [];

  // 1. Character conflicts
  for (const sc of stagingData.characters) {
    for (const nc of novelData.characters) {
      const sev = _gradeCharConflict(nc, sc);
      if (sev === 'critical') {
        items.push({
          id: `char-${items.length}`,
          type: 'character',
          severity: 'critical',
          label: _itemLabel(nc, sc),
          leftContent: JSON.stringify(sc, null, 2),
          rightContent: JSON.stringify(nc, null, 2),
          leftSource: 'imported',
          rightSource: 'existing',
          resolution: null,
          resolvedContent: null,
          userNote: '',
          status: 'pending',
        });
      }
    }
  }

  // 2. World lore conflict
  const stagingWorld = stagingData.world;
  const novelWorld = novelData.world;
  if (stagingWorld.lore || novelWorld.lore) {
    items.push({
      id: `world-lore`,
      type: 'world',
      severity: 'normal',
      label: '世界观设定 lore.md',
      leftContent: stagingWorld.lore || '(空)',
      rightContent: novelWorld.lore || '(空)',
      leftSource: 'imported',
      rightSource: 'existing',
      resolution: null,
      resolvedContent: null,
      userNote: '',
      status: 'pending',
    });
  }

  // 3. Place conflicts
  for (const sp of stagingWorld.places) {
    const match = novelWorld.places.find((np_) => (np_.name || '').toLowerCase() === (sp.name || '').toLowerCase());
    if (match) {
      items.push({
        id: `place-${sp.name}`,
        type: 'world',
        severity: 'normal',
        label: `地点: ${sp.name}`,
        leftContent: sp.description || '(无描述)',
        rightContent: match.description || '(无描述)',
        leftSource: 'imported',
        rightSource: 'existing',
        resolution: null,
        resolvedContent: null,
        userNote: '',
        status: 'pending',
      });
    }
  }

  // 4. Outline conflict
  if (stagingData.outline || novelData.outline) {
    items.push({
      id: `outline-main`,
      type: 'outline',
      severity: 'normal',
      label: '剧情大纲',
      leftContent: stagingData.outline || '(空)',
      rightContent: novelData.outline || '(空)',
      leftSource: 'imported',
      rightSource: 'existing',
      resolution: null,
      resolvedContent: null,
      userNote: '',
      status: 'pending',
    });
  }

  // 5. Style memory conflict
  if (stagingData.style || novelData.style) {
    items.push({
      id: `style-memory`,
      type: 'style',
      severity: 'minor',
      label: '文风记忆',
      leftContent: stagingData.style || '(空)',
      rightContent: novelData.style || '(空)',
      leftSource: 'imported',
      rightSource: 'existing',
      resolution: null,
      resolvedContent: null,
      userNote: '',
      status: 'pending',
    });
  }

  return items;
}

// ---------- Public API ----------

/**
 * Create a merge session from staging + existing novel.
 * Returns { sessionId, items, summary }
 */
async function createMergeSession(stagingDir, novelId, novelDir) {
  const [stagingChars, novelChars, stagingWorld, novelWorld, { stagingOutline, novelOutline }, { stagingStyle, novelStyle }] =
    await Promise.all([
      _loadStagingCharacters(stagingDir),
      _loadNovelCharacters(novelDir),
      _loadStagingWorld(stagingDir),
      _loadNovelWorld(novelDir),
      _loadOutline(stagingDir, novelDir),
      _loadStyleMemory(stagingDir, novelDir),
    ]);

  const items = _buildItems(stagingDir, novelDir, {
    characters: stagingChars,
    world: stagingWorld,
    outline: stagingOutline,
    style: stagingStyle,
  }, {
    characters: novelChars,
    world: novelWorld,
    outline: novelOutline,
    style: novelStyle,
  });

  const summary = { critical: 0, normal: 0, minor: 0, total: items.length };
  for (const item of items) { summary[item.severity]++; }

  const sessionId = generateId();
  const session = {
    id: sessionId,
    stagingId: path.basename(stagingDir),
    novelId,
    novelDir,
    items,
    summary,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  _enforceLimits();
  _sessions.set(sessionId, session);
  return { sessionId, items, summary };
}

function getMergeSession(sessionId) {
  return _sessions.get(sessionId) || null;
}

function resolveConflict(sessionId, itemId, decision, { resolvedContent, userNote } = {}) {
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Merge session not found: ${sessionId}`);
  const item = session.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`Conflict item not found: ${itemId}`);

  item.resolution = decision;
  if (decision === 'left') {
    item.resolvedContent = item.leftContent;
    item.status = 'resolved';
  } else if (decision === 'right') {
    item.resolvedContent = item.rightContent;
    item.status = 'resolved';
  } else if (decision === 'edited' && resolvedContent !== undefined) {
    item.resolvedContent = resolvedContent;
    item.status = 'resolved';
  } else if (decision === 'ai_merged' && resolvedContent !== undefined) {
    item.resolvedContent = resolvedContent;
    item.status = 'resolved';
  } else if (decision === 'disputed') {
    item.status = 'disputed';
  }

  if (userNote !== undefined) item.userNote = userNote;
  session.updatedAt = new Date().toISOString();
  return item;
}

function resetAll(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Merge session not found: ${sessionId}`);
  for (const item of session.items) {
    item.resolution = null;
    item.resolvedContent = null;
    item.userNote = '';
    item.status = 'pending';
  }
  session.updatedAt = new Date().toISOString();
}

function resetItem(sessionId, itemId) {
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Merge session not found: ${sessionId}`);
  const item = session.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`Conflict item not found: ${itemId}`);
  item.resolution = null;
  item.resolvedContent = null;
  item.userNote = '';
  item.status = 'pending';
  session.updatedAt = new Date().toISOString();
}

function getMergeSummary(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return null;
  const total = session.items.length;
  const resolved = session.items.filter((i) => i.status === 'resolved').length;
  const disputed = session.items.filter((i) => i.status === 'disputed').length;
  const pending = total - resolved - disputed;
  return { total, resolved, disputed, pending };
}

/**
 * Write resolved merge results back to the novel project.
 */
async function finalizeMerge(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) throw new Error(`Merge session not found: ${sessionId}`);

  const novelDir = session.novelDir;
  const np = novelPaths(novelDir);

  for (const item of session.items) {
    if (item.status !== 'resolved' || !item.resolvedContent) continue;

    if (item.type === 'character') {
      // Write character JSON
      try {
        const parsed = JSON.parse(item.resolvedContent);
        await fs.mkdir(np.characters, { recursive: true });
        await fs.writeFile(
          path.join(np.characters, `${parsed.name || parsed.id || item.label}.json`),
          item.resolvedContent, 'utf8'
        );
      } catch (err) {
        console.error('[merge] write character failed:', err.message);
      }
    } else if (item.type === 'world') {
      if (item.id === 'world-lore') {
        await fs.mkdir(np.world, { recursive: true });
        await fs.writeFile(path.join(np.world, 'lore.md'), item.resolvedContent, 'utf8');
      }
    } else if (item.type === 'outline') {
      await fs.mkdir(np.outlines, { recursive: true });
      await fs.writeFile(path.join(np.outlines, 'main.md'), item.resolvedContent, 'utf8');
    } else if (item.type === 'style') {
      await fs.mkdir(np.style, { recursive: true });
      await fs.writeFile(path.join(np.style, 'memory.md'), item.resolvedContent, 'utf8');
    }
  }

  // Mark staging as merged
  try {
    const stagingProject = require('./stagingProject');
    await stagingProject.updateStagingStatus(session.stagingId, 'merged');
  } catch { /* ignore */ }

  _sessions.delete(sessionId);
  return { written: session.items.filter((i) => i.status === 'resolved').length };
}

module.exports = {
  createMergeSession,
  getMergeSession,
  resolveConflict,
  resetAll,
  resetItem,
  getMergeSummary,
  finalizeMerge,
};
