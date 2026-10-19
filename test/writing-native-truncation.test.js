'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-native-truncation-'));
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'data');
  const server = http.createServer(async (request, response) => {
    const chunks=[];for await (const chunk of request)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const intent=require('./fixtures/fake-responses-server').taskIntentFixture(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: intent?.text||'正文截断在半句话' }, finish_reason: intent?'stop':'length' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = require('../src/main/modelConfig');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  let timer;
  try {
    const novel = await require('../src/main/store/novels').createNovel({ title: '截断测试', dir: path.join(temp, 'novel') });
    const history = await require('../src/main/store/chatHistory').createThread({ novelId: novel.id, title: '截断' });
    await model.saveCredential({ id: 'fixture', apiKey: 'fixture-only' });
    await model.saveConnection({ id: 'fixture', name: 'Fixture', credentialId: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port,
      templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'Fixture', capabilities: { reasoningEfforts: ['none'] }, verification: { responses: 'ok', tools: 'ok', verifiedEfforts: ['none'], byEffort: { none: { responses: 'ok', tools: 'ok' } } } }] });
    await model.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: 'none' });
    const terminal = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('native truncation timed out')), 40000);
      service.on('event', event => { if (event.runId==='truncated'&&['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) resolve(event); });
    });
    await assert.rejects(service.startTurn({ novelId: novel.id, conversationId: history.id, runId: 'truncated', text: '写一章小说，保存到正文。' }),/Incomplete response|stream disconnected|截断/u);
    const event = await terminal;
    assert.notEqual(event.type, 'turn_completed', 'truncated provider output must not be a successful model turn');
    assert.equal((await service.getRunState({ runId: 'truncated' })).taskResult.goalVerified, false);
    assert.equal((await service.getRunState({ runId: 'truncated' })).preparationStage.phase,'failed');
    assert.equal((await service.getRunState({ runId: 'truncated' })).savedResources.length,0);
    console.log('writing-native-truncation: ok (' + event.type + ')');
  } finally { clearTimeout(timer); await service.dispose(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
