'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ipcMain } = require('electron');
const config = require('../src/main/modelConfig');
const { getCodexSessionService } = require('../src/main/codex-runtime');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runResponsesConfigV6UiE2E(win) {
  const root = path.resolve(__dirname, '..');
  const result = { passed: 0, failed: 0, screenshots: [] };
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); console.error('RENDERER_ERROR', event.message); } });
  const assert = (value, label) => { if (!value) throw new Error(label); result.passed++; console.log(`TEST_PASS ${label}`); };
  const evaluate = (source) => win.webContents.executeJavaScript(source, true);
  const shot = async (name, selector) => {
    if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);
    await delay(180);
    const file = path.join(root, 'qa-screenshots', name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, (await win.webContents.capturePage()).toPNG()); result.screenshots.push(file);
  };
  let account = null;
  let refreshCount = 0;
  const service = getCodexSessionService();
  const priorAccountStatus = service.accountStatus.bind(service);
  service.accountStatus = async () => ({ account });
  const replaceHandler = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, async (_event, input = {}) => { try { return { ok: true, value: await fn(input) }; } catch (error) { return { ok: false, error: error.message, code: error.code }; } }); };
  replaceHandler('mana:codex:accountStatus', async () => ({ account }));
  replaceHandler('mana:codex:accountLogin', async () => {
    setTimeout(() => { account = { type: 'chatgpt', email: 'qa@example.invalid' }; win.webContents.send('mana:codex:event', { type: 'account_login_completed' }); }, 100);
    return { loginId: 'fixture-login' };
  });
  replaceHandler('mana:codex:refreshSubscriptionModels', async ({ expectedRevision }) => {
    refreshCount++;
    const state = await config.saveCodexSubscription([{ id: 'gpt-5.6-luna', capabilities: { reasoningEfforts: ['low', 'medium', 'high'] } }, { id: 'gpt-5.6-sol', capabilities: { reasoningEfforts: ['low', 'medium'] } }], expectedRevision);
    win.webContents.send('mana:modelConfig:changed', { action: 'fixture-subscription' });
    return { state, account };
  });
  win.setMinimumSize(760, 700); win.setSize(1280, 900); win.webContents.setAudioMuted(true); win.show();
  try {
    await evaluate(`window.qa = {
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      async wait(fn, timeout = 25000) { const start=Date.now(); while(Date.now()-start<timeout) { const value=await fn(); if(value)return value instanceof Element ? true : value; await this.sleep(80); } throw new Error('QA wait timed out: '+fn.toString()+'\\n'+document.body.innerText.slice(-1600)); },
      click(text, root=document) { const button=[...root.querySelectorAll('button')].find(item=>item.textContent.trim()===text && item.offsetParent!==null); if(!button)throw new Error('Missing button '+text); if(button.disabled)throw new Error('Disabled button '+text); button.click(); },
      set(label, value, root=document) { const el=root.querySelector('[aria-label="'+label+'"]'); if(!el)throw new Error('Missing field '+label); Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); },
      async op(status) { return this.wait(async()=>{const ops=await mana.modelConfig.querySetup(); return ops.findLast(item=>item.status===status);}); }
    }; true;`);
    await evaluate(`(async()=>{await qa.wait(()=>document.querySelector('[title="模型配置"]'));document.querySelector('[title="模型配置"]').click(); await qa.wait(()=>document.querySelector('[data-testid="responses-config-v8"]'));})()`);
    assert(await evaluate(`document.querySelector('[data-testid="active-model-summary"]').innerText.includes('尚未选择模型')`), 'empty state');
    await shot('model-config-v8-empty.png', '[data-testid="responses-config-v8"]');
    await evaluate(`qa.click('添加模型服务');`);
    await evaluate(`qa.set('模型服务','auto');`);
    await evaluate(`qa.set('供应商 URL',${JSON.stringify(process.env.MANA_RESPONSES_UI_ORIGIN)}); qa.set('API Key','ui-secret');`);
    await evaluate(`(async()=>{await qa.wait(()=>document.querySelector('[data-testid="discovery-preview"]'));qa.click('检测模型');await qa.op('awaiting_model');await qa.wait(()=>document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]'));})()`);
    assert(await evaluate(`document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]').querySelectorAll('[data-testid^="select-model-"]').length===20`), '500 models paginated to 20');
    assert(await evaluate(`document.querySelector('[data-testid="setup-editor"]').innerText.includes('500 个模型')`), '500-model count');
    await evaluate(`qa.click('下一页',document.querySelector('[data-testid="setup-editor"]'));`);
    assert(await evaluate(`document.querySelector('[data-testid="setup-editor"]').innerText.includes('2 / 25 页')`), 'pagination works');
    await evaluate(`qa.set('搜索模型','a-fixture-model',document.querySelector('[data-testid="setup-editor"]'));`);
    assert(await evaluate(`document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]').querySelectorAll('[data-testid^="select-model-"]').length===1`), 'model search');
    await shot('model-config-v8-selection.png', '[data-testid="setup-editor"]');
    await evaluate(`qa.click('验证并使用');`);
    await evaluate(`qa.op('failed')`);
    assert(await evaluate(`document.querySelector('[data-testid="setup-progress"]').innerText.includes('Fixture text verification rejected')`), 'text failure shown inline');
    const first = (await config.load()).setupOperations[0];
    await evaluate(`qa.click('验证并使用');`);
    await evaluate(`qa.op('awaiting_chat')`);
    assert(await evaluate(`document.querySelector('[data-testid="setup-progress"]').innerText.includes('仅用于聊天')`), 'tools failure offers chat-only');
    assert((await config.load()).activeSelection === null, 'tool failure does not auto-activate');
    await shot('model-config-v8-tools-failed.png', '[data-testid="setup-progress"]');
    await evaluate(`qa.click('仅用于聊天');`);
    await evaluate(`qa.op('complete')`);
    await evaluate(`qa.wait(()=>document.querySelector('[data-testid="active-model-summary"]').innerText.includes('仅聊天'))`);
    assert((await config.load()).credentials.length === 1, 'retries reuse one credential');
    assert((await config.load()).connections.length === 1, 'retries reuse one connection');
    await evaluate(`document.querySelector('[aria-label="关闭配置"]').click()`);
    await shot('model-config-v8-chat-only.png', '[data-testid="responses-config-v8"]');
    await evaluate(`(async()=>{const summary=[...document.querySelectorAll('summary')].find(item=>item.textContent.includes('500 个模型'));summary.click();await qa.sleep(100);document.querySelector('[data-testid="select-model-a-fixture-model"]').click();await qa.op('awaiting_model');})()`);
    await evaluate(`qa.wait(()=>document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]'))`);
    await evaluate(`qa.set('搜索模型','a-fixture-model',document.querySelector('[data-testid="setup-editor"]'));qa.click('验证并使用');`);
    await evaluate(`qa.wait(async()=>(await mana.modelConfig.querySetup()).filter(item=>item.status==='complete').length===2)`);
    assert((await config.activeRoute()).model.verification.tools === 'ok', 'retry only tools and enable novel operations');
    await evaluate(`qa.wait(()=>[...document.querySelectorAll('button')].some(item=>item.textContent.trim()==='修改模型 / 参数'));qa.click('修改模型 / 参数');`);
    await evaluate(`qa.wait(()=>{const field=document.querySelector('[aria-label="上下文窗口"]');return field && !field.matches(':disabled');})`);
    await evaluate(`document.querySelector('[aria-label="上下文窗口"]').closest('details').open=true;qa.set('上下文窗口','131072');`);
    await evaluate(`qa.set('最大输出 Tokens','8192');`);
    await evaluate(`qa.set('工具能力','true');`);
    await evaluate(`qa.set('结构化输出','false');`);
    assert((await config.activeRoute()).model.capabilities.contextWindow === 256000, 'parameter draft preserves active settings');
    await evaluate(`qa.click('验证并使用');qa.wait(async()=>(await mana.modelConfig.querySetup()).filter(item=>item.status==='complete').length===3)`);
    const edited = (await config.activeRoute()).model;
    assert(edited.capabilities.contextWindow === 131072 && edited.capabilities.maxOutputTokens === 8192 && edited.capabilities.supportsStructuredOutput === false, 'completed setup edits persist after verification');
    assert(edited.fieldSources.contextWindow === 'manual', 'manual parameter provenance persists');
    await evaluate(`qa.wait(()=>document.querySelector('[data-testid="capability-verification"]').innerText.includes('已通过'))`);
    await shot('model-config-capabilities-complete.png', '[data-testid="model-capabilities"]');
    await evaluate(`qa.click('修改模型 / 参数');qa.wait(()=>{const field=document.querySelector('[aria-label="上下文窗口"]');return field && !field.matches(':disabled') && field.value==='131072';})`);
    assert(await evaluate(`document.querySelector('[aria-label="最大输出 Tokens"]').value==='8192'`), 'reopened editor retains manual parameters');
    await evaluate(`document.querySelector('[data-testid="model-capabilities"]').open=true;`);
    await shot('model-config-capabilities-editable.png', '[data-testid="model-capabilities"]');
    await evaluate(`document.querySelector('[aria-label="关闭配置"]').click()`);
    // New URL is held in a draft and cannot silently save the previous discovery.
    await evaluate(`qa.click('编辑 / 刷新模型');`);
    await evaluate(`qa.set('供应商 URL',${JSON.stringify(process.env.MANA_RESPONSES_UI_ORIGIN + '/v1')});`);
    assert((await config.load()).connections[0].baseUrl === process.env.MANA_RESPONSES_UI_ORIGIN, 'editing URL preserves active route before verification');
    assert(await evaluate(`![...document.querySelector('[data-testid="setup-editor"]').querySelectorAll('button')].some(item=>item.textContent.includes('保存连接'))`), 'stale-save button removed');
    await evaluate(`document.querySelector('[aria-label="关闭配置"]').click();qa.click('添加模型服务');`);
    await evaluate(`qa.click('订阅登录');`);
    await evaluate(`qa.click('浏览器登录');`);
    await evaluate(`qa.wait(()=>document.querySelector('[data-testid="codex-subscription-setup"]').innerText.includes('gpt-5.6-luna'))`);
    assert(refreshCount === 1, 'login automatically loads subscription models once');
    assert((await config.load()).activeSelection.connectionId === first.connectionId, 'login leaves API model active until selected');
    await evaluate(`qa.wait(()=>![...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='刷新列表').disabled)`);
    await evaluate(`qa.click('刷新列表');`);
    await evaluate(`qa.wait(()=>![...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='刷新列表').disabled)`);
    assert((await config.load()).activeSelection.connectionId === first.connectionId, 'refresh leaves current model unchanged');
    await shot('model-config-v8-subscription.png', '[data-testid="setup-editor"]');
    await evaluate(`document.querySelector('[aria-label="关闭配置"]').click()`);
    await evaluate(`qa.click('添加模型服务');`);
    await evaluate(`qa.set('模型服务','auto');`);
    await evaluate(`qa.set('供应商 URL',${JSON.stringify(process.env.MANA_RESPONSES_UI_ORIGIN + '?manual=1')});qa.set('API 凭据',${JSON.stringify(first.credentialId)});`);
    await evaluate(`(async()=>{await qa.wait(()=>document.querySelector('[data-testid="discovery-preview"]'));qa.click('检测模型');await qa.wait(async()=>(await mana.modelConfig.querySetup()).find(item=>item.inputUrl.endsWith('?manual=1')&&item.status==='failed'));})()`);
    await evaluate(`qa.set('手动模型 ID','a-fixture-model');`);
    await evaluate(`qa.click('确认地址并添加模型');`);
    await evaluate(`qa.wait(async()=>(await mana.modelConfig.querySetup()).find(item=>item.inputUrl.endsWith('?manual=1')&&item.status==='awaiting_model'))`);
    assert(await evaluate(`document.querySelector('[data-testid="setup-editor"]').innerText.includes('手动模型')`), 'manual ID available when listing fails');
    await shot('model-config-v8-manual.png', '[data-testid="setup-progress"]');
    await evaluate(`qa.click('验证并使用');`);
    await evaluate(`qa.wait(async()=>(await mana.modelConfig.querySetup()).find(item=>item.inputUrl.endsWith('?manual=1')&&item.status==='complete'))`);
    assert((await config.activeRoute()).model.verification.tools === 'ok', 'manual model completes native tool verification');
    assert((await config.load()).credentials.length === 1, 'manual connection reuses existing credential');
    await evaluate(`document.querySelector('[aria-label="关闭配置"]').click()`);
    win.setSize(900, 760); await delay(600);
    await shot('model-config-v8-narrow.png', '[data-testid="responses-config-v8"]');
    assert(await evaluate(`(()=>{const panel=document.querySelector('[data-testid="responses-config-v8"]');return panel.scrollWidth<=panel.clientWidth+1;})()`), 'narrow settings have no horizontal overflow');
    assert(await evaluate(`(()=>{const button=[...document.querySelector('[data-testid="responses-config-v8"]').querySelectorAll('button')].find(item=>item.textContent.includes('添加模型服务'));const r=button.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button;})()`), 'narrow primary action is not covered by chat drawer');
    assert(!JSON.stringify(await config.publicSnapshot()).includes('ui-secret'), 'public snapshot redacts key');
    assert(errors.length === 0, `no renderer errors ${errors.join(';')}`);
    console.log(`responses-config-v8-ui: ok (${result.passed} checks)`);
    return result;
  } finally { service.accountStatus = priorAccountStatus; }
}
module.exports = { runResponsesConfigV6UiE2E };
