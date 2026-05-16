'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-writing-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天写作 UI 回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'hero.json'), JSON.stringify({
    id: 'hero',
    name: '楚岚',
    role: '主角',
    personality: '理性、克制、嘴硬',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n鹏城与武夷山之间存在明确的时间与交通约束。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '鹏城', description: '现代都市' }, null, 2), 'utf8');

  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), '# 第1章：破庙\n\n第一章正文。', 'utf8');
  await fs.writeFile(path.join(np.chapters, 'chapter-002.md'), '# 第2章：天桥\n\n第二章正文。', 'utf8');

  return { entry, dir, cleanupRoot: tmpRoot };
}

function createProviderStub() {
  return async ({ system, messages }) => {
    const systemText = String(system || '');
    const lastUser = Array.isArray(messages)
      ? [...messages].reverse().find((message) => message.role === 'user')
      : null;
    const userText = Array.isArray(lastUser?.content)
      ? lastUser.content.map((block) => block?.text || '').join('\n')
      : '';

    if (/Drafting Override/.test(systemText)) {
      const isRevised = /调整|润色|重写|检查/.test(userText);
      return {
        stopReason: 'end_turn',
        content: [{
          type: 'text',
          text: JSON.stringify({
            title: isRevised ? '领人（修订版）' : '领人',
            summary: isRevised ? '修订后的第三章草稿' : '第三章草稿',
            text: isRevised
              ? '修订版正文：陈队长当晚赶去武夷山领人，次日再回鹏城，楚岚晚上才决定开播。'
              : '第三章正文：陈队长当晚赶去武夷山领人，次日回到鹏城后，楚岚和阿宁讨论吴老狗的蹊跷。',
          }),
        }],
      };
    }

    if (/Chapter Review Override/.test(systemText)) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ issues: [] }) }],
      };
    }

    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '普通聊天兜底回复。' }],
    };
  };
}

async function runChatWritingUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
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

  const providerManager = require(path.join(ROOT, 'src/main/providerManager'));
  const modelAliases = require(path.join(ROOT, 'src/main/modelAliases'));
  const workflowOrchestrator = require(path.join(ROOT, 'src/main/runtime/workflowOrchestrator'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalSendMessage = anthropicProvider.sendMessage;

  let cleanupRoot = '';
  let novelDir = '';

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    novelDir = seeded.dir;
    pass('WU1_seed_novel', `novel=${seeded.entry.id}`);

    providerManager.getActiveProvider = async () => ({
      id: 'writing-ui-regression-provider',
      name: 'writing-ui-regression-provider',
      type: 'anthropic',
      apiKey: 'writing-ui-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'writing-ui-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'writing-ui-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    anthropicProvider.sendMessage = createProviderStub();

    await delay(1800);

    const ready = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 12000) {
          const input = document.querySelector('input[placeholder="向 AI 提问…"]');
          const body = document.body.innerText || '';
          if (input && body.includes('聊天写作 UI 回归小说')) {
            return { ok: true };
          }
          const buttons = Array.from(document.querySelectorAll('button'));
          const chatBtn = buttons.find((button) => {
            const text = button.textContent || '';
            const svg = button.querySelector('svg');
            return text.includes('AI') || svg?.getAttribute('data-lucide') === 'message-square' || svg?.classList.contains('lucide-message-square');
          });
          if (!input && chatBtn) chatBtn.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 600) };
      })()
    `);
    if (ready?.ok) {
      pass('WU2_ui_ready', 'chat input and writing novel visible');
    } else {
      fail('WU2_ui_ready', JSON.stringify(ready));
    }

    const createTurn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        async function sendChatMessage(text) {
          const input = document.querySelector('input[placeholder="向 AI 提问…"]');
          if (!input) return { ok: false, step: 'find_input' };
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, text);
          else input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 150));

          const buttons = Array.from(document.querySelectorAll('button'));
          const sendBtn = buttons.find((button) => {
            if (button.disabled) return false;
            const svg = button.querySelector('svg');
            return svg && (svg.getAttribute('data-lucide') === 'send' || svg.classList.contains('lucide-send'));
          });
          if (!sendBtn) return { ok: false, step: 'find_send' };
          sendBtn.click();

          const startedAt = Date.now();
          while (Date.now() - startedAt < 12000) {
            const bodyText = document.body.innerText || '';
            if (
              bodyText.includes('我现在先停在章节审阅阶段')
              && bodyText.includes('章节草稿：第3章《领人》')
              && bodyText.includes('审查结果')
              && !bodyText.includes('总大纲')
              && !bodyText.includes('普通聊天兜底回复。')
            ) {
              return { ok: true, bodyText: bodyText.slice(0, 1400) };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ok: false, step: 'await_review_reply', bodyText: (document.body.innerText || '').slice(0, 1400) };
        }
        return sendChatMessage('第三章的剧情是陈队长先去武夷山领人，随后次日回鹏城，楚岚晚上准备再直播一下');
      })()
    `);
    if (createTurn?.ok) {
      pass('WU3_chapter_brief_enters_review_state_in_ui', 'chapter brief rendered as chapter review, not outline draft or ordinary chat');
    } else {
      fail('WU3_chapter_brief_enters_review_state_in_ui', JSON.stringify(createTurn));
    }

    let chapterThreeExists = true;
    try {
      await fs.access(path.join(novelDir, 'chapters', 'chapter-003.md'));
    } catch {
      chapterThreeExists = false;
    }
    if (!chapterThreeExists) {
      pass('WU4_review_state_does_not_persist_chapter', 'chapter file is still absent before explicit confirmation');
    } else {
      fail('WU4_review_state_does_not_persist_chapter', 'chapter-003.md was written before confirmation');
    }
  } catch (err) {
    fail('WU5_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    anthropicProvider.sendMessage = originalSendMessage;
    try {
      if (cleanupRoot) {
        await fs.rm(cleanupRoot, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup failure
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatWritingUiRegressionTest };