'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFakeResponsesServer } = require('./fixtures/fake-responses-server');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-existing-resource-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'data');
  let patch = '';
  let sent = false;
  const fake = await createFakeResponsesServer({ respond() {
    if (sent) return { text: '本次修改结束。' };
    sent = true;
    return { customToolName: 'apply_patch', input: patch };
  } });
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  const data = require('../src/main/store/novelData');
  const model = require('../src/main/modelConfig');
  const novel = await require('../src/main/store/novels').createNovel({ title: '已有资源更新', dir: path.join(root, 'novel') });
  const thread = await require('../src/main/store/chatHistory').createThread({ title: '普通资料修改', novelId: novel.id });
  try {
    await data.writeCharacter(novel.dir, { id: 'fixture', name: '测试角色', role: '旧职务', personality: '谨慎' });
    await data.writeWorld(novel.dir, { lore: '原世界观' });
    await model.saveCredential({ id: 'fixture', apiKey: 'test-secret' });
    await model.saveConnection({ id: 'fixture', name: 'Fixture', credentialId: 'fixture', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'Fixture', verification: { responses: 'ok', tools: 'ok' } }] });
    await model.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: null });
    async function edit(runId, file, before, after) {
      sent = false;
      patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`;
      let timer;
      let listener;
      const terminal = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('update timed out')), 60000);
        listener = event => {
          if (event.runId !== runId) return;
          if (event.type === 'confirmation_requested') service.resolveConfirmation({ runId, confirmationId: event.confirmationId, accept: true }).catch(reject);
          if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) resolve(event);
        };
        service.on('event', listener);
      });
      try {
        await service.startTurn({ runId, novelId: novel.id, conversationId: thread.id, text: '请修改已有资料。' });
        const event = await terminal;
        assert.equal(event.type, 'turn_completed', event.error);
        const state = await service.getRunState({ runId });
        assert.equal(state.savedResources.length, 1);
      } finally { clearTimeout(timer); service.off('event', listener); }
    }
    await edit('character-first', 'characters/fixture.json', '  "role": "旧职务",', '  "role": "新职务",');
    assert.equal((await data.readCharacter(novel.dir, 'fixture')).role, '新职务');
    await edit('character-second', 'characters/fixture.json', '  "personality": "谨慎",', '  "personality": "果断",');
    assert.equal((await data.readCharacter(novel.dir, 'fixture')).personality, '果断');
    await edit('world', 'world/lore.md', '原世界观', '新世界观');
    assert.equal((await data.readWorld(novel.dir)).lore, '新世界观\n');
    console.log('native-existing-resource-update: ok');
  } finally { await service.dispose(); await fake.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
