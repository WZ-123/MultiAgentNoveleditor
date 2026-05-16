import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner } from '@heroui/react';
import {
  Check,
  Cpu,
  Plus,
  RefreshCw,
  Trash2,
  X,
  ChevronDown,
  ChevronRight,
  Wand2,
  Save,
  RotateCcw,
} from 'lucide-react';

export function ProviderSettingsPanel() {
  const mana = typeof window !== 'undefined' ? window.mana : null;

  const [providers, setProviders] = useState([]);
  const [current, setCurrent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', type: 'openai-compat', baseUrl: '', apiKey: '' });

  const [expandedProviders, setExpandedProviders] = useState(new Set());
  const [modelForm, setModelForm] = useState({ providerId: '', id: '', name: '', contextWindow: 200000 });

  const [aliases, setAliases] = useState([]);
  const [aliasLoading, setAliasLoading] = useState(false);
  const [aliasSaving, setAliasSaving] = useState(false);
  const [aliasError, setAliasError] = useState('');

  const refresh = useCallback(async () => {
    if (!mana?.ccs) {
      setError('IPC bridge unavailable');
      setLoading(false);
      return;
    }
    setError('');
    setLoading(true);
    try {
      const [list, cur, als] = await Promise.all([
        mana.ccs.list(),
        mana.ccs.current().catch(() => null),
        mana.modelAliases.list().catch(() => []),
      ]);
      console.debug('[ProviderSettingsPanel] provider.list() →', list);
      setProviders(Array.isArray(list) ? list : []);
      setCurrent(cur);
      setAliases(Array.isArray(als) ? als : []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [mana]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUse = useCallback(async (name) => {
    setBusyAction(`use:${name}`);
    setError('');
    try {
      await mana.ccs.use(name);
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyAction('');
    }
  }, [mana, refresh]);

  const handleRemove = useCallback(async (name) => {
    if (!confirm(`确认删除供应商 "${name}"？此操作只影响配置文件，不会删除任何 API key。`)) return;
    setBusyAction(`remove:${name}`);
    setError('');
    try {
      await mana.ccs.remove(name);
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyAction('');
    }
  }, [mana, refresh]);

  const handleAdd = useCallback(async () => {
    const { name, type, baseUrl, apiKey } = addForm;
    if (!name.trim()) {
      setError('请填写供应商名称');
      return;
    }
    setBusyAction('add');
    setError('');
    try {
      await mana.ccs.add({
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setAddForm({ name: '', type: 'openai-compat', baseUrl: '', apiKey: '' });
      setShowAddForm(false);
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyAction('');
    }
  }, [mana, addForm, refresh]);

  const toggleExpand = useCallback((providerName) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(providerName)) next.delete(providerName);
      else next.add(providerName);
      return next;
    });
  }, []);

  const handleAddModel = useCallback(async (providerName) => {
    const { id, name, contextWindow } = modelForm;
    if (!id.trim()) {
      setError('模型 ID 不能为空');
      return;
    }
    setBusyAction(`addModel:${providerName}`);
    setError('');
    try {
      await mana.ccs.addModel(providerName, {
        id: id.trim(),
        name: name.trim() || id.trim(),
        contextWindow: Number(contextWindow) || 200000,
      });
      setModelForm({ providerId: '', id: '', name: '', contextWindow: 200000 });
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyAction('');
    }
  }, [mana, modelForm, refresh]);

  const handleRemoveModel = useCallback(async (providerName, modelId) => {
    if (!confirm(`确认删除模型 "${modelId}"？`)) return;
    setBusyAction(`removeModel:${providerName}:${modelId}`);
    setError('');
    try {
      await mana.ccs.removeModel(providerName, modelId);
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyAction('');
    }
  }, [mana, refresh]);

  const handleDiscover = useCallback(async (providerName) => {
    setBusyAction(`discover:${providerName}`);
    setError('');
    try {
      const res = await mana.ccs.discoverModels(providerName);
      if (!res.ok) {
        setError(res.error || '自动发现失败');
      } else if (!res.models || res.models.length === 0) {
        setError('未发现可用模型');
      } else {
        // Add discovered models to the provider
        for (const m of res.models) {
          await mana.ccs.addModel(providerName, {
            id: m.id,
            name: m.name || m.id,
            contextWindow: 200000,
          });
        }
        await refresh();
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyAction('');
    }
  }, [mana, refresh]);

  const updateAliasField = useCallback((aliasId, field, value) => {
    setAliases((prev) =>
      prev.map((a) => (a.id === aliasId ? { ...a, [field]: value } : a))
    );
  }, []);

  const handleSaveAliases = useCallback(async () => {
    setAliasSaving(true);
    setAliasError('');
    try {
      for (const alias of aliases) {
        await mana.modelAliases.saveAlias(alias);
      }
    } catch (err) {
      setAliasError(err?.message || String(err));
    } finally {
      setAliasSaving(false);
    }
  }, [mana, aliases]);

  const handleResetAliases = useCallback(async () => {
    if (!confirm('确定重置所有 Alias 为默认值？自定义配置将丢失。')) return;
    setAliasSaving(true);
    setAliasError('');
    try {
      await mana.modelAliases.resetToDefaults();
      await refresh();
    } catch (err) {
      setAliasError(err?.message || String(err));
    } finally {
      setAliasSaving(false);
    }
  }, [mana, refresh]);

  const providerOptions = useMemo(() => {
    return providers.map((p) => ({ id: p.id || p.name, name: p.name, models: p.models || [] }));
  }, [providers]);

  const renderProviderRow = (p) => {
    const isActive = p.active;
    const isBusyUse = busyAction === `use:${p.name}`;
    const isBusyRemove = busyAction === `remove:${p.name}`;
    const isExpanded = expandedProviders.has(p.name);
    const displayUrl = !p.baseUrl || p.baseUrl.startsWith('(')
      ? '默认 https://api.anthropic.com'
      : p.baseUrl;
    const displayType = p.type === 'anthropic' ? 'Anthropic-compatible' : 'OpenAI-compatible';

    return (
      <div key={p.name}>
        <div
          className={`flex items-center gap-3 px-3 py-2 rounded border cursor-pointer ${
            isActive
              ? 'border-primary-500 bg-primary-500/10'
              : 'border-vscode-panel-border bg-vscode-sidebar/30'
          }`}
          onClick={() => toggleExpand(p.name)}
        >
          <div className="shrink-0">
            {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
          </div>
          <div className="w-4 shrink-0 flex items-center justify-center">
            {isActive ? (
              <Check size={14} className="text-primary-400" />
            ) : (
              <span className="w-3 h-3 rounded-full border border-gray-500" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-200 font-medium truncate">{p.name}</div>
            <div className="text-[11px] text-gray-500 truncate font-mono">{displayUrl}</div>
            <div className="text-[10px] text-gray-600 truncate">协议: {displayType}</div>
          </div>
          {isActive ? (
            <span className="text-[10px] uppercase tracking-wide text-primary-400 shrink-0">使用中</span>
          ) : (
            <Button
              size="sm"
              variant="flat"
              onClick={(e) => { e.stopPropagation(); handleUse(p.name); }}
              isDisabled={!!busyAction}
              isLoading={isBusyUse}
            >
              使用
            </Button>
          )}
          <Button
            size="sm"
            variant="light"
            color="danger"
            isIconOnly
            onClick={(e) => { e.stopPropagation(); handleRemove(p.name); }}
            isDisabled={!!busyAction || p.isBuiltin}
            isLoading={isBusyRemove}
            aria-label={`删除 ${p.name}`}
          >
            <Trash2 size={14} />
          </Button>
        </div>

        {isExpanded && (
          <div className="mt-1 ml-4 border-l border-vscode-panel-border pl-3 space-y-2">
            <div className="text-[11px] text-gray-400 font-medium pt-1">模型列表</div>
            {(p.models || []).length === 0 ? (
              <div className="text-[11px] text-gray-500 italic">暂无模型</div>
            ) : (
              <div className="space-y-1">
                {(p.models || []).map((m) => (
                  <div key={m.id} className="flex items-center justify-between text-[11px] text-gray-300 bg-vscode-sidebar/20 rounded px-2 py-1">
                    <div className="truncate">
                      <span className="font-mono text-gray-400">{m.id}</span>
                      {m.name !== m.id && <span className="ml-1 text-gray-500">({m.name})</span>}
                      <span className="ml-2 text-gray-600">ctx={m.contextWindow || '?'}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="light"
                      color="danger"
                      isIconOnly
                      className="min-w-0 w-5 h-5"
                      onPress={() => handleRemoveModel(p.name, m.id)}
                      isDisabled={!!busyAction}
                    >
                      <X size={10} />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Input
                size="sm"
                placeholder="模型 ID"
                className="text-[11px] font-mono"
                value={modelForm.providerId === (p.id || p.name) ? modelForm.id : ''}
                onChange={(e) => setModelForm({ providerId: p.id || p.name, id: e.target.value, name: modelForm.name, contextWindow: modelForm.contextWindow })}
              />
              <Input
                size="sm"
                placeholder="显示名称"
                className="text-[11px]"
                value={modelForm.providerId === (p.id || p.name) ? modelForm.name : ''}
                onChange={(e) => setModelForm((s) => ({ ...s, providerId: p.id || p.name, name: e.target.value }))}
              />
              <Input
                size="sm"
                type="number"
                placeholder="上下文"
                className="text-[11px] w-20"
                value={modelForm.providerId === (p.id || p.name) ? modelForm.contextWindow : 200000}
                onChange={(e) => setModelForm((s) => ({ ...s, providerId: p.id || p.name, contextWindow: Number(e.target.value) }))}
              />
              <Button
                size="sm"
                variant="flat"
                isIconOnly
                onPress={() => handleAddModel(p.name)}
                isDisabled={!!busyAction}
                aria-label="添加模型"
              >
                <Plus size={12} />
              </Button>
              {!p.isBuiltin && (
                <Button
                  size="sm"
                  variant="flat"
                  isIconOnly
                  onPress={() => handleDiscover(p.name)}
                  isDisabled={!!busyAction}
                  isLoading={busyAction === `discover:${p.name}`}
                  aria-label="自动发现"
                  title="自动发现"
                >
                  <Wand2 size={12} />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderAddForm = () => (
    <div className="border border-vscode-panel-border bg-vscode-sidebar/30 rounded p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-300">添加供应商</span>
        <Button
          size="sm"
          variant="light"
          isIconOnly
          onPress={() => { setShowAddForm(false); setError(''); }}
          aria-label="关闭"
        >
          <X size={14} />
        </Button>
      </div>
      <Input
        size="sm"
        label="名称"
        placeholder="例如 anthropic / kimi-k2.6 / deepseek-v4"
        value={addForm.name}
        onChange={(e) => setAddForm((s) => ({ ...s, name: e.target.value }))}
      />
      <label className="text-xs text-gray-400 block">
        协议类型
        <select
          className="mt-1 w-full rounded border border-vscode-panel-border bg-vscode-sidebar px-2 py-1.5 text-sm text-gray-200"
          value={addForm.type}
          onChange={(e) => setAddForm((s) => ({ ...s, type: e.target.value }))}
        >
          <option value="openai-compat">OpenAI-compatible</option>
          <option value="anthropic">Anthropic-compatible</option>
        </select>
      </label>
      <Input
        size="sm"
        label="Base URL"
        placeholder="https://api.anthropic.com（留空使用默认）"
        className="font-mono"
        value={addForm.baseUrl}
        onChange={(e) => setAddForm((s) => ({ ...s, baseUrl: e.target.value }))}
      />
      <Input
        size="sm"
        type="password"
        label="API Key"
        placeholder="sk-..."
        className="font-mono"
        value={addForm.apiKey}
        onChange={(e) => setAddForm((s) => ({ ...s, apiKey: e.target.value }))}
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="flat" onPress={() => { setShowAddForm(false); setError(''); }}>
          取消
        </Button>
        <Button
          size="sm"
          color="primary"
          onPress={handleAdd}
          isLoading={busyAction === 'add'}
          isDisabled={!addForm.name.trim() || !!busyAction}
        >
          添加
        </Button>
      </div>
    </div>
  );

  const renderAliasCard = (alias) => {
    const selectedProvider = providerOptions.find((p) => p.id === alias.providerId);
    const models = selectedProvider?.models || [];

    return (
      <div key={alias.id} className="border border-vscode-panel-border bg-vscode-sidebar/20 rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-gray-300 uppercase tracking-wide">{alias.displayName || alias.id}</span>
          <span className="text-[10px] text-gray-500 font-mono">{alias.id}</span>
        </div>

        <div className="space-y-1.5">
          <div>
            <label className="text-[10px] text-gray-500 block mb-0.5">供应商</label>
            <select
              className="w-full text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200"
              value={alias.providerId || ''}
              onChange={(e) => updateAliasField(alias.id, 'providerId', e.target.value)}
            >
              <option value="">-- 选择供应商 --</option>
              {providerOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-gray-500 block mb-0.5">模型</label>
            <select
              className="w-full text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200"
              value={alias.modelId || ''}
              onChange={(e) => updateAliasField(alias.id, 'modelId', e.target.value)}
            >
              <option value="">-- 选择模型 --</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">上下文长度</label>
              <input
                type="number"
                className="w-full text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200 outline-none focus:border-primary-500"
                value={alias.contextWindow || ''}
                onChange={(e) => updateAliasField(alias.id, 'contextWindow', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">最大输出 Tokens</label>
              <input
                type="number"
                className="w-full text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200 outline-none focus:border-primary-500"
                value={alias.maxOutputTokens || ''}
                onChange={(e) => updateAliasField(alias.id, 'maxOutputTokens', Number(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary-500 w-3.5 h-3.5"
                checked={!!alias.thinking}
                onChange={(e) => updateAliasField(alias.id, 'thinking', e.target.checked)}
              />
              <span className="text-[11px] text-gray-300">思考模式</span>
            </label>
            {alias.thinking && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-500">预算</span>
                <input
                  type="number"
                  className="w-20 text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200 outline-none focus:border-primary-500"
                  value={alias.thinkingBudget || 0}
                  onChange={(e) => updateAliasField(alias.id, 'thinkingBudget', Number(e.target.value))}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">温度 (0-2)</label>
              <input
                type="number"
                step={0.1}
                min={0}
                max={2}
                className="w-full text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200 outline-none focus:border-primary-500"
                value={alias.temperature ?? 0.7}
                onChange={(e) => updateAliasField(alias.id, 'temperature', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Effort Level</label>
              <select
                className="w-full text-xs bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-gray-200 outline-none focus:border-primary-500"
                value={alias.effortLevel || 'high'}
                onChange={(e) => updateAliasField(alias.id, 'effortLevel', e.target.value)}
              >
                <option value="low">low</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="h-9 px-3 flex items-center justify-between border-b border-vscode-panel-border bg-vscode-sidebar shrink-0">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-gray-400" />
          <span className="text-xs font-bold text-gray-400 uppercase">模型供应商</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl space-y-4">
          {error ? (
            <div className="border border-rose-500/40 bg-rose-500/10 rounded px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-6">
              <Spinner size="sm" aria-label="正在加载供应商" /> 正在加载供应商…
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-gray-300">Claude Code 模型供应商</div>
                    {current ? (
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        当前：<span className="text-gray-300">{current.name}</span>
                        {current.type ? (
                          <span> · {current.type === 'anthropic' ? 'Anthropic-compatible' : 'OpenAI-compatible'}</span>
                        ) : null}
                        {current.baseUrl ? (
                          <span className="font-mono"> · {current.baseUrl}</span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="text-[11px] text-gray-500 mt-0.5">尚未选择供应商</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="flat"
                      onPress={refresh}
                      isDisabled={loading || !!busyAction}
                      isIconOnly
                      aria-label="刷新"
                    >
                      <RefreshCw size={12} />
                    </Button>
                    {!showAddForm ? (
                      <Button
                        size="sm"
                        variant="flat"
                        onPress={() => setShowAddForm(true)}
                        startContent={<Plus size={12} />}
                      >
                        添加供应商
                      </Button>
                    ) : null}
                  </div>
                </div>

                {showAddForm ? renderAddForm() : null}

                <div className="space-y-1.5">
                  {providers.length === 0 ? (
                    <div className="text-xs text-gray-500 italic px-2 py-3">
                      暂无供应商。点击「添加供应商」开始配置。
                    </div>
                  ) : (
                    providers.map(renderProviderRow)
                  )}
                </div>
              </div>

              {/* Alias Configuration */}
              <div className="border-t border-vscode-panel-border pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-gray-300">Alias 配置</div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="light"
                      isIconOnly
                      onPress={handleResetAliases}
                      isDisabled={aliasSaving}
                      aria-label="重置默认值"
                      title="重置默认值"
                    >
                      <RotateCcw size={12} />
                    </Button>
                    <Button
                      size="sm"
                      color="primary"
                      onPress={handleSaveAliases}
                      isLoading={aliasSaving}
                      startContent={<Save size={12} />}
                    >
                      保存 Alias 配置
                    </Button>
                  </div>
                </div>

                {aliasError ? (
                  <div className="border border-rose-500/40 bg-rose-500/10 rounded px-3 py-2 text-xs text-rose-300">
                    {aliasError}
                  </div>
                ) : null}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {aliases.map(renderAliasCard)}
                </div>
              </div>

              <div className="text-[11px] text-gray-500 leading-relaxed border-t border-vscode-panel-border pt-3 space-y-1">
                <p>
                  ℹ 供应商配置保存在应用数据目录，环境变量写入 <span className="font-mono">~/.ccs/current-env.json</span> 以供 Claude Code 读取。
                </p>
                <p>
                  如需为单个 Subagent 配置不同的模型 / Tier，请在上方 Alias 区域调整对应 tier 的映射。
                </p>
                <p>
                  自动发现仅支持 OpenAI-compatible 接口（/v1/models）。Anthropic 模型需手动维护。
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
