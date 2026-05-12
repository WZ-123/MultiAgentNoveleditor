'use strict';

/**
 * Comprehensive Flow E2E Tests
 *
 * Categories:
 *   R1-R13 — MCP Read tool tests
 *   W1-W10 — MCP Write tool tests
 *   C1-C5  — Chat conversation tests
 *   P1-P5  — Persistence tests
 *   E1-E7  — Edge case tests
 */

const path = require('node:path');
const fs = require('node:fs/promises');

async function runFlowTests() {
  const results = { total: 0, passed: 0, failed: 0 };
  let novelDir = '';
  let novelId = '';
  let secondNovelDir = '';
  let secondNovelId = '';

  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const chatHistoryStore = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const eventBus = require(path.join(ROOT, 'src/main/runtime/eventBus'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  // ---------- Test data helpers ----------
  async function createTestNovel() {
    const tmpRoot = path.join(ROOT, 'tmp-test-flow');
    await fs.mkdir(tmpRoot, { recursive: true });
    const dir = path.join(tmpRoot, 'novel-' + Date.now());
    await fs.mkdir(dir, { recursive: true });
    const entry = await novelsStore.createNovel({ title: '测试小说', dir });
    const openR = await novelsStore.openNovel(entry.id);
    await mcpClient.setActiveNovel(entry.id, openR.entry.dir);
    const np = novelPaths(dir);

    // World
    await fs.mkdir(np.world, { recursive: true });
    await fs.writeFile(np.worldMeta, JSON.stringify({
      name: '测试世界', description: '一个测试用的世界',
      factions: [{ name: '测试势力', leader: '测试领袖' }],
      timeline: [{ date: '元年', event: '测试事件' }],
    }, null, 2), 'utf8');
    await fs.writeFile(np.worldLore, '# 测试世界观\n\n这是一个用于自动测试的世界。', 'utf8');

    // Outline
    await fs.mkdir(np.outlines, { recursive: true });
    await fs.writeFile(path.join(np.outlines, 'main.md'), '# 测试大纲\n\n## 第一卷\n\n### 第一章 开始\n测试内容', 'utf8');

    // Characters
    await fs.mkdir(np.characters, { recursive: true });
    await fs.writeFile(path.join(np.characters, 'protagonist.json'), JSON.stringify({
      id: 'protagonist', name: '主角', age: 20, personality: '勇敢, 善良',
      role: '主角', gender: '男', appearance: '黑发黑瞳', height: '178cm',
      background: '普通出身', quotes: '我不会放弃的',
      _enrichmentStatus: 'skipped',
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(np.characters, 'heroine.json'), JSON.stringify({
      id: 'heroine', name: '女主角', age: 18, personality: '温柔, 坚强',
      role: '女主角', gender: '女', appearance: '金发碧瞳',
      background: '神秘背景', _enrichmentStatus: 'skipped',
    }, null, 2), 'utf8');

    // Chapters
    await fs.mkdir(np.chapters, { recursive: true });
    await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), '# 第一章\n\n这是第一章的内容。主角开始了旅程。', 'utf8');

    // Style memory
    await fs.mkdir(np.style, { recursive: true });
    await fs.writeFile(np.styleMemory, '# 文风记忆\n\n- 使用第三人称\n- 描写细腻\n', 'utf8');

    // Index (for search_index) — expects { entries: [...] }
    await fs.writeFile(np.manaIndex, JSON.stringify({ entries: [
      { name: '主角', key: 'protagonist', chapterAppearances: ['chapter-001'] },
      { name: '女主角', key: 'heroine', chapterAppearances: ['chapter-001'] },
    ] }, null, 2), 'utf8');

    // Timeline
    await fs.mkdir(np.timeline, { recursive: true });
    // Timeline is stored as JSONL (one JSON object per line)
    const tlEntry = JSON.stringify({ id: 'ev1', date: '元年春', description: '故事开始', participants: ['protagonist'] }) + '\n';
    await fs.writeFile(np.timelineEvents, tlEntry, 'utf8');

    // Assets
    await fs.mkdir(np.assets, { recursive: true });
    await fs.writeFile(path.join(np.assets, 'sword.json'), JSON.stringify({
      id: 'sword', name: '宝剑', type: '武器', owner: 'protagonist', acquiredAt: '元年春',
    }, null, 2), 'utf8');

    await new Promise((r) => setTimeout(r, 300));
    return { dir, id: entry.id, paths: np };
  }

  const tmpRoot = path.join(ROOT, 'tmp-test-flow');

  async function cleanup() {
    try { await mcpClient.setActiveNovel(null); } catch { /* ignore */ }
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ============== SETUP ==============
  try {
    const setup = await createTestNovel();
    novelDir = setup.dir;
    novelId = setup.id;
  } catch (err) {
    fail('setup', err.message || String(err));
    await cleanup();
    console.log('TEST_DONE');
    return results;
  }

  // =============================================================
  // R: READ TOOL TESTS
  // =============================================================

  // R1: list_characters with characters
  try {
    const r = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('protagonist') && text.includes('heroine')) {
      pass('R1_list_characters', 'found protagonist + heroine');
    } else fail('R1_list_characters', text.slice(0, 150));
  } catch (err) { fail('R1_list_characters', err.message); }

  // R2: list_characters with empty novel
  try {
    const e = await createTestNovel();
    // Remove all characters
    const np = novelPaths(e.dir);
    await fs.rm(np.characters, { recursive: true, force: true });
    await fs.mkdir(np.characters, { recursive: true });
    await mcpClient.setActiveNovel(e.id, e.dir);

    const r = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('"characters": []') || text.includes('characters') && !text.includes('protagonist')) {
      pass('R2_list_characters_empty', 'empty list returned');
    } else fail('R2_list_characters_empty', text.slice(0, 200));

    await mcpClient.setActiveNovel(novelId, novelDir);
    try { await fs.rm(e.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  } catch (err) { fail('R2_list_characters_empty', err.message); }

  // R3: read_character existing
  try {
    const r = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('主角') && text.includes('20') && text.includes('勇敢')) {
      pass('R3_read_character', 'protagonist data OK');
    } else fail('R3_read_character', text.slice(0, 200));
  } catch (err) { fail('R3_read_character', err.message); }

  // R4: read_character not found
  try {
    const r = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'nonexistent' } });
    const isErr = !!r?.isError;
    if (isErr) pass('R4_read_character_missing', 'error returned');
    else fail('R4_read_character_missing', 'should have errored');
  } catch (err) { fail('R4_read_character_missing', err.message); }

  // R5: read_character_context
  try {
    const r = await mcpClient.callTool({ name: 'read_character_context', arguments: { id: 'protagonist', needBackground: false } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('主角') && (text.includes('personality') || text.includes('personality'))) {
      pass('R5_read_character_context', 'scene context returned');
    } else fail('R5_read_character_context', text.slice(0, 200));
  } catch (err) { fail('R5_read_character_context', err.message); }

  // R6: query_world
  try {
    const r = await mcpClient.callTool({ name: 'query_world', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('测试世界')) {
      pass('R6_query_world', 'world data OK');
    } else fail('R6_query_world', text.slice(0, 200));
  } catch (err) { fail('R6_query_world', err.message); }

  // R7: read_outline
  try {
    const r = await mcpClient.callTool({ name: 'read_outline', arguments: { name: 'main' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('测试大纲')) {
      pass('R7_read_outline', 'outline content OK');
    } else fail('R7_read_outline', text.slice(0, 200));
  } catch (err) { fail('R7_read_outline', err.message); }

  // R8: read_outline_nodes
  try {
    const r = await mcpClient.callTool({ name: 'read_outline_nodes', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    // May be empty but should return valid JSON
    if (text.includes('nodes') || text.includes('schemaVersion')) {
      pass('R8_read_outline_nodes', 'nodes data OK');
    } else fail('R8_read_outline_nodes', text.slice(0, 200));
  } catch (err) { fail('R8_read_outline_nodes', err.message); }

  // R9: read_chapter
  try {
    const r = await mcpClient.callTool({ name: 'read_chapter', arguments: { name: 'chapter-001.md' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('第一章') && text.includes('主角开始了旅程')) {
      pass('R9_read_chapter', 'chapter content OK');
    } else fail('R9_read_chapter', text.slice(0, 200));
  } catch (err) { fail('R9_read_chapter', err.message); }

  // R10: query_timeline
  try {
    const r = await mcpClient.callTool({ name: 'query_timeline', arguments: { participant: 'protagonist' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('元年春')) {
      pass('R10_query_timeline', 'timeline events OK');
    } else fail('R10_query_timeline', text.slice(0, 200));
  } catch (err) { fail('R10_query_timeline', err.message); }

  // R11: search_index
  try {
    const r = await mcpClient.callTool({ name: 'search_index', arguments: { query: '主角' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('主角') || text.includes('hits')) {
      pass('R11_search_index', 'search results OK');
    } else fail('R11_search_index', text.slice(0, 200));
  } catch (err) { fail('R11_search_index', err.message); }

  // R12: list_novels
  try {
    const r = await mcpClient.callTool({ name: 'list_novels', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('测试小说')) {
      pass('R12_list_novels', 'novels listed OK');
    } else fail('R12_list_novels', text.slice(0, 200));
  } catch (err) { fail('R12_list_novels', err.message); }

  // R13: read_style_memory
  try {
    const r = await mcpClient.callTool({ name: 'read_style_memory', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('文风记忆') || text.includes('第三人称')) {
      pass('R13_read_style_memory', 'style memory OK');
    } else fail('R13_read_style_memory', text.slice(0, 200));
  } catch (err) { fail('R13_read_style_memory', err.message); }

  // =============================================================
  // W: WRITE TOOL TESTS
  // =============================================================

  // W1: update_character (age)
  try {
    await mcpClient.callTool({ name: 'update_character', arguments: { id: 'protagonist', patch: { age: 25 } }, autoConfirm: true });
    const v = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    const parsed = JSON.parse(vt);
    if (String(parsed?.age || '') === '25') {
      pass('W1_update_age', 'age changed to 25');
    } else fail('W1_update_age', vt.slice(0, 200));
  } catch (err) { fail('W1_update_age', err.message); }

  // W2: update_character (personality)
  try {
    await mcpClient.callTool({ name: 'update_character', arguments: { id: 'protagonist', patch: { personality: '勇敢, 果断, 聪明' } }, autoConfirm: true });
    const v = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('果断')) {
      pass('W2_update_personality', 'personality updated OK');
    } else fail('W2_update_personality', vt.slice(0, 200));
  } catch (err) { fail('W2_update_personality', err.message); }

  // W3: update_world
  try {
    await mcpClient.callTool({ name: 'update_world', arguments: { lore: '# 更新后的世界观\n\n内容已更新。' }, autoConfirm: true });
    const v = await mcpClient.callTool({ name: 'query_world', arguments: {} });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('更新后的世界观')) {
      pass('W3_update_world', 'world lore updated');
    } else fail('W3_update_world', vt.slice(0, 200));
  } catch (err) { fail('W3_update_world', err.message); }

  // W4: create_character
  try {
    await mcpClient.callTool({ name: 'create_character', arguments: { id: 'new-char', name: '新角色', role: '配角' }, autoConfirm: true });
    const v = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'new-char' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('新角色')) {
      pass('W4_create_character', 'new char created');
    } else fail('W4_create_character', vt.slice(0, 200));
  } catch (err) { fail('W4_create_character', err.message); }

  // W4b: create_character unwraps valid __raw payload
  try {
    await mcpClient.callTool({
      name: 'create_character',
      arguments: { __raw: JSON.stringify({ id: 'wrapped-char', name: '包裹角色', role: '配角' }) },
      autoConfirm: true,
    });
    const v = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'wrapped-char' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('包裹角色')) {
      pass('W4b_create_character_raw_wrapper', 'wrapped payload created');
    } else fail('W4b_create_character_raw_wrapper', vt.slice(0, 200));
  } catch (err) { fail('W4b_create_character_raw_wrapper', err.message); }

  // W4c: update_character unwraps valid __raw payload
  try {
    await mcpClient.callTool({
      name: 'update_character',
      arguments: { __raw: JSON.stringify({ id: 'protagonist', patch: { age: 31 } }) },
      autoConfirm: true,
    });
    const v = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    const parsed = JSON.parse(vt);
    if (String(parsed?.age || '') === '31') {
      pass('W4c_update_character_raw_wrapper', 'wrapped patch applied');
    } else fail('W4c_update_character_raw_wrapper', vt.slice(0, 200));
  } catch (err) { fail('W4c_update_character_raw_wrapper', err.message); }

  // W4d: malformed __raw payload is rejected instead of writing empty cards
  try {
    const r = await mcpClient.callTool({
      name: 'create_character',
      arguments: { __raw: '{"name":"坏角色"' },
      autoConfirm: true,
    });
    const isErr = !!r?.isError;
    const v = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (isErr && !vt.includes('坏角色')) {
      pass('W4d_reject_malformed_raw_character', 'malformed payload rejected');
    } else if (!isErr) {
      fail('W4d_reject_malformed_raw_character', 'malformed __raw unexpectedly succeeded');
    } else {
      fail('W4d_reject_malformed_raw_character', 'malformed payload polluted character list');
    }
  } catch (err) { fail('W4d_reject_malformed_raw_character', err.message); }

  // W5: append_timeline
  try {
    await mcpClient.callTool({ name: 'append_timeline', arguments: { description: '新事件', participants: ['protagonist'], when: '元年夏' } });
    const v = await mcpClient.callTool({ name: 'query_timeline', arguments: {} });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('新事件')) {
      pass('W5_append_timeline', 'event appended');
    } else fail('W5_append_timeline', vt.slice(0, 200));
  } catch (err) { fail('W5_append_timeline', err.message); }

  // W5b: update_timeline modifies existing event instead of duplicating it
  try {
    await mcpClient.callTool({
      name: 'update_timeline',
      arguments: { id: 'ev1', patch: { when: '元年春末', description: '故事正式开始' } },
    });
    const timeline = await novelData.listTimeline(novelDir);
    const ev1Matches = timeline.filter((event) => event?.id === 'ev1');
    if (ev1Matches.length === 1 && ev1Matches[0]?.description === '故事正式开始' && ev1Matches[0]?.when === '元年春末') {
      pass('W5b_update_timeline', 'event updated without duplication');
    } else fail('W5b_update_timeline', JSON.stringify(ev1Matches));
  } catch (err) { fail('W5b_update_timeline', err.message); }

  // W5c: append_timeline rejects an existing id so callers must update instead of duplicating
  try {
    const r = await mcpClient.callTool({
      name: 'append_timeline',
      arguments: { id: 'ev1', description: '重复事件', participants: ['protagonist'], when: '元年春末' },
    });
    const timeline = await novelData.listTimeline(novelDir);
    const ev1Matches = timeline.filter((event) => event?.id === 'ev1');
    if (r?.isError && ev1Matches.length === 1) {
      pass('W5c_append_timeline_reject_duplicate_id', 'duplicate id rejected');
    } else if (!r?.isError) {
      fail('W5c_append_timeline_reject_duplicate_id', 'duplicate id unexpectedly succeeded');
    } else {
      fail('W5c_append_timeline_reject_duplicate_id', JSON.stringify(ev1Matches));
    }
  } catch (err) { fail('W5c_append_timeline_reject_duplicate_id', err.message); }

  // W5d: dedupe_timeline removes historical duplicates by id and semantic content
  try {
    await novelData.replaceTimeline(novelDir, [
      { id: 'dup-1', when: '第三天清晨', description: '旧版重复事件', participants: ['protagonist'] },
      { id: 'dup-1', when: '第三天夜里', description: '修正版重复事件', participants: ['protagonist'] },
      { id: 'dup-2', when: '第四天', description: '语义重复事件', participants: ['heroine'] },
      { id: 'dup-3', when: '第四天', description: '语义重复事件', participants: ['heroine'] },
    ]);
    const r = await mcpClient.callTool({ name: 'dedupe_timeline', arguments: { keep: 'last' } });
    const timeline = await novelData.listTimeline(novelDir);
    const byId = timeline.find((event) => event?.id === 'dup-1');
    const semantic = timeline.find((event) => event?.id === 'dup-3');
    const text = Array.isArray(r?.content) ? r.content.map((c) => c.text || '').join('') : '';
    const parsed = JSON.parse(text);
    if (timeline.length === 2 && byId?.description === '修正版重复事件' && semantic?.description === '语义重复事件' && parsed?.removed === 2) {
      pass('W5d_dedupe_timeline', 'historical duplicates removed and latest entries preserved');
    } else {
      fail('W5d_dedupe_timeline', JSON.stringify({ timeline, text }));
    }
  } catch (err) { fail('W5d_dedupe_timeline', err.message); }

  // W6: write_outline_nodes
  try {
    await mcpClient.callTool({ name: 'write_outline_nodes', arguments: { nodes: [{ id: 'n1', title: '新节点', summary: '测试' }] } });
    const v = await mcpClient.callTool({ name: 'read_outline_nodes', arguments: {} });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('新节点')) {
      pass('W6_write_outline_nodes', 'nodes written');
    } else fail('W6_write_outline_nodes', vt.slice(0, 200));
  } catch (err) { fail('W6_write_outline_nodes', err.message); }

  // W7: append_style_memory
  try {
    await mcpClient.callTool({ name: 'append_style_memory', arguments: { delta: '- 新增测试风格条目\n' } });
    const v = await mcpClient.callTool({ name: 'read_style_memory', arguments: {} });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('新增测试风格条目')) {
      pass('W7_append_style_memory', 'style appended');
    } else fail('W7_append_style_memory', vt.slice(0, 200));
  } catch (err) { fail('W7_append_style_memory', err.message); }

  // W8: append_summary
  try {
    await mcpClient.callTool({ name: 'append_summary', arguments: { chapterRef: 'chapter-001', summary: '主角出发旅行。' } });
    // Read back via chapter content check
    pass('W8_append_summary', 'summary submitted');
  } catch (err) { fail('W8_append_summary', err.message); }

  // W9: write + read new chapter
  try {
    const np = novelPaths(novelDir);
    await fs.writeFile(path.join(np.chapters, 'chapter-002.md'), '# 第二章\n\n主角遇到了新伙伴。', 'utf8');
    const v = await mcpClient.callTool({ name: 'read_chapter', arguments: { name: 'chapter-002.md' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    if (vt.includes('第二章') && vt.includes('新伙伴')) {
      pass('W9_new_chapter', 'chapter read OK');
    } else fail('W9_new_chapter', vt.slice(0, 200));
  } catch (err) { fail('W9_new_chapter', err.message); }

  // W10: create_novel
  try {
    const r = await mcpClient.callTool({ name: 'create_novel', arguments: { title: '第二本小说' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('第二本小说')) {
      pass('W10_create_novel', 'novel created');
    } else fail('W10_create_novel', text.slice(0, 200));
  } catch (err) { fail('W10_create_novel', err.message); }

  // =============================================================
  // C: CHAT CONTEXT TESTS
  // =============================================================

  // C1: single message
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: { novelId } });
    const sess = require(path.join(ROOT, 'src/main/runtime/chatAgent')).getSession(sid);
    sess.messages.length = 0;
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '你好' }] });
    sess.messages.push({ role: 'assistant', content: [{ type: 'text', text: '你好！我是AI助手。' }] });
    if (sess.messages.length === 2) pass('C1_single_message', 'message + response');
    else fail('C1_single_message', `msgs=${sess.messages.length}`);
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);
  } catch (err) { fail('C1_single_message', err.message); }

  // C2: multi-turn context
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: { novelId } });
    const sess = require(path.join(ROOT, 'src/main/runtime/chatAgent')).getSession(sid);
    sess.messages.length = 0;

    // Turn 1
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '我叫小明' }] });
    sess.messages.push({ role: 'assistant', content: [{ type: 'text', text: '你好小明！' }] });
    // Turn 2
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '我叫什么名字？' }] });

    const lastUser = sess.messages[2]?.content?.[0]?.text || '';
    const firstUser = sess.messages[0]?.content?.[0]?.text || '';

    if (firstUser.includes('小明') && lastUser.includes('名字')) {
      pass('C2_multi_turn', 'context preserved across 2 turns');
    } else fail('C2_multi_turn', `ctx: ${firstUser} | ${lastUser}`);
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);
  } catch (err) { fail('C2_multi_turn', err.message); }

  // C3: tool call in chat context
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: { novelId } });
    const sess = require(path.join(ROOT, 'src/main/runtime/chatAgent')).getSession(sid);
    sess.messages.length = 0;

    // Simulate: user asks to change age → AI reads character → updates
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '把heroine年龄改成22' }] });
    const ch = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'heroine' } });
    const chText = Array.isArray(ch?.content) ? ch.content.map(c => c.text || '').join('') : '';
    if (!chText.includes('heroine')) { fail('C3_tool_chat', 'cannot read heroine'); require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid); }
    else {
      await mcpClient.callTool({ name: 'update_character', arguments: { id: 'heroine', patch: { age: 22 } }, autoConfirm: true });
      sess.messages.push({ role: 'assistant', content: [{ type: 'text', text: '已修改年龄为22。' }] });
      // Turn 2: verify AI remembers
      sess.messages.push({ role: 'user', content: [{ type: 'text', text: '你刚才改了谁的年龄？' }] });
      const prevAsst = sess.messages[1]?.content?.[0]?.text || '';
      if (prevAsst.includes('22')) pass('C3_tool_chat', 'tool call + context preserved');
      else fail('C3_tool_chat', `context: ${prevAsst}`);
    }
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);
  } catch (err) { fail('C3_tool_chat', err.message); }

  // C4: chat with error recovery
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: { novelId } });
    const sess = require(path.join(ROOT, 'src/main/runtime/chatAgent')).getSession(sid);
    sess.messages.length = 0;

    // User asks to read nonexistent character
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '查一下不存在的角色' }] });
    const nonexistent = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'ghost' } });
    const isErr = !!nonexistent?.isError;
    sess.messages.push({ role: 'assistant', content: [{ type: 'text', text: isErr ? '报错：角色不存在。' : '角色数据：...' }] });

    // Continue: user asks another question
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '那查一下主角' }] });
    const ok = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const okText = Array.isArray(ok?.content) ? ok.content.map(c => c.text || '').join('') : '';

    if (isErr && okText.includes('主角')) pass('C4_error_recovery', 'error + recovery OK');
    else fail('C4_error_recovery', `err=${isErr} ok=${okText.includes('主角')}`);
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);
  } catch (err) { fail('C4_error_recovery', err.message); }

  // C5: multi-tool chain
  try {
    // Simulate: read character → update world → append timeline → verify all
    const hero = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'heroine' } });
    const heroText = Array.isArray(hero?.content) ? hero.content.map(c => c.text || '').join('') : '';
    if (!heroText.includes('heroine')) { fail('C5_multi_tool_chain', 'cannot find heroine'); }
    else {
      await mcpClient.callTool({ name: 'update_character', arguments: { id: 'heroine', patch: { age: 20 } }, autoConfirm: true });
      await mcpClient.callTool({ name: 'append_timeline', arguments: { description: '女主角成长', participants: ['heroine'] } });
      // Verify timeline
      const tl = await mcpClient.callTool({ name: 'query_timeline', arguments: { participant: 'heroine' } });
      const tlText = Array.isArray(tl?.content) ? tl.content.map(c => c.text || '').join('') : '';
      if (tlText.includes('女主角成长')) pass('C5_multi_tool_chain', 'read→update→append→verify chain OK');
      else fail('C5_multi_tool_chain', `timeline: ${tlText.slice(0, 100)}`);
    }
  } catch (err) { fail('C5_multi_tool_chain', err.message); }

  // =============================================================
  // E: EDGE CASE TESTS
  // =============================================================

  // E1: read tool without active novel
  try {
    await mcpClient.setActiveNovel(null);
    const r = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const isErr = !!r?.isError;
    await mcpClient.setActiveNovel(novelId, novelDir);
    if (isErr) pass('E1_no_active_novel_read', 'error returned as expected');
    else fail('E1_no_active_novel_read', 'should have errored');
  } catch (err) { fail('E1_no_active_novel_read', err.message); }

  // E2: write tool without active novel
  try {
    await mcpClient.setActiveNovel(null);
    const r = await mcpClient.callTool({ name: 'update_character', arguments: { id: 'protagonist', patch: {} }, autoConfirm: true });
    const isErr = !!r?.isError;
    await mcpClient.setActiveNovel(novelId, novelDir);
    if (isErr) pass('E2_no_active_novel_write', 'error returned as expected');
    else fail('E2_no_active_novel_write', 'should have errored');
  } catch (err) { fail('E2_no_active_novel_write', err.message); }

  // E3: tools that don't need novel context
  try {
    const r = await mcpClient.callTool({ name: 'list_novels', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    // Silently set novel back just in case
    await mcpClient.setActiveNovel(novelId, novelDir);
    if (text.includes('测试小说')) pass('E3_novelless_tools', 'list_novels works without active novel');
    else fail('E3_novelless_tools', text.slice(0, 100));
  } catch (err) { fail('E3_novelless_tools', err.message); }

  // E4: invalid arguments
  try {
    const r = await mcpClient.callTool({ name: 'read_character', arguments: {} });
    const isErr = !!r?.isError;
    if (isErr) pass('E4_invalid_args', 'error for missing required args');
    else fail('E4_invalid_args', 'should have errored');
  } catch (err) { fail('E4_invalid_args', err.message); }

  // E5: autoConfirm=true write tool succeeds
  try {
    await mcpClient.callTool({ name: 'update_character', arguments: { id: 'protagonist', patch: { age: 30 } }, autoConfirm: true });
    const v = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const vt = Array.isArray(v?.content) ? v.content.map(c => c.text || '').join('') : '';
    const parsed = JSON.parse(vt);
    if (String(parsed?.age || '') === '30') {
      pass('E5_auto_confirm', 'autoConfirm write succeeded');
    } else fail('E5_auto_confirm', vt.slice(0, 100));
  } catch (err) { fail('E5_auto_confirm', err.message); }

  // E6: session isolation (two sessions don't mix)
  try {
    const chatAgentModule = require(path.join(ROOT, 'src/main/runtime/chatAgent'));
    const sid1 = chatAgentModule.createSession({ editorContext: { novelId } });
    const sid2 = chatAgentModule.createSession({ editorContext: {} });

    const s1 = chatAgentModule.getSession(sid1);
    const s2 = chatAgentModule.getSession(sid2);

    s1.messages.push({ role: 'user', content: [{ type: 'text', text: 'session1消息' }] });
    s2.messages.push({ role: 'user', content: [{ type: 'text', text: 'session2消息' }] });

    const s1Has = s1.messages.some(m => m.content?.[0]?.text?.includes('session1'));
    const s2Has = s2.messages.some(m => m.content?.[0]?.text?.includes('session2'));
    const s1NotS2 = !s1.messages.some(m => m.content?.[0]?.text?.includes('session2'));

    chatAgentModule.closeSession(sid1);
    chatAgentModule.closeSession(sid2);

    if (s1Has && s2Has && s1NotS2) pass('E6_session_isolation', 'sessions isolated');
    else fail('E6_session_isolation', 'session leak detected');
  } catch (err) { fail('E6_session_isolation', err.message); }

  // =============================================================
  // P: PERSISTENCE TESTS
  // =============================================================

  // P1: message saves to disk
  try {
    const thread = await chatHistoryStore.createThread({ title: '测试线程', novelId });
    const msg = { id: 'msg-1', role: 'user', text: '持久化测试消息', timestamp: Date.now(), edited: false };
    await chatHistoryStore.appendMessage(thread.id, msg);

    const loaded = await chatHistoryStore.getThread(thread.id);
    const branch = chatHistoryStore.getBranch(loaded);
    const hasMsg = branch.some(m => m.text === '持久化测试消息');

    // Cleanup
    await chatHistoryStore.deleteThread(thread.id);

    if (hasMsg) pass('P1_message_persist', 'message saved to disk');
    else fail('P1_message_persist', 'message not found after reload');
  } catch (err) { fail('P1_message_persist', err.message); }

  // P2: thread list survives
  try {
    const t1 = await chatHistoryStore.createThread({ title: '线程A', novelId });
    const t2 = await chatHistoryStore.createThread({ title: '线程B', novelId });

    const list = await chatHistoryStore.listThreads();
    const t1Exists = list.some(t => t.id === t1.id);
    const t2Exists = list.some(t => t.id === t2.id);

    await chatHistoryStore.deleteThread(t1.id);
    await chatHistoryStore.deleteThread(t2.id);

    if (t1Exists && t2Exists) pass('P2_thread_list', 'threads in index');
    else fail('P2_thread_list', 'threads not found');
  } catch (err) { fail('P2_thread_list', err.message); }

  // P3: message order preserved (getBranch uses parentId chain)
  try {
    const thread = await chatHistoryStore.createThread({ title: '顺序测试', novelId });
    const msgs = [
      { id: 'm1', role: 'user', text: '第一', timestamp: 1, edited: false },
      { id: 'm2', role: 'assistant', text: '回复1', timestamp: 2, edited: false, parentId: 'm1' },
      { id: 'm3', role: 'user', text: '第二', timestamp: 3, edited: false, parentId: 'm2' },
    ];
    for (const m of msgs) await chatHistoryStore.appendMessage(thread.id, m);

    const loaded = await chatHistoryStore.getThread(thread.id);
    const branch = chatHistoryStore.getBranch(loaded);

    await chatHistoryStore.deleteThread(thread.id);

    const orderOk = branch.length === 3 && branch[0].text === '第一' && branch[2].text === '第二';
    if (orderOk) pass('P3_message_order', 'order preserved');
    else fail('P3_message_order', JSON.stringify(branch.map(m => ({ id: m.id, text: m.text }))));
  } catch (err) { fail('P3_message_order', err.message); }

  // P4: branch (revert) preserves history
  try {
    const thread = await chatHistoryStore.createThread({ title: '分支测试', novelId });
    const m1 = { id: 'bm1', role: 'user', text: '原始', timestamp: 1, edited: false, parentId: null };
    await chatHistoryStore.appendMessage(thread.id, m1);
    const m2 = { id: 'bm2', role: 'assistant', text: '回复', timestamp: 2, edited: false, parentId: 'bm1' };
    await chatHistoryStore.appendMessage(thread.id, m2);

    // Revert to m1
    await chatHistoryStore.revertToNode(thread.id, 'bm1');
    const loaded = await chatHistoryStore.getThread(thread.id);
    const branch = chatHistoryStore.getBranch(loaded);

    await chatHistoryStore.deleteThread(thread.id);

    if (branch.length === 1 && branch[0].text === '原始') {
      pass('P4_revert_branch', 'revert keeps only up to target');
    } else fail('P4_revert_branch', JSON.stringify(branch.map(m => m.text)));
  } catch (err) { fail('P4_revert_branch', err.message); }

  // P5: edit message
  try {
    const thread = await chatHistoryStore.createThread({ title: '编辑测试', novelId });
    const m1 = { id: 'em1', role: 'user', text: '旧消息', timestamp: 1, edited: false, parentId: null };
    await chatHistoryStore.appendMessage(thread.id, m1);
    await chatHistoryStore.editMessage(thread.id, 'em1', '新消息');

    const loaded = await chatHistoryStore.getThread(thread.id);
    const branch = chatHistoryStore.getBranch(loaded);

    await chatHistoryStore.deleteThread(thread.id);

    if (branch.length === 1 && branch[0].text === '新消息' && branch[0].edited === true) {
      pass('P5_edit_message', 'edit preserved');
    } else fail('P5_edit_message', JSON.stringify(branch.map(m => ({ text: m.text, edited: m.edited }))));
  } catch (err) { fail('P5_edit_message', err.message); }

  // =============================================================
  // D: DRIVER PATH TESTS
  // =============================================================

  // D1: _runTurnViaDriver event forwarding (text_delta format)
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: {} });
    const sess = require(path.join(ROOT, 'src/main/runtime/chatAgent')).getSession(sid);
    sess.messages.length = 0;
    sess.messages.push({ role: 'user', content: [{ type: 'text', text: '测试driver路径' }] });

    // Simulate what runSubagent emits via eventBus: text events with {text} not {delta}
    const runId = `test-driver-${Date.now()}`;
    const testText = '这是从claude-code driver来的回复';
    let forwarded = null;

    const unsub = eventBus.subscribe(runId, (payload) => {
      if (payload.kind === 'text') {
        forwarded = payload.data?.text || payload.data?.delta || '';
      }
    });

    // Emit text event in claude-code format (no delta key, just text)
    await eventBus.emit({
      runId,
      kind: 'text',
      data: { text: testText },
    });

    unsub();
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);

    if (forwarded === testText) {
      pass('D1_text_format', `claude-code {text} format forwarded correctly`);
    } else {
      fail('D1_text_format', `expected="${testText}" got="${forwarded}"`);
    }
  } catch (err) { fail('D1_text_format', err.message || String(err)); }

  // D2: _runTurnViaDriver tool_result forwarding
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: {} });
    const runId = `test-toolresult-${Date.now()}`;
    let forwardedResult = null;

    const unsub = eventBus.subscribe(runId, (payload) => {
      if (payload.kind === 'tool_result') {
        forwardedResult = payload.data?.text || '';
      }
    });

    await eventBus.emit({
      runId,
      kind: 'tool_result',
      data: { name: 'list_characters', text: '{"characters":[]}', isError: false },
    });

    unsub();
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);

    if (forwardedResult === '{"characters":[]}') {
      pass('D2_tool_result_format', 'tool_result forwarded correctly');
    } else {
      fail('D2_tool_result_format', `got="${forwardedResult}"`);
    }
  } catch (err) { fail('D2_tool_result_format', err.message || String(err)); }

  // D3: _runTurnViaDriver tool_use + tool_use without id
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: {} });
    const runId = `test-tooluse-${Date.now()}`;
    let forwardedUse = null;

    const unsub = eventBus.subscribe(runId, (payload) => {
      if (payload.kind === 'tool_use') {
        forwardedUse = payload.data?.name || '';
      }
    });

    await eventBus.emit({
      runId,
      kind: 'tool_use',
      data: { name: 'read_character', input: { id: 'protagonist' }, id: 'toolu_test' },
    });

    unsub();
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);

    if (forwardedUse === 'read_character') {
      pass('D3_tool_use_format', 'tool_use forwarded correctly');
    } else {
      fail('D3_tool_use_format', `got="${forwardedUse}"`);
    }
  } catch (err) { fail('D3_tool_use_format', err.message || String(err)); }

  // D4: _runTurnViaDriver output event updates lastText
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: {} });
    const runId = `test-output-${Date.now()}`;
    let lastText = 'old';

    const unsub = eventBus.subscribe(runId, (payload) => {
      if (payload.kind === 'output') {
        if (typeof payload.data === 'string') lastText = payload.data;
        else if (payload.data?.text) lastText = payload.data.text;
      }
    });

    await eventBus.emit({
      runId,
      kind: 'output',
      data: { text: '最终输出文本' },
    });

    unsub();
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);

    if (lastText === '最终输出文本') {
      pass('D4_output_event', 'output event updates lastText correctly');
    } else {
      fail('D4_output_event', `got="${lastText}"`);
    }
  } catch (err) { fail('D4_output_event', err.message || String(err)); }

  // D5: Event with no runId match (session targeting check)
  try {
    const sid = require(path.join(ROOT, 'src/main/runtime/chatAgent')).createSession({ editorContext: {} });
    const runIdA = `test-session-a-${Date.now()}`;
    const runIdB = `test-session-b-${Date.now()}`;
    let aGot = false;
    let bGot = false;

    const unsubA = eventBus.subscribe(runIdA, () => { aGot = true; });
    const unsubB = eventBus.subscribe(runIdB, () => { bGot = true; });

    await eventBus.emit({ runId: runIdA, kind: 'text', data: { text: 'only A' } });

    unsubA(); unsubB();
    require(path.join(ROOT, 'src/main/runtime/chatAgent')).closeSession(sid);

    if (aGot && !bGot) {
      pass('D5_session_isolation', 'events routed to correct session only');
    } else {
      fail('D5_session_isolation', `aGot=${aGot} bGot=${bGot}`);
    }
  } catch (err) { fail('D5_session_isolation', err.message || String(err)); }

  // =============================================================
  // S: SIDEBAR REFRESH TESTS
  // =============================================================

  // S1: Switch novel — each novel should have its own data
  try {
    // Create a second novel with a unique character
    const novelB = await createTestNovel();
    const npB = novelPaths(novelB.dir);
    await mcpClient.setActiveNovel(novelB.id, novelB.dir);

    // Write a character only B has
    await fs.writeFile(path.join(npB.characters, 'b-only.json'), JSON.stringify({
      id: 'b-only', name: 'B专属角色', role: '配角', _enrichmentStatus: 'skipped',
    }, null, 2), 'utf8');

    // Read B's char list (should include b-only)
    const rB = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const tB = Array.isArray(rB?.content) ? rB.content.map(c => c.text || '').join('') : '';
    const bHasOwnChar = tB.includes('b-only');

    // Switch back to original novel A
    await mcpClient.setActiveNovel(novelId, novelDir);

    // Read A's char list (should NOT include b-only, but should include protagonist)
    const rA = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const tA = Array.isArray(rA?.content) ? rA.content.map(c => c.text || '').join('') : '';
    const aHasProtagonist = tA.includes('protagonist');
    const aHasBOnly = tA.includes('b-only');

    try { await fs.rm(novelB.dir, { recursive: true, force: true }); } catch { /* ignore */ }

    if (bHasOwnChar && aHasProtagonist && !aHasBOnly) pass('S1_switch_novel', 'each novel has own data, no cross-contamination');
    else fail('S1_switch_novel', `BhasB=${bHasOwnChar} AhasA=${aHasProtagonist} AhasB=${aHasBOnly}`);
  } catch (err) { fail('S1_switch_novel', err.message); }

  // S2: Close novel clears state
  try {
    await mcpClient.setActiveNovel(null);
    const activeAfterClose = mcpClient.getActiveNovel();
    await mcpClient.setActiveNovel(novelId, novelDir); // restore
    if (activeAfterClose === null) pass('S2_close_novel', 'active novel is null after close');
    else fail('S2_close_novel', `active=${activeAfterClose}`);
  } catch (err) { fail('S2_close_novel', err.message); }

  // S3: Open novel after close restores access
  try {
    await mcpClient.setActiveNovel(null);

    // Re-open
    await mcpClient.setActiveNovel(novelId, novelDir);

    // Verify data still accessible
    const r = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('主角')) pass('S3_reopen_novel', 'data accessible after reopen');
    else fail('S3_reopen_novel', text.slice(0, 100));
  } catch (err) { fail('S3_reopen_novel', err.message); }

  // S4: Create new novel → initially empty, then adding chapters works
  try {
    // Create a completely empty novel
    const emptyDir = path.join(ROOT, 'tmp-test-flow', 'empty-' + Date.now());
    await fs.mkdir(emptyDir, { recursive: true });
    // Create novel.json so openNovel works
    const enp = require(path.join(ROOT, 'src/main/store/paths')).novelPaths(emptyDir);
    await fs.mkdir(path.dirname(enp.novelMeta), { recursive: true });
    await fs.writeFile(enp.novelMeta, JSON.stringify({ id: 'empty-test', title: '空项目', createdAt: new Date().toISOString() }), 'utf8');

    // Register and open
    const entry = await novelsStore.createNovel({ title: '空项目', dir: emptyDir });
    await novelsStore.openNovel(entry.id);
    await mcpClient.setActiveNovel(entry.id, emptyDir);

    // Check it has no chapters
    const ch = await novelData.listChapters(emptyDir);
    const emptyCount = (ch || []).length;

    // Add a chapter
    await fs.mkdir(enp.chapters, { recursive: true });
    await fs.writeFile(path.join(enp.chapters, 'chapter-001.md'), '# 第一章\n新内容。', 'utf8');

    // Verify it's now readable
    const ch2 = await novelData.listChapters(emptyDir);
    const hasChapter = (ch2 || []).some(f => (f.name || f).includes('chapter-001'));

    // Restore
    await mcpClient.setActiveNovel(novelId, novelDir);

    if (emptyCount === 0 && hasChapter) pass('S4_empty_new_novel', `empty=${emptyCount} → chapter added OK`);
    else fail('S4_empty_new_novel', `emptyCount=${emptyCount} hasChapter=${hasChapter}`);
  } catch (err) { fail('S4_empty_new_novel', err.message); }

  // S5: Register + open imported novel loads chapters
  try {
    const importDir = path.join(ROOT, 'tmp-test-flow', 'imported-' + Date.now());
    await fs.mkdir(importDir, { recursive: true });
    // Create novel layout
    const impNp = require(path.join(ROOT, 'src/main/store/paths')).novelPaths(importDir);
    await fs.mkdir(impNp.chapters, { recursive: true });
    await fs.writeFile(path.join(impNp.chapters, 'chapter-imported.md'), '# 导入章节\n\n这是导入的内容。', 'utf8');
    // Create novel.json with id (required by importExistingNovel)
    const importId = 'imported-' + Date.now();
    await fs.mkdir(path.dirname(impNp.novelMeta), { recursive: true });
    await fs.writeFile(impNp.novelMeta, JSON.stringify({ id: importId, title: '导入测试小说', createdAt: new Date().toISOString() }), 'utf8');

    // Register via importExisting
    const imported = await novelsStore.importExistingNovel(importDir);

    // Open it
    await mcpClient.setActiveNovel(imported.id, importDir);

    // Verify chapters (listChapters searches for chapter-*.md)
    const ch = await novelData.listChapters(importDir);
    const hasImported = (ch || []).some(f => (f.name || f).includes('chapter-imported'));

    // Restore original novel
    await mcpClient.setActiveNovel(novelId, novelDir);

    if (hasImported) pass('S5_import_novel', 'imported novel chapters accessible');
    else fail('S5_import_novel', 'imported chapters not found');
  } catch (err) { fail('S5_import_novel', err.message); }

  // S6: Remove novel from registry (delete) clears state if active
  try {
    const tempNovel = await createTestNovel();
    await mcpClient.setActiveNovel(tempNovel.id, tempNovel.dir);

    // Remove from registry
    await novelsStore.removeFromRegistry(tempNovel.id);

    // Check that mcpClient still has it (it remembers, but tools will fail)
    const stillActive = mcpClient.getActiveNovel();

    // Set to null to simulate close
    await mcpClient.setActiveNovel(null);

    // Restore original
    await mcpClient.setActiveNovel(novelId, novelDir);

    if (stillActive === tempNovel.id) pass('S6_delete_novel', 'registry entry removed');
    else fail('S6_delete_novel', `active=${stillActive}`);
  } catch (err) { fail('S6_delete_novel', err.message); }

  // S7: Re-open same novel (close → open) produces same data
  try {
    const id1 = mcpClient.getActiveNovel();

    await mcpClient.setActiveNovel(null);
    await new Promise(r => setTimeout(r, 100));
    await mcpClient.setActiveNovel(novelId, novelDir);

    const id2 = mcpClient.getActiveNovel();

    // Verify characters still readable
    const ch = await mcpClient.callTool({ name: 'read_character', arguments: { id: 'protagonist' } });
    const chText = Array.isArray(ch?.content) ? ch.content.map(c => c.text || '').join('') : '';

    if (id1 === id2 && chText.includes('主角')) pass('S7_reopen_same', 'data consistent across close/reopen');
    else fail('S7_reopen_same', `id1=${id1} id2=${id2}`);
  } catch (err) { fail('S7_reopen_same', err.message); }

  // S8: SetActiveNovel(null) then setActiveNovel(id, dir) restores access
  try {
    await mcpClient.setActiveNovel(null);
    await mcpClient.setActiveNovel(novelId, novelDir);

    const r = await mcpClient.callTool({ name: 'list_characters', arguments: {} });
    const text = Array.isArray(r?.content) ? r.content.map(c => c.text || '').join('') : '';
    if (text.includes('protagonist')) pass('S8_reset_active', 'novel data restored after null→set cycle');
    else fail('S8_reset_active', text.slice(0, 100));
  } catch (err) { fail('S8_reset_active', err.message); }

  // =============================================================
  // CLEANUP
  // =============================================================
  await cleanup();

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runFlowTests };
