'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createFakeResponsesServer, requestInputText } = require('../test/fixtures/fake-responses-server');

const ROOT = path.resolve(__dirname, '..');
const userDataRoot = path.join(ROOT, 'tmp-test-codex-native-ui');
const chapterName = 'chapter-001.md';
const initial = '她感到一种难以言喻的疲惫。';
const revised = '她很疲惫。';
const continuousScenes = [
  { fileName: 'chapter-002.md', content: '# 第二章 雨门\n\n雨声停在门外。林澈推开门，确认灯下的人已经等他很久。' },
  { fileName: 'chapter-003.md', content: '# 第三章 回声\n\n长廊尽头压着一封旧信。林澈没有拆开，只把钥匙放到信旁，身后的脚步也在此刻停住。' },
  { fileName: 'chapter-004.md', content: '# 第四章 天亮\n\n晨光越过窗棂。林澈合上册子，替空屋熄灯，随后走进刚刚醒来的街市。' },
];

function addChapterPatch(scene) {
  return `*** Begin Patch\n*** Add File: chapters/${scene.fileName}\n${scene.content.split('\n').map((line) => `+${line}`).join('\n')}\n*** End Patch`;
}

function electronBinary() {
  if (process.platform === 'darwin') return path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules/electron/dist/electron.exe');
  return path.join(ROOT, 'node_modules/electron/dist/electron');
}
function launch(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(), ['.', '--test-codex-native-ui', '--mute-audio'], { cwd: ROOT, env: { ...process.env, ...env, MANA_DISABLE_AUDIO: '1', ELECTRON_RUN_AS_NODE: undefined }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Codex native UI phase failed with exit ${code}`)));
  });
}

async function run() {
  await fsp.rm(userDataRoot, { recursive: true, force: true });
  process.env.MANA_USER_DATA_ROOT = userDataRoot;
  let patchCalls = 0;
  let continuousActive = false;
  let continuousDone = false;
  let continuousPatchIndex = 0;
  const fake = await createFakeResponsesServer({
    respond(body) {
      const inputs = Array.isArray(body.input) ? body.input : [];
      const commands = ['连续创作三个完整场景', '重启后继续刚才的对话', '拒绝测试：', '去 AI 味：', '普通问答：', '乙项目问答', '缓慢回答停止测试', '资料页世界观修改', '世界观脏稿冲突', '保存后停止', '重写选中文本', '在光标处续写小说正文', '人物卡修改'];
      commands.push('人物卡更新');
      const lastUser = inputs.findLastIndex(item => item.role === 'user' && commands.some(command => JSON.stringify(item.content).includes(command)));
      const wire = requestInputText(lastUser >= 0 ? inputs.slice(lastUser) : inputs, 50000);
      if (wire.includes('人物卡更新')) return wire.includes('custom_tool_call_output') ? { text: '已有人物卡更新完成。' }
        : { customToolName: 'apply_patch', input: '*** Begin Patch\n*** Update File: characters/qa-person.json\n@@\n-  "personality": "谨慎",\n+  "personality": "果断",\n*** End Patch' };
      if (wire.includes('人物卡修改')) return wire.includes('custom_tool_call_output') ? { text: '人物卡已保存。' }
        : { customToolName: 'apply_patch', input: '*** Begin Patch\n*** Add File: characters/qa-person.json\n+{"id":"qa-person","name":"验收角色","personality":"谨慎"}\n*** End Patch' };
      if (wire.includes('重写选中文本') || wire.includes('在光标处续写小说正文')) {
        if (wire.includes('custom_tool_call_output')) return { text: '明确范围编辑完成。' };
        const insert = wire.includes('在光标处续写小说正文');
        return { customToolName: 'apply_patch', input: `*** Begin Patch\n*** Update File: chapters/chapter-006.md\n@@\n-${insert ? '甲丁丙。' : '甲乙丙。'}\n+${insert ? '甲丁新增丙。' : '甲丁丙。'}\n*** End Patch` };
      }
      if (wire.includes('保存后停止')) return wire.includes('custom_tool_call_output')
        ? { text: '第一处已保存，正在继续第二处。', delayAfterDeltaMs: 8000 }
        : { customToolName: 'apply_patch', input: addChapterPatch({ fileName: 'chapter-005.md', content: '已经正式保存的第一处。' }) };
      if (wire.includes('资料页世界观修改') || wire.includes('世界观脏稿冲突')) {
        if (wire.includes('custom_tool_call_output')) return { text: '世界观修改已完成。' };
        const dirty = wire.includes('世界观脏稿冲突');
        return { customToolName: 'apply_patch', input: `*** Begin Patch\n*** Update File: world/lore.md\n@@\n-${dirty ? '群山城邦。' : '沿海城邦。'}\n+${dirty ? '沙漠城邦。' : '群山城邦。'}\n*** End Patch` };
      }
      if (wire.includes('乙项目问答')) return { text: '乙项目独立回答。' };
      if (wire.includes('缓慢回答停止测试')) return { text: '停止后应保留这段已显示文字。', delayAfterDeltaMs: 8000 };
      if (!continuousDone && wire.includes('连续创作三个完整场景')) continuousActive = true;
      if (continuousActive && continuousPatchIndex < continuousScenes.length) {
        const scene = continuousScenes[continuousPatchIndex];
        continuousPatchIndex += 1;
        return { customToolName: 'apply_patch', input: addChapterPatch(scene) };
      }
      if (continuousActive) {
        continuousActive = false;
        continuousDone = true;
        return { text: '三个完整场景均已在同一回合中逐章保存。' };
      }
      if (wire.includes('重启后继续刚才的对话')) return { text: '重启后已从原生 thread 继续对话。' };
      if (wire.includes('拒绝测试：提议再次覆盖当前章节') && patchCalls < 2) {
        patchCalls += 1;
        return { customToolName: 'apply_patch', input: `*** Begin Patch\n*** Update File: chapters/${chapterName}\n@@\n-${revised}\n+她转身离开。\n*** End Patch` };
      }
      if (wire.includes('custom_tool_call_output')) return { text: patchCalls > 1 ? '写入已取消，正文保持不变。' : '改写已确认并写入。' };
      if (wire.includes('score') && wire.includes('violations')) {
        patchCalls += 1;
        return { customToolName: 'apply_patch', input: `*** Begin Patch\n*** Update File: chapters/${chapterName}\n@@\n-${initial}\n+${revised}\n*** End Patch` };
      }
      if (wire.includes('detectorVersion') || wire.includes('candidates')) return { namespace: 'mcp__novel_tools', toolName: 'check_de_ai_minimality', arguments: { original: initial, candidate: revised, guidance: '只删除套话' } };
      if (wire.includes('去 AI 味：对当前章节做最小改写')) return { namespace: 'mcp__novel_tools', toolName: 'scan_de_ai_patterns', arguments: { resourceRef: `chapter:${chapterName}` } };
      if (wire.includes('普通问答：说明当前执行链')) return { text: '原生 Codex 问答已完成。' };
      return { text: '原生 Codex 测试完成。' };
    },
  });
  try {
    const modelConfig = require('../src/main/modelConfig');
    const appConfig = require('../src/main/store/appConfig');
    const novels = require('../src/main/store/novels');
    const novelData = require('../src/main/store/novelData');
    const novel = await novels.createNovel({ title: 'Codex 原生验收', dir: path.join(userDataRoot, 'qa-novel') });
    await novelData.writeChapterWithMeta(novel.dir, chapterName, initial, {}, { baseContent: '' });
    await novelData.writeChapterWithMeta(novel.dir, 'chapter-006.md', '甲乙丙。\n', {}, { baseContent: '' });
    await novelData.writeWorld(novel.dir, { lore: '沿海城邦。\n' });
    await appConfig.save({ lastNovelId: novel.id, lastNovelDir: novel.dir });
    await modelConfig.saveCredential({ id: 'fixture-key', name: 'Fixture Key', apiKey: 'fixture-secret' });
    await modelConfig.saveConnection({ id: 'fixture', name: 'QA Responses', credentialId: 'fixture-key', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash fixture', verification: { responses: 'ok', tools: 'ok' } }] });
    await modelConfig.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: null });
    const secondNovel = await novels.createNovel({ title: '链路隔离乙', dir: path.join(userDataRoot, 'qa-novel-b') });
    const common = { MANA_USER_DATA_ROOT: userDataRoot, MANA_UI_NOVEL_ID: novel.id, MANA_UI_SECOND_NOVEL_ID: secondNovel.id, MANA_UI_CHAPTER_NAME: chapterName, MANA_AUTOMATED_TEST: '1', NODE_ENV: 'production' };
    await launch({ ...common, MANA_CODEX_UI_PHASE: '1' });
    console.log('codex-native-ui-e2e: phase 1 complete');
    await launch({ ...common, MANA_CODEX_UI_PHASE: '2' });
    console.log('codex-native-ui-e2e: phase 2 complete');
    if (fake.requests.length < 4) throw new Error(`Expected multiple Responses tool-loop calls, got ${fake.requests.length}`);
    console.log('codex-native-ui-e2e: ok');
  } finally { await fake.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
