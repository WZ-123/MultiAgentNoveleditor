import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Input, Chip } from '@heroui/react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

const NODE_KINDS = ['subagent', 'parallel', 'gate', 'human', 'output'];

const KIND_COLORS = {
  subagent: '#1f6feb',
  parallel: '#8957e5',
  gate: '#bf8700',
  human: '#1a7f37',
  output: '#4a4a4a',
};

function colorFor(kind) {
  return KIND_COLORS[kind] || '#444';
}

function autoLayout(dag) {
  if (!dag) return {};
  const depth = {};
  const visiting = new Set();
  function dfs(nodeId, d) {
    if (depth[nodeId] !== undefined) {
      if (d > depth[nodeId]) depth[nodeId] = d;
      return;
    }
    if (visiting.has(nodeId)) return;
    visiting.add(nodeId);
    depth[nodeId] = d;
    const outs = dag.edges.filter((e) => e.from === nodeId);
    for (const e of outs) dfs(e.to, d + 1);
    const node = dag.nodes.find((n) => n.id === nodeId);
    if (node?.kind === 'parallel' && Array.isArray(node.children)) {
      for (const c of node.children) dfs(c, d + 1);
    }
    visiting.delete(nodeId);
  }
  for (const id of dag.entryNodeIds || []) dfs(id, 0);
  // Anything unreachable
  for (const n of dag.nodes) if (depth[n.id] === undefined) depth[n.id] = 0;

  // Group by depth
  const byDepth = {};
  for (const n of dag.nodes) {
    const d = depth[n.id];
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(n.id);
  }
  const layout = {};
  for (const dStr of Object.keys(byDepth)) {
    const d = Number(dStr);
    byDepth[d].forEach((id, idx) => {
      layout[id] = { x: d * 230, y: idx * 110 + 30 };
    });
  }
  return layout;
}

function dagToFlow(dag, subagentMap, profileMap = {}) {
  const layout = dag.layout && Object.keys(dag.layout).length ? dag.layout : autoLayout(dag);
  const nodes = (dag.nodes || []).map((n) => {
    const subagentName = n.subagentId ? (subagentMap[n.subagentId]?.displayName || n.subagentId) : null;
    const lines = [
      n.label || n.id,
      n.kind === 'subagent' && subagentName ? `· ${subagentName}` : null,
      n.modelProfileId ? `档案=${profileMap[n.modelProfileId]?.name || n.modelProfileId}` : (n.tierOverride ? `旧Tier=${n.tierOverride}` : null),
      n.kind === 'gate' ? `expr=${n.expr || '?'}` : null,
    ].filter(Boolean);
    return {
      id: n.id,
      position: layout[n.id] || { x: 0, y: 0 },
      data: { label: lines.join('\n'), kind: n.kind, raw: n },
      style: {
        background: colorFor(n.kind),
        color: '#fff',
        border: '1px solid #00000033',
        borderRadius: 6,
        padding: 8,
        fontSize: 10,
        whiteSpace: 'pre-wrap',
        width: 180,
      },
    };
  });
  const edges = (dag.edges || []).map((e, idx) => ({
    id: `${e.from}->${e.to}#${idx}`,
    source: e.from,
    target: e.to,
    label: e.when || '',
    style: e.when === 'pass' ? { stroke: '#1a7f37' } : e.when === 'block' ? { stroke: '#cf222e' } : { stroke: '#888' },
    animated: !!e.when,
  }));
  return { nodes, edges };
}

function flowToDag(prevDag, flowNodes, flowEdges) {
  const layout = {};
  const nextNodes = flowNodes.map((fn) => {
    layout[fn.id] = { x: fn.position.x, y: fn.position.y };
    return fn.data?.raw || { id: fn.id, kind: 'subagent' };
  });
  const nextEdges = flowEdges.map((fe) => {
    const m = (fe.id || '').match(/#(\d+)/);
    const oldIdx = m ? Number(m[1]) : -1;
    const oldEdge = oldIdx >= 0 ? prevDag.edges?.[oldIdx] : null;
    return {
      from: fe.source,
      to: fe.target,
      when: fe.label || oldEdge?.when || undefined,
    };
  });
  return { ...prevDag, nodes: nextNodes, edges: nextEdges, layout };
}

function NodeInspector({ node, allSubagents, profiles, onChange, readOnly }) {
  const { t } = useI18n();
  if (!node) return null;
  const raw = node.data.raw || {};
  const kind = raw.kind;
  const update = (patch) => onChange({ ...raw, ...patch });
  return (
    <div className="border border-vscode-panel-border rounded p-3 bg-vscode-sidebar/30 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <Chip size="sm" variant="flat" style={{ background: colorFor(kind), color: '#fff' }}>{kind}</Chip>
        <span className="font-mono text-gray-500">{raw.id}</span>
      </div>
      <Input size="sm" label={t('dag.nodeKind')} value={kind} readOnly />
      <Input
        size="sm"
        label="label"
        value={raw.label || ''}
        onChange={(e) => update({ label: e.target.value })}
        readOnly={readOnly}
      />
      {kind === 'subagent' && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-gray-500">subagentId</span>
            <select
              className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5"
              value={raw.subagentId || ''}
              onChange={(e) => update({ subagentId: e.target.value })}
              disabled={readOnly}
            >
              <option value="">(none)</option>
              {allSubagents.map((sa) => (
                <option key={sa.id} value={sa.id}>{sa.displayName} ({sa.id})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-500">模型档案覆盖</span>
            <select
              className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5"
              value={raw.modelProfileId || ''}
              onChange={(e) => update({ modelProfileId: e.target.value || undefined })}
              disabled={readOnly}
            >
              <option value="">使用 Subagent 默认档案</option>
              {(profiles || []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
        </>
      )}
      {kind === 'gate' && (
        <Input
          size="sm"
          label={t('dag.gateExpr')}
          value={raw.expr || ''}
          onChange={(e) => update({ expr: e.target.value })}
          readOnly={readOnly}
          placeholder="no_issues"
        />
      )}
      {kind === 'parallel' && (
        <Input
          size="sm"
          label="children (comma-separated node ids)"
          value={(raw.children || []).join(',')}
          onChange={(e) => update({ children: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

function GraphPane({ dag, subagentMap, profiles, readOnly, onCommit }) {
  const profileMap = useMemo(() => Object.fromEntries((profiles || []).map((profile) => [profile.id, profile])), [profiles]);
  const initial = useMemo(() => dagToFlow(dag, subagentMap, profileMap), [dag, subagentMap, profileMap]);
  const [nodes, setNodes] = useState(initial.nodes);
  const [edges, setEdges] = useState(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const lastDagRef = useRef(dag);

  useEffect(() => {
    if (lastDagRef.current?.id !== dag.id) {
      const fresh = dagToFlow(dag, subagentMap, profileMap);
      setNodes(fresh.nodes);
      setEdges(fresh.edges);
      setSelectedNodeId(null);
      lastDagRef.current = dag;
    }
  }, [dag, subagentMap, profileMap]);

  const onNodesChange = useCallback((changes) => {
    setNodes((n) => applyNodeChanges(changes, n));
  }, []);
  const onEdgesChange = useCallback((changes) => {
    setEdges((e) => applyEdgeChanges(changes, e));
  }, []);
  const onConnect = useCallback((conn) => {
    if (readOnly) return;
    setEdges((eds) => addEdge({ ...conn, id: `${conn.source}->${conn.target}#${Date.now()}` }, eds));
  }, [readOnly]);

  const onNodeClick = useCallback((_e, node) => setSelectedNodeId(node.id), []);
  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  const handleInspectorChange = useCallback((nextRaw) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== nextRaw.id) return n;
      const subName = nextRaw.subagentId ? (subagentMap[nextRaw.subagentId]?.displayName || nextRaw.subagentId) : null;
      const lines = [
        nextRaw.label || nextRaw.id,
        nextRaw.kind === 'subagent' && subName ? `· ${subName}` : null,
        nextRaw.modelProfileId ? `档案=${profileMap[nextRaw.modelProfileId]?.name || nextRaw.modelProfileId}` : (nextRaw.tierOverride ? `旧Tier=${nextRaw.tierOverride}` : null),
        nextRaw.kind === 'gate' ? `expr=${nextRaw.expr || '?'}` : null,
      ].filter(Boolean);
      return { ...n, data: { ...n.data, raw: nextRaw, label: lines.join('\n') } };
    }));
  }, [subagentMap, profileMap]);

  const onAddNode = useCallback((kind) => {
    if (readOnly) return;
    const id = `n_${kind}_${Date.now().toString(36)}`;
    const raw = { id, kind, label: kind };
    if (kind === 'gate') raw.expr = 'no_issues';
    if (kind === 'parallel') raw.children = [];
    setNodes((ns) => [...ns, {
      id,
      position: { x: 80 + Math.random() * 60, y: 80 + Math.random() * 60 },
      data: { label: kind, kind, raw },
      style: { background: colorFor(kind), color: '#fff', border: '1px solid #00000033', borderRadius: 6, padding: 8, fontSize: 10, width: 180 },
    }]);
  }, [readOnly]);

  const onDeleteSelected = useCallback(() => {
    if (readOnly || !selectedNodeId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedNodeId));
    setEdges((es) => es.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [readOnly, selectedNodeId]);

  const onSave = useCallback(() => {
    const next = flowToDag(dag, nodes, edges);
    onCommit(next);
  }, [dag, nodes, edges, onCommit]);

  const onSetEdgeWhen = useCallback((value) => {
    if (readOnly) return;
    setEdges((es) => es.map((e) => {
      if (e.selected) {
        return {
          ...e,
          label: value,
          style: value === 'pass' ? { stroke: '#1a7f37' } : value === 'block' ? { stroke: '#cf222e' } : { stroke: '#888' },
          animated: !!value,
        };
      }
      return e;
    }));
  }, [readOnly]);

  return (
    <div className="grid grid-cols-12 gap-3 h-[60vh]">
      <div className="col-span-9 border border-vscode-panel-border rounded bg-vscode-editor-bg/50 relative">
        <div className="absolute top-2 left-2 z-10 flex flex-wrap gap-1">
          {NODE_KINDS.map((k) => (
            <Button key={k} size="sm" variant="flat" isDisabled={readOnly} onPress={() => onAddNode(k)}>
              + {k}
            </Button>
          ))}
          <Button size="sm" variant="flat" color="danger" isDisabled={readOnly || !selectedNodeId} onPress={onDeleteSelected}>
            – node
          </Button>
          <Button size="sm" variant="flat" isDisabled={readOnly} onPress={() => onSetEdgeWhen('pass')}>edge: pass</Button>
          <Button size="sm" variant="flat" isDisabled={readOnly} onPress={() => onSetEdgeWhen('block')}>edge: block</Button>
          <Button size="sm" variant="flat" isDisabled={readOnly} onPress={() => onSetEdgeWhen('')}>edge: clear</Button>
          <Button size="sm" color="primary" isDisabled={readOnly} onPress={onSave}>save</Button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          edgesReconnectable={!readOnly}
        >
          <Background gap={16} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <div className="col-span-3 overflow-y-auto">
        {selectedNode ? (
          <NodeInspector
            node={selectedNode}
            allSubagents={Object.values(subagentMap)}
            profiles={profiles}
            onChange={handleInspectorChange}
            readOnly={readOnly}
          />
        ) : (
          <div className="text-xs text-gray-500 p-2">点击节点编辑详情；从节点边缘拖动连线</div>
        )}
      </div>
    </div>
  );
}

export function DagEditor() {
  const { t } = useI18n();
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [dags, setDags] = useState([]);
  const [subagents, setSubagents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [profiles, setProfiles] = useState([]);

  const refresh = useCallback(async () => {
    if (!mana?.config) {
      setLoadError(t('manaRuntime.bridgeMissing'));
      return;
    }
    try {
      const [dagList, subList, snapshot] = await Promise.all([
        mana.config.listDags(),
        mana.config.listSubagents(),
        mana.modelConfig?.snapshot?.().catch(() => null),
      ]);
      const sortedDags = (dagList || []).slice().sort((a, b) => {
        if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
        if (a.stage !== b.stage) return (a.stage || '').localeCompare(b.stage || '');
        return (a.name || '').localeCompare(b.name || '');
      });
      setDags(sortedDags);
      setSubagents(subList || []);
      setProfiles(snapshot?.profiles || []);
      if (!selectedId && sortedDags.length) setSelectedId(sortedDags[0].id);
      else if (selectedId && !sortedDags.find((d) => d.id === selectedId)) {
        setSelectedId(sortedDags[0]?.id || null);
      }
    } catch (e) {
      setLoadError(e?.message || String(e));
    }
  }, [mana, t, selectedId]);

  useEffect(() => { refresh(); }, [refresh]);

  const subagentMap = useMemo(() => {
    const m = {};
    for (const s of subagents) m[s.id] = s;
    return m;
  }, [subagents]);

  const selectedDag = dags.find((d) => d.id === selectedId) || null;

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, []);

  const onCommit = useCallback(async (nextDag) => {
    if (!mana?.config) return;
    if (nextDag.builtIn) { alert('Cannot save built-in DAG; clone first.'); return; }
    await mana.config.saveDag(nextDag);
    flashSaved();
    await refresh();
  }, [mana, flashSaved, refresh]);

  const onClone = useCallback(async () => {
    if (!mana?.config || !selectedDag) return;
    const newId = `dag-copy-${Date.now().toString(36)}`;
    const newName = `${selectedDag.name} (copy)`;
    const cloned = await mana.config.cloneDag(selectedDag.id, newId, newName);
    setSelectedId(cloned.id);
    await refresh();
  }, [mana, selectedDag, refresh]);

  const onDelete = useCallback(async () => {
    if (!mana?.config || !selectedDag) return;
    if (selectedDag.builtIn) { alert('Cannot delete built-in DAG.'); return; }
    if (!confirm(t('dag.deleteConfirm').replace('{name}', selectedDag.name))) return;
    await mana.config.deleteDag(selectedDag.id);
    setSelectedId(null);
    await refresh();
  }, [mana, selectedDag, t, refresh]);

  if (loadError) return <div className="p-3 text-xs text-red-400">{loadError}</div>;

  return (
    <ReactFlowProvider>
      <section className="pt-1">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div>
            <div className="font-bold text-sm">{t('dag.title')}</div>
            <p className="text-xs text-gray-500 mt-1">{t('dag.desc')}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="flat" onPress={onClone} isDisabled={!selectedDag}>
              {selectedDag?.builtIn ? t('subagent.cloneToCustomize') : t('dag.cloneDag')}
            </Button>
            <Button size="sm" variant="flat" color="danger" onPress={onDelete} isDisabled={!selectedDag || selectedDag.builtIn}>
              {t('dag.delete')}
            </Button>
            {savedFlash && <Chip size="sm" color="success" variant="flat">{t('dag.saved')}</Chip>}
          </div>
        </div>

        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-3 border border-vscode-panel-border rounded p-2 bg-vscode-sidebar/30 max-h-[60vh] overflow-y-auto">
            {dags.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setSelectedId(d.id)}
                className={`w-full text-left px-2 py-2 text-xs rounded mb-1 ${
                  selectedId === d.id ? 'bg-vscode-list-activeSelectionBackground text-white' : 'hover:bg-vscode-list-hoverBackground'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate flex-1">{d.name}</span>
                  {d.builtIn && <Chip size="sm" variant="flat">{t('dag.builtin')}</Chip>}
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  {d.id} · stage={d.stage}
                </div>
              </button>
            ))}
            {!dags.length && (
              <div className="text-xs text-gray-500 px-2 py-3">empty</div>
            )}
          </div>
          <div className="col-span-9">
            {selectedDag ? (
              <GraphPane
                key={selectedDag.id}
                dag={selectedDag}
                subagentMap={subagentMap}
                profiles={profiles}
                readOnly={!!selectedDag.builtIn}
                onCommit={onCommit}
              />
            ) : (
              <div className="text-xs text-gray-500 p-2">Select a DAG</div>
            )}
          </div>
        </div>
      </section>
    </ReactFlowProvider>
  );
}
