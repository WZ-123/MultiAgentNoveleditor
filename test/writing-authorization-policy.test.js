'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function waitPending(service, confirmationId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.pendingConfirmations.has(confirmationId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`confirmation not registered: ${confirmationId}`);
}

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-writing-authorization-'));
  process.env.MANA_USER_DATA_ROOT = path.join(root, 'user-data');
  const novels = require('../src/main/store/novels');
  const novelData = require('../src/main/store/novelData');
  const { syncNativeNovelWorkspace } = require('../src/main/codex-runtime/nativeNovelWorkspace');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const { getAuthorization, sameAuthorization, setAuthorization } = require('../src/main/codex-runtime/writingAuthorization');
  const { getProgress } = require('../src/main/codex-runtime/writingProgress');
  const { applyUnifiedDiff, assertSelectionChange, evidenceForNativeChanges, isAuthorizedProseAppend } = require('../src/main/codex-runtime/nativeChangePolicy');
  try {
    const novel = await novels.createNovel({ title: '限定授权', dir: path.join(root, 'novel') });
    assert.equal((await getAuthorization(novel)).granted, false, 'old and new projects default to confirmation');
    const granted = await setAuthorization(novel, 'append-prose');
    assert.equal(granted.granted, true);
    assert.equal(sameAuthorization(granted, await getAuthorization(novel)), true);
    assert.equal((await getAuthorization({ ...novel, dir: path.join(root, 'copied-project') })).granted, false, 'a copied path must not inherit authorization');

    const workspace = await syncNativeNovelWorkspace(novel, path.join(root, 'workspaces'));
    const added = [{ resourceRef: 'chapter:chapter-001.md', path: 'chapters/chapter-001.md', kind: { type: 'add' }, diff: '雨落在门外。\n' }];
    const addEvidence = evidenceForNativeChanges(workspace, added);
    assert.equal(isAuthorizedProseAppend(addEvidence), true);
    await fsp.mkdir(path.join(workspace.root, 'chapters'), { recursive: true });
    await fsp.writeFile(path.join(workspace.root, 'chapters', 'chapter-001.md'), '雨落在门外。\n');
    const service = new CodexSessionService();
    const events = [];
    service.on('event', (event) => events.push(event));
    const active = {
      runId: 'authorized-run', threadId: 'thread', turnId: 'turn', entry: novel, workspace,
      nativeFileItems: new Map(), approvedFileItems: new Map(), userRejectedFileItems: new Set(), completedFileItems: new Set(),
      committedResources: [], taskConstraints: { operation: 'write', allowedWriteResourceRefs: [], targetResourceRefs: [], minBodyCjk: null, maxBodyCjk: 4, prohibitRepetition: false, requiresCompleteEnding: false }, items: [], text: '', persistence: 'one-shot',
      progress: { schemaVersion: 1, novelId: novel.id, conversationId: 'conversation', runId: 'authorized-run', phase: 'tool-running', currentResourceRef: null, totalSavedBodyCjk: 0, initialTotalBodyCjk: 0, runNetBodyCjk: 0, lastSavedAt: null, startedAtMs: Date.now(), elapsedMs: 0, target: { minimum: null, maximum: null }, goalStatus: 'in-progress', updatedAt: new Date().toISOString() },
    };
    service.activeRuns.set(active.runId, active);
    assert.deepEqual(await service._handleServerRequest('item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'add', fileChanges: added }), { decision: 'accept' });
    await service._onNotification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'fileChange', id: 'add', status: 'completed', changes: added } } });
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '雨落在门外。\n');
    const savedProgress = await getProgress({ novelId: novel.id, conversationId: 'conversation' });
    assert.equal(savedProgress.totalSavedBodyCjk, 5);
    assert.equal(savedProgress.runNetBodyCjk, 5);
    assert.ok(savedProgress.lastSavedAt);
    const overTarget = await service._evaluateTaskResult(active, true);
    assert.equal(overTarget.checks.wordCount.status, 'over_target');
    assert.equal(overTarget.checks.wordCount.blocking, false);
    assert.equal(overTarget.checks.wordCount.aboveBy, 1);
    assert.equal(overTarget.goalVerified, true, 'length is informational and must not block task completion');
    active.taskConstraints.minBodyCjk = 10;
    active.taskConstraints.maxBodyCjk = 20;
    const belowTarget = await service._evaluateTaskResult(active, true);
    assert.equal(belowTarget.checks.wordCount.belowBy, 5);
    assert.equal(belowTarget.goalVerified, true, 'shortfall is reported without inventing a hard completion gate');
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '雨落在门外。\n', 'crossing a final length target must not roll back a valid save');

    const before = '雨落在门外。\n';
    const appendDiff = '@@ -1,1 +1,2 @@\n 雨落在门外。\n+她推开门。\n';
    assert.equal(applyUnifiedDiff(before, appendDiff), '雨落在门外。\n她推开门。\n');
    assert.equal(applyUnifiedDiff(before, '@@\n-雨落在门外。\n+雪落在门外。\n'), '雪落在门外。\n');
    assert.equal(applyUnifiedDiff('甲\n乙', '@@\n-乙\n+丙\n'), '甲\n丙');
    assert.throws(() => applyUnifiedDiff('甲\n甲\n', '@@\n-甲\n+乙\n'), /唯一定位/u);
    assert.throws(() => applyUnifiedDiff(before, '@@\n+无定位\n'), /定位上下文/u);
    const append = [{ resourceRef: 'chapter:chapter-001.md', path: 'chapters/chapter-001.md', kind: { type: 'update' }, diff: appendDiff }];
    assert.equal(isAuthorizedProseAppend(evidenceForNativeChanges(workspace, append)), true);

    const replace = [{ resourceRef: 'chapter:chapter-001.md', path: 'chapters/chapter-001.md', kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@\n-雨落在门外。\n+雪落在门外。\n' }];
    assert.equal(isAuthorizedProseAppend(evidenceForNativeChanges(workspace, replace)), false, 'editing existing prose must still ask');
    assert.equal(isAuthorizedProseAppend(evidenceForNativeChanges(workspace, [...added.map((change) => ({ ...change, resourceRef: 'chapter:chapter-002.md', path: 'chapters/chapter-002.md' })), ...replace])), false, 'a mixed append and replacement patch must wait for confirmation as one unit');
    const pending = service._handleServerRequest('item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'replace', fileChanges: replace });
    await waitPending(service, 'authorized-run:native:replace');
    await service.resolveConfirmation({ confirmationId: 'authorized-run:native:replace', accept: false });
    assert.deepEqual(await pending, { decision: 'decline' });

    const selection = { resourceRef: 'chapter:chapter-001.md', content: before, range: { start: 0, end: 1 } };
    const inside = evidenceForNativeChanges(workspace, [{ ...replace[0], diff: '@@ -1,1 +1,1 @@\n-雨落在门外。\n+雪落在门外。\n' }])[0];
    assert.equal(assertSelectionChange(selection, inside).range.end, 1);
    const outsideSelection = { ...selection, range: { start: 1, end: 2 } };
    assert.throws(() => assertSelectionChange(outsideSelection, inside), /选区之前/u);
    assert.throws(() => assertSelectionChange({ ...selection, content: '外部编辑后的正文。\n' }, inside), /版本已经变化/u);

    const revokedFile = path.join(workspace.root, 'chapters', 'chapter-002.md');
    const revokedChange = [{ resourceRef: 'chapter:chapter-002.md', path: 'chapters/chapter-002.md', kind: { type: 'add' }, diff: '灯熄灭了。\n' }];
    await fsp.writeFile(revokedFile, '灯熄灭了。\n');
    assert.deepEqual(await service._handleServerRequest('item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'revoked', fileChanges: revokedChange }), { decision: 'accept' });
    await service.revokeWritingAuthorization({ novelId: novel.id });
    await service._onNotification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'fileChange', id: 'revoked', status: 'completed', changes: revokedChange } } });
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-002.md'), '', 'revoked authorization must leave formal prose untouched');
    assert.equal(events.some((event) => event.type === 'turn_failed' && event.failure?.code === 'authorization_revoked'), true);

    await fsp.rm(revokedFile, { force: true });
    const mismatchRun = {
      ...active, runId: 'mismatch-run', threadId: 'mismatch-thread', turnId: 'mismatch-turn', progress: null,
      nativeFileItems: new Map(), approvedFileItems: new Map(), userRejectedFileItems: new Set(), completedFileItems: new Set(), committedResources: [],
    };
    service.activeRuns.set(mismatchRun.runId, mismatchRun);
    const mismatchPending = service._handleServerRequest('item/fileChange/requestApproval', { threadId: mismatchRun.threadId, turnId: mismatchRun.turnId, itemId: 'mismatch', fileChanges: replace });
    await waitPending(service, 'mismatch-run:native:mismatch');
    await service.resolveConfirmation({ confirmationId: 'mismatch-run:native:mismatch', accept: true });
    assert.deepEqual(await mismatchPending, { decision: 'accept' });
    await fsp.writeFile(path.join(workspace.root, 'chapters', 'chapter-001.md'), '风落在门外。\n');
    await service._onNotification({ method: 'item/completed', params: { threadId: mismatchRun.threadId, turnId: mismatchRun.turnId, item: { type: 'fileChange', id: 'mismatch', status: 'completed', changes: replace } } });
    assert.equal(await novelData.readChapter(novel.dir, 'chapter-001.md'), '雨落在门外。\n', 'content differing from the approved candidate must never reach the formal novel');
    assert.equal(events.some((event) => event.type === 'turn_failed' && event.failure?.code === 'approved_content_mismatch'), true);
    console.log('writing-authorization-policy: ok');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
