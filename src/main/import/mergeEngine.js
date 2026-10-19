'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { paths } = require('../store/paths');
const { assertEntityId, assignEntityIds, entityFileName, assertContainedFile } = require('../store/entityIdentity');
const { snapshot, read, commitPlan } = require('./resourcePlan');
const storage = require('../store/projectTransactions');

function sessionFile(id) {
  if (!/^merge-[a-f0-9-]+$/u.test(id)) throw new Error('invalid merge session id');
  return path.join(paths().root, 'import-merge-sessions', `${id}.json`);
}
function materialRoot() { return path.join(paths().root, 'import-merge-sessions'); }
async function save(session) {
  session.updatedAt = new Date().toISOString();
  await storage.transaction(materialRoot(), () => require('../store/jsonStore').writeJson(sessionFile(session.id), session));
}

function getMergeSession(id) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    if (session.id !== id || !Array.isArray(session.items) || !session.novelId || !session.stagingId) throw Object.assign(new Error('合并材料身份损坏'), { code: 'recovery_required', retryable: true });
    return session;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function mustGet(id) {
  const session = getMergeSession(id);
  if (!session) throw new Error(`Merge session not found: ${id}`);
  return session;
}
function editable(session) {
  if (session.plan || session.receipt) throw new Error('merge commit has started; resume finalization before changing decisions');
}
async function list(directory, extension) {
  try { return (await fsp.readdir(directory)).filter((name) => name.endsWith(extension)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function listResources(root, directory, extension, prefix = '') {
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const resources = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    await assertContainedFile(root, file);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) resources.push(...await listResources(root, file, extension, relative));
    else if (entry.isFile() && entry.name.endsWith(extension)) resources.push(relative);
  }
  return resources;
}
async function buildMergeSession(stagingDir, novelId, novelDir) {
  assertEntityId(novelId);
  // Reopening an unfinished import restores its decisions, including a partial commit.
  const directory = path.join(paths().root, 'import-merge-sessions');
  const existing = await storage.exclusive(materialRoot(), async () => {
    for (const file of await list(directory, '.json')) {
      const session = getMergeSession(path.basename(file, '.json'));
      if (session.stagingDir === path.resolve(stagingDir) && session.novelId === novelId && session.novelDir === path.resolve(novelDir)) return session;
    }
    return null;
  });
  if (existing) return { sessionId: existing.id, items: existing.items, summary: summaryFor(existing) };

  const items = [];
  const targetKeys = new Set();
  async function add(relative, content, type, label, options = {}) {
    const key = relative.normalize('NFKC').toLowerCase();
    if (targetKeys.has(key)) throw new Error(`import resources collide at ${relative}`);
    targetKeys.add(key);
    for (const name of await list(path.dirname(path.join(novelDir, relative)), '')) {
      if (name !== path.basename(relative) && name.normalize('NFKC').toLowerCase() === path.basename(relative).normalize('NFKC').toLowerCase()) throw new Error(`cross-platform import collision: ${relative}`);
    }
    const baseline = await snapshot(novelDir, relative);
    const existing = baseline.before;
    items.push({ id: options.id || `resource-${items.length}`, type, label: label || relative, relative,
      severity: existing !== null ? 'normal' : 'minor', leftContent: content, rightContent: existing || '',
      leftSource: 'imported', rightSource: 'existing', resolution: null, resolvedContent: null,
      userNote: '', status: 'pending', ...baseline, ...options });
  }
  // Match characters by identity/name once; new cards are part of the same review plan.
  const oldCharacters = [];
  for (const file of await list(path.join(novelDir, 'characters'), '.json')) {
    if (file.endsWith('.memory.json')) continue;
    await assertContainedFile(novelDir, path.join(novelDir, 'characters', file));
    oldCharacters.push({ file, card: JSON.parse(await read(path.join(novelDir, 'characters', file))) });
  }
  const imported = [];
  for (const file of await list(path.join(stagingDir, 'characters'), '.json')) {
    if (file.endsWith('.memory.json')) continue;
    await assertContainedFile(stagingDir, path.join(stagingDir, 'characters', file));
    imported.push(JSON.parse(await read(path.join(stagingDir, 'characters', file))));
  }
  const usedTargets = new Set();
  for (const card of assignEntityIds(imported, 'character')) {
    const matches = oldCharacters.filter(({ card: old }) => old.id === card.id || String(old.name).normalize('NFKC').toLowerCase() === card.name.normalize('NFKC').toLowerCase());
    if (matches.length > 1) throw new Error(`ambiguous character identity: ${card.name}`);
    const old = matches[0];
    const relative = `characters/${old?.file || entityFileName(card.id)}`;
    if (usedTargets.has(relative.normalize('NFKC').toLowerCase())) throw new Error('multiple imported characters map to one target');
    usedTargets.add(relative.normalize('NFKC').toLowerCase());
    const candidate = { schemaVersion: 1, ...card, id: old?.card.id || card.id };
    await add(relative, JSON.stringify(candidate, null, 2), 'character', card.name, { characterId: candidate.id });
  }
  // Every persisted import resource is reviewed. Place objects are reviewed as a
  // complete JSON collection so IDs, extra fields and additions survive decisions.
  const domains = [['world', '.md'], ['world', '.json'], ['chapters', '.md'], ['factions', '.json'],
    ['timeline', '.jsonl'], ['outlines', '.md'], ['outlines', '.json'], ['style', '.md'], ['assets', '.json'], ['summaries', '.md']];
  for (const [domain, extension] of domains) {
    for (const file of await listResources(stagingDir, path.join(stagingDir, domain), extension)) {
      await assertContainedFile(stagingDir, path.join(stagingDir, domain, file));
      const content = await read(path.join(stagingDir, domain, file));
      if (!content?.trim()) continue;
      const relative = domain === 'outlines' && file === 'main.md' ? 'outlines/outline.md' : `${domain}/${file}`;
      // Empty staging placeholders do not authorize clearing existing data.
      if (relative === 'world/places.json' && !(JSON.parse(content).places || []).length) continue;
      await add(relative, content, domain === 'chapters' ? 'chapter' : domain === 'outlines' ? 'outline' : domain.replace(/s$/u, ''), relative,
        relative === 'world/lore.md' ? { id: 'world-lore' } : {});
    }
  }
  const session = { id: `merge-${crypto.randomUUID()}`, schemaVersion: 2, stagingDir: path.resolve(stagingDir), stagingId: path.basename(stagingDir),
    novelId, novelDir: path.resolve(novelDir), items, createdAt: new Date().toISOString() };
  return session;
}
async function resolveConflict(id, itemId, decision, { resolvedContent, userNote } = {}) {
  const session = mustGet(id); editable(session);
  const item = session.items.find((item) => item.id === itemId);
  if (!item) throw new Error('merge item not found');
  if (!['left', 'right', 'edited', 'ai_merged', 'disputed'].includes(decision)) throw new Error('invalid merge decision');
  if (['edited', 'ai_merged'].includes(decision) && typeof resolvedContent !== 'string') throw new Error('resolved content required');
  item.resolution = decision;
  item.resolvedContent = decision === 'left' ? item.leftContent : decision === 'right' ? item.rightContent : resolvedContent;
  item.status = decision === 'disputed' ? 'disputed' : 'resolved';
  if (userNote !== undefined) item.userNote = String(userNote);
  await save(session); return item;
}
async function resetItem(id, itemId) {
  const session = mustGet(id); editable(session);
  for (const item of session.items.filter((item) => !itemId || item.id === itemId)) {
    Object.assign(item, { resolution: null, resolvedContent: null, userNote: '', status: 'pending' });
  }
  await save(session);
}
function resetAll(id) { return resetItem(id); }
function summaryFor(session) {
  return { total: session.items.length, resolved: session.items.filter((i) => i.status === 'resolved').length,
    disputed: session.items.filter((i) => i.status === 'disputed').length, pending: session.items.filter((i) => i.status === 'pending').length };
}
function getMergeSummary(id) { const s = getMergeSession(id); return s ? summaryFor(s) : null; }
async function commitMerge(id, authority) {
  const session = await storage.exclusive(materialRoot(), () => mustGet(id));
  const run = await authority.read();
  if (session.novelId !== authority.target.id || session.stagingId !== authority.target.importId || storage.canonicalRoot(session.novelDir) !== authority.target.root) throw Object.assign(new Error('合并材料目标与运行身份不一致'), { code: 'recovery_required', retryable: true });
  session.novelDir = authority.target.root;
  const meta = await require('../store/jsonStore').readJson(path.join(session.novelDir, 'novel.json'), null);
  if (meta?.id !== authority.target.id) throw Object.assign(new Error('正式目标项目身份已变化'), { code: 'recovery_required', retryable: true });
  let plan;
  if (run.commitDecision) {
    if (run.commitDecision.id !== id || !run.commitDecision.plan) throw Object.assign(new Error('合并决定缺少已绑定的文件计划'), { code: 'recovery_required', retryable: true });
    plan = structuredClone(run.commitDecision.plan);
  } else {
    const summary = summaryFor(session);
    if (summary.pending || summary.disputed) throw Object.assign(new Error('all imported resources require a resolved decision'), { code: 'unresolved_conflicts', retryable: true });
    if (!session.items.length) throw Object.assign(new Error('import has no resources to merge'), { code: 'empty_merge_plan' });
    const changes = [];
    for (const item of session.items) {
      const after = item.resolution === 'right' ? item.before : item.resolvedContent;
      if (after !== null && item.relative.endsWith('.json')) {
        const object = JSON.parse(after);
        if (item.type === 'character' && object.id !== item.characterId) throw new Error('resolved character identity must match reviewed target');
        if (item.relative === 'world/places.json' && !Array.isArray(object.places)) throw new Error('places must be an array');
      }
      if (after !== null && item.relative.endsWith('.jsonl')) for (const line of after.split('\n').filter(Boolean)) JSON.parse(line);
      changes.push({ relative: item.relative, before: item.before, beforeHash: item.beforeHash, after });
    }
    plan = { id, changes, state: 'prepared' };
  }
  session.plan = plan;
  try {
    const published = await storage.committedReceipt(session.novelDir, plan);
    if (!run.commitDecision && !published) {
      for (const item of plan.changes) if ((await snapshot(session.novelDir, item.relative)).beforeHash !== item.beforeHash) throw Object.assign(new Error(`审阅后资源已变化：${item.relative}`), { code: 'stale_import_review', retryable: true });
    }
    await authority.decide({ id, kind: 'merge', sessionId: id, novelId: authority.target.id, importId: authority.target.importId, targetDir: authority.target.root, plan });
    await save(session);
    const receipt = await commitPlan(session.novelDir, plan, () => save(session));
    await require('../store/novelData').rebuildCharacterIndex(session.novelDir);
    session.receipt = { ...receipt, novelId: session.novelId, stagingId: session.stagingId, targetDir: session.novelDir }; await save(session);
    return session.receipt;
  } catch (error) {
    if (error.code === 'stale_import_review' && !run.commitDecision) {
      delete session.plan;
      for (const item of session.items) {
        const current = await snapshot(session.novelDir, item.relative);
        if (current.beforeHash !== item.beforeHash) Object.assign(item, current, { rightContent: current.before || '', resolution: null, resolvedContent: null, status: 'pending' });
      }
      await authority.stale(session, error);
    }
    throw error;
  }
}

async function prepareSession(stagingDir, novelId, novelDir) {
  const lock = path.join(paths().root, 'import-merge-executions', 'prepare-' + storage.hash(`${path.resolve(stagingDir)}:${novelId}`));
  return storage.exclusive(lock, async () => {
    const session = await storage.transaction(stagingDir, () => storage.transaction(novelDir, () => buildMergeSession(stagingDir, novelId, novelDir)));
    if (session.sessionId) return session;
    await save(session);
    return { sessionId: session.id, items: session.items, summary: summaryFor(session) };
  });
}
async function executeMerge(id, authority) {
  const novels = require('../store/novels');
  return novels.withProjectIdentity(authority.target.id, async () => {
    const target = await novels.pathsFor(authority.target.id);
    const root = storage.canonicalRoot(target.root);
    if (authority.target.root && storage.canonicalRoot(authority.target.root) !== root) throw Object.assign(new Error('合并审阅后的项目登记目录已变化'), { code: 'recovery_required', retryable: true });
    authority = { ...authority, target: { ...authority.target, root } };
    return storage.exclusive(path.join(paths().root, 'import-merge-executions', id), async () => {
      const receipt = await storage.exclusive(root, () => commitMerge(id, authority));
      // No application/registry lease is acquired while holding the target.
      await require('./stagingProject').updateStagingStatus(authority.target.importId, 'merged');
      return receipt;
    });
  });
}

async function legacyDecision(importId) {
  const candidates = await storage.exclusive(materialRoot(), async () => (await list(materialRoot(), '.json')).map((name) => getMergeSession(path.basename(name, '.json'))).filter((s) => s.stagingId === importId && s.plan));
  const decisions = [];
  for (const s of candidates) {
    const receipt = await storage.committedReceipt(s.novelDir, s.plan);
    if (receipt) decisions.push({ id: s.id, kind: 'merge', sessionId: s.id, novelId: s.novelId, importId, targetDir: storage.canonicalRoot(s.novelDir), plan: s.plan, receipt: { ...receipt, novelId: s.novelId, stagingId: importId, targetDir: storage.canonicalRoot(s.novelDir) } });
  }
  if (decisions.length > 1) throw Object.assign(new Error('旧导入有多个已提交合并，需核对运行身份'), { code: 'recovery_required', retryable: true });
  return decisions[0] || null;
}
const service = () => new (require('./importSaga').ImportSagaService)();
async function createMergeSession(stagingDir, novelId, novelDir) { return service().createMerge(path.basename(stagingDir), novelId, { legacy: true, novelDir }); }
async function decideSession(id, itemId, decision, options) { return service().resolveSession(id, itemId, decision, options); }
async function finalizeMerge(id) { return service().finalizeSession(id); }
module.exports = {
  createMergeSession, getMergeSession: (id) => storage.exclusive(materialRoot(), () => getMergeSession(id)), getMergeSummary: (id) => storage.exclusive(materialRoot(), () => getMergeSummary(id)), finalizeMerge,
  readSession: getMergeSession, materialRoot, saveMaterial: save,
  resolveConflict: decideSession, resetAll: (id) => service().resetSession(id), resetItem: (id, itemId) => service().resetSession(id, itemId),
  prepareSession, executeMerge, legacyDecision, applyDecision: resolveConflict, resetChoices: resetItem,
};
