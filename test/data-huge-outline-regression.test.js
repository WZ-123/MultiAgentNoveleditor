'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-data-huge-outline-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  try {
    const novels = require('../src/main/store/novels');
    const data = require('../src/main/store/novelData');
    const novel = await novels.createNovel({ title: '大纲边界小说', dir: path.join(root, 'novel') });
    const nodes = Array.from({ length: 601 }, (_, index) => ({
      id: `node-${String(index).padStart(3, '0')}`,
      level: index % 15 === 0 ? 1 : (index % 3) + 1,
      title: `节点 ${index}`,
      summary: `第 ${index} 个情节节点，包含完整边界标记 OUTLINE_${index}_END。`,
      characters: [`角色-${index % 17}`],
    }));
    await data.writeOutlineNodes(novel.dir, nodes);
    const restored = await data.readOutlineNodes(novel.dir);
    assert.equal(restored.nodes.length, 601);
    assert.deepEqual(restored.nodes[0], nodes[0]);
    assert.deepEqual(restored.nodes[300], nodes[300]);
    assert.deepEqual(restored.nodes[600], nodes[600]);
    const readable = fs.readFileSync(path.join(novel.dir, 'outlines', 'main.md'), 'utf8');
    assert.equal(readable.includes('OUTLINE_600_END'), true);
    console.log('DATA-B08 passed: 601 outline nodes persist, reload, and remain represented in readable outline output without truncation.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
