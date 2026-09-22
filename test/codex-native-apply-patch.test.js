'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFakeResponsesServer, requestInputText } = require('./fixtures/fake-responses-server');

async function waitEvent(service, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { service.off('event', listener); reject(new Error('event timeout')); }, timeoutMs);
    const listener = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      service.off('event', listener);
      resolve(event);
    };
    service.on('event', listener);
  });
}

async function run(modelId) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-native-patch-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'user-data');
  const patch = '*** Begin Patch\n*** Update File: chapters/chapter-001.md\n@@\n-她停在门外。\n+她在门外停了一会。\n*** End Patch';
  const rejectedPatch = '*** Begin Patch\n*** Update File: chapters/chapter-001.md\n@@\n-她在门外停了一会。\n+她转身离开。\n*** End Patch';
  const fake = await createFakeResponsesServer({
    respond(body) {
      const wire = requestInputText(body.input);
      if (wire.includes('创建缺失章节')) {
        if (wire.includes('custom_tool_call_output')) return { text: '缺失章节已创建。' };
        if (wire.includes('function_call_output')) return { customToolName: 'apply_patch', input: '*** Begin Patch\n*** Add File: chapters/chapter-missing.md\n+新章节正文。\n*** End Patch' };
        return { namespace: 'mcp__novel_tools', toolName: 'read_novel_resource', arguments: { resourceRef: 'chapter:chapter-missing.md', mode: 'metadata' } };
      }

      if (wire.includes('custom_tool_call_output')) return { text: '原生补丁已执行。' };
      return { customToolName: 'apply_patch', input: wire.includes('拒绝这次修改') ? rejectedPatch : patch };
    },
  });
  const modelConfig = require('../src/main/modelConfig');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const { CodexSessionService, validateNativeFileChanges } = require('../src/main/codex-runtime/codexSessionService');
  const novel = await novels.createNovel({ title: '原生补丁测试', dir: path.join(tmp, 'novel') });
  await novelData.writeChapterWithMeta(novel.dir, 'chapter-001.md', '她停在门外。', {}, { baseContent: '' });
  await modelConfig.saveCredential({ id: 'native-key', name: 'Native Key', apiKey: 'fixture-secret' });
  await modelConfig.saveConnection({ id: 'native', name: 'Native Responses', credentialId: 'native-key', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, discovery: { status: 'ok' }, models: [{ id: modelId, name: 'DeepSeek V4 Flash fixture', verification: { responses: 'ok', tools: 'ok' } }] });
  await modelConfig.setActive({ connectionId: 'native', modelId, reasoningEffort: null });
  const service = new CodexSessionService();
  try {
    const confirmationPromise = waitEvent(service, (event) => event.type === 'confirmation_requested');
    const terminalPromise = waitEvent(service, (event) => ['turn_completed', 'turn_failed'].includes(event.type));
    await service.startTurn({ runId: 'native-patch-run', persistence: 'one-shot', novelId: novel.id, text: '使用原生 apply_patch 修改第一章。', skillName: 'mana-fiction-writing' });
    const confirmation = await confirmationPromise;
    assert.equal(confirmation.tool, 'apply_patch');
    assert.match(JSON.stringify(confirmation.arguments.nativeChanges), /chapters[/\\]chapter-001\.md/u, 'native approval must expose the target path before acceptance');
    assert.throws(() => validateNativeFileChanges(path.join(tmp, 'workspace'), [{ path: path.join(tmp, 'outside.md'), kind: { type: 'update' } }]), /越出小说工作区/u);
    assert.throws(() => validateNativeFileChanges(path.join(tmp, 'workspace'), [{ path: path.join(tmp, 'workspace', 'unexpected.txt'), kind: { type: 'update' } }]), /未知小说文件/u);
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '她停在门外。', 'real novel must remain unchanged before native approval');
    await service.resolveConfirmation({ confirmationId: confirmation.confirmationId, accept: true });
    const terminal = await terminalPromise;
    assert.equal(terminal.type, 'turn_completed', terminal.error || 'native turn failed');
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '她在门外停了一会。\n');
    assert.equal(fake.requests[0].body.tools.some((tool) => tool.type === 'custom' && tool.name === 'exec'), false, 'DeepSeek must use native tools without a custom exec wrapper');
    assert.equal(fake.requests[0].body.tools.some((tool) => tool.type === 'custom' && tool.name === 'apply_patch'), true, 'Codex must expose its native apply_patch custom tool');
    assert.equal(JSON.stringify(fake.requests.at(-1).body.input).includes('custom_tool_call_output'), true, 'native apply_patch output must return through Responses');

    const rejectedConfirmationPromise = waitEvent(service, (event) => event.type === 'confirmation_requested' && event.runId === 'native-patch-reject');
    const rejectedTerminalPromise = waitEvent(service, (event) => ['turn_completed', 'turn_failed'].includes(event.type) && event.runId === 'native-patch-reject');
    await service.startTurn({ runId: 'native-patch-reject', persistence: 'one-shot', novelId: novel.id, text: '使用原生 apply_patch，但拒绝这次修改。', skillName: 'mana-fiction-writing' });
    const rejectedConfirmation = await rejectedConfirmationPromise;
    await service.resolveConfirmation({ confirmationId: rejectedConfirmation.confirmationId, accept: false, reason: '测试拒绝' });
    await rejectedTerminalPromise;
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '她在门外停了一会。\n', 'declined native patch must not change the real novel');
    const missingConfirmation = waitEvent(service, (event) => event.type === 'confirmation_requested' && event.runId === 'missing-create');
    const missingTerminal = waitEvent(service, (event) => ['turn_completed', 'turn_failed'].includes(event.type) && event.runId === 'missing-create');
    await service.startTurn({ runId: 'missing-create', persistence: 'one-shot', novelId: novel.id, text: '读取并创建缺失章节', skillName: 'mana-fiction-writing' });
    const createConfirmation = await missingConfirmation;
    await service.resolveConfirmation({ confirmationId: createConfirmation.confirmationId, accept: true });
    const createResult = await missingTerminal;
    assert.equal(createResult.type, 'turn_completed', createResult.error);
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-missing.md'), '新章节正文。\n');
    assert.ok(JSON.stringify(fake.requests.at(-1).body.input).includes('resource_not_found'), 'model must receive a recoverable absence result before creating the resource');
    console.log(`codex-native-apply-patch: ok (${modelId})`);
  } finally {
    await service.dispose();
    await fake.close();
  }
}

(async () => { for (const modelId of ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro']) await run(modelId); })().catch((error) => { console.error(error); process.exitCode = 1; });
