'use strict';

const { ipcMain } = require('electron');
const subagentsStore = require('../store/subagents');
const dagsStore = require('../store/dags');
const secretsStore = require('../store/secrets');
const appConfig = require('../store/appConfig');
const skillsStore = require('../store/skills');

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  };
}

function registerConfigIpc() {
  // App config
  ipcMain.handle('mana:config:getApp', safeIpc(async () => appConfig.load()));
  ipcMain.handle('mana:config:setApp', safeIpc(async (_e, { patch }) => appConfig.save(patch || {})));

  // Subagents
  ipcMain.handle('mana:config:listSubagents', safeIpc(async () => subagentsStore.listSubagents()));
  ipcMain.handle('mana:config:getSubagent', safeIpc(async (_e, { id }) => subagentsStore.getSubagent(id)));
  ipcMain.handle('mana:config:saveSubagent', safeIpc(async (_e, { subagent }) => subagentsStore.saveSubagent(subagent)));
  ipcMain.handle('mana:config:deleteSubagent', safeIpc(async (_e, { id }) => subagentsStore.deleteSubagent(id)));
  ipcMain.handle('mana:config:cloneBuiltinSubagent', safeIpc(async (_e, { id, newId }) =>
    subagentsStore.cloneBuiltin(id, newId)
  ));

  // DAGs (pipelines)
  ipcMain.handle('mana:config:listDags', safeIpc(async () => dagsStore.listDags()));
  ipcMain.handle('mana:config:listDagsByStage', safeIpc(async (_e, { stage }) => dagsStore.listDagsByStage(stage)));
  ipcMain.handle('mana:config:getDag', safeIpc(async (_e, { id }) => dagsStore.getDag(id)));
  ipcMain.handle('mana:config:saveDag', safeIpc(async (_e, { dag }) => dagsStore.saveDag(dag)));
  ipcMain.handle('mana:config:deleteDag', safeIpc(async (_e, { id }) => dagsStore.deleteDag(id)));
  ipcMain.handle('mana:config:cloneDag', safeIpc(async (_e, { id, newId, newName }) =>
    dagsStore.cloneDag(id, newId, newName)
  ));

  // Skills
  ipcMain.handle('mana:config:listSkills', safeIpc(async () => skillsStore.listSkills()));
  ipcMain.handle('mana:config:getSkill', safeIpc(async (_e, { id }) => skillsStore.getSkill(id)));
  ipcMain.handle('mana:config:saveSkill', safeIpc(async (_e, { skill }) => skillsStore.saveSkill(skill)));
  ipcMain.handle('mana:config:deleteSkill', safeIpc(async (_e, { id }) => skillsStore.deleteSkill(id)));
  ipcMain.handle('mana:config:assignSkill', safeIpc(async (_e, { skillId, subagentId }) => skillsStore.assignSkillToSubagent(skillId, subagentId)));
  ipcMain.handle('mana:config:unassignSkill', safeIpc(async (_e, { skillId, subagentId }) => skillsStore.unassignSkillFromSubagent(skillId, subagentId)));
  ipcMain.handle('mana:config:exportSkill', safeIpc(async (_e, { id }) => skillsStore.exportSkill(id)));
  ipcMain.handle('mana:config:importSkill', safeIpc(async (_e, { bundle }) => skillsStore.importSkill(bundle)));

  // Secrets (api keys)
  ipcMain.handle('mana:config:setSecret', safeIpc(async (_e, { id, value }) => secretsStore.setSecret(id, value)));
  ipcMain.handle('mana:config:deleteSecret', safeIpc(async (_e, { id }) => secretsStore.deleteSecret(id)));
  ipcMain.handle('mana:config:listSecretIds', safeIpc(async () => secretsStore.listSecretIds()));
  ipcMain.handle('mana:config:secretsAvailable', safeIpc(async () => secretsStore.isAvailable()));
}

module.exports = { registerConfigIpc };
