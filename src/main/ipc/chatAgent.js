'use strict';

const { ipcMain } = require('electron');
const chatAgent = require('../runtime/chatAgent');

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      console.error('[chatAgent ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerChatAgentIpc() {
  ipcMain.handle('mana:chatAgent:createSession', safeIpc(async (_e, { editorContext, messages, threadId }) => {
    const sessionId = chatAgent.createSession({ editorContext, messages, threadId });
    return { sessionId };
  }));

  ipcMain.handle('mana:chatAgent:sendMessage', safeIpc(async (_e, { sessionId, text }) => {
    // Diagnostic: log what IPC receives from renderer
    if (typeof text !== 'string' || text === '[object Object]') {
      console.error('[chatAgent:ipc] DIAG raw payload:', { sessionId, textType: typeof text, textLen: text?.length, textVal: typeof text === 'string' ? text.slice(0, 100) : String(text).slice(0, 100) });
    }
    // Run turn asynchronously so IPC returns immediately; events stream via chatAgent:event
    chatAgent.runTurn(sessionId, text).catch((err) => {
      console.error('[chatAgent] runTurn failed', err);
    });
    return { ok: true };
  }));

  ipcMain.handle('mana:chatAgent:cancel', safeIpc(async (_e, { sessionId }) => {
    chatAgent.cancelTurn(sessionId);
    return { ok: true };
  }));

  ipcMain.handle('mana:chatAgent:resolveAction', safeIpc(async (_e, { sessionId, actionId, result }) => {
    const resolved = chatAgent.resolveFrontendAction(sessionId, actionId, result);
    return { resolved };
  }));

  ipcMain.handle('mana:chatAgent:closeSession', safeIpc(async (_e, { sessionId }) => {
    chatAgent.closeSession(sessionId);
    return { ok: true };
  }));

  ipcMain.handle('mana:chatAgent:updateContext', safeIpc(async (_e, { sessionId, editorContext }) => {
    const session = chatAgent.getSession(sessionId);
    if (session) {
      session.editorContext = editorContext || null;
    }
    return { ok: true };
  }));

  ipcMain.handle('mana:chatAgent:getSessionInfo', safeIpc(async (_e, { sessionId }) => {
    const session = chatAgent.getSession(sessionId);
    if (!session) return { sessionId: null, workflowPhase: null };
    return {
      sessionId: session.sessionId,
      workflowPhase: session.workflowPhase || 'idle',
    };
  }));
}

module.exports = { registerChatAgentIpc };
