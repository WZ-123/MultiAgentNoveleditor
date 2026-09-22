import React, { useEffect, useState } from 'react';
import { Download, Plus, Save, Trash2, Upload } from 'lucide-react';

export function SkillSettings() {
  const mana = window.mana;
  const [skills, setSkills] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const load = async () => setSkills(await mana.config.listSkills());
  useEffect(() => { load().catch((error) => setMessage(error.message)); }, []);
  const create = () => setSelected({ id: '', name: '', description: '', content: '# 新 Skill\n', enabled: true, builtIn: false });
  const save = async () => { await mana.config.saveSkill(selected); setSelected(null); await load(); setMessage('Skill 已保存，后续 Codex turn 可直接选择。'); };
  const exportOne = async (skill) => {
    const bundle = await mana.config.exportSkill(skill.id);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${skill.id}.codex-skill.json`; link.click(); URL.revokeObjectURL(url);
  };
  const importOne = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    await mana.config.importSkill(JSON.parse(await file.text())); await load();
  };
  return (
    <div className="mx-auto max-w-4xl space-y-4 text-gray-200">
      <div><h2 className="text-lg font-semibold">Codex Skills</h2><p className="mt-1 text-xs text-gray-500">内置 Skill 只读；自定义 Skill 由 Codex 原生加载，不再关联 Subagent 或 DAG。</p></div>
      <div className="flex gap-2"><button onClick={create} className="flex items-center gap-1 rounded border border-white/10 px-3 py-2 text-xs"><Plus size={13} />创建</button><label className="flex cursor-pointer items-center gap-1 rounded border border-white/10 px-3 py-2 text-xs"><Upload size={13} />导入<input type="file" accept=".json" className="hidden" onChange={importOne} /></label></div>
      <div className="grid gap-2 md:grid-cols-2">{skills.map((skill) => <div key={skill.id} className="rounded border border-white/10 bg-white/[0.03] p-3"><div className="flex items-start justify-between gap-2"><div><div className="font-medium">{skill.name}</div><div className="mt-1 text-[11px] text-gray-500">{skill.builtIn ? '内置 · 只读' : skill.enabled === false ? '已禁用' : '已启用'}</div></div><div className="flex gap-1"><button onClick={() => exportOne(skill)} className="rounded p-1.5 hover:bg-white/5"><Download size={13} /></button>{!skill.builtIn && <button onClick={async () => { await mana.config.deleteSkill(skill.id); await load(); }} className="rounded p-1.5 text-rose-300 hover:bg-rose-500/10"><Trash2 size={13} /></button>}</div></div><p className="mt-2 line-clamp-2 text-xs text-gray-400">{skill.description}</p><div className="mt-3 flex items-center justify-between">{!skill.builtIn && <label className="text-[11px] text-gray-400"><input type="checkbox" checked={skill.enabled !== false} onChange={async (event) => { await mana.config.setSkillEnabled(skill.id, event.target.checked); await load(); }} className="mr-1" />启用</label>}<button onClick={() => setSelected({ ...skill })} className="ml-auto text-[11px] text-blue-300">{skill.builtIn ? '查看' : '编辑'}</button></div></div>)}</div>
      {selected && <div className="rounded border border-white/10 bg-white/[0.03] p-4"><div className="grid gap-3"><label className="text-xs text-gray-400">名称<input disabled={selected.builtIn} value={selected.id || selected.name} onChange={(e) => setSelected({ ...selected, id: e.target.value, name: e.target.value })} className="mt-1 w-full rounded border border-white/10 bg-black/20 px-2 py-2 text-gray-100" /></label><label className="text-xs text-gray-400">说明<input disabled={selected.builtIn} value={selected.description || ''} onChange={(e) => setSelected({ ...selected, description: e.target.value })} className="mt-1 w-full rounded border border-white/10 bg-black/20 px-2 py-2 text-gray-100" /></label><textarea disabled={selected.builtIn} value={selected.content || ''} onChange={(e) => setSelected({ ...selected, content: e.target.value })} rows={14} className="w-full rounded border border-white/10 bg-black/20 p-3 font-mono text-xs" /><div className="flex justify-end gap-2"><button onClick={() => setSelected(null)} className="px-3 py-2 text-xs text-gray-400">关闭</button>{!selected.builtIn && <button onClick={save} className="flex items-center gap-1 rounded bg-blue-600 px-3 py-2 text-xs text-white"><Save size={13} />保存</button>}</div></div></div>}
      {message && <div className="rounded border border-white/10 bg-black/20 p-2 text-xs">{message}</div>}
    </div>
  );
}
