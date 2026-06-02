'use strict';

/**
 * runPipeline — DAG executor for multi-subagent novel-writing pipelines.
 *
 * Schema (see ../seeds/builtinDags.js):
 *   dag = { id, stage, nodes, edges, entryNodeIds, config: { maxRevisions } }
 *   node.kind ∈ { 'subagent', 'parallel', 'gate', 'human', 'output' }
 *   edge = { from, to, when?: 'pass'|'block' }
 *
 * Strategy:
 *   - Start at entryNodeIds; for each node call dispatch(kind).
 *   - Subagent / parallel / human / output produce an output value stored in nodeOutputs[id].
 *   - Gate evaluates expr against parent outputs and returns 'pass' | 'block';
 *     outgoing edges with matching `when` fire next. maxRevisions guards loops:
 *     after N gate evaluations producing 'block', subsequent ones force 'pass'
 *     so the user lands in human review instead of looping forever.
 *   - Human node pauses execution and emits an `awaiting_human` event; the
 *     renderer calls resumePipeline(pipelineRunId, nodeId, payload) to continue.
 *   - Cancel is propagated via AbortController shared with each runSubagent.
 *
 * Inputs to subagents: by default we string-join all parent outputs (or the
 * pipeline's user input for entry nodes). For parallel parents we pass a
 * JSON-stringified `{childId: childOutput}` object. The subagent's
 * systemPrompt should describe the expected shape.
 */

const eventBus = require('./eventBus');
const { runSubagent } = require('./runSubagent');
const dagsStore = require('../store/dags');
const { generateId } = require('../store/paths');

const activePipelines = new Map(); // pipelineRunId -> { abortController, pendingHuman: Map<nodeId, {resolve}> }

function getNode(dag, id) {
  return dag.nodes.find((n) => n.id === id) || null;
}

function getOutgoingEdges(dag, fromId) {
  return dag.edges.filter((e) => e.from === fromId);
}

function getIncomingEdges(dag, toId) {
  return dag.edges.filter((e) => e.to === toId);
}

function buildInputForNode(dag, nodeId, nodeOutputs, userInput) {
  const incoming = getIncomingEdges(dag, nodeId);
  if (!incoming.length) {
    return typeof userInput === 'string' ? userInput : JSON.stringify(userInput || {});
  }
  if (incoming.length === 1) {
    const o = nodeOutputs[incoming[0].from];
    if (o == null) return '';
    if (typeof o === 'string') return o;
    return JSON.stringify(o);
  }
  // multiple parents — pass an object keyed by parent id
  const obj = {};
  for (const e of incoming) obj[e.from] = nodeOutputs[e.from] ?? null;
  return JSON.stringify(obj);
}

function tryParseReviewFindings(text) {
  if (!text) return null;
  if (typeof text === 'object') {
    if (Array.isArray(text.issues)) return text.issues;
    if (Array.isArray(text.annotations)) return text.annotations;
    return null;
  }
  // strip code fences if present
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && Array.isArray(obj.issues)) return obj.issues;
    if (obj && Array.isArray(obj.annotations)) return obj.annotations;
  } catch {
    // fall through — try to find first JSON object in the text
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && Array.isArray(obj.issues)) return obj.issues;
        if (obj && Array.isArray(obj.annotations)) return obj.annotations;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function evaluateGate(dag, gateNode, nodeOutputs) {
  const incoming = getIncomingEdges(dag, gateNode.id);
  if (gateNode.expr === 'no_issues') {
    let foundAny = false;
    for (const e of incoming) {
      const upstream = nodeOutputs[e.from];
      if (upstream == null) continue;
      // upstream may itself be a parallel-fan-in object
      const candidates = [];
      if (typeof upstream === 'object' && !Array.isArray(upstream)) {
        for (const key of Object.keys(upstream)) candidates.push(upstream[key]);
      } else {
        candidates.push(upstream);
      }
      for (const c of candidates) {
        const findings = tryParseReviewFindings(c);
        if (findings != null) {
          foundAny = true;
          if (findings.length > 0) return 'block';
        }
      }
    }
    // if nothing parsed, default to pass (don't block on parse error)
    return foundAny ? 'pass' : 'pass';
  }
  // Unknown expr — pass
  return 'pass';
}

async function runPipeline(opts = {}) {
  const {
    dagId,
    dag: explicitDag,
    userInput,
    presetOverride,
    userLang,
    mcpClient,
    pipelineRunId: providedPipelineRunId,
  } = opts;

  const dag = explicitDag || (dagId ? await dagsStore.getDag(dagId) : null);
  if (!dag) throw new Error(`DAG not found: ${dagId}`);
  if (!Array.isArray(dag.entryNodeIds) || !dag.entryNodeIds.length) {
    throw new Error(`DAG ${dag.id} has no entry nodes`);
  }

  const pipelineRunId = providedPipelineRunId || generateId('pipeline');
  const abortController = new AbortController();
  const pendingHuman = new Map();
  activePipelines.set(pipelineRunId, { abortController, pendingHuman, dagId: dag.id });

  const maxRevisions = dag.config?.maxRevisions ?? 3;
  const nodeOutputs = {}; // nodeId -> any
  const nodeStatus = {};  // nodeId -> 'queued'|'running'|'done'|'error'|'skipped'
  const gateRevisions = {}; // gateId -> number of times block was returned
  const visited = new Set();

  await eventBus.emitPipeline({
    pipelineRunId,
    dagId: dag.id,
    kind: 'pipeline_started',
    data: { stage: dag.stage, name: dag.name },
  });

  try {
    // Run nodes via a worklist of (nodeId) entries.
    const worklist = [...dag.entryNodeIds];
    while (worklist.length) {
      if (abortController.signal.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      const nodeId = worklist.shift();
      const node = getNode(dag, nodeId);
      if (!node) {
        await eventBus.emitPipeline({
          pipelineRunId, dagId: dag.id, nodeId, kind: 'node_error',
          data: { message: `node not found: ${nodeId}` },
        });
        continue;
      }
      // Allow re-execution for revise loops, but bound it.
      // For now, only nodes whose status is 'done' once may be revisited if they are
      // reachable via a 'revise' loop edge originating from a gate.
      nodeStatus[nodeId] = 'running';
      visited.add(nodeId);
      await eventBus.emitPipeline({
        pipelineRunId, dagId: dag.id, nodeId, kind: 'node_started',
        data: { kind: node.kind, label: node.label || '', subagentId: node.subagentId || null },
      });

      let nextEdges = [];
      let output = null;

      try {
        if (node.kind === 'subagent') {
          const input = buildInputForNode(dag, nodeId, nodeOutputs, userInput);
          const r = await runSubagent({
            subagentId: node.subagentId,
            input,
            tierOverride: node.tierOverride || undefined,
            presetOverride,
            userLang,
            mcpClient,
            abortSignal: abortController.signal,
            pipelineRunId,
            nodeId,
          });
          output = r.output;
          nodeOutputs[nodeId] = output;
          nextEdges = getOutgoingEdges(dag, nodeId).filter((e) => !e.when);
        } else if (node.kind === 'parallel') {
          const children = Array.isArray(node.children) ? node.children : [];
          const results = await Promise.all(children.map(async (childId) => {
            const child = getNode(dag, childId);
            if (!child || child.kind !== 'subagent') return [childId, null];
            const childInput = buildInputForNode(dag, nodeId, nodeOutputs, userInput);
            visited.add(childId);
            nodeStatus[childId] = 'running';
            await eventBus.emitPipeline({
              pipelineRunId, dagId: dag.id, nodeId: childId, kind: 'node_started',
              data: { kind: child.kind, label: child.label || '', subagentId: child.subagentId, parentParallel: nodeId },
            });
            try {
              const r = await runSubagent({
                subagentId: child.subagentId,
                input: childInput,
                tierOverride: child.tierOverride || undefined,
                presetOverride,
                userLang,
                mcpClient,
                abortSignal: abortController.signal,
                pipelineRunId,
                nodeId: childId,
              });
              nodeOutputs[childId] = r.output;
              nodeStatus[childId] = 'done';
              await eventBus.emitPipeline({
                pipelineRunId, dagId: dag.id, nodeId: childId, kind: 'node_done',
                data: { output: r.output },
              });
              return [childId, r.output];
            } catch (err) {
              nodeStatus[childId] = 'error';
              await eventBus.emitPipeline({
                pipelineRunId, dagId: dag.id, nodeId: childId, kind: 'node_error',
                data: { message: err.message || String(err) },
              });
              throw err;
            }
          }));
          const collated = {};
          for (const [k, v] of results) collated[k] = v;
          output = collated;
          nodeOutputs[nodeId] = output;
          nextEdges = getOutgoingEdges(dag, nodeId).filter((e) => !e.when);
        } else if (node.kind === 'gate') {
          let decision = evaluateGate(dag, node, nodeOutputs);
          if (decision === 'block') {
            gateRevisions[nodeId] = (gateRevisions[nodeId] || 0) + 1;
            if (gateRevisions[nodeId] > maxRevisions) {
              decision = 'pass';
              await eventBus.emitPipeline({
                pipelineRunId, dagId: dag.id, nodeId, kind: 'gate_max_revisions',
                data: { maxRevisions, forced: 'pass' },
              });
            }
          }
          const upstream = {};
          for (const e of getIncomingEdges(dag, nodeId)) {
            upstream[e.from] = nodeOutputs[e.from] ?? null;
          }
          const context = {};
          for (const [outputNodeId, value] of Object.entries(nodeOutputs)) {
            const outputNode = getNode(dag, outputNodeId);
            if (outputNode?.kind === 'gate') continue;
            context[outputNodeId] = value;
          }
          output = { decision, revisions: gateRevisions[nodeId] || 0, upstream, context };
          nodeOutputs[nodeId] = output;
          nextEdges = getOutgoingEdges(dag, nodeId).filter((e) => e.when === decision);
          await eventBus.emitPipeline({
            pipelineRunId, dagId: dag.id, nodeId, kind: 'gate_decision',
            data: { decision, revisions: gateRevisions[nodeId] || 0 },
          });
        } else if (node.kind === 'human') {
          // Snapshot all upstream outputs for the user to review.
          const snapshot = {};
          for (const e of getIncomingEdges(dag, nodeId)) {
            snapshot[e.from] = nodeOutputs[e.from] ?? null;
          }
          await eventBus.emitPipeline({
            pipelineRunId, dagId: dag.id, nodeId, kind: 'awaiting_human',
            data: { label: node.label || '', snapshot },
          });
          // Wait for resumePipeline to deliver a payload for this node.
          output = await new Promise((resolve, reject) => {
            pendingHuman.set(nodeId, { resolve, reject });
            abortController.signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
          nodeOutputs[nodeId] = output;
          nextEdges = getOutgoingEdges(dag, nodeId).filter((e) => !e.when);
        } else if (node.kind === 'output') {
          // Collect upstream outputs into the final output.
          const final = {};
          for (const e of getIncomingEdges(dag, nodeId)) {
            final[e.from] = nodeOutputs[e.from] ?? null;
          }
          output = final;
          nodeOutputs[nodeId] = output;
          nextEdges = []; // terminal
          await eventBus.emitPipeline({
            pipelineRunId, dagId: dag.id, nodeId, kind: 'pipeline_output',
            data: { output: final },
          });
        } else {
          throw new Error(`Unknown node kind: ${node.kind}`);
        }

        nodeStatus[nodeId] = 'done';
        await eventBus.emitPipeline({
          pipelineRunId, dagId: dag.id, nodeId, kind: 'node_done',
          data: { output },
        });

        for (const e of nextEdges) {
          // For revise loops: clear cached "done" status of cycle members so they re-run.
          if (!worklist.includes(e.to)) worklist.push(e.to);
        }
      } catch (err) {
        nodeStatus[nodeId] = 'error';
        await eventBus.emitPipeline({
          pipelineRunId, dagId: dag.id, nodeId, kind: 'node_error',
          data: { message: err.message || String(err) },
        });
        throw err;
      }
    }

    // Find terminal output node(s) and return their collated payload.
    const outputNodes = dag.nodes.filter((n) => n.kind === 'output');
    const finalOutput = outputNodes.length === 1
      ? nodeOutputs[outputNodes[0].id]
      : Object.fromEntries(outputNodes.map((n) => [n.id, nodeOutputs[n.id]]));

    await eventBus.emitPipeline({
      pipelineRunId,
      dagId: dag.id,
      kind: 'pipeline_done',
      data: { output: finalOutput, nodeStatus },
    });
    return { pipelineRunId, output: finalOutput, nodeOutputs, nodeStatus };
  } catch (err) {
    await eventBus.emitPipeline({
      pipelineRunId,
      dagId: dag.id,
      kind: 'pipeline_error',
      data: { message: err.message || String(err), nodeStatus },
    });
    throw err;
  } finally {
    activePipelines.delete(pipelineRunId);
  }
}

function cancelPipeline(pipelineRunId) {
  const entry = activePipelines.get(pipelineRunId);
  if (entry) entry.abortController.abort();
}

function resumePipeline(pipelineRunId, nodeId, payload) {
  const entry = activePipelines.get(pipelineRunId);
  if (!entry) throw new Error(`pipeline not active: ${pipelineRunId}`);
  const pending = entry.pendingHuman.get(nodeId);
  if (!pending) throw new Error(`no pending human node: ${nodeId}`);
  entry.pendingHuman.delete(nodeId);
  pending.resolve(payload);
  return true;
}

function listActivePipelines() {
  return Array.from(activePipelines.entries()).map(([pipelineRunId, v]) => ({
    pipelineRunId,
    dagId: v.dagId,
    awaitingHumanNodes: Array.from(v.pendingHuman.keys()),
  }));
}

module.exports = {
  runPipeline,
  cancelPipeline,
  resumePipeline,
  listActivePipelines,
  _testBuildInputForNode: buildInputForNode,
  _testEvaluateGate: evaluateGate,
};
