'use strict';
// Audit only: executes production methods against temporary stores and a stub transport.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-chat-audit-'));
process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'data');
const req = p => require(path.join(root, p));
(async () => {
  const { taskConstraintsFor } = await import(path.join(root, 'src/components/writingTaskConstraints.mjs'));
  const novels = req('src/main/store/novels');
  const data = req('src/main/store/novelData');
  const history = req('src/main/store/chatHistory');
  const models = req('src/main/modelConfig');
  const { CodexSessionService } = req('src/main/codex-runtime/codexSessionService');
  const { assertSelectionChange } = req('src/main/codex-runtime/nativeChangePolicy');
  const { hash } = req('src/main/codex-runtime/contracts');
  models.activeRoute = async () => ({ connection: { kind: 'responses' }, model: { id: 'audit', verification: { tools: 'ok' } } });
  const a = await novels.createNovel({ title: 'Audit A', dir: path.join(tmp, 'a') });
  const b = await novels.createNovel({ title: 'Audit B', dir: path.join(tmp, 'b') });
  await data.writeChapterWithMeta(a.dir, 'chapter-001.md', '原文。', {}, { baseContent: '' });
  const svc = new CodexSessionService();
  let binding;
  svc.processManager = { workspacesDirectory: path.join(tmp, 'workspaces'), request: async () => ({}) };
  svc._ensureProcess = async () => svc.processManager;
  svc._bindConversation = async (_route, p) => { binding = p; return 'audit-thread'; };
  svc._startNativeTurn = async () => ({ turn: { id: 'audit-turn' } });
  const out = [];
  const finish = id => svc._finishRun(id);
  await svc.startTurn({ runId: 'plain', persistence: 'one-shot', novelId: a.id, text: '修改人物卡', editorContext: { novelId: a.id } });
  assert.equal(binding.includeMcp, false);
  out.push({ check: 'project ordinary request has no tools/workspace', includeMcp: binding.includeMcp, workspace: !!svc.activeRuns.get('plain').workspace }); finish('plain');
  const editor = { novelId: a.id, chapterFileName: 'chapter-001.md', selectionStart: 0, selectionEnd: 0 };
  const constraints = taskConstraintsFor('改写整章', '', editor);
  await svc.startTurn({ runId: 'cursor', persistence: 'one-shot', novelId: a.id, text: '改写整章', editorContext: editor, taskConstraints: constraints });
  const run = svc.activeRuns.get('cursor');
  let selectionError;
  try { assertSelectionChange(run.selectionState, { resourceRef: 'chapter:chapter-001.md', beforeHash: hash('原文。'), mode: 'replace', afterContent: '新文。' }); } catch (e) { selectionError = e.message; }
  assert.ok(selectionError);
  assert.equal(run.progress, null);
  out.push({ check: 'collapsed cursor restricts whole chapter rewrite', range: run.selectionState.range, selectionError });
  out.push({ check: 'ordinary edit not tracked as writing', operation: constraints.operation, progress: run.progress }); finish('cursor');
  const t = await history.createThread({ title: 'A chat', novelId: a.id });
  await svc.startTurn({ runId: 'cross', persistence: 'chat', conversationId: t.id, novelId: b.id, text: '继续修改' });
  assert.equal(svc.activeRuns.get('cross').entry.id, b.id);
  assert.equal((await history.getThread(t.id)).novelId, a.id);
  out.push({ check: 'backend accepts A conversation with B project', accepted: true }); finish('cross');
  const terminalThread = await history.createThread({ title: 'Terminal evidence', novelId: a.id });
  for (const status of ['completed', 'interrupted', 'failed']) {
    const user = { id: 'user-' + status, role: 'user', text: status };
    await history.appendMessage(terminalThread.id, user);
    await svc.startTurn({ runId: status, persistence: 'chat', conversationId: terminalThread.id, novelId: a.id, userMessageId: user.id, text: status });
    const current = svc.activeRuns.get(status);
    current.turnId = 'turn-' + status;
    current.text = 'visible partial answer';
    current.items = [{ type: 'fileChange', id: 'patch', status: 'completed' }];
    await svc._onNotification({ method: 'turn/completed', params: { threadId: current.threadId, turn: { id: current.turnId, status } } });
    const stored = (await history.getThread(terminalThread.id)).messages.find(m => m.parentId === user.id && m.role === 'assistant');
    if (status === 'completed') { assert.ok(stored); assert.equal(stored.toolCalls.length, 0); }
    else assert.equal(stored, undefined);
    out.push({ check: 'terminal persistence: ' + status, assistantStored: !!stored, fileChangeEvidenceStored: stored?.toolCalls?.length || 0, taskResultStored: !!stored?.taskResult });
  }
  const raceThread = await history.createThread({ title: 'Race', novelId: a.id });
  const race = await Promise.allSettled(['race-1', 'race-2'].map(runId => svc.startTurn({ runId, persistence: 'chat', conversationId: raceThread.id, novelId: a.id, text: 'hello' })));
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 2);
  out.push({ check: 'two concurrent starts accepted for one conversation', accepted: 2, activeRuns: svc.activeRuns.size });
  finish('race-1'); finish('race-2');
  // Run the component's production state/effect/callback body with a deterministic hook harness.
  const source = fs.readFileSync(path.join(root, 'src/components/AiChatPanel.jsx'), 'utf8');
  const body = source.slice(source.indexOf('export function AiChatPanel')).replace('export function', 'function').split('\n  return (')[0];
  const slots = []; let cursor = 0; const events = []; const requests = [];
  const mana = {
    chatHistory: { listThreads: async id => [{ id: id === 'A' ? 'thread-A' : 'thread-B' }], getThread: async () => ({ branch: [] }), appendMessage: async (id, m) => requests.push({ id, text: m.text }) },
    codex: { startTurn: async p => requests.push({ conversationId: p.conversationId, novelId: p.novelId }), onEvent: f => { events.push(f); return () => {}; } }
  };
  const context = { window: { mana }, taskConstraintsFor, id: p => p + '-id',
    useState: init => { const i = cursor++; if (!(i in slots)) slots[i] = init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useCallback: f => f, useMemo: f => f(), useRef: () => ({ current: null }),
    useEffect: () => {}, Date, Number, String, setInterval, clearInterval
  };
  vm.createContext(context);
  vm.runInContext(body + '\nreturn { loadThreads, send, activeId, run, confirmation }; }\nthis.render=AiChatPanel;', context);
  function render(novelId, before) { cursor = 0; return context.render({ editorContext: { novelId }, onBeforeSendMessage: before }); }
  await render('A').loadThreads();
  await render('B').loadThreads();
  assert.equal(render('B').activeId, 'thread-A');
  slots[3] = '继续修改';
  await render('B').send();
  out.push({ check: 'project switch retains old chat and sends mismatched context', requests });
  slots[6] = { runId: 'old-run' }; slots[9] = { confirmationId: 'old-confirmation' }; slots[1] = 'thread-B';
  const switched = render('B');
  assert.equal(switched.run.runId, 'old-run');
  assert.equal(switched.confirmation.confirmationId, 'old-confirmation');
  out.push({ check: 'chat switch retains prior run and approval', run: switched.run, confirmation: switched.confirmation });
  slots[6] = null; slots[3] = '发送'; slots[14] = '';
  await assert.rejects(() => render('B', async () => { throw new Error('save failed'); }).send(), /save failed/);
  out.push({ check: 'save failure escapes send handler', errorState: slots[14] });
  console.log(JSON.stringify({ scope: 'production methods + isolated stores + stub transport + hook harness; no real model/UI', results: out }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
