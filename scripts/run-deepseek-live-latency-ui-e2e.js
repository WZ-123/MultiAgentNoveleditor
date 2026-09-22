'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROVIDER_USER_ROOT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'provider-user-data');
const USER_ROOT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'latency-user-data');
const CAPTURE_RECEIPT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'latency-wire-capture.json');
function electronBinary() { return process.platform === 'darwin' ? path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(ROOT, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'); }

async function prepareIsolatedUserRoot(sourceRoot = PROVIDER_USER_ROOT, targetRoot = USER_ROOT) {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) throw new Error('Latency acceptance must not mutate the provider acceptance root');
  await fsp.access(path.join(sourceRoot, 'model-config.json'));
  await fsp.rm(targetRoot, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(targetRoot), { recursive: true });
  await fsp.cp(sourceRoot, targetRoot, { recursive: true, force: true });
  return targetRoot;
}

function responseUsage(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || '');
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch { /* streaming response */ }
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { candidates.push(JSON.parse(data)); } catch { /* ignore non-JSON SSE data */ }
  }
  let usage = null;
  for (const candidate of candidates) {
    const value = candidate?.response?.usage || candidate?.usage;
    if (value && typeof value === 'object') usage = value;
  }
  return usage;
}

async function writeCaptureReceipt(receiptPath, captures) {
  if (!receiptPath) return;
  await fsp.mkdir(path.dirname(receiptPath), { recursive: true });
  await fsp.writeFile(receiptPath, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), captures }, null, 2)}\n`, 'utf8');
}

async function createWireCaptureProxy(targetBaseUrl, receiptPath = '') {
  const captures = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      let capture = null;
      if (request.method === 'POST' && new URL(request.url, 'http://local').pathname === '/responses') {
        const body = JSON.parse(raw.toString('utf8'));
        const input = Array.isArray(body.input) ? body.input : [];
        capture = {
          effort: body.reasoning?.effort ?? null,
          summary: body.reasoning?.summary ?? null,
          maxOutputTokens: body.max_output_tokens ?? null,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
          inputTypes: input.reduce((counts, item) => ({ ...counts, [item?.type || 'unknown']: (counts[item?.type || 'unknown'] || 0) + 1 }), {}),
          reasoningInputItems: input.filter((item) => item?.type === 'reasoning').length,
          reasoningInputChars: input.filter((item) => item?.type === 'reasoning').reduce((sum, item) => sum + JSON.stringify(item).length, 0),
          instructionsChars: String(body.instructions || '').length,
          startedAt: new Date().toISOString(),
        };
        captures.push(capture);
        await writeCaptureReceipt(receiptPath, captures);
      }
      const headers = { ...request.headers };
      delete headers.host; delete headers['content-length']; delete headers.connection;
      const upstream = await fetch(`${targetBaseUrl.replace(/\/$/u, '')}${request.url}`, { method: request.method, headers, ...(raw.length ? { body: raw } : {}) });
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (capture) {
        capture.status = upstream.status;
        capture.durationMs = Date.now() - Date.parse(capture.startedAt);
        capture.usage = responseUsage(payload);
        await writeCaptureReceipt(receiptPath, captures);
      }
      const outgoing = {};
      for (const [key, value] of upstream.headers.entries()) if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(key)) outgoing[key] = value;
      response.writeHead(upstream.status, outgoing);
      response.end(payload);
    } catch (error) { response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, captures, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function run() {
  await prepareIsolatedUserRoot();
  await fsp.rm(CAPTURE_RECEIPT, { force: true });
  process.env.MANA_USER_DATA_ROOT = USER_ROOT;
  const modelConfig = require('../src/main/modelConfig');
  const novels = require('../src/main/store/novels');
  const appConfig = require('../src/main/store/appConfig');
  const state = await modelConfig.load();
  if (state.activeSelection?.modelId !== 'deepseek-v4-flash' || state.activeSelection?.reasoningEffort !== 'none') throw new Error('DeepSeek V4 Flash no-reasoning mode is not active');
  const originalSelection = { ...state.activeSelection };
  const originalConnection = state.connections.find((item) => item.id === originalSelection.connectionId);
  if (!originalConnection) throw new Error('Active DeepSeek connection is missing');
  const proxy = await createWireCaptureProxy(originalConnection.baseUrl, CAPTURE_RECEIPT);
  let next = await modelConfig.saveConnection({ ...originalConnection, id: '', name: 'DeepSeek wire capture', baseUrl: proxy.baseUrl, modelsUrl: `${proxy.baseUrl}/models` }, state.revision);
  const proxyConnection = next.connections.at(-1);
  next = await modelConfig.setActive({ connectionId: proxyConnection.id, modelId: originalSelection.modelId, reasoningEffort: 'none' }, next.revision);
  const novelDir = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', `latency-novel-${Date.now()}`);
  const novel = await novels.createNovel({ title: 'DeepSeek 延迟验收', dir: novelDir });
  await appConfig.save({ lastNovelId: novel.id, lastNovelDir: novel.dir });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(electronBinary(), ['.', '--test-deepseek-live-novel'], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production', MANA_AUTOMATED_TEST: '1', MANA_USER_DATA_ROOT: USER_ROOT, MANA_LIVE_NOVEL_ID: novel.id, MANA_LIVE_LATENCY_ONLY: '1' }, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`DeepSeek latency UI exited with code=${code}, signal=${signal || 'none'}`)));
    });
    await writeCaptureReceipt(CAPTURE_RECEIPT, proxy.captures);
    console.log(`deepseek-wire-capture: ${JSON.stringify(proxy.captures)}`);
  } finally {
    await proxy.close();
  }
}

if (require.main === module) run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { createWireCaptureProxy, prepareIsolatedUserRoot, responseUsage, run, writeCaptureReceipt };
