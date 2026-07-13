/**
 * Front-end remote AI client.
 *
 * All active application flows route through the unified runtime/model profile
 * resolver. Legacy localStorage is retained only for migration and for the
 * explicit offline mock mode.
 */

import { getAgentConfig } from '@/services/agentApiConfig.js';

/** Old agentId -> new builtin subagentId */
const LEGACY_AGENT_TO_SUBAGENT = {
  agent1: 'sa-outline-drafter',
  agent2: 'sa-character-reviewer',
  agent3: 'sa-timeline-guardian',
  agent4: 'sa-style-checker',
  agent5: 'sa-prose-quality',
  de_ai_rewrite: 'sa-de-ai-ifier',
  agent6: 'sa-lore-updater',
  chapter_draft: 'sa-writer',
};

const LEGACY_AGENT_TO_TIER = {
  agent1: 'opus',
  agent2: 'opus',
  agent3: 'opus',
  agent4: 'haiku',
  agent5: 'haiku',
  de_ai_rewrite: 'sonnet',
  agent6: 'opus',
  chapter_draft: 'sonnet',
};

function chatCompletionsUrl(baseUrl) {
  const b = baseUrl.replace(/\/$/, '');
  return `${b}/chat/completions`;
}

async function postChatCompletions(baseUrl, apiKey, model, body) {
  const url = chatCompletionsUrl(baseUrl);
  const payload = { model, ...body };
  const bodyStr = JSON.stringify(payload);
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (typeof window !== 'undefined' && window.mana?.chatCompletions) {
    return window.mana.chatCompletions({ url, headers, body: bodyStr });
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyStr,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Chat Completions ${res.status}: ${t}`);
  }
  return res.json();
}

function extractText(data) {
  const c = data?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

export function invalidateActivePresetCache() {
  // Kept for source compatibility. Unified model config is revision-aware and
  // does not use a renderer-side preset cache.
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      const c = messages[i].content;
      return typeof c === 'string' ? c : JSON.stringify(c);
    }
  }
  return '';
}

async function tryRuntimeRoute(agentId, messages, options) {
  if (typeof window === 'undefined' || !window.mana?.runtime) return null;
  const tier = LEGACY_AGENT_TO_TIER[agentId];
  const subagentId = LEGACY_AGENT_TO_SUBAGENT[agentId];
  if (!subagentId) return null;
  const userText = lastUserContent(messages);
  try {
    const result = await window.mana.runtime.runSubagent({
      subagentId,
      input: userText,
      tierOverride: tier,
      userLang: 'zh-CN',
    });
    return typeof result?.output === 'string' ? result.output : '';
  } catch (err) {
    console.error('[remoteAI] unified runtime failed', err);
    throw err;
  }
}

async function offlineMockEnabled() {
  try {
    const cfg = await window.mana?.config?.getApp?.();
    return cfg?.modelRuntime?.offlineMockEnabled === true;
  } catch {
    return false;
  }
}

export function createRemoteAIClient() {
  return {
    /**
     * @param {string} agentId
     * @param {{role: string, content: string}[]} messages
     * @param {{ expectJson?: boolean }} [options]
     */
    async completeForAgent(agentId, messages, options = {}) {
      if (await offlineMockEnabled()) return mockComplete(agentId, messages, options);
      const runtimeAnswer = await tryRuntimeRoute(agentId, messages, options);
      if (runtimeAnswer != null) return runtimeAnswer;

      const cfg = getAgentConfig(agentId);
      if (!cfg.apiKey?.trim()) {
        return mockComplete(agentId, messages, options);
      }
      const body = {
        messages,
        ...(options.expectJson ? { response_format: { type: 'json_object' } } : {}),
      };
      const data = await postChatCompletions(cfg.baseUrl, cfg.apiKey.trim(), cfg.model, body);
      return extractText(data);
    },
  };
}

async function mockComplete(agentId, messages, options) {
  await new Promise((r) => setTimeout(r, 120));
  if (!options.expectJson) {
    return 'mock plain text completion';
  }

  switch (agentId) {
    case 'agent1':
      return JSON.stringify({
        nodes: [
          { id: 'n1', title: '序章：风起', summary: '建立冲突与人物动机（mock）' },
          { id: 'n2', title: '中段：交锋', summary: '势力博弈升级（mock）' },
        ],
        rawMarkdown: '# Mock 大纲\n\n- 序章\n- 中段\n',
      });
    case 'agent2':
      return JSON.stringify({ issues: [] });
    case 'agent3':
      return JSON.stringify({ issues: [] });
    case 'chapter_draft':
      return JSON.stringify({
        text: '这是远程 mock 返回的正文。\n\n第二段用于测试 Agent4/5 标注。',
      });
    case 'de_ai_rewrite':
      return '她轻轻笑了一下。';
    case 'agent4':
      return JSON.stringify({
        annotations: [
          { paragraphId: 'p-0', start: 0, end: 8, reason: '（mock）文风标注示例' },
        ],
      });
    case 'agent5':
      return JSON.stringify({
        annotations: [
          { paragraphId: 'p-0', kind: 'choppy', note: '（mock）质量标注示例' },
        ],
      });
    case 'agent6':
      return JSON.stringify({
        summary: '（mock）本章摘要',
        supplementMarkdown: '- （mock）人物/势力/世界观补充条目',
      });
    default:
      return JSON.stringify({ ok: true, mock: true });
  }
}
