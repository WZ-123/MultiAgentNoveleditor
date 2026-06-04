'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

async function runChapterApplyPatchRegressionTest() {
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { getToolByName } = require(path.join(ROOT, 'src/main/mcp/tools'));
  const tmpRoot = path.join(ROOT, 'tmp-test-chapter-apply-patch');
  const novelDir = path.join(tmpRoot, 'novel-' + Date.now());

  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(novelDir, { recursive: true });

    const tool = getToolByName('apply_chapter_patch');
    assert.ok(tool);

    const originalBody = [
      '第一段。',
      '',
      '林岚说：“先等等。”',
      '',
      '第二段。',
      '',
      '钟声贴着屋檐滚过去。',
      '',
      '第三段。',
      '',
      '她抬手把窗推开。',
    ].join('\n');
    await novelData.writeChapterWithMeta(novelDir, 'chapter-001.md', originalBody, { title: '批量 patch' });

    const successResult = await tool.handler(
      {
        name: 'chapter-001.md',
        baseContent: originalBody,
        edits: [
          {
            targetText: '林岚说:"先等等。"',
            replacement: '林岚压低声音说：“先别动。”',
            beforeContext: '第一段。',
            afterContext: '第二段。',
          },
          {
            targetText: '她抬手把窗推开。',
            replacement: '她抬手把窗推开一线，让冷雨气钻进来。',
          },
        ],
      },
      { novelDir, novel: { id: 'novel-patch' } }
    );
    const successPayload = JSON.parse(successResult.content[0].text);
    const successAfter = await novelData.readChapter(novelDir, 'chapter-001.md');

    assert.equal(successPayload.ok, true);
    assert.equal(successPayload.editCount, 2);
    assert.equal(successPayload.replacedCount, 2);
    assert.equal(successPayload.edits[0]?.matchStrategy, 'normalized_context');
    assert.equal(successPayload.edits[1]?.matchStrategy, 'exact');
    assert.equal(successPayload.checkpoint?.source, 'apply_chapter_patch');
    assert.equal(successPayload.checkpoint?.novelId, 'novel-patch');
    assert.equal(successPayload.checkpoint?.chapterName, 'chapter-001.md');
    assert.equal(successPayload.checkpoint?.beforeContent, originalBody);
    assert.equal(successPayload.checkpoint?.afterContent, successAfter);
    assert.equal(successPayload.changedFiles?.[0]?.restoreMode, 'write');
    assert.ok(successAfter.includes('林岚压低声音说：“先别动。”'));
    assert.ok(successAfter.includes('她抬手把窗推开一线，让冷雨气钻进来。'));
    assert.equal(successAfter.includes('林岚说：“先等等。”'), false);
    pass('CAP1_tool_applies_multiple_edits_against_one_snapshot', 'apply_chapter_patch applied two anchored edits in one write');

    const writeTool = getToolByName('write_chapter');
    assert.ok(writeTool);
    const writeResult = await writeTool.handler(
      {
        name: 'chapter-010.md',
        content: '新章第一段。',
        title: '新建章',
      },
      { novelDir, novel: { id: 'novel-patch' } }
    );
    const writePayload = JSON.parse(writeResult.content[0].text);
    assert.equal(writePayload.ok, true);
    assert.equal(writePayload.checkpoint?.source, 'write_chapter');
    assert.equal(writePayload.changedFiles?.[0]?.chapterName, 'chapter-010.md');
    assert.equal(writePayload.changedFiles?.[0]?.restoreMode, 'delete');
    assert.equal(writePayload.changedFiles?.[0]?.afterContent, '新章第一段。');
    pass('CAP2_write_chapter_new_file_returns_delete_restore_checkpoint', 'new chapter writes can be undone by deleting the created file');

    const overlapBody = '她抬起头，紫红色的眼眸里映着冷光。';
    await novelData.writeChapterWithMeta(novelDir, 'chapter-002.md', overlapBody, { title: '冲突 patch' });
    let overlapError = null;
    try {
      await novelData.applyChapterPatch(novelDir, 'chapter-002.md', [
        {
          targetText: '紫红色的眼眸',
          replacement: '蓝紫色的眼眸',
        },
        {
          targetText: '紫红色的眼眸里映着冷光。',
          replacement: '蓝紫色的眼眸里映着疲惫的冷光。',
        },
      ]);
    } catch (err) {
      overlapError = err;
    }
    const overlapAfter = await novelData.readChapter(novelDir, 'chapter-002.md');

    assert.match(String(overlapError?.message || ''), /overlap/i);
    assert.equal(overlapAfter, overlapBody);
    pass('CAP3_overlapping_edits_are_rejected_without_partial_write', 'overlapping batch edits fail before the chapter is mutated');

    const staleBody = '窗外的风声一阵紧过一阵。';
    await novelData.writeChapterWithMeta(novelDir, 'chapter-003.md', staleBody, { title: '旧快照保护' });
    const staleSnapshot = await novelData.readChapter(novelDir, 'chapter-003.md');
    await novelData.writeChapterWithMeta(novelDir, 'chapter-003.md', `${staleBody}\n\n门闩轻轻响了一下。`, { title: '旧快照保护' });

    let staleError = null;
    try {
      await novelData.applyChapterPatch(
        novelDir,
        'chapter-003.md',
        [{ targetText: '风声', replacement: '雨声' }],
        { baseContent: staleSnapshot }
      );
    } catch (err) {
      staleError = err;
    }
    const staleAfter = await novelData.readChapter(novelDir, 'chapter-003.md');

    assert.match(String(staleError?.message || ''), /snapshot mismatch/i);
    assert.equal(staleAfter, `${staleBody}\n\n门闩轻轻响了一下。`);
    pass('CAP4_stale_snapshot_is_rejected', 'apply_chapter_patch refuses to apply edits from an outdated chapter snapshot');

    const chatAgentText = await fs.readFile(path.join(ROOT, 'src/main/runtime/chatAgent.js'), 'utf8');
    assert.ok(chatAgentText.includes('apply_chapter_patch'));
    assert.ok(chatAgentText.includes('same chapter'));
    pass('CAP5_chat_rules_advertise_batch_patch_flow', 'chat prompt now tells the model to use apply_chapter_patch for multiple same-chapter fixes');
  } catch (err) {
    fail('CAP_harness', err && err.stack ? err.stack : String(err));
  } finally {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChapterApplyPatchRegressionTest };

if (require.main === module) {
  runChapterApplyPatchRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
