'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function run() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mana-patch-read-after-write-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'user-data');
  const novels = require('../src/main/store/novels');
  const { readResource } = require('../src/main/mcp/novelResources');
  const { getToolByName } = require('../src/main/mcp/tools');
  const { syncNativeNovelWorkspace } = require('../src/main/codex-runtime/nativeNovelWorkspace');
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const novel = await novels.createNovel({ title: '批准后即时可读', dir: path.join(tmp, 'novel') });
  const entry = { id: novel.id, dir: novel.dir };
  const workspace = await syncNativeNovelWorkspace(entry, path.join(tmp, 'workspaces'));
  const service = new CodexSessionService();
  const notifications = [];
  service.on('event', event => notifications.push(event));
  const active = {
    runId: 'test-run', threadId: 'thread', turnId: 'turn', entry, workspace,
    nativeFileItems: new Map(), approvedFileItems: new Map(), completedFileItems: new Set(),
    committedResources: [], taskConstraints: { allowedWriteResourceRefs: [] },
    items: [], text: '', persistence: 'one-shot',
  };
  service.activeRuns.set(active.runId, active);
  const chapterPath = path.join(workspace.root, 'chapters', 'chapter-001.md');
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.mkdir(path.join(workspace.root, 'characters'), { recursive: true });
  await fs.writeFile(chapterPath, '她走进雨里。\n');
  await fs.writeFile(path.join(workspace.root, 'characters', 'jiangzhao.json'), '{"id":"jiangzhao","name":"江照"}\n');
  const completedPatch = async (id, fileChanges) => {
    const approval = service._handleServerRequest('item/fileChange/requestApproval', {
      threadId: 'thread', turnId: 'turn', itemId: id,
      fileChanges,
    });
    for (let attempt = 0; attempt < 50 && !service.pendingConfirmations.has(`test-run:native:${id}`); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await service.resolveConfirmation({ confirmationId: `test-run:native:${id}`, accept: true });
    await approval;
    await service._onNotification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'fileChange', id, status: 'completed', changes: fileChanges } } });
  };
  await completedPatch('patch-1', [
    { path: 'chapters/chapter-001.md', kind: { type: 'add' }, diff: '她走进雨里。\n' },
    { path: 'characters/jiangzhao.json', kind: { type: 'add' }, diff: '{"id":"jiangzhao","name":"江照"}\n' },
  ]);
  assert.equal(notifications.at(-1).novelId, novel.id);
  assert.deepEqual(notifications.at(-1).committedResources.map(resource => [resource.resourceRef, resource.mode]), [['chapter:chapter-001.md', 'create'], ['character:jiangzhao', 'create']]);
  assert.equal(service.activeRuns.has(active.runId), true, 'the model turn is still running');
  const result = await getToolByName('read_novel_resource').handler({ resourceRef: 'chapter:chapter-001.md', limit: 3 }, { novel, novelDir: novel.dir });
  assert.equal(result.structuredContent.chineseCharacterCount, 5, 'count covers the whole resource, not just the page');
  assert.equal(result.structuredContent.content, '她');
  assert.equal((await readResource(entry, 'character:jiangzhao')).content.includes('江照'), true);

  // Canonicalized JSON and successive patches must not be resubmitted as
  // stale creates. The next approved patch can update the same chapter.
  await fs.writeFile(chapterPath, '她走进雨里，关上门。\n');
  await completedPatch('patch-2', [{ path: 'chapters/chapter-001.md', kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@\n-她走进雨里。\n+她走进雨里，关上门。\n' }]);
  assert.equal((await readResource(entry, 'chapter:chapter-001.md')).content, '她走进雨里，关上门。\n');
  await fs.unlink(chapterPath);
  await completedPatch('approved-delete', [{ path: 'chapters/chapter-001.md', kind: { type: 'delete' }, diff: '她走进雨里，关上门。\n' }]);
  assert.equal(notifications.at(-1).committedResources[0].mode, 'delete');
  await assert.rejects(() => readResource(entry, 'chapter:chapter-001.md'), /ENOENT|不存在/u, 'an approved delete must reach the store without asking for a second confirmation');
  await fs.writeFile(chapterPath, '她走进雨里，关上门。\n');
  await completedPatch('approved-recreate', [{ path: 'chapters/chapter-001.md', kind: { type: 'add' }, diff: '她走进雨里，关上门。\n' }]);
  await service._onNotification({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn', turn: { status: 'interrupted' } } });
  assert.equal((await readResource(entry, 'chapter:chapter-001.md')).content, '她走进雨里，关上门。\n', 'stopping later reasoning preserves approved completed patches');
  assert.equal(service.activeRuns.size, 0);
  console.log('native-patch-read-after-write: ok');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
