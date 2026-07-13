import React, { useEffect, useState } from 'react';
import { User, Globe, Book, Pen, Calendar, Loader2, Edit3, Save, X, Sparkles, Package, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { CharacterEnrichPanel } from './CharacterEnrichPanel.jsx';
import { CharacterEditDialog } from './CharacterEditDialog.jsx';
import { saveDataTabEdit } from './dataTabSave.mjs';

/**
 * Scan outlines/ directory to build a hierarchy tree via mana.fs bridges.
 * @returns {{ volumes: Array, hasHierarchy: boolean }}
 */
async function buildOutlineTree(mana, novelDir) {
  const outlinesDir = `${novelDir}/outlines`;
  const tree = { volumes: [], hasHierarchy: false };
  try {
    const entries = await mana.fs.listDir(outlinesDir);
    for (const entry of entries || []) {
      const name = typeof entry === 'string' ? entry : (entry.name || '');
      const m = name.match(/^volume-(\d+)$/);
      if (!m) continue;
      tree.hasHierarchy = true;
      const volIdx = parseInt(m[1], 10);
      const volDir = `${outlinesDir}/volume-${String(volIdx).padStart(3, '0')}`;
      const vol = { index: volIdx, title: `第${volIdx}卷`, sections: [] };
      // Try to read volume outline.md for the title
      try {
        const volText = await mana.fs.readFile(`${volDir}/outline.md`, 'utf8');
        const h1 = volText.match(/^#\s+(.+)/m);
        if (h1) vol.title = h1[1].trim();
        if (vol.title.startsWith(`第${volIdx}卷`)) vol.title = h1[1].trim();
      } catch {}
      const secEntries = await mana.fs.listDir(volDir);
      for (const se of secEntries || []) {
        const sn = typeof se === 'string' ? se : (se.name || '');
        const sm = sn.match(/^section-(\d+)$/);
        if (!sm) continue;
        const secIdx = parseInt(sm[1], 10);
        const secDir = `${volDir}/section-${String(secIdx).padStart(3, '0')}`;
        const sec = { index: secIdx, title: `第${secIdx}节`, chapters: [] };
        try {
          const secText = await mana.fs.readFile(`${secDir}/outline.md`, 'utf8');
          const h1 = secText.match(/^#\s+(.+)/m);
          if (h1) sec.title = h1[1].trim();
        } catch {}
        const chEntries = await mana.fs.listDir(secDir);
        for (const ce of chEntries || []) {
          const cn = typeof ce === 'string' ? ce : (ce.name || '');
          const cm = cn.match(/^chapter-(\d+)\.md$/);
          if (!cm) continue;
          const chIdx = parseInt(cm[1], 10);
          const chPath = `${secDir}/chapter-${String(chIdx).padStart(3, '0')}.md`;
          const ch = { index: chIdx, title: `第${chIdx}章`, path: chPath };
          try {
            const chText = await mana.fs.readFile(chPath, 'utf8');
            const h1 = chText.match(/^#\s+(.+)/m);
            if (h1) ch.title = h1[1].trim();
          } catch {}
          sec.chapters.push(ch);
        }
        sec.chapters.sort((a, b) => a.index - b.index);
        vol.sections.push(sec);
      }
      vol.sections.sort((a, b) => a.index - b.index);
      tree.volumes.push(vol);
    }
    tree.volumes.sort((a, b) => a.index - b.index);
  } catch {}
  return tree;
}

const DATA_REFRESH_TOOL_NAMES = {
  characters: new Set(['create_character', 'update_character', 'delete_character']),
  assets: new Set(['grant_asset', 'revoke_asset', 'apply_asset_patch']),
  world: new Set(['update_world']),
  timeline: new Set(['append_timeline', 'update_timeline', 'sync_chapter_timeline', 'dedupe_timeline']),
  outline: new Set(['write_outline_nodes']),
  style: new Set(['append_style_memory']),
};

export function DataTabContent({ dataType, novelId }) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');
  const [showEnrichPanel, setShowEnrichPanel] = useState(false);
  const [enrichSelectedIds, setEnrichSelectedIds] = useState([]);
  const [editingCharacter, setEditingCharacter] = useState(null);
  const [savingCharacter, setSavingCharacter] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  // Hierarchical outline state
  const [outlineHierarchy, setOutlineHierarchy] = useState(null);
  const [outlineCurrentFile, setOutlineCurrentFile] = useState(null);

  // Load data whenever dataType or novelId changes.
  // Guard against stale async results with a cancelled flag so a
  // late response from the previous dataType never overwrites state.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    setLoading(true);

    const doLoad = async () => {
      if (!mana?.novel || !novelId) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const nid = novelId;
        let result = null;
        if (dataType === 'characters') {
          const chars = await mana.novel.listCharacters(nid);
          result = Array.isArray(chars) ? chars : [];
        } else if (dataType === 'assets') {
          const assets = await mana.novel.listAssets(nid);
          result = Array.isArray(assets) ? assets : [];
        } else if (dataType === 'world') {
          const w = await mana.novel.readWorld(nid);
          result = w || { lore: '', places: [] };
        } else if (dataType === 'timeline') {
          const evts = await mana.novel.listTimeline(nid);
          result = Array.isArray(evts) ? evts : [];
        } else if (dataType === 'outline') {
          const active = await mana.novel.active();
          if (!active?.dir) { if (!cancelled) { setLoading(false); } return; }
          const dir = active.dir;
          // Scan for hierarchical structure
          const tree = await buildOutlineTree(mana, dir);
          setOutlineHierarchy(tree);
          // Default to master outline if exists, else main.md (legacy)
          let currentFile = null;
          const masterPath = `${dir}/outlines/outline.md`;
          const mainPath = `${dir}/outlines/main.md`;
          try {
            const masterExists = await mana.fs.pathExists(masterPath);
            if (masterExists) {
              currentFile = { path: masterPath, label: '总大纲', level: 'master' };
            }
          } catch {}
          if (!currentFile) {
            currentFile = { path: mainPath, label: '大纲', level: 'master' };
          }
          setOutlineCurrentFile(currentFile);
          try {
            result = await mana.fs.readFile(currentFile.path, 'utf8');
          } catch { result = '(无大纲)'; }
        } else if (dataType === 'style') {
          let text = '';
          try { text = await mana.novel.readStyleMemory(nid); } catch { text = '(无文风记录)'; }
          result = text || '(无文风记录)';
        }
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      }
      if (!cancelled) setLoading(false);
    };

    doLoad();
    return () => { cancelled = true; };
  }, [mana, novelId, dataType, refreshKey]);

  useEffect(() => {
    if (!novelId || !mana?.chatAgent?.onEvent) return undefined;
    const refreshToolNames = DATA_REFRESH_TOOL_NAMES[dataType];
    if (!refreshToolNames) return undefined;
    const off = mana.chatAgent.onEvent((payload) => {
      if (!payload || payload.kind !== 'tool_result') return;
      const toolName = payload.data?.name;
      if (payload.data?.isError || !refreshToolNames.has(toolName)) return;
      setRefreshKey((key) => key + 1);
    });
    return () => { try { off(); } catch { /* ignore */ } };
  }, [dataType, mana, novelId]);

  const startEdit = () => {
    const text = dataType === 'characters' ? JSON.stringify(data, null, 2)
      : dataType === 'assets' ? JSON.stringify(data, null, 2)
      : dataType === 'world' ? JSON.stringify(data, null, 2)
      : dataType === 'timeline' ? JSON.stringify(data, null, 2)
      : (typeof data === 'string' ? data : JSON.stringify(data || '', null, 2));
    setEditText(text);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!mana?.novel || !novelId) return;
    setSaving(true);
    setError('');
    setSaveFeedback('');
    try {
      const result = await saveDataTabEdit({
        mana,
        novelId,
        dataType,
        editText,
        outlineCurrentFile,
      });
      setSaveFeedback(result?.message || '保存成功');
      setEditing(false);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setSaveFeedback('');
      setError(err?.message || String(err));
    }
    setSaving(false);
  };

  if (!novelId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        未打开小说项目，无法加载数据
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <Loader2 size={16} className="animate-spin mr-2" /> 加载中…
      </div>
    );
  }

  if (error) {
    return <div className="flex items-center justify-center h-full text-rose-400 text-sm">{error}</div>;
  }

  if (editing) {
    return (
      <div className="h-full flex flex-col bg-vscode-bg" data-testid="data-tab-editor">
        <div className="flex items-center justify-between px-3 py-1 border-b border-vscode-panel-border bg-vscode-sidebar">
          <span className="text-xs text-gray-400 font-mono">编辑 JSON / Markdown</span>
          <div className="flex gap-1 items-center">
            {saveFeedback && <span className={`text-[10px] ${saveFeedback.includes('失败') ? 'text-rose-400' : 'text-green-400'}`}>{saveFeedback}</span>}
            <button onClick={() => setEditing(false)} className="px-2 py-0.5 text-gray-400 hover:text-gray-200 text-xs"><X size={12}/>取消</button>
            <button data-testid="data-tab-save" onClick={saveEdit} disabled={saving} className="px-3 py-0.5 bg-blue-700 text-white rounded hover:bg-blue-600 text-xs disabled:opacity-40 flex items-center gap-1"><Save size={12}/>{saving?'保存中':'保存'}</button>
          </div>
        </div>
        <textarea data-testid="data-tab-editor-textarea" className="flex-1 w-full bg-transparent text-gray-300 font-mono text-xs p-4 resize-none outline-none border-none" value={editText} onChange={(e) => setEditText(e.target.value)} />
      </div>
    );
  }

  const s = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v || ''));

  const handleRegenerate = async () => {
    if (!mana?.novel || !novelId) return;
    // Double confirmation 1
    if (!window.confirm('确定要重新生成角色卡吗？这会清空现有所有角色卡，并重新扫描小说文本提取角色。此操作不可撤销。')) {
      return;
    }
    setRegenerating(true);
    try {
      const check = await mana.novel.regenerateCharacters(novelId, false);
      if (check?.needConfirm) {
        let proceed = true;
        if (check.isLong) {
          // Extra confirmation for long novels
          proceed = window.confirm(`该小说共约 ${check.wordCountWan} 万字，重新生成角色卡将消耗较多时间与 API 费用。是否继续？`);
        }
        if (proceed) {
          const result = await mana.novel.regenerateCharacters(novelId, true);
          setSaveFeedback(`已重新生成 ${result.characters} 个角色`);
          setTimeout(() => setSaveFeedback(''), 4000);
          setRefreshKey((k) => k + 1);
        }
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
    setRegenerating(false);
  };

  const saveCharacter = async (character) => {
    if (!mana?.novel?.writeCharacter || !novelId) return;
    setSavingCharacter(true);
    setError('');
    try {
      await mana.novel.writeCharacter(novelId, character);
      setSaveFeedback(`已保存角色「${character.name || character.id}」`);
      setEditingCharacter(null);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSavingCharacter(false);
    }
  };

  const deleteCharacter = async (character) => {
    if (!mana?.novel?.deleteCharacter || !novelId || !character?.id) return;
    const confirmed = window.confirm(`确定删除角色「${character.name || character.id}」吗？\n\n这会删除该角色卡，不会修改小说正文。`);
    if (!confirmed) return;
    setSavingCharacter(true);
    setError('');
    try {
      const deleted = await mana.novel.deleteCharacter(novelId, character.id);
      if (!deleted) throw new Error(`角色不存在或已被删除: ${character.id}`);
      setSaveFeedback(`已删除角色「${character.name || character.id}」`);
      setEditingCharacter(null);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSavingCharacter(false);
    }
  };

  const createAsset = async () => {
    if (!mana?.novel || !novelId) return;
    const raw = await window.mana?.prompt?.show?.('输入资产 ID / 名称', 'key-item');
    const id = String(raw || '').trim();
    if (!id) return;
    const name = await window.mana?.prompt?.show?.('输入资产显示名称', id);
    try {
      await mana.novel.upsertAsset(novelId, {
        id,
        name: String(name || id).trim() || id,
        type: '道具',
        status: 'active',
        grantedTo: [],
      });
      setSaveFeedback('资产已创建');
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const grantAssetToCharacter = async (asset) => {
    if (!asset?.id || !mana?.novel || !novelId) return;
    const charId = await window.mana?.prompt?.show?.(`把「${asset.name || asset.id}」授予角色 ID`, '');
    if (!String(charId || '').trim()) return;
    try {
      await mana.novel.grantAsset(novelId, {
        assetId: asset.id,
        charId: String(charId).trim(),
        chapterRef: '',
        note: '手动授权',
        baseGrantedTo: Array.isArray(asset.grantedTo) ? asset.grantedTo : [],
      });
      setSaveFeedback('资产授权已保存');
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const revokeAssetFromCharacter = async (asset) => {
    if (!asset?.id || !mana?.novel || !novelId) return;
    const activeHolders = (Array.isArray(asset.grantedTo) ? asset.grantedTo : [])
      .filter((entry) => entry && entry.revoked !== true && entry.charId)
      .map((entry) => entry.charId);
    const charId = await window.mana?.prompt?.show?.(`回收「${asset.name || asset.id}」的角色 ID`, activeHolders[0] || '');
    if (!String(charId || '').trim()) return;
    try {
      await mana.novel.revokeAsset(novelId, {
        assetId: asset.id,
        charId: String(charId).trim(),
        chapterRef: '',
        note: '手动回收',
        baseGrantedTo: Array.isArray(asset.grantedTo) ? asset.grantedTo : [],
      });
      setSaveFeedback('资产回收已保存');
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const auditAssetList = async () => {
    if (!mana?.novel || !novelId) return;
    try {
      const result = await mana.novel.auditAssets(novelId);
      setSaveFeedback(result?.issueCount ? `发现 ${result.issueCount} 个资产问题` : '资产审计通过');
      setData((current) => {
        const next = Array.isArray(current) ? [...current] : [];
        next._audit = result;
        return next;
      });
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  if (dataType === 'characters') {
    return (
      <div className="h-full overflow-y-auto p-4 text-sm relative">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold text-gray-200 flex items-center gap-2">
            <User size={18}/>角色卡 ({data.length || 0})
            {saveFeedback && (
              <span className={`text-[11px] ml-2 ${saveFeedback.includes('失败') || saveFeedback.includes('错误') ? 'text-rose-400' : 'text-green-400'}`}>
                {saveFeedback}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {Array.isArray(data) && data.length > 0 && (
              <button
                onClick={() => { setEnrichSelectedIds((data || []).filter((c) => c.isOriginal === false).map((c) => c.id)); setShowEnrichPanel(true); }}
                className="px-2 py-0.5 bg-amber-900/40 text-amber-400 hover:text-amber-300 border border-amber-700/40 rounded text-xs flex items-center gap-1"
                title="联网搜索已标记为二创的角色"
              >
                <Sparkles size={11}/>联网补全人设
              </button>
            )}
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1 disabled:opacity-40"
              title="清空现有角色卡并重新扫描小说生成"
            >
              {regenerating ? <Loader2 size={11} className="animate-spin"/> : <Pen size={11}/>}
              {regenerating ? '生成中...' : '重新生成'}
            </button>
            <button
              data-testid="data-tab-edit"
              onClick={startEdit}
              className="px-2 py-0.5 bg-vscode-active-item text-gray-500 hover:text-gray-300 rounded text-xs flex items-center gap-1"
              title="高级用法：直接编辑全部角色的 JSON。普通修改请使用角色卡上的编辑按钮。"
            ><Edit3 size={11}/>高级 JSON</button>
          </div>
        </div>
        {!data || !Array.isArray(data) || data.length === 0 ? (
          <div className="text-gray-500 italic">暂无角色数据 — 导入小说并运行AI分析后自动生成</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {data.map((ch, i) => (
              <div key={ch.id || i} className="border border-vscode-panel-border rounded p-3">
                {(() => {
                  const attributeEntries = Object.entries(ch.attributes || {}).filter(([key, value]) => key && value);
                  const archiveText = s(ch.bio || '');
                  return (
                    <>
                <div className="flex items-start justify-between">
                  <div className="font-semibold text-gray-200 text-base">{s(ch.name || ch.id || '?')}</div>
                  <div className="flex items-center gap-1.5">
                    {ch.isOriginal === true && (
                      <span className="text-[10px] bg-green-900/40 text-green-400 px-1 rounded">原创</span>
                    )}
                    {ch.isOriginal !== true && ch.sourceWork && (
                      <span className="text-[10px] bg-blue-900/40 text-blue-400 px-1 rounded" title={`出自《${ch.sourceWork}》`}>同人</span>
                    )}
                    {ch.isOriginal === undefined && (
                      <span className="text-[10px] bg-amber-900/40 text-amber-400 px-1 rounded">归属未确认</span>
                    )}
                    <button
                      onClick={() => { setEnrichSelectedIds([ch.id]); setShowEnrichPanel(true); }}
                      className="text-amber-500/60 hover:text-amber-400"
                      title={ch.isOriginal === true ? '当前标记为原创，请先编辑角色归属' : ch.isOriginal === false ? '联网补全该角色' : '请先编辑并确认角色归属'}
                      disabled={ch.isOriginal !== false}
                    >
                      <Sparkles size={12} />
                    </button>
                    <button
                      onClick={() => setEditingCharacter(ch)}
                      className="text-blue-400/60 hover:text-blue-300"
                      title="编辑角色卡"
                      aria-label={`编辑角色卡 ${s(ch.name || ch.id)}`}
                    >
                      <Edit3 size={12} />
                    </button>
                    <button
                      onClick={() => deleteCharacter(ch)}
                      className="text-rose-500/60 hover:text-rose-400"
                      title="删除角色"
                      aria-label={`删除角色 ${s(ch.name || ch.id)}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="text-gray-500 text-xs mt-0.5 space-y-0.5">
                  {ch.role && <div>定位: {s(ch.role)}</div>}
                  {ch.gender && <div>性别: {s(ch.gender)}</div>}
                  {ch.age && <div>年龄: {s(ch.age)}</div>}
                  {ch.sourceWork && <div className="text-blue-400/70">出自: 《{s(ch.sourceWork)}》</div>}
                  {ch.originalName && <div className="text-blue-400/70">原名: {s(ch.originalName)}</div>}
                  {(ch.hairColor || ch.eyeColor || ch.height) && (
                    <div className="flex flex-wrap gap-x-3 text-gray-400 text-[10px]">
                      {ch.hairColor && <span>发色: {s(ch.hairColor)}</span>}
                      {ch.eyeColor && <span>瞳色: {s(ch.eyeColor)}</span>}
                      {ch.height && <span>身高: {s(ch.height)}</span>}
                      {ch.figure && <span>体型: {s(ch.figure)}</span>}
                    </div>
                  )}
                  {ch.appearance && <div className="mt-1"><span className="text-gray-400">外貌:</span> {s(ch.appearance)}</div>}
                  {ch.moeTraits && <div className="mt-1"><span className="text-gray-400">萌点:</span> {s(ch.moeTraits)}</div>}
                  {ch.personality && <div className="mt-1"><span className="text-gray-400">性格:</span> {s(ch.personality)}</div>}
                  {ch.background && <div className="mt-1"><span className="text-gray-400">背景:</span> {s(ch.background)}</div>}
                  {ch.quotes && (
                    <div className="mt-1">
                      <span className="text-gray-400">台词:</span>
                      <div className="text-gray-400/80 italic pl-2 border-l border-gray-600/30 mt-0.5 space-y-0.5">
                        {String(ch.quotes).split(/[；;]/).filter(Boolean).map((q, idx) => (
                          <div key={idx}>「{q.trim()}」</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {attributeEntries.length > 0 && (
                    <div className="mt-2">
                      <span className="text-gray-400">细节:</span>
                      <div className="mt-1 space-y-1 text-[10px] text-gray-400">
                        {attributeEntries.map(([key, value]) => (
                          <div key={key} className="rounded border border-vscode-panel-border/40 px-2 py-1 whitespace-pre-wrap break-words">
                            <span className="text-gray-300">{s(key)}:</span> {s(value)}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {archiveText && archiveText !== s(ch.background || '') && (
                    <div className="mt-2">
                      <span className="text-gray-400">档案:</span>
                      <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-gray-400 border border-vscode-panel-border/40 rounded px-2 py-2">
                        {archiveText}
                      </div>
                    </div>
                  )}
                  {Array.isArray(ch.skins) && ch.skins.length > 0 && (
                    <div className="mt-1">
                      <span className="text-gray-400">皮肤/形态:</span>
                      <div className="space-y-1 mt-0.5">
                        {ch.skins.map((sk, idx) => (
                          <div key={idx} className="border border-vscode-panel-border/50 rounded px-2 py-1 text-[10px]">
                            <span className="text-gray-300 font-semibold">{s(sk.name)}</span>
                            {sk.outfit && <div className="text-gray-400">妆造: {s(sk.outfit)}</div>}
                            {sk.scenario && <div className="text-gray-500">适用: {s(sk.scenario)}</div>}
                            {sk.story && <div className="text-gray-500/80">{s(sk.story)}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {ch._enrichmentStatus && (
                    <div className="mt-1 text-[10px] text-amber-500/70">
                      补全状态: {ch._enrichmentStatus === 'success' ? '已补全' : ch._enrichmentStatus === 'extract-empty' ? '页面无角色信息' : ch._enrichmentStatus}
                    </div>
                  )}
                </div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
        {showEnrichPanel && (
          <CharacterEnrichPanel
            novelId={novelId}
            characters={data || []}
            initialSelectedIds={enrichSelectedIds}
            onClose={() => { setShowEnrichPanel(false); setRefreshKey((k) => k + 1); }}
            onComplete={() => { setRefreshKey((k) => k + 1); }}
          />
        )}
        {editingCharacter && (
          <CharacterEditDialog
            character={editingCharacter}
            saving={savingCharacter}
            onCancel={() => setEditingCharacter(null)}
            onSave={saveCharacter}
            onDelete={deleteCharacter}
          />
        )}
      </div>
    );
  }

  if (dataType === 'assets') {
    const audit = data?._audit || null;
    const assets = Array.isArray(data) ? data : [];
    const activeHolders = (asset) => (Array.isArray(asset.grantedTo) ? asset.grantedTo : [])
      .filter((entry) => entry && entry.revoked !== true && entry.charId)
      .map((entry) => entry.charId);

    return (
      <div className="h-full overflow-y-auto p-4 text-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold text-gray-200 flex items-center gap-2">
            <Package size={18}/>资产/物品 ({assets.length || 0})
            {saveFeedback && (
              <span className={`text-[11px] ml-2 ${saveFeedback.includes('发现') || saveFeedback.includes('失败') || saveFeedback.includes('错误') ? 'text-amber-400' : 'text-green-400'}`}>
                {saveFeedback}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={createAsset} className="px-2 py-0.5 bg-blue-700 text-white hover:bg-blue-600 rounded text-xs flex items-center gap-1"><Plus size={11}/>新建资产</button>
            <button onClick={auditAssetList} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><ShieldAlert size={11}/>审计资产</button>
            <button data-testid="data-tab-edit" onClick={startEdit} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><Edit3 size={11}/>编辑 JSON</button>
          </div>
        </div>
        {audit?.issues?.length > 0 && (
          <div className="mb-3 rounded border border-amber-700/50 bg-amber-950/20 p-3 text-xs">
            <div className="mb-1 font-semibold text-amber-300">资产审计问题</div>
            <div className="space-y-1">
              {audit.issues.map((issue, index) => (
                <div key={`${issue.code}-${index}`} className="text-amber-100/90">
                  [{issue.severity}] {issue.assetName || issue.assetId}: {issue.message}
                </div>
              ))}
            </div>
          </div>
        )}
        {!assets.length ? (
          <div className="text-gray-500 italic">暂无资产数据 — 可以新建资产，或让 AI/MCP 记录关键道具流转</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {assets.map((asset, index) => {
              const holders = activeHolders(asset);
              return (
                <div key={asset.id || index} className="border border-vscode-panel-border rounded p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-gray-200 text-base">{s(asset.name || asset.id || '?')}</div>
                      <div className="text-[10px] text-gray-600">{s(asset.id)}</div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => grantAssetToCharacter(asset)} className="px-2 py-0.5 rounded bg-green-900/40 text-green-300 hover:text-green-200 text-[10px]">授权</button>
                      <button onClick={() => revokeAssetFromCharacter(asset)} className="px-2 py-0.5 rounded bg-rose-900/40 text-rose-300 hover:text-rose-200 text-[10px]">回收</button>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-gray-500">
                    {asset.type && <div>类型: {s(asset.type)}</div>}
                    {asset.status && <div>状态: {s(asset.status)}</div>}
                    {asset.location && <div>地点: {s(asset.location)}</div>}
                    {asset.ownerId && <div>所有者: {s(asset.ownerId)}</div>}
                    {asset.description && <div className="text-gray-400 whitespace-pre-wrap">描述: {s(asset.description)}</div>}
                    {holders.length > 0 ? (
                      <div className="text-green-300/80">当前持有人: {holders.join('、')}</div>
                    ) : (
                      <div className="text-gray-600">当前无活跃持有人</div>
                    )}
                    {Array.isArray(asset.grantedTo) && asset.grantedTo.length > 0 && (
                      <div className="mt-2 border-t border-vscode-panel-border/50 pt-2">
                        <div className="text-gray-400 mb-1">流转记录</div>
                        {asset.grantedTo.slice(-4).reverse().map((entry, idx) => (
                          <div key={idx} className="text-[10px] text-gray-500">
                            {entry.revoked ? '回收' : '授权'} {s(entry.charId)} {entry.chapterRef ? `@ ${s(entry.chapterRef)}` : ''} {entry.note ? `- ${s(entry.note)}` : ''}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (dataType === 'world') {
    return (
      <div className="h-full overflow-y-auto p-4 text-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold text-gray-200 flex items-center gap-2"><Globe size={18}/>世界观</div>
          <button data-testid="data-tab-edit" onClick={startEdit} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><Edit3 size={11}/>编辑</button>
        </div>
        {data?.lore ? (
          <div className="whitespace-pre-wrap text-gray-300 leading-relaxed">{s(data.lore)}</div>
        ) : (
          <div className="text-gray-500">暂无世界观数据</div>
        )}
        {data?.places?.length > 0 && (
          <div className="mt-4">
            <div className="font-semibold text-gray-300 mb-1">地点</div>
            {data.places.map((p, i) => (
              <div key={i} className="border border-vscode-panel-border rounded p-2 mb-1">
                <span className="text-gray-200">{p.name}</span>
                {p.type && <span className="text-gray-500 ml-1">({p.type})</span>}
                {p.description && <div className="text-gray-400 text-xs mt-0.5">{p.description}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (dataType === 'timeline') {
    return (
      <div className="h-full overflow-y-auto p-4 text-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold text-gray-200 flex items-center gap-2"><Calendar size={18}/>时间线 ({data.length || 0})</div>
          <button data-testid="data-tab-edit" onClick={startEdit} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><Edit3 size={11}/>编辑</button>
        </div>
        {!data || !Array.isArray(data) || data.length === 0 ? (
          <div className="text-gray-500 italic">暂无时间线事件</div>
        ) : (
          <div className="space-y-2">
            {data.map((ev, i) => (
              <div key={ev.id || i} className="border-l-2 border-vscode-panel-border pl-3 py-1">
                <div className="text-gray-400 text-xs">{s(ev.when || ev.timestamp || ev.title || `事件 ${i+1}`)}</div>
                <div className="text-gray-300 text-sm mt-0.5">{s(ev.description || ev.event || ev.title || '')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (dataType === 'outline') {
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? '', null, 2);
    const tree = outlineHierarchy;
    const hasTree = tree?.hasHierarchy && tree.volumes.length > 0;

    const handleNav = async (fileInfo) => {
      setOutlineCurrentFile(fileInfo);
      try {
        const content = await mana.fs.readFile(fileInfo.path, 'utf8');
        setData(content);
      } catch { setData('(空)'); }
    };

    return (
      <div className="h-full flex flex-col text-sm">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-1 border-b border-vscode-panel-border shrink-0">
          <div className="text-sm font-bold text-gray-200 flex items-center gap-2">
            <Book size={16}/>大纲
            <span className="text-[10px] text-gray-500 font-normal ml-1">
              {outlineCurrentFile?.label || ''}
            </span>
          </div>
          <button data-testid="data-tab-edit" onClick={startEdit} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><Edit3 size={11}/>编辑</button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Tree sidebar */}
          {hasTree && (
            <div className="w-48 shrink-0 overflow-y-auto border-r border-vscode-panel-border bg-vscode-sidebar/30 p-2 text-xs text-gray-400 space-y-0.5">
              {/* Master outline */}
              <div
                className={`cursor-pointer px-2 py-1 rounded hover:bg-vscode-active-item/60 ${!outlineCurrentFile?.path?.includes('volume-') ? 'bg-vscode-active-item text-gray-200' : ''}`}
                onClick={async () => {
                  const active = await mana.novel.active();
                  if (!active?.dir) return;
                  handleNav({ path: `${active.dir}/outlines/outline.md`, label: '总大纲', level: 'master' });
                }}
              ><span className="text-gray-500 mr-1">[#]</span> 总大纲</div>
              {/* Volumes */}
              {tree.volumes.map(v => (
                <div key={v.index}>
                  <div
                    className={`cursor-pointer px-2 py-1 rounded hover:bg-vscode-active-item/60 ${outlineCurrentFile?.path?.includes(`volume-${String(v.index).padStart(3, '0')}`) && !outlineCurrentFile?.path?.includes('section-') ? 'bg-vscode-active-item text-gray-200' : ''}`}
                    onClick={async () => {
                      const active = await mana.novel.active();
                      if (!active?.dir) return;
                      handleNav({ path: `${active.dir}/outlines/volume-${String(v.index).padStart(3, '0')}/outline.md`, label: v.title, level: 'volume', volumeIndex: v.index });
                    }}
                  ><span className="text-gray-500 mr-1">[V]</span> {v.title}</div>
                  {v.sections.map(s => (
                    <div key={s.index} className="ml-3">
                      <div
                        className={`cursor-pointer px-2 py-0.5 rounded hover:bg-vscode-active-item/60 ${outlineCurrentFile?.path?.includes(`section-${String(s.index).padStart(3, '0')}`) && !outlineCurrentFile?.path?.endsWith('.md') ? 'bg-vscode-active-item text-gray-200' : ''}`}
                        onClick={async () => {
                          const active = await mana.novel.active();
                          if (!active?.dir) return;
                          handleNav({ path: `${active.dir}/outlines/volume-${String(v.index).padStart(3, '0')}/section-${String(s.index).padStart(3, '0')}/outline.md`, label: s.title, level: 'section', volumeIndex: v.index, sectionIndex: s.index });
                        }}
                      ><span className="text-gray-500 mr-1">[S]</span> {s.title}</div>
                      {s.chapters.map(c => (
                        <div key={c.index} className="ml-3">
                          <div
                            className={`cursor-pointer px-2 py-0.5 rounded hover:bg-vscode-active-item/60 ${outlineCurrentFile?.path === c.path ? 'bg-vscode-active-item text-gray-200' : ''}`}
                            onClick={() => handleNav({ path: c.path, label: c.title, level: 'chapter', volumeIndex: v.index, sectionIndex: s.index, chapterIndex: c.index })}
                          ><span className="text-gray-500 mr-1">[C]</span> {c.title}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-4">
            {!text || text === '(空)' || text === '(无大纲)' ? (
              <div className="text-gray-500 italic">
                {hasTree ? '从左侧选择一个大纲文件查看' : '暂无大纲数据'}
              </div>
            ) : (
              <div className="text-gray-300 whitespace-pre-wrap leading-relaxed">{text}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (dataType === 'style') {
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? '', null, 2);
    return (
      <div className="h-full overflow-y-auto p-4 text-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="text-lg font-bold text-gray-200 flex items-center gap-2"><Pen size={18}/>文风</div>
          <button data-testid="data-tab-edit" onClick={startEdit} className="px-2 py-0.5 bg-vscode-active-item text-gray-400 hover:text-gray-200 rounded text-xs flex items-center gap-1"><Edit3 size={11}/>编辑</button>
        </div>
        <div className="text-gray-300 whitespace-pre-wrap leading-relaxed">{text}</div>
      </div>
    );
  }

  return <div className="p-4 text-gray-500">未知数据类型: {dataType}</div>;
}
