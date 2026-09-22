'use strict';

const { ipcMain } = require('electron');
const chatHistory = require('../store/chatHistory');
const appConfig = require('../store/appConfig');
const { getCodexSessionService } = require('../codex-runtime');

function assertThreadMutable(threadId) {
  const service = getCodexSessionService();
  if (!service.threadRuns.has(String(threadId))) return;
  const error = new Error('当前对话仍在生成中，请先停止本轮再编辑或回退');
  error.code = 'CHAT_TURN_ACTIVE';
  throw error;
}

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      console.error('[chatHistory ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerChatHistoryIpc() {
  ipcMain.handle('mana:chatHistory:listThreads', safeIpc(async (_e, { novelId }) => chatHistory.listThreads(novelId)));

  ipcMain.handle('mana:chatHistory:createThread', safeIpc(async (_e, payload) => {
    const { title, novelId } = payload || {};
    const cfg = await appConfig.load();
    const maxBytes = cfg?.storageQuota?.chatHistoryMaxMB
      ? cfg.storageQuota.chatHistoryMaxMB * 1024 * 1024
      : 0;
    return chatHistory.createThread({ title, novelId, maxBytes });
  }));

  ipcMain.handle('mana:chatHistory:getThread', safeIpc(async (_e, { threadId }) => {
    const thread = await chatHistory.getThread(threadId);
    if (!thread) return null;
    // Include branch (messages from root to currentNode)
    return { ...thread, branch: chatHistory.getBranch(thread) };
  }));

  ipcMain.handle('mana:chatHistory:deleteThread', safeIpc(async (_e, { threadId }) => {
    assertThreadMutable(threadId);
    const thread = await chatHistory.getThread(threadId);
    if (thread?.codexBinding?.threadId) await getCodexSessionService().archiveThread(thread.codexBinding.threadId);
    await chatHistory.deleteThread(threadId);
    return { ok: true };
  }));

  ipcMain.handle('mana:chatHistory:renameThread', safeIpc(async (_e, { threadId, title }) => {
    return chatHistory.renameThread(threadId, title);
  }));

  ipcMain.handle('mana:chatHistory:appendMessage', safeIpc(async (_e, { threadId, message }) => {
    return chatHistory.appendMessage(threadId, message);
  }));

  ipcMain.handle('mana:chatHistory:editMessage', safeIpc(async (_e, { threadId, messageId, text }) => {
    assertThreadMutable(threadId);
    const thread = await chatHistory.editMessage(threadId, messageId, text);
    await getCodexSessionService().reconcileBranchMutation(threadId, messageId);
    return thread;
  }));

  ipcMain.handle('mana:chatHistory:revertToNode', safeIpc(async (_e, { threadId, messageId }) => {
    assertThreadMutable(threadId);
    const thread = await chatHistory.revertToNode(threadId, messageId);
    await getCodexSessionService().reconcileBranchMutation(threadId, messageId);
    if (!thread) return null;
    return { ...thread, branch: chatHistory.getBranch(thread) };
  }));

  ipcMain.handle('mana:chatHistory:getStorageStats', safeIpc(async () => chatHistory.getStorageStats()));

  ipcMain.handle('mana:chatHistory:enforceQuota', safeIpc(async (_e, { maxBytes }) => {
    return chatHistory.enforceQuota(maxBytes);
  }));
}

module.exports = { registerChatHistoryIpc };
