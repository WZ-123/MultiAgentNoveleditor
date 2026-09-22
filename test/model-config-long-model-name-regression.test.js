'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-model-name-boundary-'));
  const previousRoot = process.env.MANA_USER_DATA_ROOT;
  process.env.MANA_USER_DATA_ROOT = root;
  try {
    const modelConfig = require('../src/main/modelConfig');
    const longName = `长模型-${'名'.repeat(8192)}-尾标记`;
    let snapshot = await modelConfig.publicSnapshot();
    await modelConfig.saveProvider({
      id: 'long-name-provider',
      name: '长名称 Provider',
      adapterId: 'openai-chat-completions',
      baseUrl: 'https://models.invalid/v1',
      models: [{ id: 'long-name-model', name: longName, capabilities: { contextWindow: 128000, maxOutputTokens: 4096 } }],
    }, snapshot.revision);
    snapshot = await modelConfig.publicSnapshot();
    const model = snapshot.providers.find((provider) => provider.id === 'long-name-provider')?.models?.[0];
    assert.equal(model?.name, longName, 'long model name must round-trip without truncation or corruption');
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'model-config.json'), 'utf8'));
    assert.equal(disk.providers.find((provider) => provider.id === 'long-name-provider')?.models?.[0]?.name, longName);
    console.log(`CONFIG-B04 passed: ${longName.length}-character model name survives save, public snapshot, and disk readback.`);
  } finally {
    if (previousRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
