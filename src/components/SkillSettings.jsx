import React, { useEffect, useState } from 'react';
import { Book, Download, Upload, Plus, Trash2, Save, X, Edit3, Loader2 } from 'lucide-react';

export function SkillSettings() {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [skills, setSkills] = useState([]);
  const [subagents, setSubagents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', content: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');

  const load = async () => {
    if (!mana?.config) return;
    setLoading(true);
    try {
      const [skillList, subList] = await Promise.all([
        mana.config.listSkills(),
        mana.config.listSubagents(),
      ]);
      setSkills(Array.isArray(skillList) ? skillList : []);
      setSubagents(Array.isArray(subList) ? subList : []);
    } catch (err) {
      setError(err.message || String(err));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [mana]);

  const startEdit = async (skill) => {
    if (!mana?.config) return;
    const full = await mana.config.getSkill(skill.id);
    setEditingId(skill.id);
    setEditForm({
      name: full.name || '',
      description: full.description || '',
      content: full.content || '',
      tags: Array.isArray(full.tags) ? full.tags.join(', ') : '',
    });
  };

  const cancelEdit = () => { setEditingId(null); setEditForm({ name: '', description: '', content: '', tags: '' }); };

  const doSave = async () => {
    if (!mana?.config || !editingId) return;
    setSaving(true);
    try {
      await mana.config.saveSkill({
        id: editingId,
        name: editForm.name,
        description: editForm.description,
        content: editForm.content,
        tags: editForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setFeedback('已保存');
      setTimeout(() => setFeedback(''), 2000);
      setEditingId(null);
      await load();
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const doDelete = async (id) => {
    if (!mana?.config || !window.confirm('确定删除此技能？')) return;
    try {
      await mana.config.deleteSkill(id);
      await load();
    } catch (err) { setError(err.message); }
  };

  const toggleAssign = async (skillId, subagentId, currentlyAssigned) => {
    if (!mana?.config) return;
    try {
      if (currentlyAssigned) {
        await mana.config.unassignSkill(skillId, subagentId);
      } else {
        await mana.config.assignSkill(skillId, subagentId);
      }
      await load();
    } catch (err) { setError(err.message); }
  };

  const doExport = async (id) => {
    if (!mana?.config) return;
    try {
      const bundle = await mana.config.exportSkill(id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `skill-${id}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err.message); }
  };

  const doImport = async () => {
    if (!mana?.config) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        await mana.config.importSkill(bundle);
        setFeedback('已导入');
        setTimeout(() => setFeedback(''), 2000);
        await load();
      } catch (err) { setError(err.message); }
    };
    input.click();
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full text-gray-500 text-sm">
      <Loader2 size={16} className="animate-spin mr-2" /> 加载中…
    </div>
  );

  return (
    <div className="h-full flex flex-col text-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-vscode-panel-border shrink-0">
        <div className="flex items-center gap-2 font-bold text-gray-200">
          <Book size={16} /> 技能管理
        </div>
        <div className="flex gap-2">
          {feedback && <span className="text-[10px] text-green-400 self-center">{feedback}</span>}
          <button onClick={doImport} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><Upload size={11}/>导入</button>
        </div>
      </div>
      {error && <div className="px-4 py-1 text-[11px] text-rose-400">{error}</div>}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {skills.length === 0 ? (
          <div className="text-gray-500 italic">暂无技能。应用启动时会自动创建默认技能。</div>
        ) : (
          skills.map((s) => (
            <div key={s.id} className="border border-vscode-panel-border rounded p-3">
              {editingId === s.id ? (
                <div className="space-y-2">
                  <input className="w-full bg-vscode-input-bg text-gray-200 px-2 py-1 rounded text-xs"
                    value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    placeholder="技能名称" />
                  <input className="w-full bg-vscode-input-bg text-gray-200 px-2 py-1 rounded text-xs"
                    value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    placeholder="描述" />
                  <input className="w-full bg-vscode-input-bg text-gray-200 px-2 py-1 rounded text-xs"
                    value={editForm.tags} onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                    placeholder="标签（逗号分隔）" />
                  <textarea className="w-full h-40 bg-vscode-input-bg text-gray-200 px-2 py-1 rounded text-xs font-mono resize-none"
                    value={editForm.content} onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                    placeholder="Markdown 正文" />
                  <div className="flex gap-2">
                    <button onClick={doSave} disabled={saving}
                      className="px-3 py-0.5 bg-blue-700 text-white rounded text-xs disabled:opacity-40 flex items-center gap-1"><Save size={11}/>{saving ? '保存中' : '保存'}</button>
                    <button onClick={cancelEdit} className="px-3 py-0.5 bg-vscode-active-item text-gray-400 rounded text-xs flex items-center gap-1"><X size={11}/>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-semibold text-gray-200">{s.name}</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">{s.description}</div>
                      {Array.isArray(s.tags) && s.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {s.tags.map((t, i) => <span key={i} className="text-[10px] bg-vscode-active-item text-gray-400 px-1 rounded">{t}</span>)}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => startEdit(s)} className="text-gray-400 hover:text-gray-200" title="编辑"><Edit3 size={12}/></button>
                      <button onClick={() => doExport(s.id)} className="text-gray-400 hover:text-gray-200" title="导出"><Download size={12}/></button>
                      <button onClick={() => doDelete(s.id)} className="text-gray-400 hover:text-red-300" title="删除"><Trash2 size={12}/></button>
                    </div>
                  </div>
                  {/* Subagent assignment */}
                  {subagents.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-vscode-panel-border/50">
                      <div className="text-[10px] text-gray-500 mb-1">关联 Subagent：</div>
                      <div className="flex flex-wrap gap-1">
                        {subagents.map((sa) => {
                          const assigned = (s.assignedSubagentIds || []).includes(sa.id);
                          return (
                            <button key={sa.id}
                              onClick={() => toggleAssign(s.id, sa.id, assigned)}
                              className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                                assigned
                                  ? 'bg-blue-900/40 border-blue-700/40 text-blue-300'
                                  : 'bg-transparent border-gray-700/40 text-gray-500 hover:text-gray-400'
                              }`}
                            >{sa.displayName || sa.name}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
