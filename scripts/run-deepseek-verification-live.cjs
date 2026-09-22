'use strict';
// Opt-in integration check: reuses a local credential, never prints or copies it
// outside private isolated test storage; does not activate or mutate user projects.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const source = process.env.MANA_DEEPSEEK_KEY_SOURCE_ROOT || path.join(os.homedir(), 'Library/Application Support/MultiAgentNovelAssistant-dev/MultiAgentNovelAssistant');
  const config = JSON.parse(await fs.readFile(path.join(source, 'model-config.json'), 'utf8'));
  const connection = config.connections.find((c) => c.templateId === 'deepseek');
  const credential = config.credentials.find((c) => c.id === connection?.credentialId);
  const secrets = JSON.parse(await fs.readFile(path.join(source, 'secrets.json'), 'utf8'));
  const record = secrets.records[credential?.secretRef];
  if (!record?.plain || !record.value) throw new Error('No readable DeepSeek credential');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-deepseek-verification-'));
  process.env.MANA_USER_DATA_ROOT = root;
  const models = require('../src/main/modelConfig');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  try {
    await models.saveCredential({ id: 'test-key', name: 'Isolated live test', apiKey: record.value });
    await models.saveConnection({ ...connection, id: 'test', credentialId: 'test-key', models: connection.models.map((m) => ({ ...m, verification: {} })) });
    for (const modelId of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      for (const mode of ['responses', 'tools']) {
        const start = Date.now();
        await service.verifyModel({ connectionId: 'test', modelId, mode, reasoningEffort: 'max' });
        console.log(JSON.stringify({ modelId, mode, effort: 'max', ok: true, elapsedMs: Date.now() - start }));
      }
    }
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
