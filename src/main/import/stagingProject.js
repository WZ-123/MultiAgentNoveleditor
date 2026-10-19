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
const { atomicWriteFile, contentHashExact } = require('../store/resourceIdentity');

const STAGING_DIR = 'import-staging';
const STAGING_REGISTRY = 'staging-registry.json';
const STAGING_TTL_DAYS = 30;

function stagingRoot() {
  return path.join(paths().root, STAGING_DIR);
}

function projectDir(importId) {
  require('../store/entityIdentity').assertEntityId(importId);
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
  require('../store/projectTransactions').registerRoot(projectDir);
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

  const active = await listStagingProjects();
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

async function createStagingProject({ sourceFiles, chapters, metadata, targetNovelId, runId }) {
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
      ...(runId ? { runId } : {}),
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
  const run = await new (require('./importRunStore').ImportRunStore)().findByImportId(importId);
  if (novelMeta.importMeta && run) novelMeta.importMeta.status = projectedStatus(run, novelMeta.importMeta.status);

  // Read chapters
  const chapterFiles = [];
  try {
    const files = await fs.readdir(np.chapters);
    for (const f of files.sort()) {
      if (f.endsWith('.md')) {
        const content = await fs.readFile(path.join(np.chapters, f), 'utf8');
        // An empty source file is represented by an intentionally blank Markdown
        // heading (`# \n\n`).  Accept that heading as a real header as well:
        // the former `\s+(.+)` parser missed it and surfaced the literal `#` as
        // chapter body text when a staging project was reopened.
        const titleMatch = content.match(/^#[ \t]*(.*)\r?\n/);
        chapterFiles.push({
          fileName: f,
          title: titleMatch ? titleMatch[1].trim() : f,
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
    worldMeta: await readJson(path.join(np.world, 'meta.json'), null),
    analysis: await readJson(path.join(np.root, '.mana', 'analysis-summary.json'), null),
    chapters: chapterFiles,
    characters,
    world,
    outline,
    styleMemory,
  };
}

async function listStagingProjects() {
  const registry = await _readRegistry();
  const store = new (require('./importRunStore').ImportRunStore)();
  const projects = await Promise.all((registry.projects || []).map(async (p) => ({ ...p, status: projectedStatus(await store.findByImportId(p.id), p.status) })));
  return projects
    .filter((p) => p.status === 'active')
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));
}
function projectedStatus(run, fallback) {
  return run?.state === 'cancelled' ? 'cancelled' : run?.state === 'completed' ? run.targetNovelId ? 'merged' : 'promoted' : fallback;
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
  const novelMeta = await readJson(np.novelJson, null);
  if (!novelMeta?.importMeta) throw new Error('staging metadata is missing');
  novelMeta.importMeta.status = status;
  await writeJson(np.novelJson, novelMeta);

  return true;
}

async function discardImport(importId) {
  const run = await new (require('./importSaga').ImportSagaService)().cancel(importId);
  if (!['cancelled', 'completed'].includes(run.state)) throw Object.assign(new Error('请先恢复未完成的提交'), { code: 'recovery_required' });
  return require('../store/projectTransactions').exclusive(paths().root, () => require('../store/projectTransactions').transaction(projectDir(importId), () => discardStagingProject(importId)));
}
async function cleanupExpiredProjects() {
  const storage = require('../store/projectTransactions');
  const registry = await storage.exclusive(paths().root, _readRegistry);
  const deleted = [];
  for (const entry of registry.projects || []) {
    if (new Date(entry.expiresAt).getTime() >= Date.now() && entry.status !== 'discarded') continue;
    const run = await new (require('./importSaga').ImportSagaService)().cancel(entry.id);
    if (!['cancelled', 'completed'].includes(run.state)) continue;
    await storage.exclusive(projectDir(entry.id), async () => {
      // Keep the lease directory while held; remove it after the owner releases.
      for (const name of await fs.readdir(projectDir(entry.id))) if (name !== '.mana') await fs.rm(path.join(projectDir(entry.id), name), { recursive: true, force: true });
    });
    await fs.rm(projectDir(entry.id), { recursive: true, force: true }); deleted.push(entry.id);
  }
  await storage.exclusive(paths().root, async () => { const current = await _readRegistry(); current.projects = current.projects.filter((p) => !deleted.includes(p.id)); await _writeRegistry(current); });
  return { deleted: deleted.length };
}

async function preparePromotion(importId, operation, abortSignal) {
  const assertNotAborted = () => { if (abortSignal?.aborted) throw abortSignal.reason || new DOMException('aborted', 'AbortError'); };
  assertNotAborted();
  const staging = await getStagingProject(importId);
  if (!staging) { const error = new Error('Staging project not found'); error.code = 'staging_missing'; throw error; }
  const sourceDir = projectDir(importId);
  if ((await require('./reviewStore').list(sourceDir)).length) throw Object.assign(new Error('请完成候选事实审阅后再创建项目'), { code: 'unresolved_facts' });
  const targetDir = operation.targetDir;
  const canonical = require('../store/projectTransactions').canonicalRoot;
  const source = canonical(sourceDir), target = canonical(targetDir);
  if (source === target || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) throw Object.assign(new Error('正式目标目录不能与暂存来源重叠'), { code: 'invalid_import_target', retryable: true });
  const parentDir = path.dirname(targetDir);
  const tempDir = operation.tempDir;
  await fs.mkdir(parentDir, { recursive: true });
  require('../store/projectTransactions').registerRoot(tempDir);
  await atomicWriteFile(path.join(tempDir, '.mana', 'promotion-owner.json'), JSON.stringify(require('./promotionTransactions').owner(operation)));

  async function copyDir(src, dst) {
    assertNotAborted();
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      assertNotAborted();
      if (src === path.join(sourceDir, '.mana') && ['transactions', 'storage.lock', 'character-reviews', 'analysis-commit.json', 'promotion-owner.json', 'import-manifest.json'].includes(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      await require('../store/entityIdentity').assertContainedFile(sourceDir, srcPath);
      if (entry.isDirectory()) {
        await copyDir(srcPath, dstPath);
      } else {
        await fs.copyFile(srcPath, dstPath, fs.constants?.COPYFILE_EXCL || 0);
      }
    }
  }
    await copyDir(sourceDir, tempDir);
    // Keep closed fact ledgers as provenance, rebound to the promoted project.
    const reviewDir = path.join(tempDir, '.mana', 'reviews');
    let reviewNames = []; try { reviewNames = await fs.readdir(reviewDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of reviewNames.filter((n) => n.endsWith('.json'))) {
      const review = await readJson(path.join(reviewDir, name), null);
      if (!review || review.state === 'review') throw new Error('promotion contains an unresolved fact review');
      review.sourceRoot = review.root; review.root = targetDir;
      await require('../store/atomicFile').rawAtomicWriteFile(path.join(reviewDir, name), JSON.stringify(review, null, 2));
    }
    assertNotAborted();
    const result = operation.result;
    result.title ||= staging.novelMeta.title || '导入的小说';
    const novelJsonPath = path.join(tempDir, 'novel.json');
    const novelMeta = await readJson(novelJsonPath, {});
    const sourceImportMeta = staging.novelMeta?.importMeta || {};
    delete novelMeta.importMeta;
    if (sourceImportMeta.sourceType === 'chatbox-html') {
      const { sourceType, sourceFiles, importedAt, messageCount, sessionTitles, extractedAt, notes } = sourceImportMeta;
      novelMeta.importMeta = { sourceType, sourceFiles: sourceFiles || [], importedAt: importedAt || new Date().toISOString(), messageCount: messageCount || 0, sessionTitles: sessionTitles || [], extractedAt: extractedAt || '', notes: notes || '' };
    }
    novelMeta.id = result.id;
    novelMeta.title = result.title;
    novelMeta.updatedAt = new Date().toISOString();
    await writeJson(novelJsonPath, novelMeta);
    await atomicWriteFile(path.join(tempDir, '.mana-project'), JSON.stringify({ type: 'novel', version: 1, id: result.id, title: result.title, createdAt: new Date().toISOString() }, null, 2));

    const manifest = [];
    async function scan(dirPath, prefix = '') {
      for (const entry of (await fs.readdir(dirPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix ? path.join(prefix, entry.name) : entry.name;
        if (relative === path.join('.mana', 'transactions') || relative === path.join('.mana', 'storage.lock')) continue;
        if (entry.isDirectory()) await scan(path.join(dirPath, entry.name), relative);
        else {
          const data = await fs.readFile(path.join(dirPath, entry.name));
          manifest.push({ path: relative, bytes: data.length, hash: contentHashExact(data) });
        }
      }
    }
    await scan(tempDir);
    assertNotAborted();
    if (!manifest.some((item) => item.path === 'novel.json') || !manifest.some((item) => item.path === '.mana-project')) throw new Error('promotion manifest is incomplete');
    await atomicWriteFile(path.join(tempDir, '.mana', 'import-manifest.json'), JSON.stringify({ schemaVersion: 2, operationId: operation.operationId, resources: manifest }, null, 2));
    assertNotAborted();
    await require('../store/projectTransactions').transaction(tempDir, async () => {});
    await fs.rm(path.join(tempDir, '.mana', 'transactions'), { recursive: true, force: true });
    return manifest;
}

const completePromotion = (importId) => require('../store/projectTransactions').exclusive(paths().root, () =>
  require('../store/projectTransactions').transaction(projectDir(importId), () => updateStagingStatus(importId, 'promoted')));
async function executePromotion(importId, options, authority) {
  return require('./promotionTransactions').commit(importId, options,
    (id, operation, signal) => require('../store/projectTransactions').transaction(projectDir(id), () => preparePromotion(id, operation, signal)), completePromotion, authority);
}
async function promoteToNovel(importId, options = {}) { return new (require('./importSaga').ImportSagaService)().promoteImport(importId, options); }
async function cleanupPromotion(importId) {
  const store = new (require('./importRunStore').ImportRunStore)();
  return require('./promotionTransactions').cleanup(importId, { read: () => store.findByImportId(importId) });
}
async function cancelPromotion(importId) {
  const run = await new (require('./importSaga').ImportSagaService)().cancel(importId);
  return { committed: run.state === 'completed', result: run.result };
}
const recordCancelRequest = (id) => require('./promotionTransactions').requestCancel(id);

module.exports = {
  createStagingProject,
  getStagingProject,
  listStagingProjects,
  discardStagingProject: discardImport,
  updateStagingStatus,
  cleanupExpiredProjects,
  promoteToNovel,
  executePromotion, cleanupPromotion, recordCancelRequest,
  cancelPromotion,
  requestPromotionCancel: async (id) => new (require('./importSaga').ImportSagaService)().cancel(id),
  getPromotion: require('./promotionTransactions').get,
  checkDuplicateImport,
};

for (const name of ['createStagingProject', 'updateStagingStatus']) {
  const operation = module.exports[name];
  module.exports[name] = (...args) => require('../store/projectTransactions').exclusive(paths().root, () => operation(...args));
}
