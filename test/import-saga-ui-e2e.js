'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runImportSagaUiRegressionTest(mainWindow) {
  const root = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(process.env.MANA_USER_DATA_ROOT, 'import-ui-fixture');
  const sourceFile = path.join(fixtureRoot, 'p0-import-ui.txt');
  const targetParent = path.join(fixtureRoot, 'projects');
  const targetDir = path.join(targetParent, 'p0-import-ui');
  const artifactDir = path.join(root, 'artifacts', 'qa');
  const results = { total: 0, passed: 0, failed: 0 };
  const pass = (name, detail = '') => { results.total += 1; results.passed += 1; console.log(`TEST_PASS ${name}${detail ? `: ${detail}` : ''}`); };
  const fail = (name, error) => { results.total += 1; results.failed += 1; console.log(`TEST_FAIL ${name}: ${error?.message || error}`); };

  await fs.mkdir(targetParent, { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(sourceFile, '第1章 起点\n\n她推开门，确认走廊无人。\n', 'utf8');

  const { dialog } = require('electron');
  const originalDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async (...args) => {
    const options = args.find((item) => item && typeof item === 'object' && Array.isArray(item.properties)) || {};
    return options.properties?.includes('openDirectory')
      ? { canceled: false, filePaths: [targetParent] }
      : { canceled: false, filePaths: [sourceFile] };
  };

  const analyzer = require(path.join(root, 'src/main/import/analyzer'));
  const originalStart = analyzer.startAnalyses;
  const originalFinalize = analyzer.finalizeAnalyses;
  analyzer.startAnalyses = async (_stagingDir, { abortSignal } = {}) => {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return { runIds: ['import-ui-world'], taskIds: ['world'], chunkMode: false, chunkCount: 1 };
  };
  analyzer.finalizeAnalyses = async () => {
    await delay(900);
    return { characters: 0, factions: 0, timeline: 0, lore: 12, outline: 24, style: 12, chunkMode: false, chunkCount: 1 };
  };

  try {
    mainWindow.setSize(1440, 920);
    mainWindow.show();
    mainWindow.focus();
    await delay(600);
    const ui = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        async function waitFor(predicate, message, timeout = 20000) {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            const value = predicate();
            if (value) return value;
            await sleep(100);
          }
          throw new Error(message);
        }
        function button(text) {
          return Array.from(document.querySelectorAll('button')).find((item) => (item.textContent || '').includes(text) && item.getBoundingClientRect().width > 0);
        }
        async function click(text) {
          const target = await waitFor(() => button(text), 'button not found: ' + text);
          target.click();
          await sleep(100);
        }
        await click('小说');
        await click('导入外部小说文件');
        await click('点击选择文件');
        await waitFor(() => button('解析文件') && !button('解析文件').disabled, 'parse button unavailable');
        await click('解析文件');
        await waitFor(() => document.body.innerText.includes('解析完成：共'), 'parse result missing');
        await click('下一步');
        const originalLabel = Array.from(document.querySelectorAll('label')).find((item) => (item.textContent || '').includes('否，原创作品'));
        if (!originalLabel) throw new Error('original-work choice missing');
        originalLabel.click();
        await click('下一步');
        await click('选择父目录');
        await waitFor(() => document.body.innerText.includes('项目将创建在'), 'target directory preview missing');
        await click('开始导入并分析');
        await waitFor(() => document.querySelector('[data-testid="import-run-snapshot"][data-import-state="analyzing"]'), 'durable analyzing snapshot missing');
        return { analyzing: true, text: document.body.innerText.slice(-1200) };
      })()
    `, true);
    if (ui.analyzing) pass('IMPORT_UI1_file_to_durable_analyzing_snapshot');
    const analyzingShot = path.join(artifactDir, 'import-saga-analyzing.png');
    await fs.writeFile(analyzingShot, (await mainWindow.capturePage()).toPNG());
    console.log(`TEST_SCREENSHOT ${analyzingShot}`);

    const completed = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const started = Date.now();
        while (Date.now() - started < 30000) {
          const snapshot = document.querySelector('[data-testid="import-run-snapshot"]');
          if (snapshot?.dataset.importState === 'completed' && document.body.innerText.includes('导入成功')) {
            return { state: snapshot.dataset.importState, text: document.body.innerText.slice(-1200) };
          }
          await sleep(120);
        }
        throw new Error('completed ImportRun UI state missing');
      })()
    `, true);
    if (completed.state === 'completed') pass('IMPORT_UI2_review_promote_and_open_reaches_completed');
    const completedShot = path.join(artifactDir, 'import-saga-completed.png');
    await fs.writeFile(completedShot, (await mainWindow.capturePage()).toPNG());
    console.log(`TEST_SCREENSHOT ${completedShot}`);

    const chapter = await fs.readFile(path.join(targetDir, 'chapters', 'chapter-001.md'), 'utf8');
    const manifest = JSON.parse(await fs.readFile(path.join(targetDir, '.mana', 'import-manifest.json'), 'utf8'));
    const novels = require(path.join(root, 'src/main/store/novels'));
    const registered = (await novels.listNovels()).find((item) => path.resolve(item.dir) === path.resolve(targetDir));
    if (chapter.includes('她推开门') && manifest.resources?.length > 0 && registered) pass('IMPORT_UI3_disk_manifest_and_registry_readback');
    else fail('IMPORT_UI3_disk_manifest_and_registry_readback', 'chapter, manifest, or registry receipt is missing');
  } catch (error) {
    fail('IMPORT_UI_FLOW', error);
  } finally {
    dialog.showOpenDialog = originalDialog;
    analyzer.startAnalyses = originalStart;
    analyzer.finalizeAnalyses = originalFinalize;
  }
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  return results;
}

module.exports = { runImportSagaUiRegressionTest };
