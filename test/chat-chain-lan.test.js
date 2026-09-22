'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-chat-lan-'));
  process.env.MANA_USER_DATA_ROOT = root;
  const bridge = require('../src/main/lan/ipcBridge');
  const remote = require('../src/main/lan/remoteServer');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  const history = require('../src/main/store/chatHistory');
  const model = require('../src/main/modelConfig');
  const thread = await history.createThread({ title: 'LAN 两个客户端' });
  model.activeRoute = async () => ({ connection: { kind: 'api' }, model: { id: 'fixture', verification: { tools: 'failed' } } });
  service._bindConversation = async () => { await new Promise(resolve => setTimeout(resolve, 30)); return 'native'; };
  let calls = 0;
  service._startNativeTurn = async () => { calls++; return { turn: { id: 'turn' } }; };
  const methods = { startTurn: payload => service.startTurn(payload), getRunState: payload => service.getRunState(payload), getConversationState: payload => service.getConversationState(payload) };
  bridge.hasHandler = channel => !!methods[channel.split(':').at(-1)];
  bridge.invoke = async (channel, payload) => {
    try { return { ok: true, value: await methods[channel.split(':').at(-1)](payload) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  };
  try {
    const status = await remote.start({ port: 0 });
    const origin = `http://127.0.0.1:${status.port}`;
    const auth = await fetch(origin + '/api/lan/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: status.accessCode }), redirect: 'manual' });
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    const rpc = async (method, payload) => (await fetch(origin + '/api/rpc', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mana:codex:' + method, payload }) })).json();
    const script = await (await fetch(origin + '/__mana_remote_bridge.js', { headers: { Cookie: cookie } })).text();
    for (const method of ['getRunState', 'getConversationState', 'getResourceContext', 'getWritingAuthorization']) assert.ok(script.includes(method));
    const [first, second] = await Promise.all(['a', 'b'].map(runId => rpc('startTurn', { runId, conversationId: thread.id, novelId: null, text: '并发消息' })));
    assert.equal([first, second].filter(result => result.ok).length, 1);
    assert.equal(calls, 1);
    const winner = first.ok ? 'a' : 'b';
    assert.equal((await rpc('getConversationState', { conversationId: thread.id })).value.run.runId, winner);
    assert.equal((await rpc('getRunState', { runId: winner })).value.status, 'running');
    const blocked = await fetch(origin + '/api/rpc', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'mana:novel:create', payload: {} }) });
    assert.equal((await blocked.json()).ok, false, 'existing remote restrictions must remain');
    console.log('chat-chain-lan: ok');
  } finally { await service.dispose(); await remote.stop(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
