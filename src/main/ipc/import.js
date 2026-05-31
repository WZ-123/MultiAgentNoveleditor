'use strict';

const { ipcMain, dialog } = require('electron');
const fs = require('node:fs').promises;
const path = require('node:path');
const fileParser = require('../import/fileParser');
const stagingProject = require('../import/stagingProject');
const analyzer = require('../import/analyzer');
const characterEnricher = require('../import/characterEnricher');
const conflictDetector = require('../import/conflictDetector');
const mergeEngine = require('../import/mergeEngine');
const aiMerge = require('../import/aiMerge');
const eventBus = require('../runtime/eventBus');
const { paths: getPaths } = require('../store/paths');
const resultMerger = require('../import/resultMerger');

function safeIpc(handler) {
  return async (event, ...args) => {
    try {
      return { ok: true, value: await handler(event, ...args) };
    } catch (err) {
      console.error('[import ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerImportIpc() {
  // Pick novel files (.md, .txt, .epub, Chatbox .html)
  ipcMain.handle('mana:import:pickFiles', safeIpc(async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Novel Files', extensions: ['md', 'txt', 'epub', 'html', 'htm', 'markdown'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'EPUB', extensions: ['epub'] },
        { name: 'Chatbox HTML', extensions: ['html', 'htm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: result.filePaths };
  }));

  // Parse files without creating a staging project
  ipcMain.handle('mana:import:parseFiles', safeIpc(async (_e, { filePaths }) => {
    const result = await fileParser.parseNovelFiles(filePaths);
    return result;
  }));

  // Check for duplicate import based on file fingerprint
  ipcMain.handle('mana:import:checkDuplicate', safeIpc(async (_e, { filePaths }) => {
    return stagingProject.checkDuplicateImport(filePaths);
  }));

  // Create a staging project from parsed chapters
  ipcMain.handle('mana:import:createStaging', safeIpc(async (_e, payload) => {
    const { sourceFiles, chapters, metadata, targetNovelId } = payload || {};
    return stagingProject.createStagingProject({
      sourceFiles,
      chapters,
      metadata,
      targetNovelId,
    });
  }));

  // Get a staging project with all its data
  ipcMain.handle('mana:import:getStaging', safeIpc(async (_e, { importId }) => {
    return stagingProject.getStagingProject(importId);
  }));

  // List active staging projects
  ipcMain.handle('mana:import:listStaging', safeIpc(async () => {
    return stagingProject.listStagingProjects();
  }));

  // Discard a staging project
  ipcMain.handle('mana:import:discardStaging', safeIpc(async (_e, { importId }) => {
    return stagingProject.discardStagingProject(importId);
  }));

  // Promote staging project to a real novel
  ipcMain.handle('mana:import:promoteToNovel', safeIpc(async (_e, { importId, title, dir }) => {
    return stagingProject.promoteToNovel(importId, { title, dir });
  }));

  // Cleanup expired staging projects
  ipcMain.handle('mana:import:cleanup', safeIpc(async () => {
    return stagingProject.cleanupExpiredProjects();
  }));

  // Start parallel AI analysis — spawns subagents, returns runIds immediately.
  // Frontend subscribes to agent:event, filters by runId, shows per-task progress.
  // When all agent:done events received, frontend calls finalizeAnalysis.
  ipcMain.handle('mana:import:analyze', async (_e, { importId }) => {
    try {
      const staging = await stagingProject.getStagingProject(importId);
      if (!staging) return { ok: false, error: 'Staging project not found' };
      const stagingDir = path.join(getPaths().root, 'import-staging', importId);
      const { runIds, taskIds, chunkMode, chunkCount } = await analyzer.startAnalyses(stagingDir);
      return { ok: true, value: { runIds, taskIds, chunkMode, chunkCount } };
    } catch (err) {
      console.error('[import analyze]', err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Wait for pending analyses and write results to staging project files.
  ipcMain.handle('mana:import:finalizeAnalysis', async (_e, { importId }) => {
    try {
      const stagingDir = path.join(getPaths().root, 'import-staging', importId);
      const result = await analyzer.finalizeAnalyses(stagingDir);
      return { ok: true, value: result };
    } catch (err) {
      console.error('[import finalize]', err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Detect conflicts between staging project and an existing novel
  ipcMain.handle('mana:import:detectConflicts', safeIpc(async (_e, { importId, novelId }) => {
    if (!novelId) throw new Error('novelId required');
    const staging = await stagingProject.getStagingProject(importId);
    if (!staging) throw new Error('Staging project not found');
    const novelsStore = require('../store/novels');
    const entry = await novelsStore.pathsFor(novelId);
    if (!entry) throw new Error('Target novel not found');
    const stagingForCompare = {
      characters: staging.characters || [],
      world: staging.world || { lore: '', places: [] },
      outline: staging.outline || '',
      styleMemory: staging.styleMemory || '',
    };
    return conflictDetector.detectConflicts(stagingForCompare, entry.root);
  }));

  // ---- AI Merge ----
  ipcMain.handle('mana:import:aiMerge', safeIpc(async (_e, { leftContent, rightContent, conflictType, userNote }) => {
    return aiMerge.aiMerge(leftContent, rightContent, conflictType, userNote);
  }));

  // ---- Merge session ----
  ipcMain.handle('mana:import:createMerge', safeIpc(async (_e, { importId, novelId }) => {
    const staging = await stagingProject.getStagingProject(importId);
    if (!staging) throw new Error('Staging project not found');
    if (!novelId) throw new Error('novelId required');
    const novelsStore = require('../store/novels');
    const entry = await novelsStore.pathsFor(novelId);
    if (!entry) throw new Error('Novel not found');
    const stagingDir = path.join(getPaths().root, 'import-staging', importId);
    return mergeEngine.createMergeSession(stagingDir, novelId, entry.root);
  }));

  ipcMain.handle('mana:import:getMerge', safeIpc(async (_e, { sessionId }) => {
    return mergeEngine.getMergeSession(sessionId);
  }));

  ipcMain.handle('mana:import:resolveConflict', safeIpc(async (_e, { sessionId, itemId, decision, resolvedContent, userNote }) => {
    return mergeEngine.resolveConflict(sessionId, itemId, decision, { resolvedContent, userNote });
  }));

  ipcMain.handle('mana:import:resetMerge', safeIpc(async (_e, { sessionId }) => {
    mergeEngine.resetAll(sessionId);
    return { ok: true };
  }));

  ipcMain.handle('mana:import:getMergeSummary', safeIpc(async (_e, { sessionId }) => {
    return mergeEngine.getMergeSummary(sessionId);
  }));

  ipcMain.handle('mana:import:finalizeMerge', safeIpc(async (_e, { sessionId }) => {
    return mergeEngine.finalizeMerge(sessionId);
  }));

  // Check if staging project has been analyzed (has characters, world, etc.)
  ipcMain.handle('mana:import:checkAnalysis', safeIpc(async (_e, { importId }) => {
    const staging = await stagingProject.getStagingProject(importId);
    if (!staging) return { analyzed: false };
    return {
      analyzed:
        (staging.characters?.length || 0) > 0 ||
        !!staging.world?.lore ||
        !!staging.outline,
      characterCount: staging.characters?.length || 0,
      hasLore: !!staging.world?.lore,
      hasOutline: !!staging.outline,
      hasStyle: !!staging.styleMemory,
    };
  }));

  // ---- Staging character operations ----
  ipcMain.handle('mana:import:getStagingCharacters', safeIpc(async (_e, { importId }) => {
    const staging = await stagingProject.getStagingProject(importId);
    if (!staging) throw new Error('Staging project not found');
    return staging.characters || [];
  }));

  ipcMain.handle('mana:import:saveStagingCharacters', safeIpc(async (_e, { importId, characters }) => {
    const projDir = path.join(getPaths().root, 'import-staging', importId);
    const charsDir = path.join(projDir, 'characters');
    await fs.mkdir(charsDir, { recursive: true });
    for (const ch of (characters || [])) {
      const safeId = String(ch.id || ch.name || 'char').replace(/[^\w\-.]/g, '_');
      await fs.writeFile(path.join(charsDir, `${safeId}.json`), JSON.stringify(ch, null, 2), 'utf8');
    }
    return { saved: (characters || []).length };
  }));

  ipcMain.handle('mana:import:enrichStagingCharacters', safeIpc(async (_e, { importId, workAssignments }) => {
    const projDir = path.join(getPaths().root, 'import-staging', importId);
    const charsDir = path.join(projDir, 'characters');

    // Read all characters from staging
    const files = await fs.readdir(charsDir).catch(() => []);
    const allChars = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const obj = await fs.readFile(path.join(charsDir, f), 'utf8').then(JSON.parse).catch(() => null);
      if (obj) allChars.push(obj);
    }

    const runId = eventBus.ensureRunId(`enrich-staging-${importId}-${Date.now()}`);
    const results = [];

    for (const [workName, charIds] of Object.entries(workAssignments || {})) {
      const group = allChars.filter((c) => charIds.includes(c.id));
      if (!group.length) continue;

      const onProgress = (evt) => {
        eventBus.emit({
          runId,
          subagentId: 'character-enricher',
          kind: 'progress',
          data: { ...evt, workName },
        }).catch(() => {});
      };

      const enriched = await characterEnricher.enrichCharacters(
        group,
        null,
        'zh-CN',
        { fanworkNameOverride: workName, onProgress }
      );

      // Write enriched characters back to staging
      for (const ch of enriched) {
        const safeId = String(ch.id || 'char').replace(/[^\w\-.]/g, '_');
        await fs.writeFile(path.join(charsDir, `${safeId}.json`), JSON.stringify(ch, null, 2), 'utf8');
      }
      results.push({ workName, count: group.length });
    }

    await eventBus.emit({
      runId,
      subagentId: 'character-enricher',
      kind: 'complete',
      data: { results },
    });

    return { runId, results };
  }));
}

module.exports = { registerImportIpc };
