'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFakeResponsesServer, requestInputText } = require('./fixtures/fake-responses-server');

async function run() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-native-mutation-loop-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'user-data');
  const initial = '她感到一种难以言喻的疲惫。';
  const revised = '她很疲惫。';
  const chapterName = 'chapter-001.md';
  const fake = await createFakeResponsesServer({ respond(body, requests) {
    const wire = requestInputText(body.input);
    if (requests.length > 12) return { text: '工具循环超过测试上限。' };
    if (wire.includes('custom_tool_call_output')) return { text: '改写已确认并写入。' };
    if (wire.includes('score') && wire.includes('violations')) return { customToolName: 'apply_patch', input: `*** Begin Patch\n*** Update File: chapters/${chapterName}\n@@\n-${initial}\n+${revised}\n*** End Patch` };
    if (wire.includes('detectorVersion') || wire.includes('candidates')) return { namespace: 'mcp__novel_tools', toolName: 'check_de_ai_minimality', arguments: { original: initial, candidate: revised, guidance: '只删除套话' } };
    return { namespace: 'mcp__novel_tools', toolName: 'scan_de_ai_patterns', arguments: { resourceRef: `chapter:${chapterName}` } };
  } });
  const serviceModule = require('../src/main/codex-runtime');
  const service = serviceModule.getCodexSessionService();
  try {
    const modelConfig = require('../src/main/modelConfig');
    const novels = require('../src/main/store/novels');
    const novelData = require('../src/main/store/novelData');
    const chatHistory = require('../src/main/store/chatHistory');
    const novel = await novels.createNovel({ title: '原生写入循环', dir: path.join(tmp, 'novel') });
    await novelData.writeChapterWithMeta(novel.dir, chapterName, initial, {}, { baseContent: '' });
    await modelConfig.saveCredential({ id: 'fixture-key', name: 'Fixture Key', apiKey: 'fixture-secret' });
    await modelConfig.saveConnection({ id: 'fixture', name: 'Fixture', credentialId: 'fixture-key', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash fixture', verification: { responses: 'ok', tools: 'ok' } }] });
    await modelConfig.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: null });
    const thread = await chatHistory.createThread({ title: '去 AI 味', novelId: novel.id });
    const user = { id: 'user-1', role: 'user', text: '去 AI 味：对当前章节做最小改写', timestamp: Date.now() };
    await chatHistory.appendMessage(thread.id, user);
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native mutation loop timed out')), 60_000);
      service.on('event', function onEvent(event) {
        if (event.type === 'confirmation_requested') service.resolveConfirmation({ confirmationId: event.confirmationId, accept: true });
        if (!['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
        clearTimeout(timer); service.off('event', onEvent);
        event.type === 'turn_completed' ? resolve(event) : reject(new Error(event.error || event.type));
      });
    });
    await service.startTurn({ runId: 'mutation-loop', conversationId: thread.id, persistence: 'chat', novelId: novel.id, userMessageId: user.id, text: user.text, skillName: 'mana-de-ai', editorContext: { resourceRef: `chapter:${chapterName}` } });
    await terminal;
    if (await novelData.readChapter(novel.dir, chapterName) !== `${revised}\n`) {
      console.error(fake.requests.map((request, index) => ({
        index: index + 1,
        previousResponseId: request.body.previous_response_id || null,
        inputTypes: (request.body.input || []).map((item) => item?.type),
        text: requestInputText(request.body.input, 600).slice(-600),
      })));
    }
    assert.equal(await novelData.readChapter(novel.dir, chapterName), `${revised}\n`);
    assert.equal(fake.requests.length >= 4, true);
    console.log('codex-native-mutation-loop: ok');
  } finally {
    await serviceModule.disposeCodexSessionService();
    await fake.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
