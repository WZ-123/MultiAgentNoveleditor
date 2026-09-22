'use strict';

const { ipcMain } = require('electron');
const secretsStore = require('../store/secrets');
const appConfig = require('../store/appConfig');
const skillsStore = require('../store/skills');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
}

function assertGeneralAppPatchAllowed(patch) {
  if (
    patch
    && typeof patch === 'object'
    && Object.prototype.hasOwnProperty.call(patch, 'testing')
  ) {
    const error = new Error('本机测试模式只能通过专用测试开关修改');
    error.code = 'LOCAL_TEST_SETTING_REQUIRES_DEDICATED_IPC';
    throw error;
  }
}

function registerConfigIpc() {
  // App config
  ipcMain.handle('mana:config:getApp', safeIpc(async () => appConfig.loadPublic()));
  ipcMain.handle('mana:config:setApp', safeIpc(async (_e, { patch } = {}) => {
    assertGeneralAppPatchAllowed(patch);
    return appConfig.save(patch || {});
  }));

  // Skills
  ipcMain.handle('mana:config:listSkills', safeIpc(async () => skillsStore.listSkills()));
  ipcMain.handle('mana:config:getSkill', safeIpc(async (_e, { id }) => skillsStore.getSkill(id)));
  ipcMain.handle('mana:config:saveSkill', safeIpc(async (_e, { skill }) => skillsStore.saveSkill(skill)));
  ipcMain.handle('mana:config:deleteSkill', safeIpc(async (_e, { id }) => skillsStore.deleteSkill(id)));
  ipcMain.handle('mana:config:setSkillEnabled', safeIpc(async (_e, { id, enabled }) => skillsStore.setSkillEnabled(id, enabled)));
  ipcMain.handle('mana:config:exportSkill', safeIpc(async (_e, { id }) => skillsStore.exportSkill(id)));
  ipcMain.handle('mana:config:importSkill', safeIpc(async (_e, { bundle }) => skillsStore.importSkill(bundle)));

  // Secrets (api keys)
  ipcMain.handle('mana:config:setSecret', safeIpc(async (_e, { id, value }) => secretsStore.setSecret(id, value)));
  ipcMain.handle('mana:config:deleteSecret', safeIpc(async (_e, { id }) => secretsStore.deleteSecret(id)));
  ipcMain.handle('mana:config:listSecretIds', safeIpc(async () => secretsStore.listSecretIds()));
  ipcMain.handle('mana:config:secretsAvailable', safeIpc(async () => secretsStore.isAvailable()));
}

module.exports = { registerConfigIpc, _debug: { assertGeneralAppPatchAllowed } };
