import { useI18n } from '@/i18n/LanguageContext.jsx';
import {
  Globe,
  Cpu,
  Bot,
  GitBranch,
  Wand2,
  KeyRound,
  HardDrive,
  Search,
  Book,
  PenLine,
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
    // NOTE: 以下设置项功能尚未完成，暂时隐藏
    // {
    //   sid: 'runtime',
    //   title: t('runtime.title'),
    //   desc: t('runtime.description'),
    //   Icon: Cpu,
    // },
    {
      sid: 'subagent',
      title: t('subagent.title'),
      desc: t('subagent.desc'),
      Icon: Bot,
    },
    // NOTE: Pipeline(DAG) 功能尚未完成，暂时隐藏
    // {
    //   sid: 'dag',
    //   title: t('dag.title'),
    //   desc: t('dag.desc'),
    //   Icon: GitBranch,
    // },
    // NOTE: 配置助手功能尚未完成，暂时隐藏
    // {
    //   sid: 'config-helper',
    //   title: '配置助手',
    //   desc: '通过自然语言对话生成 / 修改 Subagent 与 DAG 配置。',
    //   Icon: Wand2,
    // },
    // NOTE: 大语言模型配置已移至 ActivityBar 独立入口，此处隐藏避免重复
    // {
    //   sid: 'models',
    //   title: t('settings.llmTitle'),
    //   desc: t('settings.llmDesc') || 'API Key、Provider、各 Agent 的模型与 Tier 绑定。',
    //   Icon: KeyRound,
    // },
    {
      sid: 'writing',
      title: '写作设置',
      desc: '默认写作模式与角色驱动写作交互强度。',
      Icon: PenLine,
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
      desc: '创建和管理技能文档，关联到 Subagent，导入导出。',
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
