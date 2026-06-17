import React, { useEffect, useState } from 'react';

const DEFAULT_WRITING = {
  mode: 'command_driven',
  roleplayInteractionLevel: 'director_mediated',
  roleplayMaxInteractionRounds: 3,
  roleplayProfileGate: 'block_and_ask',
  roleplayAutofillScope: 'fill_missing_and_weak',
  roleplayAutofillAlignment: 'current_scene',
  characterMemoryUpdate: 'after_confirmed_write',
};

export function WritingSettings() {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [writing, setWriting] = useState(DEFAULT_WRITING);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const cfg = await mana?.config?.getApp?.();
        if (!cancelled) setWriting({ ...DEFAULT_WRITING, ...(cfg?.writing || {}) });
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [mana]);

  async function save() {
    try {
      await mana?.config?.setApp?.({ writing });
      setSavedFlash(true);
      setError('');
      setTimeout(() => setSavedFlash(false), 1200);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  function update(patch) {
    setWriting((current) => ({ ...current, ...patch }));
  }

  function normalizeRounds(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return DEFAULT_WRITING.roleplayMaxInteractionRounds;
    return Math.min(99, Math.max(0, Math.trunc(raw)));
  }

  return (
    <div className="space-y-6 text-sm text-gray-300 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-100 mb-1">写作设置</h2>
        <p className="text-xs text-gray-500">选择章节草稿的默认生成方式。命令驱动保持旧流程，角色驱动会先让角色根据自身设定与记忆提出反应，再由导演层合并。</p>
      </div>

      {error && (
        <div className="text-xs text-rose-300 border border-rose-500/30 bg-rose-500/10 rounded p-2">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <div className="text-xs font-semibold text-gray-400 uppercase">默认写作模式</div>
        <label className="flex gap-2 items-start">
          <input
            type="radio"
            name="writing-mode"
            value="command_driven"
            checked={writing.mode === 'command_driven'}
            onChange={() => update({ mode: 'command_driven' })}
          />
          <span>
            <span className="block text-gray-100">命令驱动式写作</span>
            <span className="block text-xs text-gray-500">沿用现有流程：按用户指令生成草稿，再做人设、时空和行文审查。</span>
          </span>
        </label>
        <label className="flex gap-2 items-start">
          <input
            type="radio"
            name="writing-mode"
            value="roleplay_driven"
            checked={writing.mode === 'roleplay_driven'}
            onChange={() => update({ mode: 'roleplay_driven' })}
          />
          <span>
            <span className="block text-gray-100">角色驱动式写作</span>
            <span className="block text-xs text-gray-500">出场角色先根据角色卡和记忆生成真实反应，由导演层约束后交给 writer 成文。</span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <label className="block">
          <span className="block text-xs font-semibold text-gray-400 uppercase mb-1">角色互动强度</span>
          <select
            className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-sm text-gray-100"
            value={writing.roleplayInteractionLevel}
            onChange={(e) => update({ roleplayInteractionLevel: e.target.value })}
          >
            <option value="independent">independent - 角色只独立提案</option>
            <option value="director_mediated">director_mediated - 导演组织一轮回应</option>
            <option value="deep_interaction">deep_interaction - 使用下方互动轮数</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-400 uppercase mb-1">deep_interaction 最大互动轮数</span>
          <input
            type="number"
            min={0}
            max={99}
            className="w-28 bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1 text-sm text-gray-100"
            value={writing.roleplayMaxInteractionRounds ?? DEFAULT_WRITING.roleplayMaxInteractionRounds}
            onChange={(e) => update({ roleplayMaxInteractionRounds: normalizeRounds(e.target.value) })}
          />
          <span className="ml-2 text-xs text-gray-500">默认 3，最大 99。</span>
        </label>
        {(writing.roleplayMaxInteractionRounds ?? DEFAULT_WRITING.roleplayMaxInteractionRounds) >= 5 && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            互动轮数设置为 5 次及以上会明显增加耗时、费用和角色跑偏概率；长群戏建议先小轮数试写，再针对关键段落加深互动。
          </div>
        )}
        <p className="text-xs text-gray-500">默认推荐 director_mediated；deep_interaction 更适合对峙、谈判、争吵、告白、审讯等高冲突群戏。</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/40">
          <div className="text-xs font-semibold text-gray-400 mb-1">资料不足处理</div>
          <div className="text-sm text-gray-100">先阻塞并询问用户</div>
          <div className="text-xs text-gray-500 mt-1">角色驱动模式下，缺少关键资料时不会静默继续。</div>
        </div>
        <div className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/40">
          <div className="text-xs font-semibold text-gray-400 mb-1">记忆更新</div>
          <div className="text-sm text-gray-100">确认写入后自动更新</div>
          <div className="text-xs text-gray-500 mt-1">草稿不会污染角色记忆；只有定稿写入后才更新。</div>
        </div>
      </section>

      <button
        type="button"
        className="px-3 py-1.5 bg-blue-700 text-white rounded hover:bg-blue-600"
        onClick={save}
      >
        {savedFlash ? '已保存' : '保存设置'}
      </button>
    </div>
  );
}
