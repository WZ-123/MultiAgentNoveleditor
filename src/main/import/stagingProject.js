'use strict';

/**
 * Staging Project — temporary novel projects for imported external files.
 *
 * Storage: <userData>/import-staging/<importId>/
 * Structure mirrors a full novel project (chapters/, characters/, world/, etc.)
 *
 * Lifecycle:
 *   1. createStagingProject() — creates temp project from parsed chapters
 *   2. getStagingProject() / listStagingProjects() — read
 *   3. discardStagingProject() — marks as discarded (30-day grace period)
 *   4. cleanupExpiredProjects() — deletes projects past expiry
 *   5. promoteToNovel() — moves temp project to official novels directory
 */

const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { paths, generateId } = require('../store/paths');
const { readJson, writeJson } = require('../store/jsonStore');

const STAGING_DIR = 'import-staging';
const STAGING_REGISTRY = 'staging-registry.json';
const STAGING_TTL_DAYS = 30;

function stagingRoot() {
  return path.join(paths().root, STAGING_DIR);
}

function projectDir(importId) {
  return path.join(stagingRoot(), importId);
}

function registryPath() {
  return path.join(stagingRoot(), STAGING_REGISTRY);
}

async function _ensureStagingDir() {
  await fs.mkdir(stagingRoot(), { recursive: true });
}

async function _readRegistry() {
  return readJson(registryPath(), { projects: [] });
}

async function _writeRegistry(registry) {
  await _ensureStagingDir();
  await writeJson(registryPath(), registry);
}

function _novelPaths(projectDir) {
  return {
    root: projectDir,
    novelJson: path.join(projectDir, 'novel.json'),
    chapters: path.join(projectDir, 'chapters'),
    characters: path.join(projectDir, 'characters'),
    world: path.join(projectDir, 'world'),
    outlines: path.join(projectDir, 'outlines'),
    timeline: path.join(projectDir, 'timeline'),
    assets: path.join(projectDir, 'assets'),
    style: path.join(projectDir, 'style'),
    factions: path.join(projectDir, 'factions'),
    summaries: path.join(projectDir, 'summaries'),
    sources: path.join(projectDir, 'sources'),
  };
}

async function _ensureNovelLayout(np) {
  await fs.mkdir(np.chapters, { recursive: true });
  await fs.mkdir(np.characters, { recursive: true });
  await fs.mkdir(np.world, { recursive: true });
  await fs.mkdir(np.outlines, { recursive: true });
  await fs.mkdir(np.timeline, { recursive: true });
  await fs.mkdir(np.assets, { recursive: true });
  await fs.mkdir(np.style, { recursive: true });
  await fs.mkdir(np.factions, { recursive: true });
  await fs.mkdir(np.summaries, { recursive: true });
  await fs.mkdir(np.sources, { recursive: true });
}

// ---------- Fingerprint ----------

const FINGERPRINT_HEAD_BYTES = 1024;

async function _computeFingerprint(filePaths) {
  if (!filePaths || filePaths.length === 0) return '';
  const parts = [];
  for (const fp of filePaths) {
    let size = 0;
    let head = '';
    try {
      const stat = await fs.stat(fp);
      size = stat.size;
      const fd = await fs.open(fp, 'r');
      try {
        const buf = Buffer.alloc(Math.min(FINGERPRINT_HEAD_BYTES, size));
        await fd.read(buf, 0, buf.length, 0);
        head = buf.toString('base64').slice(0, 256);
      } finally {
        await fd.close();
      }
    } catch {
      // If file can't be read, use path only
    }
    parts.push(`${fp}:${size}:${head}`);
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

async function checkDuplicateImport(filePaths) {
  const fingerprint = await _computeFingerprint(filePaths);
  if (!fingerprint) return { isDuplicate: false };

  const registry = await _readRegistry();
  const active = (registry.projects || []).filter((p) => p.status === 'active');
  const match = active.find((p) => p.sourceFingerprint === fingerprint);
  if (match) {
    return {
      isDuplicate: true,
      existingImportId: match.id,
      existingTitle: match.title,
      existingImportedAt: match.importedAt,
      fingerprint,
    };
  }
  return { isDuplicate: false, fingerprint };
}

// ---------- CRUD ----------

async function createStagingProject({ sourceFiles, chapters, metadata, targetNovelId }) {
  const fingerprint = await _computeFingerprint(sourceFiles || []);
  await _ensureStagingDir();
  const importId = generateId('import');
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + STAGING_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const np = _novelPaths(projectDir(importId));
  await _ensureNovelLayout(np);

  // Write novel.json
  const novelMeta = {
    id: importId,
    title: metadata?.title || '导入的小说',
    schemaVersion: 1,
    activeDagId: null,
    structure: { volumes: [] },
    createdAt: now,
    updatedAt: now,
    importMeta: {
      sourceFiles: sourceFiles || [],
      importedAt: now,
      expiresAt,
      targetNovelId: targetNovelId || null,
      status: 'active', // 'active' | 'discarded' | 'merged' | 'promoted'
      ...(metadata?.importMeta || {}),
    },
    fanwork: metadata?.fanwork || { hasFanwork: null, referencedWorks: [] },
  };
  await writeJson(np.novelJson, novelMeta);
  if (metadata?.importMeta) {
    await writeJson(path.join(np.sources, 'import-source.json'), {
      sourceFiles: sourceFiles || [],
      importMeta: metadata.importMeta,
      writtenAt: now,
    });
  }
  if (metadata?.analysisHints) {
    await fs.writeFile(path.join(np.sources, 'analysis-hints.md'), metadata.analysisHints, 'utf8');
  }

  // Write chapters
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const fileName = `chapter-${String(i + 1).padStart(3, '0')}.md`;
    const content = `# ${ch.title}\n\n${ch.content}`;
    await fs.writeFile(path.join(np.chapters, fileName), content, 'utf8');
  }

  // Write initial empty files for other domains
  await writeJson(path.join(np.world, 'places.json'), { schemaVersion: 1, places: [] });
  await fs.writeFile(path.join(np.style, 'memory.md'), '', 'utf8');
  await fs.writeFile(path.join(np.world, 'lore.md'), '', 'utf8');

  // Update registry
  const registry = await _readRegistry();
  registry.projects = registry.projects || [];
  registry.projects.push({
    id: importId,
    title: novelMeta.title,
    importedAt: now,
    expiresAt,
    targetNovelId: targetNovelId || null,
    status: 'active',
    sourceFingerprint: fingerprint,
    sourceFiles: sourceFiles || [],
  });
  await _writeRegistry(registry);

  return { importId, novelMeta, chapterCount: chapters.length };
}

async function getStagingProject(importId) {
  const np = _novelPaths(projectDir(importId));
  const novelMeta = await readJson(np.novelJson, null);
  if (!novelMeta) return null;

  // Read chapters
  const chapterFiles = [];
  try {
    const files = await fs.readdir(np.chapters);
    for (const f of files.sort()) {
      if (f.endsWith('.md')) {
        const content = await fs.readFile(path.join(np.chapters, f), 'utf8');
        const titleMatch = content.match(/^#\s+(.+)\n/);
        chapterFiles.push({
          fileName: f,
          title: titleMatch ? titleMatch[1] : f,
          content: content.slice(titleMatch ? titleMatch[0].length : 0).trim(),
        });
      }
    }
  } catch { /* ignore missing chapters dir */ }

  // Read characters
  const characters = [];
  try {
    const files = await fs.readdir(np.characters);
    for (const f of files.sort()) {
      if (f.endsWith('.json')) {
        const char = await readJson(path.join(np.characters, f), null);
        if (char) characters.push(char);
      }
    }
  } catch { /* ignore */ }

  // Read world
  let world = { lore: '', places: [] };
  try {
    const lore = await fs.readFile(path.join(np.world, 'lore.md'), 'utf8');
    const places = await readJson(path.join(np.world, 'places.json'), { places: [] });
    world = { lore, places: places.places || [] };
  } catch { /* ignore */ }

  // Read outline
  let outline = '';
  try {
    const outlineFiles = (await fs.readdir(np.outlines)).filter((f) => f.endsWith('.md')).sort();
    if (outlineFiles.length > 0) {
      outline = await fs.readFile(path.join(np.outlines, outlineFiles[0]), 'utf8');
    }
  } catch { /* ignore */ }

  // Read style
  let styleMemory = '';
  try {
    styleMemory = await fs.readFile(path.join(np.style, 'memory.md'), 'utf8');
  } catch { /* ignore */ }

  return {
    importId,
    novelMeta,
    chapters: chapterFiles,
    characters,
    world,
    outline,
    styleMemory,
  };
}

async function listStagingProjects() {
  const registry = await _readRegistry();
  return (registry.projects || [])
    .filter((p) => p.status === 'active')
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));
}

async function discardStagingProject(importId) {
  const registry = await _readRegistry();
  const p = (registry.projects || []).find((x) => x.id === importId);
  if (!p) return false;
  p.status = 'discarded';
  await _writeRegistry(registry);

  // Update novel.json status too
  const np = _novelPaths(projectDir(importId));
  try {
    const novelMeta = await readJson(np.novelJson, null);
    if (novelMeta?.importMeta) {
      novelMeta.importMeta.status = 'discarded';
      await writeJson(np.novelJson, novelMeta);
    }
  } catch { /* ignore */ }

  return true;
}

async function updateStagingStatus(importId, status) {
  const registry = await _readRegistry();
  const p = (registry.projects || []).find((x) => x.id === importId);
  if (!p) return false;
  p.status = status;
  await _writeRegistry(registry);

  const np = _novelPaths(projectDir(importId));
  try {
    const novelMeta = await readJson(np.novelJson, null);
    if (novelMeta?.importMeta) {
      novelMeta.importMeta.status = status;
      await writeJson(np.novelJson, novelMeta);
    }
  } catch { /* ignore */ }

  return true;
}

async function cleanupExpiredProjects() {
  const registry = await _readRegistry();
  const now = Date.now();
  const toDelete = [];
  const remaining = [];

  for (const p of registry.projects || []) {
    const expired = new Date(p.expiresAt).getTime() < now;
    const discarded = p.status === 'discarded';
    if (expired || discarded) {
      toDelete.push(p.id);
    } else {
      remaining.push(p);
    }
  }

  for (const id of toDelete) {
    try {
      const dir = projectDir(id);
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[staging] cleanup failed for ${id}`, err);
    }
  }

  registry.projects = remaining;
  await _writeRegistry(registry);
  return { deleted: toDelete.length };
}

async function promoteToNovel(importId, { title, dir }) {
  const staging = await getStagingProject(importId);
  if (!staging) throw new Error('Staging project not found');

  const novelsStore = require('../store/novels');
  const result = await novelsStore.createNovel({ title: title || staging.novelMeta.title, dir });

  // Defensive: verify the registry entry was actually created.
  // createNovel skips adding if {id,dir} already exists — but we need it to.
  const verifyList = await novelsStore.listNovels();
  if (!verifyList.find((n) => n.id === result.id)) {
    console.error('[promoteToNovel] createNovel returned', result.id, 'but registry has no entry — forcing add');
    // Read registry directly and add entry
    const { paths: getPaths } = require('../store/paths');
    const { readJson, writeJson } = require('../store/jsonStore');
    const reg = await readJson(getPaths().novelsRegistry, { novels: [] });
    reg.novels = reg.novels || [];
    reg.novels.push({ id: result.id, title: result.title, dir: result.dir, addedAt: new Date().toISOString(), lastOpenedAt: null });
    await writeJson(getPaths().novelsRegistry, reg);
  }

  // Copy files from staging to the new novel directory.
  // Skip novel.json — createNovel already wrote the correct one in the target.
  const sourceDir = projectDir(importId);
  const targetDir = result.dir;

  async function copyDir(src, dst) {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      // Skip novel.json — target already has the correct one from createNovel
      if (!entry.isDirectory() && entry.name === 'novel.json') continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await copyDir(srcPath, dstPath);
      } else {
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  await copyDir(sourceDir, targetDir);

  // Ensure the target novel.json has the correct ID and clean metadata
  const novelJsonPath = path.join(targetDir, 'novel.json');
  const novelMeta = await readJson(novelJsonPath, {});
  delete novelMeta.importMeta;
  if (staging.novelMeta?.importMeta?.sourceType === 'chatbox-html') {
    const { sourceType, sourceFiles, importedAt, messageCount, sessionTitles, extractedAt, notes } = staging.novelMeta.importMeta;
    novelMeta.importMeta = {
      sourceType,
      sourceFiles: sourceFiles || [],
      importedAt: importedAt || new Date().toISOString(),
      messageCount: messageCount || 0,
      sessionTitles: sessionTitles || [],
      extractedAt: extractedAt || '',
      notes: notes || '',
    };
  }
  novelMeta.id = result.id;
  novelMeta.title = title || novelMeta.title;
  await writeJson(novelJsonPath, novelMeta);

  // Write .mana-project marker file so the editor can recognize this directory
  const markerPath = path.join(targetDir, '.mana-project');
  await fs.writeFile(markerPath, JSON.stringify({
    type: 'novel',
    version: 1,
    id: result.id,
    title: novelMeta.title,
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  // Mark staging as promoted
  await updateStagingStatus(importId, 'promoted');

  return result;
}

module.exports = {
  createStagingProject,
  getStagingProject,
  listStagingProjects,
  discardStagingProject,
  updateStagingStatus,
  cleanupExpiredProjects,
  promoteToNovel,
  checkDuplicateImport,
};
