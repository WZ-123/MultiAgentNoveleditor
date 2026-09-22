'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/main/modelConfig');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runCodexSubscriptionUiE2E(win) {
  let passed = 0;
  const assert = (value, message) => { if (!value) throw new Error(message); passed++; };
  const evaluate = (source) => win.webContents.executeJavaScript(source, true);
  const wait = async (expression, timeout = 180000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await evaluate(`Boolean(${expression})`)) return; await delay(150); }
    throw new Error(`Subscription UI timeout: ${expression}`);
  };
  const click = (text) => evaluate(`[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)} && item.offsetParent!==null).click()`);
  win.webContents.setAudioMuted(true); win.setSize(1440, 960); win.show();
  await wait(`document.querySelector('[title="模型配置"]')`);
  await evaluate(`document.querySelector('[title="模型配置"]').click()`);
  await wait(`document.querySelector('[data-testid="responses-config-v8"]')`);
  await click('添加模型服务'); await click('订阅登录');
  const account = await evaluate(`mana.codex.accountStatus()`);
  if (account.account?.type !== 'chatgpt') { await click('浏览器登录'); }
  await wait(`[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='刷新列表'&&!item.disabled)`);
  assert(!(await evaluate(`document.querySelector('[data-testid="codex-subscription-setup"]').innerText.includes('API Key')`)), 'subscription flow should not request API Key');
  const prior = (await config.load()).activeSelection;
  await click('刷新列表');
  await wait(`document.querySelector('[data-testid="select-model-gpt-5.6-luna"]') && ![...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='刷新列表').disabled`);
  assert(JSON.stringify((await config.load()).activeSelection) === JSON.stringify(prior), 'refresh must preserve active model');
  await evaluate(`document.querySelector('[data-testid="codex-subscription-setup"] [data-testid="select-model-gpt-5.6-luna"]').click()`);
  await click('使用此模型');
  await wait(`document.querySelector('[data-testid="active-model-summary"]').innerText.includes('medium')`);
  const selected = (await config.load()).activeSelection;
  assert(selected?.modelId === 'gpt-5.6-luna' && selected.reasoningEffort === 'medium', 'explicit Luna medium selection must activate');
  const screenshotPath = path.join(__dirname, '..', 'qa-screenshots', 'codex-subscription-luna-medium.png');
  await evaluate(`document.querySelector('[data-testid="codex-subscription-setup"]').scrollIntoView({block:'start'})`); await delay(200);
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true }); await fs.writeFile(screenshotPath, (await win.webContents.capturePage()).toPNG());
  console.log(`codex-subscription-ui: ok (${passed} checks)`);
  return { passed, failed: 0, screenshotPath };
}
module.exports = { runCodexSubscriptionUiE2E };
