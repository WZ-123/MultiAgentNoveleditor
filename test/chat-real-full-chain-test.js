'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

function realUserDataRoot() {
  if (process.env.MANA_REAL_USER_DATA_ROOT) return process.env.MANA_REAL_USER_DATA_ROOT;
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'multi-agent-novel-assistant',
    'MultiAgentNovelAssistant'
  );
}

async function copyIfExists(src, dest) {
  try {
    await fs.copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

async function seedProviderConfig(targetRoot) {
  const sourceRoot = realUserDataRoot();
  await fs.mkdir(targetRoot, { recursive: true });
  const providersOk = await copyIfExists(path.join(sourceRoot, 'providers.json'), path.join(targetRoot, 'providers.json'));
  const aliasesOk = await copyIfExists(path.join(sourceRoot, 'modelAliases.json'), path.join(targetRoot, 'modelAliases.json'));
  if (!providersOk || !aliasesOk) {
    throw new Error(`real provider config missing: providers=${providersOk} aliases=${aliasesOk} source=${sourceRoot}`);
  }
  return { sourceRoot };
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-real-full-chain');
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '真实全链路测试小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'shen-yan.json'), JSON.stringify({
    id: 'shen-yan',
    name: '沈砚',
    role: '主角',
    gender: '男',
    personality: '克制、敏锐、习惯先观察后行动',
    appearance: '黑发，眼下有浅淡旧伤',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.writeFile(path.join(np.characters, 'lin-shuang.json'), JSON.stringify({
    id: 'lin-shuang',
    name: '林霜',
    role: '搭档',
    gender: '女',
    personality: '冷静、直接、判断很快',
    appearance: '短发，常穿深色外套',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n北雾港常年被海雾笼罩。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '北雾港', description: '海港城' }, null, 2), 'utf8');

  const thread = await chatHistory.createThread({ title: '真实工具链测试', novelId: entry.id });
  return { entry, dir, threadId: thread.id, cleanupRoot: tmpRoot };
}

async function runRealFullChainTest() {
  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  const ROOT = path.resolve(__dirname, '..');
  const { paths } = require(path.join(ROOT, 'src/main/store/paths'));
  const chatAgent = require(path.join(ROOT, 'src/main/runtime/chatAgent'));
  const chatHistory = require(path.join(ROOT, 'src/main/store/chatHistory'));

  let cleanupRoot = '';

  try {
    const cfg = await seedProviderConfig(paths().root);
    pass('R1_provider_config', `copied from ${cfg.sourceRoot}`);
  } catch (err) {
    fail('R1_provider_config', err.message || String(err));
    console.log('');
    console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
    console.log('TEST_DONE');
    return results;
  }

  let threadId = '';
  let sessionId = '';
  const userText = '请先调用工具 read_character 读取 id 为 shen-yan 的角色卡，再用中文告诉我他的身份和性格，不要编造。';

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    threadId = seeded.threadId;
    await chatHistory.appendMessage(threadId, {
      id: `msg-user-${Date.now()}`,
      role: 'user',
      text: userText,
      timestamp: Date.now(),
      edited: false,
      toolCalls: null,
    });
    sessionId = chatAgent.createSession({
      editorContext: { novelId: seeded.entry.id, chapterCount: 1 },
      messages: [{ role: 'user', text: userText }],
      threadId,
    });
    pass('R2_seed_novel', `novel=${seeded.entry.id} thread=${threadId}`);
  } catch (err) {
    fail('R2_seed_novel', err.message || String(err));
  }

  try {
    await chatAgent.runTurn(sessionId, userText);
    const saved = await chatHistory.getThread(threadId);
    const branch = chatHistory.getBranch(saved);
    const assistant = [...branch].reverse().find((m) => m.role === 'assistant') || null;
    const toolCalls = assistant?.toolCalls || [];
    const hasToolCall = Array.isArray(toolCalls) && toolCalls.length > 0;
    const toolNames = hasToolCall ? toolCalls.map((t) => t.name).join(',') : '';
    const answer = assistant?.text || '';
    const mentionsCharacter = answer.includes('沈砚');
    const mentionsRoleOrPersonality = answer.includes('主角') || answer.includes('克制') || answer.includes('敏锐');

    if (hasToolCall && mentionsCharacter && mentionsRoleOrPersonality) {
      pass('R3_real_full_chain', `tools=${toolNames} answer="${answer.slice(0, 80)}"`);
    } else {
      fail('R3_real_full_chain', JSON.stringify({
        hasToolCall,
        toolNames,
        answer: answer.slice(0, 200),
        toolCalls,
      }));
    }
  } catch (err) {
    fail('R3_real_full_chain', err.message || String(err));
  }

  try {
    const reopened = await chatHistory.getThread(threadId);
    const branch = chatHistory.getBranch(reopened);
    const assistant = [...branch].reverse().find((m) => m.role === 'assistant') || null;
    const toolCalls = assistant?.toolCalls || [];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      pass('R4_reopen_keeps_tool_calls', `toolCalls=${toolCalls.length}`);
    } else {
      fail('R4_reopen_keeps_tool_calls', JSON.stringify(assistant));
    }
  } catch (err) {
    fail('R4_reopen_keeps_tool_calls', err.message || String(err));
  }

  try {
    if (sessionId) chatAgent.closeSession(sessionId);
  } catch {
    // ignore
  }

  try {
    if (cleanupRoot) {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runRealFullChainTest };