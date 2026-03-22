const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mana', {
  /**
   * OpenAI 兼容 Chat Completions（主进程 fetch，避免渲染进程 CORS）
   * @param {{ url: string, headers: Record<string, string>, body: string }} payload
   */
  chatCompletions: (payload) => ipcRenderer.invoke('mana-chat-completions', payload),
});
