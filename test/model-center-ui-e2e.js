'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runModelCenterUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0, screenshots: [] };
  const pass = (name, detail) => { results.total += 1; results.passed += 1; console.log(`TEST_PASS ${name}${detail ? `: ${detail}` : ''}`); };
  const fail = (name, reason) => { results.total += 1; results.failed += 1; console.log(`TEST_FAIL ${name}: ${reason}`); };

  const evaluate = (source) => mainWindow.webContents.executeJavaScript(source, true);
  const screenshot = async (name) => {
    const dir = path.join(ROOT, 'qa-screenshots');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    const image = await mainWindow.webContents.capturePage();
    await fs.writeFile(file, image.toPNG());
    results.screenshots.push(file);
    console.log(`TEST_SCREENSHOT ${file}`);
    return file;
  };

  try {
    mainWindow.setMinimumSize(900, 700);
    mainWindow.setSize(1280, 860);
    mainWindow.show();
    await delay(500);

    const opened = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 10000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(100); } return null; };
        const button = await wait(() => document.querySelector('[title="模型配置"]'));
        if (!button) return { ok: false, step: 'activity_button' };
        button.click();
        const title = await wait(() => Array.from(document.querySelectorAll('*')).find((el) => el.textContent === '模型中心'));
        return { ok: !!title, body: (document.body.innerText || '').slice(0, 800) };
      })()
    `);
    if (opened.ok) pass('MCUI_T1_open_model_center', '模型中心可从 Activity Bar 打开');
    else throw new Error(`模型中心未打开：${JSON.stringify(opened)}`);

    const overview = await evaluate(`(() => ({
      schema: document.body.innerText.includes('Schema v3'),
      tabs: ['总览','Provider','模型档案','分配矩阵'].every((text) => Array.from(document.querySelectorAll('button')).some((button) => button.textContent.includes(text))),
      environment: document.body.innerText.includes('配置环境'),
      error: document.body.innerText.includes('模型配置 IPC 不可用'),
    }))()`);
    if (overview.schema && overview.tabs && overview.environment && !overview.error) pass('MCUI_T2_overview_complete', JSON.stringify(overview));
    else fail('MCUI_T2_overview_complete', JSON.stringify(overview));
    await screenshot('model-center-v3-overview.png');

    const providerCreated = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 8000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        const clickText = (text) => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === text); if (button) button.click(); return !!button; };
        clickText('Provider'); await sleep(100); clickText('新增 Provider');
        const editor = await wait(() => document.querySelector('[data-testid="provider-editor"]'));
        const inputs = Array.from(editor?.querySelectorAll('input') || []);
        const byPlaceholder = (placeholder) => inputs.find((input) => input.placeholder === placeholder);
        const set = (input, value) => { if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true; };
        const named = set(inputs.find((input) => input.type === 'text' && !input.placeholder), 'UI Test Provider');
        const base = set(byPlaceholder('https://api.example.com/v1'), 'https://ui-test.invalid/anthropic');
        const password = set(document.querySelector('input[type="password"]'), 'ui-test-secret');
        clickText('手动添加'); await sleep(50);
        const modelId = set(byPlaceholder('模型 ID') || Array.from(document.querySelectorAll('input')).find((input) => input.placeholder === '模型 ID'), 'ui-test-model');
        const displayName = set(byPlaceholder('显示名称') || Array.from(document.querySelectorAll('input')).find((input) => input.placeholder === '显示名称'), 'UI Test Model');
        const saved = clickText('保存 Provider');
        const visible = await wait(() => document.body.innerText.includes('Provider 已保存') && document.body.innerText.includes('UI Test Provider'));
        return { ok: !!visible, named, base, password, modelId, displayName, saved, body: (document.body.innerText || '').slice(-1000) };
      })()
    `);
    if (providerCreated.ok) pass('MCUI_T3_provider_create_flow', '表单→IPC→Store→列表完整可见');
    else fail('MCUI_T3_provider_create_flow', JSON.stringify(providerCreated));
    await screenshot('model-center-v3-providers.png');

    const configRaw = await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'model-config.json'), 'utf8');
    const secretRaw = await fs.readFile(path.join(process.env.MANA_USER_DATA_ROOT, 'secrets.json'), 'utf8');
    if (!configRaw.includes('ui-test-secret') && !secretRaw.includes('ui-test-secret')) pass('MCUI_T4_secret_not_plaintext', '公开配置和安全存储均无明文密钥');
    else fail('MCUI_T4_secret_not_plaintext', '检测到明文 API Key');

    const profileAndAssignment = await evaluate(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const wait = async (fn, timeout = 8000) => { const start = Date.now(); while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(80); } return null; };
        const button = (text) => Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === text);
        button('模型档案')?.click(); await sleep(100); button('新增档案')?.click();
        const editor = await wait(() => document.querySelector('[data-testid="profile-editor"]'));
        const inputs = Array.from(editor?.querySelectorAll('input') || []);
        const firstText = inputs.find((input) => input.type === 'text' && !input.placeholder);
        if (firstText) { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(firstText, 'UI 长篇写作'); firstText.dispatchEvent(new Event('input', { bubbles: true })); firstText.dispatchEvent(new Event('change', { bubbles: true })); }
        const selects = Array.from(document.querySelectorAll('select'));
        const providerSelect = selects.find((select) => Array.from(select.options).some((option) => option.textContent === 'UI Test Provider'));
        if (providerSelect) { providerSelect.value = 'ui-test-provider'; providerSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        await sleep(80);
        const modelSelect = Array.from(document.querySelectorAll('select')).find((select) => Array.from(select.options).some((option) => option.value === 'ui-test-model'));
        if (modelSelect) { modelSelect.value = 'ui-test-model'; modelSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        button('保存档案')?.click();
        const profileSaved = await wait(() => document.body.innerText.includes('模型档案已保存') && document.body.innerText.includes('UI 长篇写作'));
        button('分配矩阵')?.click(); await sleep(100);
        const chatRow = Array.from(document.querySelectorAll('div')).find((div) => div.textContent.trim().startsWith('主聊天') && div.querySelector('select'));
        const chatSelect = chatRow?.querySelector('select');
        const profileOption = chatSelect && Array.from(chatSelect.options).find((option) => option.textContent === 'UI 长篇写作');
        if (chatSelect && profileOption) { chatSelect.value = profileOption.value; chatSelect.dispatchEvent(new Event('change', { bubbles: true })); }
        button('保存分配')?.click();
        const routingSaved = await wait(() => document.body.innerText.includes('模型分配已保存'));
        return { ok: !!profileSaved && !!routingSaved, profile: profileOption?.value || '', body: (document.body.innerText || '').slice(0, 1000) };
      })()
    `);
    if (profileAndAssignment.ok) pass('MCUI_T5_profile_assignment_flow', profileAndAssignment.profile);
    else fail('MCUI_T5_profile_assignment_flow', JSON.stringify(profileAndAssignment));

    const modelConfig = require(path.join(ROOT, 'src/main/modelConfig'));
    const preview = await modelConfig.resolvePreview({ driverId: 'direct-api', systemTask: 'chat' });
    if (preview[0]?.modelId === 'ui-test-model') pass('MCUI_T6_runtime_preview_matches_ui', JSON.stringify(preview[0]));
    else fail('MCUI_T6_runtime_preview_matches_ui', JSON.stringify(preview));

    const assignmentShot = await screenshot('model-center-v3-assignments.png');
    const dom = await evaluate(`(() => ({
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      hasError: /IPC 不可用|Cannot read|undefined is not/.test(document.body.innerText),
      visibleButtons: Array.from(document.querySelectorAll('button')).filter((button) => button.offsetParent !== null).map((button) => button.textContent.trim()).filter(Boolean).slice(0, 30),
    }))()`);
    if (!dom.hasHorizontalOverflow && !dom.hasError) pass('MCUI_B1_layout_and_error_state', JSON.stringify(dom));
    else fail('MCUI_B1_layout_and_error_state', JSON.stringify(dom));
    console.log(`TEST_SCREENSHOT ${assignmentShot}`);
  } catch (err) {
    fail('MCUI_HARNESS', err.stack || err.message || String(err));
  }

  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runModelCenterUiRegressionTest };
