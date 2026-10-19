'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runImportSagaUiRegressionTest(mainWindow) {
  const root = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(process.env.MANA_USER_DATA_ROOT, 'import-ui-fixture');
  let sourceFile = path.join(fixtureRoot, 'p0-import-ui.txt');
  const targetParent = path.join(fixtureRoot, 'projects');
  const targetDir = path.join(targetParent, 'p0-import-ui');
  const artifactDir = path.join(root, 'artifacts', 'data-import-safety-audit', 'ui');
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
  const originalStart = analyzer.executeStartAnalyses;
  const originalFinalize = analyzer.executeFinalizeAnalyses;
  const nativeService = require(path.join(root, 'src/main/codex-runtime')).getCodexSessionService();
  const originalOneShot = nativeService.runOneShot;
  const enrichmentService = require(path.join(root, 'src/main/import/characterEnricher'));
  const originalEnrich = enrichmentService.enrichCharacters;
  let analysisMode = 'complete', analysisDir = '';
  analyzer.executeStartAnalyses = async (_stagingDir, { abortSignal } = {}) => {
    analysisDir = _stagingDir;
    if (abortSignal?.aborted) throw abortSignal.reason;
    return { runIds: ['import-ui-world'], taskIds: ['world'], chunkMode: false, chunkCount: 1 };
  };
  analyzer.executeFinalizeAnalyses = async () => {
    await delay(900);
    if (analysisMode === 'partial') return { status: 'partial', characters: 0, domains: [{ taskId: 'world', status: 'failed', errors: [{ error: 'fixture world failed' }] }], chunkCount: 1 };
    if (analysisMode === 'merge') {
      await fs.writeFile(path.join(analysisDir, 'characters', 'ui-new.json'), JSON.stringify({ id: 'ui-new', name: '界面新增角色', personality: '谨慎' }));
      await fs.writeFile(path.join(analysisDir, 'world', 'places.json'), JSON.stringify({ places: [{ name: '界面地点', description: '导入描述' }] }));
      await fs.writeFile(path.join(analysisDir, 'world', 'lore.md'), '界面导入世界');
    }
    return { status: 'complete', characters: analysisMode === 'merge' ? 1 : 0, factions: 0, timeline: 0, lore: 12, outline: 24, style: 12, chunkMode: false, chunkCount: 1 };
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
    await delay(800);
    await mainWindow.webContents.executeJavaScript(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 15000) {
        if (!document.body.innerText.includes('正在载入工作区') && document.body.innerText.includes('p0-import-ui')) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('promoted workspace did not finish loading');
    })()`);
    const completedShot = path.join(artifactDir, 'import-saga-completed.png');
    await fs.writeFile(completedShot, (await mainWindow.capturePage()).toPNG());
    console.log(`TEST_SCREENSHOT ${completedShot}`);

    const chapter = await fs.readFile(path.join(targetDir, 'chapters', 'chapter-001.md'), 'utf8');
    const manifest = JSON.parse(await fs.readFile(path.join(targetDir, '.mana', 'import-manifest.json'), 'utf8'));
    const novels = require(path.join(root, 'src/main/store/novels'));
    const registered = (await novels.listNovels()).find((item) => path.resolve(item.dir) === path.resolve(targetDir));
    if (chapter.includes('她推开门') && manifest.resources?.length > 0 && registered) pass('IMPORT_UI3_disk_manifest_and_registry_readback');
    else fail('IMPORT_UI3_disk_manifest_and_registry_readback', 'chapter, manifest, or registry receipt is missing');

    async function flow(code) {
      return mainWindow.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (item) => item.getBoundingClientRect().width > 0;
        const button = (text) => [...document.querySelectorAll('button')].find((item) => visible(item) && item.textContent.includes(text));
        const wait = async (predicate, message) => { const start = Date.now(); while (Date.now() - start < 15000) { const found = predicate(); if (found) return found; await sleep(80); } throw new Error(message); };
        const click = async (text) => { const target = await wait(() => button(text), 'button missing: ' + text); if (target.disabled) throw new Error('button disabled: ' + text); target.click(); await sleep(150); };
        const closeImport = () => { const title = [...document.querySelectorAll('span')].find((item) => visible(item) && item.textContent === '导入外部小说'); title?.parentElement.parentElement.querySelector('button')?.click(); };
        ${code}
      })()`, true);
    }
    async function screenshot(name) {
      await delay(250);
      const file = path.join(artifactDir, name + '.png');
      await fs.writeFile(file, (await mainWindow.capturePage()).toPNG());
      console.log('TEST_SCREENSHOT ' + file);
    }
    await flow(`
      if (button('完成')) await click('完成');
      window.dispatchEvent(new Event('offline'));
      await window.mana.networkStatus.set('offline');
      await window.mana.novel.saveChapter(${JSON.stringify(registered.id)}, 'chapter-001.md', '离线正文'.repeat(500));
      await window.mana.novel.writeStyleMemory(${JSON.stringify(registered.id)}, '离线文风'.repeat(500));
      window.dispatchEvent(new Event('online'));
      await wait(() => button('确认保存记录'), 'offline dialog missing');
    `);
    await screenshot('offline-saved-records');
    await flow(`await click('确认保存记录'); await wait(() => !document.body.innerText.includes('检测到离线编辑记录'), 'offline confirmation did not close');`);
    const data = require(path.join(root, 'src/main/store/novelData'));
    if ((await data.readChapter(targetDir, 'chapter-001.md')).length !== 2000 || (await data.readStyleMemory(targetDir)).length !== 2000) throw new Error('offline UI truncated saved content');
    pass('IMPORT_UI4_offline_confirmation_preserves_2000_char_body_and_style');

    analysisMode = 'partial'; sourceFile = path.join(fixtureRoot, 'partial-book.txt');
    await fs.writeFile(sourceFile, '第1章 部分分析\n\n只完成部分分析，不能自动提升。\n');
    await flow(`
      await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件');
      await wait(() => document.body.innerText.includes('解析完成：共'), 'partial parse missing'); await click('下一步');
      [...document.querySelectorAll('label')].find((item) => item.textContent.includes('否，原创作品')).click();
      await click('下一步'); await click('选择父目录'); await click('开始导入并分析');
      await wait(() => document.querySelector('[data-testid="import-partial-analysis"]'), 'partial status missing');
      if (document.querySelector('[data-import-state="completed"]')) throw new Error('partial analysis was silently promoted');
    `);
    await screenshot('partial-analysis-review');
    if (await fs.access(path.join(targetParent, 'partial-book')).then(() => true, () => false)) throw new Error('partial project was auto-promoted');
    pass('IMPORT_UI5_partial_analysis_is_visible_and_requires_review');
    await flow(`closeImport(); await sleep(200);`);

    analysisMode = 'merge'; sourceFile = path.join(fixtureRoot, 'merge-book.txt');
    await fs.writeFile(sourceFile, '第1章 合并正文\n\n界面新增角色抵达界面地点。\n');
    await data.writeWorld(targetDir, { lore: '界面旧世界', places: [{ name: '界面地点', description: '现有描述' }] });
    await flow(`
      await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件');
      await wait(() => document.body.innerText.includes('解析完成：共'), 'merge parse missing');
      document.querySelector('input[name="targetMode"][value="existing"]').click(); await sleep(150);
      const select = [...document.querySelectorAll('select')].find(visible);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(registered.id)});
      select.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); await click('下一步');
      [...document.querySelectorAll('label')].find((item) => item.textContent.includes('否，原创作品')).click(); await click('下一步'); await click('确认导入并自动分析');
      await wait(() => button('继续（冲突检测）') || button('继续'), 'analysis continuation missing');
      const next = button('继续（冲突检测）') || button('继续'); next.click(); await sleep(200);
      await wait(() => button('接受并进入合并模式') || button('无冲突，直接导入'), 'conflict report missing');
      (button('接受并进入合并模式') || button('无冲突，直接导入')).click();
      await wait(() => document.body.innerText.includes('合并模式') && button('接受导入版'), 'merge review missing');
      if (!document.body.innerText.includes('界面新增角色')) throw new Error('new character absent from review');
    `);
    await screenshot('merge-complete-plan');
    const projects = await require(path.join(root, 'src/main/import/stagingProject')).listStagingProjects();
    const imported = projects.find((project) => project.sourceFiles.includes(sourceFile));
    const run = await new (require(path.join(root, 'src/main/import/importRunStore')).ImportRunStore)().findByImportId(imported.id);
    const engine = require(path.join(root, 'src/main/import/mergeEngine'));
    const session = await engine.getMergeSession(run.mergeSessionId);
    // All choices originate in visible controls, including non-conflicting additions.
    for (const item of session.items) {
      await flow(`const target = [...document.querySelectorAll('button')].find((button) => button.querySelector('span.truncate')?.textContent === ${JSON.stringify(item.label)}); if (!target) throw new Error('review item missing'); target.click(); await sleep(100); await click('接受导入版');`);
    }
    await data.writeWorld(targetDir, { lore: '审阅期间用户编辑' });
    await flow(`await click('保存并退出'); await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('审阅后资源已变化'), 'stale-review error missing');`);
    await screenshot('merge-stale-review');
    if (await data.readCharacter(targetDir, 'ui-new')) throw new Error('stale plan partly committed');
    await flow(`await click('继续审阅'); const target = [...document.querySelectorAll('button')].find((button) => button.querySelector('span.truncate')?.textContent === 'world/lore.md'); target.click(); await sleep(100); await click('接受现有版'); await click('保存并退出'); await wait(() => !document.body.innerText.includes('合并模式') && !button('保存中'), 'merge did not exit');`);
    if ((await data.readCharacter(targetDir, 'ui-new'))?.name !== '界面新增角色') throw new Error('new character not saved');
    if ((await data.readWorld(targetDir)).lore !== '审阅期间用户编辑') throw new Error('stale user edit was lost');
    if ((await data.readWorld(targetDir)).places[0]?.description !== '导入描述') throw new Error('resolved place not saved');
    const finalRun = await new (require(path.join(root, 'src/main/import/importRunStore')).ImportRunStore)().get(run.runId);
    if (finalRun.state !== 'completed' || !finalRun.checkpoints.some((item) => item.mergeReceipt)) throw new Error('compatibility merge receipt missing in Saga');
    pass('IMPORT_UI6_new_character_and_places_save_with_stale_review_and_durable_saga_receipt');
    await data.writeChapterWithMeta(targetDir, 'chapter-001.md', '界面新增角色在门边观察，随后走入大厅。'.repeat(20), {});
    let extractionFails = true;
    nativeService.runOneShot = async () => {
      if (extractionFails) throw new Error('fixture regeneration failure');
      return { text: JSON.stringify([{ id: 'model-new', name: '界面新增角色', personality: '重新提取的完整候选' }, { id: 'new-two', name: '候选第二角色' }]) };
    };
    await flow(`
      window.confirm = () => true;
      const open = await wait(() => document.querySelector('button[title="在编辑器中打开角色卡"]'), 'character tab entry missing'); open.click();
      await wait(() => button('重新生成'), 'regeneration button missing'); await click('重新生成');
      await wait(() => document.body.innerText.includes('fixture regeneration failure'), 'regeneration failure missing');
      if (!document.body.innerText.includes('界面新增角色')) throw new Error('old cards disappeared on failed extraction');
    `);
    if (!(await data.readCharacter(targetDir, 'ui-new'))) throw new Error('failed extraction deleted old card');
    pass('IMPORT_UI7_failed_regeneration_keeps_visible_and_saved_cards');
    extractionFails = false;
    await flow(`await click('重新生成'); await wait(() => document.querySelector('[data-testid="fact-review"] select'), 'regeneration review missing'); if (!document.querySelector('[data-testid="fact-review"]').textContent.includes('候选第二角色')) throw new Error('candidate content missing');`);
    await screenshot('regeneration-review');
    await flow(`await click('拒绝本次变更'); await wait(() => !document.querySelector('[data-testid="fact-review"]'), 'rejected review still open');`);
    if (await data.readCharacter(targetDir, 'new-two')) throw new Error('rejected candidate was saved');
    await flow(`await click('重新生成'); await wait(() => document.querySelector('[data-testid="fact-review"] select'), 'second review missing'); while ([...document.querySelectorAll('[data-testid="fact-review"] select')].some((s) => s.value === '')) {
      const select = [...document.querySelectorAll('[data-testid="fact-review"] select')].find((s) => s.value === '');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '0'); select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(180); await wait(() => !select.disabled, 'decision save pending');
    } await click('确认并保存已审阅内容'); await wait(() => !document.querySelector('[data-testid="fact-review"]') && document.body.innerText.includes('候选第二角色'), 'approved cards not visible');`);
    if ((await data.readCharacter(targetDir, 'ui-new'))?.personality !== '重新提取的完整候选' || !(await data.readCharacter(targetDir, 'new-two'))) throw new Error('approved regeneration readback failed');
    await screenshot('regeneration-saved');
    pass('IMPORT_UI8_regeneration_review_reject_and_approve_matches_official_readback');


    // Real analyzer + real IPC/review/storage; only the native model transport is deterministic.
    analyzer.executeStartAnalyses = originalStart;
    analyzer.executeFinalizeAnalyses = originalFinalize;
    sourceFile = path.join(fixtureRoot, 'fact-review-book.txt');
    await fs.writeFile(sourceFile, '第1章 事实来源\n\n事实角色十八岁。\n' + '她逐字核对档案。\n'.repeat(8000) + '事实角色二十岁。');
    const requestSizes = [];
    nativeService.runOneShot = async ({ text }) => {
      requestSizes.push(text.length);
      let output;
      if (text.includes('以下小说文本中出现了哪些角色')) output = [{ id: 'fact-char', name: '事实角色', age: text.includes('【上下文】') ? '20' : '18', evidence: { quote: text.includes('【上下文】') ? '事实角色二十岁' : '事实角色十八岁', location: '正文分片' } }];
      else if (text.includes('以下小说文本中出现了哪些势力') || text.includes('以下小说文本中发生了哪些重要事件')) output = [];
      else if (text.includes('分析以下小说的世界观')) output = { isFanwork: false, places: [] };
      else output = '## 审阅材料\n\n事实角色核对档案。';
      return { text: typeof output === 'string' ? output : JSON.stringify(output) };
    };
    await flow(`
      await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件');
      await wait(() => document.body.innerText.includes('解析完成：共'), 'fact source parse missing'); await click('下一步');
      [...document.querySelectorAll('label')].find((item) => item.textContent.includes('否，原创作品')).click();
      await click('下一步'); await click('选择父目录'); await click('开始导入并分析');
      await wait(() => document.querySelector('[data-testid="fact-review"] select'), 'fact review dialog missing');
      if (!button('确认并保存已审阅内容')?.disabled) throw new Error('unresolved facts can commit');
      const select = document.querySelector('select[aria-label="事实角色 · 年龄"]');
      if (!select || ![...select.options].some((o) => o.value === '1')) throw new Error('conflicting age candidates missing');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '1');
      select.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500);
      const detail = [...document.querySelectorAll('details')].find((d) => d.textContent.includes('正文分片')); if (detail) detail.open = true;
    `);
    await screenshot('fact-review-candidates');
    const factProjects = await require(path.join(root, 'src/main/import/stagingProject')).listStagingProjects();
    const factProject = factProjects.find((p) => p.sourceFiles.includes(sourceFile));
    const factRoot = path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', factProject.id);
    const reviewApi = require(path.join(root, 'src/main/import/reviewStore'));
    const pendingReview = (await reviewApi.list(factRoot))[0];
    if (!pendingReview || pendingReview.decisions['characters/fact-char.json:age'] !== 1) throw new Error('UI decision was not persisted');
    if ((await data.listCharacters(factRoot)).length) throw new Error('unreviewed facts saved early');
    if (await fs.access(path.join(targetParent, 'fact-review-book')).then(() => true, () => false)) throw new Error('fact review was promoted early');
    await new Promise((resolve) => { mainWindow.webContents.once('did-finish-load', resolve); mainWindow.webContents.reload(); });
    await delay(800);
    await flow(`
      await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件');
      await wait(() => button('复用已有结果'), 'duplicate recovery entry missing'); await click('复用已有结果');
      await wait(() => document.querySelector('[data-testid="fact-review"] select'), 'persisted fact review did not reopen');
      if (document.querySelector('select[aria-label="事实角色 · 年龄"]')?.value !== '1') throw new Error('persisted candidate choice was lost');
      while ([...document.querySelectorAll('[data-testid="fact-review"] select')].some((select) => select.value === '')) {
        const select = [...document.querySelectorAll('[data-testid="fact-review"] select')].find((s) => s.value === '');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '0'); select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(180); await wait(() => !select.disabled, 'decision save did not finish');
      }
    `);
    await screenshot('fact-review-restored');
    await flow(`await click('确认并保存已审阅内容'); await wait(() => !document.querySelector('[data-testid="fact-review"]'), 'review did not commit');`);
    if ((await data.readCharacter(factRoot, 'fact-char'))?.age !== '20') throw new Error('selected fact was not saved');
    const finalFactReview = await reviewApi.get(factRoot, pendingReview.id);
    if (finalFactReview.state !== 'committed' || !finalFactReview.receipt?.resources?.length) throw new Error('durable fact receipt missing');
    if (!requestSizes.length || requestSizes.some((size) => size > 60000)) throw new Error('total prompt budget exceeded');
    pass('IMPORT_UI9_real_analyzer_fact_review_blocks_early_save_and_restores_choices_after_reload');
    // Reuse restores the original target. Set a new destination through the visible controls if needed.
    await flow(`await click('审阅后创建项目'); await wait(() => document.querySelector('[data-import-state="completed"]') && document.body.innerText.includes('导入成功'), 'reviewed import did not complete');`);
    const factNovel = (await novels.listNovels()).find((n) => n.title === 'fact-review-book');
    if (!factNovel || (await data.readCharacter(factNovel.dir, 'fact-char'))?.age !== '20') throw new Error('promoted facts did not match reviewed bytes');
    await screenshot('fact-review-promoted');
    pass('IMPORT_UI10_reviewed_facts_promote_with_selected_value_and_official_readback');
    const beforeWeb = await data.readCharacter(factNovel.dir, 'fact-char');
    await data.writeCharacter(factNovel.dir, { ...beforeWeb, isOriginal: false, sourceWork: '测试原作' });
    enrichmentService.enrichCharacters = async (cards) => cards.map((card) => ({ ...card, _enrichmentStatus: 'partial',
      _proposedFacts: { background: [{ value: '用户逐项确认的原作背景', quote: '页面明确介绍该角色背景', quoteExists: true, verbatimValue: false, url: 'https://example.invalid/fact-source' }] },
      _enrichmentEvidence: { url: 'https://example.invalid/fact-source', title: '事实角色', targetCharacter: '事实角色', targetWork: '测试原作', sourceText: '事实角色来自测试原作。页面明确介绍该角色背景。' } }));
    await flow(`
      if (button('完成')) await click('完成');
      const open = await wait(() => document.querySelector('button[title="在编辑器中打开角色卡"]'), 'fact character entry missing'); open.click();
      await wait(() => button('联网补全人设'), 'web enrichment entry missing'); await click('联网补全人设'); await click('启动联网补全');
      await wait(() => document.querySelector('[data-testid="fact-review"] select'), 'web fact review missing');
      await wait(() => document.body.innerText.includes('确认网页主体及所属作品'), 'identity review missing');
    `);
    const webPending = (await reviewApi.list(factNovel.dir)).find((r) => r.kind === 'enrichment');
    if (!webPending || (await data.readCharacter(factNovel.dir, 'fact-char')).background === '用户逐项确认的原作背景') throw new Error('web fact was automatically saved');
    await screenshot('web-fact-review');
    await flow(`
      while ([...document.querySelectorAll('[data-testid="fact-review"] select')].some((s) => s.value === '')) {
        const select = [...document.querySelectorAll('[data-testid="fact-review"] select')].find((s) => s.value === '');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '0'); select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(180); await wait(() => !select.disabled, 'web decision pending');
      }
      await click('确认并保存已审阅内容'); await wait(() => !document.querySelector('[data-testid="fact-review"]'), 'web review did not close');
      await click('关闭'); await wait(() => document.body.innerText.includes('用户逐项确认的原作背景'), 'reviewed web background not visible');
    `);
    const reviewedWeb = await data.readCharacter(factNovel.dir, 'fact-char');
    if (reviewedWeb.background !== '用户逐项确认的原作背景' || reviewedWeb._enrichmentStatus !== 'reviewed') throw new Error('web fact receipt/readback mismatch');
    await screenshot('web-fact-saved');
    pass('IMPORT_UI11_web_candidates_require_identity_and_field_decisions_before_visible_official_save');
    await data.writeStyleMemory(factNovel.dir, '待提交前的文风');
    const offlineApi = require(path.join(root, 'src/main/store/offlineLog'));
    const { hash } = require(path.join(root, 'src/main/codex-runtime/contracts'));
    const pendingOffline = await offlineApi.appendEntry({ novelId: factNovel.id, type: 'style', targetName: '界面待提交文风', change: { resourceRef: 'style:memory', mode: 'replace', baseHash: hash('待提交前的文风'), content: '界面待提交全文'.repeat(300) } });
    await flow(`
      window.dispatchEvent(new Event('offline')); await window.mana.networkStatus.set('offline');
      window.dispatchEvent(new Event('online'));
      await wait(() => button('确认并提交待保存变更'), 'pending offline write button missing');
      const detail = [...document.querySelectorAll('details')].find((d) => d.textContent.includes('界面待提交文风')); if (!detail) throw new Error('offline payload preview missing'); detail.open = true;
    `);
    await screenshot('offline-pending-preview');
    await flow(`await click('确认并提交待保存变更'); await wait(() => !document.body.innerText.includes('检测到离线编辑记录'), 'pending offline commit did not finish');`);
    if (await data.readStyleMemory(factNovel.dir) !== '界面待提交全文'.repeat(300)) throw new Error('pending offline payload lost bytes');
    const pendingReceipt = await offlineApi.syncEntry(factNovel.id, pendingOffline.id);
    if (pendingReceipt.status !== 'committed') throw new Error('pending offline receipt missing');
    pass('IMPORT_UI12_pending_offline_preview_commits_full_payload_with_durable_receipt');
    const stagingApi = require(path.join(root, 'src/main/import/stagingProject'));
    const runsApi = new (require(path.join(root, 'src/main/import/importRunStore')).ImportRunStore)();
    const promotionApi = require(path.join(root, 'src/main/import/promotionTransactions'));
    analyzer.executeStartAnalyses = async (dir) => { analysisDir = dir; return { chunkCount: 1 }; };
    analyzer.executeFinalizeAnalyses = async () => ({ status: 'partial', domains: [{ taskId: 'world', status: 'partial' }], chunkCount: 1 });
    async function beginP1Import(name, facts = false, auto = false) {
      sourceFile = path.join(fixtureRoot, name + '.txt');
      await fs.writeFile(sourceFile, '第1章 事务边界\n\n完整流程必须保留原有事件和地点，以及提交回执。\n');
      await flow(`
        if (button('完成')) await click('完成'); else closeImport();
        await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件');
        await wait(() => document.body.innerText.includes('解析完成：共'), 'P1 parse missing'); await click('下一步');
        [...document.querySelectorAll('label')].find((item) => item.textContent.includes('否，原创作品')).click();
        await click('下一步'); await click('选择父目录'); await click('开始导入并分析');
        await wait(() => ${facts ? "document.querySelector('[data-testid=\"fact-review\"] select')" : auto ? "document.body.innerText.includes('正在提交项目')" : "document.querySelector('[data-testid=\"import-partial-analysis\"]')"}, 'P1 review missing');
      `);
      const project = (await stagingApi.listStagingProjects()).find((p) => p.sourceFiles.includes(sourceFile));
      if (!project) throw new Error('P1 staging project missing');
      return { run: await runsApi.findByImportId(project.id), stagingDir: path.join(process.env.MANA_USER_DATA_ROOT, 'import-staging', project.id), target: path.join(targetParent, name) };
    }
    const partialFinalize = analyzer.executeFinalizeAnalyses;
    let existingEventBaseline;
    analyzer.executeFinalizeAnalyses = async () => {
      await data.replaceTimeline(analysisDir, [{ id: 'ui-existing-event', title: '界面原有事件', description: '用户已确认的旧事件' }]);
      existingEventBaseline = await data.listTimeline(analysisDir);
      const world = { schemaVersion: 1, lore: '界面旧世界', places: [{ id: 'ui-existing-place', name: '界面原有地点', description: '用户原有地点说明' }] };
      await fs.writeFile(path.join(analysisDir, 'world/meta.json'), JSON.stringify(world));
      await fs.writeFile(path.join(analysisDir, 'world/places.json'), JSON.stringify({ places: world.places }));
      const plans = require(path.join(root, 'src/main/import/resourcePlan'));
      const proposed = { ...world, places: [{ id: 'ui-existing-place', name: '应拒绝的地点名称', description: '应拒绝的地点说明', _analysisCandidates: { name: [{ value: '应拒绝的地点名称' }], description: [{ value: '应拒绝的地点说明' }] } }] };
      const changes = [{ ...await plans.snapshot(analysisDir, 'timeline/events.jsonl'), after: JSON.stringify({ id: 'ui-existing-event', title: '应拒绝的事件', description: '错误候选' }) + '\n' },
        { ...await plans.snapshot(analysisDir, 'world/meta.json'), after: JSON.stringify(proposed) },
        { ...await plans.snapshot(analysisDir, 'world/places.json'), after: JSON.stringify({ places: proposed.places }) }];
      const review = await reviewApi.create(analysisDir, { kind: 'analysis', fields: reviewApi.fieldsForChanges(changes), plan: { changes } });
      const summary = { status: 'partial', reviewId: review.id, reviewState: 'review', domains: [{ taskId: 'world', status: 'complete' }] };
      await require(path.join(root, 'src/main/store/jsonStore')).writeJson(path.join(analysisDir, '.mana/analysis-summary.json'), summary);
      return summary;
    };
    const existingFacts = await beginP1Import('p1-existing-facts', true);
    const existingReview = (await reviewApi.list(existingFacts.stagingDir))[0];
    await screenshot('p1-existing-facts-review');
    for (const field of existingReview.fields) await flow(`
      const select = [...document.querySelectorAll('[data-testid="fact-review"] select')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(field.label)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'reject'); select.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => !select.disabled && select.value === 'reject', 'rejected decision not durable');
    `);
    await flow(`await click('确认并保存已审阅内容'); await wait(() => !document.querySelector('[data-testid="fact-review"]'), 'existing facts did not commit'); await click('审阅后创建项目'); await wait(() => document.querySelector('[data-import-state="completed"]') && document.body.innerText.includes('导入成功'), 'existing facts promotion failed');`);
    assert.deepEqual(await data.listTimeline(existingFacts.target), existingEventBaseline, 'reject must preserve every original event field');
    if ((await data.readWorld(existingFacts.target)).places[0]?.name !== '界面原有地点') throw new Error('reject deleted or changed the existing place');
    await flow(`if (![...document.querySelectorAll('span.text-white')].some((span) => span.textContent === 'p1-existing-facts')) throw new Error('completion title does not match the formal project');`);
    await screenshot('p1-existing-facts-saved');
    await flow(`await click('完成'); const world = await wait(() => document.querySelector('button[title="在编辑器中打开世界观"]'), 'formal world tab missing'); world.click(); await wait(() => document.body.innerText.includes('界面原有地点') && document.body.innerText.includes('用户原有地点说明'), 'preserved place not visible in formal project');`);
    await screenshot('p1-existing-place-visible');
    await flow(`document.querySelector('button[title="在编辑器中打开时间线"]').click(); await wait(() => document.body.innerText.includes('用户已确认的旧事件'), 'preserved event not visible in formal project');`);
    await screenshot('p1-existing-event-visible');
    pass('IMPORT_UI13_existing_event_and_place_rejection_preserves_formal_data');
    analyzer.executeFinalizeAnalyses = partialFinalize;

    const recovery = await beginP1Import('p1-recovery');
    const originalRename = fs.rename; let injected = false;
    fs.rename = async (a, b, ...args) => { await originalRename(a, b, ...args); if (!injected && b === recovery.target) { injected = true; throw Object.assign(new Error('测试：目录就位后中断'), { code: 'EIO' }); } };
    try {
      await flow(`await click('审阅后创建项目'); await wait(() => document.querySelector('[data-import-state="interrupted"]'), 'interrupted decided promotion not visible');`);
    } finally { fs.rename = originalRename; }
    const originalProjectId = JSON.parse(await fs.readFile(path.join(recovery.target, 'novel.json'))).id;
    await screenshot('p1-promotion-interrupted');
    mainWindow.webContents.reload(); await delay(1000);
    await flow(`await click('小说'); await click('导入外部小说文件'); await wait(() => document.querySelector('[data-testid="import-restore-${recovery.run.runId}"]'), 'durable recovery entry missing').then((b) => b.click()); await wait(() => document.querySelector('[data-testid="import-run-resume"]'), 'promotion resume button missing'); await click('从检查点恢复'); await wait(() => document.querySelector('[data-import-state="completed"]') && document.body.innerText.includes('导入成功'), 'promotion resume failed');`);
    const resumed = await runsApi.get(recovery.run.runId);
    if (resumed.result.id !== originalProjectId || !resumed.result.receipt?.operationId || (await novels.listNovels()).filter((n) => n.dir === recovery.target).length !== 1) throw new Error('recovery duplicated or lost the original promotion receipt');
    await flow(`document.querySelector('[data-testid="import-promotion-receipt"]').open = true;`);
    await screenshot('p1-promotion-recovered');
    pass('IMPORT_UI14_interrupted_promotion_reload_restore_resume_same_project_and_receipt');

    async function cancelAtBoundary(name, method, predicate, committed, auto = false) {
      let fixture = { target: path.join(targetParent, name), stagingDir: '' };
      const original = fs[method]; let reached, release, once = true;
      const boundary = new Promise((resolve) => { reached = resolve; }); const barrier = new Promise((resolve) => { release = resolve; });
      fs[method] = async (...args) => { const result = await original(...args); if (once && predicate(fixture, ...args)) { once = false; reached(); await barrier; } return result; };
      try {
        fixture = await beginP1Import(name, false, auto);
        if (!auto) await flow(`await click('审阅后创建项目');`);
        await boundary;
        await flow(`const cancel = document.querySelector('[data-testid="import-run-cancel"]'); if (!cancel || cancel.disabled) throw new Error('cancel unavailable at commit boundary'); cancel.click(); await wait(() => document.body.innerText.includes('正在核对取消与保存结果'), 'cancellation feedback missing');`);
        const deadline = Date.now() + 5000;
        while (!await fs.access(path.join(process.env.MANA_USER_DATA_ROOT, 'import-promotion-requests', fixture.run.importId, 'cancel.json')).then(() => true, () => false)) { if (Date.now() > deadline) throw new Error('durable cancel request missing'); await delay(40); }
        release();
        await flow(`await wait(() => document.querySelector('[data-import-state="${committed ? 'completed' : 'cancelled'}"]') && ${committed ? "document.body.innerText.includes('取消请求到达时项目已提交') && document.querySelector('[data-testid=\"import-promotion-receipt\"]')" : "document.querySelector('[data-testid=\"import-cancelled\"]')"}, 'cancel/commit outcome or receipt missing');`);
        const durable = await runsApi.get(fixture.run.runId);
        if (durable.state !== (committed ? 'completed' : 'cancelled')) throw new Error('visible and durable cancellation states differ');
        const registered = (await novels.listNovels()).filter((n) => n.dir === fixture.target);
        if (registered.length !== (committed ? 1 : 0)) throw new Error('cancellation disagrees with formal registry');
        if (committed && !durable.result?.receipt?.operationId) throw new Error('commit receipt lost to cancellation');
        if (!committed && await fs.access(fixture.target).then(() => true, () => false)) throw new Error('cancelled operation created a formal directory');
        if ((await promotionApi.get(fixture.run.importId)).state !== (committed ? 'committed' : 'cancelled')) throw new Error('promotion ledger and run terminal disagree');
        if (committed) await flow(`document.querySelector('[data-testid="import-promotion-receipt"]').open = true;`);
        await screenshot(name);
      } finally { release(); fs[method] = original; }
    }
    await cancelAtBoundary('p1-cancel-after-commit', 'rename', (fixture, _a, b) => b === fixture.target, true);
    pass('IMPORT_UI15_cancel_after_commit_reports_actual_project_and_receipt');
    await cancelAtBoundary('p1-cancel-before-commit', 'copyFile', (fixture, a) => String(a).startsWith(fixture.stagingDir) && String(a).endsWith('chapter-001.md'), false);
    pass('IMPORT_UI16_cancel_before_commit_creates_no_formal_project');
    analyzer.executeFinalizeAnalyses = async () => ({ status: 'complete', chunkCount: 1 });
    await cancelAtBoundary('p1-cancel-auto-promotion', 'copyFile', (_fixture, a) => String(a).endsWith('chapter-001.md'), false, true);
    pass('IMPORT_UI17_initial_analysis_auto_promotion_cancel_keeps_the_cancelled_view');
    analyzer.executeFinalizeAnalyses = partialFinalize;
    await cancelAtBoundary('p1-cancel-at-decision', 'rename', (_fixture, _a, b) => String(b).endsWith('/reservation.json'), false);
    pass('IMPORT_UI18_durable_cancel_before_decision_wins_after_target_reservation');

    analyzer.executeFinalizeAnalyses = async () => {
      const old = { lore: '名称审阅旧世界', places: [{ name: '古城', description: '用户旧说明', custom: '保留字段' }] };
      await fs.writeFile(path.join(analysisDir, 'world/meta.json'), JSON.stringify(old));
      await fs.writeFile(path.join(analysisDir, 'world/places.json'), JSON.stringify({ places: old.places }));
      const world = require(path.join(root, 'src/main/import/resultMerger')).mergeWorld([
        { chunkIndex: 0, world: { places: [{ name: '古城', description: '候选说明甲' }] } },
        { chunkIndex: 1, world: { places: [{ name: '古 城', description: '候选说明乙' }] } },
      ]);
      const plans = require(path.join(root, 'src/main/import/resourcePlan'));
      const reviewApi = require(path.join(root, 'src/main/import/reviewStore'));
      const changes = [{ ...await plans.snapshot(analysisDir, 'world/meta.json'), after: JSON.stringify(world) }, { ...await plans.snapshot(analysisDir, 'world/places.json'), after: JSON.stringify({ places: world.places }) }];
      const review = await reviewApi.create(analysisDir, { kind: 'analysis', fields: reviewApi.fieldsForChanges(changes), plan: { changes } });
      return { status: 'partial', reviewState: 'review', reviewId: review.id, domains: [{ taskId: 'world', status: 'partial' }] };
    };
    const renamed = await beginP1Import('authority-name-review', true);
    await flow(`while ([...document.querySelectorAll('[data-testid="fact-review"] select')].some((s) => s.value === '')) {
      const select = [...document.querySelectorAll('[data-testid="fact-review"] select')].find((s) => s.value === '');
      const label = select.getAttribute('aria-label'); const choice = label.includes('古城') && label.includes('姓名') ? '1' : label.includes('古城') && label.includes('描述') ? 'reject' : '0';
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, choice); select.dispatchEvent(new Event('change', { bubbles: true })); await sleep(180); await wait(() => !select.disabled, 'name decision pending');
    }`);
    await screenshot('authority-name-review');
    await flow(`await click('确认并保存已审阅内容'); await wait(() => !document.querySelector('[data-testid="fact-review"]'), 'alternative name failed to save'); await click('审阅后创建项目'); await wait(() => document.querySelector('[data-import-state="completed"]'), 'renamed place not promoted'); await click('完成'); document.querySelector('button[title="在编辑器中打开世界观"]').click(); await wait(() => document.body.innerText.includes('古 城') && document.body.innerText.includes('用户旧说明'), 'renamed place or rejected original description missing');`);
    const renamedPlace = (await data.readWorld(renamed.target)).places[0];
    if (renamedPlace.name !== '古 城' || renamedPlace.description !== '用户旧说明' || renamedPlace.custom !== '保留字段') throw new Error('immutable place operation lost its original field binding');
    await screenshot('authority-name-saved');
    pass('IMPORT_UI19_alternative_name_keeps_original_rejected_fields_through_formal_readback');

    analyzer.executeFinalizeAnalyses = partialFinalize;
    const failedImport = await beginP1Import('authority-failed-cancel'); const copyFile = fs.copyFile;
    fs.copyFile = async (...args) => { if (String(args[0]).endsWith('chapter-001.md')) throw Object.assign(new Error('测试：准备复制失败'), { code: 'EIO' }); return copyFile(...args); };
    try { await flow(`await click('审阅后创建项目'); await wait(() => document.querySelector('[data-import-state="failed"]') && document.body.innerText.includes('测试：准备复制失败'), 'retryable preparation failure missing');`); }
    finally { fs.copyFile = copyFile; }
    await screenshot('authority-failed-preparation');
    await flow(`document.querySelector('[data-testid="import-run-cancel"]').click(); await wait(() => document.querySelector('[data-import-state="cancelled"]') && document.querySelector('[data-testid="import-cancelled"]'), 'failed run did not cancel');`);
    if ((await runsApi.get(failedImport.run.runId)).state !== 'cancelled' || (await promotionApi.get(failedImport.run.importId)).state !== 'cancelled' || await fs.access(failedImport.target).then(() => true, () => false)) throw new Error('failed cancellation has conflicting durable outcomes');
    await screenshot('authority-failed-cancelled');
    pass('IMPORT_UI20_failed_preparation_cancel_has_one_visible_and_durable_terminal');

    async function mergeBoundary(name, committed) {
      sourceFile = path.join(fixtureRoot, name + '.txt'); await fs.writeFile(sourceFile, '第1章 合并边界\n\n' + name + ' 的完整待提交正文。\n');
      analyzer.executeFinalizeAnalyses = async () => ({ status: 'complete', chunkCount: 1 });
      const before = await fs.readFile(path.join(targetDir, 'chapters/chapter-001.md'), 'utf8');
      await flow(`closeImport(); await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件'); await wait(() => document.body.innerText.includes('解析完成：共'), 'merge boundary parse missing');
        document.querySelector('input[name="targetMode"][value="existing"]').click(); await sleep(150); const select = [...document.querySelectorAll('select')].find(visible);
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(registered.id)}); select.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); await click('下一步');
        [...document.querySelectorAll('label')].find((item) => item.textContent.includes('否，原创作品')).click(); await click('下一步'); await click('确认导入并自动分析');
        await wait(() => button('继续（冲突检测）') || button('继续'), 'merge boundary analysis missing'); (button('继续（冲突检测）') || button('继续')).click(); await sleep(200);
        await wait(() => button('接受并进入合并模式') || button('无冲突，直接导入'), 'merge boundary conflicts missing'); (button('接受并进入合并模式') || button('无冲突，直接导入')).click(); await wait(() => button('接受导入版'), 'merge boundary editor missing');`);
      const source = (await stagingApi.listStagingProjects()).find((p) => p.sourceFiles.includes(sourceFile)); const run = await runsApi.findByImportId(source.id);
      const session = await engine.getMergeSession(run.mergeSessionId);
      for (const item of session.items) await flow(`const item = [...document.querySelectorAll('button')].find((b) => b.querySelector('span.truncate')?.textContent === ${JSON.stringify(item.label)}); item.click(); await sleep(100); await click('接受导入版');`);
      const execute = engine.executeMerge, rename = fs.rename; let reached, release, settled, once = true;
      const boundary = new Promise((r) => { reached = r; }), barrier = new Promise((r) => { release = r; }), done = new Promise((r) => { settled = r; });
      if (committed) fs.rename = async (a, b, ...args) => { const result = await rename(a, b, ...args); if (once && b === path.join(require('node:fs').realpathSync(targetDir), 'chapters/chapter-001.md')) { once = false; reached(); await barrier; } return result; };
      engine.executeMerge = async (id, authority) => { try { return await execute(id, committed ? authority : { ...authority, decide: async (d) => { reached(); await barrier; return authority.decide(d); } }); } finally { settled(); } };
      try {
        await flow(`await click('保存并退出');`); await boundary;
        await flow(`await click('取消本次导入');`);
        if (committed) {
          const deadline = Date.now() + 5000; while ((await runsApi.get(run.runId)).cancelOutcome !== 'already_committed') { if (Date.now() > deadline) throw new Error('merge commit cancellation not arbitrated'); await delay(30); }
        } else {
          await flow(`await wait(() => document.querySelector('[data-testid="merge-import-outcome"][data-import-state="cancelled"]'), 'merge cancellation not acknowledged');`);
          if (await fs.readFile(path.join(targetDir, 'chapters/chapter-001.md'), 'utf8') !== before) throw new Error('merge wrote before its cancellation acknowledgement');
        }
        release(); await done;
        await flow(`await wait(() => document.querySelector('[data-testid="merge-import-outcome"][data-import-state="${committed ? 'completed' : 'cancelled'}"]'), 'late merge response changed its authoritative outcome'); if (${committed} && document.querySelector('[data-testid="merge-import-outcome"] details')) document.querySelector('[data-testid="merge-import-outcome"] details').open = true;`);
        const final = await runsApi.get(run.runId), text = await fs.readFile(path.join(targetDir, 'chapters/chapter-001.md'), 'utf8');
        if (final.state !== (committed ? 'completed' : 'cancelled') || (committed ? !text.includes(name) || !final.result?.receipt : text !== before || final.commitDecision)) throw new Error('merge final data, decision or receipt disagrees with cancellation');
        await screenshot(name); await flow(`await click('关闭合并结果');`);
      } finally { release(); engine.executeMerge = execute; fs.rename = rename; }
    }
    await mergeBoundary('authority-merge-cancel-before', false);
    pass('IMPORT_UI21_pending_compatibility_merge_cannot_write_after_acknowledged_cancellation');
    await mergeBoundary('authority-merge-cancel-after', true);
    pass('IMPORT_UI22_decided_merge_cancellation_reports_saved_data_and_original_receipt');

    analyzer.executeFinalizeAnalyses = partialFinalize;
    sourceFile = path.join(fixtureRoot, 'authority-source-recovery.txt'); await fs.writeFile(sourceFile, '第1章 来源恢复\n\n来源快照重载之后仍完整。\n');
    const createStaging = stagingApi.createStagingProject; let sourceFault = true;
    stagingApi.createStagingProject = async (...args) => { if (sourceFault) { sourceFault = false; throw Object.assign(new Error('测试：暂存创建前中断'), { code: 'EIO' }); } return createStaging(...args); };
    try {
      await flow(`await click('小说'); await click('导入外部小说文件'); await click('点击选择文件'); await click('解析文件'); await wait(() => document.body.innerText.includes('解析完成：共'), 'source recovery parse missing'); await click('下一步');
        [...document.querySelectorAll('label')].find((item) => item.textContent.includes('否，原创作品')).click(); await click('下一步'); await click('选择父目录'); await click('开始导入并分析');
        await wait(() => document.querySelector('[data-import-state="failed"]') && document.body.innerText.includes('测试：暂存创建前中断'), 'source failure not visible');`);
    } finally { stagingApi.createStagingProject = createStaging; }
    const sourceRun = (await runsApi.listActive()).find((r) => r.sourceFiles.includes(sourceFile));
    if (!sourceRun || sourceRun.importId || !sourceRun.parsed?.chapters?.length) throw new Error('source checkpoint should precede staging identity');
    await screenshot('authority-source-interrupted');
    mainWindow.webContents.reload(); await delay(1000);
    await flow(`await click('小说'); await click('导入外部小说文件'); await wait(() => document.querySelector('[data-testid="import-restore-${sourceRun.runId}"]'), 'pre-staging recovery entry missing').then((b) => b.click()); await wait(() => document.querySelector('[data-testid="import-partial-analysis"]'), 'saved source did not resume through analysis'); await click('审阅后创建项目'); await wait(() => document.querySelector('[data-import-state="completed"]'), 'source recovery did not reach formal project'); document.querySelector('[data-testid="import-promotion-receipt"]').open = true;`);
    const sourceResult = await runsApi.get(sourceRun.runId);
    if (!sourceResult.result?.receipt || !(await fs.readFile(path.join(sourceResult.result.dir, 'chapters/chapter-001.md'), 'utf8')).includes('来源快照重载之后仍完整。')) throw new Error('source snapshot or receipt lost during recovery');
    const meta = JSON.parse(await fs.readFile(path.join(sourceResult.result.dir, 'novel.json')));
    assert.deepEqual(meta.fanwork, sourceRun.parsed.metadata.fanwork);
    await screenshot('authority-source-recovered');
    pass('IMPORT_UI23_pre_staging_checkpoint_reload_keeps_source_metadata_and_formal_receipt');
  } catch (error) {
    const failureShot = path.join(artifactDir, 'failure.png');
    await fs.writeFile(failureShot, (await mainWindow.capturePage()).toPNG());
    console.log('TEST_SCREENSHOT ' + failureShot);
    fail('IMPORT_UI_FLOW', error);
    console.log(error?.stack || error);
  } finally {
    dialog.showOpenDialog = originalDialog;
    analyzer.executeStartAnalyses = originalStart;
    analyzer.executeFinalizeAnalyses = originalFinalize;
    nativeService.runOneShot = originalOneShot;
    enrichmentService.enrichCharacters = originalEnrich;
  }
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  return results;
}

module.exports = { runImportSagaUiRegressionTest };
