'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureLayout, paths } = require('./store/paths');
const subagentsStore = require('./store/subagents');
const dagsStore = require('./store/dags');
const skillsStore = require('./store/skills');
const appConfig = require('./store/appConfig');
const eventBus = require('./runtime/eventBus');
const mcpClient = require('./mcp/mcpClientStdio');
const workflowOrchestrator = require('./runtime/workflowOrchestrator');

const { registerFsIpc } = require('./ipc/fs');
const { registerConfigIpc } = require('./ipc/config');
const { registerRuntimeIpc } = require('./ipc/runtime');
const { registerNovelIpc } = require('./ipc/novel');
const { registerMcpIpc } = require('./ipc/mcp');
const { registerProviderManagerIpc } = require('./ipc/providerManager');
const { registerModelAliasesIpc } = require('./ipc/modelAliases');
const { registerChatIpc } = require('./ipc/chat');
const { registerChatAgentIpc } = require('./ipc/chatAgent');
const { registerChatHistoryIpc } = require('./ipc/chatHistory');
const { registerOfflineLogIpc } = require('./ipc/offlineLog');
const { registerImportIpc } = require('./ipc/import');
const { registerFeedbackIpc } = require('./ipc/feedback');
const { registerFeedbackSyncIpc } = require('./ipc/feedbackSync');
const { FeedbackSyncWorker } = require('./sync/feedbackSyncWorker');
const chatHistory = require('./store/chatHistory');
const offlineLog = require('./store/offlineLog');
const recentLogBuffer = require('./store/recentLogBuffer');
const stagingProject = require('./import/stagingProject');

const SKILL_SEED = `# Multi-Agent Novel Assistant — Skill Reference

This is a runtime reference document used by subagents and the config-helper.

## Product Positioning

MultiAgentNovelAssistant is infrastructure for AI IDE (Claude Code). The AI IDE makes decisions and performs analysis; this app provides MCP data tools, workflow guidance (DAG/Subagent), file management, and conflict resolution. The built-in direct-api driver is a fallback when Claude Code is unavailable.

## Tier slots

A Preset bundles 3 tier slots:

- **opus** — strong reasoning / consistency review (character / timeline)
- **sonnet** — chapter-level prose writing
- **haiku** — light annotation / cheap quick passes

Subagents declare a default tier; nodes in a DAG can override.

## Built-in subagents

- sa-outline-drafter (opus)
- sa-character-reviewer (opus)
- sa-timeline-guardian (opus)
- sa-style-checker (haiku)
- sa-prose-quality (haiku)
- sa-writer (sonnet)
- sa-lore-updater (opus)
- sa-import-orchestrator (sonnet) — novel import workflow orchestration
- sa-config-helper (haiku)

## Built-in DAGs

- dag-quality-outline / dag-quality-writing — quality-first; uses parallel review and revision loops
- dag-cheap-outline / dag-cheap-writing — cost-first; flatter graph, haiku-heavy

## Cost vs quality trade-offs

- Need to lower cost? Switch to dag-cheap-* and remap opus tier to a cheaper provider/model.
- Need to improve quality? Switch to dag-quality-* and ensure opus tier uses a top-tier model.
- Timeline correctness benefits from at least sonnet-level model on sa-timeline-guardian.

## Tools (MCP)

Read-only: list_characters, read_character, list_assets, read_asset, query_timeline,
check_timeline_feasibility, query_world, read_outline, read_chapter, read_style_memory,
read_skill, search_index.

Write (auto): grant_asset, revoke_asset, append_timeline, append_summary, append_style_memory.

Write (requires user confirmation): create_character, update_character, update_world.

---

# Character Web Search Strategy

When a novel is a fanwork/derivative work, official character info (appearance, personality, background, moe traits) must be filled in for characters from the original work.

## Cultural Sphere Routing

Determine the cultural sphere from the work name to decide search source priority:

| Sphere | Priority | Works |
|--------|----------|-------|
| east-asian-cn | Moegirl → Bing → Wikipedia | Chinese works (Azur Lane, Genshin Impact, etc.) |
| east-asian-jp | Wikipedia → Moegirl → Bing | Japanese works (Fate, Touhou, etc.) |
| east-asian-kr | Wikipedia → Bing → Moegirl | Korean works (Blue Archive, Nikke, etc.) |
| western-en | Wikipedia → Bing | Western works (Harry Potter, Marvel, etc.) |
| global | Wikipedia → Bing | Undetermined |

## Query Format per Source

Always include BOTH work name and character name to avoid same-name confusion:

| Source | Preferred Query | Example |
|--------|----------------|---------|
| Moegirl | {work}:{character} | Azur Lane:Atago |
| Moegirl (fallback) | {work} {character} | Azur Lane Atago |
| Wikipedia | {character} {work} character | Atago Azur Lane character |
| Bing / DDG | {character} {work} character wiki | Atago Azur Lane character wiki |

IMPORTANT: The work name MUST be in the query. Without it, same-name characters from different works will be confused (e.g. "Atago" appears in both Azur Lane and Kantai Collection).

## Search Failure Fallback

1. Try neighboring sphere (cn ↔ jp)
2. Try global DuckDuckGo
3. Mark _enrichmentStatus = 'search-failed', continue with other characters

## Data Merge Rules

- Novel data takes priority: if the character card already has a field, append web data as reference, do not overwrite
- Only fill empty fields with web data
- Write _enrichmentSource on every enrichment (format: sphere=east-asian-cn sources=moegirl,bing)
- Write _enrichmentStatus: success | extract-empty | search-failed | fetch-failed | extract-failed | skipped

## Multi-Work Crossover

When a novel references multiple original works:
1. Each character must have an explicit sourceWork
2. Group characters by sourceWork
3. Run enrichment independently per group
4. Each work uses its own cultural sphere routing

## User Decision Boundary

- isOriginal MUST be declared by the user; AI must NOT auto-detect it
- sourceWork may be preliminarily identified by AI during extraction, but final assignment requires user confirmation
- User can skip web enrichment at any time; characters keep their original extracted state
`;

let initialized = false;
let feedbackSyncWorker = null;

function getFeedbackSyncWorker() {
  return feedbackSyncWorker;
}

async function ensureSkillSeed() {
  const file = paths().skillsMain;
  try {
    fs.accessSync(file);
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SKILL_SEED, 'utf8');
  }
  try {
    await skillsStore.ensureSeeds(SKILL_SEED);
  } catch (err) {
    console.error('[init] skills store seed failed:', err.message);
  }
}

async function initBackend() {
  if (initialized) return;
  initialized = true;
  recentLogBuffer.installConsoleCapture();
  ensureLayout();
  await ensureSkillSeed();
  await subagentsStore.ensureBuiltinSeeds();
  await dagsStore.ensureBuiltinSeeds();
  // Restore last active novel, if still valid
  try {
    const cfg = await appConfig.load();
    if (cfg?.lastNovelId) {
      const novelsStore = require('./store/novels');
      const entry = await novelsStore.getNovelById(cfg.lastNovelId);
      if (entry) mcpClient.setActiveNovel(cfg.lastNovelId, entry.dir);
    }
  } catch (err) {
    console.error('[main] restore last novel failed', err);
  }
  // Enforce storage quotas on startup
  try {
    const cfg = await appConfig.load();
    if (cfg?.storageQuota?.chatHistoryMaxMB) {
      await chatHistory.enforceQuota(cfg.storageQuota.chatHistoryMaxMB * 1024 * 1024);
    }
    if (cfg?.storageQuota?.offlineLogMaxMB) {
      await offlineLog.enforceQuota(cfg.storageQuota.offlineLogMaxMB * 1024 * 1024);
    }
  } catch (err) {
    console.error('[main] quota enforcement failed', err);
  }
  registerFsIpc();
  registerConfigIpc();
  workflowOrchestrator.bootstrap();
  registerRuntimeIpc();
  registerNovelIpc();
  registerMcpIpc();
  registerProviderManagerIpc();
  registerModelAliasesIpc();
  registerChatIpc();
  registerChatAgentIpc();
  registerChatHistoryIpc();
  registerOfflineLogIpc();
  registerImportIpc();
  registerFeedbackIpc();
  registerFeedbackSyncIpc();
  registerLegacyChatCompletionsIpc();

  // Initialize feedback sync worker
  try {
    const cfg = await appConfig.load();
    if (cfg?.feishuSync) {
      feedbackSyncWorker = new FeedbackSyncWorker();
      feedbackSyncWorker.setConfig(cfg.feishuSync);
      if (cfg.feishuSync.enabled) {
        feedbackSyncWorker.start();
      }
    }
  } catch (err) {
    console.error('[main] feedback sync worker init failed', err);
  }

  // Cleanup expired import staging projects on startup
  try {
    await stagingProject.cleanupExpiredProjects();
  } catch (err) {
    console.error('[main] staging cleanup failed', err);
  }
}

function attachWindow(win) {
  if (!win) return;
  eventBus.setWebContents(win.webContents);
  workflowOrchestrator.setWebContents(win.webContents);
  win.on('closed', () => {
    eventBus.setWebContents(null);
    workflowOrchestrator.setWebContents(null);
  });
}

function registerLegacyChatCompletionsIpc() {
  const { ipcMain } = require('electron');
  if (ipcMain.eventNames().includes('mana-chat-completions')) return;
  ipcMain.handle('mana-chat-completions', async (_e, { url, headers, body }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Chat Completions ${res.status}: ${text}`);
    return JSON.parse(text);
  });
}

module.exports = { initBackend, attachWindow, getFeedbackSyncWorker };
