import React, { useEffect, useState } from 'react';

export function FactReviewDialog({ api, ownerId, reviewId, onComplete }) {
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getReview(ownerId, reviewId).then((r) => { if (!cancelled) setReview(r); }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [api, ownerId, reviewId]);
  const perform = async (operation) => {
    setBusy(true); setError('');
    try { await operation(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const finish = (approved) => perform(async () => {
    const result = await api.finishReview(ownerId, reviewId, approved);
    onComplete(result);
  });
  const unresolved = review?.fields.filter((f) => !(f.id in review.decisions)).length || 0;
  return <div className="fixed inset-0 z-[120] bg-black/70 flex items-center justify-center p-6" role="dialog" aria-label="候选事实审阅" data-testid="fact-review">
    <div className="bg-vscode-panel-bg border border-vscode-panel-border rounded-lg w-[860px] max-w-full max-h-[90vh] flex flex-col p-4 gap-3 text-xs text-gray-300">
      <h2 className="text-base font-semibold">候选事实审阅</h2>
      <p>请核对候选值、引文和来源。选择会自动保存；重新打开项目后可继续。未决定 {unresolved} 项。</p>
      {review?.kind === 'regeneration' && <p className="text-amber-300">将以 {review.candidates?.length || 0} 个候选重建角色卡，删除 {review.plan.changes.filter((c) => c.after === null).length} 个旧文件。角色记忆保留。完整变更可在下方查看。</p>}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {!review && !error && <p>正在读取审阅记录…</p>}
      {review && <div className="overflow-y-auto min-h-0 space-y-4" style={{ maxHeight: '62vh' }}>
        {review.fields.map((field) => <section key={field.id} className="border border-vscode-panel-border rounded p-3 space-y-2">
          <label className="block font-semibold">{field.label}</label>
          <select aria-label={field.label} disabled={busy || review.state !== 'review'} className="bg-vscode-bg border rounded p-2 w-full" value={field.id in review.decisions ? String(review.decisions[field.id]) : ''} onChange={(e) => {
            const choice = e.target.value;
            if (!choice) return;
            perform(async () => setReview(await api.decideReview(ownerId, reviewId, { [field.id]: choice === 'reject' ? 'reject' : Number(choice) })));
          }}>
            <option value="">请选择确认的候选，或拒绝变更</option>
            {field.candidates.map((c, i) => <option key={i} value={i}>确认候选 {i + 1}</option>)}
            <option value="reject">拒绝此项，保留原值</option>
          </select>
          {field.candidates.map((candidate, i) => <div key={i} className="space-y-1">
            <div className="text-amber-200">候选 {i + 1}</div>
            <pre className="whitespace-pre-wrap break-words bg-vscode-bg p-2">{typeof candidate.value === 'boolean' ? field.identity ? '确认网页主体、角色和所属作品一致' : candidate.value ? '是' : '否' : typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value, null, 2)}</pre>
            {(candidate.sources || []).filter((source) => /^https?:\/\//.test(source?.url || '')).map((source, index) => <a key={index} className="text-blue-300 underline block break-all" href={source.url} target="_blank" rel="noreferrer">打开原始来源：{source.url}</a>)}
            <details><summary>查看来源、原文与位置</summary><pre className="whitespace-pre-wrap break-words p-2">{JSON.stringify(candidate.sources || candidate.evidence || [], null, 2)}</pre></details>
          </div>)}
        </section>)}
        <details><summary>查看完整变更及原始基线</summary><pre className="whitespace-pre-wrap break-words p-2">{JSON.stringify(review.plan.changes, null, 2)}</pre></details>
      </div>}
      <div className="flex justify-end gap-3">
        {review?.state === 'review' ? <><button disabled={busy} onClick={() => finish(false)}>拒绝本次变更</button><button className="bg-blue-700 rounded px-3 py-2 disabled:opacity-40" disabled={busy || unresolved > 0} onClick={() => finish(true)}>确认并保存已审阅内容</button></> : review && <button onClick={() => onComplete(review)}>关闭审阅记录</button>}
      </div>
    </div>
  </div>;
}
