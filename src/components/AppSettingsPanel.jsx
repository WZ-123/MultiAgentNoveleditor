import { useI18n } from '@/i18n/LanguageContext.jsx';
import {
  Globe,
  HardDrive,
  Search,
  Book,
  Wifi,
} from 'lucide-react';

// One row per category. The settings UI itself lives in the main editor area —
// the sidebar just lists categories, each click opens (or activates) a tab.
function buildCategories(t) {
  return [
    {
      sid: 'language',
      title: t('settings.languageTitle'),
      desc: t('settings.languageDesc'),
      Icon: Globe,
    },
    {
      sid: 'lan-remote',
      title: '局域网遥控',
      desc: '在同一 Wi-Fi 下用浏览器遥控这台 Mac 的本地应用。',
      Icon: Wifi,
    },
    {
      sid: 'storage',
      title: '存储空间',
      desc: '对话历史与离线操作日志的存储上限与清理策略。',
      Icon: HardDrive,
    },
    {
      sid: 'search',
      title: '搜索引擎',
      desc: '同人角色联网搜索补全设置，选择搜索源偏好。',
      Icon: Search,
    },
    {
      sid: 'skill',
      title: 'Skill',
      desc: '直接创建、启用、禁用、导入和导出 Codex Skills。',
      Icon: Book,
    },
  ];
}

export function AppSettingsPanel({ onOpenInEditor, activeSettingsId }) {
  const { t } = useI18n();
  const categories = buildCategories(t);

  return (
    <div className="space-y-1">
      {categories.map(({ sid, title, desc, Icon }) => {
        const active = sid === activeSettingsId;
        return (
          <button
            key={sid}
            type="button"
            onClick={() => onOpenInEditor?.(sid)}
            className={`w-full flex items-start gap-2 px-2 py-2 rounded text-left text-xs transition-colors ${
              active
                ? 'bg-vscode-list-activeSelectionBackground text-white'
                : 'hover:bg-vscode-list-hoverBackground text-gray-300'
            }`}
          >
            <Icon size={14} className="mt-0.5 flex-shrink-0 opacity-80" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{title}</div>
              {desc ? (
                <div className="text-[10px] text-gray-500 mt-0.5 line-clamp-2 leading-snug">
                  {desc}
                </div>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}
