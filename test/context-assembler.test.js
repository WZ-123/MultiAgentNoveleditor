'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function runContextAssemblerTest() {
  const ROOT = path.resolve(__dirname, '..');
  const {
    DEFAULT_TOOL_RESULT_CHAR_LIMIT,
    DEFAULT_ERROR_TOOL_RESULT_CHAR_LIMIT,
    TRIM_NOTICE_PREFIX,
    fitTextForModel,
    fitToolResultForModel,
    stableJson,
    toolCacheKey,
    isCacheableToolName,
    buildContextManifest,
    classifyChatToolPolicy,
    applyToolPolicy,
  } = require(path.join(ROOT, 'src/main/runtime/contextAssembler'));

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

  try {
    const short = fitTextForModel('short text', { maxChars: 256, sourceRef: 'short-ref' });
    assert.equal(short.text, 'short text');
    assert.equal(short.wasTrimmed, false);
    pass('CA1_short_text_not_trimmed');
  } catch (err) {
    fail('CA1_short_text_not_trimmed', err?.stack || String(err));
  }

  try {
    const longText = `HEAD-${'a'.repeat(400)}-MIDDLE-${'b'.repeat(400)}-TAIL`;
    const trimmed = fitTextForModel(longText, { maxChars: 420, sourceRef: 'long-ref', label: 'long-label' });
    assert.equal(trimmed.wasTrimmed, true);
    assert.ok(trimmed.text.includes(TRIM_NOTICE_PREFIX));
    assert.ok(trimmed.text.includes('sourceRef=long-ref'));
    assert.ok(trimmed.text.includes('originalLength='));
    assert.ok(trimmed.text.includes('HEAD-'));
    assert.ok(trimmed.text.includes('-TAIL'));
    assert.ok(trimmed.text.length < longText.length);
    pass('CA2_long_text_trimmed_with_source_ref');
  } catch (err) {
    fail('CA2_long_text_trimmed_with_source_ref', err?.stack || String(err));
  }

  try {
    const text = 'x'.repeat(DEFAULT_TOOL_RESULT_CHAR_LIMIT + 1000);
    const normal = fitToolResultForModel({ toolName: 'read_chapter', toolUseId: 'tool-normal', content: text, isError: false });
    const error = fitToolResultForModel({ toolName: 'read_chapter', toolUseId: 'tool-error', content: text, isError: true });
    assert.equal(normal.wasTrimmed, true);
    assert.equal(error.wasTrimmed, false);
    assert.ok(DEFAULT_ERROR_TOOL_RESULT_CHAR_LIMIT > DEFAULT_TOOL_RESULT_CHAR_LIMIT);
    pass('CA3_error_tool_result_uses_higher_limit');
  } catch (err) {
    fail('CA3_error_tool_result_uses_higher_limit', err?.stack || String(err));
  }

  try {
    const objectResult = fitToolResultForModel({
      toolName: 'query_world',
      toolUseId: 'tool-object',
      content: { ok: true, nested: { value: 42 } },
      isError: false,
    });
    assert.equal(objectResult.wasTrimmed, false);
    assert.ok(objectResult.modelContent.includes('"nested"'));
    assert.ok(objectResult.displayContent.includes('"value": 42'));
    pass('CA4_non_string_content_is_stable_json');
  } catch (err) {
    fail('CA4_non_string_content_is_stable_json', err?.stack || String(err));
  }

  try {
    assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
    assert.equal(toolCacheKey('read_chapter', { b: 2, a: 1 }), toolCacheKey('read_chapter', { a: 1, b: 2 }));
    assert.equal(isCacheableToolName('read_chapter'), true);
    assert.equal(isCacheableToolName('query_world'), true);
    assert.equal(isCacheableToolName('write_chapter'), false);
    assert.equal(isCacheableToolName('update_character'), false);
    pass('CA5_cache_key_and_cacheable_tool_policy_are_stable');
  } catch (err) {
    fail('CA5_cache_key_and_cacheable_tool_policy_are_stable', err?.stack || String(err));
  }

  try {
    const manifest = buildContextManifest({
      runtime: { kind: 'chatAgent', turnIdx: 2 },
      stats: { estimatedInputTokens: 123 },
      included: [{ kind: 'tool_result', sourceRef: 'tool:read#1' }],
      trimmed: [{ kind: 'tool_result', sourceRef: 'tool:read#1', reason: 'trimmed_for_model' }],
      omitted: [{ kind: 'tool', reason: 'policy' }],
      cached: [{ kind: 'tool_result', cacheKey: 'read::{}' }],
      toolPolicy: { id: 'general', afterCount: 3 },
    });
    assert.equal(manifest.runKind, 'chatAgent');
    assert.equal(manifest.turnIdx, 2);
    assert.equal(manifest.trimmed.length, 1);
    assert.equal(manifest.cached.length, 1);
    assert.equal(manifest.toolPolicy.id, 'general');
    assert.equal(manifest.stats.manifestTrimmedCount, 1);
    pass('CA6_context_manifest_records_included_trimmed_omitted_cached');
  } catch (err) {
    fail('CA6_context_manifest_records_included_trimmed_omitted_cached', err?.stack || String(err));
  }

  try {
    assert.equal(classifyChatToolPolicy('帮我写下一章', { workflowPhase: 'idle' }).id, 'writing');
    assert.equal(classifyChatToolPolicy('审查第三章AI味', { workflowPhase: 'idle' }).id, 'review');
    assert.equal(classifyChatToolPolicy('修改楚岚的角色卡', { workflowPhase: 'idle' }).id, 'character_edit');
    assert.equal(classifyChatToolPolicy('补充世界观地点表', { workflowPhase: 'idle' }).id, 'world_edit');
    assert.equal(classifyChatToolPolicy('你好，聊聊创作方向', { workflowPhase: 'idle' }).id, 'general');
    const tools = [
      { name: 'read_chapter' },
      { name: 'write_chapter' },
      { name: 'update_world' },
      { name: 'read_character' },
      { name: 'WebSearch' },
    ];
    const writing = applyToolPolicy(tools, { id: 'writing', reason: 'test' });
    assert.ok(writing.tools.some((tool) => tool.name === 'write_chapter'));
    assert.equal(writing.tools.some((tool) => tool.name === 'update_world'), false);
    const characterEdit = applyToolPolicy(tools, { id: 'character_edit', reason: 'test' });
    assert.ok(characterEdit.tools.some((tool) => tool.name === 'read_character'));
    assert.equal(characterEdit.tools.some((tool) => tool.name === 'write_chapter'), false);
    pass('CA7_chat_tool_policy_classifies_and_filters_tools');
  } catch (err) {
    fail('CA7_chat_tool_policy_classifies_and_filters_tools', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runContextAssemblerTest };

if (require.main === module) {
  const results = runContextAssemblerTest();
  if (results.failed > 0) process.exitCode = 1;
}
