import React, { useCallback, useMemo, useState } from 'react';
import {
  AGENT_ENDPOINT_KEYS,
  AGENT_ENDPOINT_LABELS,
  applyPresetToAgent,
  loadAgentApiConfig,
  saveAgentApiConfig,
} from '@/services/agentApiConfig.js';
import { PROVIDER_PRESETS } from '@/services/aiProviders.js';

export function AgentApiSettings() {
  const initial = useMemo(() => loadAgentApiConfig(), []);
  const [config, setConfig] = useState(initial);
  const [savedFlash, setSavedFlash] = useState(false);

  const updateAgent = useCallback((key, patch) => {
    setConfig((c) => ({
      ...c,
      [key]: { ...c[key], ...patch },
    }));
  }, []);

  const onProviderChange = useCallback((key, providerId) => {
    setConfig((c) => ({
      ...c,
      [key]: applyPresetToAgent(c[key], providerId),
    }));
  }, []);

  const save = useCallback(() => {
    saveAgentApiConfig(config);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, [config]);

  return (
    <section className="pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <div className="font-bold text-sm">API 配置（OpenAI 兼容）</div>
          <p className="text-xs text-gray-500 mt-1">
            每个 Agent 可单独指定服务商、Base URL、模型与 Key；关闭「使用
            mock」并填写 Key 后走真实请求。未配置 Key 或开启 mock 时使用本地 mock。
            Electron 应用内请求经主进程转发，可避免浏览器 CORS；在纯浏览器
            dev（仅 Vite）直连厂商 API 时可能需自建网关或代理。
          </p>
        </div>
        <button
          type="button"
          className="px-3 py-1 rounded bg-blue-800/90 text-xs text-white"
          onClick={save}
        >
          {savedFlash ? '已保存' : '保存全部'}
        </button>
      </div>

      <div className="space-y-4 max-h-[min(70vh,520px)] overflow-y-auto pr-1">
        {AGENT_ENDPOINT_KEYS.map((key) => {
          const row = config[key];
          if (!row) return null;
          const label = AGENT_ENDPOINT_LABELS[key] ?? key;
          return (
            <div
              key={key}
              className="border border-vscode-panel-border/80 rounded p-2 bg-vscode-editor-bg/50"
            >
              <div className="text-xs font-semibold text-gray-300 mb-2">{label}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-gray-500">服务商预设</span>
                  <select
                    className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1"
                    value={row.providerId}
                    onChange={(e) => onProviderChange(key, e.target.value)}
                  >
                    {PROVIDER_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-gray-500">模型 ID</span>
                  <input
                    className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1"
                    value={row.model}
                    onChange={(e) => updateAgent(key, { model: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-gray-500">Base URL（须为 OpenAI 兼容，不含 /chat/completions）</span>
                  <input
                    className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 font-mono"
                    value={row.baseUrl}
                    onChange={(e) => updateAgent(key, { baseUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-gray-500">API Key（仅保存在本机 localStorage）</span>
                  <input
                    type="password"
                    autoComplete="off"
                    className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 font-mono"
                    value={row.apiKey}
                    onChange={(e) => updateAgent(key, { apiKey: e.target.value })}
                    placeholder="sk-… 或各厂商密钥"
                  />
                </label>
                <label className="flex items-center gap-2 sm:col-span-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={row.useMock}
                    onChange={(e) => updateAgent(key, { useMock: e.target.checked })}
                  />
                  <span className="text-gray-400">使用 mock（不发起网络请求）</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
