import React, { useState } from 'react';
import { useWorkflowState } from '@/hooks/useWorkflowState.js';
import { AGENTS } from '@/agents/registry.js';
import { OUTLINE_PHASE } from '@/domain/types.js';
import { useI18n } from '@/i18n/LanguageContext.jsx';
import { Button, TextArea, Input, RadioGroup, Radio } from '@heroui/react';

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
          onClick={async () => {
            const action = await window.mana.prompt.show(
              '文风：输入 unify | memory | pass',
              'pass'
            );
            if (action === 'unify') onStyleAction(a.id, 'unify_style');
            else if (action === 'memory') {
              const patch = await window.mana.prompt.show('记忆补丁', '');
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
        hasQuality ? 'border-danger-500/40 bg-danger-900/20' : ''
      }`}
    >
      <div className="text-xs text-gray-500 mb-1">段落 {p.id}</div>
      <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
      {hasQuality && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {qualityAnn.map((q) => (
            <span key={q.id} className="text-danger-300" title={q.note}>
              {q.kind}: {q.note}
            </span>
          ))}
          <Button size="sm" onPress={() => onQualityChoice(p.id, 'keep')}>
            保留
          </Button>
          <Button size="sm" color="warning" onPress={() => onQualityChoice(p.id, 'rewrite')}>
            重写
          </Button>
          <Button size="sm" color="primary" onPress={() => onPeekRewrite(p.id)}>
            Peek 重写
          </Button>
        </div>
      )}
      {showPeek && (
        <div className="mt-2 border border-vscode-panel-border rounded p-2 bg-vscode-sidebar text-xs">
          <div className="font-bold mb-1 text-gray-400">Peek 预览</div>
          <div className="text-gray-300 mb-2 whitespace-pre-wrap">
            {peek.candidate || '（请求中…）'}
          </div>
          <div className="flex gap-2">
            <Button size="sm" color="success" onPress={() => onResolvePeek('accept')}>
              接受
            </Button>
            <Button size="sm" onPress={() => onPeekRewrite(p.id)}>
              重写
            </Button>
            <Button size="sm" color="danger" onPress={() => onResolvePeek('discard')}>
              放弃
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkflowPanel() {
  const { t } = useI18n();
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
      <section>
        <div className="text-xs font-bold text-gray-500 uppercase mb-2">
          {t('workflow.title')}
        </div>
        <p className="text-xs text-gray-500 mb-2">
          {t('workflow.hint')} Agent:
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
        <div className="font-bold mb-3">{t('workflow.outlineStage')}</div>
        <RadioGroup
          orientation="horizontal"
          value={mode}
          onValueChange={setMode}
          className="mb-3"
          size="sm"
        >
          <Radio value="plot_direction">剧情走向</Radio>
          <Radio value="user_outline">已有大纲</Radio>
        </RadioGroup>
        <TextArea
          className="mb-3"
          rows={3}
          aria-label="用户输入"
          value={userText}
          onChange={(e) => setUserText(e.target.value)}
        />
        <div className="flex flex-wrap gap-2 mb-2">
          <Button
            size="sm"
            color="primary"
            isDisabled={busy}
            onPress={() => startInput(mode, userText)}
          >
            记录输入
          </Button>
          <Button
            size="sm"
            color="secondary"
            isDisabled={busy}
            onPress={() => {
              const mana = typeof window !== 'undefined' ? window.mana : null;
              runOutline(mana?.novel?.readCharacter ? async (id) => mana.novel.readCharacter(id) : undefined);
            }}
          >
            运行 Agent1→2/3
          </Button>
          <Button
            size="sm"
            onPress={() => resolveIssues(outline.blockingIssues.map((i) => i.id))}
          >
            一键消除阻塞项（演示）
          </Button>
          <Button
            size="sm"
            color="success"
            onPress={() => confirm()}
          >
            确认大纲
          </Button>
        </div>
        <div className="text-xs text-gray-500">
          状态：<span className="text-gray-300">{outline.phase}</span>
          {outline.lastError && (
            <span className="text-danger-400 ml-2">{outline.lastError}</span>
          )}
        </div>
        {outline.blockingIssues.length > 0 && (
          <ul className="mt-2 text-xs space-y-1">
            {outline.blockingIssues.map((i) => (
              <li key={i.id} className="text-warning-500">
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
        <div className="font-bold mb-3">{t('workflow.writingStage')}</div>
        <div className="flex gap-4 mb-3 items-end">
          <Input
            type="number"
            label={t('workflow.targetWords')}
            size="sm"
            className="w-32"
            value={words}
            onChange={(e) => setWords(Number(e.target.value))}
          />
          <Input
            type="number"
            label={t('workflow.chapterCount')}
            size="sm"
            className="w-24"
            min={1}
            value={chapters}
            onChange={(e) => setChapters(Number(e.target.value))}
          />
          <Button
            size="sm"
            onPress={() => applyReq(words, chapters, '')}
          >
            {t('workflow.applyRequirements')}
          </Button>
        </div>
        <div className="mb-3">
          <TextArea
            label="文风记忆（localStorage）"
            size="sm"
            rows={2}
            value={styleMemoryDraft}
            onChange={(e) => setStyleMemoryDraft(e.target.value)}
          />
          <Button
            size="sm"
            className="mt-2"
            onPress={() => saveStyle()}
          >
            保存文风记忆
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          <Button
            size="sm"
            color="success"
            isDisabled={busy || outline.phase !== OUTLINE_PHASE.CONFIRMED}
            onPress={() => genDraft()}
          >
            远程生成初稿
          </Button>
          <Button
            size="sm"
            isDisabled={busy}
            onPress={() => runAgent4()}
          >
            Agent4 文风
          </Button>
          <Button
            size="sm"
            isDisabled={busy}
            onPress={() => runAgent5()}
          >
            Agent5 质量
          </Button>
          <Button
            size="sm"
            onPress={() => bulkKeepAll()}
          >
            全部保留（质量）
          </Button>
          <Button
            size="sm"
            isDisabled={busy}
            onPress={() => bulkRewrite()}
          >
            全部重写（质量，未决策段）
          </Button>
          <Button
            size="sm"
            onPress={() => markReadyToSave()}
          >
            准备存档
          </Button>
          <Button
            size="sm"
            color="secondary"
            isDisabled={busy}
            onPress={() => runAgent6()}
          >
            本章存档 / Agent6
          </Button>
          <Button
            size="sm"
            color="danger"
            onPress={() => finalizeChapter()}
          >
            结束本章
          </Button>
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
