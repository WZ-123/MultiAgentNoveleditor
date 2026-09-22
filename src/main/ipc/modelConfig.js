'use strict';

const { ipcMain, webContents } = require('electron');
const modelConfig = require('../modelConfig');
const clientEvents = require('../events/clientEvents');
const { discoverConnection } = require('../modelConfig/connectionDiscovery');
const { discoveryPreview, TEMPLATES } = require('../modelConfig/providerTemplates');
const { ModelSetupService } = require('../modelConfig/setupService');
const { getCodexSessionService } = require('../codex-runtime');
async function snapshot() { return { ...(await modelConfig.publicSnapshot()), templates: TEMPLATES.map(({ id, name, documentedBases, authCandidates, preferredModelHint }) => ({ id, name, baseUrl: documentedBases?.[0] || '', authCandidates, preferredModelHint: preferredModelHint || '' })) }; }

function notifyChanged(action) {
  clientEvents.emit('mana:modelConfig:changed', { action, changedAt: Date.now() });
  for (const contents of webContents.getAllWebContents()) {
    try { contents.send('mana:modelConfig:changed', { action, changedAt: Date.now() }); } catch { /* window closed */ }
  }
}

function safe(handler) {
  return async (_event, payload) => {
    try { return { ok: true, value: await handler(payload || {}) }; }
    catch (error) { return { ok: false, error: error?.message || String(error), code: error?.code || '', details: error?.details || null, references: error?.references || null }; }
  };
}

const setup = new ModelSetupService({ session: getCodexSessionService, notify: (operation) => {
  clientEvents.emit('mana:modelConfig:setupProgress', operation);
  for (const contents of webContents.getAllWebContents()) {
    try { contents.send('mana:modelConfig:setupProgress', operation); } catch { /* closed */ }
  }
  notifyChanged('setup_progress');
} });
function registerModelConfigIpc() {
  ipcMain.handle('mana:modelConfig:startSetup', safe((payload) => setup.start(payload)));
  ipcMain.handle('mana:modelConfig:querySetup', safe(({ id }) => setup.query(id)));
  ipcMain.handle('mana:modelConfig:retrySetup', safe(({ id, ...input }) => setup.retry(id, input)));
  ipcMain.handle('mana:modelConfig:cancelSetup', safe(({ id }) => setup.cancel(id)));
  ipcMain.handle('mana:modelConfig:snapshot', safe(snapshot));
  ipcMain.handle('mana:modelConfig:saveCredential', safe(async ({ credential, expectedRevision }) => {
    await modelConfig.saveCredential(credential, expectedRevision);
    notifyChanged('credential_saved');
    return snapshot();
  }));
  ipcMain.handle('mana:modelConfig:deleteCredential', safe(async ({ id, expectedRevision }) => {
    await modelConfig.deleteCredential(id, expectedRevision);
    notifyChanged('credential_deleted');
    return snapshot();
  }));
  ipcMain.handle('mana:modelConfig:previewConnection', safe((payload) => discoveryPreview(payload)));
  ipcMain.handle('mana:modelConfig:discoverConnection', safe(async (payload) => {
    const secret = await modelConfig.credentialSecret(payload.credentialId);
    return discoverConnection({ ...payload, apiKey: secret.value });
  }));
  ipcMain.handle('mana:modelConfig:saveConnection', safe(async ({ connection, expectedRevision }) => {
    if (connection.inputUrl && discoveryPreview({ ...connection, inputUrl: connection.inputUrl }).candidates[0].baseUrl !== connection.baseUrl) throw new Error('地址已修改，请重新检测后保存');
    await modelConfig.saveConnection(connection, expectedRevision);
    notifyChanged('connection_saved');
    return snapshot();
  }));
  ipcMain.handle('mana:modelConfig:deleteConnection', safe(async ({ id, expectedRevision }) => {
    await modelConfig.deleteConnection(id, expectedRevision);
    notifyChanged('connection_deleted');
    return snapshot();
  }));
  ipcMain.handle('mana:modelConfig:verifyModel', safe(({ connectionId, modelId, mode, reasoningEffort }) => getCodexSessionService().verifyModel({ connectionId, modelId, mode, reasoningEffort })));
  ipcMain.handle('mana:modelConfig:setActive', safe(async (payload) => {
    await getCodexSessionService().prepareModelSwitch({ interruptActive: payload.interruptActive === true });
    await modelConfig.setActive(payload, payload.expectedRevision);
    notifyChanged('active_selection_changed');
    return snapshot();
  }));
}

module.exports = { registerModelConfigIpc };
