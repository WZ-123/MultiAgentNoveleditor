'use strict';

/**
 * Novels store — manages the registry of novel projects (one-novel-one-directory).
 *
 * <userData>/novels.json holds the registry: { novels: [{ id, title, dir, addedAt, lastOpenedAt }, ...] }
 * Each novel directory holds its own novel.json (metadata).
 */

const path = require('node:path');
const fs = require('node:fs').promises;
const { paths, novelPaths, ensureNovelLayout, generateId } = require('./paths');
const { readJson, writeJson, pathExists } = require('./jsonStore');

const SCHEMA_VERSION = 1;

async function loadRegistry() {
  return readJson(paths().novelsRegistry, { novels: [] });
}

async function saveRegistry(reg) {
  await writeJson(paths().novelsRegistry, reg);
}

function novelMetaTemplate({ id, title }) {
  return {
    id,
    title: title || 'Untitled',
    schemaVersion: SCHEMA_VERSION,
    activeDagId: null,
    structure: { volumes: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function listNovels() {
  const reg = await loadRegistry();
  return Array.isArray(reg.novels) ? reg.novels : [];
}

async function getNovelById(id) {
  const list = await listNovels();
  return list.find((n) => n.id === id) || null;
}

async function createNovel({ title, dir }) {
  if (!dir || typeof dir !== 'string') throw new Error('dir is required');
  const np = ensureNovelLayout(dir);
  const existing = await readJson(np.novelMeta, null);
  const id = existing?.id || generateId('novel');
  const meta = existing || novelMetaTemplate({ id, title });
  if (title && !existing) meta.title = title;
  meta.updatedAt = new Date().toISOString();
  try {
    await writeJson(np.novelMeta, meta);
  } catch (err) {
    throw new Error(`无法写入 novel.json: ${err.message}。检查目录权限和磁盘空间。`);
  }

  // Write .mana-project marker
  try {
    const markerPath = path.join(dir, '.mana-project');
    await fs.writeFile(markerPath, JSON.stringify({
      type: 'novel', version: 1, id, title: meta.title, createdAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (err) {
    console.error('[createNovel] .mana-project write failed:', err.message);
  }

  const reg = await loadRegistry();
  const list = Array.isArray(reg.novels) ? reg.novels : [];
  if (!list.find((n) => n.id === id || n.dir === dir)) {
    list.push({ id, title: meta.title, dir, addedAt: new Date().toISOString(), lastOpenedAt: null });
    await saveRegistry({ novels: list });
  }
  return { id, title: meta.title, dir };
}

async function openNovel(id) {
  const entry = await getNovelById(id);
  if (!entry) throw new Error(`novel not found: ${id}`);
  const np = ensureNovelLayout(entry.dir);
  const meta = await readJson(np.novelMeta, null);
  if (!meta) throw new Error(`novel.json missing in ${entry.dir}`);
  // touch lastOpenedAt
  const reg = await loadRegistry();
  const list = (reg.novels || []).map((n) =>
    n.id === id ? { ...n, lastOpenedAt: new Date().toISOString() } : n
  );
  await saveRegistry({ novels: list });
  return { entry, meta, paths: np };
}

async function saveNovelMeta(id, patch) {
  const entry = await getNovelById(id);
  if (!entry) throw new Error(`novel not found: ${id}`);
  const np = novelPaths(entry.dir);
  const meta = (await readJson(np.novelMeta, null)) || novelMetaTemplate({ id, title: entry.title });
  const next = { ...meta, ...patch, id, updatedAt: new Date().toISOString() };
  await writeJson(np.novelMeta, next);
  // mirror title to registry
  if (patch?.title) {
    const reg = await loadRegistry();
    const list = (reg.novels || []).map((n) => (n.id === id ? { ...n, title: patch.title } : n));
    await saveRegistry({ novels: list });
  }
  return next;
}

async function removeFromRegistry(id) {
  const reg = await loadRegistry();
  const list = (reg.novels || []).filter((n) => n.id !== id);
  await saveRegistry({ novels: list });
}

/**
 * Recover registry entry from a directory containing a novel.json (e.g. user picks a folder again).
 */
async function importExistingNovel(dir) {
  const np = novelPaths(dir);
  const meta = await readJson(np.novelMeta, null);
  if (!meta?.id) throw new Error('no novel.json or invalid id');
  const reg = await loadRegistry();
  const list = Array.isArray(reg.novels) ? reg.novels : [];
  if (!list.find((n) => n.id === meta.id)) {
    list.push({
      id: meta.id,
      title: meta.title || 'Untitled',
      dir,
      addedAt: new Date().toISOString(),
      lastOpenedAt: null,
    });
    await saveRegistry({ novels: list });
  } else {
    // update dir if path moved
    const next = list.map((n) => (n.id === meta.id ? { ...n, dir } : n));
    await saveRegistry({ novels: next });
  }
  return { id: meta.id, title: meta.title, dir };
}

async function pathsFor(id) {
  const entry = await getNovelById(id);
  if (!entry) throw new Error(`novel not found: ${id}`);
  return novelPaths(entry.dir);
}

/** 默认章节命名规则 */
const DEFAULT_NAMING = { rule: '第{n}章', separator: '：' };

/**
 * @param {string} id
 * @returns {Promise<{rule: string, separator: string}>}
 */
async function getChapterNamingRule(id) {
  const entry = await getNovelById(id);
  if (!entry) throw new Error(`novel not found: ${id}`);
  const np = novelPaths(entry.dir);
  const meta = await readJson(np.novelMeta, null);
  const cfg = meta?.chapterNaming;
  if (cfg && typeof cfg === 'object' && typeof cfg.rule === 'string') {
    return { rule: cfg.rule, separator: cfg.separator || DEFAULT_NAMING.separator };
  }
  return { ...DEFAULT_NAMING };
}

/**
 * @param {string} id
 * @param {string} rule - 命名规则模板
 * @param {string} [separator]
 * @returns {Promise<{rule: string, separator: string}>}
 */
async function setChapterNamingRule(id, rule, separator) {
  const entry = await getNovelById(id);
  if (!entry) throw new Error(`novel not found: ${id}`);
  const np = novelPaths(entry.dir);
  const meta = await readJson(np.novelMeta, null) || novelMetaTemplate({ id, title: entry.title });
  const cfg = { rule, separator: separator || DEFAULT_NAMING.separator };
  meta.chapterNaming = cfg;
  meta.updatedAt = new Date().toISOString();
  await writeJson(np.novelMeta, meta);
  return cfg;
}

module.exports = {
  SCHEMA_VERSION,
  listNovels,
  getNovelById,
  createNovel,
  openNovel,
  saveNovelMeta,
  removeFromRegistry,
  importExistingNovel,
  pathsFor,
  getChapterNamingRule,
  setChapterNamingRule,
};
