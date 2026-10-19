'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const merge = require('../src/main/import/mergeEngine');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-import-many-conflicts-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const createdStaging = await require('../src/main/import/stagingProject').createStagingProject({ chapters: [], metadata: { title: '兼容入口测试' } });
    const staging = path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', createdStaging.importId);
    const targetNovel = await require('../src/main/store/novels').createNovel({ dir: path.join(root, 'novel'), title: '目标' });
    const novel = targetNovel.dir;
    fs.mkdirSync(path.join(staging, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(novel, 'characters'), { recursive: true });
    for (let index = 0; index < 501; index += 1) {
      const file = `character-${String(index).padStart(3, '0')}.json`;
      const id = `character-${String(index).padStart(3, '0')}`;
      fs.writeFileSync(path.join(staging, 'characters', file), JSON.stringify({ id, name: `角色 ${index}`, background: `导入版本 ${index} IMPORT_${index}_END` }), 'utf8');
      fs.writeFileSync(path.join(novel, 'characters', file), JSON.stringify({ id, name: `角色 ${index}`, background: `目标版本 ${index}` }), 'utf8');
    }
    const session = await merge.createMergeSession(staging, targetNovel.id, novel);
    assert.equal(session.items.length, 501);
    assert.equal(new Set(session.items.map((item) => item.id)).size, 501);
    assert.equal(session.items.every((item) => item.type === 'character' && item.status === 'pending'), true);
    assert.equal(session.items.some((item) => item.label === '角色 0'), true);
    assert.equal(session.items.some((item) => item.label === '角色 250'), true);
    assert.equal(session.items.some((item) => item.label === '角色 500'), true);
    assert.deepEqual(await merge.getMergeSummary(session.sessionId), { total: 501, resolved: 0, disputed: 0, pending: 501 });
    console.log('IMPORT-B06 passed: a 501-conflict merge session retains every target/staging resource and complete conflict accounting.');
  } finally {
    if (previousRoot === undefined) delete process.env.MANA_USER_DATA_ROOT; else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
