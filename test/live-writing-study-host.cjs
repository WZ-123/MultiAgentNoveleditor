'use strict';

// Real Electron UI + real Codex + real DeepSeek. Only OS directory selection
// and transparent transport observation are automated outside the normal UI.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { app, BrowserWindow, dialog } = require('electron');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.MANA_STUDY_ROOT || path.join(ROOT, 'artifacts', 'deepseek-max-100k-2026-09-05'));
const PHASE = process.env.MANA_STUDY_PHASE || 'baseline';
process.env.MANA_USER_DATA_ROOT = path.join(OUT, 'user-data');
process.env.MANA_AUTOMATED_TEST = '1';
process.env.NODE_ENV = 'production';
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
const log = (file, data) => fs.appendFileSync(path.join(OUT, file), `${JSON.stringify({ timestamp: new Date().toISOString(), phase: PHASE, ...data })}\n`);
const save = (file, data) => fs.writeFileSync(path.join(OUT, file), `${JSON.stringify(data, null, 2)}\n`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cjk = text => (String(text).match(/[\u3400-\u9fff]/gu) || []).length;
app.commandLine.appendSwitch('mute-audio');
app.on('web-contents-created', (_event, contents) => { contents.setAudioMuted(true); });
let win, service, current = null, lastEventAt = Date.now(), proxy;
let wireSequence = 0;
const completed = new Set();
for (const row of fs.existsSync(path.join(OUT, 'commands-results.jsonl')) ? fs.readFileSync(path.join(OUT, 'commands-results.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []) completed.add(JSON.parse(row).id);

async function captureProxy() {
  const server = http.createServer(async (request, response) => {
    const id = `http-${Date.now()}-${++wireSequence}`;
    const start = Date.now();
    let count = 0, buffer = '', firstByteAt = null, firstTextAt = null, usage = null, responseStatus = '', requestModel = '', lastProgressAt = Date.now();
    const eventCounts = {};
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw) : {};
      requestModel = body.model || '';
      const input = Array.isArray(body.input) ? body.input : [];
      const refs = [...new Set(JSON.stringify(input).match(/(?:chapter:chapter-\d+\.md|outline:chapter:\d+:\d+:\d+|world:lore|character:[a-z0-9-]+)/gu) || [])];
      log('wire.jsonl', { type: 'request', id, commandId: current?.id, method: request.method, target: `https://api.deepseek.com${request.url}`, model: body.model, reasoning: body.reasoning, maxOutputTokens: body.max_output_tokens, stream: body.stream, inputItems: input.length, inputBytes: Buffer.byteLength(JSON.stringify(input)), requestBytes: raw.length, requestHash: crypto.createHash('sha256').update(raw).digest('hex'), refs, tools: body.tools, });
      if (request.method === 'POST' && (body.model !== 'deepseek-v4-flash' || !['max', 'xhigh'].includes(body.reasoning?.effort))) throw new Error(`Study invariant: unexpected model/effort ${body.model}/${body.reasoning?.effort}`);
      const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      const abort = new AbortController();
      response.on('close', () => { if (!response.writableEnded) abort.abort(); });
      const upstream = await fetch(`https://api.deepseek.com${request.url}`, { method: request.method, headers, ...(raw.length ? { body: raw } : {}), signal: abort.signal });
      log('wire.jsonl', { type: 'headers', id, status: upstream.status, durationMs: Date.now() - start });
      const outgoing = Object.fromEntries([...upstream.headers].filter(([key]) => !['content-encoding', 'content-length', 'connection', 'transfer-encoding'].includes(key)));
      response.writeHead(upstream.status, outgoing);
      for await (const chunk of upstream.body || []) {
        if (!firstByteAt) firstByteAt = Date.now();
        count += chunk.length;
        buffer += Buffer.from(chunk).toString('utf8');
        let split;
        while ((split = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5));
            eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
            if (event.type === 'response.output_text.delta' && !firstTextAt) firstTextAt = Date.now();
            if (event.response?.usage) usage = event.response.usage;
            if (event.response?.status) responseStatus = event.response.status;
            if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type)) log('wire.jsonl', { type: 'terminal', id, event: event.type, status: event.response?.status, model: event.response?.model, usage: event.response?.usage, error: event.response?.error || event.error, incompleteDetails: event.response?.incomplete_details, durationMs: Date.now() - start });
          } catch { /* keep byte-for-byte stream even for comments or partial JSON */ }
        }
        if (!response.write(chunk)) await once(response, 'drain');
        if (Date.now() - lastProgressAt > 5000) {
          log('wire.jsonl', { type: 'progress', id, commandId: current?.id, durationMs: Date.now() - start, bytes: count, firstByteMs: firstByteAt - start, firstTextMs: firstTextAt && firstTextAt - start, eventCounts });
          lastProgressAt = Date.now();
        }
      }
      if (!upstream.ok) log('wire.jsonl', { type: 'http-error', id, status: upstream.status, body: buffer.slice(0, 2000) });
      response.end();
      log('wire.jsonl', { type: 'end', id, commandId: current?.id, model: requestModel, status: upstream.status, responseStatus, durationMs: Date.now() - start, firstByteMs: firstByteAt && firstByteAt - start, firstTextMs: firstTextAt && firstTextAt - start, bytes: count, usage, eventCounts });
    } catch (error) {
      log('wire.jsonl', { type: 'error', id, commandId: current?.id, durationMs: Date.now() - start, error: error.message, cause: error.cause?.code || error.cause?.message });
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const evaluate = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(`Boolean(${code})`)) return; await delay(200); }
  throw new Error(`UI wait exceeded ${timeout} ms: ${code}`);
}
async function shot(name) {
  const file = path.join(OUT, 'screenshots', `${name}.png`);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(100);
  await fsp.writeFile(file, (await win.webContents.capturePage()).toPNG());
  return file;
}
async function setInput(selector, value, tag = 'input') {
  await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});const proto=${tag === 'select' ? 'HTMLSelectElement' : tag === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(${tag === 'select' ? "'change'" : "'input'"},{bubbles:true}));})()`);
  await delay(100);
}
async function inventory() {
  const dir = path.join(OUT, 'novel', 'chapters');
  const chapterCounts = {};
  for (const file of await fsp.readdir(dir).catch(() => [])) if (/\.md$/u.test(file)) chapterCounts[file] = cjk(await fsp.readFile(path.join(dir, file), 'utf8'));
  return { chapterCounts, totalCjk: Object.values(chapterCounts).reduce((a, b) => a + b, 0) };
}

async function execute(command) {
  if (command.action === 'openChapter') {
    const selector = `[data-testid="chapter-tree-item"][data-chapter-file="${command.file}"]`;
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(`document.querySelector('[data-testid="chapter-editor"] .cm-content')?.innerText.length > 500`);
    return { screenshot: await shot(command.id), body: await evaluate('document.body.innerText.slice(0,14000)') };
  }
  if (command.action === 'setEffort') {
    await evaluate(`document.querySelector('[title="模型配置"]')?.click()`);
    await waitFor(`document.querySelector('[data-testid="reasoning-effort-deepseek-v4-flash"]')`);
    await setInput('[data-testid="reasoning-effort-deepseek-v4-flash"]', command.effort, 'select');
    await evaluate(`document.querySelector('[data-testid="reasoning-effort-deepseek-v4-flash"]').parentElement.querySelector('button[title*="验证 Responses"]').click()`);
    await waitFor(`document.body.innerText.includes('Responses 文本验证通过')`, 90000);
    await evaluate(`[...document.querySelector('[data-testid="reasoning-effort-deepseek-v4-flash"]').parentElement.querySelectorAll('button')].find(b=>b.innerText.trim()==='激活').click()`);
    await waitFor(`document.body.innerText.includes('当前 Responses 模型已切换')`, 30000);
    const state = await require('../src/main/modelConfig').publicSnapshot();
    if (state.activeSelection?.reasoningEffort !== command.effort) throw new Error('Requested effort did not activate');
    return { activeSelection: state.activeSelection, screenshot: await shot(command.id) };
  }
  if (command.action === 'configure') {
    await waitFor('document.querySelector(\'[title="模型配置"]\')');
    await evaluate('document.querySelector(\'[title="模型配置"]\').click()');
    await waitFor('document.querySelector(\'[data-testid="preset-provider-effort"]\')');
    await setInput('[data-testid="preset-provider-select"]', 'deepseek', 'select');
    await setInput('[data-testid="preset-provider-effort"]', 'max', 'select');
    const source = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
    const config = JSON.parse(await fsp.readFile(path.join(source, 'model-config.json'), 'utf8'));
    const credential = config.credentials.find(item => /deepseek/iu.test(item.name));
    const records = JSON.parse(await fsp.readFile(path.join(source, 'secrets.json'), 'utf8'));
    const record = records.records[credential.secretRef];
    if (!record?.plain || !record.value) throw new Error('Saved DeepSeek key unavailable');
    await setInput('[data-testid="preset-provider-key"]', record.value);
    await evaluate('document.querySelector(\'[data-testid="preset-provider-submit"]\').click()');
    await waitFor('document.body.innerText.includes("文本与工具验证均通过并已激活") || (document.querySelector(\'[data-testid="preset-provider-submit"]\')?.innerText === "检测并配置" && !document.querySelector(\'[data-testid="preset-provider-key"]\')?.value)', 150000);
    const modelConfig = require('../src/main/modelConfig');
    const state = await modelConfig.publicSnapshot();
    save('provider-public.json', state);
    if (state.activeSelection?.modelId !== 'deepseek-v4-flash' || state.activeSelection?.reasoningEffort !== 'max') throw new Error('max model was not activated');
    await waitFor('!document.querySelector(\'[data-testid="codex-input"]\')?.disabled');
    return { model: state.activeSelection, screenshot: await shot('provider-max-active') };
  }
  if (command.action === 'create') {
    await evaluate(`([...document.querySelectorAll('button')].find(b=>/未打开小说|当前小说|当前作品/.test(b.title)) || [...document.querySelectorAll('button')].find(b=>b.querySelector('svg.lucide-book-open')))?.click()`);
    await waitFor(`[...document.querySelectorAll('input')].some(el=>/小说|标题|名称/.test(el.placeholder))`);
    const selector = await evaluate(`[...document.querySelectorAll('input')].find(el=>/小说|标题|名称/.test(el.placeholder))?.placeholder`);
    await setInput(`input[placeholder=${JSON.stringify(selector)}]`, '逆光档案');
    const novelDir = path.join(OUT, 'novel'); await fsp.mkdir(novelDir, { recursive: true });
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [novelDir] });
    try { await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='新建小说'||b.innerText.trim()==='创建小说'||b.innerText.trim()==='新建').click()`); await waitFor(`document.body.innerText.includes('逆光档案')`); }
    finally { dialog.showOpenDialog = original; }
    const novels = await require('../src/main/store/novels').listNovels();
    save('novel-state.json', novels);
    await evaluate(`document.querySelector('[title="模型配置"]')?.click()`);
    return { novels, screenshot: await shot('novel-created') };
  }
  if (command.action === 'newConversation') {
    await evaluate(`document.querySelector('[data-testid="codex-chat-panel"] > div > div button')?.click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='新对话')`);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='新对话').click()`);
    await waitFor(`document.querySelectorAll('[data-testid^="codex-message-"]').length===0`);
    return {};
  }
  if (command.action === 'screenshot') return { screenshot: await shot(command.id), body: await evaluate('document.body.innerText.slice(-12000)') };
  if (command.action === 'turn') {
    const before = await inventory();
    await waitFor(`document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled && !document.querySelector('button[aria-label="停止"]')`);
    await evaluate(`window.dispatchEvent(new CustomEvent('mana:codex-prompt',{detail:{text:${JSON.stringify(command.text)},skillName:${JSON.stringify(command.skillName || '')}}}))`);
    await waitFor(`document.querySelector('[data-testid="codex-input"]').value.length>0`);
    const started = Date.now(); current.startedAt = started; current.events = []; current.confirmations = [];
    await evaluate(`document.querySelector('button[aria-label="发送"]').click()`);
    await waitFor(`document.querySelector('button[aria-label="停止"]') || document.querySelector('[data-testid="codex-error"]')`, 15000);
    let lastClick = 0;
    while (Date.now() - started < (command.timeoutMs || 900000)) {
      const state = await evaluate(`({running:!!document.querySelector('button[aria-label="停止"]'),error:document.querySelector('[data-testid="codex-error"]')?.innerText||'',confirmation:document.querySelector('[data-testid="codex-confirmation-card"]')?.innerText||'',reply:[...document.querySelectorAll('[data-testid="codex-message-assistant"]')].at(-1)?.innerText||''})`);
      if (state.confirmation && Date.now() - lastClick > 1000) {
        const activeConfirmation = [...service.pendingConfirmations.keys()].at(-1);
        if (activeConfirmation && !current.confirmations.includes(activeConfirmation)) {
          current.confirmations.push(activeConfirmation);
          log('ui-confirmations.jsonl', { commandId: command.id, confirmationId: activeConfirmation, visiblePreview: state.confirmation });
          if (current.confirmations.length === 1) {
            await evaluate(`document.querySelector('[data-testid="codex-confirmation-card"]')?.scrollIntoView({block:'center'})`);
            await delay(250);
            await shot(`${command.id}-confirmation`);
          }
          await evaluate(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].find(b=>b.innerText.includes('确认写入')&&!b.disabled)?.click()`);
          lastClick = Date.now();
        }
      }
      if (!state.running) {
        await delay(300);
        const after = await inventory();
        const reply = await evaluate(`[...document.querySelectorAll('[data-testid="codex-message-assistant"]')].at(-1)?.innerText||''`);
        return { durationMs: Date.now() - started, status: state.error ? 'failed' : 'completed', error: state.error, reply: current.events.some(event => event.item?.type === 'agentMessage') ? reply : '', before, after, confirmations: current.confirmations, events: current.events };
      }
      await delay(300);
    }
    await evaluate(`document.querySelector('button[aria-label="停止"]')?.click()`);
    await waitFor(`!document.querySelector('button[aria-label="停止"]')`, 30000).catch(() => {});
    return { status: 'interrupted-at-observation-limit', durationMs: Date.now() - started, before, after: await inventory(), confirmations: current.confirmations, events: current.events };
  }
  if (command.action === 'shutdown') { await service.dispose(); proxy?.server.close(); app.exit(0); return { stopped: true }; }
  throw new Error(`Unknown action: ${command.action}`);
}

async function start() {
  win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  win.setSize(1440, 1000); win.webContents.setAudioMuted(true); win.show();
  proxy = CODEX_LOGIN_STUDY ? null : await captureProxy();
  service = require('../src/main/codex-runtime').getCodexSessionService();
  const nativeConfig = service._threadConfig.bind(service);
  if (!CODEX_LOGIN_STUDY) service._threadConfig = async (...args) => { const config = await nativeConfig(...args); config.model_providers.mana_responses.base_url = proxy.url; return config; };
  service.on('event', event => {
    lastEventAt = Date.now();
    const projected = { type: event.type, runId: event.runId, turnId: event.turnId, conversationId: event.conversationId, threadId: event.threadId, item: event.item, deltaChars: event.delta?.length, error: event.error, confirmationId: event.confirmationId };
    log('ui-events.jsonl', { commandId: current?.id, ...projected });
    if (current?.events && event.type !== 'text_delta') current.events.push(projected);
  });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) log('renderer-errors.jsonl', { level, message }); });
  log('host-events.jsonl', { type: 'ready', pid: process.pid, proxy: proxy?.url, codexMock: CODEX_LOGIN_STUDY, muted: win.webContents.isAudioMuted() });
  if (CODEX_LOGIN_STUDY) await evaluate(`(() => {const label=document.createElement('div');label.textContent='Codex mock 测试 · gpt-5.6-luna · medium · 真实登录生成';label.style.cssText='position:fixed;top:44px;left:420px;z-index:99999;background:#173e34;color:#dcfff2;padding:6px 12px;font-size:12px;pointer-events:none';document.body.append(label)})()`);
  setInterval(() => save('status.json', { pid: process.pid, ready: true, current: current && { id: current.id, action: current.action, elapsedMs: current.startedAt && Date.now() - current.startedAt, confirmations: current.confirmations?.length, events: current.events?.length }, lastEventAt, completed: [...completed], muted: win.webContents.isAudioMuted() }), 3000);
  while (true) {
    const queue = JSON.parse(await fsp.readFile(path.join(OUT, 'commands.json'), 'utf8').catch(() => '[]'));
    const command = queue.find(item => !completed.has(item.id));
    if (!command) { await delay(500); continue; }
    current = { ...command, startedAt: Date.now() };
    log('commands-starts.jsonl', { ...command });
    try { const result = await execute(command); log('commands-results.jsonl', { id: command.id, action: command.action, ok: true, result }); }
    catch (error) { log('commands-results.jsonl', { id: command.id, action: command.action, ok: false, error: error.stack }); await shot(`${command.id}-failure`).catch(() => {}); }
    completed.add(command.id); current = null;
  }
}

require('../main.js');
app.whenReady().then(async () => {
  while (!BrowserWindow.getAllWindows()[0] || !BrowserWindow.getAllWindows()[0].webContents.getURL().startsWith('file:')) await delay(100);
  await delay(700);
  await start();
}).catch(error => { log('host-events.jsonl', { type: 'fatal', error: error.stack }); app.exit(1); });
