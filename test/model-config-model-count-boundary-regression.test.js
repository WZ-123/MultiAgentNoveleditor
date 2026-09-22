'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-model-count-boundary-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = root;
  try {
    const modelConfig = require('../src/main/modelConfig');
    let snapshot = await modelConfig.publicSnapshot();
    await modelConfig.saveProvider({
      id: 'empty-model-provider', name: '零模型 Provider', adapterId: 'openai-chat-completions', baseUrl: 'https://empty.invalid/v1', models: [],
    }, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    assert.deepEqual(snapshot.providers.find((provider) => provider.id === 'empty-model-provider')?.models, []);

    const models = Array.from({ length: 500 }, (_, index) => ({
      id: `model-${String(index).padStart(3, '0')}`,
      name: `规模测试模型 ${index}`,
      capabilities: { contextWindow: 128000 + index, maxOutputTokens: 4096 },
    }));
    await modelConfig.saveProvider({
      id: 'many-model-provider', name: '五百模型 Provider', adapterId: 'openai-chat-completions', baseUrl: 'https://many.invalid/v1', models,
    }, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    const stored = snapshot.providers.find((provider) => provider.id === 'many-model-provider')?.models || [];
    const sample = [0, 249, 499].map((index) => stored[index]);
    assert.equal(stored.length, 500);
    assert.deepEqual(sample.map((model) => model.id), ['model-000', 'model-249', 'model-499']);
    assert.deepEqual(sample.map((model) => model.capabilities.contextWindow), [128000, 128249, 128499]);
    console.log('CONFIG-B01 passed: zero and 500-model providers save and public-snapshot round-trip without loss or reordering.');
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
