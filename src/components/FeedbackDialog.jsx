import React, { useEffect, useRef, useState } from 'react';
import { buildQuickFeedbackPayload } from './chatFeedbackPayload.mjs';
import { getRecentRendererLogs } from './recentRendererLogs.mjs';

const buttonClass = 'rounded border border-white/20 px-3 py-2 text-sm disabled:opacity-50';

function syncLabel(record) {
  if (record.syncStatus === 'sent' && record.remoteRecordId) return '远端提交成功 · 远端已收到';
  return ({ pending: '等待同步 · 尚未确认远端收到', syncing: '正在同步 · 尚未确认远端收到',
    retryable_failed: '同步失败 · 将自动重试', failed_terminal: '同步失败 · 需要处理后重试',
  })[record.syncStatus] || '同步状态待确认 · 尚未确认远端收到';
}

// One snapshot per opening: switching project/thread must not change a pending report's target.
export function FeedbackDialog({ context, onClose }) {
  const api = window.mana?.feedback;
  const dialog = useRef(null);
  const submitting = useRef(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [includeLogs, setIncludeLogs] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [attachmentWarning, setAttachmentWarning] = useState('');
  const [retrying, setRetrying] = useState('');

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element.showModal();
    element.querySelector('textarea')?.focus();
    return () => { element.close(); previousFocus?.focus?.(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function refresh() {
      try {
        if (!api?.listOutbox) throw new Error('当前环境不支持反馈服务');
        const items = await api.listOutbox();
        if (!cancelled) { setRecords(items || []); setSyncError(''); }
      } catch (e) {
        if (!cancelled) setSyncError(`无法刷新同步状态：${e.message || String(e)}`);
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 3000);
      }
    }
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, saved?.feedbackId]);

  async function submit(event) {
    event.preventDefault();
    if (submitting.current || saved) return;
    if (!description.trim()) { setError('请填写问题描述。'); return; }
    submitting.current = true; setBusy(true); setError(''); setAttachmentWarning('');
    try {
      if (!api?.submit) throw new Error('当前环境不支持反馈服务');
      const payload = buildQuickFeedbackPayload({ ...context, issueTitle: title.trim(), actualBehavior: description.trim(),
        includeLogs, includeScreenshot, recentRendererLogs: includeLogs ? getRecentRendererLogs() : [],
      });
      const result = await api.submit(payload, { includeScreenshot });
      if (!result?.feedbackId) throw new Error('未收到本地保存凭据，请检查反馈记录后重试。');
      // Only the host's local receipt establishes persistence; it is not a remote receipt.
      setSaved(result);
      if (includeScreenshot && !result.attachments?.some(item => item.kind === 'window-screenshot' && item.size > 0)) {
        setAttachmentWarning('反馈已保存，但截图未能附加。需要截图时请重新提交一条反馈。');
      }
    } catch (e) { setError(`未能确认本地保存：${e.message || String(e)}`); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function retry(feedbackId) {
    if (retrying) return;
    setRetrying(feedbackId); setSyncError('');
    try {
      const result = await api.retrySync(feedbackId);
      if (result?.ok === false) throw new Error(result.error || '无法重试');
      setRecords(await api.listOutbox());
    } catch (e) { setSyncError(`重试同步失败：${e.message || String(e)}`); }
    finally { setRetrying(''); }
  }

  const savedRecord = saved && (records.find(record => record.feedbackId === saved.feedbackId) || saved);
  return <dialog ref={dialog} data-testid="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-heading"
    onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}
    className="m-auto w-[560px] max-w-[94vw] max-h-[90dvh] overflow-y-auto rounded-lg border border-white/20 bg-[#202020] p-5 text-gray-200 shadow-xl backdrop:bg-black/60">
    <h2 id="feedback-heading" className="mb-3 text-lg font-semibold">反馈问题</h2>
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy || !!saved} className="space-y-3 disabled:opacity-60">
        <label className="block text-sm">问题标题（选填）<input data-testid="feedback-title" type="text" maxLength={160} value={title} onChange={event => setTitle(event.target.value)} className="mt-1 w-full rounded border border-white/20 bg-black/30 p-2" /></label>
        <label className="block text-sm">问题描述（必填）<textarea autoFocus data-testid="feedback-description" required maxLength={10000} rows={4} value={description} onChange={event => setDescription(event.target.value)} className="mt-1 w-full rounded border border-white/20 bg-black/30 p-2" /></label>
        <p className="text-xs leading-5 text-gray-400">默认仅发送你填写的内容、基本环境与项目/对话标识，不附带小说正文和对话内容。保存后会自动尝试同步。</p>
        <label className="flex items-start gap-2 text-sm"><input data-testid="feedback-logs" aria-describedby="feedback-logs-help" type="checkbox" checked={includeLogs} onChange={event => setIncludeLogs(event.target.checked)} />附带上下文日志（可选）</label>
        <p id="feedback-logs-help" className="text-xs leading-5 text-gray-400">勾选后包含最近 8 条对话摘要、6 次工具调用、日志、当前正文片段与选区；工具参数或日志可能包含小说内容。</p>
        <label className="flex items-start gap-2 text-sm"><input data-testid="feedback-screenshot" type="checkbox" checked={includeScreenshot} onChange={event => setIncludeScreenshot(event.target.checked)} />附带当前窗口截图（可选）</label>
        <p className="text-xs leading-5 text-gray-400">截图会隐藏此表单，可能包含窗口内可见的小说正文或对话，请确认后选择。</p>
      </fieldset>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {savedRecord && <div role="status" data-testid="feedback-saved" className="rounded border border-emerald-500/40 p-3 text-sm">
        <p>本地保存成功 · {savedRecord.feedbackId}</p><p data-testid="feedback-sync-status">{syncLabel(savedRecord)}</p>
      </div>}
      {attachmentWarning && <p role="alert" className="text-sm text-amber-300">{attachmentWarning}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>{saved ? '关闭' : '取消'}</button>
        {!saved && <button data-testid="feedback-submit" type="submit" disabled={busy} className={`${buttonClass} bg-blue-700 text-white`}>{busy ? '正在保存…' : '提交反馈'}</button>}
      </div>
    </form>
    <section aria-label="反馈同步记录" className="mt-5 border-t border-white/15 pt-3">
      <h3 className="text-sm font-semibold">反馈同步记录</h3>
      {syncError && <p role="alert" className="my-2 text-sm text-amber-300">{syncError}；已保存的记录不会因此重新提交。</p>}
      {!records.length && <p className="mt-2 text-xs text-gray-400">暂无可显示的记录</p>}
      <ul className="mt-2 space-y-3">
        {records.map(record => <li key={record.feedbackId} data-testid="feedback-record" data-feedback-id={record.feedbackId} className="break-words text-xs">
          <p>{record.issueTitle} · 本地已保存</p><p>{syncLabel(record)}</p>
          {record.lastError && <p className="text-amber-300">{record.lastError}</p>}
          {['pending', 'retryable_failed', 'failed_terminal'].includes(record.syncStatus) && <button type="button" className="mt-1 underline disabled:opacity-50" disabled={!!retrying} onClick={() => retry(record.feedbackId)}>{retrying === record.feedbackId ? '正在重试…' : '重试同步'}</button>}
        </li>)}
      </ul>
    </section>
  </dialog>;
}
