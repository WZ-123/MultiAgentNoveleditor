'use strict';

const { ipcMain } = require('electron');
const fs = require('node:fs').promises;
const path = require('node:path');
const novelsStore = require('../store/novels');
const novelData = require('../store/novelData');
const appConfig = require('../store/appConfig');
const offlineLog = require('../store/offlineLog');
const networkStatus = require('../store/networkStatus');
const characterUpdates = require('../import/characterUpdates');
const characterEnricher = require('../import/characterEnricher');
const { assertFanworkCharacters } = require('../import/characterEnrichmentEligibility');
const { extractCharacters } = require('../import/analyzer');
const eventBus = require('../events/appEventBus');
const clientEvents = require('../events/clientEvents');

const enrichmentRuns = new Map();

function notifyChapterChanged(name, action, title) {
  if (!name) return;
  const payload = { name, action, title: title || null };
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send('mana:chapter:changed', payload); } catch {}
    }
  } catch {
    // ignore renderer sync failures
  }
  clientEvents.emit('mana:chapter:changed', payload);
}

async function buildChapterSaveSnapshot(id, novelRoot, fileName, metadata) {
  const chapters = await novelData.listChapters(novelRoot);
  const sorted = chapters.map((chapter) => chapter.name).sort((a, b) => a.localeCompare(b));
  const seq = Math.max(1, sorted.indexOf(fileName) + 1);
  const rule = await novelsStore.getChapterNamingRule(id);
  const title = metadata?.title || '';
  return {
    title,
    volume: metadata?.volume ?? null,
    section: metadata?.section ?? null,
    seq,
    displayName: novelData.computeChapterDisplayName(rule.rule, seq, rule.separator, title),
  };
}

function notifyActiveNovelChanged(entry, action) {
  const payload = {
    action: action || 'updated',
    entry: entry || null,
  };
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try {
        wc.send('mana:novel:activeChanged', payload);
      } catch {}
    }
  } catch {
    // ignore renderer sync failures
  }
  clientEvents.emit('mana:novel:activeChanged', payload);
}

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err), errorCode: err.code || null }; }
  };
}

async function maybeLogOffline({ type, action, targetId, targetName, payload, novelId }) {
  if (!networkStatus.isOffline()) return;
  try {
    await offlineLog.appendEntry({
      type,
      action,
      targetId: targetId || '',
      targetName: targetName || '',
      payload: payload || {},
      networkStatus: networkStatus.get(),
      persistence: 'local_committed',
      novelId: novelId || null,
    });
  } catch (err) {
    console.error('[novelIpc] offlineLog append failed', err);
  }
}

function registerNovelIpc() {
  ipcMain.handle('mana:novel:listReview', safeIpc(async (_e, { id, reviewId, decisions, approved }) => {
    const root = (await novelsStore.pathsFor(id)).root;
    return require('../import/reviewStore').list(root);
  }));
  ipcMain.handle('mana:novel:getReview', safeIpc(async (_e, { id, reviewId, decisions, approved }) => {
    const root = (await novelsStore.pathsFor(id)).root;
    return require('../import/reviewStore').get(root, reviewId);
  }));
  ipcMain.handle('mana:novel:decideReview', safeIpc(async (_e, { id, reviewId, decisions, approved }) => {
    const root = (await novelsStore.pathsFor(id)).root;
    return require('../import/reviewStore').decide(root, reviewId, decisions);
  }));
  ipcMain.handle('mana:novel:finishReview', safeIpc(async (_e, { id, reviewId, decisions, approved }) => {
    const root = (await novelsStore.pathsFor(id)).root;
    return require('../import/reviewStore').finish(root, reviewId, approved);
  }));
  // ---- Network status reporting from renderer ----
  ipcMain.handle('mana:networkStatus:set', safeIpc(async (_e, { status }) => {
    networkStatus.set(status);
    return { ok: true };
  }));
  // ---- Project lifecycle ----
  ipcMain.handle('mana:novel:list', safeIpc(async () => novelsStore.listNovels()));

  ipcMain.handle('mana:novel:create', safeIpc(async (_e, { title, dir }) =>
    novelsStore.createNovel({ title, dir })
  ));

  ipcMain.handle('mana:novel:open', safeIpc(async (_e, { id }) => {
    const r = await novelsStore.openNovel(id);
    const cfg = await appConfig.load();
    await appConfig.save({ ...cfg, lastNovelId: id, lastNovelDir: r.entry.dir });
    notifyActiveNovelChanged(r.entry || null, 'opened');
    return { entry: r.entry, meta: r.meta };
  }));

  ipcMain.handle('mana:novel:close', safeIpc(async () => {
    const cfg = await appConfig.load();
    await appConfig.save({ ...cfg, lastNovelId: null, lastNovelDir: null });
    notifyActiveNovelChanged(null, 'closed');
    return true;
  }));

  ipcMain.handle('mana:novel:active', safeIpc(async () => {
    const id = (await appConfig.load())?.lastNovelId;
    if (!id) return null;
    return novelsStore.getNovelById(id);
  }));

  ipcMain.handle('mana:novel:saveMeta', safeIpc(async (_e, { id, patch }) =>
    novelsStore.saveNovelMeta(id, patch || {})
  ));

  ipcMain.handle('mana:novel:importExisting', safeIpc(async (_e, { dir }) =>
    novelsStore.importExistingNovel(dir)
  ));

  ipcMain.handle('mana:novel:remove', safeIpc(async (_e, { id }) =>
    novelsStore.removeFromRegistry(id)
  ));

  // ---- Read APIs ----
  ipcMain.handle('mana:novel:listChapters', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.listChapters(np.root);
  }));

  ipcMain.handle('mana:novel:listChapterMetas', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    const chapters = await novelData.listChapterMetas(np.root);
    const rule = await novelsStore.getChapterNamingRule(id);
    return chapters.map((chapter, index) => ({
      ...chapter,
      seq: index + 1,
      displayName: novelData.computeChapterDisplayName(
        rule.rule,
        index + 1,
        rule.separator,
        chapter.title || ''
      ),
    }));
  }));

  ipcMain.handle('mana:novel:readChapter', safeIpc(async (_e, { id, name }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readChapter(np.root, name);
  }));

  ipcMain.handle('mana:novel:saveChapter', safeIpc(async (_e, { id, name, content, metadata, options }) => {
    const np = await novelsStore.pathsFor(id);
    let finalMeta = metadata || {};
    // Preserve existing frontmatter fields (volume, section) from the file
    const existing = await novelData.readChapterMeta(np.root, name);
    if (existing?.metadata) {
      if (finalMeta.volume == null && existing.metadata.volume != null) finalMeta.volume = existing.metadata.volume;
      if (finalMeta.section == null && existing.metadata.section != null) finalMeta.section = existing.metadata.section;
    }
    const resolvedTitle = novelData.resolveChapterTitle({
      metadataTitle: finalMeta.title,
      content,
      fallbackTitle: existing?.metadata?.title || existing?.headingTitle || '',
    });
    if (resolvedTitle) {
      finalMeta.title = resolvedTitle;
    } else if ('title' in finalMeta) {
      delete finalMeta.title;
    }
    const writeOptions = {};
    if (options && Object.prototype.hasOwnProperty.call(options, 'baseContent')) {
      writeOptions.baseContent = typeof options.baseContent === 'string' ? options.baseContent : '';
    }
    if (options && typeof options.verifiedContentHash === 'string' && options.verifiedContentHash) {
      writeOptions.verifiedContentHash = options.verifiedContentHash;
    }
    const result = await novelData.writeChapterWithMeta(np.root, name, content, finalMeta, writeOptions);
    const revision = options && options.createRevision !== false
      ? await novelData.createChapterRevision(np.root, result.name || name, content, finalMeta, {
        source: options?.source || 'manual',
        revisionLabel: options?.revisionLabel,
        createRevision: options?.createRevision,
      })
      : null;
    const snapshot = await buildChapterSaveSnapshot(id, np.root, result.name || name, finalMeta);
    notifyChapterChanged(result.name || name, 'updated', finalMeta.title || existing?.metadata?.title || null);
    await maybeLogOffline({ type: 'chapter', action: 'update', targetId: name, targetName: name, payload: { name, content, metadata: finalMeta }, novelId: id });
    return {
      ...result,
      ...snapshot,
      metadata: finalMeta,
      revision,
    };
  }));

  ipcMain.handle('mana:novel:listChapterRevisions', safeIpc(async (_e, { id, name }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.listChapterRevisions(np.root, name);
  }));

  ipcMain.handle('mana:novel:readChapterRevision', safeIpc(async (_e, { id, name, revisionId }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readChapterRevision(np.root, name, revisionId);
  }));

  ipcMain.handle('mana:novel:restoreChapterRevision', safeIpc(async (_e, { id, name, revisionId }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.restoreChapterRevision(np.root, name, revisionId);
    const snapshot = await buildChapterSaveSnapshot(id, np.root, result.name || name, result.metadata || {});
    notifyChapterChanged(result.name || name, 'updated', result.metadata?.title || null);
    await maybeLogOffline({ type: 'chapter', action: 'restore', targetId: name, targetName: name, payload: { name, revisionId }, novelId: id });
    return { ...result, ...snapshot };
  }));

  ipcMain.handle('mana:novel:deleteChapter', safeIpc(async (_e, { id, name, options }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.deleteChapter(np.root, name, options || {});
    if (result.treeChanged) {
      notifyChapterChanged(result.name || name, 'deleted', null);
      await maybeLogOffline({ type: 'chapter', action: 'delete', targetId: name, targetName: name, payload: { name, commandId: result.commandId }, novelId: id });
    }
    return result;
  }));

  // ── 章节命名规则 ──
  ipcMain.handle('mana:novel:getChapterNaming', safeIpc(async (_e, { id }) => {
    return novelsStore.getChapterNamingRule(id);
  }));

  ipcMain.handle('mana:novel:setChapterNaming', safeIpc(async (_e, { id, rule, separator }) => {
    return novelsStore.setChapterNamingRule(id, rule, separator);
  }));

  ipcMain.handle('mana:novel:nextChapterName', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    const chapters = await novelData.listChapters(np.root);
    const seq = chapters.length + 1;
    const rule = await novelsStore.getChapterNamingRule(id);
    const displayName = novelData.computeChapterDisplayName(rule.rule, seq, rule.separator);
    const fileName = `chapter-${String(seq).padStart(3, '0')}.md`;
    return { seq, fileName, displayName };
  }));

  ipcMain.handle('mana:novel:computeChapterDisplayName', safeIpc(async (_e, { id, seq, title }) => {
    const rule = await novelsStore.getChapterNamingRule(id);
    return novelData.computeChapterDisplayName(rule.rule, seq, rule.separator, title || '');
  }));

  ipcMain.handle('mana:novel:readChapterMeta', safeIpc(async (_e, { id, name }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readChapterMeta(np.root, name);
  }));

  ipcMain.handle('mana:novel:computeNextInsertName', safeIpc(async (_e, { id, afterFileName }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.computeNextInsertNameForNovel(np.root, afterFileName);
  }));

  ipcMain.handle('mana:novel:listCharacters', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.listCharacters(np.root);
  }));

  ipcMain.handle('mana:novel:readCharacter', safeIpc(async (_e, { id, charId }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readCharacter(np.root, charId);
  }));

  ipcMain.handle('mana:novel:writeCharacter', safeIpc(async (_e, { id, character }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.writeCharacter(np.root, character);
    await maybeLogOffline({ type: 'character', action: 'update', targetId: character?.id, targetName: character?.name, payload: character, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:deleteCharacter', safeIpc(async (_e, { id, charId }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.deleteCharacter(np.root, charId);
    await maybeLogOffline({ type: 'character', action: 'delete', targetId: charId, targetName: charId, payload: {}, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:listAssets', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.listAssets(np.root);
  }));

  ipcMain.handle('mana:novel:readAsset', safeIpc(async (_e, { id, assetId }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readAsset(np.root, assetId);
  }));

  ipcMain.handle('mana:novel:upsertAsset', safeIpc(async (_e, { id, asset }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.upsertAsset(np.root, asset);
    await maybeLogOffline({ type: 'asset', action: 'update', targetId: asset?.id, targetName: asset?.name, payload: asset, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:deleteAsset', safeIpc(async (_e, { id, assetId }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.deleteAsset(np.root, assetId);
    await maybeLogOffline({ type: 'asset', action: 'delete', targetId: assetId, targetName: assetId, payload: {}, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:grantAsset', safeIpc(async (_e, { id, payload }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.grantAsset(np.root, payload || {});
    await maybeLogOffline({ type: 'asset', action: 'grant', targetId: payload?.assetId, targetName: payload?.assetId, payload, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:revokeAsset', safeIpc(async (_e, { id, payload }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.revokeAsset(np.root, payload || {});
    await maybeLogOffline({ type: 'asset', action: 'revoke', targetId: payload?.assetId, targetName: payload?.assetId, payload, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:applyAssetPatch', safeIpc(async (_e, { id, patch }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.applyAssetPatch(np.root, patch || {});
    await maybeLogOffline({ type: 'asset', action: 'patch', targetId: 'asset-patch', targetName: '资产批量变更', payload: patch || {}, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:auditAssets', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.auditAssets(np.root);
  }));

  ipcMain.handle('mana:novel:listTimeline', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.listTimeline(np.root);
  }));

  ipcMain.handle('mana:novel:appendTimeline', safeIpc(async (_e, { id, event }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.appendTimelineEvent(np.root, event);
    await maybeLogOffline({ type: 'timeline', action: 'create', targetId: event?.id, targetName: event?.title, payload: { event }, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:replaceTimeline', safeIpc(async (_e, { id, events }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.replaceTimeline(np.root, events);
    await maybeLogOffline({ type: 'timeline', action: 'replace', targetId: 'timeline', targetName: '时间线', payload: { count: Array.isArray(events) ? events.length : 0 }, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:readWorld', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readWorld(np.root);
  }));

  ipcMain.handle('mana:novel:writeWorld', safeIpc(async (_e, { id, world }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.writeWorld(np.root, world);
    await maybeLogOffline({ type: 'world', action: 'update', targetId: 'world', targetName: '世界观', payload: world, novelId: id });
    return result;
  }));

  ipcMain.handle('mana:novel:readStyleMemory', safeIpc(async (_e, { id }) => {
    const np = await novelsStore.pathsFor(id);
    return novelData.readStyleMemory(np.root);
  }));

  ipcMain.handle('mana:novel:writeStyleMemory', safeIpc(async (_e, { id, text }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.writeStyleMemory(np.root, text);
    await maybeLogOffline({ type: 'style', action: 'update', targetId: 'style', targetName: '文风记忆', payload: { text }, novelId: id });
    return result;
  }));

  // ---- Character enrichment (manual web search) ----
  ipcMain.handle('mana:novel:cancelEnrichment', safeIpc(async (_e, { id, runId }) => {
    const active = enrichmentRuns.get(id);
    if (!active || active.runId !== runId) throw new Error('enrichment run does not belong to this novel');
    active.controller.abort(new DOMException('用户已取消角色补全', 'AbortError'));
    return { cancelled: true, runId };
  }));
  ipcMain.handle('mana:novel:enrichCharacters', safeIpc(async (_e, { id, fanworkName, characterIds, runId }) => {
    const np = await novelsStore.pathsFor(id);
    let characters = await novelData.listCharacters(np.root);
    if (!characters.length) {
      throw new Error('没有角色数据可补全');
    }
    // Filter to selected characters if characterIds provided
    if (Array.isArray(characterIds) && characterIds.length > 0) {
      const idSet = new Set(characterIds);
      characters = characters.filter((c) => idSet.has(c.id));
      if (!characters.length) {
        throw new Error('所选角色不存在');
      }
    }

    assertFanworkCharacters(characters);

    // Try to auto-detect fanwork name from world meta
    let resolvedFanworkName = fanworkName;
    if (!resolvedFanworkName) {
      try {
        const meta = await novelData.readWorldMeta(np.root);
        if (meta?.possibleFanworkOf && meta.possibleFanworkOf !== 'null' && meta.possibleFanworkOf !== '原创作品') {
          resolvedFanworkName = meta.possibleFanworkOf;
        }
      } catch { /* ignore */ }
    }

    const resolvedRunId = eventBus.ensureRunId(runId || `enrich-${id}-${Date.now()}`);
    if (enrichmentRuns.has(id)) throw new Error('该小说已有角色补全任务正在运行');
    const controller = new AbortController();
    enrichmentRuns.set(id, { runId: resolvedRunId, controller });
    try {

    // Progress callback emits events via eventBus so renderer can subscribe
    let progressQueue = Promise.resolve();
    const onProgress = (evt) => {
      progressQueue = progressQueue.then(() => eventBus.emit({
        runId: resolvedRunId,
        subagentId: 'character-enricher',
        kind: 'progress',
        data: evt.status === 'complete' ? { ...evt, status: 'extracted' } : evt,
      })).catch(() => {});
    };

    const enriched = await characterEnricher.enrichCharacters(
      characters,
      null,
      'zh-CN',
      { fanworkNameOverride: resolvedFanworkName, onProgress, abortSignal: controller.signal }
    );
    await progressQueue;

    const saved = await characterUpdates.saveEnrichment(np.root, characters, enriched, { runId: resolvedRunId, abortSignal: controller.signal });
    const written = saved.written;

    await eventBus.emit({
      runId: resolvedRunId,
      subagentId: 'character-enricher',
      kind: 'complete',
      data: { ...saved, charName: '_all', status: 'complete', successCount: written, failCount: saved.failures.length, total: characters.length, message: saved.needReview ? '已生成候选，待逐项审阅后保存' : `正式保存 ${written}/${characters.length} 个角色；字段冲突 ${saved.conflicts.length}，失败 ${saved.failures.length}${saved.cancelled ? '（已取消）' : ''}` },
    });

    return { ...saved, runId: resolvedRunId, written, total: characters.length, fanworkName: resolvedFanworkName };
    } finally { if (enrichmentRuns.get(id)?.runId === resolvedRunId) enrichmentRuns.delete(id); }
  }));

  // ---- Regenerate characters from novel text ----
  ipcMain.handle('mana:novel:regenerateCharacters', safeIpc(async (_e, { id, confirmed, reviewId, approved }) => {
    const np = await novelsStore.pathsFor(id);
    if (reviewId) return characterUpdates.commitRegeneration(np.root, reviewId, approved === true);

    // 1. Read all chapters and compute word count
    const chapters = await novelData.listChapters(np.root);
    let fullText = '';
    for (const ch of chapters) {
      const content = await novelData.readChapter(np.root, ch.name);
      fullText += content + '\n\n';
    }

    // Approximate word count: Chinese chars + English words
    const chineseChars = (fullText.match(/[一-鿿]/g) || []).length;
    const englishWords = fullText.split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w)).length;
    const wordCount = chineseChars + englishWords;
    const wordCountWan = Math.round(wordCount / 10000 * 10) / 10;

    // 2. If not confirmed, return stats for frontend to ask user
    if (!confirmed) {
      return { needConfirm: true, wordCount, wordCountWan, isLong: wordCount > 100000 };
    }

    return { ...await characterUpdates.prepareRegeneration(np.root, extractCharacters, fullText), wordCount, wordCountWan };
  }));

  // ---- Search across novel project ----
  ipcMain.handle('mana:novel:search', safeIpc(async (_e, { id, query, options }) => {
    if (!id) throw new Error('No novel ID provided');
    if (!query || !query.trim()) return [];
    const np = await novelsStore.pathsFor(id);
    const searchEngine = require('../search/searchEngine');
    return searchEngine.searchNovel(np.root, query.trim(), options || {});
  }));
}

module.exports = { registerNovelIpc };
