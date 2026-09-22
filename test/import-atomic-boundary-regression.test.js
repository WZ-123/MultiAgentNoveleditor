'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-import-atomic-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const staging = require('../src/main/import/stagingProject');
    const merge = require('../src/main/import/mergeEngine');
    const novels = require('../src/main/store/novels');
    const novelData = require('../src/main/store/novelData');
    const created = await staging.createStagingProject({
      sourceFiles: [], chapters: [{ title: '第一章', content: '导入正文' }], metadata: { title: '原子导入' }, targetNovelId: null,
    });

    const registryBefore = await novels.listNovels();
    const conflictTarget = path.join(root, 'already-exists');
    await fsp.mkdir(conflictTarget, { recursive: true });
    await assert.rejects(() => staging.promoteToNovel(created.importId, { title: '冲突', dir: conflictTarget }), (error) => error?.code === 'resource_name_conflict');
    assert.deepEqual(await novels.listNovels(), registryBefore, 'target conflict cannot mutate the registry');

    const cancelledTarget = path.join(root, 'cancelled-target');
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    await assert.rejects(() => staging.promoteToNovel(created.importId, { title: '取消', dir: cancelledTarget, abortSignal: controller.signal }), (error) => error?.code === 'cancelled');
    assert.equal(fs.existsSync(cancelledTarget), false);
    assert.deepEqual(await novels.listNovels(), registryBefore, 'cancelled promotion cannot register a project');

    const targetDir = path.join(root, 'merge-target');
    const target = await novels.createNovel({ title: '合并目标', dir: targetDir });
    await novelData.writeWorld(targetDir, { lore: '目标旧世界观', places: [] });
    const mergeStaging = await staging.createStagingProject({
      sourceFiles: [], chapters: [{ title: '章', content: '内容' }], metadata: { title: '合并源' }, targetNovelId: target.id,
    });
    await fsp.writeFile(path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', mergeStaging.importId, 'world', 'lore.md'), '导入新世界观', 'utf8');
    const session = await merge.createMergeSession(path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', mergeStaging.importId), target.id, targetDir);
    const beforeLore = (await novelData.readWorld(targetDir)).lore;
    await assert.rejects(() => merge.finalizeMerge(session.sessionId), (error) => error?.code === 'unresolved_conflicts');
    assert.equal((await novelData.readWorld(targetDir)).lore, beforeLore, 'unresolved merge cannot write any target resource');
    assert.equal((await staging.getStagingProject(mergeStaging.importId)).novelMeta.importMeta.status, 'active');

    for (const item of session.items) merge.resolveConflict(session.sessionId, item.id, 'left');
    const receipt = await merge.finalizeMerge(session.sessionId);
    assert.ok(receipt.written >= 1);
    assert.equal((await novelData.readWorld(targetDir)).lore, '导入新世界观');
    assert.equal((await staging.getStagingProject(mergeStaging.importId)).novelMeta.importMeta.status, 'merged');

    await novelData.writeCharacter(targetDir, { id: 'rollback-char', name: '回滚角色', personality: '旧值' });
    const failingStaging = await staging.createStagingProject({
      sourceFiles: [], chapters: [{ title: '章', content: '内容' }], metadata: { title: '失败合并源' }, targetNovelId: target.id,
    });
    const failingRoot = path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', failingStaging.importId);
    await fsp.mkdir(path.join(failingRoot, 'characters'), { recursive: true });
    await fsp.writeFile(path.join(failingRoot, 'characters', 'rollback-char.json'), JSON.stringify({ id: 'rollback-char', name: '回滚角色', personality: '新值' }), 'utf8');
    await fsp.writeFile(path.join(failingRoot, 'world', 'lore.md'), '不应落盘的世界观', 'utf8');
    const failingSession = await merge.createMergeSession(failingRoot, target.id, targetDir);
    for (const item of failingSession.items) merge.resolveConflict(failingSession.sessionId, item.id, 'left');
    const characterFile = path.join(targetDir, 'characters', 'rollback-char.json');
    const characterBefore = await fsp.readFile(characterFile, 'utf8');
    // chmod is not a reliable failure injector for privileged test runners.
    const writeFile = fsp.writeFile;
    let injected = false;
    fsp.writeFile = async (to, ...args) => {
      if (!injected && path.resolve(to) === path.join(targetDir, 'world', 'lore.md')) {
        injected = true;
        throw Object.assign(new Error('simulated world write denied'), { code: 'EACCES' });
      }
      return writeFile(to, ...args);
    };
    try {
      await assert.rejects(() => merge.finalizeMerge(failingSession.sessionId), (error) => ['EACCES', 'EPERM', 'EROFS'].includes(error?.code));
    } finally {
      fsp.writeFile = writeFile;
    }
    assert.equal(await fsp.readFile(characterFile, 'utf8'), characterBefore, 'a later merge write failure rolls back earlier resources');
    assert.equal((await staging.getStagingProject(failingStaging.importId)).novelMeta.importMeta.status, 'active', 'failed merge cannot mark staging as merged');
    console.log('TEST_PASS import-atomic-boundary-regression');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT; else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(`TEST_FAIL import-atomic-boundary-regression: ${error.stack || error}`); process.exitCode = 1; });
module.exports = { run };
