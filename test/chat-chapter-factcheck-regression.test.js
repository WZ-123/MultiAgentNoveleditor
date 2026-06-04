'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runChatChapterFactcheckRegressionTest() {
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

  process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-chat-chapter-factcheck-userdata');
  process.env.MANA_USE_STDIO_MCP = '0';

  const emittedEvents = [];
  const electronModulePath = require.resolve('electron');
  const originalElectronCache = require.cache[electronModulePath];
  require.cache[electronModulePath] = {
    id: electronModulePath,
    filename: electronModulePath,
    loaded: true,
    exports: {
      app: null,
      webContents: {
        getAllWebContents: () => [{
          send(channel, payload) {
            emittedEvents.push({ channel, payload });
          },
        }],
      },
    },
  };

  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));
  const originalCallTool = mcpClient.callTool;
  const originalGetActiveNovel = mcpClient.getActiveNovel;
  const originalSendMessage = anthropicProvider.sendMessage;

  const calls = [];

  try {
    mcpClient.getActiveNovel = () => 'novel-factcheck-regression';
    mcpClient.callTool = async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === 'list_chapters') {
        return { content: [{ type: 'text', text: JSON.stringify(['chapter-003.md', 'chapter-004.md']) }] };
      }
      if (name === 'list_chapter_displays') {
        return {
          content: [{ type: 'text', text: JSON.stringify([
            { name: 'chapter-003.md', displayName: '第三章：小别胜新婚', seq: 3 },
            { name: 'chapter-004.md', displayName: '第四章：直播论牛', seq: 4 },
          ]) }],
        };
      }
      if (name === 'read_chapter' && args?.name === 'chapter-003.md') {
        return { content: [{ type: 'text', text: '# 第三章：小别胜新婚\n\n完整的夜归、重逢、亲密戏。' }] };
      }
      if (name === 'read_chapter' && args?.name === 'chapter-004.md') {
        return { content: [{ type: 'text', text: '# 第四章：直播论牛\n\n直播间牛肉论道那段，以弹幕刷屏和查漏电收尾。' }] };
      }
      return { isError: true, content: [{ type: 'text', text: `unexpected tool ${name}` }] };
    };
    anthropicProvider.sendMessage = async () => {
      throw new Error('provider should not be called for chapter factcheck');
    };

    const chatAgentPath = path.join(ROOT, 'src/main/runtime/chatAgent');
    delete require.cache[require.resolve(chatAgentPath)];
    const chatAgent = require(chatAgentPath);
    const sessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-factcheck-regression', chapterCount: 4, novelTitle: '事实核对回归小说' },
      messages: [],
    });

    await chatAgent.runTurn(sessionId, '你傻逼吧，第三章小别胜新婚和第四章的直播论牛怎么就在一起了？');
    const session = chatAgent.getSession(sessionId);
    const last = session.messages[session.messages.length - 1]?.content?.[0]?.text || '';

    assert.ok(calls.some((call) => call.name === 'list_chapter_displays'));
    assert.ok(calls.some((call) => call.name === 'read_chapter' && call.args?.name === 'chapter-003.md'));
    assert.ok(calls.some((call) => call.name === 'read_chapter' && call.args?.name === 'chapter-004.md'));
    assert.ok(last.includes('核对结果如下'));
    assert.ok(last.includes('第三章：小别胜新婚'));
    assert.ok(last.includes('第四章：直播论牛'));
    chatAgent.closeSession(sessionId);
    pass('CCF1_chapter_challenge_forces_factcheck_tools', 'chapter continuity challenge reads display mapping and exact chapter files before answering');

    calls.length = 0;
    const normalSessionId = chatAgent.createSession({
      editorContext: { novelId: 'novel-factcheck-regression', chapterCount: 4, novelTitle: '事实核对回归小说' },
      messages: [],
    });
    await chatAgent.runTurn(normalSessionId, '第四章直播论牛写了什么，和第三章怎么衔接？');
    const normalSession = chatAgent.getSession(normalSessionId);
    const normalLast = normalSession.messages[normalSession.messages.length - 1]?.content?.[0]?.text || '';
    assert.ok(calls.some((call) => call.name === 'list_chapter_displays'));
    assert.ok(calls.some((call) => call.name === 'read_chapter' && call.args?.name === 'chapter-003.md'));
    assert.ok(calls.some((call) => call.name === 'read_chapter' && call.args?.name === 'chapter-004.md'));
    assert.ok(normalLast.includes('核对结果如下'));
    assert.ok(normalLast.includes('第四章：直播论牛'));
    chatAgent.closeSession(normalSessionId);
    pass('CCF2_chapter_fact_question_prefetches_sources', 'ordinary chapter fact questions also read exact chapter files before answering');
  } catch (err) {
    fail('CCF_harness', err?.stack || String(err));
  } finally {
    mcpClient.callTool = originalCallTool;
    mcpClient.getActiveNovel = originalGetActiveNovel;
    anthropicProvider.sendMessage = originalSendMessage;
    if (originalElectronCache) {
      require.cache[electronModulePath] = originalElectronCache;
    } else {
      delete require.cache[electronModulePath];
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runChatChapterFactcheckRegressionTest };

if (require.main === module) {
  runChatChapterFactcheckRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
