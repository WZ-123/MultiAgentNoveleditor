'use strict';

/**
 * REAL UI full-chain E2E test.
 * Seeds a real provider + novel, types through the UI, then verifies the UI
 * shows the user message, tool invocation/result, and final assistant reply.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function seedProviderConfig(ROOT) {
  const { paths } = require(path.join(ROOT, 'src/main/store/paths'));
  const targetRoot = paths().root;
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
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-real-ui-chain');
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '真实UI全链路测试小说', dir });
  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);

  const np = novelPaths(dir);
  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'shen-yan.json'), JSON.stringify({
    id: 'shen-yan',
    name: '沈砚',
    role: '北雾港巡夜人',
    gender: '男',
    personality: '克制、敏锐、记仇但守诺',
    appearance: '黑发，眼下有浅淡旧伤',
    _enrichmentStatus: 'skipped',
  }, null, 2), 'utf8');

  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), '# 星夜启程\n\n北雾港的风吹过空码头。', 'utf8');
  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 世界观\n\n北雾港常年被海雾笼罩。', 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ name: '北雾港', description: '海港城' }, null, 2), 'utf8');

  return { entry, cleanupRoot: tmpRoot };
}

async function runChatRealE2E(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  let cleanupRoot = '';

  await delay(1500);

  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  try {
    const cfg = await seedProviderConfig(ROOT);
    pass('REAL_ui_provider_seed', `copied from ${cfg.sourceRoot}`);
  } catch (err) {
    fail('REAL_ui_provider_seed', err.message || String(err));
    console.log('');
    console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
    console.log('TEST_DONE');
    return results;
  }

  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    pass('REAL_ui_novel_seed', `novel=${seeded.entry.id}`);
  } catch (err) {
    fail('REAL_ui_novel_seed', err.message || String(err));
    console.log('');
    console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
    console.log('TEST_DONE');
    return results;
  }

  try {
    const uiReady = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 12000) {
          const text = document.body.innerText || '';
          const input = document.querySelector('input[placeholder="向 AI 提问…"]');
          if (text.includes('第1章：星夜启程') && !!input) {
            return { ok: true };
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return { ok: false, body: (document.body.innerText || '').slice(0, 500) };
      })()
    `);
    if (uiReady?.ok) {
      pass('REAL_ui_ready', 'chapter tree and chat input visible');
    } else {
      fail('REAL_ui_ready', JSON.stringify(uiReady));
    }
  } catch (err) {
    fail('REAL_ui_ready', err.message || String(err));
  }

  // =============================================================
  // REAL TEST: type in chat input, click send, verify DOM result
  // =============================================================
  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const testPhrase = '请先调用 read_character 读取 id 为 shen-yan 的角色卡，再用中文告诉我他的身份和性格，并明确包含“记仇但守诺”这五个字。';

        const inputCandidates = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'));
        const chatInput = inputCandidates.find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 120 && rect.height > 20 && ((el.placeholder || '').includes('向 AI 提问') || el.tagName === 'INPUT');
        });
        if (!chatInput) {
          const debug = inputCandidates.map(el => ({
            tag: el.tagName,
            type: el.type || '',
            w: el.offsetWidth,
            h: el.offsetHeight,
            ph: el.placeholder || '',
            parent: el.parentElement?.className?.slice(0, 60) || '',
          }));
          return { step: 'find_input', error: 'input not found', debug };
        }

        const proto = chatInput.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
        if (setter) {
          setter.call(chatInput, testPhrase);
        } else {
          chatInput.value = testPhrase;
        }
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        chatInput.dispatchEvent(new Event('change', { bubbles: true }));

        await new Promise(r => setTimeout(r, 200));

        const typedValue = chatInput.value;

        const btns = Array.from(document.querySelectorAll('button'));
        const sendBtn = btns.find((b) => {
          if (b.disabled) return false;
          const svg = b.querySelector('svg');
          return !!svg && (svg.getAttribute('data-lucide') === 'send' || svg.classList.contains('lucide-send'));
        });
        if (!sendBtn) return { step: 'find_send', error: 'send button not found', typedValue };

        sendBtn.click();

        let snapshot = {
          bodyText: '',
          hasUserMsgInUi: false,
          hasToolCard: false,
          hasToolResultSnippet: false,
          hasAssistantReply: false,
          assistantSnippet: '',
        };

        const startedAt = Date.now();
        while (Date.now() - startedAt < 20000) {
          const bodyText = document.body.innerText || '';

          snapshot = {
            bodyText,
            hasUserMsgInUi: bodyText.includes(testPhrase),
            hasToolCard: bodyText.includes('调用: read_character'),
            hasToolResultSnippet: bodyText.includes('记仇但守诺') || bodyText.includes('北雾港巡夜人'),
            hasAssistantReply: bodyText.includes('沈砚') && (bodyText.includes('记仇但守诺') || bodyText.includes('北雾港巡夜人')),
            assistantSnippet: bodyText.includes('沈砚') ? bodyText.slice(Math.max(0, bodyText.indexOf('沈砚') - 40), bodyText.indexOf('沈砚') + 120) : '',
          };

          if (snapshot.hasUserMsgInUi && snapshot.hasToolCard && snapshot.hasToolResultSnippet && snapshot.hasAssistantReply) {
            break;
          }
          await new Promise(r => setTimeout(r, 250));
        }

        return {
          typedValue,
          typedValueType: typeof typedValue,
          sendEnabled: !sendBtn.disabled,
          ...snapshot,
          ok: snapshot.hasUserMsgInUi && snapshot.hasToolCard && snapshot.hasToolResultSnippet && snapshot.hasAssistantReply,
        };
      })()
    `);

    if (r?.ok) {
      pass('REAL_ui_full_chain', `typed="${r.typedValue}" toolCard=${r.hasToolCard} assistant="${r.assistantSnippet}"`);
    } else {
      fail('REAL_ui_full_chain', JSON.stringify({
        typedValue: r?.typedValue,
        hasUserMsgInUi: r?.hasUserMsgInUi,
        hasToolCard: r?.hasToolCard,
        hasToolResultSnippet: r?.hasToolResultSnippet,
        hasAssistantReply: r?.hasAssistantReply,
        assistantSnippet: r?.assistantSnippet,
        bodyText: r?.bodyText?.slice(0, 1000),
      }));
    }
  } catch (err) {
    fail('REAL_ui_full_chain', err.message || String(err));
  }

  try {
    const persisted = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const startedAt = Date.now();
        let snapshot = { ok: false, toolCalls: 0 };
        while (Date.now() - startedAt < 8000) {
          const threads = await window.mana.chatHistory.listThreads();
          const latest = threads?.[0] || null;
          const thread = latest ? await window.mana.chatHistory.getThread(latest.id) : null;
          const branch = thread?.branch || [];
          const assistant = [...branch].reverse().find((m) => m.role === 'assistant') || null;
          snapshot = {
            ok: Array.isArray(assistant?.toolCalls) && assistant.toolCalls.length > 0,
            toolCalls: assistant?.toolCalls?.length || 0,
          };
          if (snapshot.ok) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        return snapshot;
      })()
    `);
    if (persisted?.ok) {
      pass('REAL_ui_toolcalls_persisted', `toolCalls=${persisted.toolCalls}`);
    } else {
      fail('REAL_ui_toolcalls_persisted', JSON.stringify(persisted));
    }
  } catch (err) {
    fail('REAL_ui_toolcalls_persisted', err.message || String(err));
  }

  // =============================================================
  // Cleanup
  // =============================================================
  try {
    if (cleanupRoot) {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup failure
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatRealE2E };
