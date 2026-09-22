'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const modelConfig = require('../src/main/modelConfig');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'qa-screenshots');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(win, expression, timeout = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(150);
  }
  throw new Error(`UI wait timed out: ${expression}`);
}

async function screenshot(win, name) {
  await fsp.mkdir(SHOTS, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOTS, name);
  await fsp.writeFile(file, image.toPNG());
  return file;
}

async function readExistingDeepSeekKey() {
  const sourceRoot = String(process.env.MANA_DEEPSEEK_KEY_SOURCE_ROOT || '').trim();
  if (!sourceRoot) throw new Error('MANA_DEEPSEEK_KEY_SOURCE_ROOT missing');
  const config = JSON.parse(await fsp.readFile(path.join(sourceRoot, 'model-config.json'), 'utf8'));
  const credential = config.credentials?.find((item) => /deepseek/i.test(`${item.id} ${item.name}`));
  if (!credential?.secretRef) throw new Error('No reusable DeepSeek credential found in source root');
  const secretStore = JSON.parse(await fsp.readFile(path.join(sourceRoot, 'secrets.json'), 'utf8'));
  const record = secretStore.records?.[credential.secretRef];
  const value = record?.plain === true ? String(record.value || '') : '';
  if (!value) throw new Error('DeepSeek credential is not readable from local private storage');
  return value;
}

async function runDeepSeekLiveProviderUiE2E(win) {
  const results = { passed: 0, failed: 0, screenshots: [] };
  const assert = (condition, message) => {
    if (!condition) { results.failed += 1; throw new Error(message); }
    results.passed += 1;
  };
  const apiKey = await readExistingDeepSeekKey();
  win.setSize(1440, 960);
  win.show();
  await waitFor(win, `document.querySelector('[title="模型配置"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('[title="模型配置"]').click()`, true);
  await waitFor(win, `document.querySelector('[data-testid="responses-config-v8"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='添加模型服务').click()`, true);
  await waitFor(win, `document.querySelector('[aria-label="API Key"]')`);
  const target = await win.webContents.executeJavaScript(`document.querySelector('[aria-label="供应商 URL"]').value==='https://api.deepseek.com'`, true);
  assert(target, 'DeepSeek preset did not show the official Responses target URL');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="API Key"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(apiKey)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await waitFor(win, `document.querySelector('[data-testid="discovery-preview"]')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='检测模型').click()`, true);
  await waitFor(win, `document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]')`, 240_000);
  // This live regression deliberately exercises explicit none, independent of the default.
  await win.webContents.executeJavaScript(`(() => { const select=document.querySelector('[aria-label="思考档位"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'__custom');select.dispatchEvent(new Event('change',{bubbles:true}));})()`, true);
  await waitFor(win, `document.querySelector('[aria-label="自定义思考档位"]')`);
  await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('[aria-label="自定义思考档位"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'none');input.dispatchEvent(new Event('input',{bubbles:true}));})()`, true);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='验证并使用').click()`, true);
  await waitFor(win, `document.querySelector('[data-testid="active-model-summary"]').innerText.includes('可操作小说')`, 240_000);
  const publicText = await win.webContents.executeJavaScript(`document.body.innerText`, true);
  assert(!publicText.includes(apiKey), 'API key leaked into the renderer text snapshot');
  assert(publicText.includes('https://api.deepseek.com'), 'configured DeepSeek base URL is missing');
  assert(!publicText.includes('api.deepseek.com/anthropic'), 'legacy Anthropic path leaked into the Responses connection');
  results.screenshots.push(await screenshot(win, 'deepseek-v4-flash-live-provider-active.png'));

  const snapshot = await modelConfig.publicSnapshot();
  const connection = snapshot.connections.find((item) => item.baseUrl === 'https://api.deepseek.com');
  const flash = connection?.models.find((item) => item.id === snapshot.activeSelection?.modelId);
  assert(!!flash && /flash/i.test(flash.id), 'the discovered Flash model was not selected');
  assert(connection?.modelsUrl === 'https://api.deepseek.com/models', 'DeepSeek models URL is incorrect');
  assert(flash?.verification.responses === 'ok', 'Flash Responses verification did not persist');
  assert(flash?.verification.tools === 'ok', 'Flash MCP tool verification did not persist');
  assert(snapshot.activeSelection?.connectionId === connection.id && snapshot.activeSelection?.modelId === flash.id, 'Flash was not activated');
  assert(snapshot.activeSelection?.reasoningEffort === 'none', 'Flash no-reasoning mode was not actually verified and activated');
  assert(flash?.verification.verifiedEfforts?.includes('none'), 'Flash no-reasoning verification did not persist');

  await win.webContents.executeJavaScript(`document.querySelector('[title="AI 聊天"]').click()`, true);
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled`);
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-testid="codex-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '只回复：DeepSeek V4 Flash 生产连接已可用');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="发送"]').click();
  })()`, true);
  await waitFor(win, `[...document.querySelectorAll('[data-testid="codex-message-assistant"]')].some((item) => item.innerText.includes('DeepSeek V4 Flash 生产连接已可用')) && !document.querySelector('button[aria-label="停止"]')`, 180_000);
  const body = await win.webContents.executeJavaScript(`document.body.innerText`, true);
  assert(!body.includes('turn_failed') && !body.includes('404 Not Found'), 'real Flash chat surfaced a runtime error');
  results.screenshots.push(await screenshot(win, 'deepseek-v4-flash-live-chat.png'));
  console.log(`deepseek-live-provider-ui: ok (${results.passed} checks)`);
  return results;
}

module.exports = { runDeepSeekLiveProviderUiE2E };
