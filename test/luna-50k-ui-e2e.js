'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const novels = require('../src/main/store/novels');
const { getCodexSessionService } = require('../src/main/codex-runtime');
const { bodyChineseCharacterCount, listResourceDescriptors, proseRepetitionEvidence, readResource } = require('../src/main/mcp/novelResources');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runLunaFiftyKUiE2E(mainWindow) {
  const root = path.resolve(__dirname, '..');
  const artifactRoot = path.join(root, 'artifacts', 'luna-50k-acceptance');
  const novelDir = path.join(artifactRoot, 'novel');
  const screenshots = path.join(artifactRoot, 'screenshots');
  const eventsFile = path.join(artifactRoot, 'acceptance-events.jsonl');
  const stateFile = path.join(artifactRoot, 'acceptance-state.json');
  await fsp.mkdir(screenshots, { recursive: true });
  await fsp.mkdir(novelDir, { recursive: true });
  const evaluate = (source) => mainWindow.webContents.executeJavaScript(source, true);
  const service = getCodexSessionService();
  const startedAt = Date.now();
  const maxModelMs = 60 * 60 * 1000;
  const maxTurns = 30;
  let priorModelDurationMs = 0;
  let turns = 0;
  try {
    const ledgerRows = (await fsp.readFile(path.join(artifactRoot, 'user-data', 'codex-task-ledger.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const finished = ledgerRows.filter((item) => item.type === 'task_finished');
    turns = finished.length;
    priorModelDurationMs = finished.reduce((sum, item) => sum + (Number(item.modelDurationMs) || 0), 0);
  } catch {}
  let firstCommitInterrupted = fs.existsSync(path.join(artifactRoot, 'interruption-tested.json'));
  let currentRun = null;
  const append = async (row) => fsp.appendFile(eventsFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`);
  const waitFor = async (source, timeoutMs = 30_000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeoutMs) {
      const value = await evaluate(source);
      if (value) return value;
      await delay(150);
    }
    throw new Error(`UI condition timed out: ${source}`);
  };
  const shot = async (name) => {
    const file = path.join(screenshots, `${name}.png`);
    await delay(150);
    await fsp.writeFile(file, (await mainWindow.webContents.capturePage()).toPNG());
    console.log(`TEST_SCREENSHOT ${file}`);
    return file;
  };
  const inventory = async (entry) => {
    const descriptors = (await listResourceDescriptors(entry)).filter((item) => item.kind === 'chapter');
    const chapters = [];
    for (const descriptor of descriptors) {
      const resource = await readResource(entry, descriptor.resourceRef);
      chapters.push({ resourceRef: descriptor.resourceRef, hash: resource.sourceHash, bodyCjk: bodyChineseCharacterCount(resource.content), bytes: resource.bytes });
    }
    const contents = await Promise.all(descriptors.map((descriptor) => readResource(entry, descriptor.resourceRef).then((resource) => resource.content)));
    return { chapterCount: chapters.length, bodyCjk: chapters.reduce((sum, item) => sum + item.bodyCjk, 0), repetition: proseRepetitionEvidence(contents), chapters };
  };

  mainWindow.setSize(1440, 960);
  mainWindow.show();
  await delay(300);
  let entry = (await novels.listNovels()).find((item) => path.resolve(item.dir) === path.resolve(novelDir));
  if (!entry) {
    const originalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [novelDir] });
    try {
      await waitFor(`!![...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='创建新项目')`);
      await evaluate(`[...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='创建新项目').click()`);
      await waitFor(`!document.body.innerText.includes('未打开小说项目')`, 20_000);
    } finally { dialog.showOpenDialog = originalDialog; }
    entry = (await novels.listNovels()).find((item) => path.resolve(item.dir) === path.resolve(novelDir));
    if (!entry) throw new Error('正式 UI 新建小说后没有生成项目注册记录');
  } else {
    await novels.openNovel(entry.id);
    await evaluate(`window.location.reload()`);
    await delay(1000);
  }
  await waitFor(`document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`, 30_000);
  console.log(`TEST_PASS luna_50k_project_ready novelId=${entry.id}`);
  await shot('01-project-ready');

  const allEvents = [];
  const listener = (event) => {
    if (!currentRun || event.runId !== currentRun.runId) return;
    allEvents.push(event);
    append({ type: 'codex_event', runId: event.runId, eventType: event.type, itemType: event.item?.type || null, itemId: event.item?.id || null, committedResources: event.committedResources || null, taskResult: event.taskResult || null, failure: event.failure || null }).catch(() => {});
    if (!firstCommitInterrupted && event.committedResources?.length) {
      firstCommitInterrupted = true;
      fsp.writeFile(path.join(artifactRoot, 'interruption-tested.json'), `${JSON.stringify({ interruptedAfterCommitAt: new Date().toISOString(), resources: event.committedResources }, null, 2)}\n`).catch(() => {});
      setTimeout(() => evaluate(`document.querySelector('button[aria-label="停止"]')?.click()`).catch(() => {}), 100);
    }
  };
  service.on('event', listener);

  async function sendTurn(text, skillName = 'mana-fiction-writing') {
    if (turns >= maxTurns) throw new Error(`达到 ${maxTurns} 个原生回合预算`);
    if (priorModelDurationMs + Date.now() - startedAt >= maxModelMs) throw new Error('达到累计 60 分钟模型运行预算');
    turns += 1;
    const before = await inventory(entry);
    allEvents.length = 0;
    await evaluate(`window.dispatchEvent(new CustomEvent('mana:codex-prompt',{detail:{text:${JSON.stringify(text)},skillName:${JSON.stringify(skillName)}}}))`);
    await waitFor(`document.querySelector('[data-testid="codex-input"]')?.value.length>0`);
    await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
    await waitFor(`document.querySelector('button[aria-label="停止"]') || document.querySelector('[data-testid="codex-error"]')`, 20_000);
    const runId = await (async () => {
        const begin = Date.now();
        while (Date.now() - begin < 30_000) {
          const id = [...service.activeRuns.keys()].at(-1);
          if (id) return id;
          const uiError = await evaluate(`document.querySelector('[data-testid="codex-error"]')?.innerText||''`);
          if (uiError) throw new Error(uiError);
          await delay(100);
        }
        throw new Error('Codex startTurn 在 30 秒内没有登记活动 run');
      })();
    currentRun = { runId, turnNumber: turns };
    await append({ type: 'turn_started', runId, turnNumber: turns, promptSha256: crypto.createHash('sha256').update(text).digest('hex'), before });
    let capturedConfirmation = false;
    while (priorModelDurationMs + Date.now() - startedAt < maxModelMs) {
      const terminal = allEvents.find((event) => ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type));
      if (terminal) {
        const after = await inventory(entry);
        await append({ type: 'turn_finished', runId, turnNumber: turns, terminalType: terminal.type, taskResult: terminal.taskResult || null, failure: terminal.failure || null, after });
        await fsp.writeFile(stateFile, `${JSON.stringify({ schemaVersion: 1, novelId: entry.id, turns, elapsedMs: Date.now() - startedAt, inventory: after, lastTerminal: terminal.type }, null, 2)}\n`);
        if (terminal.type === 'turn_failed') throw new Error(`${terminal.failure?.code || 'turn_failed'}: ${terminal.error || terminal.failure?.message || 'Codex turn failed'}`);
        currentRun = null;
        return { terminal, before, after };
      }
      const confirmation = await evaluate(`document.querySelector('[data-testid="codex-confirmation-card"]')?.innerText||''`);
      if (confirmation) {
        if (!capturedConfirmation) { capturedConfirmation = true; await shot(`turn-${String(turns).padStart(2, '0')}-confirmation`); }
        const clicked = await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(item=>item.innerText.includes('确认写入')&&!item.disabled);if(!button)return false;button.click();return true})()`);
        if (clicked) await delay(300);
      } else await delay(250);
    }
    throw new Error('达到累计 60 分钟模型运行预算');
  }

  try {
    let current = await inventory(entry);
    {
      const prompt = current.bodyCjk === 0
        ? '请新写一部完整的中文长篇小说，净正文总计50000—55000个汉字，并有完整结局。题材、人物、章节结构和书名由你决定。请直接在当前空白项目中创作并保存正文；按故事需要安排章节，不要为了凑字数重复内容。达到目标后结束，不要自动启动全书审校。'
        : `请在同一原生回合内从当前已保存现场继续完成这部小说。现在净正文约${current.bodyCjk}个汉字，最终目标是50000—55000个汉字并有完整结局。延续现有人物、情节和文风，以完整场景或章节为单位创作并在自然落点保存；每次保存后继续下一部分，不要等待我再次说“继续”，也不要为了凑字数重复内容。完成后结束，不要自动启动全书审校。`;
      const result = await sendTurn(prompt);
      current = result.after;
      await shot(`turn-${String(turns).padStart(2, '0')}-finished-${current.bodyCjk}`);
      if (result.terminal.type === 'turn_interrupted') {
        if (current.bodyCjk <= result.before.bodyCjk) throw new Error('中断测试没有保留已提交正文');
        await append({ type: 'interruption_verified', beforeBodyCjk: result.before.bodyCjk, afterBodyCjk: current.bodyCjk });
      }
    }
    await append({ type: 'word_count_observed', blocking: false, actual: current.bodyCjk, minimum: 50_000, maximum: 55_000, belowBy: Math.max(0, 50_000 - current.bodyCjk), aboveBy: Math.max(0, current.bodyCjk - 55_000) });
    await shot('50k-complete');
    const renderedChapterCount = await evaluate(`document.querySelectorAll('[data-testid="chapter-tree-item"]').length`);
    const chapterTreeMatchesDisk = renderedChapterCount === current.chapterCount;
    await fsp.writeFile(path.join(artifactRoot, 'ui-state.json'), `${JSON.stringify({ checkedAt: new Date().toISOString(), chapterTreeMatchesDisk, expectedChapterCount: current.chapterCount, renderedChapterCount }, null, 2)}\n`);
    await fsp.writeFile(path.join(artifactRoot, 'manuscript-inventory.json'), `${JSON.stringify(current, null, 2)}\n`);
    if (!chapterTreeMatchesDisk) throw new Error('最终页面的章节树没有显示已提交章节');
    console.log(`TEST_PASS luna_manuscript_persistence bodyCjk=${current.bodyCjk} chapters=${current.chapterCount} turns=${turns}`);
    console.log('TEST_DONE');
    return { passed: 1, failed: 0, inventory: current, turns };
  } finally {
    service.off('event', listener);
  }
}

module.exports = { runLunaFiftyKUiE2E };
