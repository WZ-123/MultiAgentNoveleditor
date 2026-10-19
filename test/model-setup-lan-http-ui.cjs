'use strict';
// Real Chromium, production LAN authentication/bridge, model IPC and setup store.
// Only provider discovery is served by a local fixture. No real credentials.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.MANA_AUTOMATED_TEST = '1';
process.env.MANA_USER_DATA_ROOT = path.join(root, 'tmp-test-model-setup-lan-http');
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP mana-lan-test.invalid 127.0.0.1');
app.setPath('userData', process.env.MANA_USER_DATA_ROOT);
let win, remote, fake;
app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'direct' });
    await require('../src/main/index').initBackend();
    remote = require('../src/main/lan/remoteServer');
    fake = await require('./fixtures/fake-responses-server').createFakeResponsesServer({ models: [{ id: 'lan-fixture' }] });
    const status = await remote.start({ host: '127.0.0.1', port: 0 });
    const origin = `http://mana-lan-test.invalid:${status.port}`;
    assert.equal((await fetch(`http://127.0.0.1:${status.port}/api/lan/status`)).status, 401);
    win = new BrowserWindow({ width: 1200, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    const wait = async source => {
      const until = Date.now() + 25000;
      while (Date.now() < until) { if (await evaluate(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('LAN UI timed out: ' + source + '\n' + await evaluate('document.body.innerText.slice(-1500)'));
    };
    await win.loadURL(origin);
    await evaluate(`document.querySelector('#code').value=${JSON.stringify(status.accessCode)}; document.querySelector('form').requestSubmit();`);
    await wait(`!!document.querySelector('[title="模型配置"]')`);
    assert.deepEqual(await evaluate(`({secure:isSecureContext,uuid:typeof crypto.randomUUID,random:typeof crypto.getRandomValues})`), { secure: false, uuid: 'undefined', random: 'function' });
    await evaluate(`document.querySelector('[title="模型配置"]').click()`);
    await wait(`!!document.querySelector('[data-testid="responses-config-v8"]')`);
    await evaluate(`window.qa={click(text){const button=[...document.querySelectorAll('button')].find(b=>b.offsetParent!==null&&b.textContent.trim()===text);if(!button||button.disabled)throw new Error('Unavailable '+text);button.click()},set(label,value){const el=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}};qa.click('添加模型服务')`);
    await evaluate(`qa.set('模型服务','auto')`);
    await evaluate(`qa.set('供应商 URL',${JSON.stringify(fake.origin)});qa.set('API Key','lan-fixture-key')`);
    await wait(`!!document.querySelector('[data-testid="discovery-preview"]')`);
    await evaluate(`qa.click('检测模型')`);
    const config = require('../src/main/modelConfig');
    const getOperation = async count => {
      const until = Date.now() + 25000;
      while(Date.now()<until) { const ops=(await config.load()).setupOperations; if(ops.length===count&&ops.at(-1).status==='awaiting_model')return ops.at(-1); await new Promise(resolve=>setTimeout(resolve,50)); }
      throw new Error('LAN setup operation not persisted');
    };
    const first = await getOperation(1);
    assert.match(first.id, /^[a-f0-9-]{36}$/);
    await wait(`!!document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]')`);
    await evaluate(`document.querySelector('[aria-label="关闭配置"]').click()`);
    await wait(`!!document.querySelector('[data-testid="pending-setups"]')`);
    await evaluate(`document.querySelector('[data-testid="pending-setups"]').open=true;qa.click('继续配置')`);
    await wait(`!!document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]')`);
    assert.equal((await config.load()).setupOperations[0].id, first.id);
    await evaluate(`qa.click('修改接入信息')`);
    await wait(`!!document.querySelector('[data-testid="discovery-preview"]')`);
    await evaluate(`qa.click('检测模型')`);
    const second = await getOperation(2);
    assert.notEqual(second.id, first.id);
    assert.equal(second.credentialId, first.credentialId);
    assert.equal((await config.load()).credentials.length, 1);
    assert.equal((await config.load()).activeSelection, null);
    await wait(`!!document.querySelector('[data-testid="setup-editor"] [data-testid="model-list"]')`);
    const shot = path.join(root, 'qa-screenshots/model-setup-lan-http.png');
    await fs.mkdir(path.dirname(shot), { recursive: true });
    await fs.writeFile(shot, (await win.webContents.capturePage()).toPNG());
    console.log('model-setup-lan-http-ui: ok (insecure HTTP; auth 401; add; resume preserves ID; edit renews ID; credential reused; active model unchanged)');
    win.destroy(); await remote.stop(); await fake.close(); app.exit(0);
  } catch(error) {
    console.error(error); win?.destroy(); await remote?.stop(); await fake?.close(); app.exit(1);
  }
});
