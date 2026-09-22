import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, RefreshCw, X } from 'lucide-react';

const fieldClass = 'mt-1 w-full min-w-0 rounded-lg border border-white/10 bg-[#181b22] px-3 py-2 text-sm text-gray-100';
const cardClass = 'rounded-xl border border-white/10 bg-white/[0.025] p-4';
const stages = { discover: '检测模型列表', select: '选择模型', responses: '验证文本', tools: '验证小说工具', activate: '启用模型', complete: '配置完成' };
const statusFor = (model, effort = '') => model?.verification?.byEffort?.[effort || 'default'] || { responses: 'unknown', tools: 'unknown' };
const modeLabel = (result) => result.responses !== 'ok' ? '需验证' : result.tools === 'ok' ? '可操作小说' : result.tools === 'failed' ? '仅聊天' : '工具需验证';
const newDraft = () => ({ id: crypto.randomUUID(), name: '', templateId: 'deepseek', inputUrl: '', apiKey: '', credentialId: '', authMode: 'auto', customHeaderName: '', connectionId: '' });
function Button({ children, primary, className = '', ...props }) {
  return <button {...props} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${primary ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-white/10 text-gray-300 hover:bg-white/5'} ${className}`}>{children}</button>;
}
function ModelList({ models, selected, onSelect, subscription = false }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const filtered = models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const current = Math.min(page, pages - 1);
  return <div className="space-y-2" data-testid="model-list">
    <input aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} className={fieldClass} />
    <div className="space-y-1">{filtered.slice(current * 20, current * 20 + 20).map((model) => <button key={model.id} data-testid={`select-model-${model.id}`} disabled={model.availability === 'stale'} onClick={() => onSelect(model)} className={`flex w-full min-w-0 items-center gap-2 rounded-lg border p-2.5 text-left text-xs disabled:opacity-40 ${selected === model.id ? 'border-blue-500/50 bg-blue-500/10' : 'border-white/5 hover:bg-white/5'}`}>
      <span className="min-w-0 flex-1 break-all">{model.name || model.id}<span className="mt-0.5 block text-[10px] text-gray-500">{model.id}</span></span>
      <span className="shrink-0 text-[10px] text-gray-400">{model.availability === 'stale' ? '已从列表消失' : subscription ? '订阅可用' : model.source === 'manual' ? '手动模型' : ''}</span>{selected === model.id && <Check size={14} className="shrink-0 text-blue-400" />}
    </button>)}</div>
    {!filtered.length && <p className="py-3 text-xs text-gray-500">没有匹配的模型</p>}
    <div className="flex items-center justify-between text-xs text-gray-500"><span>{filtered.length} 个模型 · {current + 1} / {pages} 页</span><div className="flex gap-2"><Button disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</Button><Button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</Button></div></div>
  </div>;
}
function EffortPicker({ model, value, onChange, disabled, allowCustom = true }) {
  const choices = [...new Set([...(model?.capabilities?.reasoningEfforts || []), ...(model?.verification?.verifiedEfforts || [])])];
  const [custom, setCustom] = useState(false);
  return <div className="space-y-2"><label className="text-xs text-gray-400">思考档位<select aria-label="思考档位" disabled={disabled} value={allowCustom && (custom || (value && !choices.includes(value))) ? '__custom' : choices.includes(value) ? value : ''} onChange={(event) => { const next = event.target.value; setCustom(next === '__custom'); onChange(next === '__custom' ? '' : next); }} className={fieldClass}><option value="">自动（模型默认）</option>{choices.map((effort) => <option key={effort} value={effort}>{effort}</option>)}{allowCustom && <option value="__custom">自定义，使用前验证</option>}</select></label>{allowCustom && (custom || (value && !choices.includes(value))) && <input aria-label="自定义思考档位" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value.trim())} placeholder="例如 high" className={fieldClass} />}</div>;
}
function Capabilities({ model, onChange, disabled, effort = '', dirty = false }) {
  const caps = model?.capabilities || {};
  const verified = dirty ? {} : statusFor(model, effort);
  const source = (key) => dirty ? '修改后需保存验证' : ({ manual: '手动设置', provider: '服务接口', 'models.dev': 'models.dev 目录（2026-09-21）', 'official-catalog': '供应商官方目录' }[model?.fieldSources?.[key]] || '服务未提供，可手动填写');
  return <details data-testid="model-capabilities" className="text-xs text-gray-400"><summary className="cursor-pointer py-2">模型能力参数（高级）</summary><div className="grid grid-cols-2 gap-3">{[['contextWindow', '上下文窗口'], ['maxOutputTokens', '最大输出 Tokens']].map(([key, label]) => <label key={key}>{label}<input aria-label={label} disabled={disabled} type="number" min="1" placeholder="未提供，可手动填写" value={caps[key] ?? ''} onChange={(event) => onChange({ ...caps, [key]: event.target.value ? Number(event.target.value) : null })} className={fieldClass} /><span className="mt-1 block text-[10px]">{source(key)}</span></label>)}{[['supportsTools', '工具能力'], ['supportsStructuredOutput', '结构化输出']].map(([key, label]) => <label key={key}>{label}<select aria-label={label} disabled={disabled} value={caps[key] == null ? '' : String(caps[key])} onChange={(event) => onChange({ ...caps, [key]: event.target.value === '' ? null : event.target.value === 'true' })} className={fieldClass}><option value="">未提供，可手动选择</option><option value="true">支持</option><option value="false">不支持</option></select><span className="mt-1 block text-[10px]">{source(key)}</span></label>)}</div><p data-testid="capability-verification" className="mt-2 text-[11px]">当前档位工具实测：{verified.tools === 'ok' ? '已通过' : verified.tools === 'failed' ? '验证失败，可重试' : '待验证'}。参数声明不替代实际验证。</p></details>;
}

export function ProviderSettingsPanel() {
  const mana = window.mana;
  const [state, setState] = useState({ credentials: [], connections: [], templates: [], revision: 0 });
  const [account, setAccount] = useState(null);
  const [login, setLogin] = useState(null);
  const [limits, setLimits] = useState(null);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState('api');
  const [draft, setDraft] = useState(null);
  const [rawPreview, setPreview] = useState(null);
  const discoveryKey = JSON.stringify([draft?.inputUrl, draft?.templateId, draft?.authMode, draft?.customHeaderName, draft?.credentialId]);
  const preview = rawPreview?._key === discoveryKey ? rawPreview : null;
  const [crossOrigins, setCrossOrigins] = useState([]);
  const [operation, setOperation] = useState(null);
  const [operations, setOperations] = useState([]);
  const [selected, setSelected] = useState('');
  const [effort, setEffort] = useState('');
  const [capabilities, setCapabilities] = useState(null);
  const [manualId, setManualId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [credential, setCredential] = useState(null);
  const operationRef = useRef(null);
  const loggingIn = useRef(false);
  const subscriptionRefreshing = useRef(false);
  const refresh = async () => { const next = await mana.modelConfig.snapshot(); setState(next); return next; };
  const act = async (fn) => {
    setBusy(true); setError(''); setMessage('');
    try { return await fn(); } catch (cause) { setError(cause.message || String(cause)); await refresh().catch(() => {}); return null; } finally { setBusy(false); }
  };
  const useOperation = (next) => {
    operationRef.current = next?.id || null; setOperation(next);
    setSelected(next?.modelId || ''); setEffort(next?.reasoningEffort || ''); setCapabilities(null);
  };
  const refreshSubscription = async () => {
    if (subscriptionRefreshing.current) return;
    subscriptionRefreshing.current = true;
    try {
      const fresh = await refresh();
      await mana.codex.refreshSubscriptionModels(fresh.revision);
      const next = await refresh();
      const connection = next.connections.find((item) => item.kind === 'codexSubscription');
      const selectedId = next.activeSelection?.connectionId === connection?.id ? next.activeSelection.modelId : connection?.models.find((model) => model.id === 'gpt-5.6-luna')?.id || connection?.models[0]?.id || '';
      setSelected(selectedId);
      setEffort(next.activeSelection?.connectionId === connection?.id ? next.activeSelection.reasoningEffort || '' : connection?.models.find((model) => model.id === selectedId)?.capabilities.reasoningEfforts.includes('medium') ? 'medium' : '');
      setLogin(null); setMessage('订阅模型已加载，请选择后使用。当前模型未切换。');
    } finally { subscriptionRefreshing.current = false; }
  };
  useEffect(() => {
    refresh().catch((cause) => setError(cause.message));
    mana.modelConfig.querySetup().then(setOperations).catch((cause) => setError(cause.message));
    mana.codex.accountStatus().then((result) => setAccount(result.account)).catch(() => {});
    const changed = mana.modelConfig.onChanged(() => { refresh().catch(() => {}); mana.modelConfig.querySetup().then(setOperations).catch(() => {}); });
    const progress = mana.modelConfig.onSetupProgress((next) => {
      if (operationRef.current !== next.id) return;
      setOperation(next);
      if (next.status === 'awaiting_model') { setSelected(next.modelId); setEffort(next.reasoningEffort || ''); }
      if (next.status === 'complete') { setCapabilities(null); setMessage('模型已启用，后续聊天将使用此模型。'); }
    });
    const events = mana.codex.onEvent((event) => {
      if (!['account_login_completed', 'account_updated'].includes(event.type)) return;
      mana.codex.accountStatus().then(async (result) => {
        setAccount(result.account);
        if (loggingIn.current && result.account?.type === 'chatgpt') { loggingIn.current = false; await act(refreshSubscription); }
      }).catch((cause) => setError(cause.message));
    });
    return () => { changed?.(); progress?.(); events?.(); };
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    setPreview(null); setCrossOrigins([]);
    if (!draft?.inputUrl) return;
    let valid = true;
    const timer = setTimeout(() => mana.modelConfig.previewConnection(draft).then((result) => { if (valid) setPreview({ ...result, _key: discoveryKey }); }).catch(() => {}), 200);
    return () => { valid = false; clearTimeout(timer); };
  }, [draft?.inputUrl, draft?.templateId, draft?.authMode, draft?.customHeaderName, draft?.credentialId]);
  const running = ['running', 'cancelling'].includes(operation?.status);
  const locked = busy || running;
  const activeConnection = state.connections.find((item) => item.id === state.activeSelection?.connectionId);
  const activeModel = activeConnection?.models.find((item) => item.id === state.activeSelection?.modelId);
  const activeStatus = activeConnection?.kind === 'codexSubscription' ? { responses: account?.type === 'chatgpt' ? 'ok' : 'unknown', tools: 'ok' } : statusFor(activeModel, state.activeSelection?.reasoningEffort);
  const subscription = state.connections.find((item) => item.kind === 'codexSubscription');
  const chosen = (method === 'subscription' ? subscription?.models : operation?.candidate?.models)?.find((item) => item.id === selected);
  const begin = (connection = null, credentialId = '') => {
    const next = newDraft();
    if (connection) {
      const url = new URL(connection.baseUrl); Object.entries(connection.queryParams || {}).forEach(([key, value]) => url.searchParams.set(key, value));
      Object.assign(next, { connectionId: connection.id, credentialId: connection.credentialId, name: connection.name, inputUrl: url.toString(), templateId: connection.templateId, authMode: connection.auth.mode === 'bearer' ? 'bearer' : 'custom', customHeaderName: connection.auth.headerName || '' });
    } else { next.inputUrl = state.templates.find((item) => item.id === next.templateId)?.baseUrl || ''; next.credentialId = credentialId; }
    setDraft(next); useOperation(null); setAdding(true); setMethod('api'); setError(''); setMessage(''); setManualId(''); return next;
  };
  const chooseSaved = (connection, model) => act(async () => {
    const nextDraft = begin(connection);
    if (!['ok', 'manual'].includes(connection.discovery?.status)) { setMessage('此旧连接需要先检测地址，再验证使用。'); return; }
    const targets = await mana.modelConfig.previewConnection(nextDraft);
    const fresh = await refresh();
    operationRef.current = nextDraft.id;
    const next = await mana.modelConfig.startSetup({ ...nextDraft, useSaved: true, modelId: model.id, reasoningEffort: fresh.activeSelection?.connectionId === connection.id && fresh.activeSelection?.modelId === model.id ? fresh.activeSelection.reasoningEffort || '' : '', expectedRevision: fresh.revision, approvedCandidateUrls: targets.candidates.filter((item) => item.origin === new URL(connection.baseUrl).origin).map((item) => item.modelsUrl) });
    useOperation(next);
    await refresh();
  });
  const resume = (next) => {
    setAdding(true); setMethod('api'); setError('');
    setDraft({ ...newDraft(), ...next, apiKey: '' }); useOperation(next);
  };
  const editAgain = () => {
    setDraft({ ...draft, id: crypto.randomUUID(), credentialId: operation?.credentialId || draft.credentialId, apiKey: '' });
    useOperation(null); setError('');
  };
  const detect = () => act(async () => {
    operationRef.current = draft.id;
    const origin = new URL(draft.inputUrl).origin;
    const approvedCandidateUrls = preview.candidates.filter((item) => item.origin === origin || crossOrigins.includes(item.origin)).map((item) => item.modelsUrl);
    const next = await mana.modelConfig.startSetup({ ...draft, expectedRevision: state.revision, approvedCandidateUrls });
    useOperation(next); setDraft((prior) => ({ ...prior, apiKey: '', credentialId: next.credentialId }));
    const latest = await mana.modelConfig.querySetup(next.id); if (latest) useOperation(latest);
    await refresh();
  });
  const verify = (chatOnly = false, interruptActive = false) => act(async () => {
    const next = await mana.modelConfig.retrySetup({ id: operation.id, modelId: selected, reasoningEffort: effort, capabilities: capabilities || undefined, manualModelId: manualId || undefined, chatOnly, interruptActive });
    setOperation(await mana.modelConfig.querySetup(next.id));
  });
  const activateSubscription = () => act(async () => {
    let next;
    try { next = await mana.modelConfig.setActive(subscription.id, selected, chosen?.capabilities.reasoningEfforts.includes(effort) ? effort : null, state.revision); }
    catch (cause) {
      if (cause.code !== 'codex_turn_active' || !window.confirm('当前写作任务仍在运行。取消当前任务并切换模型？')) throw cause;
      const fresh = await refresh(); next = await mana.modelConfig.setActive(subscription.id, selected, chosen?.capabilities.reasoningEfforts.includes(effort) ? effort : null, fresh.revision, true);
    }
    setState(next); setMessage('订阅模型已启用。');
  });
  return <div data-testid="responses-config-v8" className="h-full overflow-y-auto p-4 text-gray-200 sm:p-5"><div className="mx-auto max-w-4xl space-y-4">
    <header className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">模型配置</h2><p className="mt-1 text-xs text-gray-500">连接服务，选择模型，即可开始写作。</p></div><Button primary disabled={locked} onClick={() => begin()}><Plus size={14} />添加模型服务</Button></header>
    <section data-testid="active-model-summary" className="rounded-xl border border-blue-500/25 bg-blue-500/5 p-4"><div className="text-xs text-gray-400">当前使用</div><div className="mt-2 flex flex-wrap items-center gap-2"><strong className="min-w-0 break-all text-base">{activeModel?.name || '尚未选择模型'}</strong>{activeModel && <span className={`rounded px-2 py-1 text-[11px] ${activeStatus.tools === 'ok' && activeStatus.responses === 'ok' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{modeLabel(activeStatus)}</span>}</div><p className="mt-2 break-all text-xs text-gray-500">{activeConnection ? `${activeConnection.name} · 思考档位：${state.activeSelection.reasoningEffort || '自动'}` : '添加服务后，选择模型并完成验证。'}</p>{activeStatus.tools === 'failed' && <p className="mt-2 text-xs text-amber-300">仅聊天：无法读取、改写或写入小说资源。</p>}</section>
    {state.selectionNotice && <p role="status" className="text-xs text-amber-300">{state.selectionNotice}</p>}
    {!adding && error && <p role="alert" className="text-xs text-rose-300">{error}</p>}{message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
    {adding && <section data-testid="setup-editor" className={`${cardClass} space-y-4 border-blue-500/20`}><div className="flex items-center justify-between"><h3 className="text-sm font-medium">{draft?.connectionId ? '编辑模型服务' : '添加模型服务'}</h3><Button aria-label="关闭配置" disabled={locked} onClick={() => setAdding(false)}><X size={14} /></Button></div>
      <div className="flex gap-2"><Button disabled={locked || !!operation} primary={method === 'api'} onClick={() => { setMethod('api'); setSelected(''); }}>API 接入</Button><Button disabled={locked || !!operation} primary={method === 'subscription'} onClick={() => { setMethod('subscription'); setSelected(subscription?.models.find((model) => model.id === state.activeSelection?.modelId)?.id || subscription?.models.find((model) => model.id === 'gpt-5.6-luna')?.id || subscription?.models[0]?.id || ''); setEffort('medium'); }}>订阅登录</Button></div>
      {error && <p data-testid="provider-settings-error" role="alert" className="rounded-lg bg-rose-500/10 p-3 text-xs text-rose-200">{error}</p>}
      {method === 'subscription' ? <div data-testid="codex-subscription-setup" className="space-y-3"><p className="text-xs text-gray-400">{account?.type === 'chatgpt' ? `已登录 ${account.email || 'ChatGPT'}` : '使用 ChatGPT 订阅登录，完成后自动加载可选模型。'}</p><div className="flex flex-wrap gap-2">{account?.type !== 'chatgpt' ? ['browser', 'device'].map((mode) => <Button key={mode} disabled={busy} primary={mode === 'browser'} onClick={() => act(async () => { loggingIn.current = true; setLogin(await mana.codex.accountLogin(mode)); })}>{mode === 'browser' ? '浏览器登录' : '设备码登录'}</Button>) : <><Button disabled={busy} onClick={() => act(refreshSubscription)}><RefreshCw size={13} />刷新列表</Button><Button disabled={busy} onClick={() => act(async () => setLimits(await mana.codex.accountRateLimits()))}>查看额度</Button><Button disabled={busy} onClick={() => act(async () => { await mana.codex.accountLogout(); setAccount(null); setLimits(null); await refresh(); })}>退出登录</Button></>}</div>{login && <div className="rounded-lg bg-white/5 p-3 text-xs">{login.userCode ? `设备验证码：${login.userCode}` : '请在浏览器完成登录。'}<Button onClick={() => act(async () => { await mana.codex.accountCancel(login.loginId); setLogin(null); loggingIn.current = false; })}>取消登录</Button></div>}{limits && <div className="text-xs text-gray-400">{Object.entries(limits.rateLimitsByLimitId || { 订阅: limits.rateLimits || limits }).map(([key, value]) => <div key={key}>{key}：{value.primary?.usedPercent != null ? `已使用 ${value.primary.usedPercent}%` : '暂无额度数据'}</div>)}</div>}{subscription && account?.type === 'chatgpt' && <><ModelList models={subscription.models} selected={selected} subscription onSelect={(model) => { setSelected(model.id); setEffort(model.capabilities.reasoningEfforts.includes('medium') ? 'medium' : ''); }} /><EffortPicker model={chosen} value={effort} onChange={setEffort} disabled={busy} allowCustom={false} /><Button primary disabled={busy || !selected} onClick={activateSubscription}>使用此模型</Button></>}</div> : <>
      {!operation && draft && <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-gray-400">模型服务<select aria-label="模型服务" value={draft.templateId} onChange={(event) => { const template = state.templates.find((item) => item.id === event.target.value); setDraft({ ...draft, templateId: event.target.value, inputUrl: template?.baseUrl || '' }); }} className={fieldClass}><option value="auto">自定义地址（自动识别）</option>{state.templates.filter((item) => item.baseUrl).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="text-xs text-gray-400">供应商 URL<input aria-label="供应商 URL" value={draft.inputUrl} onChange={(event) => setDraft({ ...draft, inputUrl: event.target.value })} placeholder="https://api.example.com/v1" className={fieldClass} /></label></div>
      <label className="block text-xs text-gray-400">API 凭据<select aria-label="API 凭据" value={draft.credentialId} onChange={(event) => setDraft({ ...draft, credentialId: event.target.value, apiKey: '' })} className={fieldClass}><option value="">输入新的 API Key</option>{state.credentials.map((item) => <option key={item.id} value={item.id} disabled={!item.secretStatus?.readable}>{item.name}{item.secretStatus?.readable ? '（已保存）' : '（不可用）'}</option>)}</select></label>{!draft.credentialId && <label className="block text-xs text-gray-400">API Key<input aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} className={fieldClass} /></label>}
      <details className="text-xs text-gray-400"><summary className="cursor-pointer py-2">高级连接设置</summary><div className="grid gap-3 sm:grid-cols-2"><label>连接名称<input aria-label="连接名称" placeholder="按服务地址自动命名" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={fieldClass} /></label><label>认证方式<select aria-label="认证方式" value={draft.authMode} onChange={(event) => setDraft({ ...draft, authMode: event.target.value })} className={fieldClass}><option value="auto">自动检测</option><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="api-key">api-key</option><option value="custom">自定义 Header</option></select></label>{draft.authMode === 'custom' && <label>Header 名称<input aria-label="Header 名称" value={draft.customHeaderName} onChange={(event) => setDraft({ ...draft, customHeaderName: event.target.value })} className={fieldClass} /></label>}</div></details>
      {preview && <div data-testid="discovery-preview" className="space-y-1 rounded-lg bg-black/20 p-3 text-[11px] text-gray-400"><p>点击检测，即允许向以下已确认地址发送 Key：</p>{preview.candidates.map((item) => <div key={item.modelsUrl} className="break-all">{item.origin !== new URL(draft.inputUrl).origin ? <label><input type="checkbox" checked={crossOrigins.includes(item.origin)} onChange={(event) => setCrossOrigins(event.target.checked ? [...crossOrigins, item.origin] : crossOrigins.filter((origin) => origin !== item.origin))} /> 单独确认其他域名：{item.modelsUrl}</label> : item.modelsUrl}</div>)}{preview.insecureHttp && <p className="text-amber-300">此 HTTP 地址会明文传输 Key。</p>}</div>}
      <Button primary disabled={busy || !preview || (!draft.credentialId && !draft.apiKey.trim())} onClick={detect}>检测模型</Button></div>}
      {operation && <div data-testid="setup-progress" className="space-y-3"><div className="flex flex-wrap items-center gap-2 text-xs"><strong>{stages[operation.stage] || operation.stage}</strong><span className="text-gray-500">{running ? `进行中 · ${Math.max(0, Math.floor((now - (operation.stageStartedAt || operation.startedAt)) / 1000))} 秒` : operation.status === 'complete' ? '已完成' : '可继续'}</span>{running && <Button onClick={() => act(async () => setOperation(await mana.modelConfig.cancelSetup(operation.id)))}>取消</Button>}</div><div className="flex flex-wrap gap-2 text-[10px] text-gray-500">{['discover', 'select', 'responses', 'tools', 'activate'].map((stage) => <span key={stage} className={operation.stage === stage ? 'text-blue-300' : ''}>{stages[stage]}</span>)}</div>
      {operation.error && <p role="alert" className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200">{operation.error}</p>}
      {operation.candidate && <><p className="break-all text-[11px] text-gray-500">{operation.candidate.baseUrl}</p><p className="text-xs text-gray-400">{operation.recommended ? '已预选服务推荐模型，你可以改选。' : '按模型 ID 排序预选首项，不代表质量推荐。'}</p><fieldset disabled={locked || operation.status === 'complete'}><ModelList models={operation.candidate.models} selected={selected} onSelect={(model) => { setSelected(model.id); setCapabilities(null); setEffort(''); }} /><EffortPicker model={chosen} value={effort} onChange={setEffort} disabled={locked} /><Capabilities model={capabilities ? { ...chosen, capabilities } : chosen} onChange={setCapabilities} disabled={locked} effort={effort} dirty={!!capabilities} /></fieldset></>}
      {operation.status === 'complete' && <Button primary disabled={locked} onClick={() => { const connection = state.connections.find((item) => item.id === operation.connectionId); const model = connection?.models.find((item) => item.id === selected); if (connection && model) chooseSaved(connection, model); }}>修改模型 / 参数</Button>}
      {!running && operation.status !== 'complete' && <div className="space-y-3">{!operation.candidate && <div className="rounded-lg border border-white/10 p-3"><p className="mb-2 text-xs text-gray-400">列表接口不可用？可手动填写模型 ID，验证仍会使用下列 Responses 地址。</p><p className="mb-2 break-all text-[11px] text-gray-500">{operation.approvedCandidateUrls[0]?.replace(/\/models(?=\?|$)/, '/responses')}</p><input aria-label="手动模型 ID" placeholder="供应商提供的模型 ID" value={manualId} onChange={(event) => setManualId(event.target.value)} className={fieldClass} /></div>}<div className="flex flex-wrap gap-2"><Button primary disabled={busy || (!!operation.candidate && !selected) || operation.errorCode === 'model_config_stale'} onClick={() => verify(false)}>{operation.candidate ? operation.stage === 'tools' ? '重试工具验证' : '验证并使用' : manualId ? '确认地址并添加模型' : '重试检测'}</Button>{operation.status === 'awaiting_chat' && <Button disabled={busy} onClick={() => verify(true)}>仅用于聊天</Button>}{operation.errorCode === 'codex_turn_active' && operation.stage === 'activate' && <Button disabled={busy} onClick={() => { if (window.confirm('取消当前写作任务并切换模型？')) verify(false, true); }}>中断任务并切换</Button>}<Button disabled={busy} onClick={editAgain}>修改接入信息</Button></div>{operation.status === 'awaiting_chat' && <p className="text-xs text-amber-300">文本已通过，小说工具失败。仅聊天不会开放小说资料读取、改写和写入；点击后才切换模型。</p>}</div>}
      </div>}
      </>}
    </section>}
    <section className="space-y-3"><h3 className="text-sm font-medium">已保存的服务 <span className="text-gray-500">{state.connections.length}</span></h3>{!state.connections.length && <p className={`${cardClass} text-xs text-gray-500`}>还没有保存的服务。添加后可以随时切换模型。</p>}{state.connections.map((connection) => <details key={connection.id} className={cardClass}><summary className="flex cursor-pointer list-none items-center gap-2"><ChevronDown size={14} className="shrink-0 text-gray-500" /><span className="min-w-0 flex-1 break-all text-sm">{connection.name}<span className="mt-1 block text-[10px] text-gray-500">{connection.models.length} 个模型{activeConnection?.id === connection.id ? ` · 当前：${activeModel?.name}` : ''}</span></span>{activeConnection?.id === connection.id && <Check size={14} className="shrink-0 text-emerald-400" />}</summary><div className="mt-3 space-y-3"><ModelList models={connection.models} selected={activeConnection?.id === connection.id ? activeModel?.id : ''} subscription={connection.kind === 'codexSubscription'} onSelect={(model) => { if (connection.kind === 'codexSubscription') { setAdding(true); setMethod('subscription'); useOperation(null); setSelected(model.id); setEffort(model.capabilities.reasoningEfforts.includes('medium') ? 'medium' : ''); } else { chooseSaved(connection, model); } }} /><div className="flex gap-2"><Button disabled={locked} onClick={() => connection.kind === 'api' ? begin(connection) : (setAdding(true), setMethod('subscription'), useOperation(null))}>编辑 / 刷新模型</Button><Button disabled={locked} onClick={() => { if (window.confirm(`删除服务“${connection.name}”？`)) act(async () => { await mana.modelConfig.deleteConnection(connection.id, state.revision); await refresh(); }); }}>删除服务</Button></div></div></details>)}</section>
    {operations.some((item) => item.status !== 'complete') && <details className={cardClass}><summary className="cursor-pointer text-sm">未完成的配置</summary><div className="mt-3 space-y-2">{operations.filter((item) => item.status !== 'complete').map((item) => <div key={item.id} className="flex items-center justify-between gap-2 text-xs"><span className="min-w-0 break-all">{item.name} · {stages[item.stage]}</span><Button disabled={locked} onClick={() => resume(item)}>继续配置</Button></div>)}</div></details>}
    <details className={cardClass}><summary className="cursor-pointer text-sm">高级：API 凭据管理</summary><p className="mt-2 text-xs text-gray-500">Key 可供多个连接复用。轮换后需重新验证；引用中的凭据不可删除。</p><div className="mt-3 space-y-2">{state.credentials.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1 break-all">{item.name} · {item.connectionCount} 个连接</span><Button disabled={locked || !item.secretStatus?.readable} onClick={() => begin(null, item.id)}>复用 Key</Button><Button disabled={locked} onClick={() => setCredential({ id: item.id, name: item.name, apiKey: '' })}>改名 / 轮换</Button><Button disabled={locked || item.connectionCount > 0} onClick={() => act(async () => { await mana.modelConfig.deleteCredential(item.id, state.revision); await refresh(); })}>删除</Button></div>)}</div>{credential && <div className="mt-3 space-y-2"><input aria-label="凭据名称" value={credential.name} onChange={(event) => setCredential({ ...credential, name: event.target.value })} className={fieldClass} /><input aria-label="新 API Key" type="password" placeholder="留空保持原 Key" value={credential.apiKey} onChange={(event) => setCredential({ ...credential, apiKey: event.target.value })} className={fieldClass} /><Button disabled={busy} onClick={() => act(async () => { await mana.modelConfig.saveCredential(credential, state.revision); setCredential(null); await refresh(); })}>保存凭据</Button></div>}</details>
  </div></div>;
}
