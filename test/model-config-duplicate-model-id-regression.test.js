'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-duplicate-model-id-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = root;
  try {
    const modelConfig = require('../src/main/modelConfig');
    const initial = await modelConfig.publicSnapshot();
    await assert.rejects(
      () => modelConfig.saveProvider({
        id: 'duplicate-model-provider', name: '重复模型 Provider', adapterId: 'openai-chat-completions', baseUrl: 'https://models.invalid/v1',
        models: [{ id: 'same-model', name: '第一个' }, { id: 'same-model', name: '第二个' }],
      }, initial.revision),
      /模型 ID 无效或重复/u,
    );
    const after = await modelConfig.publicSnapshot();
    assert.equal(after.revision, initial.revision, 'rejected duplicate must not create a partial revision');
    assert.equal(after.providers.some((provider) => provider.id === 'duplicate-model-provider'), false);
    console.log('CONFIG-B05 passed: duplicate model IDs are rejected before config mutation.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
