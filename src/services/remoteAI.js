/**
 * OpenAI 兼容 Chat Completions：POST {baseUrl}/chat/completions
 * 支持各厂商在「统一 baseUrl + /chat/completions」下的兼容实现。
 */

import { getAgentConfig } from '@/services/agentApiConfig.js';

/**
 * @param {string} baseUrl
 */
function chatCompletionsUrl(baseUrl) {
  const b = baseUrl.replace(/\/$/, '');
  return `${b}/chat/completions`;
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} model
 * @param {object} body
 */
async function postChatCompletions(baseUrl, apiKey, model, body) {
  const url = chatCompletionsUrl(baseUrl);
  const payload = { model, ...body };
  const bodyStr = JSON.stringify(payload);
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (typeof window !== 'undefined' && window.mana?.chatCompletions) {
    return window.mana.chatCompletions({
      url,
      headers,
      body: bodyStr,
    });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: bodyStr,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Chat Completions ${res.status}: ${t}`);
  }
  return res.json();
}

/**
 * @param {unknown} data
 */
function extractText(data) {
  const c = data?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

/**
 * @typedef {Object} RemoteAIClient
 * @property {(agentId: string, messages: {role: string, content: string}[], options?: { expectJson?: boolean }) => Promise<string>} completeForAgent
 */

/**
 * @returns {RemoteAIClient}
 */
export function createRemoteAIClient() {
  return {
    /**
     * @param {string} agentId
     * @param {{role: string, content: string}[]} messages
     * @param {{ expectJson?: boolean }} [options]
     */
    async completeForAgent(agentId, messages, options = {}) {
      const cfg = getAgentConfig(agentId);
      if (cfg.useMock || !cfg.apiKey?.trim()) {
        return mockComplete(agentId, messages, options);
      }
      const body = {
        messages,
        ...(options.expectJson
          ? { response_format: { type: 'json_object' } }
          : {}),
      };
      const data = await postChatCompletions(
        cfg.baseUrl,
        cfg.apiKey.trim(),
        cfg.model,
        body
      );
      return extractText(data);
    },
  };
}

/**
 * @param {string} agentId
 * @param {{role: string, content: string}[]} messages
 * @param {{ expectJson?: boolean }} options
 */
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
    case 'agent4':
      return JSON.stringify({
        annotations: [
          {
            paragraphId: 'p-0',
            start: 0,
            end: 8,
            reason: '（mock）文风标注示例',
          },
        ],
      });
    case 'agent5':
      return JSON.stringify({
        annotations: [
          {
            paragraphId: 'p-0',
            kind: 'choppy',
            note: '（mock）质量标注示例',
          },
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
