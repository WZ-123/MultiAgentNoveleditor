import React, { useCallback, useEffect, useState } from 'react';
import { User, Globe, Book, Pen, Calendar, ChevronRight, ChevronDown } from 'lucide-react';

/**
 * Browses the active novel's characters, world, timeline, outline, and style.
 * Displayed in the sidebar below the chapter tree.
 */
export function NovelDataBrowser({ onOpenTab }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [activeNovel, setActiveNovel] = useState(null);

  const [openSection, setOpenSection] = useState(null);
  const [sectionData, setSectionData] = useState({});
  const [loading, setLoading] = useState({});

  // Watch for active novel changes
  useEffect(() => {
    if (!mana?.novel?.active) return;
    let cancelled = false;
    const check = async () => {
      try {
        const a = await mana.novel.active();
        if (!cancelled) {
          if (!a?.id && activeNovel?.id) setActiveNovel(null);
          else if (a?.id && a.id !== activeNovel?.id) setActiveNovel(a);
        }
      } catch { /* ignore */ }
    };
    check();
    const iv = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [mana, activeNovel?.id]);

  const loadSection = useCallback(async (key) => {
    if (!mana?.novel || !activeNovel?.id) return;
    if (openSection === key) { setOpenSection(null); return; }
    setOpenSection(key);
    if (sectionData[key]) return; // already loaded

    setLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const nid = activeNovel.id;
      if (key === 'characters') {
        const chars = await mana.novel.listCharacters(nid);
        setSectionData((prev) => ({ ...prev, characters: Array.isArray(chars) ? chars : [] }));
      } else if (key === 'world') {
        const w = await mana.novel.readWorld(nid);
        setSectionData((prev) => ({ ...prev, world: w && typeof w === 'object' ? w : { lore: '', places: [] } }));
      } else if (key === 'timeline') {
        const evts = await mana.novel.listTimeline(nid);
        setSectionData((prev) => ({ ...prev, timeline: Array.isArray(evts) ? evts : [] }));
      } else if (key === 'outline') {
        // Try master outline first, then list files for the tree path info
        let text = '';
        try {
          const exists = await mana.fs.pathExists(`${activeNovel.dir}/outlines/outline.md`);
          if (exists) {
            text = await mana.fs.readFile(`${activeNovel.dir}/outlines/outline.md`, 'utf8');
          } else {
            const files = await mana.fs.listDir(`${activeNovel.dir}/outlines`);
            const mdFiles = (files || []).filter((f) => typeof f === 'string' ? f.endsWith('.md') : (f.name || '').endsWith('.md'));
            if (mdFiles.length > 0) {
              const firstName = typeof mdFiles[0] === 'string' ? mdFiles[0] : mdFiles[0].name;
              text = await mana.fs.readFile(`${activeNovel.dir}/outlines/${firstName}`, 'utf8');
            }
          }
        } catch { text = '(无大纲)'; }
        setSectionData((prev) => ({ ...prev, outline: typeof text === 'string' ? text : String(text ?? '') }));
      } else if (key === 'style') {
        let text = '';
        try { text = await mana.novel.readStyleMemory(nid); } catch { text = '(无文风记录)'; }
        setSectionData((prev) => ({ ...prev, style: typeof text === 'string' ? text : String(text ?? '') }));
      }
    } catch (err) {
      console.error(`[NovelDataBrowser] load ${key} failed:`, err);
    }
    setLoading((prev) => ({ ...prev, [key]: false }));
  }, [mana, activeNovel, openSection, sectionData]);

  if (!activeNovel?.id) {
    return (
      <div className="px-2 py-2 text-[11px] text-gray-600 border-t border-vscode-panel-border">
        未打开小说项目
      </div>
    );
  }

  const sections = [
    { key: 'characters', icon: User, label: '角色卡', countKey: 'characters' },
    { key: 'world', icon: Globe, label: '世界观' },
    { key: 'timeline', icon: Calendar, label: '时间线', countKey: 'timeline' },
    { key: 'outline', icon: Book, label: '大纲' },
    { key: 'style', icon: Pen, label: '文风' },
  ];

  const renderContent = (key) => {
    const data = sectionData[key];
    const isLoading = loading[key];
    const s = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));

    if (isLoading) return <div className="px-4 py-1 text-[10px] text-blue-400">加载中…</div>;
    if (!data) return null;

    if (key === 'characters') {
      if (!Array.isArray(data) || !data.length) return <div className="px-4 py-1 text-[10px] text-gray-600">暂无角色</div>;
      return (
        <div className="px-4 pb-1 max-h-48 overflow-y-auto">
          {data.map((ch, i) => (
            <div key={ch.id || i} className="py-0.5 text-[11px] border-b border-vscode-panel-border/30 last:border-0">
              <span className="text-gray-200">{s(ch.name || ch.id || '?')}</span>
              {ch.role && <span className="text-gray-500 ml-1 text-[10px]">— {s(ch.role)}</span>}
              {ch.gender && <span className="text-gray-600 ml-1 text-[10px]">({s(ch.gender)})</span>}
              {ch.personality && <div className="text-gray-500 text-[10px] truncate">{s(ch.personality)}</div>}
            </div>
          ))}
        </div>
      );
    }

    if (key === 'world') {
      if (!data.lore) return <div className="px-4 py-1 text-[10px] text-gray-600">暂无世界观</div>;
      return (
        <div className="px-4 pb-1 max-h-48 overflow-y-auto">
          <div className="text-[10px] text-gray-500 whitespace-pre-wrap line-clamp-8 leading-relaxed">{s(data.lore)}</div>
          {data.places?.length > 0 && (
            <div className="mt-1 text-[10px] text-gray-600">地点: {data.places.map((p) => s(p.name)).join('、')}</div>
          )}
        </div>
      );
    }

    if (key === 'timeline') {
      if (!Array.isArray(data) || !data.length) return <div className="px-4 py-1 text-[10px] text-gray-600">暂无事件</div>;
      return (
        <div className="px-4 pb-1 max-h-48 overflow-y-auto">
          {data.map((ev, i) => (
            <div key={ev.id || i} className="py-0.5 text-[10px] border-b border-vscode-panel-border/30 last:border-0">
              <span className="text-gray-400">{s(ev.timestamp || ev.title || '?')}</span>
              <span className="text-gray-500 ml-1">{s(ev.event || ev.title || '').slice(0, 100)}</span>
            </div>
          ))}
        </div>
      );
    }

    if (key === 'outline') {
      const isHierarchical = typeof data === 'string' && data.startsWith('# 总大纲');
      const truncate = (str) => str && typeof str === 'string' ? str.slice(0, 300) : '';
      return (
        <div className="px-4 pb-1 max-h-48 overflow-y-auto">
          {isHierarchical ? (
            <div className="text-[10px] text-gray-400">
              <div className="text-gray-500 mb-1">层级大纲（含卷/节/章结构）</div>
              <div className="whitespace-pre-wrap line-clamp-7 leading-relaxed">{truncate(data)}</div>
            </div>
          ) : (
            <div className="text-[10px] text-gray-500 whitespace-pre-wrap line-clamp-8 leading-relaxed">{s(data)}</div>
          )}
        </div>
      );
    }

    if (key === 'style') {
      return (
        <div className="px-4 pb-1 max-h-48 overflow-y-auto">
          <div className="text-[10px] text-gray-500 whitespace-pre-wrap line-clamp-6 leading-relaxed">{s(data)}</div>
        </div>
      );
    }
  };

  return (
    <div className="text-xs border-t border-vscode-panel-border mt-1">
      <div className="px-2 py-1 text-gray-500 font-bold text-[10px] uppercase tracking-wider">
        小说数据
      </div>
      {sections.map(({ key, icon: Icon, label, countKey }) => {
        const isOpen = openSection === key;
        const count = countKey ? sectionData[countKey]?.length : undefined;
        return (
          <div key={key}>
            <div className="flex items-center gap-0">
              <button
                type="button"
                onClick={() => loadSection(key)}
                className="flex items-center gap-1 px-1 py-1 text-left text-gray-400 hover:text-gray-200 hover:bg-vscode-active-item/50 flex-1 min-w-0"
              >
                {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <Icon size={12} />
                <span className="text-[11px] flex-1">{label}</span>
                {count !== undefined && <span className="text-[10px] text-gray-600">{count}</span>}
                {loading[key] && <span className="text-[10px] text-blue-400">…</span>}
              </button>
              <button
                type="button"
                onClick={() => { if (onOpenTab) onOpenTab(key); }}
                className="px-1.5 py-1 text-gray-500 hover:text-gray-200 hover:bg-vscode-active-item/50 text-[10px] shrink-0"
                title={`在编辑器中打开${label}`}
              >
                打开
              </button>
            </div>
            {isOpen && renderContent(key)}
          </div>
        );
      })}
    </div>
  );
}
