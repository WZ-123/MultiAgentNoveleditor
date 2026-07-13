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
import { createRemoteAIClient } from '@/services/remoteAI.js';
import { SubagentEditor } from '@/components/SubagentEditor.jsx';
import { DagEditor } from '@/components/DagEditor.jsx';
import { ConfigHelperChat } from '@/components/ConfigHelperChat.jsx';
import { AiChatPanel } from '@/components/AiChatPanel.jsx';
import { LanguageSettings } from '@/components/LanguageSettings.jsx';
import { StorageSettings } from '@/components/StorageSettings.jsx';
import { SearchSettings } from '@/components/SearchSettings.jsx';
import { SkillSettings } from '@/components/SkillSettings.jsx';
import { WritingSettings } from '@/components/WritingSettings.jsx';
import { LanRemoteSettings } from '@/components/LanRemoteSettings.jsx';
import { ChapterEditor } from '@/components/ChapterEditor.jsx';
import { OfflineSyncDialog } from '@/components/OfflineSyncDialog.jsx';
import { ImportNovelPanel } from '@/components/ImportNovelPanel.jsx';
import { ImportMergePanel } from '@/components/ImportMergePanel.jsx';
import { SearchPanel } from '@/components/SearchPanel.jsx';
import { NovelDataBrowser } from '@/components/NovelDataBrowser.jsx';
import { DataTabContent } from '@/components/DataTabContent.jsx';
import { countMeaningfulCharacters } from '@/domain/text.js';
import { collectPreferredTextMatches } from '@/domain/textMatch.js';
import { assessDeAiMinimality, minimalityRetryInstruction } from '@/services/deAiMinimality.mjs';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import DiffMatchPatch from 'diff-match-patch';

const TAB_PREFIX = 'chapter:';
const BLUEPRINT_PREFIX = 'blueprint:';
const SETTINGS_PREFIX = 'settings:';
const DATA_PREFIX = 'data:'; // character, world, outline, timeline, style
const DEFAULT_RIGHT_PANEL_WIDTH = 640;
const MIN_RIGHT_PANEL_WIDTH = 420;
const FIXED_LEFT_CHROME_WIDTH = 48 + 256;
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'mana-right-panel-width-v1';
const EDITOR_CONTEXT_MENU_WIDTH = 220;
const diffMatchPatch = new DiffMatchPatch();
const makeId = (prefix) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function editorDeAiReferenceSamples(content, range, maxSamples = 4) {
  const text = String(content || '').replace(/\r\n/gu, '\n');
  const start = Number.isFinite(Number(range?.start)) ? Number(range.start) : -1;
  const end = Number.isFinite(Number(range?.end)) ? Number(range.end) : start;
  if (!text || start < 0 || end < start) return [];
  const toParagraphs = (value) => value.split(/\n\s*\n/gu)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12 && !/^#{1,6}\s/u.test(item));
  const before = toParagraphs(text.slice(0, start)).slice(-2);
  const after = toParagraphs(text.slice(end)).slice(0, 2);
  return [...before, ...after].filter((item, index, list) => list.indexOf(item) === index).slice(0, maxSamples);
}

function editorDeAiCharacterVoices(characters, contextText, maxCharacters = 5) {
  const haystack = String(contextText || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
  return (Array.isArray(characters) ? characters : []).filter((character) => {
    const names = [character?.name, ...(Array.isArray(character?.aliases) ? character.aliases : [])]
      .map((item) => String(item || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN'))
      .filter((item) => item.length >= 2);
    return names.some((name) => haystack.includes(name));
  }).slice(0, maxCharacters).map((character) => ({
    name: character.name || character.id || '',
    personality: String(character.personality || '').slice(0, 500),
    speechStyle: String(character.speechStyle || character.attributes?.语言特点 || '').slice(0, 500),
    quotes: String(character.quotes || '').slice(0, 500),
  })).filter((item) => item.name && (item.personality || item.speechStyle || item.quotes));
}

const EDITOR_AI_ACTIONS = {
  rewrite: {
    label: 'AI 重写选中段落',
    requiresSelection: true,
    mode: 'replace',
    instruction: '重写选中文本：保持事实、人物关系和剧情推进不变，提升小说正文的自然度、节奏和画面感。避免 AI 八股句式、空泛总结和解释型旁白。只输出改写后的正文，不要解释。',
  },
  expand: {
    label: '扩写选中文本',
    requiresSelection: true,
    mode: 'replace',
    instruction: '扩写选中文本：保留原有剧情含义，把场面、动作、感官细节或人物反应写得更充分，篇幅约为原文 1.5 到 2 倍。不要新增会改变后续剧情的大事件。只输出扩写后的正文，不要解释。',
  },
  shorten: {
    label: '缩写选中文本',
    requiresSelection: true,
    mode: 'replace',
    instruction: '缩写选中文本：保留必要信息、情绪和剧情功能，删去重复解释、空泛修饰和拖慢节奏的句子，篇幅约为原文 50% 到 70%。只输出缩写后的正文，不要解释。',
  },
  deAi: {
    label: '去 AI 味润色',
    requiresSelection: true,
    mode: 'replace',
    instruction: '只对选中文本做最小必要的去 AI 味修改。删除或压缩「不是……而是……」「那是一种……」「仿佛……」「空气中弥漫着……」等机械模板，但不要新增原文没有的动作、对白、景物、感官、心理、比喻或情绪解释；保留原有短句、停顿、留白、粗粝感和不规则节奏，不强求优美或圆润。若没有明确问题，原样输出。只输出处理后的正文，不要解释。',
  },
  strongerScene: {
    label: '增强现场感',
    requiresSelection: true,
    mode: 'replace',
    instruction: '改写选中文本：增强现场感和可读性，优先加入角色动作、视线、对白、环境反馈和节奏变化；不要写成设定说明或作者总结。只输出改写后的正文，不要解释。',
  },
  continue: {
    label: '在光标处续写',
    requiresSelection: false,
    mode: 'insert',
    instruction: '在光标处续写小说正文：承接前文语气、人物状态和当前场景，写一到三段自然衔接的内容。不要重复光标前已有文字，不要解释，只输出要插入的续写正文。',
  },
};

const EDITOR_AI_SYSTEM_PROMPT = '你是中文小说正文编辑助手。输出必须是可直接粘贴进正文的简体中文小说内容；标点使用全角中文标点（，。！？：；、“”‘’（）《》——）；不要输出标题、列表、解释、前后缀说明或 Markdown 围栏。';

function clampRightPanelWidth(width) {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const availableWidth = Math.max(0, viewportWidth - FIXED_LEFT_CHROME_WIDTH);
  const minWidth = Math.min(MIN_RIGHT_PANEL_WIDTH, availableWidth);
  const maxWidth = Math.max(minWidth, Math.min(Math.floor(viewportWidth * 0.75), availableWidth));
  return Math.min(Math.max(width, minWidth), maxWidth);
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

function extractChapterHeadingTitle(content) {
  const match = String(content || '').match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : '';
}

function resolveChapterTitle({ metadataTitle, content, fallbackTitle } = {}) {
  const explicitTitle = String(metadataTitle || '').trim();
  if (explicitTitle) return explicitTitle;
  const headingTitle = extractChapterHeadingTitle(content);
  if (headingTitle) return headingTitle;
  return String(fallbackTitle || '').trim();
}

function getChapterSaveTitle(chapter, content) {
  return resolveChapterTitle({
    content,
    fallbackTitle: chapter?._title || '',
  });
}

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
  const hasInitializedActiveNovelRef = useRef(false);

  const resetNovelUiState = useCallback((clearCache = false) => {
    setNovel({ volumes: [] });
    setOpenChapterIds([]);
    setOpenBlueprintIds([]);
    setOpenSettingsIds([]);
    setActiveEditorTab('');
    if (clearCache) {
      try { localStorage.removeItem('mana-chapters-v1'); } catch { /* ignore */ }
    }
  }, []);

  const applySavedChapterSnapshot = useCallback((chapterId, snapshot, options = {}) => {
    if (!chapterId || !snapshot) return;
    const { content, isContentLoaded, isDirty = false } = options;
    setNovel((currentNovel) => ({
      ...currentNovel,
      volumes: currentNovel.volumes.map((volume) => ({
        ...volume,
        sections: volume.sections.map((section) => ({
          ...section,
          chapters: section.chapters.map((chapter) => {
            if (chapter.id !== chapterId) return chapter;
            const next = {
              ...chapter,
              isDirty,
              _title: snapshot.title || '',
              displayName: snapshot.displayName || chapter.displayName || chapter.fileName,
              volume: snapshot.volume ?? chapter.volume ?? null,
              section: snapshot.section ?? chapter.section ?? null,
            };
            if (typeof content === 'string') {
              next.content = content;
              next.lastSavedContent = content;
            }
            if (typeof isContentLoaded === 'boolean') next.isContentLoaded = isContentLoaded;
            return next;
          }),
        })),
      })),
    }));
  }, []);

  const refreshAllChapterDisplayNames = useCallback(async (novelId, baseNovel) => {
    const sourceNovel = baseNovel || novel;
    const chapters = [];
    sourceNovel.volumes.forEach((volume) => {
      volume.sections.forEach((section) => {
        section.chapters.forEach((chapter) => {
          chapters.push(chapter);
        });
      });
    });
    if (!novelId || !window.mana?.novel?.computeChapterDisplayName || chapters.length === 0) return;

    const sortedChapters = [...chapters].sort((a, b) => (a.fileName || '').localeCompare(b.fileName || ''));
    const displayNames = await Promise.all(sortedChapters.map((chapter, index) =>
      window.mana.novel.computeChapterDisplayName(novelId, index + 1, chapter._title || '')
    ));
    const byId = new Map(sortedChapters.map((chapter, index) => [chapter.id, displayNames[index] || chapter.displayName || chapter.fileName]));

    setNovel((currentNovel) => ({
      ...currentNovel,
      volumes: currentNovel.volumes.map((volume) => ({
        ...volume,
        sections: volume.sections.map((section) => ({
          ...section,
          chapters: section.chapters.map((chapter) => ({
            ...chapter,
            displayName: byId.get(chapter.id) || chapter.displayName || chapter.fileName,
          })),
        })),
      })),
    }));
  }, [novel]);

  // Sync the novel tree (volumes/sections/chapters) from the project directory on disk
  async function syncNovelTreeFromDisk(novelEntry) {
    if (!novelEntry?.dir || !window.mana) return;
    try {
      const chapterMetaEntries = await window.mana.novel.listChapterMetas(novelEntry.id);

      const chapters = (chapterMetaEntries || [])
        .filter(Boolean)
        .sort((a, b) => a.fileName.localeCompare(b.fileName))
        .map((chapterMeta, index) => {
          return {
            id: `ch-${chapterMeta.fileName}-${Date.now()}-${index}`,
            fileName: chapterMeta.fileName,
            content: '',
            lastSavedContent: '',
            isContentLoaded: false,
            isDirty: false,
            _title: resolveChapterTitle({ metadataTitle: chapterMeta.title }),
            displayName: chapterMeta.displayName || chapterMeta.fileName,
            volume: chapterMeta.volume,
            section: chapterMeta.section,
          };
        });

      // Compute correct display names immediately (listChapterMetas doesn't
      // include displayName, so we'd otherwise show raw filenames until
      // refreshAllChapterDisplayNames runs).
      if (chapters.length > 0 && window.mana?.novel?.computeChapterDisplayName) {
        const sorted = [...chapters].sort((a, b) => (a.fileName || '').localeCompare(b.fileName || ''));
        const displayNames = await Promise.all(sorted.map((ch, i) =>
          window.mana.novel.computeChapterDisplayName(novelEntry.id, i + 1, ch._title || '')
        ));
        const byId = new Map(sorted.map((ch, i) => [ch.id, displayNames[i] || ch.displayName]));
        for (const ch of chapters) {
          const dn = byId.get(ch.id);
          if (dn) ch.displayName = dn;
        }
      }

      if (chapters.length > 0) {
        // Restore volume/section structure from novel.json
        let structure = null;
        try {
          if (novelEntry?.dir) {
            const raw = await window.mana.fs.readFile(novelEntry.dir + '/novel.json', 'utf8');
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

  const refreshActiveNovelState = useCallback(async (novelEntry, options = {}) => {
    if (!window.mana?.novel?.active) return null;
    try {
      const activeEntry = novelEntry === undefined
        ? await window.mana.novel.active()
        : novelEntry;
      const nextId = activeEntry?.id || '';
      if (nextId === activeNovelId && !options.forceReload) {
        return activeEntry || null;
      }

      setActiveNovelId(nextId);
      if (!nextId) {
        resetNovelUiState(true);
        return null;
      }

      if (nextId !== activeNovelId || options.resetUi) {
        resetNovelUiState(false);
      }
      await syncNovelTreeFromDisk(activeEntry);
      return activeEntry;
    } catch (err) {
      console.error('[App] refresh active novel failed', err);
      return null;
    }
  }, [activeNovelId, resetNovelUiState]);

  // Detect active novel once on startup/login. Subsequent changes are pushed
  // explicitly by create/open/close/import flows instead of polling every 3s.
  useEffect(() => {
    if (hasInitializedActiveNovelRef.current) return undefined;
    hasInitializedActiveNovelRef.current = true;
    let cancelled = false;
    (async () => {
      const activeEntry = await refreshActiveNovelState();
      if (cancelled || !activeEntry) return;
    })();
    return () => { cancelled = true; };
  }, [refreshActiveNovelState]);

  useEffect(() => {
    if (!window.mana?.novel?.onActiveChanged) return undefined;
    const off = window.mana.novel.onActiveChanged((payload) => {
      refreshActiveNovelState(payload?.entry ?? null, { forceReload: true }).catch((err) => {
        console.error('[App] active novel push refresh failed', err);
      });
      loadExistingNovels();
    });
    return () => {
      try { off(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshActiveNovelState]);

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

  // Reverse map: fileName → chapterId for search navigation
  const fileNameToChapterId = useMemo(() => {
    const m = {};
    for (const [id, entry] of chapterMap) {
      if (entry.chapter.fileName) m[entry.chapter.fileName] = id;
    }
    return m;
  }, [chapterMap]);

  const ensureChapterContentLoaded = useCallback(async (chapterId) => {
    const entry = chapterMap.get(chapterId);
    if (!entry?.chapter?.fileName) return '';
    if (entry.chapter.isContentLoaded) return entry.chapter.content || '';
    if (!activeNovelId || !window.mana?.novel?.readChapter) return entry.chapter.content || '';

    const content = await window.mana.novel.readChapter(activeNovelId, entry.chapter.fileName);
    setNovel((currentNovel) => ({
      ...currentNovel,
      volumes: currentNovel.volumes.map((volume) => ({
        ...volume,
        sections: volume.sections.map((section) => ({
          ...section,
          chapters: section.chapters.map((chapter) => {
            if (chapter.id !== chapterId) return chapter;
            const nextTitle = resolveChapterTitle({
              content,
              fallbackTitle: chapter._title || '',
            });
            let nextDisplayName = chapter.displayName || chapter.fileName;
            if (nextTitle) {
              if (/[:：]/.test(nextDisplayName)) nextDisplayName = nextDisplayName.replace(/[:：].*$/, `：${nextTitle}`);
              else if (nextDisplayName !== nextTitle) nextDisplayName = `${nextDisplayName}：${nextTitle}`;
            }
            return {
              ...chapter,
              content: content || '',
              lastSavedContent: content || '',
              isContentLoaded: true,
              isDirty: false,
              _title: nextTitle,
              displayName: nextDisplayName,
            };
          }),
        })),
      })),
    }));

    return content || '';
  }, [activeNovelId, chapterMap]);

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
        const content = await mana.novel.readChapter(activeEntry.id, data.name);
        const title = resolveChapterTitle({
          metadataTitle: meta?.title || meta?.metadata?.title || data.title,
          content,
          fallbackTitle: existing?.chapter?._title || '',
        });
        const sorted = [...new Set([...chapterEntries.map(e => e.chapter.fileName), data.name])].sort((a, b) => a.localeCompare(b));
        const seq = sorted.indexOf(data.name) + 1;
        const displayName = await mana.novel.computeChapterDisplayName(activeEntry.id, seq, title);
        const nextChapter = {
          id: existing?.chapter?.id || `ch-${data.name}-${Date.now()}`,
          fileName: data.name,
          content: content || '',
          lastSavedContent: content || '',
          isContentLoaded: true,
          isDirty: false,
          _title: title,
          displayName,
          volume: meta?.volume ?? meta?.metadata?.volume ?? null,
          section: meta?.section ?? meta?.metadata?.section ?? null,
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
          const nextNovel = { ...prev, volumes };
          refreshAllChapterDisplayNames(activeEntry.id, nextNovel).catch(() => {});
          return nextNovel;
        });
      } catch (err) {
        console.error('[App] incremental chapter sync failed:', err);
      }
    });
    return cleanup;
  }, [chapterEntries, refreshAllChapterDisplayNames]);

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
    const labels = { characters: '角色卡', assets: '资产/物品', world: '世界观', timeline: '时间线', outline: '大纲', style: '文风' };
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
        case 'models': return '模型中心';
        case 'storage': return '存储空间';
        case 'writing': return '写作设置';
        case 'lan-remote': return '局域网遥控';
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

  const openChapterInEditor = async (chapterId, jump = null) => {
    if (!chapterMap.get(chapterId)) return;
    await ensureChapterContentLoaded(chapterId);
    setOpenChapterIds((ids) => (ids.includes(chapterId) ? ids : [...ids, chapterId]));
    setActiveEditorTab(`${TAB_PREFIX}${chapterId}`);
    if (jump && Number.isFinite(jump.startOffset)) {
      const start = jump.startOffset;
      const end = Number.isFinite(jump.endOffset) ? jump.endOffset : start;
      setPendingEditorJump({ chapterId, start, end, nonce: Date.now() });
      setEditorJumpStatus(`已跳转到搜索命中 ${start}-${end}`);
      setTimeout(() => setEditorJumpStatus(''), 3500);
    }
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
      lastSavedContent: '',
      isContentLoaded: true,
      isDirty: false,
    };

    const nextNovel = {
      ...novel,
      volumes: novel.volumes.map((volume) => {
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
    };

    setNovel(() => nextNovel);
    refreshAllChapterDisplayNames(activeNovelId, nextNovel).catch(() => {});
    setOpenChapterIds((ids) => (ids.includes(chapter.id) ? ids : [...ids, chapter.id]));
    setActiveEditorTab(`${TAB_PREFIX}${chapter.id}`);
    // Persist: write empty file to disk
    if (activeNovelId && window.mana?.novel?.saveChapter) {
      window.mana.novel.saveChapter(activeNovelId, fileName, '', {}, { createRevision: false }).catch(() => {});
    }
  };
  
  const closeEditorTab = (tabId) => {
    if (tabId.startsWith(TAB_PREFIX)) {
      const chapterId = tabId.slice(TAB_PREFIX.length);
      // Flush save before closing
      const chapterEntry = chapterMap.get(chapterId);
      if (chapterEntry?.chapter?.fileName && activeNovelId && window.mana?.novel?.saveChapter) {
        const ch = chapterEntry.chapter;
        if (ch.isContentLoaded && ch.isDirty) {
          const chapTitle = getChapterSaveTitle(ch, ch.content);
          window.mana.novel.saveChapter(activeNovelId, ch.fileName, ch.content, { title: chapTitle }, {
            baseContent: ch.lastSavedContent ?? '',
            source: 'manual',
            revisionLabel: '关闭标签页前保存',
            createRevision: true,
          })
            .then((saved) => applySavedChapterSnapshot(chapterId, saved, { content: ch.content, isContentLoaded: true, isDirty: false }))
            .catch(() => {});
        }
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
    const updated = {
      ...novel,
      volumes: novel.volumes.filter((v) => v.id !== volumeId),
    };
    setNovel(updated);
    syncStructureToMeta(updated);
    refreshAllChapterDisplayNames(activeNovelId, updated).catch(() => {});
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
    const updated = {
      ...novel,
      volumes: novel.volumes.map((v) =>
        v.id !== volumeId
          ? v
          : {
              ...v,
              sections: v.sections.filter((s) => s.id !== sectionId),
            }
      ),
    };
    setNovel(updated);
    syncStructureToMeta(updated);
    refreshAllChapterDisplayNames(activeNovelId, updated).catch(() => {});
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
      try {
        const content = await ensureChapterContentLoaded(chapterId);
        window.mana?.novel?.saveChapter(activeNovelId, chapter.fileName, content, { title: raw }, {
          baseContent: chapter.lastSavedContent ?? content,
          source: 'manual',
          revisionLabel: '更新章节标题',
          createRevision: true,
        })
          .then((saved) => applySavedChapterSnapshot(chapterId, saved, { content, isContentLoaded: true, isDirty: false }))
          .catch(() => {});
      } catch {
        // ignore eager title persistence failures
      }
    }
  };

  const deleteChapter = (chapterId) => {
    const entry = chapterMap.get(chapterId);
    const chapter = entry?.chapter;
    if (!chapter) return;
    const confirmText = t('app.deleteChapterConfirm').replace('{name}', chapter.fileName);
    const ok = window.confirm(confirmText);
    if (!ok) return;

    const updated = {
      ...novel,
      volumes: novel.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.filter((c) => c.id !== chapterId),
        })),
      })),
    };
    setNovel(updated);
    refreshAllChapterDisplayNames(activeNovelId, updated).catch(() => {});
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
  const [editorContextMenu, setEditorContextMenu] = useState(null);
  const [editorAiStatus, setEditorAiStatus] = useState(null);
  const [editorAiPreview, setEditorAiPreview] = useState(null);
  const [saveConflict, setSaveConflict] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chapterRevisions, setChapterRevisions] = useState([]);
  const [selectedRevision, setSelectedRevision] = useState(null);
  const [revisionPreview, setRevisionPreview] = useState(null);
  const [historyStatus, setHistoryStatus] = useState('');
  const [pendingEditorJump, setPendingEditorJump] = useState(null);
  const [editorJumpStatus, setEditorJumpStatus] = useState('');
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
  const chapterEditorRef = useRef(null);
  const pendingEditorSelectionRef = useRef(null);

  const showSaveToast = useCallback((type, message) => {
    setSaveToast({ type, message });
    setTimeout(() => setSaveToast(null), 3000);
  }, []);

  const saveChapterContentToDisk = useCallback(async (chapterId, content, options = {}) => {
    if (!chapterId || !activeNovelId) return null;
    const entry = chapterMap.get(chapterId);
    if (!entry?.chapter?.fileName || !window.mana?.novel?.saveChapter) return null;
    const name = entry.chapter.fileName;
    const chapTitle = getChapterSaveTitle(entry.chapter, content);
    const source = options.source || 'manual';
    const baseContent = Object.prototype.hasOwnProperty.call(options, 'baseContent')
      ? options.baseContent
      : (entry.chapter.lastSavedContent ?? '');
    try {
      const saved = await window.mana.novel.saveChapter(
        activeNovelId,
        name,
        content,
        { title: chapTitle },
        {
          baseContent,
          source,
          revisionLabel: options.revisionLabel || (source === 'autosave' ? '自动保存' : '手动保存'),
          createRevision: options.createRevision !== false,
          verifiedContentHash: options.verifiedContentHash || undefined,
        }
      );
      applySavedChapterSnapshot(chapterId, saved, { content, isContentLoaded: true, isDirty: false });
      return saved;
    } catch (err) {
      const reason = err?.message || String(err);
      if (/snapshot mismatch/i.test(reason)) {
        let diskContent = '';
        try {
          diskContent = await window.mana.novel.readChapter(activeNovelId, name);
        } catch {
          diskContent = '';
        }
        setSaveConflict({
          chapterId,
          name,
          localContent: content,
          diskContent,
          baseContent,
          message: '磁盘上的章节已变化，请选择如何处理。',
        });
      }
      throw err;
    }
  }, [activeNovelId, chapterMap, applySavedChapterSnapshot]);

  const flushActiveChapterToDisk = useCallback(async ({ silent = false } = {}) => {
    if (!activeChapterId || !activeNovelId) return;
    const entry = chapterMap.get(activeChapterId);
    if (!entry?.chapter?.fileName) return;
    if (!entry.chapter.isContentLoaded || !entry.chapter.isDirty) {
      if (!silent) setSaveStatus(null);
      return;
    }
    const name = entry.chapter.fileName;
    const content = activeChapter?.content || '';
    if (!window.mana?.novel?.saveChapter) return;
    const key = `_save_${name}`;
    clearTimeout(window[key]);
    if (!silent) setSaveStatus('saving');
    try {
      await saveChapterContentToDisk(activeChapterId, content, {
        source: silent ? 'autosave' : 'manual',
        revisionLabel: silent ? '自动保存' : '手动保存',
      });
      if (!silent) {
        setSaveStatus('saved');
        showSaveToast('success', '已保存到磁盘');
        setTimeout(() => setSaveStatus(null), 2000);
      } else {
        setSaveStatus(null);
      }
    } catch (err) {
      setSaveStatus('save-failed');
      const reason = err?.message || String(err);
      if (!silent) showSaveToast('error', `保存失败：${reason}`);
      console.error('[editor-save]', reason);
      throw err;
    }
  }, [activeChapterId, activeNovelId, activeChapter, chapterMap, showSaveToast, saveChapterContentToDisk]);

  const manualSave = useCallback(async () => {
    try {
      await flushActiveChapterToDisk();
    } catch (err) {
      // flushActiveChapterToDisk already reported the save failure.
    }
  }, [flushActiveChapterToDisk]);

  const updateActiveChapterContent = (content, { scheduleSave = true } = {}) => {
    if (!activeChapterId) return;
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.map((c) =>
            c.id === activeChapterId ? { ...c, content, isContentLoaded: true, isDirty: true } : c
          ),
        })),
      })),
    }));
    // Save to project file on disk (debounced per chapter)
    const chapterEntry = chapterMap.get(activeChapterId);
    if (scheduleSave && chapterEntry?.chapter?.fileName && activeNovelId) {
      const name = chapterEntry.chapter.fileName;
      const key = `_save_${name}`;
      clearTimeout(window[key]);
      window[key] = setTimeout(async () => {
        if (window.mana?.novel?.saveChapter) {
          try {
            await saveChapterContentToDisk(activeChapterId, content, {
              source: 'autosave',
              revisionLabel: '自动保存',
              baseContent: chapterEntry.chapter.lastSavedContent ?? '',
            });
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
      if (!chapterEntry.chapter.isContentLoaded || !chapterEntry.chapter.isDirty) return;
      const name = chapterEntry.chapter.fileName;
      const content = saveContentRef.current;
      if (!content) return;
      saveChapterContentToDisk(activeChapterId, content, {
        source: 'autosave',
        revisionLabel: '自动保存',
        baseContent: chapterEntry.chapter.lastSavedContent ?? '',
      })
        .then(() => {
          setSaveStatus(null);
        })
        .catch(() => setSaveStatus('save-failed'));
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [activeNovelId, activeChapterId, chapterMap, saveChapterContentToDisk]);

  useEffect(() => {
    setEditorSelection({ text: '', start: 0, end: 0 });
    setEditorHasFocus(false);
    setEditorScroll({ top: 0, left: 0 });
    setEditorAiPreview(null);
    setSaveConflict(null);
    setHistoryOpen(false);
    setChapterRevisions([]);
    setSelectedRevision(null);
    setRevisionPreview(null);
    setEditorJumpStatus('');
  }, [activeChapterId]);

  useEffect(() => {
    const pending = pendingEditorSelectionRef.current;
    const editor = chapterEditorRef.current;
    if (!pending || !editor) return;
    pendingEditorSelectionRef.current = null;
    try {
      editor.focus();
      editor.setSelectionRange(pending.start, pending.end);
    } catch {
      // ignore DOM selection failures
    }
  }, [activeChapter?.content]);

  const handleEditorSelection = (selection) => {
    const start = Number.isFinite(selection?.start) ? selection.start : 0;
    const end = Number.isFinite(selection?.end) ? selection.end : start;
    setEditorSelection({ text: String(selection?.text || ''), start, end });
  };

  const handleTextSelect = (e) => {
    const target = e.target;
    if (!target || typeof target.selectionStart !== 'number') return;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const text = target.value.substring(start, end);
    setEditorSelection({ text, start, end });
  };

  useEffect(() => {
    if (!editorContextMenu) return undefined;
    const close = () => setEditorContextMenu(null);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [editorContextMenu]);

  // Global keyboard shortcut: Ctrl+F / Cmd+F to open search sidebar
  // Intercepts even when editor textarea is focused (overrides browser "find in page")
  useEffect(() => {
    const onKeyDown = (e) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (modifier && e.key === 'f') {
        e.preventDefault();
        setActiveSidebarItem('search');
        // Auto-focus the search input after React renders
        requestAnimationFrame(() => {
          document.getElementById('search-input')?.focus();
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openEditorContextMenu = useCallback((event, selectionInfo = null) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectionInfo) handleEditorSelection(selectionInfo);
    else handleTextSelect(event);
    const fallback = selectionInfo || editorSelection;
    const start = Number.isFinite(fallback?.start) ? fallback.start : 0;
    const end = Number.isFinite(fallback?.end) ? fallback.end : start;
    const selectedText = String(fallback?.text || '');
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - EDITOR_CONTEXT_MENU_WIDTH - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - 260));
    setEditorContextMenu({
      x,
      y,
      hasSelection: end > start && !!selectedText.trim(),
      start,
      end,
    });
  }, [editorSelection]);

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
    const editorRange = chapterEditorRef.current?.getSelectionRange?.();
    if (editorRange && typeof editorRange.start === 'number' && typeof editorRange.end === 'number') {
      const start = editorRange.start;
      const end = editorRange.end;
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

  const resolveVerifiedPreviewRange = (rangeOverride, current, mode) => {
    const start = Number(rangeOverride?.expectedStart);
    const end = Number(rangeOverride?.expectedEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end < start || end > current.length) throw new Error('已验证预览的编辑范围无效，请重新生成预览');
    const expectedText = String(rangeOverride?.expectedText || '');
    if (current.substring(start, end) !== expectedText) throw new Error('章节内容或目标范围在确认前已变化，请重新生成预览');
    if (mode === 'replace' && end <= start) throw new Error('已验证预览没有稳定的选中文本，请重新选择后再试');
    return { start, end, text: expectedText };
  };

  const replaceSelectedText = (replacement, rangeOverride = null) => {
    if (!activeChapterId || !activeChapter) throw new Error('当前没有打开的章节');
    const current = activeChapter.content;
    const { start, end } = resolveVerifiedPreviewRange(rangeOverride, current, 'replace') || resolveEditorSelectionRange('replace');
    const before = current.substring(0, start);
    const after = current.substring(end);
    const newContent = before + replacement + after;
    updateActiveChapterContent(newContent);
    const nextPos = start + replacement.length;
    pendingEditorSelectionRef.current = { start, end: nextPos };
    setEditorSelection({ text: '', start: nextPos, end: nextPos });
    return `Text replaced successfully (${end - start} chars)`;
  };

  const replaceTextNearCursor = (targetText, replacement, rangeOverride = null) => {
    if (!activeChapterId || !activeChapter) throw new Error('当前没有打开的章节');
    const current = activeChapter.content || '';
    const needle = String(targetText || '');
    if (!needle) throw new Error('targetText 不能为空');

    const verifiedRange = resolveVerifiedPreviewRange(rangeOverride, current, 'replace');
    if (verifiedRange) {
      const nextContent = current.substring(0, verifiedRange.start) + replacement + current.substring(verifiedRange.end);
      updateActiveChapterContent(nextContent);
      const nextPos = verifiedRange.start + replacement.length;
      pendingEditorSelectionRef.current = { start: verifiedRange.start, end: nextPos };
      setEditorSelection({ text: '', start: nextPos, end: nextPos });
      return `Text replaced near cursor successfully (${verifiedRange.end - verifiedRange.start} chars)`;
    }

    const selectionCoversTarget = (selectedText) => {
      const text = String(selectedText || '');
      if (!text) return false;
      const preferred = collectPreferredTextMatches(text, needle);
      return preferred.matches.length === 1
        && preferred.matches[0].start === 0
        && preferred.matches[0].end === text.length;
    };

    const editorRange = chapterEditorRef.current?.getSelectionRange?.();
    const domStart = editorRange && typeof editorRange.start === 'number' ? editorRange.start : null;
    const domEnd = editorRange && typeof editorRange.end === 'number' ? editorRange.end : null;
    const selectedFromDom = domStart != null && domEnd != null ? current.substring(domStart, domEnd) : '';
    if (domStart != null && domEnd != null && domEnd > domStart && selectionCoversTarget(selectedFromDom)) {
      return replaceSelectedText(replacement);
    }

    const cached = editorSelection;
    const cachedText = String(cached.text || '');
    if (typeof cached.start === 'number' && typeof cached.end === 'number' && cached.end > cached.start) {
      const slice = current.substring(cached.start, cached.end);
      if (slice === cachedText && selectionCoversTarget(cachedText)) {
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

    const matches = collectPreferredTextMatches(current, needle).matches;
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

  const insertTextAtCursor = (text, rangeOverride = null) => {
    if (!activeChapterId || !activeChapter) throw new Error('当前没有打开的章节');
    const current = activeChapter.content;
    const { start, end } = resolveVerifiedPreviewRange(rangeOverride, current, 'insert') || resolveEditorSelectionRange('insert');
    const before = current.substring(0, start);
    const after = current.substring(end);
    const newContent = before + text + after;
    updateActiveChapterContent(newContent);
    const nextPos = start + text.length;
    pendingEditorSelectionRef.current = { start: nextPos, end: nextPos };
    setEditorSelection({ text: '', start: nextPos, end: nextPos });
    return `Text inserted successfully (${text.length} chars)`;
  };

  const loadEditorDeAiBaseline = useCallback(async (range) => {
    const current = activeChapter?.content || '';
    const contextText = current.substring(Math.max(0, range.start - 1800), Math.min(current.length, range.end + 900));
    const [styleResult, charactersResult] = await Promise.allSettled([
      activeNovelId && window.mana?.novel?.readStyleMemory
        ? window.mana.novel.readStyleMemory(activeNovelId)
        : Promise.resolve(''),
      activeNovelId && window.mana?.novel?.listCharacters
        ? window.mana.novel.listCharacters(activeNovelId)
        : Promise.resolve([]),
    ]);
    const fullStyleMemory = styleResult.status === 'fulfilled' ? String(styleResult.value || '') : '';
    const styleMemory = fullStyleMemory.length > 6000
      ? `[仅载入最近的文风记忆]\n${fullStyleMemory.slice(-6000)}`
      : fullStyleMemory;
    const characters = charactersResult.status === 'fulfilled' ? charactersResult.value : [];
    const referenceSamples = editorDeAiReferenceSamples(current, range);
    return {
      styleMemory,
      characterVoices: editorDeAiCharacterVoices(characters, contextText),
      referenceSamples,
      dialogueSamples: referenceSamples.filter((item) => /^[“"「『]/u.test(item) || /[”"」』]$/u.test(item)),
      povRule: '保持选中文本当前的人称和视角距离，不切换 POV，也不替 POV 人物解释其未明确表达的心理。',
      rhythmRule: '以前后文和作者当前保留段落的句长、停顿与段落疏密为准，保留粗粝、跳跃、留白和不规则节奏。',
    };
  }, [activeChapter, activeNovelId]);

  const buildEditorAiUserPrompt = useCallback((action, range, customInstruction = '', deAiBaseline = null) => {
    const current = activeChapter?.content || '';
    const before = current.substring(Math.max(0, range.start - 1800), range.start);
    const after = current.substring(range.end, Math.min(current.length, range.end + 900));
    const selectedText = current.substring(range.start, range.end);
    const instruction = customInstruction || action.instruction;
    const lines = [
      instruction,
      '',
      `当前章节：${activeChapter?.displayName || activeChapter?.fileName || '未命名章节'}`,
    ];
    if (deAiBaseline) {
      lines.push('', '作品与人物基线（只读软参考，不得复制原句）：');
      if (deAiBaseline.styleMemory) lines.push('', '文风记忆：', deAiBaseline.styleMemory);
      if (deAiBaseline.characterVoices?.length) lines.push('', `人物声音基线：${JSON.stringify(deAiBaseline.characterVoices)}`);
      if (deAiBaseline.referenceSamples?.length) lines.push('', '作者当前保留的相邻段落：', deAiBaseline.referenceSamples.join('\n\n'));
      if (deAiBaseline.dialogueSamples?.length) lines.push('', '本章既有对白样本：', deAiBaseline.dialogueSamples.join('\n'));
      lines.push('', `POV：${deAiBaseline.povRule}`, `场景节奏：${deAiBaseline.rhythmRule}`);
    }
    if (before) lines.push('', '光标/选区前文：', before);
    if (selectedText) lines.push('', '选中文本：', selectedText);
    if (after) lines.push('', '选区/光标后文：', after);
    return lines.join('\n');
  }, [activeChapter]);

  const cleanEditorAiOutput = (text) => {
    let output = String(text || '').trim();
    output = output.replace(/^```(?:\w+)?\s*/u, '').replace(/\s*```$/u, '').trim();
    return output;
  };

  const buildDiffParts = (before, after) => {
    const diffs = diffMatchPatch.diff_main(String(before || ''), String(after || ''));
    diffMatchPatch.diff_cleanupSemantic(diffs);
    return diffs.map(([kind, text], index) => ({ id: `${index}-${kind}`, kind, text }));
  };

  const runEditorAiAction = useCallback(async (actionId, customInstruction = '') => {
    const action = EDITOR_AI_ACTIONS[actionId];
    if (!action || !activeChapter) return;
    setEditorContextMenu(null);
    let range;
    try {
      range = resolveEditorSelectionRange(action.mode === 'insert' ? 'insert' : 'replace');
      if (action.requiresSelection && !String(range.text || '').trim()) {
        throw new Error('请先选中需要处理的文本');
      }
    } catch (err) {
      showSaveToast('error', err?.message || String(err));
      return;
    }

    setEditorAiStatus(action.label);
    try {
      await flushActiveChapterToDisk({ silent: true });
      const client = createRemoteAIClient();
      const deAiBaseline = actionId === 'deAi' ? await loadEditorDeAiBaseline(range) : null;
      const userPrompt = buildEditorAiUserPrompt(action, range, customInstruction, deAiBaseline);
      const callEditorAgent = (prompt) => client.completeForAgent(
        actionId === 'deAi' ? 'de_ai_rewrite' : (action.mode === 'insert' ? 'chapter_draft' : 'agent5'),
        [
          { role: 'system', content: EDITOR_AI_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        { expectJson: false }
      );
      let result = await callEditorAgent(userPrompt);
      let output = cleanEditorAiOutput(result);
      let minimality = null;
      if (actionId === 'deAi') {
        minimality = assessDeAiMinimality(range.text || '', output, { guidance: customInstruction || action.instruction });
        if (!minimality.ok) {
          result = await callEditorAgent(`${userPrompt}\n\n${minimalityRetryInstruction(minimality)}`);
          output = cleanEditorAiOutput(result);
          minimality = assessDeAiMinimality(range.text || '', output, { guidance: customInstruction || action.instruction });
        }
        if (!minimality.ok) {
          throw new Error(`两版候选都偏离最小必要修改原则：${minimality.violations.map((item) => item.label).join('；')}`);
        }
      }
      if (!output) throw new Error('AI 没有返回可插入的正文');
      const current = activeChapter.content || '';
      const insertionPoint = action.mode === 'insert' ? range.end : range.start;
      const safeStart = Math.max(0, Math.min(insertionPoint, current.length));
      const safeEnd = action.mode === 'insert'
        ? safeStart
        : Math.max(safeStart, Math.min(range.end, current.length));
      if (action.mode !== 'insert' && current.substring(safeStart, safeEnd) !== range.text) {
        throw new Error('选中文本已变化，请重新选中后再试');
      }
      const previewId = makeId('editor-ai-preview');
      const candidateContent = current.substring(0, safeStart) + output + current.substring(safeEnd);
      const preview = {
        id: previewId,
        actionId,
        actionLabel: action.label,
        mode: action.mode,
        range: { start: safeStart, end: safeEnd, text: range.text || '' },
        original: action.mode === 'insert' ? '' : current.substring(safeStart, safeEnd),
        output,
        minimality,
        customInstruction,
        baseContent: current,
        verification: { status: 'running', checks: [], issues: [], blockingCount: 0, contentHash: '' },
      };
      setEditorAiPreview(preview);
      const verification = await window.mana?.novel?.verifyChapterContent?.(activeNovelId, {
        name: activeChapter.fileName,
        displayName: activeChapter.displayName || activeChapter.fileName,
        title: getChapterSaveTitle(activeChapter, candidateContent),
        content: candidateContent,
        userText: customInstruction || action.instruction,
        editorContext: {
          type: 'chapter',
          novelId: activeNovelId,
          chapterFileName: activeChapter.fileName,
          title: activeChapter.displayName || activeChapter.fileName,
          selectedText: range.text || '',
        },
      });
      const finalVerification = verification || {
        status: 'blocked',
        checks: [],
        issues: [{ severity: 'blocking', summary: '严格验证服务不可用。' }],
        blockingCount: 1,
        contentHash: '',
      };
      setEditorAiPreview((currentPreview) => currentPreview?.id === previewId
        ? { ...currentPreview, verification: finalVerification }
        : currentPreview);
      if (finalVerification.status === 'passed' && Number(finalVerification.blockingCount || 0) === 0) {
        showSaveToast('success', `${action.label}已生成并通过严格验证`);
      } else {
        showSaveToast('error', `${action.label}预览未通过严格验证，已禁止写入`);
      }
    } catch (err) {
      showSaveToast('error', `${action.label}失败：${err?.message || String(err)}`);
    } finally {
      setEditorAiStatus(null);
    }
  }, [
    activeChapter,
    activeNovelId,
    buildEditorAiUserPrompt,
    flushActiveChapterToDisk,
    loadEditorDeAiBaseline,
    resolveEditorSelectionRange,
    showSaveToast,
  ]);

  const runCustomEditorAiAction = useCallback(async () => {
    const instruction = await window.mana?.prompt?.show?.('告诉 AI 如何处理选中文本:', '改得更有张力，但保持剧情不变');
    if (instruction == null || !instruction.trim()) return;
    await runEditorAiAction('rewrite', `按用户要求处理选中文本：${instruction.trim()}。只输出处理后的正文，不要解释。`);
  }, [runEditorAiAction]);

  const acceptEditorAiPreview = useCallback(async () => {
    if (!editorAiPreview || !activeChapterId || !activeChapter) return;
    const { range, output, mode, actionLabel } = editorAiPreview;
    const current = activeChapter.content || '';
    const start = Math.max(0, Math.min(range.start, current.length));
    const end = mode === 'insert'
      ? start
      : Math.max(start, Math.min(range.end, current.length));
    if (mode !== 'insert' && current.substring(start, end) !== range.text) {
      showSaveToast('error', '原文已变化，请重新生成 AI 预览');
      return;
    }
    const nextContent = current.substring(0, start) + output + current.substring(end);
    let verification = editorAiPreview.verification || null;
    if (current !== editorAiPreview.baseContent || verification?.status !== 'passed' || Number(verification?.blockingCount || 0) > 0) {
      setEditorAiPreview((preview) => preview ? { ...preview, baseContent: current, verification: { ...(preview.verification || {}), status: 'running' } } : preview);
      try {
        verification = await window.mana?.novel?.verifyChapterContent?.(activeNovelId, {
          name: activeChapter.fileName,
          displayName: activeChapter.displayName || activeChapter.fileName,
          title: getChapterSaveTitle(activeChapter, nextContent),
          content: nextContent,
          userText: editorAiPreview.customInstruction || editorAiPreview.actionLabel || '编辑器 AI 章节变更',
          editorContext: {
            type: 'chapter',
            novelId: activeNovelId,
            chapterFileName: activeChapter.fileName,
            title: activeChapter.displayName || activeChapter.fileName,
            selectedText: range.text || '',
          },
        });
      } catch (err) {
        verification = {
          status: 'blocked', checks: [], blockingCount: 1, contentHash: '',
          issues: [{ severity: 'blocking', summary: err?.message || String(err) }],
        };
      }
      setEditorAiPreview((preview) => preview ? { ...preview, baseContent: current, verification } : preview);
    }
    if (verification?.status !== 'passed' || Number(verification?.blockingCount || 0) > 0 || !verification?.contentHash) {
      showSaveToast('error', '严格验证未通过，章节内容保持不变');
      return;
    }
    const nextPos = start + output.length;
    setSaveStatus('saving');
    try {
      await saveChapterContentToDisk(activeChapterId, nextContent, {
        source: 'ai',
        revisionLabel: actionLabel || 'AI 修改',
        baseContent: current,
        verifiedContentHash: verification.contentHash,
      });
      pendingEditorSelectionRef.current = mode === 'insert'
        ? { start: nextPos, end: nextPos }
        : { start, end: nextPos };
      setEditorSelection({ text: '', start: nextPos, end: nextPos });
      setSaveStatus('saved');
      showSaveToast('success', `${actionLabel || 'AI 修改'}已应用并保存`);
      setTimeout(() => setSaveStatus(null), 2000);
      setEditorAiPreview(null);
    } catch (err) {
      setSaveStatus('save-failed');
      showSaveToast('error', `AI 修改保存失败：${err?.message || String(err)}`);
    }
  }, [activeChapter, activeChapterId, activeNovelId, editorAiPreview, saveChapterContentToDisk, showSaveToast]);

  const regenerateEditorAiPreview = useCallback(async () => {
    if (!editorAiPreview) return;
    await runEditorAiAction(editorAiPreview.actionId, editorAiPreview.customInstruction || '');
  }, [editorAiPreview, runEditorAiAction]);

  const openChapterHistory = useCallback(async () => {
    if (!activeNovelId || !activeChapter?.fileName || !window.mana?.novel?.listChapterRevisions) return;
    setHistoryOpen(true);
    setHistoryStatus('加载历史中...');
    setSelectedRevision(null);
    setRevisionPreview(null);
    try {
      const revisions = await window.mana.novel.listChapterRevisions(activeNovelId, activeChapter.fileName);
      setChapterRevisions(Array.isArray(revisions) ? revisions : []);
      setHistoryStatus(revisions?.length ? '' : '暂无历史记录');
    } catch (err) {
      setHistoryStatus(err?.message || String(err));
    }
  }, [activeChapter?.fileName, activeNovelId]);

  const selectChapterRevision = useCallback(async (revision) => {
    if (!activeNovelId || !activeChapter?.fileName || !revision?.id) return;
    setSelectedRevision(revision);
    setHistoryStatus('读取版本中...');
    try {
      const detail = await window.mana.novel.readChapterRevision(activeNovelId, activeChapter.fileName, revision.id);
      setRevisionPreview(detail);
      setHistoryStatus('');
    } catch (err) {
      setHistoryStatus(err?.message || String(err));
    }
  }, [activeChapter?.fileName, activeNovelId]);

  const restoreSelectedRevision = useCallback(async () => {
    if (!activeNovelId || !activeChapterId || !activeChapter?.fileName || !selectedRevision?.id) return;
    setHistoryStatus('恢复中...');
    try {
      const restored = await window.mana.novel.restoreChapterRevision(activeNovelId, activeChapter.fileName, selectedRevision.id);
      applySavedChapterSnapshot(activeChapterId, restored, {
        content: restored.content || '',
        isContentLoaded: true,
        isDirty: false,
      });
      setHistoryStatus('已恢复并保存');
      showSaveToast('success', '已恢复历史版本');
      await openChapterHistory();
    } catch (err) {
      setHistoryStatus(err?.message || String(err));
    }
  }, [activeChapter?.fileName, activeChapterId, activeNovelId, applySavedChapterSnapshot, openChapterHistory, selectedRevision?.id, showSaveToast]);

  const useDiskConflictVersion = useCallback(() => {
    if (!saveConflict) return;
    const diskContent = saveConflict.diskContent || '';
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.map((c) =>
            c.id === saveConflict.chapterId
              ? { ...c, content: diskContent, lastSavedContent: diskContent, isContentLoaded: true, isDirty: false }
              : c
          ),
        })),
      })),
    }));
    setSaveConflict(null);
    setSaveStatus(null);
    showSaveToast('success', '已使用磁盘版本');
  }, [saveConflict, showSaveToast]);

  const keepLocalConflictVersion = useCallback(async () => {
    if (!saveConflict) return;
    setSaveStatus('saving');
    try {
      await saveChapterContentToDisk(saveConflict.chapterId, saveConflict.localContent || '', {
        source: 'manual',
        revisionLabel: '冲突后保留本地版本',
        baseContent: saveConflict.diskContent || '',
      });
      setSaveConflict(null);
      setSaveStatus('saved');
      showSaveToast('success', '已保存本地版本');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus('save-failed');
      showSaveToast('error', `冲突处理失败：${err?.message || String(err)}`);
    }
  }, [saveChapterContentToDisk, saveConflict, showSaveToast]);

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
    <div
      className="flex w-screen bg-vscode-bg text-vscode-text overflow-hidden"
      style={{
        height: 'var(--mana-app-height, 100dvh)',
        boxSizing: 'border-box',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      
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
            onClick={() => {
              setActiveSidebarItem('settings');
              if (window.innerWidth < 1100) setRightPanelOpen(false);
            }}
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
                          if (r?.id) {
                            await mana.novel.open(r.id);
                            await refreshActiveNovelState();
                          }
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
                                    data-testid="chapter-tree-item"
                                    data-chapter-file={chapter.fileName}
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
              {activeSidebarItem === 'source-control' && t('app.sourceControl')}
              {activeSidebarItem === 'settings' && t('app.settings')}
              {activeSidebarItem === 'pipeline' && 'Pipeline'}
            </div>
            <div className="flex-1 overflow-y-auto">
              {activeSidebarItem === 'search' && (
                <SearchPanel
                  novelId={activeNovelId}
                  onOpenChapter={(fileName, jump) => {
                    const id = fileNameToChapterId[fileName];
                    if (id) {
                      openChapterInEditor(id, jump || null);
                    }
                  }}
                  onOpenCharacter={(id) => openDataInEditor('character', id)}
                  onOpenAsset={() => openDataInEditor('assets')}
                  onSwitchSidebar={() => setActiveSidebarItem('explorer')}
                />
              )}
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
        <div className="flex bg-vscode-sidebar border-b border-vscode-panel-border min-h-9 min-w-0 overflow-hidden">
          <div className="flex flex-1 min-w-0 overflow-x-auto overflow-y-hidden" data-testid="editor-tab-strip">
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
          </div>
          <div className="flex shrink-0 border-l border-vscode-panel-border bg-vscode-sidebar" data-testid="editor-fixed-actions">
            <div className="px-2 flex items-center gap-3 text-xs shrink-0">
              <div className="shrink-0">
                <WorkspaceSwitcher onImportExternal={() => { loadExistingNovels(); setShowImportPanel(true); }} onActiveNovelChanged={refreshActiveNovelState} />
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
        </div>

        {/* Editor + Right Panel row */}
        <div className="flex-1 flex min-h-0">
          {/* Editor Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeEditorTab.startsWith(TAB_PREFIX) && activeChapter ? (
              <div className="flex flex-col h-full">
                <div className="relative flex-1 min-h-0 overflow-hidden">
                  <ChapterEditor
                    ref={chapterEditorRef}
                    value={activeEditor.content}
                    placeholder={t('app.markdownInputPlaceholder')}
                    onChange={(nextContent) => updateActiveChapterContent(nextContent)}
                    onSelectionChange={handleEditorSelection}
                    onContextMenu={openEditorContextMenu}
                    onScroll={(scroll) => setEditorScroll(scroll)}
                    onSaveShortcut={manualSave}
                    jumpRange={pendingEditorJump?.chapterId === activeChapterId ? pendingEditorJump : null}
                  />
                  {overlaySelection ? (
                    <div
                      data-editor-selection-overlay="visible"
                      className="pointer-events-none absolute right-3 top-3 rounded border border-blue-400/40 bg-blue-500/15 px-2 py-1 text-[11px] text-blue-100 shadow-lg"
                    >
                      已选中 {overlaySelection.text.length} 字
                    </div>
                  ) : null}
                  {editorContextMenu ? (
                    <div
                      className="fixed z-50 w-[220px] overflow-hidden rounded border border-vscode-panel-border bg-[#252526] py-1 text-xs text-gray-200 shadow-2xl"
                      style={{ left: editorContextMenu.x, top: editorContextMenu.y }}
                      onPointerDown={(e) => e.stopPropagation()}
                      role="menu"
                    >
                      {[
                        'rewrite',
                        'expand',
                        'shorten',
                        'deAi',
                        'strongerScene',
                      ].map((actionId) => {
                        const action = EDITOR_AI_ACTIONS[actionId];
                        const disabled = editorAiStatus || (action.requiresSelection && !editorContextMenu.hasSelection);
                        return (
                          <button
                            key={actionId}
                            type="button"
                            className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${disabled ? 'cursor-not-allowed text-gray-500' : 'hover:bg-vscode-active-item hover:text-white'}`}
                            disabled={!!disabled}
                            onClick={() => runEditorAiAction(actionId)}
                          >
                            <span>{action.label}</span>
                          </button>
                        );
                      })}
                      <div className="my-1 h-px bg-vscode-panel-border" />
                      <button
                        type="button"
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${editorAiStatus ? 'cursor-not-allowed text-gray-500' : 'hover:bg-vscode-active-item hover:text-white'}`}
                        disabled={!!editorAiStatus}
                        onClick={() => runEditorAiAction('continue')}
                      >
                        <span>{EDITOR_AI_ACTIONS.continue.label}</span>
                      </button>
                      <button
                        type="button"
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${editorAiStatus || !editorContextMenu.hasSelection ? 'cursor-not-allowed text-gray-500' : 'hover:bg-vscode-active-item hover:text-white'}`}
                        disabled={!!editorAiStatus || !editorContextMenu.hasSelection}
                        onClick={runCustomEditorAiAction}
                      >
                        <span>自定义 AI 修改...</span>
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="h-6 border-t border-vscode-panel-border flex items-center px-2 gap-2 shrink-0 bg-vscode-sidebar/50">
                  {editorAiStatus ? (
                    <span className="text-[10px] text-blue-300">{editorAiStatus}中...</span>
                  ) : null}
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
                              await saveChapterContentToDisk(activeChapterId, activeChapter.content, {
                                source: 'manual',
                                revisionLabel: '重试保存',
                              });
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
                  {editorJumpStatus ? (
                    <span className="text-[10px] text-blue-300">{editorJumpStatus}</span>
                  ) : null}
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => openChapterHistory()}
                    className="text-[10px] text-gray-400 hover:text-gray-200 underline"
                  >
                    历史
                  </button>
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
                onBeforeSendMessage={() => flushActiveChapterToDisk({ silent: true })}
              />
            </div>
          </div>
        </div>

      </div>

      <ToolConfirmationModal />

      {editorAiPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" data-testid="editor-ai-preview">
          <div className="flex max-h-[82vh] w-[min(920px,96vw)] flex-col overflow-hidden rounded border border-vscode-panel-border bg-[#1e1e1e] shadow-2xl">
            <div className="flex items-center justify-between border-b border-vscode-panel-border px-4 py-2">
              <div>
                <div className="text-sm font-semibold text-gray-100">{editorAiPreview.actionLabel}预览</div>
                <div className="text-[11px] text-gray-500">确认后才会写入正文并保存</div>
              </div>
              <button type="button" className="text-gray-400 hover:text-white" onClick={() => setEditorAiPreview(null)}>×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 text-xs leading-relaxed">
              <div className="mb-2 text-gray-400">差异预览</div>
              <div className="whitespace-pre-wrap rounded border border-vscode-panel-border bg-black/20 p-3 font-mono text-gray-300">
                {buildDiffParts(editorAiPreview.original, editorAiPreview.output).map((part) => (
                  <span
                    key={part.id}
                    className={part.kind === 1 ? 'bg-green-500/20 text-green-200' : part.kind === -1 ? 'bg-rose-500/20 text-rose-200 line-through' : ''}
                  >
                    {part.text}
                  </span>
                ))}
              </div>
              <div data-testid="editor-ai-strict-verification" className={`mt-3 rounded border px-3 py-2 ${editorAiPreview.verification?.status === 'passed' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : editorAiPreview.verification?.status === 'running' ? 'border-sky-500/30 bg-sky-500/10 text-sky-200' : 'border-rose-500/30 bg-rose-500/10 text-rose-200'}`}>
                严格验证：{editorAiPreview.verification?.status === 'running' ? '进行中' : editorAiPreview.verification?.status === 'passed' ? '通过' : '未通过，禁止写入'}
                {Array.isArray(editorAiPreview.verification?.issues) && editorAiPreview.verification.issues.length > 0 && (
                  <div className="mt-1 space-y-1 text-[11px]">
                    {editorAiPreview.verification.issues.slice(0, 6).map((issue, index) => <div key={`${issue.id || 'issue'}-${index}`}>{issue.summary || '验证问题'}</div>)}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-vscode-panel-border px-4 py-3">
              <button type="button" className="rounded border border-vscode-panel-border px-3 py-1 text-xs text-gray-300 hover:bg-vscode-active-item" onClick={() => navigator.clipboard?.writeText(editorAiPreview.output || '')}>复制结果</button>
              <button type="button" className="rounded border border-vscode-panel-border px-3 py-1 text-xs text-gray-300 hover:bg-vscode-active-item" onClick={regenerateEditorAiPreview} disabled={!!editorAiStatus}>重新生成</button>
              <button type="button" className="rounded border border-vscode-panel-border px-3 py-1 text-xs text-gray-300 hover:bg-vscode-active-item" onClick={() => setEditorAiPreview(null)}>拒绝</button>
              <button data-testid="editor-ai-accept" type="button" className="rounded bg-blue-600 px-4 py-1 text-xs text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40" onClick={acceptEditorAiPreview} disabled={editorAiPreview.verification?.status !== 'passed' || Number(editorAiPreview.verification?.blockingCount || 0) > 0}>接受并保存</button>
            </div>
          </div>
        </div>
      )}

      {saveConflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" data-testid="editor-save-conflict">
          <div className="flex max-h-[82vh] w-[min(980px,96vw)] flex-col overflow-hidden rounded border border-amber-700/60 bg-[#1e1e1e] shadow-2xl">
            <div className="border-b border-vscode-panel-border px-4 py-2">
              <div className="text-sm font-semibold text-amber-200">保存冲突</div>
              <div className="text-[11px] text-gray-500">{saveConflict.message}</div>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 text-xs">
              <div>
                <div className="mb-1 text-gray-400">我的版本</div>
                <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap rounded border border-vscode-panel-border bg-black/20 p-3 text-gray-300">{saveConflict.localContent}</pre>
              </div>
              <div>
                <div className="mb-1 text-gray-400">磁盘版本</div>
                <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap rounded border border-vscode-panel-border bg-black/20 p-3 text-gray-300">{saveConflict.diskContent}</pre>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-vscode-panel-border px-4 py-3">
              <button type="button" className="rounded border border-vscode-panel-border px-3 py-1 text-xs text-gray-300 hover:bg-vscode-active-item" onClick={() => navigator.clipboard?.writeText(saveConflict.localContent || '')}>复制本地文本</button>
              <button type="button" className="rounded border border-vscode-panel-border px-3 py-1 text-xs text-gray-300 hover:bg-vscode-active-item" onClick={useDiskConflictVersion}>使用磁盘版本</button>
              <button type="button" className="rounded bg-blue-600 px-4 py-1 text-xs text-white hover:bg-blue-500" onClick={keepLocalConflictVersion}>保留我的版本并保存</button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" data-testid="chapter-history-panel">
          <div className="flex max-h-[84vh] w-[min(980px,96vw)] flex-col overflow-hidden rounded border border-vscode-panel-border bg-[#1e1e1e] shadow-2xl">
            <div className="flex items-center justify-between border-b border-vscode-panel-border px-4 py-2">
              <div>
                <div className="text-sm font-semibold text-gray-100">章节历史</div>
                <div className="text-[11px] text-gray-500">{activeChapter?.displayName || activeChapter?.fileName}</div>
              </div>
              <button type="button" className="text-gray-400 hover:text-white" onClick={() => setHistoryOpen(false)}>×</button>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="w-64 shrink-0 overflow-y-auto border-r border-vscode-panel-border p-2 text-xs">
                {chapterRevisions.map((revision) => (
                  <button
                    key={revision.id}
                    type="button"
                    className={`mb-1 w-full rounded px-2 py-2 text-left hover:bg-vscode-active-item ${selectedRevision?.id === revision.id ? 'bg-vscode-active-item text-white' : 'text-gray-300'}`}
                    onClick={() => selectChapterRevision(revision)}
                  >
                    <div className="truncate">{revision.label || revision.source || revision.id}</div>
                    <div className="text-[10px] text-gray-500">{revision.updatedAt || revision.createdAt}</div>
                  </button>
                ))}
                {!chapterRevisions.length && <div className="px-2 py-4 text-gray-500">{historyStatus || '暂无历史记录'}</div>}
              </div>
              <div className="flex-1 overflow-y-auto p-4 text-xs">
                {historyStatus && <div className="mb-2 text-blue-300">{historyStatus}</div>}
                {revisionPreview ? (
                  <>
                    <div className="mb-2 text-gray-400">当前正文 ↔ 历史版本</div>
                    <div className="whitespace-pre-wrap rounded border border-vscode-panel-border bg-black/20 p-3 font-mono text-gray-300">
                      {buildDiffParts(activeChapter?.content || '', revisionPreview.content || '').map((part) => (
                        <span
                          key={part.id}
                          className={part.kind === 1 ? 'bg-green-500/20 text-green-200' : part.kind === -1 ? 'bg-rose-500/20 text-rose-200 line-through' : ''}
                        >
                          {part.text}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="text-gray-500">选择一个历史版本查看差异</div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-vscode-panel-border px-4 py-3">
              <button type="button" className="rounded border border-vscode-panel-border px-3 py-1 text-xs text-gray-300 hover:bg-vscode-active-item" onClick={() => setHistoryOpen(false)}>关闭</button>
              <button type="button" className="rounded bg-blue-600 px-4 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-40" onClick={restoreSelectedRevision} disabled={!selectedRevision}>恢复此版本</button>
            </div>
          </div>
        </div>
      )}

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
          onImportComplete={async (result) => {
            console.log('[App] import complete', result);
            if (result?.id) {
              await refreshActiveNovelState();
              return;
            }
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
    case 'writing':
      return (
        <div className="h-full overflow-y-auto p-6">
          <WritingSettings />
        </div>
      );
    case 'lan-remote':
      return (
        <div className="h-full overflow-y-auto p-6">
          <LanRemoteSettings />
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
