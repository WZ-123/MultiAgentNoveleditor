'use strict';

/**
 * Built-in DAG pipelines (4 total: 2 quality + 2 cheap, each pair = outline + writing).
 *
 * Schema:
 *   { id, builtIn, name, stage: 'outline'|'writing',
 *     entryNodeIds, nodes, edges, config: { maxRevisions }, schemaVersion }
 *
 * Node kinds: subagent | parallel | gate | human | output
 *  - subagent: { id, kind:'subagent', subagentId, tierOverride? , label? }
 *  - parallel: { id, kind:'parallel', children: [nodeId...], label? }
 *  - gate    : { id, kind:'gate', expr, label? }   // expr currently: 'no_issues'
 *  - human   : { id, kind:'human', label? }
 *  - output  : { id, kind:'output', label? }
 *
 * Edge:
 *   { from, to, when?: 'pass' | 'block' | undefined }
 *
 * Layout coordinates are NOT stored here — DagEditor will lay them out
 * deterministically (column = topological depth, row = edge order) on first
 * load and persist a `layout` map when the user moves nodes.
 */

const SCHEMA_VERSION = 2;

const BUILTIN_DAGS = [
  // ---------- 写作质量最优 · 大纲 ----------
  {
    id: 'dag-quality-outline',
    builtIn: true,
    name: '写作质量最优 · 大纲',
    stage: 'outline',
    schemaVersion: SCHEMA_VERSION,
    entryNodeIds: ['n_drafter'],
    nodes: [
      { id: 'n_drafter', kind: 'subagent', subagentId: 'sa-outline-drafter', label: '大纲草拟 (opus)' },
      { id: 'n_parallel_review', kind: 'parallel', children: ['n_char', 'n_time'], label: '并行审查' },
      { id: 'n_char', kind: 'subagent', subagentId: 'sa-character-reviewer', label: '人设审查 (opus)' },
      { id: 'n_time', kind: 'subagent', subagentId: 'sa-timeline-guardian', label: '时空校验 (opus)' },
      { id: 'n_gate', kind: 'gate', expr: 'no_issues', label: '若无 issues 则放行' },
      { id: 'n_revise', kind: 'subagent', subagentId: 'sa-outline-drafter', label: '修订大纲 (opus)' },
      { id: 'n_human', kind: 'human', label: '人工审阅' },
      { id: 'n_out', kind: 'output', label: '输出大纲' },
    ],
    edges: [
      { from: 'n_drafter', to: 'n_parallel_review' },
      { from: 'n_parallel_review', to: 'n_gate' },
      { from: 'n_gate', to: 'n_human', when: 'pass' },
      { from: 'n_gate', to: 'n_revise', when: 'block' },
      { from: 'n_revise', to: 'n_parallel_review' },
      { from: 'n_human', to: 'n_out' },
    ],
    config: { maxRevisions: 3 },
  },

  // ---------- 写作质量最优 · 撰写 ----------
  {
    id: 'dag-quality-writing',
    builtIn: true,
    name: '写作质量最优 · 撰写',
    stage: 'writing',
    schemaVersion: SCHEMA_VERSION,
    entryNodeIds: ['n_writer'],
    nodes: [
      { id: 'n_writer', kind: 'subagent', subagentId: 'sa-writer', label: '章节撰写 (sonnet)' },
      { id: 'n_parallel_check', kind: 'parallel', children: ['n_character', 'n_timeline', 'n_style', 'n_quality'], label: '并行硬检查' },
      { id: 'n_character', kind: 'subagent', subagentId: 'sa-character-reviewer', label: '逻辑 / 人设校验 (opus)' },
      { id: 'n_timeline', kind: 'subagent', subagentId: 'sa-timeline-guardian', label: '时空校验 (opus)' },
      { id: 'n_style', kind: 'subagent', subagentId: 'sa-style-checker', label: '文风一致性 (haiku)' },
      { id: 'n_quality', kind: 'subagent', subagentId: 'sa-prose-quality', label: '行文质量 (haiku)' },
      { id: 'n_gate', kind: 'gate', expr: 'no_issues', label: '若无 issues/annotations 则放行' },
      { id: 'n_revise', kind: 'subagent', subagentId: 'sa-writer', label: '按审查意见修订 (sonnet)' },
      { id: 'n_human', kind: 'human', label: '人工审阅' },
      { id: 'n_lore', kind: 'subagent', subagentId: 'sa-lore-updater', label: '本章总结 / 设定回写 (opus)' },
      { id: 'n_out', kind: 'output', label: '输出章节' },
    ],
    edges: [
      { from: 'n_writer', to: 'n_parallel_check' },
      { from: 'n_parallel_check', to: 'n_gate' },
      { from: 'n_gate', to: 'n_human', when: 'pass' },
      { from: 'n_gate', to: 'n_revise', when: 'block' },
      { from: 'n_revise', to: 'n_parallel_check' },
      { from: 'n_human', to: 'n_lore' },
      { from: 'n_lore', to: 'n_out' },
    ],
    config: { maxRevisions: 3 },
  },

  // ---------- 成本优先 · 大纲 ----------
  {
    id: 'dag-cheap-outline',
    builtIn: true,
    name: '成本优先 · 大纲',
    stage: 'outline',
    schemaVersion: SCHEMA_VERSION,
    entryNodeIds: ['n_drafter'],
    nodes: [
      { id: 'n_drafter', kind: 'subagent', subagentId: 'sa-outline-drafter', tierOverride: 'haiku', label: '大纲草拟 (haiku)' },
      { id: 'n_review', kind: 'subagent', subagentId: 'sa-character-reviewer', tierOverride: 'haiku', label: '人设审查 (haiku)' },
      { id: 'n_time', kind: 'subagent', subagentId: 'sa-timeline-guardian', tierOverride: 'sonnet', label: '时空校验 (sonnet)' },
      { id: 'n_human', kind: 'human', label: '人工审阅' },
      { id: 'n_out', kind: 'output', label: '输出大纲' },
    ],
    edges: [
      { from: 'n_drafter', to: 'n_review' },
      { from: 'n_review', to: 'n_time' },
      { from: 'n_time', to: 'n_human' },
      { from: 'n_human', to: 'n_out' },
    ],
    config: { maxRevisions: 2 },
  },

  // ---------- 成本优先 · 撰写 ----------
  {
    id: 'dag-cheap-writing',
    builtIn: true,
    name: '成本优先 · 撰写',
    stage: 'writing',
    schemaVersion: SCHEMA_VERSION,
    entryNodeIds: ['n_writer'],
    nodes: [
      { id: 'n_writer', kind: 'subagent', subagentId: 'sa-writer', tierOverride: 'haiku', label: '章节撰写 (haiku)' },
      { id: 'n_parallel_check', kind: 'parallel', children: ['n_character', 'n_timeline'], label: '并行硬检查' },
      { id: 'n_character', kind: 'subagent', subagentId: 'sa-character-reviewer', tierOverride: 'haiku', label: '逻辑 / 人设校验 (haiku)' },
      { id: 'n_timeline', kind: 'subagent', subagentId: 'sa-timeline-guardian', tierOverride: 'sonnet', label: '时空校验 (sonnet)' },
      { id: 'n_gate', kind: 'gate', expr: 'no_issues', label: '若无 issues 则放行' },
      { id: 'n_revise', kind: 'subagent', subagentId: 'sa-writer', tierOverride: 'haiku', label: '按硬伤修订 (haiku)' },
      { id: 'n_human', kind: 'human', label: '人工审阅' },
      { id: 'n_lore', kind: 'subagent', subagentId: 'sa-lore-updater', tierOverride: 'haiku', label: '本章总结 (haiku)' },
      { id: 'n_out', kind: 'output', label: '输出章节' },
    ],
    edges: [
      { from: 'n_writer', to: 'n_parallel_check' },
      { from: 'n_parallel_check', to: 'n_gate' },
      { from: 'n_gate', to: 'n_human', when: 'pass' },
      { from: 'n_gate', to: 'n_revise', when: 'block' },
      { from: 'n_revise', to: 'n_parallel_check' },
      { from: 'n_human', to: 'n_lore' },
      { from: 'n_lore', to: 'n_out' },
    ],
    config: { maxRevisions: 2 },
  },
];

module.exports = { BUILTIN_DAGS, SCHEMA_VERSION };
