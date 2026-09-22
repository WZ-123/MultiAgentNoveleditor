'use strict';

const { getCodexSessionService } = require('./index');

function messageText(messages) {
  return (messages || []).map((message) => {
    const content = Array.isArray(message.content) ? message.content.map((part) => part?.text || '').join('\n') : String(message.content || '');
    return `${message.role || 'user'}:\n${content}`;
  }).join('\n\n');
}

async function createNativeCodexProvider(_routing = {}, defaults = {}) {
  return {
    provider: {
      async sendMessage(request = {}) {
        const result = await getCodexSessionService().runOneShot({
          text: [request.system ? `system:\n${request.system}` : '', messageText(request.messages)].filter(Boolean).join('\n\n'),
          skillName: defaults.skillName,
          outputSchema: request.outputSchema,
          novelId: defaults.novelId,
          abortSignal: request.abortSignal,
        });
        return { content: [{ type: 'text', text: result.text }], stopReason: 'end_turn', model: 'codex-native', usage: {} };
      },
    },
    tier: { type: 'codex-native', model: 'active', extra: {} },
  };
}

module.exports = { createNativeCodexProvider, messageText };
