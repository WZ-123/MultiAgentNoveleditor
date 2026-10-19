'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const merge = require('../src/main/import/mergeEngine');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-import-merge-reset-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const createdStaging = await require('../src/main/import/stagingProject').createStagingProject({ chapters: [], metadata: { title: '兼容入口测试' } });
    const staging = path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', createdStaging.importId);
    const targetNovel = await require('../src/main/store/novels').createNovel({ dir: path.join(root, 'novel'), title: '目标' });
    const novel = targetNovel.dir;
    fs.mkdirSync(path.join(staging, 'world'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'style'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'outlines'), { recursive: true });
    fs.mkdirSync(path.join(novel, 'world'), { recursive: true });
    fs.mkdirSync(path.join(novel, 'style'), { recursive: true });
    fs.mkdirSync(path.join(novel, 'outlines'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'world', 'lore.md'), '导入 lore', 'utf8');
    fs.writeFileSync(path.join(staging, 'style', 'memory.md'), '导入文风', 'utf8');
    fs.writeFileSync(path.join(novel, 'world', 'lore.md'), '原小说 lore', 'utf8');
    fs.writeFileSync(path.join(novel, 'style', 'memory.md'), '原小说文风', 'utf8');

    const created = await merge.createMergeSession(staging, targetNovel.id, novel);
    assert.ok(created.items.length >= 2);
    const target = created.items[0];
    await merge.resolveConflict(created.sessionId, target.id, 'left', { userNote: '先采用导入版本' });
    assert.equal((await merge.getMergeSummary(created.sessionId)).resolved, 1);
    await merge.resetAll(created.sessionId);
    const reset = await merge.getMergeSession(created.sessionId);
    assert.ok(reset.items.every((item) => item.resolution === null && item.resolvedContent === null && item.userNote === '' && item.status === 'pending'));
    assert.deepEqual(await merge.getMergeSummary(created.sessionId), { total: created.items.length, resolved: 0, disputed: 0, pending: created.items.length });
    assert.equal(fs.readFileSync(path.join(novel, 'world', 'lore.md'), 'utf8'), '原小说 lore');
    console.log('IMPORT-T10 passed: resetAll clears all resolutions and leaves the target novel unchanged before finalization.');
  } finally {
    if (previousRoot === undefined) delete process.env.MANA_USER_DATA_ROOT; else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
