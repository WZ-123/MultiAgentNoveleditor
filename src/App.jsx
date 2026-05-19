import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Settings, Search, GitBranch, MessageSquare, Play, Cpu } from 'lucide-react';
import { PipelineRunnerPanel } from '@/components/PipelineRunnerPanel.jsx';
import { AppSettingsPanel } from '@/components/AppSettingsPanel.jsx';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher.jsx';
import { ToolConfirmationModal } from '@/components/ToolConfirmationModal.jsx';
import { RuntimeStatusIndicator } from '@/components/RuntimeStatusIndicator.jsx';
import { BlueprintEditor } from '@/components/BlueprintEditor.jsx';
import { ProviderSettingsPanel } from '@/components/ProviderSettingsPanel.jsx';
import { RuntimeDriverSettings } from '@/components/RuntimeDriverSettings.jsx';
import { saveNovelTree } from '@/services/chapterStore.js';
import { SubagentEditor } from '@/components/SubagentEditor.jsx';
import { DagEditor } from '@/components/DagEditor.jsx';
import { ConfigHelperChat } from '@/components/ConfigHelperChat.jsx';
import { AiChatPanel } from '@/components/AiChatPanel.jsx';
import { LanguageSettings } from '@/components/LanguageSettings.jsx';
import { StorageSettings } from '@/components/StorageSettings.jsx';
import { SearchSettings } from '@/components/SearchSettings.jsx';
import { SkillSettings } from '@/components/SkillSettings.jsx';
import { OfflineSyncDialog } from '@/components/OfflineSyncDialog.jsx';
import { ImportNovelPanel } from '@/components/ImportNovelPanel.jsx';
import { ImportMergePanel } from '@/components/ImportMergePanel.jsx';
import { NovelDataBrowser } from '@/components/NovelDataBrowser.jsx';
import { DataTabContent } from '@/components/DataTabContent.jsx';
import { countMeaningfulCharacters } from '@/domain/text.js';
import { useI18n } from '@/i18n/LanguageContext.jsx';

const TAB_PREFIX = 'chapter:';
const BLUEPRINT_PREFIX = 'blueprint:';
const SETTINGS_PREFIX = 'settings:';
const DATA_PREFIX = 'data:'; // character, world, outline, timeline, style
const DEFAULT_RIGHT_PANEL_WIDTH = 448;
const MIN_RIGHT_PANEL_WIDTH = 320;
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'mana-right-panel-width-v1';
const makeId = (prefix) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function clampRightPanelWidth(width) {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const maxWidth = Math.max(480, Math.floor(viewportWidth * 0.7));
  return Math.min(Math.max(width, MIN_RIGHT_PANEL_WIDTH), maxWidth);
}

function readInitialRightPanelWidth() {
  if (typeof window === 'undefined') return DEFAULT_RIGHT_PANEL_WIDTH;
  try {
    const rawWidth = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    const parsedWidth = Number.parseInt(rawWidth || '', 10);
    if (Number.isFinite(parsedWidth)) {
      return clampRightPanelWidth(parsedWidth);
    }
  } catch {
    /* ignore storage read failures */
  }
  return clampRightPanelWidth(DEFAULT_RIGHT_PANEL_WIDTH);
}

const CN_NUMS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const toChineseNum = (n) => {
  if (n <= 10) return CN_NUMS[n];
  if (n < 20) return '十' + (n % 10 > 0 ? CN_NUMS[n % 10] : '');
  const tens = Math.floor(n / 10);
  const rem = n % 10;
  return CN_NUMS[tens] + '十' + (rem > 0 ? CN_NUMS[rem] : '');
};

function parseMarkdownOutline(content) {
  if (!content) return [];
  const lines = content.split('\n');
  const headings = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
      });
    }
  }
  return headings;
}

function getChapterWordCount(content) {
  return countMeaningfulCharacters(content);
}

function App() {
  const { t } = useI18n();
  const [activeSidebarItem, setActiveSidebarItem] = useState('explorer');
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(() => readInitialRightPanelWidth());
  const [novel, setNovel] = useState({ volumes: [] });
  const [openChapterIds, setOpenChapterIds] = useState([]);
  const [openBlueprintIds, setOpenBlueprintIds] = useState([]);
  const [openSettingsIds, setOpenSettingsIds] = useState([]);
  const [activeEditorTab, setActiveEditorTab] = useState('');

  // ---- Online/offline & sync dialog ----
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [syncNovelId, setSyncNovelId] = useState(null);

  // ---- Import novel panel ----
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [existingNovels, setExistingNovels] = useState([]);
  const [mergePanel, setMergePanel] = useState(null);
  const [activeNovelId, setActiveNovelId] = useState('');
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'save-failed'
  const [saveToast, setSaveToast] = useState(null); // { type: 'success' | 'error', message: string } | null

  // Track active novel ID for data tabs and sync chapter tree.
  // When the active novel is closed (newId becomes ''), clear everything
  // so the UI never shows a ghost chapter tree.
  useEffect(() => {
    if (!window.mana?.novel?.active) return;
    let cancelled = false;
    const check = async () => {
      try {
        const a = await window.mana.novel.active();
        if (!cancelled) {
          const newId = a?.id || '';
          if (newId !== activeNovelId) {
            setActiveNovelId(newId);
            if (newId) {
              // Clear previous novel's sidebar state before loading new one
              setNovel({ volumes: [] });
              setOpenChapterIds([]);
              setOpenBlueprintIds([]);
              setOpenSettingsIds([]);
              setActiveEditorTab('');
              syncNovelTreeFromDisk(a);
            } else {
              // Novel closed — clear in-memory tree and localStorage cache
              setNovel({ volumes: [] });
              setOpenChapterIds([]);
              setOpenBlueprintIds([]);
              setOpenSettingsIds([]);
              setActiveEditorTab('');
              try { localStorage.removeItem('mana-chapters-v1'); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* ignore */ }
    };
    check();
    const iv = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [activeNovelId]);

  // Sync the novel tree (volumes/sections/chapters) from the project directory on disk
  async function syncNovelTreeFromDisk(novelEntry) {
    if (!novelEntry?.dir || !window.mana) return;
    try {
      // Read naming rule for display name computation
      let namingRule = '第{n}章';
      let namingSep = '：';
      try {
        const cfg = await window.mana.novel.getChapterNaming(novelEntry.id);
        if (cfg?.rule) { namingRule = cfg.rule; namingSep = cfg.separator || '：'; }
      } catch {}

      // List chapter files from the novel's chapters/ dir
      const files = await window.mana.novel.listChapters(novelEntry.id);
      const chapters = [];
      for (let i = 0; i < (files || []).length; i++) {
        const f = files[i];
        const name = typeof f === 'string' ? f : f.name || f.fileName || '';
        if (!name.endsWith('.md')) continue;
        try {
          // Read frontmatter metadata (fast, first 2KB)
          let title = name;
          let volume = null;
          let section = null;
          const meta = await window.mana.novel.readChapterMeta(novelEntry.id, name);
          if (meta?.metadata) {
            if (meta.metadata.title) title = meta.metadata.title;
            if (meta.metadata.volume != null) volume = meta.metadata.volume;
            if (meta.metadata.section != null) section = meta.metadata.section;
          }
          // Read full content (frontmatter stripped automatically)
          const content = await window.mana.novel.readChapter(novelEntry.id, name);
          // Fallback: extract # Title from content for legacy files w/o frontmatter
          if (!meta?.metadata?.title) {
            const m = (content || '').match(/^#\s+(.+)/);
            if (m) title = m[1].trim();
          }
          // Compute display name: e.g., "第一章：苟利国家生死以"
          const seq = i + 1;
          let displayName = namingRule.replace('{n}', seq).replace('{cn}', toChineseNum(seq));
          if (title) displayName += namingSep + title;
          chapters.push({
            id: `ch-${name}-${Date.now()}`,
            fileName: name,
            content: content || '',
            _title: title,
            displayName,
            volume,
            section,
          });
        } catch { /* skip broken file */ }
      }
      // Sort by filename
      chapters.sort((a, b) => a.fileName.localeCompare(b.fileName));
      if (chapters.length > 0) {
        // Restore volume/section structure from novel.json
        let structure = null;
        try {
          const active = await window.mana.novel.active();
          if (active?.dir) {
            const raw = await window.mana.fs.readFile(active.dir + '/novel.json', 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed?.structure?.volumes) structure = parsed.structure;
          }
        } catch {}
        let volumes;
        if (structure?.volumes?.length > 0) {
          const allCh = chapters.slice();
          let chIdx = 0;
          volumes = structure.volumes.map((v, vi) => ({
            id: `vol-${vi}-${Date.now()}`,
            name: v.name || '卷' + (vi + 1),
            sections: (v.sections || []).map((s, si) => {
              const matched = allCh.filter(c => c.volume === vi + 1 && c.section === si + 1);
              const assigned = matched.length > 0 ? matched : allCh.slice(chIdx, chIdx + Math.ceil(allCh.length / structure.volumes.length));
              chIdx += assigned.length || Math.ceil(allCh.length / structure.volumes.length);
              return { id: `sec-${vi}-${si}`, name: s.name || '节' + (si + 1), chapters: assigned };
            }),
          }));
        } else {
          volumes = [{ id: `vol-${Date.now()}`, name: '卷1', sections: [{ id: `sec-${Date.now()}`, name: '节1', chapters }] }];
        }
        setNovel({ volumes });
      }
    } catch (err) {
      console.error('[App] syncNovelTree failed:', err);
    }
  }

  async function loadExistingNovels() {
    if (!window.mana?.novel?.list) return;
    try {
      const list = await window.mana.novel.list();
      setExistingNovels(list || []);
    } catch (err) {
      console.error('[App] load novels failed', err);
    }
  }

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      if (window.mana?.networkStatus?.set) {
        window.mana.networkStatus.set('online').catch(() => {});
      }
    };
    const onOffline = () => {
      setIsOnline(false);
      if (window.mana?.networkStatus?.set) {
        window.mana.networkStatus.set('disconnected').catch(() => {});
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // Report initial status
    if (window.mana?.networkStatus?.set) {
      window.mana.networkStatus.set(navigator.onLine ? 'online' : 'disconnected').catch(() => {});
    }
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // When coming back online, check for unsynced offline entries
  useEffect(() => {
    if (!isOnline) return;
    const mana = window.mana;
    if (!mana?.offlineLog?.listUnsynced) return;
    (async () => {
      try {
        // Get active novel id from mcp client via novel:active
        const activeNovel = await mana.novel.active();
        const novelId = activeNovel?.id || null;
        const unsynced = await mana.offlineLog.listUnsynced(novelId);
        if (unsynced && unsynced.length > 0) {
          setSyncNovelId(novelId);
          setShowSyncDialog(true);
        }
      } catch (err) {
        console.error('[App] check unsynced failed', err);
      }
    })();
  }, [isOnline]);

  const chapterEntries = useMemo(() => {
    const entries = [];
    novel.volumes.forEach((volume) => {
      volume.sections.forEach((section) => {
        section.chapters.forEach((chapter) => {
          entries.push({
            volumeId: volume.id,
            sectionId: section.id,
            chapter,
            volumeName: volume.name,
            sectionName: section.name,
          });
        });
      });
    });
    return entries;
  }, [novel]);

  const chapterMap = useMemo(() => {
    const m = new Map();
    chapterEntries.forEach((entry) => m.set(entry.chapter.id, entry));
    return m;
  }, [chapterEntries]);

  // Listen for chapter changes from main process (MCP write_chapter, etc.)
  useEffect(() => {
    const mana = window.mana;
    if (!mana?.novel?.onChapterChanged) return;
    const cleanup = mana.novel.onChapterChanged(async (data) => {
      if (!data?.name) return;
      const existing = chapterEntries.find(e => e.chapter.fileName === data.name);

      try {
        const activeEntry = await mana.novel.active();
        if (!activeEntry?.id) return;
        const meta = await mana.novel.readChapterMeta(activeEntry.id, data.name);
        let title = data.title || data.name;
        if (meta?.metadata?.title) title = meta.metadata.title;
        const content = await mana.novel.readChapter(activeEntry.id, data.name);
        if (!meta?.metadata?.title && content) {
          const m = content.match(/^#\s+(.+)/);
          if (m) title = m[1].trim();
        }
        let namingRule = '第{n}章';
        let namingSep = '：';
        try {
          const cfg = await mana.novel.getChapterNaming(activeEntry.id);
          if (cfg?.rule) { namingRule = cfg.rule; namingSep = cfg.separator || '：'; }
        } catch {}
        const sorted = [...new Set([...chapterEntries.map(e => e.chapter.fileName), data.name])].sort((a, b) => a.localeCompare(b));
        const seq = sorted.indexOf(data.name) + 1;
        let displayName = namingRule.replace('{n}', seq).replace('{cn}', toChineseNum(seq));
        if (title) displayName += namingSep + title;
        const nextChapter = {
          id: existing?.chapter?.id || `ch-${data.name}-${Date.now()}`,
          fileName: data.name,
          content: content || '',
          _title: title,
          displayName,
          volume: meta?.metadata?.volume || null,
          section: meta?.metadata?.section || null,
        };
        setNovel(prev => {
          const volumes = prev.volumes.map(v => ({
            ...v,
            sections: v.sections.map(s => ({
              ...s,
              chapters: existing
                ? s.chapters.map((chapter) => (chapter.fileName === data.name ? { ...chapter, ...nextChapter } : chapter))
                : [...s.chapters, nextChapter].sort((a, b) => a.fileName.localeCompare(b.fileName)),
            })),
          }));
          return { ...prev, volumes };
        });
      } catch (err) {
        console.error('[App] incremental chapter sync failed:', err);
      }
    });
    return cleanup;
  }, [chapterEntries]);

  // Persist volume/section tree structure to novel.json
  const syncStructureToMeta = (novelData) => {
    if (!activeNovelId || !window.mana?.novel?.saveMeta) return;
    const volumes = (novelData || novel).volumes.map(v => ({
      name: v.name,
      sections: v.sections.map(s => ({ name: s.name })),
    }));
    window.mana.novel.saveMeta(activeNovelId, { structure: { volumes } }).catch(() => {});
  };

  const dataTabLabel = (dataType) => {
    const labels = { characters: '角色卡', world: '世界观', timeline: '时间线', outline: '大纲', style: '文风' };
    return labels[dataType] || dataType;
  };

  const editorTabs = useMemo(() => {
    const chapterTabs = openChapterIds
      .map((id) => chapterMap.get(id)?.chapter)
      .filter(Boolean)
      .map((chapter) => ({
        id: `${TAB_PREFIX}${chapter.id}`,
        chapterId: chapter.id,
        title: chapter.displayName || chapter.fileName,
        language: 'Markdown',
        content: chapter.content,
        type: 'chapter',
      }));
    const blueprintTabs = openBlueprintIds.map((bpId) => ({
      id: `${BLUEPRINT_PREFIX}${bpId}`,
      blueprintId: bpId,
      title: `流程: ${bpId}`,
      language: 'Blueprint',
      type: 'blueprint',
    }));
    const settingsTitle = (sid) => {
      switch (sid) {
        case 'language': return t('settings.languageTitle');
        case 'runtime': return t('runtime.title');
        case 'subagent': return t('subagent.title');
        case 'dag': return t('dag.title');
        case 'config-helper': return '配置助手';
        case 'models': return t('settings.llmTitle');
        case 'storage': return '存储空间';
        case 'search': return '搜索引擎';
        case 'skill': return 'Skill';
        default: return `设置: ${sid}`;
      }
    };
    const settingsTabs = openSettingsIds.map((sid) => ({
      id: `${SETTINGS_PREFIX}${sid}`,
      settingsId: sid,
      title: settingsTitle(sid),
      language: 'Settings',
      type: 'settings',
    }));
    // Data view tabs (characters, world, etc.) — shown when activeEditorTab starts with DATA_PREFIX
    const activeDataTabId = activeEditorTab.startsWith(DATA_PREFIX) ? activeEditorTab.slice(DATA_PREFIX.length) : '';
    const dataTabs = activeDataTabId ? [{
      id: `${DATA_PREFIX}${activeDataTabId}`,
      title: dataTabLabel(activeDataTabId),
      type: 'data',
    }] : [];
    return [...chapterTabs, ...blueprintTabs, ...settingsTabs, ...dataTabs];
  }, [openChapterIds, openBlueprintIds, openSettingsIds, chapterMap, t, activeEditorTab]);

  const activeChapterId = activeEditorTab.startsWith(TAB_PREFIX)
    ? activeEditorTab.slice(TAB_PREFIX.length)
    : '';
  const activeChapterEntry = activeChapterId ? chapterMap.get(activeChapterId) : null;
  const activeChapter = activeChapterEntry?.chapter ?? null;
  const activeBlueprintId = activeEditorTab.startsWith(BLUEPRINT_PREFIX)
    ? activeEditorTab.slice(BLUEPRINT_PREFIX.length)
    : '';
  const activeSettingsId = activeEditorTab.startsWith(SETTINGS_PREFIX)
    ? activeEditorTab.slice(SETTINGS_PREFIX.length)
    : '';

  const openChapterInEditor = (chapterId) => {
    if (!chapterMap.get(chapterId)) return;
    setOpenChapterIds((ids) => (ids.includes(chapterId) ? ids : [...ids, chapterId]));
    setActiveEditorTab(`${TAB_PREFIX}${chapterId}`);
  };

  const openBlueprintInEditor = (bpId) => {
    setOpenBlueprintIds((ids) => (ids.includes(bpId) ? ids : [...ids, bpId]));
    setActiveEditorTab(`${BLUEPRINT_PREFIX}${bpId}`);
  };

  const openSettingsInEditor = (sid) => {
    setOpenSettingsIds((ids) => (ids.includes(sid) ? ids : [...ids, sid]));
    setActiveEditorTab(`${SETTINGS_PREFIX}${sid}`);
  };

  const openDataInEditor = (dataType) => {
    const tabId = `${DATA_PREFIX}${dataType}`;
    setActiveEditorTab(tabId);
  };

  const ensureMarkdownFileName = (name) =>
    name.toLowerCase().endsWith('.md') ? name : `${name}.md`;

  const createVolume = () => {
    const index = novel.volumes.length + 1;
    const volume = {
      id: makeId('volume'),
      name: `卷${index}`,
      sections: [],
    };
    setNovel((n) => {
      const updated = { ...n, volumes: [...n.volumes, volume] };
      syncStructureToMeta(updated);
      return updated;
    });
  };

  const createSection = (volumeId) => {
    setNovel((n) => {
      const updated = {
        ...n,
        volumes: n.volumes.map((volume) => {
          if (volume.id !== volumeId) return volume;
          const idx = volume.sections.length + 1;
          return {
            ...volume,
            sections: [
              ...volume.sections,
              {
                id: makeId('section'),
                name: `节${idx}`,
                chapters: [],
              },
            ],
          };
        }),
      };
      syncStructureToMeta(updated);
      return updated;
    });
  };

  const createChapter = (volumeId, sectionId) => {
    let next = chapterEntries.length + 1;
    let fileName = `chapter-${String(next).padStart(3, '0')}.md`;
    const exists = (name) =>
      chapterEntries.some(
        (e) => e.chapter.fileName.toLowerCase() === name.toLowerCase()
      );
    while (exists(fileName)) {
      next += 1;
      fileName = `chapter-${String(next).padStart(3, '0')}.md`;
    }

    const chapter = {
      id: makeId('chapter'),
      fileName,
      content: '',
    };

    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((volume) => {
        if (volume.id !== volumeId) return volume;
        return {
          ...volume,
          sections: volume.sections.map((section) =>
            section.id === sectionId
              ? { ...section, chapters: [...section.chapters, chapter] }
              : section
          ),
        };
      }),
    }));
    setOpenChapterIds((ids) => (ids.includes(chapter.id) ? ids : [...ids, chapter.id]));
    setActiveEditorTab(`${TAB_PREFIX}${chapter.id}`);
    // Persist: write empty file to disk
    if (activeNovelId && window.mana?.novel?.saveChapter) {
      window.mana.novel.saveChapter(activeNovelId, fileName, '').catch(() => {});
    }
  };
  
  const closeEditorTab = (tabId) => {
    if (tabId.startsWith(TAB_PREFIX)) {
      const chapterId = tabId.slice(TAB_PREFIX.length);
      // Flush save before closing
      const chapterEntry = chapterMap.get(chapterId);
      if (chapterEntry?.chapter?.fileName && activeNovelId && window.mana?.novel?.saveChapter) {
        const ch = chapterEntry.chapter;
        const titleMatch = (ch.content || '').match(/^#\s+(.+)/);
        const chapTitle = titleMatch ? titleMatch[1].trim() : (ch._title || '');
        window.mana.novel.saveChapter(activeNovelId, ch.fileName, ch.content, { title: chapTitle })
          .catch(() => {});
      }
      setOpenChapterIds((ids) => {
        if (!ids.includes(chapterId)) return ids;
        const currentIndex = ids.indexOf(chapterId);
        const nextIds = ids.filter((id) => id !== chapterId);
        if (activeEditorTab === tabId) {
          const fallbackIndex = Math.max(0, currentIndex - 1);
          const fallbackId = nextIds[fallbackIndex] ?? nextIds[0] ?? '';
          setActiveEditorTab(fallbackId ? `${TAB_PREFIX}${fallbackId}` : '');
        }
        return nextIds;
      });
    } else if (tabId.startsWith(BLUEPRINT_PREFIX)) {
      const bpId = tabId.slice(BLUEPRINT_PREFIX.length);
      setOpenBlueprintIds((ids) => {
        if (!ids.includes(bpId)) return ids;
        const currentIndex = ids.indexOf(bpId);
        const nextIds = ids.filter((id) => id !== bpId);
        if (activeEditorTab === tabId) {
          const fallbackIndex = Math.max(0, currentIndex - 1);
          const fallbackId = nextIds[fallbackIndex] ?? nextIds[0] ?? '';
          setActiveEditorTab(fallbackId ? `${BLUEPRINT_PREFIX}${fallbackId}` : '');
        }
        return nextIds;
      });
    } else if (tabId.startsWith(DATA_PREFIX)) {
      setActiveEditorTab('');
    } else if (tabId.startsWith(SETTINGS_PREFIX)) {
      const sid = tabId.slice(SETTINGS_PREFIX.length);
      setOpenSettingsIds((ids) => {
        if (!ids.includes(sid)) return ids;
        const currentIndex = ids.indexOf(sid);
        const nextIds = ids.filter((id) => id !== sid);
        if (activeEditorTab === tabId) {
          const fallbackIndex = Math.max(0, currentIndex - 1);
          const fallbackId = nextIds[fallbackIndex] ?? nextIds[0] ?? '';
          setActiveEditorTab(fallbackId ? `${SETTINGS_PREFIX}${fallbackId}` : '');
        }
        return nextIds;
      });
    }
  };

  const removeDeletedChapterIdsFromTabs = (deletedChapterIds) => {
    if (deletedChapterIds.length === 0) return;
    setOpenChapterIds((ids) => ids.filter((id) => !deletedChapterIds.includes(id)));
    if (activeChapterId && deletedChapterIds.includes(activeChapterId)) {
      setActiveEditorTab('');
    }
  };

  const renameVolume = async (volumeId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    if (!volume) return;
    const name = await window.mana.prompt.show(t('app.renameVolumePrompt'), volume.name);
    if (name == null) return;
    const next = name.trim();
    if (!next) return;
    setNovel((n) => {
      const updated = {
        ...n,
        volumes: n.volumes.map((v) => (v.id === volumeId ? { ...v, name: next } : v)),
      };
      syncStructureToMeta(updated);
      return updated;
    });
  };

  const deleteVolume = (volumeId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    if (!volume) return;
    const ok = window.confirm(
      t('app.deleteVolumeConfirm').replace('{name}', volume.name)
    );
    if (!ok) return;
    const deletedChapterIds = volume.sections.flatMap((s) => s.chapters.map((c) => c.id));
    setNovel((n) => {
      const updated = {
        ...n,
        volumes: n.volumes.filter((v) => v.id !== volumeId),
      };
      syncStructureToMeta(updated);
      return updated;
    });
    removeDeletedChapterIdsFromTabs(deletedChapterIds);
  };

  const renameSection = async (volumeId, sectionId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    const section = volume?.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const name = await window.mana.prompt.show(t('app.renameSectionPrompt'), section.name);
    if (name == null) return;
    const next = name.trim();
    if (!next) return;
    setNovel((n) => {
      const updated = {
        ...n,
        volumes: n.volumes.map((v) =>
          v.id !== volumeId
            ? v
            : {
                ...v,
                sections: v.sections.map((s) =>
                  s.id === sectionId ? { ...s, name: next } : s
                ),
              }
        ),
      };
      syncStructureToMeta(updated);
      return updated;
    });
  };

  const deleteSection = (volumeId, sectionId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    const section = volume?.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const ok = window.confirm(
      t('app.deleteSectionConfirm').replace('{name}', section.name)
    );
    if (!ok) return;
    const deletedChapterIds = section.chapters.map((c) => c.id);
    setNovel((n) => {
      const updated = {
        ...n,
        volumes: n.volumes.map((v) =>
          v.id !== volumeId
            ? v
            : {
                ...v,
                sections: v.sections.filter((s) => s.id !== sectionId),
              }
        ),
      };
      syncStructureToMeta(updated);
      return updated;
    });
    removeDeletedChapterIdsFromTabs(deletedChapterIds);
  };

  const renameChapter = async (chapterId) => {
    const entry = chapterMap.get(chapterId);
    const chapter = entry?.chapter;
    if (!entry || !chapter) return;
    const nextTitle = await window.mana.prompt.show('输入章节标题', chapter._title || '');
    if (nextTitle == null) return;
    const raw = nextTitle.trim();
    if (!raw) return;
    // Update in-memory state
    const newDisplayName = chapter.displayName
      ? chapter.displayName.replace(/[:：].*$/, '：' + raw)
      : raw;
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.map((c) =>
            c.id === chapterId ? { ...c, _title: raw, displayName: newDisplayName } : c
          ),
        })),
      })),
    }));
    // Persist to disk (update frontmatter)
    if (activeNovelId) {
      window.mana?.novel?.saveChapter(activeNovelId, chapter.fileName, chapter.content, { title: raw })
        .catch(() => {});
    }
  };

  const deleteChapter = (chapterId) => {
    const entry = chapterMap.get(chapterId);
    const chapter = entry?.chapter;
    if (!chapter) return;
    const confirmText = t('app.deleteChapterConfirm').replace('{name}', chapter.fileName);
    const ok = window.confirm(confirmText);
    if (!ok) return;

    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.filter((c) => c.id !== chapterId),
        })),
      })),
    }));
    removeDeletedChapterIdsFromTabs([chapterId]);
    // Delete file from disk
    if (chapter.fileName && window.mana?.fs?.deleteFile) {
      (async () => {
        try {
          const active = await window.mana.novel.active();
          if (active?.dir) {
            await window.mana.fs.deleteFile(`${active.dir}/chapters/${chapter.fileName}`);
          }
        } catch (err) { console.error('[App] delete chapter file failed:', err); }
      })();
    }
  };

  const [editorSelection, setEditorSelection] = useState({ text: '', start: 0, end: 0 });
  const [editorHasFocus, setEditorHasFocus] = useState(false);
  const [editorScroll, setEditorScroll] = useState({ top: 0, left: 0 });
  const isResizingRightPanelRef = useRef(false);
  const [isRightPanelResizeHover, setIsRightPanelResizeHover] = useState(false);
  const [isRightPanelResizing, setIsRightPanelResizing] = useState(false);

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!isResizingRightPanelRef.current) return;
      setRightPanelWidth(clampRightPanelWidth(window.innerWidth - event.clientX));
    };

    const stopResize = () => {
      if (!isResizingRightPanelRef.current) return;
      isResizingRightPanelRef.current = false;
      setIsRightPanelResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      stopResize();
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setRightPanelWidth((currentWidth) => clampRightPanelWidth(currentWidth));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
    } catch {
      /* ignore storage write failures */
    }
  }, [rightPanelWidth]);

  const startResizeRightPanel = useCallback((event) => {
    event.preventDefault();
    isResizingRightPanelRef.current = true;
    setIsRightPanelResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  const editorTextareaRef = useRef(null);
  const pendingEditorSelectionRef = useRef(null);

  const showSaveToast = useCallback((type, message) => {
    setSaveToast({ type, message });
    setTimeout(() => setSaveToast(null), 3000);
  }, []);

  const manualSave = useCallback(async () => {
    if (!activeChapterId || !activeNovelId) return;
    const entry = chapterMap.get(activeChapterId);
    if (!entry?.chapter?.fileName) return;
    const name = entry.chapter.fileName;
    const content = activeChapter?.content || '';
    if (!window.mana?.novel?.saveChapter) return;
    const key = `_save_${name}`;
    clearTimeout(window[key]);
    setSaveStatus('saving');
    try {
      const titleMatch = content.match(/^#\s+(.+)/);
      const chapTitle = titleMatch ? titleMatch[1].trim() : (entry.chapter._title || '');
      await window.mana.novel.saveChapter(activeNovelId, name, content, { title: chapTitle });
      setSaveStatus('saved');
      showSaveToast('success', '已保存到磁盘');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus('save-failed');
      const reason = err?.message || String(err);
      showSaveToast('error', `保存失败：${reason}`);
      console.error('[editor-save]', reason);
    }
  }, [activeChapterId, activeNovelId, activeChapter, chapterMap, showSaveToast]);

  const updateActiveChapterContent = (content) => {
    if (!activeChapterId) return;
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.map((c) =>
            c.id === activeChapterId ? { ...c, content } : c
          ),
        })),
      })),
    }));
    // Save to project file on disk (debounced per chapter)
    const chapterEntry = chapterMap.get(activeChapterId);
    if (chapterEntry?.chapter?.fileName && activeNovelId) {
      const name = chapterEntry.chapter.fileName;
      const key = `_save_${name}`;
      clearTimeout(window[key]);
      window[key] = setTimeout(async () => {
        if (window.mana?.novel?.saveChapter) {
          try {
            await window.mana.novel.saveChapter(activeNovelId, name, content);
            setSaveStatus(null);
          } catch {
            setSaveStatus('save-failed');
          }
        }
      }, 2000);
    }
  };

  // Save chapter before screen lock (visibilitychange → hidden)
  const saveContentRef = useRef('');
  useEffect(() => { saveContentRef.current = activeChapter?.content || ''; }, [activeChapter?.content]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      if (!activeNovelId || !activeChapterId) return;
      const chapterEntry = chapterMap.get(activeChapterId);
      if (!chapterEntry?.chapter?.fileName) return;
      const name = chapterEntry.chapter.fileName;
      const content = saveContentRef.current;
      if (!content) return;
      window.mana?.novel?.saveChapter(activeNovelId, name, content)
        .then(() => setSaveStatus(null))
        .catch(() => setSaveStatus('save-failed'));
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [activeNovelId, activeChapterId, chapterMap]);

  useEffect(() => {
    setEditorSelection({ text: '', start: 0, end: 0 });
    setEditorHasFocus(false);
    setEditorScroll({ top: 0, left: 0 });
  }, [activeChapterId]);

  useEffect(() => {
    const pending = pendingEditorSelectionRef.current;
    const textarea = editorTextareaRef.current;
    if (!pending || !textarea) return;
    pendingEditorSelectionRef.current = null;
    try {
      textarea.focus();
      textarea.setSelectionRange(pending.start, pending.end);
    } catch {
      // ignore DOM selection failures
    }
  }, [activeChapter?.content]);

  const handleTextSelect = (e) => {
    const target = e.target;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const text = target.value.substring(start, end);
    setEditorSelection({ text, start, end });
  };

  const overlaySelection = useMemo(() => {
    if (!activeChapter) return null;
    const current = activeChapter.content || '';
    const cachedText = String(editorSelection.text || '');
    if (!cachedText) return null;
    if (typeof editorSelection.start === 'number' && typeof editorSelection.end === 'number') {
      const slice = current.substring(editorSelection.start, editorSelection.end);
      if (editorSelection.end > editorSelection.start && slice === cachedText) {
        return { start: editorSelection.start, end: editorSelection.end, text: cachedText };
      }
    }
    const first = current.indexOf(cachedText);
    const last = current.lastIndexOf(cachedText);
    if (first >= 0 && first === last) {
      return { start: first, end: first + cachedText.length, text: cachedText };
    }
    return null;
  }, [activeChapter, editorSelection]);

  const resolveEditorSelectionRange = useCallback((mode = 'replace') => {
    if (!activeChapter) {
      throw new Error('当前没有打开的章节');
    }

    const current = activeChapter.content || '';
    const textarea = editorTextareaRef.current;
    if (textarea && typeof textarea.selectionStart === 'number' && typeof textarea.selectionEnd === 'number') {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = current.substring(start, end);
      if (mode === 'insert' || (end > start && text)) {
        return { start, end, text };
      }
    }

    const cached = editorSelection;
    const cachedText = String(cached.text || '');
    if (typeof cached.start === 'number' && typeof cached.end === 'number') {
      const slice = current.substring(cached.start, cached.end);
      if (mode === 'insert' || (cached.end > cached.start && slice === cachedText && cachedText)) {
        return { start: cached.start, end: cached.end, text: slice };
      }
    }

    if (mode === 'replace' && cachedText) {
      const first = current.indexOf(cachedText);
      const last = current.lastIndexOf(cachedText);
      if (first >= 0 && first === last) {
        return { start: first, end: first + cachedText.length, text: cachedText };
      }
    }

    if (mode === 'replace') {
      throw new Error('未找到稳定的选中文本，请重新选中后再让 AI 替换');
    }
    throw new Error('未找到稳定的光标位置，请重新聚焦编辑器后再试');
  }, [activeChapter, editorSelection]);

  const replaceSelectedText = (replacement) => {
    if (!activeChapterId || !activeChapter) throw new Error('当前没有打开的章节');
    const { start, end } = resolveEditorSelectionRange('replace');
    const current = activeChapter.content;
    const before = current.substring(0, start);
    const after = current.substring(end);
    const newContent = before + replacement + after;
    updateActiveChapterContent(newContent);
    const nextPos = start + replacement.length;
    pendingEditorSelectionRef.current = { start, end: nextPos };
    setEditorSelection({ text: '', start: nextPos, end: nextPos });
    return `Text replaced successfully (${end - start} chars)`;
  };

  const replaceTextNearCursor = (targetText, replacement) => {
    if (!activeChapterId || !activeChapter) throw new Error('当前没有打开的章节');
    const current = activeChapter.content || '';
    const needle = String(targetText || '');
    if (!needle) throw new Error('targetText 不能为空');

    const textarea = editorTextareaRef.current;
    const domStart = textarea && typeof textarea.selectionStart === 'number' ? textarea.selectionStart : null;
    const domEnd = textarea && typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : null;
    const selectedFromDom = domStart != null && domEnd != null ? current.substring(domStart, domEnd) : '';
    if (domStart != null && domEnd != null && domEnd > domStart && selectedFromDom === needle) {
      return replaceSelectedText(replacement);
    }

    const cached = editorSelection;
    const cachedText = String(cached.text || '');
    if (typeof cached.start === 'number' && typeof cached.end === 'number' && cached.end > cached.start) {
      const slice = current.substring(cached.start, cached.end);
      if (slice === cachedText && cachedText === needle) {
        const before = current.substring(0, cached.start);
        const after = current.substring(cached.end);
        const nextContent = before + replacement + after;
        updateActiveChapterContent(nextContent);
        const nextPos = cached.start + replacement.length;
        pendingEditorSelectionRef.current = { start: cached.start, end: nextPos };
        setEditorSelection({ text: '', start: nextPos, end: nextPos });
        return `Text replaced near cursor successfully (${cached.end - cached.start} chars)`;
      }
    }

    const matches = [];
    let cursor = 0;
    while (cursor <= current.length) {
      const index = current.indexOf(needle, cursor);
      if (index < 0) break;
      matches.push({ start: index, end: index + needle.length });
      cursor = index + needle.length;
    }
    if (!matches.length) {
      throw new Error('当前章节中找不到目标文本，请重新读取后再试');
    }
    if (matches.length === 1) {
      const only = matches[0];
      const before = current.substring(0, only.start);
      const after = current.substring(only.end);
      const nextContent = before + replacement + after;
      updateActiveChapterContent(nextContent);
      const nextPos = only.start + replacement.length;
      pendingEditorSelectionRef.current = { start: only.start, end: nextPos };
      setEditorSelection({ text: '', start: nextPos, end: nextPos });
      return `Text replaced near cursor successfully (${only.end - only.start} chars)`;
    }

    const anchor = domStart != null
      ? domStart
      : typeof cached.start === 'number'
        ? cached.start
        : null;
    if (anchor == null) {
      throw new Error('目标文本有多处命中，请先让用户把光标放到目标文本旁边，或直接选中后再试');
    }

    const distanceToRange = (range) => {
      if (anchor >= range.start && anchor <= range.end) return 0;
      return Math.min(Math.abs(anchor - range.start), Math.abs(anchor - range.end));
    };
    const ranked = matches
      .map((range) => ({ ...range, distance: distanceToRange(range) }))
      .sort((a, b) => a.distance - b.distance || a.start - b.start);
    const best = ranked[0];
    if (!best) {
      throw new Error('未能根据当前光标定位到目标文本');
    }
    if (ranked[1] && ranked[1].distance === best.distance) {
      throw new Error('当前光标附近仍有多个等距命中，请再把光标放近一点，或直接手动选中文本');
    }

    const before = current.substring(0, best.start);
    const after = current.substring(best.end);
    const nextContent = before + replacement + after;
    updateActiveChapterContent(nextContent);
    const nextPos = best.start + replacement.length;
    pendingEditorSelectionRef.current = { start: best.start, end: nextPos };
    setEditorSelection({ text: '', start: nextPos, end: nextPos });
    return `Text replaced near cursor successfully (${best.end - best.start} chars)`;
  };

  const insertTextAtCursor = (text) => {
    if (!activeChapterId || !activeChapter) throw new Error('当前没有打开的章节');
    const { start, end } = resolveEditorSelectionRange('insert');
    const current = activeChapter.content;
    const before = current.substring(0, start);
    const after = current.substring(end);
    const newContent = before + text + after;
    updateActiveChapterContent(newContent);
    const nextPos = start + text.length;
    pendingEditorSelectionRef.current = { start: nextPos, end: nextPos };
    setEditorSelection({ text: '', start: nextPos, end: nextPos });
    return `Text inserted successfully (${text.length} chars)`;
  };

  const editorContext = useMemo(() => {
    const base = {
      novelId: activeNovelId,
      selectedText: editorSelection.text,
      chapterCount: chapterEntries.length,
    };
    if (activeChapter) {
      return {
        ...base,
        type: 'chapter',
        title: activeChapter.fileName,
        chapterFileName: activeChapter.fileName,
        chapterDisplayName: activeChapter.displayName || activeChapter.fileName,
        content: activeChapter.content,
        chapterId: activeChapterId,
        selectionStart: editorSelection.start,
        selectionEnd: editorSelection.end,
      };
    }
    if (activeBlueprintId) {
      return { ...base, type: 'blueprint', title: `流程: ${activeBlueprintId}` };
    }
    if (activeSettingsId) {
      return { ...base, type: 'settings', title: `设置: ${activeSettingsId}` };
    }
    return { ...base, type: 'none', title: '' };
  }, [activeChapter, activeChapterId, activeBlueprintId, activeSettingsId, editorSelection, activeNovelId, chapterEntries]);

  const activeEditor = activeChapter
    ? {
        content: activeChapter.content,
        language: 'Markdown',
      }
    : {
    content: '',
    language: 'Plain Text',
  };

  return (
    <div className="flex h-screen w-screen bg-vscode-bg text-vscode-text overflow-hidden">
      
      {/* Activity Bar (Leftmost narrow sidebar) */}
      <div className="w-12 bg-vscode-activity-bar flex flex-col items-center py-2 justify-between border-r border-vscode-panel-border z-10">
        <div className="flex flex-col gap-2 w-full">
          <ActivityBarItem 
            icon={<FileText size={24} />} 
            active={activeSidebarItem === 'explorer'} 
            onClick={() => setActiveSidebarItem('explorer')} 
            label={t('app.explorer')}
          />
          <ActivityBarItem
            icon={<Search size={24} />}
            active={activeSidebarItem === 'search'}
            onClick={() => setActiveSidebarItem('search')}
            label={t('app.search')}
          />
          {/* NOTE: 源代码管理功能尚未完成，暂时隐藏 */}
          {/* <ActivityBarItem
            icon={<GitBranch size={24} />}
            active={activeSidebarItem === 'source-control'}
            onClick={() => setActiveSidebarItem('source-control')}
            label={t('app.sourceControl')}
          /> */}
          {/* NOTE: Pipeline 功能尚未完成，暂时隐藏 */}
          {/* <ActivityBarItem
            icon={<Play size={24} />}
            active={activeSidebarItem === 'pipeline'}
            onClick={() => setActiveSidebarItem('pipeline')}
            label="Pipeline"
          /> */}
        </div>
        <div className="flex flex-col gap-2 w-full mb-2">
          <ActivityBarItem
            icon={<Cpu size={24} />}
            active={activeEditorTab.startsWith(SETTINGS_PREFIX)}
            onClick={() => openSettingsInEditor('models')}
            label="模型配置"
          />
           <ActivityBarItem
            icon={<Settings size={24} />}
            active={activeSidebarItem === 'settings'}
            onClick={() => setActiveSidebarItem('settings')}
            label={t('app.settings')}
          />
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-64 bg-vscode-sidebar flex flex-col border-r border-vscode-panel-border">
        {activeSidebarItem === 'explorer' ? (
          <>
            {/* Top: Explorer (章节列表) */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="h-9 px-4 flex items-center text-xs font-bold tracking-wide uppercase text-gray-400">
                <span className="flex-1">{t('app.explorer')}</span>
                {activeNovelId && (
                  <button
                    type="button"
                    className="text-gray-500 hover:text-gray-200 text-[10px] px-1"
                    title="从磁盘刷新章节列表"
                    onClick={async () => {
                      const mana = window.mana;
                      if (!mana?.novel) return;
                      try {
                        const active = await mana.novel.active();
                        if (active) await syncNovelTreeFromDisk(active);
                      } catch {}
                    }}
                  >↻</button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-2 text-sm">
                <div className="font-bold mb-2 px-2 text-gray-400">{t('app.openEditors')}</div>
                {editorTabs.length === 0 ? (
                  <div className="px-2 py-1 text-gray-500">{t('app.noOpenEditors')}</div>
                ) : (
                  editorTabs.map((tab) => {
                    const tabIcon = tab.type === 'data'
                      ? { label: 'DATA', color: 'text-purple-400' }
                      : tab.type === 'blueprint'
                      ? { label: 'BP', color: 'text-purple-400' }
                      : tab.type === 'settings'
                      ? { label: 'SET', color: 'text-gray-400' }
                      : { label: 'MD', color: 'text-yellow-400' };
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        className={`w-full text-left px-2 py-1 cursor-pointer flex items-center gap-2 ${
                          tab.id === activeEditorTab ? 'bg-vscode-active-item text-white' : 'hover:bg-vscode-active-item'
                        }`}
                        onClick={() => setActiveEditorTab(tab.id)}
                      >
                        <span className={`${tabIcon.color} text-xs w-7 shrink-0 text-center`}>{tabIcon.label}</span>
                        <span className="truncate">{tab.title}</span>
                      </button>
                    );
                  })
                )}
                {/* NOTE: 写作流程 / Pipeline 编排功能尚未完成，暂时隐藏 */}
                {/*
                <div className="font-bold mt-4 mb-2 px-2 text-gray-400 flex items-center justify-between gap-2">
                  <span>写作流程</span>
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded bg-purple-800/90 text-[11px] text-white"
                    onClick={() => openBlueprintInEditor('default')}
                  >
                    打开蓝图
                  </button>
                </div>
                <div className="px-2 py-1 text-gray-500 text-xs mb-2">
                  拖拽节点编排Agent执行顺序
                </div>
                */}

                {!activeNovelId ? (
                  <div className="px-2 py-3 text-gray-500 text-xs text-center">
                    未打开小说项目
                    <div className="mt-1 text-gray-600 text-[10px]">
                      点击顶部「小说」按钮选择项目<br/>或点击「导入」导入外部小说
                    </div>
                    <button
                      type="button"
                      className="mt-2 px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px]"
                      onClick={async () => {
                        const mana = window.mana;
                        if (!mana?.fs) return;
                        try {
                          const dir = await mana.fs.pickDirectory({ title: '选择项目目录' });
                          if (!dir) return;
                          const title = dir.split(/[/\\]/).pop() || 'Untitled';
                          const r = await mana.novel.create({ title, dir });
                          if (r?.id) await mana.novel.open(r.id);
                        } catch (err) {
                          console.error('Create novel failed:', err);
                        }
                      }}
                    >
                      创建新项目
                    </button>
                  </div>
                ) : novel.volumes.length === 0 ? (
                  <div className="px-2 py-2 text-gray-500 text-xs text-center">
                    <div className="mb-1">{t('app.noVolumes')}</div>
                    <button
                      type="button"
                      className="text-blue-400 hover:text-blue-300 underline text-[10px]"
                      onClick={() => { loadExistingNovels(); setShowImportPanel(true); }}
                    >
                      点击导入外部小说添加章节
                    </button>
                  </div>
                ) : (
                  novel.volumes.map((volume) => (
                    <div key={volume.id} className="mb-1">
                      <div className="group flex items-center gap-1 pl-2 pr-1 py-1 hover:bg-vscode-active-item">
                        <span className="flex-1 text-left pl-2 pr-1 py-0.5 text-gray-300">{volume.name}</span>
                        <button
                          type="button"
                          className="text-gray-400 hover:text-white text-xs px-1"
                          title={t('app.newSection')}
                          onClick={(e) => { e.stopPropagation(); createSection(volume.id); }}
                        >+节</button>
                        <button
                          type="button"
                          className="text-gray-400 hover:text-white text-xs px-1"
                          title={t('app.renameVolume')}
                          onClick={(e) => { e.stopPropagation(); renameVolume(volume.id); }}
                        >✎</button>
                        <button
                          type="button"
                          className="text-gray-400 hover:text-red-300 text-xs px-1"
                          title={t('app.deleteVolume')}
                          onClick={(e) => { e.stopPropagation(); deleteVolume(volume.id); }}
                        >🗑</button>
                      </div>
                      {volume.sections.length === 0 ? (
                        <div className="pl-8 py-1 text-xs text-gray-500">{t('app.noSections')}</div>
                      ) : (
                        volume.sections.map((section) => (
                          <div key={section.id}>
                            <div className="group flex items-center gap-1 pl-6 pr-1 py-1 hover:bg-vscode-active-item">
                              <span className="flex-1 text-left pl-2 pr-1 py-0.5 text-gray-400">{section.name}</span>
                              <button
                                type="button"
                                className="text-gray-400 hover:text-white text-xs px-1"
                                title={t('app.newChapter')}
                                onClick={(e) => { e.stopPropagation(); createChapter(volume.id, section.id); }}
                              >+章</button>
                              <button
                                type="button"
                                className="text-gray-400 hover:text-white text-xs px-1"
                                title={t('app.renameSection')}
                                onClick={(e) => { e.stopPropagation(); renameSection(volume.id, section.id); }}
                              >✎</button>
                              <button
                                type="button"
                                className="text-gray-400 hover:text-red-300 text-xs px-1"
                                title={t('app.deleteSection')}
                                onClick={(e) => { e.stopPropagation(); deleteSection(volume.id, section.id); }}
                              >🗑</button>
                            </div>
                            {section.chapters.length === 0 ? (
                              <div className="pl-10 py-1 text-xs text-gray-500">{t('app.noChapters')}</div>
                            ) : (
                              section.chapters.map((chapter) => (
                                <div key={chapter.id} className="group flex items-center gap-1 pl-10 pr-1 py-1 hover:bg-vscode-active-item">
                                  <button
                                    type="button"
                                    className="flex-1 text-left pl-2 pr-1 py-0.5 cursor-pointer"
                                    onClick={() => openChapterInEditor(chapter.id)}
                                  >{chapter.displayName || chapter.fileName}</button>
                                  <button
                                    type="button"
                                    className="text-gray-400 hover:text-white text-xs px-1"
                                    title={t('app.renameChapter')}
                                    onClick={(e) => { e.stopPropagation(); renameChapter(chapter.id); }}
                                  >✎</button>
                                  <button
                                    type="button"
                                    className="text-gray-400 hover:text-red-300 text-xs px-1"
                                    title={t('app.deleteChapter')}
                                    onClick={(e) => { e.stopPropagation(); deleteChapter(chapter.id); }}
                                  >🗑</button>
                                </div>
                              ))
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  ))
                )}
              </div>
                {activeNovelId ? (
                  <NovelDataBrowser onOpenTab={openDataInEditor} />
                ) : null}
            </div>

            {/* Bottom: Outline (大纲) */}
            <div className="h-1/3 border-t border-vscode-panel-border flex flex-col min-h-0">
              <div className="h-9 px-4 flex items-center text-xs font-bold tracking-wide uppercase text-gray-400">
                {t('app.novelStructure')}
              </div>
              <div className="flex-1 overflow-y-auto p-2 text-sm">
                {activeChapter ? (
                  (() => {
                    const headings = parseMarkdownOutline(activeChapter.content);
                    if (headings.length === 0) {
                      return <div className="px-2 py-1 text-gray-500 text-xs">{t('app.noOutline')}</div>;
                    }
                    return (
                      <div className="space-y-0.5">
                        {headings.map((h, i) => (
                          <div
                            key={i}
                            className="text-gray-400 hover:text-white hover:bg-vscode-active-item px-2 py-0.5 rounded cursor-pointer truncate"
                            style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
                            title={h.text}
                          >
                            {h.text}
                          </div>
                        ))}
                      </div>
                    );
                  })()
                ) : (
                  <div className="px-2 py-1 text-gray-500 text-xs">{t('app.noActiveChapter')}</div>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="h-9 px-4 flex items-center text-xs font-bold tracking-wide uppercase text-gray-400">
              {activeSidebarItem === 'search' && t('app.search')}
              {activeSidebarItem === 'source-control' && t('app.sourceControl')}
              {activeSidebarItem === 'settings' && t('app.settings')}
              {activeSidebarItem === 'pipeline' && 'Pipeline'}
            </div>
            <div className="flex-1 overflow-y-auto">
              {activeSidebarItem === 'settings' && (
                <div className="text-sm px-2 py-2">
                  <AppSettingsPanel
                    onOpenInEditor={openSettingsInEditor}
                    activeSettingsId={activeSettingsId}
                  />
                </div>
              )}
              {activeSidebarItem === 'pipeline' && (
                <div className="text-sm p-2">
                  <PipelineRunnerPanel />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col bg-vscode-editor-bg min-w-0">
        
        {/* Tabs */}
        <div className="flex bg-vscode-sidebar border-b border-vscode-panel-border overflow-x-auto min-h-9">
            {editorTabs.map((tab) => (
              <TabItem
                key={tab.id}
                title={tab.title}
                active={tab.id === activeEditorTab}
                onClick={() => setActiveEditorTab(tab.id)}
                onClose={() => closeEditorTab(tab.id)}
              />
            ))}
            {editorTabs.length === 0 && (
              <div className="px-3 py-1.5 text-xs text-gray-500 flex items-center">
                {t('app.noOpenFiles')}
              </div>
            )}
            <div className="flex-1" />
            <div className="px-2 flex items-center gap-3 text-xs border-l border-vscode-panel-border shrink-0">
              <div className="shrink-0">
                <WorkspaceSwitcher onImportExternal={() => { loadExistingNovels(); setShowImportPanel(true); }} />
              </div>
              <div className="shrink-0 whitespace-nowrap">
                <RuntimeStatusIndicator />
              </div>
            </div>
            <button
              type="button"
              className={`px-3 text-xs flex items-center gap-1 border-l border-vscode-panel-border shrink-0 ${rightPanelOpen ? 'text-white bg-vscode-active-item' : 'text-gray-400 hover:text-gray-200'}`}
              onClick={() => setRightPanelOpen((v) => !v)}
              title={t('app.aiChat')}
            >
              <MessageSquare size={14} />
              <span className="hidden sm:inline">{t('app.aiChat')}</span>
            </button>
        </div>

        {/* Editor + Right Panel row */}
        <div className="flex-1 flex min-h-0">
          {/* Editor Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeEditorTab.startsWith(TAB_PREFIX) && activeChapter ? (
              <div className="flex flex-col h-full">
                <div className="relative flex-1 min-h-0 overflow-hidden">
                  {overlaySelection ? (
                    <div
                      data-editor-selection-overlay="visible"
                      className="absolute inset-0 pointer-events-none overflow-hidden"
                      aria-hidden="true"
                    >
                      <div
                        className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-sm leading-relaxed text-transparent"
                        style={{ transform: `translate(${-editorScroll.left}px, ${-editorScroll.top}px)` }}
                      >
                        {activeEditor.content.substring(0, overlaySelection.start)}
                        <span className="rounded-sm bg-blue-500/30 shadow-[0_0_0_1px_rgba(96,165,250,0.25)] text-transparent">
                          {activeEditor.content.substring(overlaySelection.start, overlaySelection.end)}
                        </span>
                        {activeEditor.content.substring(overlaySelection.end)}
                      </div>
                    </div>
                  ) : null}
                  <textarea
                    ref={editorTextareaRef}
                    className="relative z-10 flex-1 h-full w-full resize-none bg-transparent outline-none text-gray-300 leading-relaxed p-4 font-mono text-sm"
                    value={activeEditor.content}
                    onChange={(e) => updateActiveChapterContent(e.target.value)}
                    onSelect={handleTextSelect}
                    onClick={handleTextSelect}
                    onKeyUp={handleTextSelect}
                    onKeyDown={(e) => {
                      const isMac = navigator.platform.toLowerCase().includes('mac');
                      const modifier = isMac ? e.metaKey : e.ctrlKey;
                      if (modifier && e.key === 's') {
                        e.preventDefault();
                        manualSave();
                      }
                    }}
                    onFocus={() => setEditorHasFocus(true)}
                    onBlur={() => setEditorHasFocus(false)}
                    onScroll={(e) => setEditorScroll({ top: e.target.scrollTop, left: e.target.scrollLeft })}
                    placeholder={t('app.markdownInputPlaceholder')}
                  />
                </div>
                <div className="h-6 border-t border-vscode-panel-border flex items-center px-2 gap-2 shrink-0 bg-vscode-sidebar/50">
                  {saveStatus === 'save-failed' ? (
                    <span className="text-[10px] text-rose-400 flex items-center gap-1">
                      保存失败
                      <button
                        type="button"
                        onClick={async () => {
                          const entry = chapterMap.get(activeChapterId);
                          if (entry?.chapter?.fileName && activeNovelId) {
                            setSaveStatus('saving');
                            try {
                              const titleMatch = ((activeChapter.content) || '').match(/^#\s+(.+)/);
                              const chapTitle = titleMatch ? titleMatch[1].trim() : (entry.chapter._title || '');
                              await window.mana.novel.saveChapter(activeNovelId, entry.chapter.fileName, activeChapter.content, { title: chapTitle });
                              setSaveStatus('saved');
                              setTimeout(() => setSaveStatus(null), 2000);
                            } catch { setSaveStatus('save-failed'); }
                          }
                        }}
                        className="text-blue-400 hover:text-blue-300 underline"
                      >重试</button>
                    </span>
                  ) : saveStatus === 'saving' ? (
                    <span className="text-[10px] text-gray-500">保存中…</span>
                  ) : saveStatus === 'saved' ? (
                    <span className="text-[10px] text-green-400">已保存到磁盘</span>
                  ) : null}
                  <div className="flex-1" />
                  <span className="text-[10px] text-gray-500">字数 {getChapterWordCount(activeEditor.content)}</span>
                  <span className="text-[9px] text-gray-600">自动保存至项目文件</span>
                </div>
              </div>
            ) : activeEditorTab.startsWith(BLUEPRINT_PREFIX) && activeBlueprintId ? (
              <BlueprintEditor dagId={activeBlueprintId} />
            ) : activeEditorTab.startsWith(SETTINGS_PREFIX) && activeSettingsId ? (
              <SettingsTabContent settingsId={activeSettingsId} />
            ) : activeEditorTab.startsWith(DATA_PREFIX) ? (
              <DataTabContent dataType={activeEditorTab.slice(DATA_PREFIX.length)} novelId={activeNovelId} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-500">
                {!activeNovelId ? (
                  <div className="text-center space-y-2">
                    <div className="text-base text-gray-400">欢迎使用小说写作助手</div>
                    <div className="text-xs text-gray-600">
                      在左侧项目栏点击「打开已有项目」导入小说目录<br/>
                      或点击「导入」导入外部小说文件（.md / .txt / .epub）
                    </div>
                  </div>
                ) : (
                  <span className="italic">{t('app.selectOrOpenFile')}</span>
                )}
              </div>
            )}
          </div>

          {/* Right AI Chat Panel */}
          <div
            className={`relative border-l border-vscode-panel-border flex flex-col bg-vscode-panel-bg transition-[width] duration-200 overflow-hidden ${rightPanelOpen ? 'shrink-0' : 'w-0'}`}
            style={rightPanelOpen ? { width: `${rightPanelWidth}px` } : undefined}
          >
            {rightPanelOpen && (
              <div
                className="absolute inset-y-0 left-0 z-20 flex w-3 -translate-x-1/2 cursor-col-resize items-center justify-center touch-none"
                onPointerDown={startResizeRightPanel}
                onPointerEnter={() => setIsRightPanelResizeHover(true)}
                onPointerLeave={() => setIsRightPanelResizeHover(false)}
                title="拖拽调整宽度"
              >
                <div
                  className={`h-full w-px transition-all duration-150 ${isRightPanelResizing ? 'bg-blue-300 shadow-[0_0_0_1px_rgba(147,197,253,0.45)]' : isRightPanelResizeHover ? 'bg-blue-400/80 shadow-[0_0_0_1px_rgba(96,165,250,0.25)]' : 'bg-vscode-panel-border/80'}`}
                />
                <div
                  className={`pointer-events-none absolute left-1/2 top-1/2 h-12 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-150 ${isRightPanelResizing ? 'bg-blue-400/70 shadow-[0_0_12px_rgba(96,165,250,0.35)]' : isRightPanelResizeHover ? 'bg-blue-400/45' : 'bg-transparent'}`}
                />
              </div>
            )}
            <div className="h-8 border-b border-vscode-panel-border flex items-center px-3 justify-between shrink-0">
              <span className="text-xs font-bold text-gray-400">{t('app.aiChat')}</span>
              <button
                type="button"
                className="text-gray-400 hover:text-white text-xs px-1"
                onClick={() => setRightPanelOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <AiChatPanel
                editorContext={editorContext}
                onReplaceSelectedText={replaceSelectedText}
                onReplaceTextNearCursor={replaceTextNearCursor}
                onInsertTextAtCursor={insertTextAtCursor}
              />
            </div>
          </div>
        </div>

      </div>

      <ToolConfirmationModal />

      {showSyncDialog && (
        <OfflineSyncDialog
          novelId={syncNovelId}
          onClose={() => setShowSyncDialog(false)}
        />
      )}

      {showImportPanel && (
        <ImportNovelPanel
          isOpen={showImportPanel}
          onClose={() => setShowImportPanel(false)}
          existingNovels={existingNovels}
          activeNovelId={''}
          onImportComplete={(result) => {
            console.log('[App] import complete', result);
            if (result?.chapters?.length > 0) {
              const chapters = result.chapters.map((ch, i) => ({
                id: `chapter-imported-${i}-${Date.now()}`,
                fileName: `${ch.title || `chapter${i + 1}`}.md`,
                content: ch.content || '',
              }));
              const newNovel = {
                volumes: [{
                  id: `volume-imported-${Date.now()}`,
                  name: '卷1',
                  sections: [{
                    id: `section-imported-${Date.now()}`,
                    name: '节1',
                    chapters,
                  }],
                }],
              };
              saveNovelTree(newNovel);
              setNovel(newNovel);
            }
          }}
          onEnterMergeMode={(importId, novelId) => {
            setMergePanel({ importId, novelId });
          }}
        />
      )}

      {mergePanel && (
        <ImportMergePanel
          importId={mergePanel.importId}
          novelId={mergePanel.novelId}
          onClose={() => setMergePanel(null)}
        />
      )}

      {/* Save toast notification */}
      {saveToast && (
        <div className="fixed bottom-4 right-4 z-[9999] animate-fade-in-up">
          <div className={`rounded px-3 py-2 text-xs shadow-lg border ${
            saveToast.type === 'success'
              ? 'border-emerald-500/30 bg-emerald-900/80 text-emerald-200'
              : 'border-rose-500/30 bg-rose-900/80 text-rose-200'
          }`}>
            {saveToast.message}
          </div>
        </div>
      )}

    </div>
  );
}

function ActivityBarItem({ icon, active, onClick, label }) {
    return (
        <div 
            onClick={onClick}
            className={`cursor-pointer p-3 w-full flex justify-center border-l-2 ${active ? 'border-white text-white' : 'border-transparent text-gray-500 hover:text-white'}`}
            title={label}
        >
            {icon}
        </div>
    )
}

function TabItem({ title, active, onClick, onClose }) {
    return (
        <div
            onClick={onClick}
            className={`px-3 py-1.5 min-w-[120px] flex items-center gap-2 border-r border-vscode-panel-border cursor-pointer text-sm ${active ? 'bg-vscode-editor-bg text-white border-t-2 border-t-blue-500' : 'bg-vscode-sidebar text-gray-400 hover:bg-[#2a2d2e]'}`}
        >
            <span className="truncate">{title}</span>
            {active && (
              <button
                type="button"
                className="ml-auto hover:bg-gray-600 rounded-full w-4 h-4 flex items-center justify-center text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose?.();
                }}
                aria-label={`Close ${title}`}
              >
                ×
              </button>
            )}
        </div>
    )
}

export default App;

function SettingsTabContent({ settingsId }) {
  switch (settingsId) {
    case 'language':
      return (
        <div className="h-full overflow-y-auto p-6">
          <LanguageSettings />
        </div>
      );
    case 'runtime':
      return (
        <div className="h-full overflow-y-auto p-6">
          <RuntimeDriverSettings />
        </div>
      );
    case 'subagent':
      return (
        <div className="h-full overflow-hidden">
          <SubagentEditor />
        </div>
      );
    case 'dag':
      return (
        <div className="h-full overflow-hidden">
          <DagEditor />
        </div>
      );
    case 'config-helper':
      return (
        <div className="h-full overflow-hidden">
          <ConfigHelperChat />
        </div>
      );
    case 'models':
      return (
        <div className="h-full overflow-hidden">
          <ProviderSettingsPanel />
        </div>
      );
    case 'storage':
      return (
        <div className="h-full overflow-y-auto p-6">
          <StorageSettings />
        </div>
      );
    case 'search':
      return (
        <div className="h-full overflow-y-auto p-6">
          <SearchSettings />
        </div>
      );
    case 'skill':
      return (
        <div className="h-full overflow-y-auto p-6">
          <SkillSettings />
        </div>
      );
    default:
      return (
        <div className="flex items-center justify-center h-full text-gray-500 italic">
          未知设置: {settingsId}
        </div>
      );
  }
}
