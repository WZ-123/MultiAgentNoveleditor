import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner, Chip } from '@heroui/react';
import {
  Activity, Check, ChevronDown, ChevronRight, Copy, Cpu, KeyRound,
  Plus, RefreshCw, Save, ShieldAlert, TestTube2, Trash2, Wand2, X,
} from 'lucide-react';

const DRIVER_IDS = ['direct-api', 'claude-code-vscode', 'claude-code-cli', 'codex'];
const SYSTEM_TASKS = [
  ['chat', '主聊天'],
  ['import-analysis', '导入分析'],
  ['character-enrichment', '角色联网补全'],
  ['chatbox-extraction', 'Chatbox 整理'],
  ['config-helper', '配置助手'],
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function newProvider() {
  return { id: '', name: '', adapterId: 'openai-chat-completions', baseUrl: '', apiKey: '', auth: { mode: 'bearer' }, models: [] };
}

function targetId(prefix = 'target') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function newProfile(providers) {
  const provider = providers?.[0];
  const model = provider?.models?.[0];
  return {
    id: '',
    name: '',
    description: '',
    workloadTags: ['reasoning'],
    priority: 'balanced',
    targetsByDriver: provider && model ? {
      'direct-api': {
        primary: {
          id: targetId('direct'), providerId: provider.id, modelId: model.id,
          params: { contextLimit: model.capabilities?.contextWindow || 128000, maxOutputTokens: model.capabilities?.maxOutputTokens || 4096, temperature: 0.7, thinking: false, thinkingBudget: 0 },
        },
        fallbacks: [],
      },
    } : {},
  };
}

function sectionButton(active, onClick, Icon, children) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs whitespace-nowrap ${active ? 'bg-primary-500/20 text-primary-300' : 'text-gray-400 hover:bg-vscode-list-hoverBackground'}`}
    >
      <Icon size={13} /> {children}
    </button>
  );
}

function ProviderEditor({ provider, snapshot, discovered, busy, onChange, onCancel, onSave, onTest, onDiscover, onApplyDiscovery, onClearKey }) {
  const updateModel = (idx, patch) => {
    const models = clone(provider.models || []);
    models[idx] = { ...models[idx], ...patch, capabilities: { ...(models[idx]?.capabilities || {}), ...(patch.capabilities || {}) } };
    onChange({ ...provider, models });
  };
  const removeModel = (idx) => onChange({ ...provider, models: (provider.models || []).filter((_item, index) => index !== idx) });
  const addModel = () => onChange({
    ...provider,
    models: [...(provider.models || []), { id: '', name: '', capabilities: { contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsTools: true, supportsStreaming: true } }],
  });
  return (
    <div data-testid="provider-editor" className="border border-primary-500/30 rounded p-4 space-y-3 bg-vscode-sidebar/30">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-200">{provider.id ? `编辑 ${provider.name}` : '新增 Provider'}</div>
        <Button isIconOnly size="sm" variant="light" onPress={onCancel}><X size={14} /></Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input size="sm" label="名称" value={provider.name || ''} onChange={(e) => onChange({ ...provider, name: e.target.value })} />
        <label className="text-xs text-gray-500">
          Adapter
          <select className="mt-1 w-full bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-2 text-gray-200" value={provider.adapterId} onChange={(e) => onChange({ ...provider, adapterId: e.target.value, auth: { ...(provider.auth || {}), mode: e.target.value === 'anthropic-messages' ? 'x-api-key' : 'bearer' } })}>
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="openai-chat-completions">OpenAI Chat Completions</option>
          </select>
        </label>
        <Input className="md:col-span-2 font-mono" size="sm" label="Base URL" value={provider.baseUrl || ''} placeholder="https://api.example.com/v1" onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })} />
        <Input className="font-mono" size="sm" type="password" label={provider.auth?.hasApiKey ? 'API Key（留空保持不变）' : 'API Key'} value={provider.apiKey || ''} onChange={(e) => onChange({ ...provider, apiKey: e.target.value })} />
        <div className="flex items-end gap-2">
          {provider.id && <Button size="sm" variant="flat" onPress={onTest} isLoading={busy === 'test-provider'} startContent={<TestTube2 size={12} />}>验证连接</Button>}
          {provider.id && provider.auth?.hasApiKey && <Button size="sm" color="danger" variant="light" onPress={onClearKey}>清空密钥</Button>}
        </div>
      </div>
      {provider.auth?.keyStatus && !['missing', null].includes(provider.auth.keyStatus) && !provider.auth?.hasApiKey && (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded px-3 py-2 text-xs text-amber-200">
          已发现旧的 API Key 记录，但系统安全存储无法读取。请重新输入 API Key 并保存。
        </div>
      )}

      <div className="border-t border-vscode-panel-border pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-gray-300">模型与能力</div>
          <div className="flex gap-2">
            <Button size="sm" variant="flat" onPress={addModel} startContent={<Plus size={12} />}>手动添加</Button>
            {provider.id && <Button size="sm" variant="flat" onPress={onDiscover} isLoading={busy === 'discover'} startContent={<Wand2 size={12} />}>发现模型</Button>}
          </div>
        </div>
        {(provider.models || []).map((model, idx) => (
          <div key={`${model.id}-${idx}`} className="grid grid-cols-12 gap-2 items-center text-xs">
            <input className="col-span-3 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 font-mono" placeholder="模型 ID" value={model.id || ''} onChange={(e) => updateModel(idx, { id: e.target.value })} />
            <input className="col-span-3 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1" placeholder="显示名称" value={model.name || ''} onChange={(e) => updateModel(idx, { name: e.target.value })} />
            <input type="number" className="col-span-2 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1" title="上下文" value={model.capabilities?.contextWindow || ''} onChange={(e) => updateModel(idx, { capabilities: { contextWindow: Number(e.target.value) } })} />
            <input type="number" className="col-span-2 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1" title="最大输出" value={model.capabilities?.maxOutputTokens || ''} onChange={(e) => updateModel(idx, { capabilities: { maxOutputTokens: Number(e.target.value) } })} />
            <label className="col-span-1 flex items-center gap-1 text-[10px] text-gray-400"><input type="checkbox" checked={!!model.capabilities?.supportsThinking} onChange={(e) => updateModel(idx, { capabilities: { supportsThinking: e.target.checked } })} />思考</label>
            <Button className="col-span-1" isIconOnly size="sm" variant="light" color="danger" onPress={() => removeModel(idx)}><Trash2 size={12} /></Button>
          </div>
        ))}
        {!provider.models?.length && <div className="text-xs text-gray-500">尚无模型。保存 Provider 后可发现模型，或手动添加。</div>}
      </div>

      {discovered?.models?.length ? (
        <div className="border border-emerald-500/30 rounded p-3 bg-emerald-500/5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-emerald-300">发现 {discovered.models.length} 个模型，尚未写入配置。</span>
            <Button size="sm" color="success" variant="flat" onPress={onApplyDiscovery}>应用发现结果</Button>
          </div>
          <div className="mt-2 max-h-24 overflow-y-auto font-mono text-[10px] text-gray-400">{discovered.models.map((model) => model.id).join(' · ')}</div>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="flat" onPress={onCancel}>取消</Button>
        <Button size="sm" color="primary" onPress={onSave} isLoading={busy === 'save-provider'} startContent={<Save size={12} />}>保存 Provider</Button>
      </div>
    </div>
  );
}

function TargetEditor({ driverId, group, providers, onChange }) {
  const isDirect = driverId === 'direct-api';
  const targets = [group.primary, ...(group.fallbacks || [])];
  const updateTarget = (idx, patch) => {
    const next = clone(group);
    if (idx === 0) next.primary = { ...next.primary, ...patch, params: { ...(next.primary.params || {}), ...(patch.params || {}) } };
    else next.fallbacks[idx - 1] = { ...next.fallbacks[idx - 1], ...patch, params: { ...(next.fallbacks[idx - 1].params || {}), ...(patch.params || {}) } };
    onChange(next);
  };
  const addFallback = () => onChange({ ...group, fallbacks: [...(group.fallbacks || []), { ...clone(group.primary), id: targetId(`${driverId}-fallback`) }] });
  const removeFallback = (idx) => onChange({ ...group, fallbacks: group.fallbacks.filter((_item, index) => index !== idx - 1) });
  return (
    <div className="border border-vscode-panel-border rounded p-3 space-y-2">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold text-gray-300">{driverId}</span><Button size="sm" variant="light" onPress={addFallback}>+ 备用目标</Button></div>
      {targets.map((target, idx) => {
        const selectedProvider = providers.find((provider) => provider.id === target.providerId);
        return (
          <div key={target.id} className="grid grid-cols-12 gap-2 items-center border-t border-vscode-panel-border/50 pt-2">
            <span className="col-span-1 text-[10px] text-gray-500">{idx === 0 ? '主' : `备${idx}`}</span>
            {isDirect ? (
              <>
                <select className="col-span-3 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={target.providerId || ''} onChange={(e) => { const provider = providers.find((item) => item.id === e.target.value); updateTarget(idx, { providerId: e.target.value, modelId: provider?.models?.[0]?.id || '' }); }}>
                  <option value="">选择 Provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
                <select className="col-span-3 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={target.modelId || ''} onChange={(e) => { const model = selectedProvider?.models?.find((item) => item.id === e.target.value); updateTarget(idx, { modelId: e.target.value, params: { contextLimit: model?.capabilities?.contextWindow, maxOutputTokens: model?.capabilities?.maxOutputTokens, thinking: false, thinkingBudget: 0 } }); }}>
                  <option value="">选择模型</option>{(selectedProvider?.models || []).map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
                </select>
                <input type="number" title="最大输出 Tokens" className="col-span-2 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={target.params?.maxOutputTokens || ''} onChange={(e) => updateTarget(idx, { params: { maxOutputTokens: Number(e.target.value) } })} />
                <label className="col-span-2 text-[10px] text-gray-400 flex items-center gap-1"><input type="checkbox" checked={!!target.params?.thinking} onChange={(e) => updateTarget(idx, { params: { thinking: e.target.checked, thinkingBudget: e.target.checked ? (target.params?.thinkingBudget || 16000) : 0 } })} />思考</label>
              </>
            ) : (
              <>
                <input className="col-span-5 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs font-mono" placeholder="Driver 模型 ID" value={target.modelId || ''} onChange={(e) => updateTarget(idx, { modelId: e.target.value })} />
                <select className="col-span-3 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={target.params?.effortLevel || 'high'} onChange={(e) => updateTarget(idx, { params: { effortLevel: e.target.value } })}><option value="low">low</option><option value="high">high</option><option value="max">max</option></select>
                <span className="col-span-2 text-[10px] text-gray-600">Driver 自有认证</span>
              </>
            )}
            {idx > 0 && <Button className="col-span-1" isIconOnly size="sm" variant="light" color="danger" onPress={() => removeFallback(idx)}><X size={11} /></Button>}
          </div>
        );
      })}
    </div>
  );
}

function ProfileEditor({ profile, providers, busy, onChange, onCancel, onSave, onTest }) {
  const setDriverEnabled = (driverId, enabled) => {
    const targetsByDriver = clone(profile.targetsByDriver || {});
    if (!enabled) delete targetsByDriver[driverId];
    else if (!targetsByDriver[driverId]) {
      const provider = providers[0];
      const model = provider?.models?.[0];
      targetsByDriver[driverId] = {
        primary: { id: targetId(driverId), ...(driverId === 'direct-api' ? { providerId: provider?.id || '', modelId: model?.id || '', params: { contextLimit: model?.capabilities?.contextWindow || 128000, maxOutputTokens: model?.capabilities?.maxOutputTokens || 4096, temperature: 0.7 } } : { modelId: '', params: { effortLevel: 'high' } }) },
        fallbacks: [],
      };
    }
    onChange({ ...profile, targetsByDriver });
  };
  return (
    <div data-testid="profile-editor" className="border border-primary-500/30 rounded p-4 space-y-3 bg-vscode-sidebar/30">
      <div className="flex items-center justify-between"><div className="text-sm font-semibold text-gray-200">{profile.id ? `编辑档案 · ${profile.name}` : '新增模型档案'}</div><Button isIconOnly size="sm" variant="light" onPress={onCancel}><X size={14} /></Button></div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input size="sm" label="档案名称" value={profile.name || ''} onChange={(e) => onChange({ ...profile, name: e.target.value })} />
        <Input size="sm" label="说明" value={profile.description || ''} onChange={(e) => onChange({ ...profile, description: e.target.value })} />
        <label className="text-xs text-gray-500">优先目标<select className="mt-1 w-full bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-2 text-gray-200" value={profile.priority || 'balanced'} onChange={(e) => onChange({ ...profile, priority: e.target.value })}><option value="quality">质量</option><option value="balanced">均衡</option><option value="cost">成本</option><option value="latency">延迟</option></select></label>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-400">{DRIVER_IDS.map((driverId) => <label key={driverId} className="flex items-center gap-1"><input type="checkbox" checked={!!profile.targetsByDriver?.[driverId]} onChange={(e) => setDriverEnabled(driverId, e.target.checked)} />{driverId}</label>)}</div>
      {DRIVER_IDS.filter((driverId) => profile.targetsByDriver?.[driverId]).map((driverId) => <TargetEditor key={driverId} driverId={driverId} group={profile.targetsByDriver[driverId]} providers={providers} onChange={(group) => onChange({ ...profile, targetsByDriver: { ...profile.targetsByDriver, [driverId]: group } })} />)}
      <div className="flex justify-end gap-2"><Button size="sm" variant="flat" onPress={onCancel}>取消</Button>{profile.id && <Button size="sm" variant="flat" onPress={onTest} isLoading={busy === 'test-profile'} startContent={<TestTube2 size={12} />}>最小推理测试</Button>}<Button size="sm" color="primary" onPress={onSave} isLoading={busy === 'save-profile'} startContent={<Save size={12} />}>保存档案</Button></div>
    </div>
  );
}

export function ProviderSettingsPanel() {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [snapshot, setSnapshot] = useState(null);
  const [subagents, setSubagents] = useState([]);
  const [driver, setDriver] = useState(null);
  const [section, setSection] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [providerDraft, setProviderDraft] = useState(null);
  const [profileDraft, setProfileDraft] = useState(null);
  const [discovered, setDiscovered] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [routingDraft, setRoutingDraft] = useState(null);
  const [replacement, setReplacement] = useState('');

  const refresh = useCallback(async () => {
    if (!mana?.modelConfig) { setError('模型配置 IPC 不可用'); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const [next, subs, activeDriver] = await Promise.all([
        mana.modelConfig.snapshot(),
        mana.config?.listSubagents?.().catch(() => []),
        mana.runtime?.getActiveDriver?.().catch(() => null),
      ]);
      setSnapshot(next); setRoutingDraft(clone(next.routing)); setSubagents(subs || []); setDriver(activeDriver);
      if (typeof window !== 'undefined' && !window.localStorage.getItem('mana-model-config-v3-local-migrated')) {
        const raw = window.localStorage.getItem('mana-agent-api-config-v2');
        if (raw) {
          const result = await mana.modelConfig.importLegacyRendererConfig(JSON.parse(raw));
          if (result.imported) {
            const migrated = await mana.modelConfig.snapshot();
            setSnapshot(migrated);
            setRoutingDraft(clone(migrated.routing));
            setNotice(`已安全迁移 ${result.imported} 条旧 Agent API 配置。`);
          }
        }
        window.localStorage.setItem('mana-model-config-v3-local-migrated', '1');
      }
    } catch (err) { setError(err.message || String(err)); }
    finally { setLoading(false); }
  }, [mana]);

  useEffect(() => { refresh(); }, [refresh]);

  const providers = snapshot?.providers || [];
  const profiles = snapshot?.profiles || [];
  const profileMap = useMemo(() => Object.fromEntries(profiles.map((profile) => [profile.id, profile])), [profiles]);

  const act = useCallback(async (key, fn, success) => {
    setBusy(key); setError(''); setNotice('');
    try { const result = await fn(); if (result?.schemaVersion) { setSnapshot(result); setRoutingDraft(clone(result.routing)); } if (success) setNotice(success); return result; }
    catch (err) { setError(err.message || String(err)); return null; }
    finally { setBusy(''); }
  }, []);

  const saveProvider = async () => {
    const payload = clone(providerDraft);
    if (!payload.name?.trim()) { setError('Provider 名称不能为空'); return; }
    if (!payload.apiKey) delete payload.apiKey;
    const next = await act('save-provider', () => mana.modelConfig.saveProvider(payload, snapshot.revision), 'Provider 已保存');
    if (!next) return;
    setProviderDraft(null); setDiscovered(null);
  };

  const discover = async () => {
    const result = await act('discover', () => mana.modelConfig.discoverModels(providerDraft.id));
    if (!result) return;
    if (!result.ok) { setError(result.error || '模型发现失败'); return; }
    setDiscovered(result); setNotice(`发现 ${result.models.length} 个模型，请确认后应用。`);
  };

  const applyDiscovery = async () => {
    const next = await act('apply-discovery', () => mana.modelConfig.applyDiscoveredModels(providerDraft.id, discovered.models, snapshot.revision), '模型发现结果已应用');
    if (!next) return;
    setProviderDraft(clone(next.providers.find((provider) => provider.id === providerDraft.id)));
    setDiscovered(null);
  };

  const saveProfile = async () => {
    if (!profileDraft.name?.trim()) { setError('档案名称不能为空'); return; }
    const next = await act('save-profile', () => mana.modelConfig.saveProfile(profileDraft, snapshot.revision), '模型档案已保存');
    if (!next) return;
    setProfileDraft(null);
  };

  const saveRouting = async () => {
    const next = await act('save-routing', () => mana.modelConfig.saveRouting(routingDraft, snapshot.revision), '模型分配已保存');
    if (!next) return;
    setRoutingDraft(clone(next.routing));
  };

  const recommendProfile = (subagent) => {
    const workload = subagent.modelRequirements?.workload;
    const priority = subagent.modelRequirements?.priority;
    return profiles.find((profile) => profile.workloadTags?.includes(workload) && profile.priority === priority)
      || profiles.find((profile) => profile.workloadTags?.includes(workload))
      || profiles.find((profile) => profile.priority === priority)
      || profiles[0];
  };

  if (loading) return <div className="h-full flex items-center justify-center gap-2 text-sm text-gray-400"><Spinner size="sm" /> 正在加载模型中心…</div>;

  return (
    <div data-testid="model-center" className="flex flex-col h-full overflow-hidden">
      <div className="h-11 px-4 flex items-center justify-between border-b border-vscode-panel-border bg-vscode-sidebar shrink-0">
        <div className="flex items-center gap-2 whitespace-nowrap"><Cpu size={15} className="text-primary-400 shrink-0" /><span className="text-sm font-bold text-gray-300">模型中心</span><Chip size="sm" variant="flat">Schema v{snapshot?.schemaVersion}</Chip></div>
        <div className="flex items-center gap-1">{sectionButton(section === 'overview', () => setSection('overview'), Activity, '总览')}{sectionButton(section === 'providers', () => setSection('providers'), KeyRound, 'Provider')}{sectionButton(section === 'profiles', () => setSection('profiles'), Cpu, '模型档案')}{sectionButton(section === 'assignments', () => setSection('assignments'), Wand2, '分配矩阵')}<Button size="sm" isIconOnly variant="light" onPress={refresh}><RefreshCw size={13} /></Button></div>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-5xl mx-auto space-y-4">
          {error && <div className="border border-rose-500/40 bg-rose-500/10 rounded px-3 py-2 text-xs text-rose-300">{error}</div>}
          {notice && <div className="border border-emerald-500/40 bg-emerald-500/10 rounded px-3 py-2 text-xs text-emerald-200">{notice}</div>}
          {snapshot?.secretStatus?.storageMode === 'restricted-plaintext' && <div className="border border-amber-500/40 bg-amber-500/10 rounded px-3 py-2 text-xs text-amber-200 flex items-center gap-2"><ShieldAlert size={14} />系统安全存储不可用，密钥以受限权限（0600）保存在本机。</div>}

          {section === 'overview' && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                {[
                  ['当前 Driver', driver?.displayName || driver?.id || 'direct-api'],
                  ['默认档案', profileMap[snapshot?.routing?.defaultProfileId]?.name || '未配置'],
                  ['Provider', `${providers.length} 个`],
                  ['配置环境', snapshot?.environment?.kind === 'development' ? '开发版' : '安装版'],
                ].map(([label, value]) => <div key={label} className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/20"><div className="text-[10px] text-gray-500">{label}</div><div className="text-sm text-gray-200 mt-1 truncate">{value}</div></div>)}
              </div>
              <div className="border border-vscode-panel-border rounded p-4 space-y-2">
                <div className="text-sm font-semibold text-gray-300">系统任务路由</div>
                {SYSTEM_TASKS.map(([id, label]) => <div key={id} className="flex justify-between text-xs border-t border-vscode-panel-border/40 pt-2"><span className="text-gray-400">{label}</span><span className="text-gray-200">{profileMap[snapshot.routing.systemAssignments?.[id]]?.name || profileMap[snapshot.routing.defaultProfileId]?.name || '未配置'}</span></div>)}
              </div>
              <div className="text-[11px] text-gray-600 break-all">配置位置：{snapshot?.environment?.configRoot}</div>
            </>
          )}

          {section === 'providers' && (
            <>
              <div className="flex justify-between items-center"><div><div className="text-sm font-semibold text-gray-300">Provider 连接</div><div className="text-[11px] text-gray-500">Provider 只描述连接；实际模型选择由模型档案决定。</div></div><Button size="sm" color="primary" variant="flat" onPress={() => { setProviderDraft(newProvider()); setDiscovered(null); }} startContent={<Plus size={12} />}>新增 Provider</Button></div>
              {providerDraft && <ProviderEditor provider={providerDraft} snapshot={snapshot} discovered={discovered} busy={busy} onChange={setProviderDraft} onCancel={() => { setProviderDraft(null); setDiscovered(null); }} onSave={saveProvider} onTest={async () => { const result = await act('test-provider', () => mana.modelConfig.testProvider(providerDraft.id)); if (!result) return; if (!result.ok) { setError(result.error || '连接失败'); return; } setNotice(result.message || '连接成功'); }} onDiscover={discover} onApplyDiscovery={applyDiscovery} onClearKey={async () => { const next = await act('clear-key', () => mana.modelConfig.saveProvider({ id: providerDraft.id, name: providerDraft.name, adapterId: providerDraft.adapterId, baseUrl: providerDraft.baseUrl, apiKey: '' }, snapshot.revision), '密钥已清空'); if (!next) return; setProviderDraft(clone(next.providers.find((provider) => provider.id === providerDraft.id))); }} />}
              <div className="space-y-2">{providers.map((provider) => {
                const refs = profiles.flatMap((profile) => Object.values(profile.targetsByDriver || {}).flatMap((group) => [group.primary, ...(group.fallbacks || [])].filter((target) => target?.providerId === provider.id).map(() => profile.name)));
                return <div key={provider.id} className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/20"><div className="flex items-center gap-3"><button type="button" onClick={() => setExpanded((prev) => { const next = new Set(prev); next.has(provider.id) ? next.delete(provider.id) : next.add(provider.id); return next; })}>{expanded.has(provider.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><div className="flex-1 min-w-0"><div className="text-sm text-gray-200 font-medium">{provider.name}</div><div className="text-[10px] text-gray-500 font-mono truncate">{provider.baseUrl} · {provider.adapterId}</div></div><Chip size="sm" color={provider.auth?.hasApiKey ? 'success' : 'warning'} variant="flat">{provider.auth?.hasApiKey ? '密钥已保存' : '缺少密钥'}</Chip><Button size="sm" variant="flat" onPress={() => { setProviderDraft(clone(provider)); setDiscovered(null); }}>编辑</Button>{!provider.isBuiltin && <Button isIconOnly size="sm" color="danger" variant="light" onPress={async () => { if (!confirm(`删除 Provider「${provider.name}」？${refs.length ? `\n将把 ${refs.length} 个引用迁移到所选替代 Provider。` : ''}`)) return; await act('delete-provider', () => mana.modelConfig.deleteProvider(provider.id, refs.length ? replacement : null, snapshot.revision), 'Provider 已删除'); }}><Trash2 size={13} /></Button>}</div>{expanded.has(provider.id) && <div className="mt-3 pl-7 space-y-2"><div className="text-[11px] text-gray-500">模型：{provider.models.map((model) => model.id).join(' · ') || '无'}；引用档案：{[...new Set(refs)].join('、') || '无'}</div>{refs.length > 0 && !provider.isBuiltin && <label className="text-[11px] text-gray-500">删除时替换为：<select className="ml-2 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1" value={replacement} onChange={(e) => setReplacement(e.target.value)}><option value="">请选择</option>{providers.filter((item) => item.id !== provider.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</div>}</div>;
              })}</div>
            </>
          )}

          {section === 'profiles' && (
            <>
              <div className="flex justify-between items-center"><div><div className="text-sm font-semibold text-gray-300">语义模型档案</div><div className="text-[11px] text-gray-500">同一档案可为不同 Driver 指定不同模型，并配置显式备用链。</div></div><Button size="sm" color="primary" variant="flat" onPress={() => setProfileDraft(newProfile(providers))} startContent={<Plus size={12} />}>新增档案</Button></div>
              {profileDraft && <ProfileEditor profile={profileDraft} providers={providers} busy={busy} onChange={setProfileDraft} onCancel={() => setProfileDraft(null)} onSave={saveProfile} onTest={async () => { if (!confirm('最小推理测试会发送一条极短请求，可能产生少量 API 费用。继续吗？')) return; const result = await act('test-profile', () => mana.modelConfig.testProfile(profileDraft.id)); if (!result) return; setNotice(`测试成功：${result.modelId}${result.requestId ? ` · ${result.requestId}` : ''}`); }} />}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{profiles.map((profile) => {
                const refs = Object.values(snapshot.routing.systemAssignments || {}).filter((id) => id === profile.id).length + Object.values(snapshot.routing.subagentAssignments || {}).filter((id) => id === profile.id).length + (snapshot.routing.defaultProfileId === profile.id ? 1 : 0);
                return <div key={profile.id} className="border border-vscode-panel-border rounded p-4 bg-vscode-sidebar/20 space-y-2"><div className="flex items-center gap-2"><div className="flex-1"><div className="text-sm font-semibold text-gray-200">{profile.name}</div><div className="text-[10px] text-gray-500">{profile.description}</div></div><Chip size="sm" variant="flat">{profile.priority}</Chip></div><div className="flex flex-wrap gap-1">{Object.keys(profile.targetsByDriver || {}).map((id) => <Chip key={id} size="sm" variant="bordered">{id}</Chip>)}</div><div className="text-[10px] text-gray-600">{refs} 处引用 · {profile.id}</div><div className="flex justify-end gap-2"><Button size="sm" variant="light" onPress={() => setProfileDraft({ ...clone(profile), id: '', name: `${profile.name} 副本` })} startContent={<Copy size={11} />}>复制</Button><Button size="sm" variant="flat" onPress={() => setProfileDraft(clone(profile))}>编辑</Button><Button size="sm" color="danger" variant="light" onPress={async () => { const alternatives = profiles.filter((item) => item.id !== profile.id); const replacementId = refs ? alternatives[0]?.id : null; if (!confirm(`删除档案「${profile.name}」？${refs ? `\n${refs} 处引用将迁移到「${profileMap[replacementId]?.name || '无'}」。` : ''}`)) return; await act('delete-profile', () => mana.modelConfig.deleteProfile(profile.id, replacementId, snapshot.revision), '模型档案已删除'); }} isDisabled={profiles.length <= 1}><Trash2 size={11} /></Button></div></div>;
              })}</div>
            </>
          )}

          {section === 'assignments' && routingDraft && (
            <>
              <div className="flex justify-between items-center"><div><div className="text-sm font-semibold text-gray-300">模型分配矩阵</div><div className="text-[11px] text-gray-500">推荐只填入待保存状态，不会在运行时自动改模。</div></div><div className="flex gap-2"><Button size="sm" variant="flat" onPress={() => setRoutingDraft((routing) => { const next = clone(routing); for (const subagent of subagents) { const recommended = recommendProfile(subagent); if (recommended) next.subagentAssignments[subagent.id] = recommended.id; } return next; })} startContent={<Wand2 size={12} />}>应用全部推荐</Button><Button size="sm" color="primary" onPress={saveRouting} isLoading={busy === 'save-routing'} startContent={<Save size={12} />}>保存分配</Button></div></div>
              <div className="border border-vscode-panel-border rounded overflow-hidden"><div className="grid grid-cols-12 gap-2 px-3 py-2 bg-vscode-sidebar text-[10px] uppercase text-gray-500"><span className="col-span-4">对象</span><span className="col-span-3">需求</span><span className="col-span-5">模型档案</span></div>
                <div className="grid grid-cols-12 gap-2 px-3 py-2 items-center border-t border-vscode-panel-border/50"><span className="col-span-4 text-xs text-gray-300">全局默认</span><span className="col-span-3 text-[10px] text-gray-500">未显式绑定时使用</span><select className="col-span-5 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={routingDraft.defaultProfileId || ''} onChange={(e) => setRoutingDraft({ ...routingDraft, defaultProfileId: e.target.value })}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></div>
                {SYSTEM_TASKS.map(([id, label]) => <div key={id} className="grid grid-cols-12 gap-2 px-3 py-2 items-center border-t border-vscode-panel-border/50"><span className="col-span-4 text-xs text-gray-300">{label}</span><span className="col-span-3 text-[10px] text-gray-500">系统任务</span><select className="col-span-5 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={routingDraft.systemAssignments?.[id] || routingDraft.defaultProfileId} onChange={(e) => setRoutingDraft({ ...routingDraft, systemAssignments: { ...routingDraft.systemAssignments, [id]: e.target.value } })}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></div>)}
                {subagents.map((subagent) => { const recommended = recommendProfile(subagent); const selected = routingDraft.subagentAssignments?.[subagent.id] || ''; return <div key={subagent.id} className="grid grid-cols-12 gap-2 px-3 py-2 items-center border-t border-vscode-panel-border/50"><div className="col-span-4"><div className="text-xs text-gray-300">{subagent.displayName || subagent.id}</div><div className="text-[9px] text-gray-600 font-mono">{subagent.id}</div></div><div className="col-span-3 text-[10px] text-gray-500">{subagent.modelRequirements?.workload || '未标注'} · {subagent.modelRequirements?.priority || 'balanced'}</div><div className="col-span-5 flex gap-2"><select className="flex-1 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-xs" value={selected} onChange={(e) => setRoutingDraft({ ...routingDraft, subagentAssignments: { ...routingDraft.subagentAssignments, [subagent.id]: e.target.value } })}><option value="">使用全局默认</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>{recommended && recommended.id !== selected && <Button size="sm" variant="light" onPress={() => setRoutingDraft({ ...routingDraft, subagentAssignments: { ...routingDraft.subagentAssignments, [subagent.id]: recommended.id } })}>推荐：{recommended.name}</Button>}</div></div>; })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
