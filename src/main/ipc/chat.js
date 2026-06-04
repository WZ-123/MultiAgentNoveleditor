'use strict';

const { ipcMain } = require('electron');
const providerManager = require('../providerManager');
const modelAliases = require('../modelAliases');

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
  const provider = await providerManager.getActiveProvider();
  if (!provider) throw new Error('No active provider configured');

  const alias = await modelAliases.getAlias('opus');
  const modelId = alias?.modelId || provider.models?.[0]?.id || '';
  if (!modelId) throw new Error('No model configured for chat');

  const apiKey = provider.apiKey || '';
  if (!apiKey) throw new Error('Provider API key is missing');

  const baseUrl = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const url = `${baseUrl}/v1/messages`;

  const anthropicMessages = messages.map((m) => ({
    role: m.role === 'system' ? 'user' : m.role,
    content: m.text,
  }));

  let systemPrompt = '';
  if (messages[0]?.role === 'system') {
    systemPrompt = messages[0].text;
    anthropicMessages.shift();
  }

  const body = {
    model: modelId,
    max_tokens: alias?.maxOutputTokens || 4096,
    messages: anthropicMessages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(alias?.temperature !== undefined ? { temperature: alias.temperature } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Chat API ${res.status}: ${text}`);
  const data = JSON.parse(text);
  const content = data?.content?.[0]?.text || '';
  return { text: content };
}

function registerChatIpc() {
  ipcMain.handle('mana:chat:complete', safeIpc(async (_e, { messages }) => chatComplete({ messages })));
}

module.exports = { registerChatIpc };
