import React, { useEffect, useMemo, useState } from 'react';
import { FileText, Settings, Search, GitBranch, MessageSquare, BookOpen } from 'lucide-react';
import { WorkflowPanel } from '@/components/WorkflowPanel.jsx';
import { AppSettingsPanel } from '@/components/AppSettingsPanel.jsx';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import { loadNovelTree, saveNovelTree } from '@/services/chapterStore.js';

const TAB_PREFIX = 'chapter:';
const makeId = (prefix) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function App() {
  const { t } = useI18n();
  const [activeSidebarItem, setActiveSidebarItem] = useState('explorer');
  const [bottomTab, setBottomTab] = useState('workflow');
  const [novel, setNovel] = useState(() => loadNovelTree());
  const [openChapterIds, setOpenChapterIds] = useState([]);
  const [activeEditorTab, setActiveEditorTab] = useState('');

  useEffect(() => {
    saveNovelTree(novel);
  }, [novel]);

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

  const editorTabs = useMemo(
    () =>
      openChapterIds
        .map((id) => chapterMap.get(id)?.chapter)
        .filter(Boolean)
        .map((chapter) => ({
          id: `${TAB_PREFIX}${chapter.id}`,
          chapterId: chapter.id,
          title: chapter.fileName,
          language: 'Markdown',
          content: chapter.content,
        })),
    [openChapterIds, chapterMap]
  );

  const activeChapterId = activeEditorTab.startsWith(TAB_PREFIX)
    ? activeEditorTab.slice(TAB_PREFIX.length)
    : '';
  const activeChapterEntry = activeChapterId ? chapterMap.get(activeChapterId) : null;
  const activeChapter = activeChapterEntry?.chapter ?? null;

  const openChapterInEditor = (chapterId) => {
    if (!chapterMap.get(chapterId)) return;
    setOpenChapterIds((ids) => (ids.includes(chapterId) ? ids : [...ids, chapterId]));
    setActiveEditorTab(`${TAB_PREFIX}${chapterId}`);
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
    setNovel((n) => ({ ...n, volumes: [...n.volumes, volume] }));
  };

  const createSection = (volumeId) => {
    setNovel((n) => ({
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
    }));
  };

  const createChapter = (volumeId, sectionId) => {
    let next = chapterEntries.length + 1;
    let fileName = `chapter${next}.md`;
    const exists = (name) =>
      chapterEntries.some(
        (e) => e.chapter.fileName.toLowerCase() === name.toLowerCase()
      );
    while (exists(fileName)) {
      next += 1;
      fileName = `chapter${next}.md`;
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
  };
  
  const closeEditorTab = (tabId) => {
    const chapterId = tabId.startsWith(TAB_PREFIX) ? tabId.slice(TAB_PREFIX.length) : '';
    if (!chapterId) return;
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
  };

  const removeDeletedChapterIdsFromTabs = (deletedChapterIds) => {
    if (deletedChapterIds.length === 0) return;
    setOpenChapterIds((ids) => ids.filter((id) => !deletedChapterIds.includes(id)));
    if (activeChapterId && deletedChapterIds.includes(activeChapterId)) {
      setActiveEditorTab('');
    }
  };

  const renameVolume = (volumeId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    if (!volume) return;
    const name = window.prompt(t('app.renameVolumePrompt'), volume.name);
    if (name == null) return;
    const next = name.trim();
    if (!next) return;
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => (v.id === volumeId ? { ...v, name: next } : v)),
    }));
  };

  const deleteVolume = (volumeId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    if (!volume) return;
    const ok = window.confirm(
      t('app.deleteVolumeConfirm').replace('{name}', volume.name)
    );
    if (!ok) return;
    const deletedChapterIds = volume.sections.flatMap((s) => s.chapters.map((c) => c.id));
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.filter((v) => v.id !== volumeId),
    }));
    removeDeletedChapterIdsFromTabs(deletedChapterIds);
  };

  const renameSection = (volumeId, sectionId) => {
    const volume = novel.volumes.find((v) => v.id === volumeId);
    const section = volume?.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const name = window.prompt(t('app.renameSectionPrompt'), section.name);
    if (name == null) return;
    const next = name.trim();
    if (!next) return;
    setNovel((n) => ({
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
    }));
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
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) =>
        v.id !== volumeId
          ? v
          : {
              ...v,
              sections: v.sections.filter((s) => s.id !== sectionId),
            }
      ),
    }));
    removeDeletedChapterIdsFromTabs(deletedChapterIds);
  };

  const renameChapter = (chapterId) => {
    const entry = chapterMap.get(chapterId);
    const chapter = entry?.chapter;
    if (!entry || !chapter) return;
    const nextName = window.prompt(t('app.renameChapterPrompt'), chapter.fileName);
    if (nextName == null) return;
    const raw = nextName.trim();
    if (!raw) return;
    const fileName = ensureMarkdownFileName(raw);
    const duplicated = chapterEntries.some(
      (e) => e.chapter.id !== chapterId && e.chapter.fileName.toLowerCase() === fileName.toLowerCase()
    );
    if (duplicated) {
      window.alert(t('app.fileNameExists'));
      return;
    }
    setNovel((n) => ({
      ...n,
      volumes: n.volumes.map((v) => ({
        ...v,
        sections: v.sections.map((s) => ({
          ...s,
          chapters: s.chapters.map((c) =>
            c.id === chapterId ? { ...c, fileName } : c
          ),
        })),
      })),
    }));
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
  };

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
  };

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
          <ActivityBarItem 
            icon={<GitBranch size={24} />} 
            active={activeSidebarItem === 'source-control'} 
            onClick={() => setActiveSidebarItem('source-control')} 
            label={t('app.sourceControl')}
          />
          <ActivityBarItem 
            icon={<BookOpen size={24} />} 
            active={activeSidebarItem === 'novel-structure'} 
            onClick={() => setActiveSidebarItem('novel-structure')} 
            label={t('app.novelStructure')}
          />
        </div>
        <div className="flex flex-col gap-2 w-full mb-2">
           <ActivityBarItem 
            icon={<Settings size={24} />} 
            active={activeSidebarItem === 'settings'} 
            onClick={() => setActiveSidebarItem('settings')} 
            label={t('app.settings')}
          />
        </div>
      </div>

      {/* Sidebar (File explorer, etc.) */}
      <div className="w-64 bg-vscode-sidebar flex flex-col border-r border-vscode-panel-border">
        <div className="h-9 px-4 flex items-center text-xs font-bold tracking-wide uppercase text-gray-400">
          {activeSidebarItem === 'explorer' && t('app.explorer')}
          {activeSidebarItem === 'search' && t('app.search')}
          {activeSidebarItem === 'source-control' && t('app.sourceControl')}
          {activeSidebarItem === 'novel-structure' && t('app.novelStructure')}
          {activeSidebarItem === 'settings' && t('app.settings')}
        </div>
        
        {/* Sidebar Content Area */}
        <div className="flex-1 overflow-y-auto p-2">
             {activeSidebarItem === 'explorer' && (
                <div className="text-sm">
                    <div className="font-bold mb-2 px-2 text-gray-400">{t('app.openEditors')}</div>
                    {editorTabs.length === 0 ? (
                      <div className="px-2 py-1 text-gray-500">{t('app.noOpenEditors')}</div>
                    ) : (
                      editorTabs.map((tab) => {
                          return (
                        <button
                          key={tab.id}
                          type="button"
                          className={`w-full text-left px-2 py-1 cursor-pointer flex items-center gap-2 ${
                            tab.id === activeEditorTab ? 'bg-vscode-active-item text-white' : 'hover:bg-vscode-active-item'
                          }`}
                          onClick={() => setActiveEditorTab(tab.id)}
                        >
                          <span className="text-yellow-400 text-xs">MD</span>
                          <span className="truncate">{tab.title}</span>
                        </button>
                          );
                        })
                    )}
                    <div className="font-bold mt-4 mb-2 px-2 text-gray-400 flex items-center justify-between gap-2">
                      <span>{t('app.myNovel')}</span>
                      <button
                        type="button"
                        className="px-2 py-0.5 rounded bg-blue-800/90 text-[11px] text-white"
                        onClick={createVolume}
                      >
                        {t('app.newVolume')}
                      </button>
                    </div>
                    {novel.volumes.length === 0 ? (
                      <div className="px-2 py-1 text-gray-500">{t('app.noVolumes')}</div>
                    ) : (
                      novel.volumes.map((volume) => (
                        <div key={volume.id} className="mb-1">
                          <div className="group flex items-center gap-1 pl-2 pr-1 py-1 hover:bg-vscode-active-item">
                            <span className="flex-1 text-left pl-2 pr-1 py-0.5 text-gray-300">{volume.name}</span>
                            <button
                              type="button"
                              className="text-gray-400 hover:text-white text-xs px-1"
                              title={t('app.newSection')}
                              onClick={(e) => {
                                e.stopPropagation();
                                createSection(volume.id);
                              }}
                            >
                              +节
                            </button>
                            <button
                              type="button"
                              className="text-gray-400 hover:text-white text-xs px-1"
                              title={t('app.renameVolume')}
                              onClick={(e) => {
                                e.stopPropagation();
                                renameVolume(volume.id);
                              }}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="text-gray-400 hover:text-red-300 text-xs px-1"
                              title={t('app.deleteVolume')}
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteVolume(volume.id);
                              }}
                            >
                              🗑
                            </button>
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
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      createChapter(volume.id, section.id);
                                    }}
                                  >
                                    +章
                                  </button>
                                  <button
                                    type="button"
                                    className="text-gray-400 hover:text-white text-xs px-1"
                                    title={t('app.renameSection')}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      renameSection(volume.id, section.id);
                                    }}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    type="button"
                                    className="text-gray-400 hover:text-red-300 text-xs px-1"
                                    title={t('app.deleteSection')}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      deleteSection(volume.id, section.id);
                                    }}
                                  >
                                    🗑
                                  </button>
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
                                      >
                                        {chapter.fileName}
                                      </button>
                                      <button
                                        type="button"
                                        className="text-gray-400 hover:text-white text-xs px-1"
                                        title={t('app.renameChapter')}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          renameChapter(chapter.id);
                                        }}
                                      >
                                        ✎
                                      </button>
                                      <button
                                        type="button"
                                        className="text-gray-400 hover:text-red-300 text-xs px-1"
                                        title={t('app.deleteChapter')}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteChapter(chapter.id);
                                        }}
                                      >
                                        🗑
                                      </button>
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
             )}
             {activeSidebarItem === 'novel-structure' && (
                 <div className="text-sm px-2">
                     <p>{t('app.structurePlaceholder')}</p>
                 </div>
             )}
             {activeSidebarItem === 'settings' && (
                <div className="text-sm px-2">
                  <AppSettingsPanel />
                </div>
             )}
        </div>
      </div>

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col bg-vscode-editor-bg min-w-0">
        
        {/* Tabs */}
        <div className="flex bg-vscode-sidebar border-b border-vscode-panel-border overflow-x-auto h-9">
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

        {/* Editor Content (Placeholder for now) */}
        <div className="flex-1 p-4 font-mono text-sm overflow-auto text-gray-300">
          {activeChapter ? (
            <textarea
              className="w-full h-full resize-none bg-transparent outline-none text-gray-300 leading-relaxed"
              value={activeEditor.content}
              onChange={(e) => updateActiveChapterContent(e.target.value)}
              placeholder={t('app.markdownInputPlaceholder')}
            />
          ) : (
            <p className="text-gray-500 italic">{t('app.selectOrOpenFile')}</p>
          )}
        </div>

        {/* AI Assistant Panel (Bottom or Right - Let's put it on the right for now like Copilot Chat or a Terminal) */}
        <div className="h-1/3 border-t border-vscode-panel-border flex flex-col bg-vscode-panel-bg">
             <div className="h-8 border-b border-vscode-panel-border flex items-center px-4 justify-between shrink-0">
                <div className="flex gap-4 text-xs font-bold text-gray-400">
                    <button
                      type="button"
                      className={`cursor-pointer pb-1 border-b-2 ${bottomTab === 'workflow' ? 'text-white border-white' : 'border-transparent hover:text-gray-200'}`}
                      onClick={() => setBottomTab('workflow')}
                    >
                      {t('app.workflow')}
                    </button>
                    <button
                      type="button"
                      className={`cursor-pointer pb-1 border-b-2 ${bottomTab === 'chat' ? 'text-white border-white' : 'border-transparent hover:text-gray-200'}`}
                      onClick={() => setBottomTab('chat')}
                    >
                      {t('app.aiChat')}
                    </button>
                    <span className="cursor-pointer hover:text-gray-200">{t('app.terminal')}</span>
                    <span className="cursor-pointer hover:text-gray-200">{t('app.output')}</span>
                </div>
             </div>
             <div className="flex-1 p-4 overflow-y-auto min-h-0">
                 {bottomTab === 'workflow' && <WorkflowPanel />}
                 {bottomTab === 'chat' && (
                   <div className="flex gap-2 mb-4">
                     <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs">AI</div>
                     <div className="bg-vscode-active-item p-2 rounded max-w-[80%] text-sm">
                        {t('app.aiGreeting')}
                     </div>
                   </div>
                 )}
             </div>
             <div className="p-2 border-t border-vscode-panel-border">
                 <div className="flex gap-2 bg-vscode-sidebar border border-vscode-panel-border rounded p-1">
                     <input type="text" placeholder={t('app.askAI')} className="bg-transparent border-none outline-none flex-1 px-2 text-sm text-white" />
                     <button className="p-1 hover:bg-vscode-active-item rounded"><MessageSquare size={16}/></button>
                 </div>
             </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="h-6 bg-vscode-status-bar text-white text-xs flex items-center px-2 justify-between absolute bottom-0 w-full z-20">
          <div className="flex gap-4">
              <span className="flex items-center gap-1"><GitBranch size={12} /> main</span>
              <span>{t('app.errorsWarnings')}</span>
          </div>
          <div className="flex gap-4">
              <span>Ln 3, Col 15</span>
              <span>UTF-8</span>
              <span>{activeEditor.language}</span>
          </div>
      </div>

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
