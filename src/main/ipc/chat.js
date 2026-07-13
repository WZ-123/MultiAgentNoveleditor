'use strict';

const { ipcMain } = require('electron');
const { createProfileProvider } = require('../runtime/profileProvider');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) {
      console.error('[chat ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

async function chatComplete({ messages }) {
  const { provider, tier } = await createProfileProvider({ systemTask: 'chat', legacyTier: 'opus' }, { extra: { streaming: false } });
  let systemPrompt = '';
  const canonicalMessages = (messages || []).map((message) => ({
    role: message.role === 'system' ? 'user' : message.role,
    content: [{ type: 'text', text: message.text || message.content || '' }],
  }));
  if (messages?.[0]?.role === 'system') {
    systemPrompt = messages[0].text || messages[0].content || '';
    canonicalMessages.shift();
  }
  const result = await provider.sendMessage({
    system: systemPrompt,
    messages: canonicalMessages,
    tools: [],
    tier,
  });
  const content = (result.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('');
  return { text: content };
}

function registerChatIpc() {
  ipcMain.handle('mana:chat:complete', safeIpc(async (_e, { messages }) => chatComplete({ messages })));
}

module.exports = { registerChatIpc };
