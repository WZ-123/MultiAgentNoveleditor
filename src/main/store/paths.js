'use strict';

const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = 'MultiAgentNovelAssistant';

let _electronApp = null;
function _resolveElectronApp() {
  if (_electronApp) return _electronApp;
  try {
    _electronApp = require('electron').app || null;
  } catch {
    _electronApp = null;
  }
  return _electronApp;
}

function userDataDir() {
  if (process.env.MANA_USER_DATA_ROOT) return process.env.MANA_USER_DATA_ROOT;
  const a = _resolveElectronApp();
  if (a?.getPath) return path.join(a.getPath('userData'), APP_NAME);
  throw new Error('paths.userDataDir unavailable: set MANA_USER_DATA_ROOT or run in Electron main.');
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function paths() {
  const root = userDataDir();
  return {
    root,
    appConfig: path.join(root, 'app-config.json'),
    secrets: path.join(root, 'secrets.json'),
    subagents: path.join(root, 'subagents'),
    subagentsBuiltin: path.join(root, 'subagents', 'builtin'),
    subagentsUser: path.join(root, 'subagents', 'user'),
    pipelines: path.join(root, 'pipelines'),
    pipelinesBuiltin: path.join(root, 'pipelines', 'builtin'),
    pipelinesUser: path.join(root, 'pipelines', 'user'),
    skills: path.join(root, 'skills'),
    skillsMain: path.join(root, 'skills', 'skill.md'),
    skillsIndex: path.join(root, 'skills', 'index.json'),
    logs: path.join(root, 'logs', 'runs'),
    novelsRegistry: path.join(root, 'novels.json'),
  };
}

/**
 * @param {string} novelDir
 */
function novelPaths(novelDir) {
  return {
    root: novelDir,
    novelMeta: path.join(novelDir, 'novel.json'),
    chapters: path.join(novelDir, 'chapters'),
    outlines: path.join(novelDir, 'outlines'),
    outlineNodes: path.join(novelDir, 'outlines', 'nodes.json'),
    outlineMain: path.join(novelDir, 'outlines', 'main.md'),
    outlineMaster: path.join(novelDir, 'outlines', 'outline.md'),
    summaries: path.join(novelDir, 'summaries'),
    characters: path.join(novelDir, 'characters'),
    factions: path.join(novelDir, 'factions'),
    world: path.join(novelDir, 'world'),
    worldLore: path.join(novelDir, 'world', 'lore.md'),
    worldPlaces: path.join(novelDir, 'world', 'places.json'),
    worldMeta: path.join(novelDir, 'world', 'meta.json'),
    timeline: path.join(novelDir, 'timeline'),
    timelineEvents: path.join(novelDir, 'timeline', 'events.jsonl'),
    assets: path.join(novelDir, 'assets'),
    assetsMain: path.join(novelDir, 'assets', 'assets.json'),
    style: path.join(novelDir, 'style'),
    styleMemory: path.join(novelDir, 'style', 'memory.md'),
    styleThreshold: path.join(novelDir, 'style', 'threshold.json'),
    styleArchive: path.join(novelDir, 'style', 'archive'),
    runs: path.join(novelDir, 'runs'),
    mana: path.join(novelDir, '.mana'),
    manaLock: path.join(novelDir, '.mana', 'lock'),
    manaIndex: path.join(novelDir, '.mana', 'index.json'),
  };
}

function ensureLayout() {
  const p = paths();
  ensureDirSync(p.root);
  ensureDirSync(p.subagentsBuiltin);
  ensureDirSync(p.subagentsUser);
  ensureDirSync(p.pipelinesBuiltin);
  ensureDirSync(p.pipelinesUser);
  ensureDirSync(p.skills);
  ensureDirSync(p.logs);
  return p;
}

function ensureNovelLayout(novelDir) {
  const np = novelPaths(novelDir);
  ensureDirSync(np.root);
  ensureDirSync(np.chapters);
  ensureDirSync(np.outlines);
  ensureDirSync(np.summaries);
  ensureDirSync(np.characters);
  ensureDirSync(np.factions);
  ensureDirSync(np.world);
  ensureDirSync(np.timeline);
  ensureDirSync(np.assets);
  ensureDirSync(np.style);
  ensureDirSync(np.styleArchive);
  ensureDirSync(np.runs);
  ensureDirSync(np.mana);
  return np;
}

function _pad(n, width = 3) {
  return String(n).padStart(width, '0');
}

/**
 * @param {string} novelDir
 * @param {number} volIdx
 */
function outlineVolumePath(novelDir, volIdx) {
  return path.join(novelDir, 'outlines', `volume-${_pad(volIdx)}`, 'outline.md');
}

/**
 * @param {string} novelDir
 * @param {number} volIdx
 * @param {number} secIdx
 */
function outlineSectionPath(novelDir, volIdx, secIdx) {
  return path.join(novelDir, 'outlines', `volume-${_pad(volIdx)}`, `section-${_pad(secIdx)}`, 'outline.md');
}

/**
 * @param {string} novelDir
 * @param {number} volIdx
 * @param {number} secIdx
 * @param {number} chIdx
 */
function outlineChapterPath(novelDir, volIdx, secIdx, chIdx) {
  return path.join(novelDir, 'outlines', `volume-${_pad(volIdx)}`, `section-${_pad(secIdx)}`, `chapter-${_pad(chIdx)}.md`);
}

/**
 * @param {string} novelDir
 * @param {number} volIdx
 */
function outlineVolumeDir(novelDir, volIdx) {
  return path.join(novelDir, 'outlines', `volume-${_pad(volIdx)}`);
}

/**
 * @param {string} novelDir
 * @param {number} volIdx
 * @param {number} secIdx
 */
function outlineSectionDir(novelDir, volIdx, secIdx) {
  return path.join(novelDir, 'outlines', `volume-${_pad(volIdx)}`, `section-${_pad(secIdx)}`);
}

function skillContentPath(id) {
  const root = paths().skills;
  return path.join(root, `${id.replace(/[^\w.\-]/g, '_')}.md`);
}

function generateId(prefix) {
  const ts = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${r}`;
}

module.exports = {
  paths,
  novelPaths,
  ensureLayout,
  ensureNovelLayout,
  ensureDirSync,
  generateId,
  outlineVolumePath,
  outlineSectionPath,
  outlineChapterPath,
  outlineVolumeDir,
  outlineSectionDir,
  skillContentPath,
  _pad,
  APP_NAME,
};
