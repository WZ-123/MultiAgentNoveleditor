import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  addEdge,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Input } from '@heroui/react';
import { Play, Save, Trash2, Copy, Zap, GitBranch, Layers, FileOutput, Type, BookOpen, Sparkles, CheckCircle } from 'lucide-react';
import { useI18n } from '@/i18n/LanguageContext.jsx';

/* ────────────────────────────────
   节点颜色与类型定义（虚幻蓝图风格）
   ──────────────────────────────── */
const NODE_COLORS = {
  start: { bg: '#2e7d32', border: '#1b5e20', header: '#4caf50' },
  agent: { bg: '#0d47a1', border: '#1565c0', header: '#1976d2' },
  gate:  { bg: '#6a1b9a', border: '#8e24aa', header: '#ab47bc' },
  parallel: { bg: '#006064', border: '#00838f', header: '#26c6da' },
  output: { bg: '#c62828', border: '#e53935', header: '#ef5350' },
};

const AGENT_TYPES = [
  { id: 'outline', label: '大纲生成', icon: BookOpen, desc: '根据输入生成故事大纲' },
  { id: 'writing', label: '章节写作', icon: Type, desc: '根据大纲写作章节内容' },
  { id: 'style', label: '文风检查', icon: Sparkles, desc: '检查并统一文风' },
  { id: 'quality', label: '质量审查', icon: CheckCircle, desc: '审查内容质量' },
  { id: 'archive', label: '本章存档', icon: FileOutput, desc: '存档本章内容' },
];

/* ────────────────────────────────
   自定义节点组件
   ──────────────────────────────── */

/* ────────────────────────────────
   引脚分类与连接校验（蓝图核心约束）
   ──────────────────────────────── */

// 引脚 ID 的命名约定决定其类别：
//   exec-*       → 执行流引脚（白色方形）
//   input-* / output-* → 数据变量引脚（彩色圆形）
function pinClassOf(handleId) {
  if (!handleId) return null;
  if (handleId.startsWith('exec')) return 'exec';
  if (handleId.startsWith('input-') || handleId.startsWith('output-')) return 'var';
  return null;
}

// ReactFlow 在用户连线前会调用此 callback，返回 false 阻止连接成立。
function isValidBlueprintConnection(conn) {
  const sc = pinClassOf(conn.sourceHandle);
  const tc = pinClassOf(conn.targetHandle);
  if (sc == null || tc == null) return false;
  return sc === tc;
}

// 将 edge 按引脚类别上色：exec 流是白色实线（动画），变量流是蓝色细线。
function styleEdgeByClass(edge) {
  const isExec = edge.sourceHandle?.startsWith('exec');
  return {
    ...edge,
    animated: isExec,
    style: {
      stroke: isExec ? '#e0e0e0' : '#4fc3f7',
      strokeWidth: isExec ? 2 : 1.5,
    },
  };
}

/* ────────────────────────────────
   引脚原语：行式布局
   ──────────────────────────────── */

const EXEC_PIN_STYLE = {
  background: '#f5f5f5',
  width: 12,
  height: 12,
  border: '2px solid #bdbdbd',
  borderRadius: 2,
};

const VAR_PIN_STYLE = (color) => ({
  background: color || '#4fc3f7',
  width: 10,
  height: 10,
  border: `2px solid ${color || '#4fc3f7'}`,
  borderRadius: '50%',
});

function ExecRow({ leftId, rightId, leftLabel = '执行', rightLabel = '执行', leftColor, rightColor }) {
  return (
    <div className="relative flex items-center justify-between min-h-[22px] px-3 py-0.5 bg-black/25 border-y border-white/10">
      <div className="flex items-center gap-1.5 min-w-0">
        {leftId ? (
          <>
            <Handle
              type="target"
              position={Position.Left}
              id={leftId}
              style={{ ...EXEC_PIN_STYLE, ...(leftColor ? { borderColor: leftColor } : {}), top: '50%', left: -6 }}
            />
            <span className="text-[10px] text-gray-200 font-semibold">{leftLabel}</span>
          </>
        ) : <span />}
      </div>
      <div className="flex items-center gap-1.5 min-w-0 ml-auto">
        {rightId ? (
          <>
            <span className="text-[10px] text-gray-200 font-semibold">{rightLabel}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={rightId}
              style={{ ...EXEC_PIN_STYLE, ...(rightColor ? { borderColor: rightColor } : {}), top: '50%', right: -6 }}
            />
          </>
        ) : <span />}
      </div>
    </div>
  );
}

function VarRow({ side, type, id, label, color }) {
  // side: 'left' 输入 / 'right' 输出
  return (
    <div className="relative flex items-center min-h-[20px] px-3 py-0.5"
         style={{ justifyContent: side === 'left' ? 'flex-start' : 'flex-end' }}>
      {side === 'left' ? (
        <>
          <Handle
            type={type}
            position={Position.Left}
            id={id}
            style={{ ...VAR_PIN_STYLE(color), top: '50%', left: -5 }}
          />
          <span className="text-[10px] text-gray-300 ml-1.5 whitespace-nowrap">{label}</span>
        </>
      ) : (
        <>
          <span className="text-[10px] text-gray-300 mr-1.5 whitespace-nowrap">{label}</span>
          <Handle
            type={type}
            position={Position.Right}
            id={id}
            style={{ ...VAR_PIN_STYLE(color), top: '50%', right: -5 }}
          />
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────
   节点组件（行式布局：标题 → 执行流 → 变量）
   ──────────────────────────────── */

function StartNode({ data, selected }) {
  const colors = NODE_COLORS.start;
  const outputs = data.outputs || [];
  return (
    <div
      className="rounded border-2 min-w-[160px] overflow-hidden"
      style={{
        background: '#1a1a2e',
        borderColor: selected ? '#fff' : colors.border,
        boxShadow: selected ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
      }}
    >
      <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ background: colors.header }}>
        <Zap size={12} className="text-white" />
        <span className="text-xs font-bold text-white">{data.label || '开始'}</span>
      </div>
      <ExecRow rightId="exec-out" leftId={null} rightLabel="执行" />
      {outputs.map((o) => (
        <VarRow key={o.id} side="right" type="source" id={`output-${o.id}`} label={o.label} color="#81c784" />
      ))}
    </div>
  );
}

function EndNode({ data, selected }) {
  const colors = NODE_COLORS.output;
  return (
    <div
      className="rounded border-2 min-w-[160px] overflow-hidden"
      style={{
        background: '#1a1a2e',
        borderColor: selected ? '#fff' : colors.border,
        boxShadow: selected ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
      }}
    >
      <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ background: colors.header }}>
        <FileOutput size={12} className="text-white" />
        <span className="text-xs font-bold text-white">{data.label || '结束'}</span>
      </div>
      <ExecRow leftId="exec-in" rightId={null} leftLabel="执行" />
      <VarRow side="left" type="target" id="input-result" label="结果" color="#4fc3f7" />
    </div>
  );
}

function AgentNode({ data, selected }) {
  const colors = NODE_COLORS.agent;
  const agentType = AGENT_TYPES.find(a => a.id === data.agentType) || AGENT_TYPES[0];
  const Icon = agentType.icon;
  const inputs = data.inputs || [];
  const outputs = data.outputs || [];

  return (
    <div
      className="rounded border-2 min-w-[200px] overflow-hidden"
      style={{
        background: '#1a1a2e',
        borderColor: selected ? '#fff' : colors.border,
        boxShadow: selected ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
      }}
    >
      {/* 标题栏 */}
      <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ background: colors.header }}>
        <Icon size={12} className="text-white" />
        <span className="text-xs font-bold text-white">{data.label || agentType.label}</span>
      </div>

      {/* 执行流（exec-in 左 / exec-out 右，同一行） */}
      <ExecRow leftId="exec-in" rightId="exec-out" />

      {/* 数据输入（左侧蓝色圆点） */}
      {inputs.map((input) => (
        <VarRow
          key={`in-${input.id}`}
          side="left"
          type="target"
          id={`input-${input.id}`}
          label={input.label}
          color="#4fc3f7"
        />
      ))}

      {/* 数据输出（右侧绿色圆点） */}
      {outputs.map((output) => (
        <VarRow
          key={`out-${output.id}`}
          side="right"
          type="source"
          id={`output-${output.id}`}
          label={output.label}
          color="#81c784"
        />
      ))}
    </div>
  );
}

function GateNode({ data, selected }) {
  const colors = NODE_COLORS.gate;
  return (
    <div
      className="rounded border-2 min-w-[180px] overflow-hidden"
      style={{
        background: '#1a1a2e',
        borderColor: selected ? '#fff' : colors.border,
        boxShadow: selected ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
      }}
    >
      <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ background: colors.header }}>
        <GitBranch size={12} className="text-white" />
        <span className="text-xs font-bold text-white">{data.label || '条件门'}</span>
      </div>
      {/* exec-in 单独一行 */}
      <ExecRow leftId="exec-in" rightId={null} />
      {/* exec-out-pass 一行（绿色边框） */}
      <ExecRow leftId={null} rightId="exec-out-pass" rightLabel="通过" rightColor="#81c784" />
      {/* exec-out-fail 一行（红色边框） */}
      <ExecRow leftId={null} rightId="exec-out-fail" rightLabel="不通过" rightColor="#e57373" />
      {/* 条件输入变量（可选） */}
      <VarRow side="left" type="target" id="input-condition" label="条件输入" color="#ffb74d" />
    </div>
  );
}

function ParallelNode({ data, selected }) {
  const colors = NODE_COLORS.parallel;
  return (
    <div
      className="rounded border-2 min-w-[180px] overflow-hidden"
      style={{
        background: '#1a1a2e',
        borderColor: selected ? '#fff' : colors.border,
        boxShadow: selected ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
      }}
    >
      <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ background: colors.header }}>
        <Layers size={12} className="text-white" />
        <span className="text-xs font-bold text-white">{data.label || '并行执行'}</span>
      </div>
      <ExecRow leftId="exec-in" rightId={null} />
      <ExecRow leftId={null} rightId="exec-out-1" rightLabel="分支 1" />
      <ExecRow leftId={null} rightId="exec-out-2" rightLabel="分支 2" />
      <ExecRow leftId={null} rightId="exec-out-3" rightLabel="分支 3" />
    </div>
  );
}

const nodeTypes = {
  startNode: StartNode,
  agentNode: AgentNode,
  gateNode: GateNode,
  parallelNode: ParallelNode,
  endNode: EndNode,
};

/* ────────────────────────────────
   预置的写作流程模板
   ──────────────────────────────── */
const WRITING_FLOW_TEMPLATE = {
  nodes: [
    {
      id: 'start',
      type: 'startNode',
      position: { x: 50, y: 200 },
      data: { label: '开始写作', outputs: [{ id: 'userInput', label: '用户输入' }] },
    },
    {
      id: 'outline',
      type: 'agentNode',
      position: { x: 300, y: 150 },
      data: {
        label: '大纲生成',
        agentType: 'outline',
        inputs: [{ id: 'userInput', label: '用户输入' }],
        outputs: [{ id: 'outline', label: '大纲' }],
      },
    },
    {
      id: 'writing',
      type: 'agentNode',
      position: { x: 550, y: 150 },
      data: {
        label: '章节写作',
        agentType: 'writing',
        inputs: [{ id: 'outline', label: '大纲' }],
        outputs: [{ id: 'draft', label: '初稿' }],
      },
    },
    {
      id: 'style-gate',
      type: 'gateNode',
      position: { x: 800, y: 200 },
      data: { label: '文风检查?' },
    },
    {
      id: 'style',
      type: 'agentNode',
      position: { x: 1050, y: 100 },
      data: {
        label: '文风检查',
        agentType: 'style',
        inputs: [{ id: 'draft', label: '初稿' }],
        outputs: [{ id: 'styled', label: '润色稿' }],
      },
    },
    {
      id: 'quality',
      type: 'agentNode',
      position: { x: 1050, y: 280 },
      data: {
        label: '质量审查',
        agentType: 'quality',
        inputs: [{ id: 'draft', label: '初稿' }],
        outputs: [{ id: 'reviewed', label: '审查稿' }],
      },
    },
    {
      id: 'archive',
      type: 'agentNode',
      position: { x: 1300, y: 200 },
      data: {
        label: '本章存档',
        agentType: 'archive',
        inputs: [{ id: 'content', label: '内容' }],
        outputs: [{ id: 'saved', label: '已存档' }],
      },
    },
    {
      id: 'end',
      type: 'endNode',
      position: { x: 1550, y: 200 },
      data: { label: '完成' },
    },
  ],
  edges: [
    { id: 'e-start-outline', source: 'start', target: 'outline', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
    { id: 'e-outline-writing', source: 'outline', target: 'writing', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
    { id: 'e-writing-gate', source: 'writing', target: 'style-gate', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
    { id: 'e-gate-style', source: 'style-gate', target: 'style', sourceHandle: 'exec-out-pass', targetHandle: 'exec-in' },
    { id: 'e-gate-quality', source: 'style-gate', target: 'quality', sourceHandle: 'exec-out-fail', targetHandle: 'exec-in' },
    { id: 'e-style-archive', source: 'style', target: 'archive', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
    { id: 'e-quality-archive', source: 'quality', target: 'archive', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
    { id: 'e-archive-end', source: 'archive', target: 'end', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
  ],
};

/* ────────────────────────────────
   节点属性面板
   ──────────────────────────────── */
function NodePropertiesPanel({ node, onChange, onDelete }) {
  const { t } = useI18n();
  if (!node) return (
    <div className="p-3 text-xs text-gray-500">
      点击节点编辑属性<br />
      拖拽引脚创建连线
    </div>
  );

  const data = node.data;
  const isAgent = node.type === 'agentNode';

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-300">节点属性</span>
        <Button size="sm" color="danger" variant="flat" onPress={onDelete}>
          <Trash2 size={12} />
        </Button>
      </div>

      <Input
        size="sm"
        label="名称"
        value={data.label || ''}
        onChange={(e) => onChange({ ...data, label: e.target.value })}
      />

      {isAgent && (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-500">Agent类型</span>
            <select
              className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-xs"
              value={data.agentType || 'outline'}
              onChange={(e) => onChange({ ...data, agentType: e.target.value })}
            >
              {AGENT_TYPES.map(a => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-500">模型</span>
            <select
              className="bg-vscode-sidebar border border-vscode-panel-border rounded px-2 py-1.5 text-xs"
              value={data.model || 'claude-sonnet-4-6'}
              onChange={(e) => onChange({ ...data, model: e.target.value })}
            >
              <option value="claude-opus-4-7">Claude Opus 4.7</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-500">Temperature</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={data.temperature ?? 0.7}
              onChange={(e) => onChange({ ...data, temperature: Number(e.target.value) })}
              className="w-full"
            />
            <span className="text-gray-400">{data.temperature ?? 0.7}</span>
          </label>
        </>
      )}

      {node.type === 'gateNode' && (
        <Input
          size="sm"
          label="条件表达式"
          value={data.condition || ''}
          onChange={(e) => onChange({ ...data, condition: e.target.value })}
          placeholder="例如: quality_score > 0.8"
        />
      )}
    </div>
  );
}

/* ────────────────────────────────
   主编辑器组件
   ──────────────────────────────── */
function BlueprintCanvas({ initialNodes, initialEdges, onSave, readOnly = false }) {
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState(null);
  const reactFlowWrapper = useRef(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const onConnect = useCallback(
    (params) => {
      if (readOnly) return;
      // 蓝图核心约束：执行流引脚 ↔ 执行流引脚；变量引脚 ↔ 变量引脚；二者不可混连。
      if (!isValidBlueprintConnection(params)) return;
      setEdges((eds) => addEdge(styleEdgeByClass(params), eds));
    },
    [readOnly, setEdges]
  );

  const onNodeClick = useCallback((_event, node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      if (readOnly || !reactFlowInstance) return;

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const agentType = event.dataTransfer.getData('agentType');
      const newNode = createNode(type, position, agentType);
      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, readOnly, setNodes]
  );

  const handleNodeChange = useCallback((nodeId, newData) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== nodeId) return n;
        return { ...n, data: newData };
      })
    );
    if (selectedNode?.id === nodeId) {
      setSelectedNode({ ...selectedNode, data: newData });
    }
  }, [setNodes, selectedNode]);

  const handleDeleteNode = useCallback(() => {
    if (!selectedNode || readOnly) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
    setSelectedNode(null);
  }, [selectedNode, readOnly, setNodes, setEdges]);

  const handleSave = useCallback(() => {
    onSave?.({ nodes, edges });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }, [nodes, edges, onSave]);

  const handleRun = useCallback(() => {
    setIsRunning(true);
    // TODO: 实际执行流程
    setTimeout(() => setIsRunning(false), 2000);
  }, []);

  const handleLoadTemplate = useCallback(() => {
    setNodes(WRITING_FLOW_TEMPLATE.nodes);
    setEdges(WRITING_FLOW_TEMPLATE.edges.map(styleEdgeByClass));
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  return (
    <div className="flex h-full w-full">
      {/* 左侧节点面板 */}
      <div className="w-48 border-r border-vscode-panel-border bg-vscode-sidebar flex flex-col">
        <div className="h-9 px-3 flex items-center text-xs font-bold text-gray-400 uppercase border-b border-vscode-panel-border">
          节点库
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="text-[10px] text-gray-500 uppercase font-bold mb-1">控制流</div>
          <NodePaletteItem type="startNode" label="开始" color={NODE_COLORS.start.header} icon={Zap} />
          <NodePaletteItem type="endNode" label="结束" color={NODE_COLORS.output.header} icon={FileOutput} />
          <NodePaletteItem type="gateNode" label="条件门" color={NODE_COLORS.gate.header} icon={GitBranch} />
          <NodePaletteItem type="parallelNode" label="并行" color={NODE_COLORS.parallel.header} icon={Layers} />

          <div className="text-[10px] text-gray-500 uppercase font-bold mt-3 mb-1">Agent节点</div>
          {AGENT_TYPES.map(agent => (
            <NodePaletteItem
              key={agent.id}
              type="agentNode"
              label={agent.label}
              color={NODE_COLORS.agent.header}
              icon={agent.icon}
              agentType={agent.id}
            />
          ))}
        </div>
      </div>

      {/* 画布区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 工具栏 */}
        <div className="h-9 border-b border-vscode-panel-border flex items-center px-3 gap-2 bg-vscode-sidebar">
          <Button size="sm" color="primary" variant="flat" onPress={handleRun} isDisabled={isRunning}>
            <Play size={12} />
            {isRunning ? '运行中...' : '运行流程'}
          </Button>
          <Button size="sm" variant="flat" onPress={handleSave}>
            <Save size={12} />
            {savedFlash ? '已保存!' : '保存'}
          </Button>
          <div className="w-px h-4 bg-vscode-panel-border mx-1" />
          <Button size="sm" variant="flat" onPress={handleLoadTemplate}>
            <Copy size={12} />
            加载写作模板
          </Button>
          <div className="flex-1" />
          {savedFlash && <span className="text-xs text-green-400">已保存</span>}
        </div>

        {/* React Flow 画布 */}
        <div className="flex-1 min-h-0" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidBlueprintConnection}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            edgesReconnectable={!readOnly}
            deleteKeyCode={readOnly ? null : 'Delete'}
            style={{ background: '#0f0f1a' }}
          >
            <Background gap={20} size={1} color="#2a2a3a" />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      {/* 右侧属性面板 */}
      <div className="w-56 border-l border-vscode-panel-border bg-vscode-sidebar flex flex-col">
        <div className="h-9 px-3 flex items-center text-xs font-bold text-gray-400 uppercase border-b border-vscode-panel-border">
          属性
        </div>
        <div className="flex-1 overflow-y-auto">
          <NodePropertiesPanel
            node={selectedNode}
            onChange={(newData) => selectedNode && handleNodeChange(selectedNode.id, newData)}
            onDelete={handleDeleteNode}
          />
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────
   辅助组件
   ──────────────────────────────── */

function NodePaletteItem({ type, label, color, icon: Icon, agentType }) {
  const onDragStart = (event) => {
    event.dataTransfer.setData('application/reactflow', type);
    if (agentType) {
      event.dataTransfer.setData('agentType', agentType);
    }
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="flex items-center gap-2 px-2 py-1.5 rounded cursor-grab hover:bg-vscode-active-item active:cursor-grabbing"
    >
      <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
      <Icon size={12} className="text-gray-400 shrink-0" />
      <span className="text-xs text-gray-300">{label}</span>
    </div>
  );
}

function createNode(type, position, agentType) {
  const id = `${type}-${Date.now()}`;
  switch (type) {
    case 'startNode':
      return { id, type, position, data: { label: '开始', outputs: [{ id: 'userInput', label: '用户输入' }] } };
    case 'endNode':
      return { id, type, position, data: { label: '结束' } };
    case 'agentNode': {
      const agent = AGENT_TYPES.find(a => a.id === agentType) || AGENT_TYPES[0];
      return {
        id, type, position,
        data: {
          label: agent.label,
          agentType: agent.id,
          inputs: [{ id: 'input', label: '输入' }],
          outputs: [{ id: 'output', label: '输出' }],
          model: 'claude-sonnet-4-6',
          temperature: 0.7,
        },
      };
    }
    case 'gateNode':
      return { id, type, position, data: { label: '条件门', condition: '' } };
    case 'parallelNode':
      return { id, type, position, data: { label: '并行执行' } };
    default:
      return { id, type: 'agentNode', position, data: { label: '节点' } };
  }
}

/* ────────────────────────────────
   导出组件
   ──────────────────────────────── */
export function BlueprintEditor({ dagId, readOnly = false }) {
  const { t } = useI18n();
  const [flowData, setFlowData] = useState(() => loadFlow(dagId));

  const handleSave = useCallback((data) => {
    saveFlow(dagId, data);
  }, [dagId]);

  return (
    <ReactFlowProvider>
      <div className="h-full w-full flex flex-col">
        <BlueprintCanvas
          initialNodes={flowData.nodes}
          initialEdges={flowData.edges}
          onSave={handleSave}
          readOnly={readOnly}
        />
      </div>
    </ReactFlowProvider>
  );
}

/* ────────────────────────────────
   本地存储
   ──────────────────────────────── */
const STORAGE_KEY = 'blueprint-flows';

function loadFlow(dagId) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const flows = JSON.parse(stored);
      if (flows[dagId]) return flows[dagId];
    }
  } catch { /* ignore */ }
  // 默认返回写作模板
  return {
    nodes: WRITING_FLOW_TEMPLATE.nodes,
    edges: WRITING_FLOW_TEMPLATE.edges.map(styleEdgeByClass),
  };
}

function saveFlow(dagId, data) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const flows = stored ? JSON.parse(stored) : {};
    flows[dagId] = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flows));
  } catch { /* ignore */ }
}
