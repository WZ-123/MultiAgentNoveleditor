import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

function extractSuggestPatches(text) {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0] || '');
  if (!candidate) return null;
  try {
    const obj = JSON.parse(candidate);
    if (obj && Array.isArray(obj.suggestPatches)) return obj.suggestPatches;
  } catch { /* ignore */ }
  return null;
}

export function ConfigHelperChat() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]); // [{role, text, suggestPatches?}]
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [streamRunId, setStreamRunId] = useState(null);
  const [streamingText, setStreamingText] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [history, streamingText]);

  useEffect(() => {
    if (!mana?.runtime?.on) return;
    const off = mana.runtime.on('agent:event', (payload) => {
      if (!streamRunId || payload.runId !== streamRunId) return;
      if (payload.kind === 'text' && payload.data?.delta) {
        setStreamingText((prev) => prev + payload.data.delta);
      }
    });
    return () => { try { off(); } catch { /* ignore */ } };
  }, [mana, streamRunId]);

  const onAsk = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !mana?.runtime?.runSubagent) return;
    setErrorMsg('');
    setRunning(true);
    const userEntry = { role: 'user', text: trimmed };
    setHistory((h) => [...h, userEntry]);
    setInput('');
    setStreamingText('');
    // Generate runId upfront so events during the call are captured
    const expectedRunId = `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setStreamRunId(expectedRunId);
    try {
      const res = await mana.runtime.runSubagent({
        subagentId: 'sa-config-helper',
        input: trimmed,
        userLang: 'zh-CN',
        runId: expectedRunId,
      });
      const text = res.output || '';
      const patches = extractSuggestPatches(text);
      setHistory((h) => [...h, { role: 'assistant', text, suggestPatches: patches }]);
      setStreamingText('');
    } catch (err) {
      setErrorMsg(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  }, [input, mana]);

  const onApplyPatch = useCallback(async (patch) => {
    if (!mana?.config) return;
    try {
      if (patch.kind === 'preset') {
        const cur = await mana.config.getPreset(patch.id);
        if (!cur) throw new Error(`preset not found: ${patch.id}`);
        const next = { ...cur, ...patch.patch };
        await mana.config.savePreset(next);
      } else if (patch.kind === 'subagent') {
        const cur = await mana.config.getSubagent(patch.id);
        if (!cur) throw new Error(`subagent not found: ${patch.id}`);
        if (cur.builtIn) {
          throw new Error(`built-in subagent "${patch.id}" must be cloned before patching`);
        }
        const next = { ...cur, ...patch.patch };
        await mana.config.saveSubagent(next);
      } else if (patch.kind === 'dag') {
        const cur = await mana.config.getDag(patch.id);
        if (!cur) throw new Error(`dag not found: ${patch.id}`);
        if (cur.builtIn) {
          throw new Error(`built-in DAG "${patch.id}" must be cloned before patching`);
        }
        const next = { ...cur, ...patch.patch };
        await mana.config.saveDag(next);
      } else {
        throw new Error(`unknown patch kind: ${patch.kind}`);
      }
      setHistory((h) => [...h, { role: 'system', text: `Applied patch to ${patch.kind}/${patch.id}` }]);
    } catch (err) {
      setHistory((h) => [...h, { role: 'system', text: `Apply failed: ${err.message || err}` }]);
    }
  }, [mana]);

  return (
    <div className="space-y-3">
      <div>
        <div className="font-bold text-sm">配置助手</div>
        <p className="text-xs text-gray-500 mt-1">
          基于 skill.md 与当前 preset/subagent/DAG，向 sa-config-helper 提问以获得 JSON 配置建议。
        </p>
      </div>

      <div
        ref={containerRef}
        className="border border-vscode-panel-border rounded p-2 bg-vscode-sidebar/30 h-72 overflow-auto space-y-2 text-xs"
      >
        {history.map((m, idx) => (
          <div
            key={idx}
            className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[80%] rounded px-2 py-1 ${
              m.role === 'user'
                ? 'bg-vscode-list-activeSelectionBackground text-white'
                : m.role === 'system'
                  ? 'bg-amber-500/20 text-amber-200'
                  : 'bg-vscode-editor-bg text-gray-200'
            }`}
            >
              <pre className="whitespace-pre-wrap break-words font-sans">{m.text}</pre>
              {m.suggestPatches && m.suggestPatches.length > 0 && (
                <div className="mt-2 border-t border-white/10 pt-2 space-y-1">
                  <div className="text-[10px] uppercase text-gray-400">{m.suggestPatches.length} suggested patch(es)</div>
                  {m.suggestPatches.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <Chip size="sm" variant="flat">{p.kind}</Chip>
                      <span className="font-mono text-gray-300">{p.id}</span>
                      <span className="flex-1 truncate text-gray-400">{p.reason}</span>
                      <Button size="sm" variant="flat" onPress={() => onApplyPatch(p)}>apply</Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {streamingText && (
          <div className="flex gap-2 justify-start">
            <div className="max-w-[80%] rounded px-2 py-1 bg-vscode-editor-bg text-gray-300">
              <pre className="whitespace-pre-wrap break-words font-sans opacity-60">{streamingText}</pre>
            </div>
          </div>
        )}
        {!history.length && !streamingText && (
          <div className="text-gray-500 px-2 py-3">
            示例：「我想降低成本，请把所有 opus 槽换成 haiku，并切到 cheap DAG」
          </div>
        )}
      </div>

      {!!errorMsg && <Chip size="sm" color="danger" variant="flat">{errorMsg}</Chip>}

      <div className="flex gap-2">
        <textarea
          className="flex-1 bg-vscode-sidebar border border-vscode-panel-border rounded p-2 text-xs"
          rows={3}
          placeholder="问点什么…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) onAsk();
          }}
        />
        <Button color="primary" onPress={onAsk} isDisabled={running || !input.trim()}>
          {running ? '…' : 'Ask'}
        </Button>
      </div>
    </div>
  );
}
