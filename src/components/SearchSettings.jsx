import React, { useCallback, useEffect, useState } from 'react';
import { Globe, Sparkles, Users } from 'lucide-react';

const ENGINES = [
  { id: 'auto', label: '自动（智能路由）', desc: '根据原作文化圈自动选择最优搜索源' },
  { id: 'moegirl', label: '萌娘百科', desc: 'ACG 角色资料最全，仅中文' },
  { id: 'wikipedia', label: 'Wikipedia', desc: '多语言支持，全球覆盖' },
  { id: 'duckduckgo', label: 'DuckDuckGo', desc: '海外网络友好，全局兜底' },
  { id: 'all', label: '全部搜索源', desc: '使用所有可用源，最全面但较慢' },
];

export function SearchSettings() {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [engine, setEngine] = useState('auto');
  const [mode, setMode] = useState('traditional');
  const [concurrency, setConcurrency] = useState(10);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!mana?.config?.getApp) return;
    mana.config.getApp().then((cfg) => {
      if (cfg?.searchEngine) setEngine(cfg.searchEngine);
      if (cfg?.enrichmentMode) setMode(cfg.enrichmentMode);
      if (cfg?.enrichmentConcurrency != null) setConcurrency(cfg.enrichmentConcurrency);
    }).catch(() => {});
  }, [mana]);

  const onSave = useCallback(async () => {
    if (!mana?.config?.setApp) return;
    try {
      await mana.config.setApp({ searchEngine: engine, enrichmentMode: mode, enrichmentConcurrency: concurrency });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch { /* ignore */ }
  }, [mana, engine, mode, concurrency]);

  return (
    <div className="text-xs space-y-3 max-w-xl">
      <div className="flex items-start gap-2 text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-2">
        <Sparkles size={14} className="shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold text-amber-300">联网搜索补全角色信息</div>
          <div className="text-amber-300/70 mt-0.5">
            当检测到同人小说时，自动联网搜索原作角色的外貌、性格、背景等信息来补全角色卡。
            若搜索结果与本小说描述冲突，以本小说为准。
          </div>
        </div>
      </div>

      <div>
        <label className="text-gray-500 text-[11px] block mb-1">搜索引擎偏好</label>
        <div className="space-y-1">
          {ENGINES.map((e) => (
            <label key={e.id} className="flex items-start gap-2 py-1 cursor-pointer hover:bg-vscode-active-item/30 rounded px-1">
              <input
                type="radio"
                name="searchEngine"
                value={e.id}
                checked={engine === e.id}
                onChange={() => setEngine(e.id)}
                className="mt-0.5"
              />
              <div>
                <div className="text-gray-300 text-[11px]">{e.label}</div>
                <div className="text-gray-500 text-[10px]">{e.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-gray-500 text-[11px] block mb-1">补全搜索模式</label>
        <div className="space-y-1">
          <label className="flex items-start gap-2 py-1 cursor-pointer hover:bg-vscode-active-item/30 rounded px-1">
            <input
              type="radio"
              name="enrichmentMode"
              value="traditional"
              checked={mode === 'traditional'}
              onChange={() => setMode('traditional')}
              className="mt-0.5"
            />
            <div>
              <div className="text-gray-300 text-[11px]">传统搜索</div>
              <div className="text-gray-500 text-[10px]">使用萌娘百科、Wikipedia、Bing 等源直接搜索，速度快、成本低</div>
            </div>
          </label>
          <label className="flex items-start gap-2 py-1 cursor-pointer hover:bg-vscode-active-item/30 rounded px-1">
            <input
              type="radio"
              name="enrichmentMode"
              value="llm"
              checked={mode === 'llm'}
              onChange={() => setMode('llm')}
              className="mt-0.5"
            />
            <div>
              <div className="text-gray-300 text-[11px]">LLM 智能搜索</div>
              <div className="text-gray-500 text-[10px]">由 AI 自主决定搜索策略和关键词，更智能但消耗更多 Token</div>
            </div>
          </label>
        </div>
      </div>

      <div>
        <label className="text-gray-500 text-[11px] block mb-1">并发搜索数量</label>
        <div className="flex items-center gap-3">
          <Users size={14} className="text-gray-400 shrink-0" />
          <input
            type="range"
            min={1}
            max={30}
            step={1}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="flex-1 accent-blue-500"
          />
          <span className="text-gray-300 font-mono w-8 text-right">{concurrency}</span>
        </div>
        <div className="text-gray-500 text-[10px] mt-1">
          同时搜索的角色数量。数值越大速度越快，但对网络和搜索引擎负载越高。
          建议：普通网络 5~10，优质网络 15~20，本地代理/海外网络 20~30。
        </div>
      </div>

      <div className="text-gray-500 text-[10px] bg-vscode-sidebar rounded p-2">
        <Globe size={12} className="inline mr-1" />
        自动模式路由规则：中文作品优先萌娘百科→Bing→Wikipedia，欧美作品优先Wikipedia→Bing，全局兜底DuckDuckGo。
        搜索时会自动附加作品名（如「碧蓝航线:爱宕」），避免同名角色混淆。
      </div>

      <button
        type="button"
        onClick={onSave}
        className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600 text-xs"
      >
        {saved ? '已保存' : '保存搜索设置'}
      </button>
    </div>
  );
}
