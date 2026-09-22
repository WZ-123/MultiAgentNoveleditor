'use strict';
// Small, isolated check using an existing model configuration. Never edits its source.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const source = process.env.MANA_LIVE_CONFIG_ROOT || path.resolve(__dirname, '../artifacts/deepseek-live-acceptance/provider-user-data');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-chat-live-'));
  for (const name of ['model-config.json', 'secrets.json']) await fs.copyFile(path.join(source, name), path.join(root, name));
  await fs.chmod(path.join(root, 'secrets.json'), 0o600);
  process.env.MANA_USER_DATA_ROOT = root;
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const novels = require('../src/main/store/novels');
  const data = require('../src/main/store/novelData');
  const history = require('../src/main/store/chatHistory');
  const service = new CodexSessionService();
  const receipt = { checkedAt: new Date().toISOString(), cases: [] };
  try {
    const route = await require('../src/main/modelConfig').activeRoute();
    receipt.model = route.model.id;
    const novel = await novels.createNovel({ title: '聊天链路真实模型隔离验收', dir: path.join(root, 'novel') });
    await data.writeChapterWithMeta(novel.dir, 'chapter-001.md', '窗外正在下雨。\n', {}, { baseContent: '' });
    const thread = await history.createThread({ title: '读取和受控修改', novelId: novel.id });
    async function turn(name, text, accept) {
      let approvals = 0;
      const runId = `live-${name}`;
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { service.off('event', listener); reject(new Error(`${name}: timeout`)); }, 180000);
        const listener = event => {
          if (event.runId !== runId) return;
          if (event.type === 'confirmation_requested') {
            approvals++;
            service.resolveConfirmation({ runId, confirmationId: event.confirmationId, accept: !!accept }).catch(reject);
          }
          if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) {
            clearTimeout(timer); service.off('event', listener); resolve(event);
          }
        };
        service.on('event', listener);
      });
      await service.startTurn({ runId, conversationId: thread.id, novelId: novel.id, text });
      const event = await terminal;
      const state = await service.getRunState({ runId });
      receipt.cases.push({ name, status: state.status, approvals, savedResources: state.savedResources.map(r => r.resourceRef), toolTypes: state.items.map(i => i.name || i.type) });
      assert.equal(event.type, 'turn_completed', state.error || name);
      return { state, approvals };
    }
    if (process.env.MANA_LIVE_CHARACTER_ONLY === '1') {
      await data.writeCharacter(novel.dir, { id: 'live-character', name: '测试人物', role: '旧职务', personality: '谨慎' });
      const read = await turn('character-read', '请用项目读取工具读取 character:live-character，告诉我 role 和 personality。不要修改。', false);
      assert.match(read.state.text, /谨慎/u);
      assert.ok(read.state.items.some(i => /mcp|tool/iu.test(i.type || '') || i.name));
      const accepted = await turn('character-update', '请实际用 apply_patch 把 character:live-character 的 role 从“旧职务”改成“新职务”，personality 从“谨慎”改成“果断”，其余字段不变。等待我确认。', true);
      assert.ok(accepted.approvals > 0);
      assert.ok(accepted.state.savedResources.some(r => r.resourceRef === 'character:live-character'));
      const saved = await data.readCharacter(novel.dir, 'live-character');
      assert.equal(saved.role, '新职务'); assert.equal(saved.personality, '果断');
      const declined = await turn('character-reject', '请实际发起补丁，把 character:live-character 的 personality 改成“犹豫”。如果我拒绝，不要重试。', false);
      assert.ok(declined.approvals > 0);
      assert.equal(declined.state.savedResources.length, 0);
      assert.equal((await data.readCharacter(novel.dir, 'live-character')).personality, '果断');
    } else {
      const read = await turn('read', '请用项目读取工具读取 chapter:chapter-001.md，告诉我正文。不要修改文件。', false);
      assert.match(read.state.text, /下雨/u);
      assert.ok(read.state.items.some(i => /mcp|tool/iu.test(i.type || '') || i.name), 'must have actual read evidence');
      const accepted = await turn('accept', '请把 chapter:chapter-001.md 中的“窗外正在下雨。”改成“窗外雨停了。”，只改这句话。请实际用 apply_patch 修改，等待我确认。', true);
      assert.ok(accepted.approvals > 0);
      assert.ok(accepted.state.savedResources.length > 0);
      assert.equal(await data.readChapter(novel.dir, 'chapter-001.md'), '窗外雨停了。\n');
      const declined = await turn('reject', '请把 chapter:chapter-001.md 中的“窗外雨停了。”改成“窗外下起大雪。”，请实际发起修改批准；如果我拒绝，不要重试。', false);
      assert.ok(declined.approvals > 0);
      assert.equal(declined.state.savedResources.length, 0);
      assert.equal(await data.readChapter(novel.dir, 'chapter-001.md'), '窗外雨停了。\n');
    }
    receipt.passed = true;
  } catch (error) { receipt.passed = false; receipt.error = error.message; process.exitCode = 1; }
  finally {
    await service.dispose();
    const receiptName = process.env.MANA_LIVE_CHARACTER_ONLY === '1' ? 'character-update-live-results.json' : 'live-results.json';
    await fs.writeFile(path.resolve(__dirname, '../artifacts/chat-chain-audit', receiptName), JSON.stringify(receipt, null, 2) + '\n');
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(receipt));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
