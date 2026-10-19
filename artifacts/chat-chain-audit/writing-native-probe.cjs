'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-writing-native-audit-'));
  process.env.MANA_USER_DATA_ROOT = path.join(temp, 'data');
  const { createFakeResponsesServer } = require(path.join(ROOT, 'test/fixtures/fake-responses-server'));
  let plan = [];
  const fake = await createFakeResponsesServer({ respond() { return plan.shift() || { text: '探针回合结束' }; } });
  const { CodexSessionService } = require(path.join(ROOT, 'src/main/codex-runtime/codexSessionService'));
  const service = new CodexSessionService();
  const model = require(path.join(ROOT, 'src/main/modelConfig'));
  const data = require(path.join(ROOT, 'src/main/store/novelData'));
  const { taskConstraintsFor } = await import(pathToFileURL(path.join(ROOT, 'src/components/writingTaskConstraints.mjs')));
  const results = { date: '2026-10-18', evidence: 'actual App Server + fake Responses + isolated formal novel store; no live model', checks: [] };
  try {
    const novel = await require(path.join(ROOT, 'src/main/store/novels')).createNovel({ title: '原生写作审计夹具', dir: path.join(temp, 'novel') });
    const thread = await require(path.join(ROOT, 'src/main/store/chatHistory')).createThread({ title: '写作模式检查', novelId: novel.id });
    await data.writeChapterWithMeta(novel.dir, 'chapter-001.md', '城门九点关闭。', {}, { baseContent: '' });
    await data.writeChapterWithMeta(novel.dir, 'chapter-002.md', '十点时城门仍未关闭。', {}, { baseContent: '' });
    await data.writeWorld(novel.dir, { lore: '城门每晚九点关闭。' });
    await data.writeCharacter(novel.dir, { id: 'lin', name: '林岚', personality: '谨慎', relationships: [{ with: '苏绾', type: '信任' }] });
    await data.writeCharacterMemory(novel.dir, { characterId: 'lin', factsKnown: [{ id: 'door', summary: '城门九点关闭' }] });
    await data.writeStyleMemory(novel.dir, '第三人称限知');
    await model.saveCredential({ id: 'fixture', apiKey: 'audit-fixture-secret' });
    await model.saveConnection({ id: 'fixture', name: 'Audit Fixture', credentialId: 'fixture', baseUrl: fake.origin, templateId: 'deepseek', auth: { mode: 'bearer' }, models: [{ id: 'deepseek-v4-flash', name: 'Fixture', verification: { responses: 'ok', tools: 'ok' } }] });
    await model.setActive({ connectionId: 'fixture', modelId: 'deepseek-v4-flash', reasoningEffort: null });
    async function run(name, text, skillName, responses) {
      plan = responses;
      let timer, listener;
      const terminal = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('native audit timeout: ' + name)), 60000);
        listener = event => {
          if (event.runId !== name) return;
          if (event.type === 'confirmation_requested') service.resolveConfirmation({ runId: name, confirmationId: event.confirmationId, accept: true }).catch(reject);
          if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) resolve(event);
        };
        service.on('event', listener);
      });
      try {
        await service.startTurn({ runId: name, novelId: novel.id, conversationId: thread.id, text, skillName, taskConstraints: taskConstraintsFor(text, skillName, {}) });
        const event = await terminal;
        const state = await service.getRunState({ runId: name });
        const result = { name, type: event.type, error: event.error, text: state.text, taskResult: state.taskResult,
          toolItems: state.items.filter(i => i.type === 'mcpToolCall' || i.type === 'fileChange').map(i => ({ type: i.type, tool: i.tool, status: i.status, error: i.error, arguments: i.arguments, result: i.result })) };
        results.checks.push(result);
        console.log('NATIVE ' + name + ': ' + event.type + (event.error ? ' / ' + event.error : ''));
        return result;
      } finally { clearTimeout(timer); service.off('event', listener); }
    }
    const read = ref => ({ namespace: 'mcp__novel_tools', toolName: 'read_novel_resource', arguments: { resourceRef: ref } });
    const context = await run('canonical-reading', '读取角色、世界观、记忆与文风', 'mana-fiction-writing', [
      ...['character:lin', 'character-memory:lin', 'world:lore', 'style:memory'].map(read), { text: '资料已读取。' },
    ]);
    assert.equal(context.type, 'turn_completed');
    assert.equal(context.toolItems.filter(i => i.status === 'completed').length, 4);
    const role = await run('roleplay-persist-memory', '角色驱动：林岚记住苏绾交来钥匙并保存记忆', 'mana-character-roleplay', [
      read('character-memory:lin'),
      { customToolName: 'apply_patch', input: '*** Begin Patch\n*** Update File: character-memories/lin.json\n@@\n-      "summary": "城门九点关闭"\n+      "summary": "城门九点关闭；苏绾交来钥匙"\n*** End Patch' },
      { text: '角色记忆已提交。' },
    ]);
    assert.equal(role.type, 'turn_completed');
    assert.ok((await data.readCharacterMemory(novel.dir, 'lin')).factsKnown[0].summary.includes('苏绾'));
    const missing = await run('missing-character-read', '读取角色卡并在未找到时修正查询', '', [read('character:missing'), { text: '模型收到查询失败后继续回答。' }]);
    assert.equal(missing.type, 'turn_failed');
    const review = await run('whole-review-one-chapter', '审校全书的人物和世界观一致性', 'mana-consistency-review', [
      read('chapter:chapter-001.md'), { text: '全书审校完成。\n```json\n{"coveredResourceRefs":["chapter:chapter-001.md"],"issues":[]}\n```' },
    ]);
    assert.equal(review.taskResult.goalVerified, true);
    const write = await run('write-requested-self-review', '写下一章，写完自查人物与世界观冲突', 'mana-fiction-writing', [
      { customToolName: 'apply_patch', input: '*** Begin Patch\n*** Add File: chapters/chapter-003.md\n+林岚推开城门。\n*** End Patch' },
      { text: '正文保存完成，未调用任何审校工具或提交审校报告。' },
    ]);
    assert.equal(write.taskResult.goalVerified, true);
    assert.equal(write.taskResult.contentReview.characterConsistency.status, 'not_evaluated');
    // Isolate provider truncation handling; the upstream returns an explicit length limit.
    const http = require('node:http');
    const upstream = http.createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume fixture request */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '报告被截断在这里 {' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const { chatCompletionAsResponses, normalizeNoReasoningRequest, upstreamTimeoutMs } = require(path.join(ROOT, 'src/main/codex-runtime/deepseekNoReasoningBridge'));
      const request = { model: 'deepseek-v4-flash', reasoning: { effort: 'none' }, input: [{ type: 'message', role: 'user', content: '<name>mana-consistency-review</name> 审校全书' }], tools: [], max_output_tokens: 20000 };
      const converted = await chatCompletionAsResponses({ body: request, headers: { 'content-type': 'application/json' }, target: 'http://127.0.0.1:' + upstream.address().port });
      let stream = '';
      for await (const chunk of converted.stream) stream += chunk;
      const events = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const final = events.at(-1);
      assert.equal(final.type, 'response.completed');
      assert.equal(final.response.incomplete_details, null);
      results.checks.push({ name: 'deepseek-length-limit-reported-completed', upstreamFinishReason: 'length', finalEvent: final.type, incompleteDetails: final.response.incomplete_details, normalizedReviewOutputCap: normalizeNoReasoningRequest(request).max_output_tokens, reviewTimeoutMs: upstreamTimeoutMs(request), note: 'Flash chat conversion caps at 6000 separately; 1200 belongs to Responses normalization path.' });
      console.log('NATIVE deepseek-length-limit-reported-completed: reproduced');
    } finally { await new Promise(resolve => upstream.close(resolve)); }
    await fs.writeFile(path.join(__dirname, 'writing-native-probe-results.json'), JSON.stringify(results, null, 2) + '\n');
  } finally { await service.dispose(); await fake.close(); await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
