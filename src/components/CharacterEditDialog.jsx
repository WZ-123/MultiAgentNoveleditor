import React, { useState } from 'react';
import { Loader2, Plus, Save, Trash2, X } from 'lucide-react';

const GENDER_OPTIONS = ['', '女', '男', '非二元/其他', '未知'];

function splitList(value) {
  return String(value || '')
    .split(/[,，、;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function Field({ label, value, onChange, placeholder = '', multiline = false, rows = 3 }) {
  const className = 'w-full rounded border border-vscode-panel-border bg-vscode-sidebar px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500';
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-gray-400">{label}</span>
      {multiline ? (
        <textarea
          value={value || ''}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={rows}
          className={`${className} resize-y`}
        />
      ) : (
        <input
          value={value || ''}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={className}
        />
      )}
    </label>
  );
}

export function CharacterEditDialog({ character, saving = false, onCancel, onSave, onDelete }) {
  const [draft, setDraft] = useState(() => ({
    ...character,
    aliasesText: Array.isArray(character.aliases) ? character.aliases.join('、') : String(character.aliases || ''),
    relationshipRows: Array.isArray(character.relationships) ? character.relationships.map((item) => ({ ...item })) : [],
    skinRows: Array.isArray(character.skins) ? character.skins.map((item) => ({ ...item })) : [],
    attributeRows: Object.entries(character.attributes || {}).map(([key, value]) => ({ key, value: String(value ?? '') })),
  }));
  const [error, setError] = useState('');
  const customGender = draft.gender && !GENDER_OPTIONS.includes(draft.gender) ? draft.gender : '';
  const originType = draft.isOriginal === true ? 'original' : draft.isOriginal === false ? 'fanwork' : 'unmarked';

  const patch = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  const submit = async () => {
    const name = String(draft.name || '').trim();
    if (!name) {
      setError('角色姓名不能为空');
      return;
    }
    if (draft.isOriginal === false && !String(draft.sourceWork || '').trim()) {
      setError('二创角色必须填写原作名称，否则无法准确联网补全');
      return;
    }
    const next = {
      ...draft,
      name,
      aliases: splitList(draft.aliasesText),
      relationships: draft.relationshipRows
        .map((item) => ({ with: String(item.with || '').trim(), type: String(item.type || '').trim() }))
        .filter((item) => item.with || item.type),
      skins: draft.skinRows
        .map((item) => ({
          name: String(item.name || '').trim(),
          outfit: String(item.outfit || '').trim(),
          story: String(item.story || '').trim(),
          quotes: String(item.quotes || '').trim(),
          ...(item.scenario ? { scenario: String(item.scenario).trim() } : {}),
        }))
        .filter((item) => item.name || item.outfit || item.story || item.quotes),
      attributes: Object.fromEntries(draft.attributeRows
        .map((item) => [String(item.key || '').trim(), String(item.value || '').trim()])
        .filter(([key]) => key)),
      sourceWork: draft.isOriginal === true ? '' : String(draft.sourceWork || '').trim(),
      originalName: draft.isOriginal === true ? '' : String(draft.originalName || '').trim(),
    };
    delete next.aliasesText;
    delete next.relationshipRows;
    delete next.skinRows;
    delete next.attributeRows;
    setError('');
    await onSave?.(next);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-vscode-panel-border bg-vscode-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-vscode-panel-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-gray-100">编辑角色卡</div>
            <div className="mt-0.5 text-[10px] text-gray-500">ID: {draft.id}</div>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-500 hover:text-gray-200 disabled:opacity-40" aria-label="关闭角色编辑">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <section className="space-y-3">
            <div className="text-xs font-semibold text-gray-300">基本资料</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="角色姓名 *" value={draft.name} onChange={(value) => patch('name', value)} />
              <Field label="别名（用顿号或换行分隔）" value={draft.aliasesText} onChange={(value) => patch('aliasesText', value)} />
              <label className="block space-y-1">
                <span className="text-[11px] text-gray-400">性别</span>
                <select value={draft.gender || ''} onChange={(event) => patch('gender', event.target.value)} className="w-full rounded border border-vscode-panel-border bg-vscode-sidebar px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500">
                  {GENDER_OPTIONS.map((value) => <option key={value || 'empty'} value={value}>{value || '-- 未填写 --'}</option>)}
                  {customGender && <option value={customGender}>{customGender}</option>}
                </select>
              </label>
              <Field label="年龄" value={draft.age} onChange={(value) => patch('age', value)} />
              <Field label="故事定位" value={draft.role} onChange={(value) => patch('role', value)} placeholder="例如：主角、对手、友方" />
              <Field label="阵营/组织" value={draft.faction} onChange={(value) => patch('faction', value)} />
              <label className="flex items-center gap-2 self-end pb-1 text-xs text-gray-300">
                <input type="checkbox" checked={draft.protagonist === true} onChange={(event) => patch('protagonist', event.target.checked)} className="accent-blue-500" />
                标记为主要角色
              </label>
            </div>
          </section>

          <section className="space-y-3 rounded border border-vscode-panel-border/70 bg-vscode-sidebar/30 p-3">
            <div>
              <div className="text-xs font-semibold text-gray-300">角色归属</div>
              <div className="mt-0.5 text-[10px] text-gray-500">这里直接决定该角色是否参与联网补全。</div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-1.5 text-gray-300">
                <input type="radio" name="character-origin" checked={originType === 'original'} onChange={() => setDraft((current) => ({ ...current, isOriginal: true }))} />
                原创角色
              </label>
              <label className="flex items-center gap-1.5 text-gray-300">
                <input type="radio" name="character-origin" checked={originType === 'fanwork'} onChange={() => setDraft((current) => ({ ...current, isOriginal: false }))} />
                二创角色
              </label>
              <label className="flex items-center gap-1.5 text-gray-500">
                <input type="radio" name="character-origin" checked={originType === 'unmarked'} onChange={() => setDraft((current) => {
                  const next = { ...current };
                  delete next.isOriginal;
                  return next;
                })} />
                未确认
              </label>
            </div>
            {originType === 'fanwork' && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="原作名称 *" value={draft.sourceWork} onChange={(value) => patch('sourceWork', value)} placeholder="例如：蔚蓝档案" />
                <Field label="原作官方姓名" value={draft.originalName} onChange={(value) => patch('originalName', value)} placeholder="与小说内称呼相同时可留空" />
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="text-xs font-semibold text-gray-300">人设信息</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="发色" value={draft.hairColor} onChange={(value) => patch('hairColor', value)} />
              <Field label="瞳色" value={draft.eyeColor} onChange={(value) => patch('eyeColor', value)} />
              <Field label="身高" value={draft.height} onChange={(value) => patch('height', value)} />
              <Field label="体型/身材" value={draft.figure} onChange={(value) => patch('figure', value)} />
            </div>
            <Field label="外貌" value={draft.appearance} onChange={(value) => patch('appearance', value)} multiline />
            <Field label="性格" value={draft.personality} onChange={(value) => patch('personality', value)} multiline />
            <Field label="背景" value={draft.background} onChange={(value) => patch('background', value)} multiline rows={4} />
            <Field label="萌点/特征" value={draft.moeTraits} onChange={(value) => patch('moeTraits', value)} multiline rows={2} />
            <Field label="代表台词" value={draft.quotes} onChange={(value) => patch('quotes', value)} multiline rows={3} />
            <Field label="剧情作用/角色弧" value={draft.storyArc} onChange={(value) => patch('storyArc', value)} multiline rows={3} />
            <Field label="完整档案/备注" value={draft.bio} onChange={(value) => patch('bio', value)} multiline rows={3} />
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-gray-300">角色关系</div>
              <button type="button" onClick={() => patch('relationshipRows', [...draft.relationshipRows, { with: '', type: '' }])} className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"><Plus size={11} />添加关系</button>
            </div>
            {draft.relationshipRows.length === 0 ? <div className="text-[10px] text-gray-600">暂无关系记录</div> : draft.relationshipRows.map((item, index) => (
              <div key={`relationship-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Field label="对方角色" value={item.with} onChange={(value) => patch('relationshipRows', draft.relationshipRows.map((row, rowIndex) => rowIndex === index ? { ...row, with: value } : row))} />
                <Field label="关系类型" value={item.type} onChange={(value) => patch('relationshipRows', draft.relationshipRows.map((row, rowIndex) => rowIndex === index ? { ...row, type: value } : row))} />
                <button type="button" onClick={() => patch('relationshipRows', draft.relationshipRows.filter((_, rowIndex) => rowIndex !== index))} className="mt-5 text-rose-500/70 hover:text-rose-400" aria-label={`删除第 ${index + 1} 条关系`}><Trash2 size={13} /></button>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-gray-300">皮肤/形态</div>
              <button type="button" onClick={() => patch('skinRows', [...draft.skinRows, { name: '', outfit: '', story: '', quotes: '' }])} className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"><Plus size={11} />添加皮肤</button>
            </div>
            {draft.skinRows.length === 0 ? <div className="text-[10px] text-gray-600">暂无皮肤或特殊形态</div> : draft.skinRows.map((item, index) => (
              <div key={`skin-${index}`} className="space-y-2 rounded border border-vscode-panel-border/60 p-3">
                <div className="flex items-start gap-2">
                  <div className="grid flex-1 grid-cols-1 gap-2 md:grid-cols-2">
                    <Field label="名称" value={item.name} onChange={(value) => patch('skinRows', draft.skinRows.map((row, rowIndex) => rowIndex === index ? { ...row, name: value } : row))} />
                    <Field label="服装/外观" value={item.outfit} onChange={(value) => patch('skinRows', draft.skinRows.map((row, rowIndex) => rowIndex === index ? { ...row, outfit: value } : row))} />
                    <Field label="故事背景" value={item.story} onChange={(value) => patch('skinRows', draft.skinRows.map((row, rowIndex) => rowIndex === index ? { ...row, story: value } : row))} multiline rows={2} />
                    <Field label="代表台词" value={item.quotes} onChange={(value) => patch('skinRows', draft.skinRows.map((row, rowIndex) => rowIndex === index ? { ...row, quotes: value } : row))} multiline rows={2} />
                  </div>
                  <button type="button" onClick={() => patch('skinRows', draft.skinRows.filter((_, rowIndex) => rowIndex !== index))} className="mt-5 text-rose-500/70 hover:text-rose-400" aria-label={`删除第 ${index + 1} 个皮肤`}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-gray-300">自定义细节</div>
              <button type="button" onClick={() => patch('attributeRows', [...draft.attributeRows, { key: '', value: '' }])} className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"><Plus size={11} />添加细节</button>
            </div>
            {draft.attributeRows.length === 0 ? <div className="text-[10px] text-gray-600">暂无自定义细节</div> : draft.attributeRows.map((item, index) => (
              <div key={`attribute-${index}`} className="grid grid-cols-[minmax(120px,0.4fr)_1fr_auto] gap-2">
                <Field label="字段名" value={item.key} onChange={(value) => patch('attributeRows', draft.attributeRows.map((row, rowIndex) => rowIndex === index ? { ...row, key: value } : row))} />
                <Field label="内容" value={item.value} onChange={(value) => patch('attributeRows', draft.attributeRows.map((row, rowIndex) => rowIndex === index ? { ...row, value } : row))} multiline rows={2} />
                <button type="button" onClick={() => patch('attributeRows', draft.attributeRows.filter((_, rowIndex) => rowIndex !== index))} className="mt-5 text-rose-500/70 hover:text-rose-400" aria-label={`删除第 ${index + 1} 个自定义细节`}><Trash2 size={13} /></button>
              </div>
            ))}
          </section>

          {error && <div className="rounded border border-rose-700/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-vscode-panel-border px-4 py-3">
          <button type="button" onClick={() => onDelete?.(character)} disabled={saving} className="flex items-center gap-1 rounded border border-rose-800/60 px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-950/40 disabled:opacity-40">
            <Trash2 size={12} />删除这个角色
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} disabled={saving} className="rounded border border-vscode-panel-border px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-40">取消</button>
            <button type="button" onClick={submit} disabled={saving} className="flex items-center gap-1 rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600 disabled:opacity-40">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {saving ? '保存中...' : '保存角色卡'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
