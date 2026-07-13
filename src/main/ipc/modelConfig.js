'use strict';

const { ipcMain } = require('electron');
const modelConfig = require('../modelConfig');
const providerManager = require('../providerManager');

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      console.error('[modelConfig ipc]', err);
      return {
        ok: false,
        error: err.message || String(err),
        code: err.code || '',
        details: err.references ? { references: err.references } : undefined,
      };
    }
  };
}

async function snapshotAfter(promise) {
  await promise;
  return modelConfig.publicSnapshot();
}

async function testProfile(profileId) {
  const [resolved] = await modelConfig.resolveTargets({ driverId: 'direct-api', modelProfileId: profileId });
  if (!resolved) throw new Error('模型档案没有 Direct API 目标');
  const tier = modelConfig.tierFromResolved(resolved);
  tier.extra.maxTokens = Math.min(16, tier.extra.maxTokens || 16);
  tier.extra.streaming = false;
  const adapter = tier.type === 'anthropic'
    ? require('../runtime/providers/anthropic')
    : require('../runtime/providers/openaiCompat');
  const result = await adapter.sendMessage({
    system: 'Return exactly: OK',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Connection test. Reply OK.' }] }],
    tier,
  });
  return {
    ok: true,
    profileId,
    providerId: resolved.provider?.id || null,
    modelId: result.model || tier.model,
    requestId: result.requestId || '',
    usage: result.usage || {},
  };
}

function registerModelConfigIpc() {
  ipcMain.handle('mana:modelConfig:snapshot', safeIpc(async () => modelConfig.publicSnapshot()));
  ipcMain.handle('mana:modelConfig:saveProvider', safeIpc(async (_e, { provider, expectedRevision }) =>
    snapshotAfter(modelConfig.saveProvider(provider, expectedRevision))));
  ipcMain.handle('mana:modelConfig:deleteProvider', safeIpc(async (_e, { id, replacementProviderId, expectedRevision }) =>
    snapshotAfter(modelConfig.deleteProvider(id, replacementProviderId, expectedRevision))));
  ipcMain.handle('mana:modelConfig:discoverModels', safeIpc(async (_e, { providerId }) => providerManager.discoverModels(providerId, { save: false })));
  ipcMain.handle('mana:modelConfig:applyDiscoveredModels', safeIpc(async (_e, { providerId, models, expectedRevision }) => {
    const provider = await modelConfig.getProviderInternal(providerId);
    if (!provider) throw new Error('Provider 不存在');
    return snapshotAfter(modelConfig.saveProvider({ ...provider, models }, expectedRevision));
  }));
  ipcMain.handle('mana:modelConfig:testProvider', safeIpc(async (_e, { providerId }) => providerManager.testConnection(providerId)));
  ipcMain.handle('mana:modelConfig:testProfile', safeIpc(async (_e, { profileId }) => testProfile(profileId)));
  ipcMain.handle('mana:modelConfig:saveProfile', safeIpc(async (_e, { profile, expectedRevision }) =>
    snapshotAfter(modelConfig.saveProfile(profile, expectedRevision))));
  ipcMain.handle('mana:modelConfig:deleteProfile', safeIpc(async (_e, { id, replacementProfileId, expectedRevision }) =>
    snapshotAfter(modelConfig.deleteProfile(id, replacementProfileId, expectedRevision))));
  ipcMain.handle('mana:modelConfig:saveRouting', safeIpc(async (_e, { routing, expectedRevision }) =>
    snapshotAfter(modelConfig.saveRouting(routing, expectedRevision))));
  ipcMain.handle('mana:modelConfig:resolvePreview', safeIpc(async (_e, context) => modelConfig.resolvePreview(context || {})));
  ipcMain.handle('mana:modelConfig:importLegacyRendererConfig', safeIpc(async (_e, { config }) => modelConfig.importLegacyRendererConfig(config)));
}

module.exports = { registerModelConfigIpc };
