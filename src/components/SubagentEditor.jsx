import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Chip } from '@heroui/react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

const TIER_OPTIONS = ['opus', 'sonnet', 'haiku'];

const READ_TOOLS = [
  'list_characters', 'read_character',
  'list_assets', 'read_asset',
  'query_timeline', 'check_timeline_feasibility',
  'query_world',
  'read_outline', 'read_chapter',
  'read_style_memory', 'read_skill',
  'search_index',
];

const WRITE_AUTO_TOOLS = [
  'grant_asset', 'revoke_asset',
  'append_timeline', 'append_summary', 'append_style_memory',
];

const WRITE_CONFIRM_TOOLS = [
  'create_character', 'update_character', 'update_world',
];

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_AUTO_TOOLS, ...WRITE_CONFIRM_TOOLS];

function emptySubagentTemplate() {
  return {
    id: `sa-${Date.now().toString(36)}`,
    name: 'sa-custom',
    displayName: 'New Subagent',
    tier: 'sonnet',
    systemPrompt: '',
    allowedTools: [],
    runtimeHints: { maxTurns: 4 },
    tags: [],
    schemaVersion: 1,
    builtIn: false,
  };
}

export function SubagentEditor() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [subagents, setSubagents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [loadError, setLoadError] = useState('');

  const refresh = useCallback(async () => {
    if (!mana?.config) {
      setLoadError(t('manaRuntime.bridgeMissing'));
      return;
    }
    try {
      const list = await mana.config.listSubagents();
      const sorted = (list || []).slice().sort((a, b) => {
        if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
        return (a.displayName || a.id).localeCompare(b.displayName || b.id);
      });
      setSubagents(sorted);
      if (!selectedId && sorted.length) {
        setSelectedId(sorted[0].id);
        setDraft({ ...sorted[0] });
      } else if (selectedId) {
        const found = sorted.find((s) => s.id === selectedId);
        if (found) setDraft({ ...found });
        else if (sorted.length) {
          setSelectedId(sorted[0].id);
          setDraft({ ...sorted[0] });
        } else {
          setSelectedId(null);
          setDraft(null);
        }
      }
    } catch (e) {
      setLoadError(e?.message || String(e));
    }
  }, [mana, t, selectedId]);

  useEffect(() => { refresh(); }, [refresh]);

  const onSelect = useCallback((id) => {
    setSelectedId(id);
    const found = subagents.find((s) => s.id === id);
    if (found) setDraft({ ...found });
  }, [subagents]);

  const updateDraft = useCallback((patch) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }, []);

  const toggleTool = useCallback((tool) => {
    setDraft((d) => {
      if (!d) return d;
      const set = new Set(d.allowedTools || []);
      if (set.has(tool)) set.delete(tool); else set.add(tool);
      return { ...d, allowedTools: Array.from(set) };
    });
  }, []);

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, []);

  const onSave = useCallback(async () => {
    if (!mana?.config || !draft) return;
    if (draft.builtIn) {
      alert(t('subagent.cannotEditBuiltin'));
      return;
    }
    const next = {
      ...draft,
      runtimeHints: { ...(draft.runtimeHints || {}), maxTurns: Number(draft.runtimeHints?.maxTurns) || 4 },
      schemaVersion: 1,
    };
    await mana.config.saveSubagent(next);
    flashSaved();
    await refresh();
  }, [mana, draft, t, flashSaved, refresh]);

  const onClone = useCallback(async () => {
    if (!mana?.config || !draft) return;
    if (draft.builtIn) {
      const newId = `${draft.id}-copy-${Date.now().toString(36)}`;
      const cloned = await mana.config.cloneBuiltinSubagent(draft.id, newId);
      setSelectedId(cloned.id);
      setDraft({ ...cloned });
      await refresh();
    } else {
      const newId = `sa-copy-${Date.now().toString(36)}`;
      const next = { ...draft, id: newId, builtIn: false, displayName: `${draft.displayName} (copy)` };
      await mana.config.saveSubagent(next);
      setSelectedId(newId);
      setDraft(next);
      await refresh();
    }
  }, [mana, draft, refresh]);

  const onCreate = useCallback(async () => {
    if (!mana?.config) return;
    const next = emptySubagentTemplate();
    await mana.config.saveSubagent(next);
    setSelectedId(next.id);
    setDraft(next);
    await refresh();
  }, [mana, refresh]);

  const onDelete = useCallback(async () => {
    if (!mana?.config || !draft) return;
    if (draft.builtIn) { alert(t('subagent.cannotEditBuiltin')); return; }
    if (!confirm(t('subagent.deleteConfirm').replace('{name}', draft.displayName || draft.id))) return;
    await mana.config.deleteSubagent(draft.id);
    setSelectedId(null);
    setDraft(null);
    await refresh();
  }, [mana, draft, t, refresh]);

  const isReadOnly = !!draft?.builtIn;

  if (loadError) {
    return <div className="p-3 text-xs text-red-400">{loadError}</div>;
  }

  return (
    <section className="pt-1">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div>
          <div className="font-bold text-sm">{t('subagent.title')}</div>
          <p className="text-xs text-gray-500 mt-1">{t('subagent.desc')}</p>
        </div>
        <Button color="primary" size="sm" onPress={onCreate}>{t('subagent.newSubagent')}</Button>
      </div>

      <div className="grid grid-cols-12 gap-3">
        {/* Sidebar list */}
        <div className="col-span-4 border border-vscode-panel-border rounded p-2 bg-vscode-sidebar/30 max-h-[60vh] overflow-y-auto">
          {subagents.map((sa) => (
            <button
              key={sa.id}
              type="button"
              onClick={() => onSelect(sa.id)}
              className={`w-full text-left px-2 py-2 text-xs rounded mb-1 ${
                selectedId === sa.id ? 'bg-vscode-list-activeSelectionBackground text-white' : 'hover:bg-vscode-list-hoverBackground'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate flex-1">{sa.displayName || sa.id}</span>
                {sa.builtIn && (
                  <Chip size="sm" variant="flat" color="default">{t('subagent.builtin')}</Chip>
                )}
              </div>
              <div className="text-[10px] text-gray-500 truncate">{sa.id} · tier={sa.tier}</div>
            </button>
          ))}
          {!subagents.length && (
            <div className="text-xs text-gray-500 px-2 py-3">{t('subagent.empty')}</div>
          )}
        </div>

        {/* Detail panel */}
        <div className="col-span-8 border border-vscode-panel-border rounded p-3 bg-vscode-editor-bg/50 max-h-[60vh] overflow-y-auto">
          {!draft ? (
            <div className="text-xs text-gray-500 px-2 py-3">{t('subagent.selectOne')}</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {draft.builtIn ? (
                  <Chip size="sm" color="warning" variant="flat">{t('subagent.builtinReadOnly')}</Chip>
                ) : (
                  <Chip size="sm" color="success" variant="flat">{t('subagent.userEditable')}</Chip>
                )}
                <div className="text-xs font-mono text-gray-500 ml-auto">{draft.id}</div>
              </div>

              <Input
                size="sm"
                label={t('subagent.displayName')}
                value={draft.displayName || ''}
                onChange={(e) => updateDraft({ displayName: e.target.value })}
                readOnly={isReadOnly}
              />

              <Input
                size="sm"
                label={t('subagent.name')}
                value={draft.name || ''}
                onChange={(e) => updateDraft({ name: e.target.value })}
                readOnly={isReadOnly}
              />

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-gray-500">{t('subagent.tier')}</span>
                <select
                  className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-2 text-xs"
                  value={draft.tier || 'sonnet'}
                  onChange={(e) => updateDraft({ tier: e.target.value })}
                  disabled={isReadOnly}
                >
                  {TIER_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-gray-500">{t('subagent.systemPrompt')}</span>
                <textarea
                  className="bg-vscode-sidebar border border-vscode-panel-border rounded p-2 font-mono text-xs"
                  rows={10}
                  value={draft.systemPrompt || ''}
                  onChange={(e) => updateDraft({ systemPrompt: e.target.value })}
                  readOnly={isReadOnly}
                />
              </label>

              <Input
                size="sm"
                label={t('subagent.maxTurns')}
                type="number"
                value={String(draft.runtimeHints?.maxTurns ?? 4)}
                onChange={(e) => updateDraft({ runtimeHints: { ...(draft.runtimeHints || {}), maxTurns: Number(e.target.value) || 4 } })}
                readOnly={isReadOnly}
              />

              <div>
                <div className="text-xs font-semibold text-gray-400 mb-2">{t('subagent.allowedTools')}</div>
                {[
                  { label: t('subagent.toolsRead'), tools: READ_TOOLS },
                  { label: t('subagent.toolsWriteAuto'), tools: WRITE_AUTO_TOOLS },
                  { label: t('subagent.toolsWriteConfirm'), tools: WRITE_CONFIRM_TOOLS },
                ].map((group) => (
                  <div key={group.label} className="mb-2">
                    <div className="text-[10px] uppercase text-gray-500 mb-1">{group.label}</div>
                    <div className="flex flex-wrap gap-2">
                      {group.tools.map((tool) => {
                        const checked = (draft.allowedTools || []).includes(tool);
                        return (
                          <label key={tool} className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleTool(tool)}
                              disabled={isReadOnly}
                            />
                            <span className={checked ? 'text-gray-200' : 'text-gray-500'}>{tool}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t border-vscode-panel-border">
                <Button size="sm" variant="flat" onPress={onClone}>
                  {draft.builtIn ? t('subagent.cloneToCustomize') : t('subagent.duplicate')}
                </Button>
                <Button size="sm" color="primary" onPress={onSave} isDisabled={isReadOnly}>
                  {savedFlash ? t('subagent.saved') : t('subagent.save')}
                </Button>
                <Button size="sm" variant="flat" color="danger" onPress={onDelete} isDisabled={isReadOnly}>
                  {t('subagent.delete')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
