'use strict';

const { ipcMain } = require('electron');
const fs = require('node:fs').promises;
const path = require('node:path');
const novelsStore = require('../store/novels');
const novelData = require('../store/novelData');
const mcpClient = require('../mcp/mcpClientStdio');
const appConfig = require('../store/appConfig');
const offlineLog = require('../store/offlineLog');
const networkStatus = require('../store/networkStatus');
const characterEnricher = require('../import/characterEnricher');
const { extractCharacters } = require('../import/analyzer');
const eventBus = require('../runtime/eventBus');

function notifyChapterChanged(name, action, title) {
  if (!name) return;
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send('mana:chapter:changed', { name, action, title: title || null }); } catch {}
    }
  } catch {
    // ignore renderer sync failures
  }
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
  try {
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      try {
        wc.send('mana:novel:activeChanged', {
          action: action || 'updated',
          entry: entry || null,
        });
      } catch {}
    }
  } catch {
    // ignore renderer sync failures
  }
}

function safeIpc(handler) {
  return async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
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
      novelId: novelId || null,
    });
  } catch (err) {
    console.error('[novelIpc] offlineLog append failed', err);
  }
}

function registerNovelIpc() {
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
    mcpClient.setActiveNovel(id, r.entry?.dir);
    const cfg = await appConfig.load();
    await appConfig.save({ ...cfg, lastNovelId: id, lastNovelDir: r.entry.dir });
    notifyActiveNovelChanged(r.entry || null, 'opened');
    return { entry: r.entry, meta: r.meta };
  }));

  ipcMain.handle('mana:novel:close', safeIpc(async () => {
    mcpClient.setActiveNovel(null);
    notifyActiveNovelChanged(null, 'closed');
    return true;
  }));

  ipcMain.handle('mana:novel:active', safeIpc(async () => {
    const id = mcpClient.getActiveNovel();
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

  ipcMain.handle('mana:novel:saveChapter', safeIpc(async (_e, { id, name, content, metadata }) => {
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
    const result = await novelData.writeChapterWithMeta(np.root, name, content, finalMeta);
    const snapshot = await buildChapterSaveSnapshot(id, np.root, result.name || name, finalMeta);
    notifyChapterChanged(result.name || name, 'updated', finalMeta.title || existing?.metadata?.title || null);
    await maybeLogOffline({ type: 'chapter', action: 'update', targetId: name, targetName: name, payload: { name, content: content?.slice(0, 500) }, novelId: id });
    return {
      ...result,
      ...snapshot,
      metadata: finalMeta,
    };
  }));

  ipcMain.handle('mana:novel:deleteChapter', safeIpc(async (_e, { id, name }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.deleteChapter(np.root, name);
    notifyChapterChanged(result.name || name, 'deleted', null);
    await maybeLogOffline({ type: 'chapter', action: 'delete', targetId: name, targetName: name, payload: { name }, novelId: id });
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

  ipcMain.handle('mana:novel:upsertAsset', safeIpc(async (_e, { id, asset }) => {
    const np = await novelsStore.pathsFor(id);
    const result = await novelData.upsertAsset(np.root, asset);
    await maybeLogOffline({ type: 'asset', action: 'update', targetId: asset?.id, targetName: asset?.name, payload: asset, novelId: id });
    return result;
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
    await maybeLogOffline({ type: 'style', action: 'update', targetId: 'style', targetName: '文风记忆', payload: { text: text?.slice(0, 500) }, novelId: id });
    return result;
  }));

  // ---- Character enrichment (manual web search) ----
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

    // Progress callback emits events via eventBus so renderer can subscribe
    const onProgress = (evt) => {
      eventBus.emit({
        runId: resolvedRunId,
        subagentId: 'character-enricher',
        kind: 'progress',
        data: evt,
      }).catch(() => {});
    };

    const enriched = await characterEnricher.enrichCharacters(
      characters,
      null,
      'zh-CN',
      { fanworkNameOverride: resolvedFanworkName, onProgress }
    );

    // Write enriched characters back to disk
    let written = 0;
    for (const ch of enriched) {
      if (ch._enrichmentStatus === 'success') {
        await novelData.writeCharacter(np.root, ch);
        written++;
      }
    }

    await eventBus.emit({
      runId: resolvedRunId,
      subagentId: 'character-enricher',
      kind: 'complete',
      data: { written, total: characters.length },
    });

    return { runId: resolvedRunId, written, total: characters.length, fanworkName: resolvedFanworkName };
  }));

  // ---- Regenerate characters from novel text ----
  ipcMain.handle('mana:novel:regenerateCharacters', safeIpc(async (_e, { id, confirmed }) => {
    const np = await novelsStore.pathsFor(id);

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

    // 3. Execute: clear existing characters, then extract new ones
    const charDir = path.join(np.root, 'characters');
    try {
      const files = await fs.readdir(charDir);
      for (const f of files) {
        if (f.endsWith('.json')) await fs.unlink(path.join(charDir, f));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const extracted = await extractCharacters(fullText);
    const chars = Array.isArray(extracted) ? extracted : [];

    // Write each character
    const usedNames = new Set();
    for (const ch of chars) {
      let baseName = ch.id || ch.name || 'char';
      let fname = baseName;
      let dupIdx = 1;
      while (usedNames.has(fname)) { fname = `${baseName}-${dupIdx++}`; }
      usedNames.add(fname);
      const charObj = { ...ch, id: ch.id || fname };
      await novelData.writeCharacter(np.root, charObj);
    }

    return { characters: chars.length, wordCount, wordCountWan };
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
