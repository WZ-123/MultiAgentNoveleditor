import { createId } from '@/domain/ids.js';
import { OUTLINE_PHASE, TIMELINE_ISSUE_KIND } from '@/domain/types.js';
import { AGENT1_SYSTEM, AGENT2_SYSTEM, AGENT3_SYSTEM } from '@/services/agentPrompts.js';
import { parseJsonFromModelText } from '@/services/llmJson.js';
import { createRemoteAIClient } from '@/services/remoteAI.js';

/**
 * @returns {import('@/domain/types.js').OutlineSessionState}
 */
export function createInitialOutlineState() {
  return {
    phase: OUTLINE_PHASE.IDLE,
    mode: 'plot_direction',
    userText: '',
    artifact: null,
    blockingIssues: [],
    lastError: null,
  };
}

/**
 * @param {import('@/domain/types.js').OutlineSessionState} state
 * @param {{ mode: import('@/domain/types.js').UserOutlineMode, userText: string }} input
 */
export function startOutlineInput(state, input) {
  return {
    ...state,
    phase: OUTLINE_PHASE.COLLECTING_INPUT,
    mode: input.mode,
    userText: input.userText,
    lastError: null,
  };
}

/**
 * Agent1 产出大纲，Agent2/Agent3 并行审查（真实模型）。
 * @param {import('@/domain/types.js').OutlineSessionState} state
 */
export async function runOutlinePipeline(state) {
  const client = createRemoteAIClient();
  const next = { ...state, phase: OUTLINE_PHASE.AGENT1, lastError: null };
  try {
    const json = await client.completeForAgent(
      'agent1',
      [
        { role: 'system', content: AGENT1_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            mode: state.mode,
            userText: state.userText,
          }),
        },
      ],
      { expectJson: true }
    );
    const parsed = parseJsonFromModelText(json);
    const artifact = {
      id: createId('outline'),
      nodes: parsed.nodes ?? [],
      rawMarkdown: parsed.rawMarkdown ?? JSON.stringify(parsed),
      version: 1,
    };

    const [from2, from3] = await Promise.all([
      runAgent2Issues(client, state, artifact),
      runAgent3Issues(client, state, artifact),
    ]);
    const issues = [...from2, ...from3];

    return {
      ...next,
      artifact,
      blockingIssues: issues,
      phase:
        issues.length > 0
          ? OUTLINE_PHASE.BLOCKING_REVIEW
          : OUTLINE_PHASE.CONFIRMED,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ...state, phase: OUTLINE_PHASE.IDLE, lastError: err };
  }
}

/**
 * @param {{ completeForAgent: Function }} client
 * @param {import('@/domain/types.js').OutlineSessionState} state
 * @param {import('@/domain/types.js').OutlineArtifact} artifact
 */
async function runAgent2Issues(client, state, artifact) {
  try {
    const raw = await client.completeForAgent(
      'agent2',
      [
        { role: 'system', content: AGENT2_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            mode: state.mode,
            userText: state.userText,
            outline: artifact,
          }),
        },
      ],
      { expectJson: true }
    );
    const data = parseJsonFromModelText(raw);
    const list = Array.isArray(data.issues) ? data.issues : [];
    return list
      .filter((i) => String(i.summary ?? '').trim())
      .map((i) => ({
        id: createId('issue'),
        sourceAgent: /** @type {'character_world'} */ ('character_world'),
        summary: String(i.summary),
        detail: i.detail != null ? String(i.detail) : undefined,
        affectedOutlineNodeIds: Array.isArray(i.affectedOutlineNodeIds)
          ? i.affectedOutlineNodeIds.map(String)
          : [],
      }));
  } catch {
    return [];
  }
}

/**
 * @param {{ completeForAgent: Function }} client
 * @param {import('@/domain/types.js').OutlineSessionState} state
 * @param {import('@/domain/types.js').OutlineArtifact} artifact
 */
async function runAgent3Issues(client, state, artifact) {
  try {
    const raw = await client.completeForAgent(
      'agent3',
      [
        { role: 'system', content: AGENT3_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            mode: state.mode,
            userText: state.userText,
            outline: artifact,
          }),
        },
      ],
      { expectJson: true }
    );
    const data = parseJsonFromModelText(raw);
    const list = Array.isArray(data.issues) ? data.issues : [];
    return list
      .filter((i) => String(i.summary ?? '').trim())
      .map((i) => {
        const tk =
          i.timelineKind === 'information'
            ? TIMELINE_ISSUE_KIND.INFORMATION
            : TIMELINE_ISSUE_KIND.MOBILITY;
        return {
          id: createId('issue'),
          sourceAgent: /** @type {'timeline'} */ ('timeline'),
          summary: String(i.summary),
          detail: i.detail != null ? String(i.detail) : undefined,
          timelineKind: tk,
          affectedOutlineNodeIds: Array.isArray(i.affectedOutlineNodeIds)
            ? i.affectedOutlineNodeIds.map(String)
            : [],
        };
      });
  } catch {
    return [];
  }
}

/**
 * Remove resolved issues; optionally mark outline confirmed when empty.
 * @param {import('@/domain/types.js').OutlineSessionState} state
 * @param {string[]} resolvedIssueIds
 */
export function dismissOutlineIssues(state, resolvedIssueIds) {
  const set = new Set(resolvedIssueIds);
  const blockingIssues = state.blockingIssues.filter((i) => !set.has(i.id));
  return {
    ...state,
    blockingIssues,
    phase:
      blockingIssues.length === 0
        ? OUTLINE_PHASE.CONFIRMED
        : OUTLINE_PHASE.BLOCKING_REVIEW,
  };
}

/**
 * @param {import('@/domain/types.js').OutlineSessionState} state
 */
export function confirmOutline(state) {
  if (!state.artifact) return state;
  return { ...state, phase: OUTLINE_PHASE.CONFIRMED };
}
