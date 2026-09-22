'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('authBridge', Object.freeze({
  verify: (authCode) => ipcRenderer.invoke('mana:auth:verify', { authCode: String(authCode || '') }),
  quit: () => ipcRenderer.send('mana:auth:quit'),
}));
