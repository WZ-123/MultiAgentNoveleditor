import React, { useState } from 'react';
import { useWorkflowState } from '@/hooks/useWorkflowState.js';
import { AGENTS } from '@/agents/registry.js';
import { OUTLINE_PHASE } from '@/domain/types.js';
import { AgentApiSettings } from '@/components/AgentApiSettings.jsx';

function ParagraphBlock({
  p,
  styleAnn,
  qualityAnn,
  resolved,
  peek,
  onPeekRewrite,
  onResolvePeek,
  onStyleAction,
  onQualityChoice,
}) {
  const text = p.text;
  const hasQuality = qualityAnn.length > 0 && !resolved;
  const showPeek = peek && peek.paragraphId === p.id;

  let content;
  if (styleAnn.length === 0) {
    content = <span>{text}</span>;
  } else {
    const parts = [];
    let cursor = 0;
    const sorted = [...styleAnn].sort((a, b) => a.start - b.start);
    sorted.forEach((a, i) => {
      if (cursor < a.start) {
        parts.push(<span key={`t-${i}`}>{text.slice(cursor, a.start)}</span>);
      }
      parts.push(
        <span
          key={`s-${a.id}`}
          className="bg-blue-900/60 underline decoration-blue-400 cursor-pointer"
          title={a.reason}
          onClick={() => {
            const action = window.prompt(
              '文风：输入 unify | memory | pass',
              'pass'
            );
            if (action === 'unify') onStyleAction(a.id, 'unify_style');
            else if (action === 'memory') {
              const patch = window.prompt('记忆补丁', '');
              onStyleAction(a.id, 'update_style_memory', patch ?? '');
            } else if (action === 'pass') onStyleAction(a.id, 'pass');
          }}
        >
          {text.slice(a.start, a.end)}
        </span>
      );
      cursor = a.end;
    });
    if (cursor < text.length) {
      parts.push(<span key="end">{text.slice(cursor)}</span>);
    }
    content = <>{parts}</>;
  }

  return (
    <div
      className={`mb-3 rounded border border-transparent p-2 ${
        hasQuality ? 'border-red-500/40 bg-red-950/20' : ''
      }`}
    >
      <div className="text-xs text-gray-500 mb-1">段落 {p.id}</div>
      <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
      {hasQuality && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {qualityAnn.map((q) => (
            <span key={q.id} className="text-red-300" title={q.note}>
              {q.kind}: {q.note}
            </span>
          ))}
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-vscode-active-item hover:bg-[#2a2d2e]"
            onClick={() => onQualityChoice(p.id, 'keep')}
          >
            保留
          </button>
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-vscode-active-item hover:bg-[#2a2d2e]"
            onClick={() => onQualityChoice(p.id, 'rewrite')}
          >
            重写
          </button>
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-vscode-active-item hover:bg-[#2a2d2e]"
            onClick={() => onPeekRewrite(p.id)}
          >
            Peek 重写
          </button>
        </div>
      )}
      {showPeek && (
        <div className="mt-2 border border-vscode-panel-border rounded p-2 bg-vscode-sidebar text-xs">
          <div className="font-bold mb-1 text-gray-400">Peek 预览</div>
          <div className="text-gray-300 mb-2 whitespace-pre-wrap">
            {peek.candidate || '（请求中…）'}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-2 py-1 rounded bg-emerald-800/80"
              onClick={() => onResolvePeek('accept')}
            >
              接受
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded bg-vscode-active-item"
              onClick={() => onPeekRewrite(p.id)}
            >
              重写
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded bg-vscode-active-item"
              onClick={() => onResolvePeek('discard')}
            >
              放弃
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkflowPanel() {
  const wf = useWorkflowState();
  const [mode, setMode] = useState('plot_direction');
  const [userText, setUserText] = useState('主角在雨夜收到一封旧信，决定回到故乡。');
  const [words, setWords] = useState(8000);
  const [chapters, setChapters] = useState(1);

  const {
    outline,
    writing,
    busy,
    outlineText,
    styleMemoryDraft,
    setStyleMemoryDraft,
    startInput,
    runOutline,
    resolveIssues,
    confirm,
    applyReq,
    genDraft,
    runAgent4,
    runAgent5,
    markReadyToSave,
    runAgent6,
    finalizeChapter,
    applyStyleAction,
    applyQualityChoice,
    peekRewrite,
    resolvePeek,
    bulkRewrite,
    bulkKeepAll,
    saveStyle,
  } = wf;

  const styleByParagraph = (pid) =>
    writing.styleAnnotations.filter((a) => a.paragraphId === pid);
  const qualityByParagraph = (pid) =>
    writing.qualityAnnotations.filter((a) => a.paragraphId === pid);

  return (
    <div className="flex flex-col gap-4 text-sm text-gray-300 h-full overflow-y-auto pr-1">
      <details className="group border border-vscode-panel-border rounded bg-vscode-sidebar/30">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center justify-between">
          <span>每 Agent API（OpenAI 兼容 · 多服务商）</span>
          <span className="text-gray-600 group-open:rotate-0">▼</span>
        </summary>
        <div className="px-3 pb-3 border-t border-vscode-panel-border">
          <AgentApiSettings />
        </div>
      </details>

      <section>
        <div className="text-xs font-bold text-gray-500 uppercase mb-2">
          多 Agent 管线（工程骨架）
        </div>
        <p className="text-xs text-gray-500 mb-2">
          未填写 Key 或勾选 mock 时使用本地 mock。Agent 说明：
        </p>
        <ul className="text-xs text-gray-500 list-disc pl-4 space-y-1">
          {Object.values(AGENTS).map((a) => (
            <li key={a.id}>
              <span className="text-gray-400">{a.title}</span> — {a.summary}
            </li>
          ))}
        </ul>
      </section>

      <section className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/40">
        <div className="font-bold mb-2">1. 大纲阶段</div>
        <div className="flex gap-4 mb-2 text-xs">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              checked={mode === 'plot_direction'}
              onChange={() => setMode('plot_direction')}
            />
            剧情走向
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              checked={mode === 'user_outline'}
              onChange={() => setMode('user_outline')}
            />
            已有大纲
          </label>
        </div>
        <textarea
          className="w-full bg-vscode-editor-bg border border-vscode-panel-border rounded p-2 text-xs min-h-[72px] mb-2"
          value={userText}
          onChange={(e) => setUserText(e.target.value)}
        />
        <div className="flex flex-wrap gap-2 mb-2">
          <button
            type="button"
            disabled={busy}
            className="px-2 py-1 rounded bg-blue-900/80 text-xs disabled:opacity-50"
            onClick={() => startInput(mode, userText)}
          >
            记录输入
          </button>
          <button
            type="button"
            disabled={busy}
            className="px-2 py-1 rounded bg-blue-700/80 text-xs disabled:opacity-50"
            onClick={() => runOutline()}
          >
            运行 Agent1→2/3
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded bg-vscode-active-item text-xs"
            onClick={() => resolveIssues(outline.blockingIssues.map((i) => i.id))}
          >
            一键消除阻塞项（演示）
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded bg-vscode-active-item text-xs"
            onClick={() => confirm()}
          >
            确认大纲
          </button>
        </div>
        <div className="text-xs text-gray-500">
          状态：<span className="text-gray-300">{outline.phase}</span>
          {outline.lastError && (
            <span className="text-red-400 ml-2">{outline.lastError}</span>
          )}
        </div>
        {outline.blockingIssues.length > 0 && (
          <ul className="mt-2 text-xs space-y-1">
            {outline.blockingIssues.map((i) => (
              <li key={i.id} className="text-amber-300/90">
                [{i.sourceAgent}] {i.summary}
              </li>
            ))}
          </ul>
        )}
        {outlineText && (
          <pre className="mt-2 text-xs bg-black/30 p-2 rounded max-h-32 overflow-auto whitespace-pre-wrap">
            {outlineText}
          </pre>
        )}
      </section>

      <section className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/40">
        <div className="font-bold mb-2">2. 撰写阶段</div>
        <div className="flex gap-2 mb-2">
          <label className="text-xs flex items-center gap-1">
            目标字数
            <input
              type="number"
              className="w-24 bg-vscode-editor-bg border border-vscode-panel-border rounded px-1"
              value={words}
              onChange={(e) => setWords(Number(e.target.value))}
            />
          </label>
          <label className="text-xs flex items-center gap-1">
            章数
            <input
              type="number"
              className="w-16 bg-vscode-editor-bg border border-vscode-panel-border rounded px-1"
              min={1}
              value={chapters}
              onChange={(e) => setChapters(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="px-2 py-1 rounded bg-vscode-active-item text-xs"
            onClick={() => applyReq(words, chapters, '')}
          >
            应用字数/章节要求
          </button>
        </div>
        <div className="mb-2">
          <div className="text-xs text-gray-500 mb-1">文风记忆（localStorage）</div>
          <textarea
            className="w-full bg-vscode-editor-bg border border-vscode-panel-border rounded p-2 text-xs min-h-[56px]"
            value={styleMemoryDraft}
            onChange={(e) => setStyleMemoryDraft(e.target.value)}
          />
          <button
            type="button"
            className="mt-1 px-2 py-0.5 rounded bg-vscode-active-item text-xs"
            onClick={() => saveStyle()}
          >
            保存文风记忆
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          <button
            type="button"
            disabled={busy || outline.phase !== OUTLINE_PHASE.CONFIRMED}
            className="px-2 py-1 rounded bg-emerald-900/80 text-xs disabled:opacity-50"
            onClick={() => genDraft()}
          >
            远程生成初稿
          </button>
          <button
            type="button"
            disabled={busy}
            className="px-2 py-1 rounded bg-vscode-active-item text-xs disabled:opacity-50"
            onClick={() => runAgent4()}
          >
            Agent4 文风
          </button>
          <button
            type="button"
            disabled={busy}
            className="px-2 py-1 rounded bg-vscode-active-item text-xs disabled:opacity-50"
            onClick={() => runAgent5()}
          >
            Agent5 质量
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded bg-vscode-active-item text-xs"
            onClick={() => bulkKeepAll()}
          >
            全部保留（质量）
          </button>
          <button
            type="button"
            disabled={busy}
            className="px-2 py-1 rounded bg-vscode-active-item text-xs disabled:opacity-50"
            onClick={() => bulkRewrite()}
          >
            全部重写（质量，未决策段）
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded bg-vscode-active-item text-xs"
            onClick={() => markReadyToSave()}
          >
            准备存档
          </button>
          <button
            type="button"
            disabled={busy}
            className="px-2 py-1 rounded bg-purple-900/80 text-xs disabled:opacity-50"
            onClick={() => runAgent6()}
          >
            本章存档 / Agent6
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded bg-vscode-active-item text-xs"
            onClick={() => finalizeChapter()}
          >
            结束本章
          </button>
        </div>
        <div className="text-xs text-gray-500 mb-2">
          撰写状态：{writing.phase}
          {writing.agent6Summary && (
            <span className="block text-gray-300 mt-1">{writing.agent6Summary}</span>
          )}
          {writing.agent6Supplement && (
            <pre className="block mt-2 text-xs text-gray-400 whitespace-pre-wrap max-h-40 overflow-auto border border-vscode-panel-border rounded p-2">
              {writing.agent6Supplement}
            </pre>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto border border-vscode-panel-border rounded p-2 bg-vscode-editor-bg">
          {writing.paragraphs.length === 0 ? (
            <p className="text-xs text-gray-500">尚无段落，请先生成初稿。</p>
          ) : (
            writing.paragraphs.map((p) => (
              <ParagraphBlock
                key={p.id}
                p={p}
                styleAnn={styleByParagraph(p.id)}
                qualityAnn={qualityByParagraph(p.id)}
                resolved={writing.qualityResolvedIds.has(p.id)}
                peek={writing.peek}
                onPeekRewrite={peekRewrite}
                onResolvePeek={resolvePeek}
                onStyleAction={(id, action, patch) =>
                  applyStyleAction(id, action, patch)
                }
                onQualityChoice={applyQualityChoice}
              />
            ))
          )}
        </div>
        {busy && <div className="text-xs text-amber-400 mt-2">处理中…</div>}
      </section>
    </div>
  );
}
