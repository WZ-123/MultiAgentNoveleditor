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

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-de-ai-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天去AI味 UI 回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.chapters, { recursive: true });
  const chapterBodies = {
    'chapter-001.md': '第一章正文。',
    'chapter-002.md': '第二章正文。',
    'chapter-003.md': ['第一段。', '', '然后她笑了。那是一个很淡的笑。', '', '第三段。'].join('\n'),
    'chapter-004.md': '第四章正文。',
    'chapter-005.md': '第五章正文。',
    'chapter-006.md': '第六章正文。',
  };
  for (const [name, body] of Object.entries(chapterBodies)) {
    await fs.writeFile(path.join(np.chapters, name), `# ${name}\n\n${body}`, 'utf8');
  }

  return { entry, dir, cleanupRoot: tmpRoot };
}

async function runChatDeAiUiRegressionTest(mainWindow) {
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
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));

  const originalGetActiveProvider = providerManager.getActiveProvider;
  const originalGetAlias = modelAliases.getAlias;
  const originalGetActiveDriverId = workflowOrchestrator.getActiveDriverId;
  const originalRunWorkflow = workflowOrchestrator.runWorkflow;
  const originalSendMessage = anthropicProvider.sendMessage;
  const originalCallTool = mcpClient.callTool;

  let cleanupRoot = '';
  let novelDir = '';

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    novelDir = seeded.dir;
    pass('DAU1_seed_novel', `novel=${seeded.entry.id}`);

    providerManager.getActiveProvider = async () => ({
      id: 'de-ai-ui-regression-provider',
      name: 'de-ai-ui-regression-provider',
      type: 'anthropic',
      apiKey: 'de-ai-ui-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'de-ai-ui-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'de-ai-ui-regression-model',
      maxOutputTokens: 512,
      temperature: 0,
    });
    workflowOrchestrator.getActiveDriverId = () => 'direct-api';
    workflowOrchestrator.runWorkflow = async (payload) => {
      if (payload?.mode !== 'subagent') {
        return originalRunWorkflow(payload);
      }
      if (payload?.subagentId === 'sa-prose-quality') {
        let chapterName = '';
        try {
          chapterName = JSON.parse(String(payload.input || '{}')).chapterName || '';
        } catch {
          chapterName = '';
        }
        if (chapterName === 'chapter-003.md') {
          return {
            output: JSON.stringify({
              annotations: [{ paragraphId: 'p-1', note: '短反应句加解释句，AI 味偏重。', kind: 'choppy' }],
            }),
          };
        }
        return { output: JSON.stringify({ annotations: [] }) };
      }
      if (payload?.subagentId === 'sa-de-ai-ifier') {
        return {
          output: '她笑了一下，笑意很淡，像把原本要出口的话收了回去。',
        };
      }
      return originalRunWorkflow(payload);
    };
    anthropicProvider.sendMessage = async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '普通聊天兜底回复。' }],
    });
    mcpClient.callTool = async (payload) => {
      const name = payload?.name;
      const args = payload?.arguments || {};
      if (name === 'review_de_ai_style') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              chapterCount: 5,
              totalAnnotations: 1,
              chapters: [
                { chapterName: 'chapter-002.md', annotations: [] },
                {
                  chapterName: 'chapter-003.md',
                  annotations: [{ paragraphIndex: 2, paragraphIndexes: [2], note: '短反应句加解释句，AI 味偏重。', kind: 'choppy' }],
                },
                { chapterName: 'chapter-004.md', annotations: [] },
                { chapterName: 'chapter-005.md', annotations: [] },
                { chapterName: 'chapter-006.md', annotations: [] },
              ],
            }),
          }],
        };
      }
      if (name === 'de_ai_ify') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ revisedText: '她笑了一下，笑意很淡，像把原本要出口的话收了回去。' }),
          }],
        };
      }
      return originalCallTool(payload);
    };

    await delay(1800);

    const ready = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 12000) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          const body = document.body.innerText || '';
          if (input && body.includes('聊天去AI味 UI 回归小说')) {
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
        return { ok: false, body: (document.body.innerText || '').slice(0, 800) };
      })()
    `);
    if (ready?.ok) {
      pass('DAU2_ui_ready', 'chat input and seeded novel visible');
    } else {
      fail('DAU2_ui_ready', JSON.stringify(ready));
    }

    const reviewTurn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        async function sendChatMessage(text, checks, timeout = 15000) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
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
          while (Date.now() - startedAt < timeout) {
            const bodyText = document.body.innerText || '';
            if (checks.every((item) => bodyText.includes(item)) && !bodyText.includes('普通聊天兜底回复。')) {
              return { ok: true, bodyText: bodyText.slice(0, 1600) };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ok: false, step: 'await_reply', bodyText: (document.body.innerText || '').slice(0, 1600) };
        }
        return sendChatMessage('拿去ai味工具审查2-6章', ['我已并行审查 5 章', 'chapter-003.md：1 处', '暂不自动改正文']);
      })()
    `);
    if (reviewTurn?.ok) {
      pass('DAU3_review_turn_renders_tool_result', 'multi-chapter de-ai review rendered in real chat UI');
    } else {
      fail('DAU3_review_turn_renders_tool_result', JSON.stringify(reviewTurn));
    }

    const applyTurn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        async function sendChatMessage(text, checks, timeout = 15000) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
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
          while (Date.now() - startedAt < timeout) {
            const bodyText = document.body.innerText || '';
            if (checks.every((item) => bodyText.includes(item)) && !bodyText.includes('普通聊天兜底回复。')) {
              return { ok: true, bodyText: bodyText.slice(0, 1800) };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ok: false, step: 'await_reply', bodyText: (document.body.innerText || '').slice(0, 1800) };
        }
        return sendChatMessage('方案A', ['已按上一次审查结果自动应用去 AI 味修改', 'chapter-003.md：1 处']);
      })()
    `);
    if (applyTurn?.ok) {
      pass('DAU4_plan_a_applies_in_ui', 'plan A follow-up applied fixes through the real chat UI');
    } else {
      fail('DAU4_plan_a_applies_in_ui', JSON.stringify(applyTurn));
    }

    const chapterThree = await novelData.readChapter(novelDir, 'chapter-003.md');
    if (
      chapterThree.includes('她笑了一下，笑意很淡，像把原本要出口的话收了回去。')
      && !chapterThree.includes('然后她笑了。那是一个很淡的笑。')
    ) {
      pass('DAU5_plan_a_persists_rewritten_chapter', 'chapter-003.md was rewritten on disk after UI follow-up');
    } else {
      fail('DAU5_plan_a_persists_rewritten_chapter', chapterThree);
    }
  } catch (err) {
    fail('DAU6_harness', err.message || String(err));
  } finally {
    providerManager.getActiveProvider = originalGetActiveProvider;
    modelAliases.getAlias = originalGetAlias;
    workflowOrchestrator.getActiveDriverId = originalGetActiveDriverId;
    workflowOrchestrator.runWorkflow = originalRunWorkflow;
    anthropicProvider.sendMessage = originalSendMessage;
    mcpClient.callTool = originalCallTool;
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

module.exports = { runChatDeAiUiRegressionTest };
