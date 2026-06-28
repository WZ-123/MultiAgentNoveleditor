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

  const tmpRoot = path.join(ROOT, 'tmp-test-chat-outline-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '聊天大纲 UI 回归小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'hero.json'), JSON.stringify({
    id: 'hero',
    name: '主角',
    role: '巡夜人',
    personality: '克制、敏锐、记仇但守诺',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n海雾港常年被海雾包围。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '海雾港', description: '被海雾包围的港城' }, null, 2), 'utf8');

  return { entry, dir, cleanupRoot: tmpRoot };
}

function makeHierarchy(kind) {
  const isRevised = kind === 'revise';
  return {
    id: isRevised ? 'outline-revise' : 'outline-create',
    version: 1,
    master: [
      {
        id: 'vol-1',
        title: '回港',
        summary: isRevised ? '主角与旧搭档重逢后被迫再次联手。' : '主角收到海雾港的求救信，决定返港。',
        volumeIndex: 1,
      },
    ],
    volumes: [
      {
        volumeIndex: 1,
        metadata: {
          id: 'vol-1',
          title: '回港',
          summary: isRevised ? '主线冲突集中在主角与搭档旧怨。' : '主角在返港中被卷入旧案。',
          volumeIndex: 1,
        },
        sections: [
          {
            sectionIndex: 1,
            metadata: {
              id: 'sec-1-1',
              title: isRevised ? '雾中重逢' : '雾城来信',
              summary: isRevised ? '旧搭档现身，逼主角直面旧案。' : '求救信引出海雾港旧案。',
              volumeIndex: 1,
              sectionIndex: 1,
            },
            chapterOutlines: [
              {
                chapterIndex: 1,
                title: isRevised ? '旧钟楼' : '归雾',
                writingNotes: isRevised ? '突出主角与搭档对旧案责任的分歧。' : '突出主角收到求救信后的犹疑与决断。',
                scenes: [
                  {
                    id: isRevised ? 'scene-revise-1' : 'scene-create-1',
                    title: isRevised ? '钟楼重逢' : '来信抵港',
                    summary: isRevised ? '主角在旧钟楼与搭档重逢，二人因旧案爆发冲突。' : '主角在夜里收到求救信，决定返回海雾港。',
                    characters: ['hero'],
                    volumeIndex: 1,
                    sectionIndex: 1,
                    chapterIndex: 1,
                    location: isRevised ? '旧钟楼' : '巡夜站',
                    pov: 'hero',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildDraftResponse(userText) {
  const isRevised = /细化|强化|调整/.test(userText);
  const hierarchy = makeHierarchy(isRevised ? 'revise' : 'create');
  const rawMarkdown = isRevised
    ? '# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾中重逢\n\n- 第1章：旧钟楼\n  - 钟楼重逢：主角与搭档因旧案爆发冲突。'
    : '# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾城来信\n\n- 第1章：归雾\n  - 来信抵港：主角收到求救信，决定返回海雾港。';
  const assistantText = isRevised
    ? '我已按专用大纲流程基于当前草案重做了一版，先不写入项目。\n\n# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾中重逢\n\n如果确认写入项目，请回复“确认写入大纲”或“保存这个大纲”。'
    : '我已按专用大纲流程生成了一版草案，先不写入项目。\n\n# 总大纲\n\n## 第一卷：回港\n\n### 第一节：雾城来信\n\n如果确认写入项目，请回复“确认写入大纲”或“保存这个大纲”。';
  return {
    hierarchy,
    rawMarkdown,
    assistantText,
  };
}

function createProviderStub() {
  return async ({ system, messages }) => {
    const systemText = String(system || '');
    const text = Array.isArray(messages)
      ? messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).map((block) => block?.text || '').join('\n')
      : '';

    if (/Outline Drafter|大纲撰写者|Drafting Override|结构化大纲草案/.test(systemText)) {
      const lastUser = Array.isArray(messages)
        ? [...messages].reverse().find((message) => message.role === 'user')
        : null;
      const userText = Array.isArray(lastUser?.content)
        ? lastUser.content.map((block) => block?.text || '').join('\n')
        : '';
      const response = buildDraftResponse(userText);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(response.hierarchy) }],
      };
    }

    if (/Character Reviewer|人设与世界观审查者/.test(systemText)) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ issues: [] }) }],
      };
    }

    if (/Timeline Guardian|时空与信息守护者/.test(systemText)) {
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

async function runChatOutlineUiRegressionTest(mainWindow) {
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
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));

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
    pass('OU1_seed_novel', `novel=${seeded.entry.id}`);

    providerManager.getActiveProvider = async () => ({
      id: 'outline-ui-regression-provider',
      name: 'outline-ui-regression-provider',
      type: 'anthropic',
      apiKey: 'outline-ui-regression-key',
      baseUrl: 'https://example.invalid',
      models: [{ id: 'outline-ui-regression-model' }],
    });
    modelAliases.getAlias = async (aliasId) => ({
      id: aliasId || 'sonnet',
      providerId: null,
      modelId: 'outline-ui-regression-model',
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
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          const body = document.body.innerText || '';
          if (input && body.includes('聊天大纲 UI 回归小说')) {
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
      pass('OU2_ui_ready', 'chat input and seeded novel visible');
    } else {
      fail('OU2_ui_ready', JSON.stringify(ready));
    }

    const createTurn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        async function sendChatMessage(text) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          if (!input) return { ok: false, step: 'find_input' };
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
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
            if (bodyText.includes('先不写入项目') && bodyText.includes('雾城来信') && !bodyText.includes('普通聊天兜底回复。')) {
              return { ok: true, bodyText: bodyText.slice(0, 1000) };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ok: false, step: 'await_create_reply', bodyText: (document.body.innerText || '').slice(0, 1000) };
        }
        return sendChatMessage('第三章剧情走向有何建议？总之第四章的剧情是楚岚在家里直播驱魔（不用你写，只是告诉你需要承上启下的内容）');
      })()
    `);
    if (createTurn?.ok) {
      pass('OU3_chapter_plot_brief_routes_to_draft_in_ui', 'chapter plot brief rendered as outline draft, not fallback chat');
    } else {
      fail('OU3_chapter_plot_brief_routes_to_draft_in_ui', JSON.stringify(createTurn));
    }

    const outlineAfterCreate = await novelData.readOutlineNodes(novelDir);
    if (!outlineAfterCreate?.nodes?.length) {
      pass('OU4_create_does_not_persist', 'outline still empty before confirmation');
    } else {
      fail('OU4_create_does_not_persist', JSON.stringify(outlineAfterCreate));
    }

    const reviseTurn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        async function sendChatMessage(text) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          if (!input) return { ok: false, step: 'find_input' };
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
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
            if (bodyText.includes('雾中重逢') && bodyText.includes('旧钟楼')) {
              return { ok: true, bodyText: bodyText.slice(0, 1200) };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ok: false, step: 'await_revise_reply', bodyText: (document.body.innerText || '').slice(0, 1200) };
        }
        return sendChatMessage('把这个大纲细化一下，强化主角和搭档的冲突');
      })()
    `);
    if (reviseTurn?.ok) {
      pass('OU5_revise_draft_in_ui', 'revised draft rendered in chat');
    } else {
      fail('OU5_revise_draft_in_ui', JSON.stringify(reviseTurn));
    }

    const outlineAfterRevise = await novelData.readOutlineNodes(novelDir);
    if (!outlineAfterRevise?.nodes?.length) {
      pass('OU6_revise_still_not_persisted', 'outline still empty after revision');
    } else {
      fail('OU6_revise_still_not_persisted', JSON.stringify(outlineAfterRevise));
    }

    const confirmTurn = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        async function sendChatMessage(text) {
          const input = document.querySelector('textarea[placeholder="向 AI 提问…"], input[placeholder="向 AI 提问…"]');
          if (!input) return { ok: false, step: 'find_input' };
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
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
            if (bodyText.includes('已将当前大纲写入项目，并切换到写作阶段。')) {
              return { ok: true, bodyText: bodyText.slice(0, 1200) };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ok: false, step: 'await_confirm_reply', bodyText: (document.body.innerText || '').slice(0, 1200) };
        }
        return sendChatMessage('确认写入大纲');
      })()
    `);
    if (confirmTurn?.ok) {
      pass('OU7_confirm_in_ui', 'confirm reply rendered in chat');
    } else {
      fail('OU7_confirm_in_ui', JSON.stringify(confirmTurn));
    }

    const outlineAfterConfirm = await novelData.readOutlineNodes(novelDir);
    const sceneTitles = Array.isArray(outlineAfterConfirm?.nodes)
      ? outlineAfterConfirm.nodes.map((node) => node.title).join(' | ')
      : '';
    if (Array.isArray(outlineAfterConfirm?.nodes) && outlineAfterConfirm.nodes.length > 0 && sceneTitles.includes('钟楼重逢')) {
      pass('OU8_confirm_persists_outline', `nodes=${outlineAfterConfirm.nodes.length}`);
    } else {
      fail('OU8_confirm_persists_outline', JSON.stringify(outlineAfterConfirm));
    }
  } catch (err) {
    fail('OU9_harness', err.message || String(err));
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

module.exports = { runChatOutlineUiRegressionTest };
