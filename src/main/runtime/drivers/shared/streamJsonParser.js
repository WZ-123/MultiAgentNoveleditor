'use strict';

/**
 * streamJsonParser — normalize Claude Code's `--output-format stream-json
 * --verbose` NDJSON into our internal AgentEvent shape.
 *
 * Why a stateful factory (not a pure function): stream-json reports
 * `tool_use` and matching `tool_result` as separate events. To translate a
 * Task/sub-agent flow into one `sub_agent_start` and one `sub_agent_done`,
 * we have to remember which `tool_use_id`s came from a `Task` call and pair
 * them with their `tool_result`. Same logic for cost accumulation.
 *
 * Reference event sequence (typical happy path):
 *
 *   {"type":"system","subtype":"init", ...}                                 // ignore
 *   {"type":"assistant","message":{"content":[{"type":"text", "text":"…"}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use",
 *     "id":"toolu_AAA","name":"Task","input":{"subagent_type":"x", ...}}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use",
 *     "id":"toolu_BBB","name":"mcp__novel-tools__query_timeline",
 *     "parent_tool_use_id":"toolu_AAA", "input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",
 *     "tool_use_id":"toolu_BBB","content":"..."}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",
 *     "tool_use_id":"toolu_AAA","content":"..."}]}}
 *   {"type":"result","subtype":"success","cost_usd":0.02,"duration_ms":1234,
 *     "num_turns":6,"is_error":false}
 *
 * Known quirks (handled defensively):
 *   - claude-code#1920: the trailing `result` event is sometimes lost. Caller
 *     must invoke `finish(exitCode)` on stdout EOF; we synthesize a `done`
 *     event when that happens.
 *   - --include-partial-messages emits `stream_event` envelopes around
 *     content_block_delta. We pass through `text_delta` deltas as `text`
 *     events but otherwise ignore the partial scaffolding.
 *   - `parent_tool_use_id` may live on the assistant message envelope itself
 *     OR on the inner content block. We check both.
 */

// Claude Code v1.x called the sub-agent dispatch tool `Task`; v2.x (>=2.1)
// renamed it to `Agent`. Accept both so we work across versions.
const TASK_TOOL_NAMES = new Set(['Task', 'Agent']);
// Keep TASK_TOOL_NAME exported for back-compat (tests reference it as the
// canonical name); resolve to whatever the current Claude Code build emits.
const TASK_TOOL_NAME = 'Agent';

/**
 * Create a parser bound to a single Claude Code run.
 *
 * @param {object} ctx
 * @param {string} ctx.runId
 * @param {string=} ctx.pipelineRunId
 * @param {string=} ctx.nodeId         If the run is one node of a DAG.
 * @param {object=} ctx.logger         Optional `{warn(msg, data)}`.
 * @returns {{
 *   parseLine: (line: string) => object[],
 *   finish:    (exitCode?: number) => object[],
 *   getStats:  () => { costUsd: number, durationMs: number, turns: number, sawResult: boolean }
 * }}
 */
function createStreamParser(ctx = {}) {
  const runId = ctx.runId;
  const pipelineRunId = ctx.pipelineRunId || null;
  const nodeId = ctx.nodeId || null;
  const log = ctx.logger || { warn: () => {} };

  // tool_use_id  →  { name, subagentId?, parentToolUseId?, isTask, startedAt }
  const toolUses = new Map();

  // Cumulative stats (for emitting kind='cost' or filling final 'done' fallback).
  let costUsd = 0;
  let durationMs = 0;
  let turns = 0;
  let sawResult = false;

  // ---------- helpers ----------
  const ev = (kind, data, extra = {}) => ({
    runId,
    pipelineRunId,
    nodeId,
    kind,
    data: data || {},
    ...extra,
  });

  function recordTask(toolUseId, input, name) {
    const subagentType = input?.subagent_type || null;
    toolUses.set(toolUseId, {
      name: name || TASK_TOOL_NAME,
      subagentId: subagentType,
      isTask: true,
      startedAt: Date.now(),
    });
  }

  function recordTool(toolUseId, name, parentToolUseId) {
    toolUses.set(toolUseId, {
      name,
      parentToolUseId: parentToolUseId || null,
      isTask: false,
      startedAt: Date.now(),
    });
  }

  // ---------- assistant content handlers ----------
  function handleAssistantContent(block, msgParentToolUseId) {
    const out = [];
    if (!block || typeof block !== 'object') return out;

    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (!text) break;
        out.push(ev('text', {
          text,
          parentToolUseId: msgParentToolUseId || null,
        }));
        break;
      }
      case 'tool_use': {
        const id = block.id;
        const name = block.name;
        const parent = block.parent_tool_use_id || msgParentToolUseId || null;
        if (!id || !name) {
          log.warn('[streamJsonParser] tool_use missing id/name', block);
          break;
        }
        if (TASK_TOOL_NAMES.has(name)) {
          recordTask(id, block.input || {}, name);
          out.push(ev('sub_agent_start', {
            toolUseId: id,
            subagentId: block.input?.subagent_type || null,
            input: block.input || {},
          }, { subagentId: block.input?.subagent_type || null }));
        } else {
          recordTool(id, name, parent);
          out.push(ev('tool_use', {
            toolUseId: id,
            name,
            arguments: block.input || {},
            parentToolUseId: parent,
          }, parent ? { parentToolUseId: parent } : {}));
        }
        break;
      }
      // Some Claude Code versions stream "thinking" blocks; emit as text-like
      // events so the UI can show them dimmed if desired.
      case 'thinking': {
        const text = typeof block.thinking === 'string' ? block.thinking : '';
        if (text) out.push(ev('text', { text, thinking: true, parentToolUseId: msgParentToolUseId || null }));
        break;
      }
      default:
        // Unknown content type — surface as warn but don't break the stream.
        log.warn('[streamJsonParser] unknown assistant content type', block.type);
    }
    return out;
  }

  function handleUserContent(block) {
    const out = [];
    if (!block || typeof block !== 'object') return out;
    if (block.type !== 'tool_result') return out;
    const tid = block.tool_use_id;
    if (!tid) return out;

    // Coerce content (string | array of {type:'text'|'image', ...}) to a string.
    let text = '';
    if (typeof block.content === 'string') text = block.content;
    else if (Array.isArray(block.content)) {
      text = block.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
    }

    const recorded = toolUses.get(tid);
    if (recorded?.isTask) {
      out.push(ev('sub_agent_done', {
        toolUseId: tid,
        subagentId: recorded.subagentId,
        output: text,
        isError: !!block.is_error,
      }, { subagentId: recorded.subagentId }));
      toolUses.delete(tid);
    } else {
      const parent = recorded?.parentToolUseId || null;
      out.push(ev('tool_result', {
        toolUseId: tid,
        name: recorded?.name || null,
        output: text,
        isError: !!block.is_error,
        parentToolUseId: parent,
      }, parent ? { parentToolUseId: parent } : {}));
      if (recorded) toolUses.delete(tid);
    }
    return out;
  }

  // ---------- top-level dispatcher ----------
  function dispatch(obj) {
    const out = [];
    if (!obj || typeof obj !== 'object' || !obj.type) return out;

    switch (obj.type) {
      case 'system':
        // 'init' carries cwd/tools manifest. Useful for debugging but no
        // user-visible event needed.
        return out;

      case 'assistant': {
        const msg = obj.message || obj;
        const msgParent = obj.parent_tool_use_id || msg.parent_tool_use_id || null;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          out.push(...handleAssistantContent(block, msgParent));
        }
        return out;
      }

      case 'user': {
        const msg = obj.message || obj;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          out.push(...handleUserContent(block));
        }
        return out;
      }

      case 'result': {
        sawResult = true;
        if (typeof obj.cost_usd === 'number') costUsd = obj.cost_usd;
        if (typeof obj.duration_ms === 'number') durationMs = obj.duration_ms;
        if (typeof obj.num_turns === 'number') turns = obj.num_turns;
        if (obj.is_error || obj.subtype === 'error') {
          out.push(ev('error', {
            message: obj.error || obj.message || 'Claude Code reported error',
            subtype: obj.subtype || null,
          }));
        } else {
          out.push(ev('cost', { costUsd, durationMs, turns }));
          out.push(ev('done', {
            costUsd,
            durationMs,
            turns,
            output: obj.result || obj.output || null,
          }));
        }
        return out;
      }

      // --include-partial-messages envelope.
      case 'stream_event': {
        const inner = obj.event;
        if (!inner || typeof inner !== 'object') return out;
        // Forward text deltas as small 'text' events with delta:true so the
        // UI can append in place. Other partial frames (message_start,
        // content_block_start, message_delta, message_stop) are scaffolding —
        // ignore.
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          const t = inner.delta.text || '';
          if (t) out.push(ev('text', {
            text: t,
            delta: true,
            parentToolUseId: obj.parent_tool_use_id || null,
          }));
        }
        return out;
      }

      default:
        log.warn('[streamJsonParser] unknown top-level type', obj.type);
        return out;
    }
  }

  // ---------- public ----------
  function parseLine(line) {
    if (!line) return [];
    const trimmed = line.trim();
    if (!trimmed) return [];
    let obj;
    try { obj = JSON.parse(trimmed); }
    catch (err) {
      log.warn('[streamJsonParser] bad JSON line', { line: trimmed.slice(0, 200), err: err.message });
      return [];
    }
    return dispatch(obj);
  }

  function finish(exitCode) {
    if (sawResult) return [];
    // Synthesize a closing event so consumers don't hang. Treat non-zero
    // exit (and unknown -> assume failure if no stats accrued) as error.
    const isError = exitCode != null && exitCode !== 0;
    if (isError) {
      return [ev('error', {
        message: `Claude Code exited with code ${exitCode} (no result event received)`,
        synthesized: true,
      })];
    }
    return [ev('done', {
      costUsd, durationMs, turns,
      synthesized: true,
    })];
  }

  function getStats() {
    return { costUsd, durationMs, turns, sawResult };
  }

  return { parseLine, finish, getStats };
}

/**
 * Convenience: Splits a buffered chunk into complete NDJSON lines plus a
 * trailing remainder (for streaming reads where the chunk boundary may
 * land mid-line).
 *
 * Returns { lines, rest }.
 */
function splitNdjson(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer.charCodeAt(i) === 10 /* \n */) {
      lines.push(buffer.slice(start, i));
      start = i + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

module.exports = {
  TASK_TOOL_NAME,
  TASK_TOOL_NAMES,
  createStreamParser,
  splitNdjson,
};
