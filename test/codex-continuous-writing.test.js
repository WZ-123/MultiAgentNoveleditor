'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFakeResponsesServer } = require('./fixtures/fake-responses-server');

function addChapterPatch(fileName, content) {
  return `*** Begin Patch\n*** Add File: chapters/${fileName}\n${content.split('\n').map((line) => `+${line}`).join('\n')}\n*** End Patch`;
}

async function waitForTerminal(service, runId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('event', listener);
      reject(new Error('continuous native writing timed out'));
    }, timeoutMs);
    const listener = (event) => {
      if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
      clearTimeout(timer);
      service.off('event', listener);
      event.type === 'turn_completed' ? resolve(event) : reject(new Error(event.error || event.type));
    };
    service.on('event', listener);
  });
}

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-continuous-writing-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  const scenes = [
    { fileName: 'chapter-001.md', content: '# 第一章 雨门\n\n雨脚越过石阶时，林澈才把伞收拢。门里的人没有催他，他听完最后一声钟，推门走进灯下。' },
    { fileName: 'chapter-002.md', content: '# 第二章 回声\n\n长廊比记忆里更窄。林澈沿着墙上的旧刻痕走到尽头，发现那封未寄出的信仍压在玻璃下。\n\n他没有拆信，只把带来的钥匙放在旁边。身后的脚步停住，两个人隔着一层倒影点了点头。' },
    { fileName: 'chapter-003.md', content: '# 第三章 天亮\n\n风从破窗吹进来，纸页一张张翻过。林澈守到天色发白，终于在末页看见自己的名字。\n\n他合上册子，替走廊熄了灯。院门外已有早市的叫卖声，他走出去，没有回头。' },
  ];
  const fake = await createFakeResponsesServer({
    respond(_body, requests) {
      const scene = scenes[requests.length - 1];
      return scene
        ? { customToolName: 'apply_patch', input: addChapterPatch(scene.fileName, scene.content) }
        : { text: '三个完整场景均已在同一回合中逐章保存。' };
    },
  });
  const modelConfig = require('../src/main/modelConfig');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const chatHistory = require('../src/main/store/chatHistory');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const { bodyChineseCharacterCount } = require('../src/main/mcp/novelResources');
  const service = new CodexSessionService();
  const checkpoint = service._checkpointRun.bind(service);
  service._checkpointRun = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 35));
    return checkpoint(...args);
  };
  try {
    const novel = await novels.createNovel({ title: '连续创作协议验收', dir: path.join(root, 'novel') });
    await modelConfig.saveCredential({ id: 'continuous-key', name: 'Continuous fixture', apiKey: 'fixture-secret' });
    await modelConfig.saveConnection({
      id: 'continuous', name: 'Continuous Responses fixture', credentialId: 'continuous-key', baseUrl: fake.origin,
      templateId: 'deepseek', auth: { mode: 'bearer' }, discovery: { status: 'ok' },
      models: [{ id: 'deepseek-v4-flash', name: 'Continuous fixture model', verification: { responses: 'ok', tools: 'ok' } }],
    });
    await modelConfig.setActive({ connectionId: 'continuous', modelId: 'deepseek-v4-flash', reasoningEffort: null });
    await service.setWritingAuthorization({ novelId: novel.id, mode: 'append-prose' });
    const thread = await chatHistory.createThread({ title: '连续写三章', novelId: novel.id });
    const userMessage = { id: 'continuous-user-1', role: 'user', text: '连续创作三个完整场景，每个场景自然收束后保存，并在同一回合继续。', timestamp: Date.now() };
    await chatHistory.appendMessage(thread.id, userMessage);

    const events = [];
    service.on('event', (event) => events.push(event));
    const runId = 'continuous-writing-run';
    const terminal = waitForTerminal(service, runId);
    await service.startTurn({
      runId, conversationId: thread.id, persistence: 'chat', novelId: novel.id, userMessageId: userMessage.id,
      text: userMessage.text, skillName: 'mana-fiction-writing', taskConstraints: { operation: 'write' },
    });
    const completed = await terminal;

    assert.equal(fake.requests.length, 4, 'one native turn must continue after each of three saves');
    assert.equal(events.filter((event) => event.type === 'confirmation_requested').length, 0, 'authorized new chapters should not pause for repeated approval');
    const committed = events.filter((event) => event.type === 'item_completed' && event.committedResources?.length);
    assert.equal(committed.length, 3, 'each complete scene must be committed and read back before the next one');
    assert.deepEqual(committed.map((event) => event.committedResources[0].resourceRef), scenes.map((scene) => `chapter:${scene.fileName}`));
    for (const scene of scenes) {
      assert.equal(await novelData.readChapter(novel.dir, scene.fileName), `${scene.content}\n`);
    }
    const expectedTotal = scenes.reduce((sum, scene) => sum + bodyChineseCharacterCount(`${scene.content}\n`), 0);
    const progress = await service.getWritingProgress({ novelId: novel.id, conversationId: thread.id });
    assert.equal(progress.totalSavedBodyCjk, expectedTotal);
    assert.equal(progress.runNetBodyCjk, expectedTotal);
    assert.equal(progress.currentResourceRef, 'chapter:chapter-003.md');
    assert.ok(progress.lastSavedAt);
    assert.equal(progress.phase, 'completed');
    assert.equal(completed.taskResult.goalVerified, true);
    assert.equal(chatHistory.getBranch(await chatHistory.getThread(thread.id)).filter((message) => message.role === 'user').length, 1, 'the host must not synthesize extra continue messages');
    console.log('codex-continuous-writing: ok');
  } finally {
    await service.dispose();
    await fake.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
