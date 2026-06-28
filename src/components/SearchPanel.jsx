import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, X, FileText, User, Globe, Clock, Package } from 'lucide-react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

const CATEGORY_OPTIONS = [
  { key: 'all', icon: null },
  { key: 'chapters', icon: FileText },
  { key: 'characters', icon: User },
  { key: 'assets', icon: Package },
  { key: 'world', icon: Globe },
  { key: 'timeline', icon: Clock },
];

const TYPE_LABEL_MAP = {
  chapter_content: 'chapterContent',
  chapter_name: 'chapterName',
  character: 'characterInfo',
  asset: 'assetInfo',
  world_lore: 'worldLore',
  world_place: 'worldPlace',
  timeline_event: 'timelineEvent',
};

const TYPE_ICON_MAP = {
  chapter_content: FileText,
  chapter_name: FileText,
  character: User,
  asset: Package,
  world_lore: Globe,
  world_place: Globe,
  timeline_event: Clock,
};

/**
 * SearchPanel — sidebar search panel for Ctrl+F / Cmd+F.
 * @param {object} props
 * @param {string|null} props.novelId
 * @param {(fileName: string) => void} props.onOpenChapter
 * @param {(id: string) => void} props.onOpenCharacter
 * @param {(id: string) => void} [props.onOpenAsset]
 * @param {() => void} [props.onSwitchSidebar]
 */
export function SearchPanel({ novelId, onOpenChapter, onOpenCharacter, onOpenAsset, onSwitchSidebar }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Focus the input on mount (and when novelId appears)
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, [novelId]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setHasSearched(false);
      setIsSearching(false);
      return;
    }

    if (!novelId) return;

    setIsSearching(true);

    debounceRef.current = setTimeout(async () => {
      try {
        const categories = selectedCategory === 'all'
          ? undefined
          : [selectedCategory];

        const searchResults = await window.mana.novel.search(novelId, trimmed, { categories });
        setResults(Array.isArray(searchResults) ? searchResults : []);
        setHasSearched(true);
      } catch (err) {
        console.error('Search failed:', err);
        setResults([]);
        setHasSearched(true);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, selectedCategory, novelId]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      if (query) {
        // Clear query on first Escape
        setQuery('');
        e.preventDefault();
      } else if (onSwitchSidebar) {
        // Switch back to explorer on second Escape
        onSwitchSidebar();
        e.preventDefault();
      }
    }
  }, [query, onSwitchSidebar]);

  const handleCategoryChange = useCallback((key) => {
    setSelectedCategory(key);
  }, []);

  const handleResultClick = useCallback((result) => {
    const target = result.target;
    if (!target) return;
    if (target.type === 'chapter' && target.chapterFileName) {
      onOpenChapter(target.chapterFileName, { startOffset: target.startOffset, endOffset: target.endOffset });
    } else if (target.type === 'character' && target.characterId) {
      onOpenCharacter(target.characterId);
    } else if (target.type === 'asset' && target.assetId && onOpenAsset) {
      onOpenAsset(target.assetId);
    }
  }, [onOpenChapter, onOpenCharacter, onOpenAsset]);

  const groupResultsByType = (items) => {
    const groups = {};
    for (const item of items) {
      const key = item.type || 'other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return groups;
  };

  const grouped = groupResultsByType(results);

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Search input */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            ref={inputRef}
            id="search-input"
            type="text"
            className="w-full pl-8 pr-7 py-1.5 rounded bg-vscode-input-bg border border-vscode-panel-border text-gray-200 placeholder-gray-500 outline-none focus:border-blue-500/60 text-xs"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!novelId}
          />
          {query && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Category filter pills */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {CATEGORY_OPTIONS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              selectedCategory === key
                ? 'bg-blue-600/50 text-blue-200'
                : 'bg-vscode-active-item/50 text-gray-400 hover:text-gray-200 hover:bg-vscode-active-item'
            }`}
            onClick={() => handleCategoryChange(key)}
            disabled={!novelId}
          >
            {key === 'all' ? t('search.all') : t(`search.${key}`)}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="border-t border-vscode-panel-border" />

      {/* Results area */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!novelId ? (
          <div className="text-gray-500 text-center py-8 px-4">
            {t('search.noNovel')}
          </div>
        ) : isSearching ? (
          <div className="text-gray-500 text-center py-8">
            <span className="animate-pulse">{t('search.searching')}</span>
          </div>
        ) : !hasSearched ? (
          <div className="text-gray-500 text-center py-8 px-4">
            {t('search.typeToSearch')}
          </div>
        ) : results.length === 0 ? (
          <div className="text-gray-500 text-center py-8 px-4">
            {t('search.noResults')}
          </div>
        ) : (
          Object.entries(grouped).map(([typeKey, items]) => (
            <div key={typeKey} className="mb-3">
              <div className="text-gray-400 font-bold text-[11px] uppercase tracking-wide px-1 mb-1">
                {t(`search.${TYPE_LABEL_MAP[typeKey] || typeKey}`)}
                <span className="font-normal text-gray-500 ml-1">({items.length})</span>
              </div>
              {items.map((item, idx) => (
                <ResultItem
                  key={`${item.target?.chapterFileName || item.target?.characterId || ''}-${idx}`}
                  item={item}
                  Icon={TYPE_ICON_MAP[typeKey]}
                  onClick={() => handleResultClick(item)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ResultItem({ item, Icon, onClick }) {
  return (
    <button
      type="button"
      className="w-full text-left px-2 py-1.5 rounded hover:bg-vscode-active-item cursor-pointer group mb-0.5"
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5">
        {Icon && <Icon size={11} className="shrink-0 text-gray-400" />}
        <span className="text-gray-200 text-[11px] font-medium truncate flex-1">
          {item.title}
        </span>
      </div>
      {item.snippet && (
        <div className="text-gray-500 text-[10px] mt-0.5 pl-5 line-clamp-2 leading-relaxed">
          {item.snippet}
        </div>
      )}
      <div className="text-gray-600 text-[9px] mt-0.5 pl-5">
        {item.matchField && <span className="italic">{item.matchField}</span>}
      </div>
    </button>
  );
}
