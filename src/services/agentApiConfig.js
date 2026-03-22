import { getPresetById } from '@/services/aiProviders.js';

const STORAGE_KEY = 'mana-agent-api-config-v2';

/** 可调用的逻辑角色：6 个 Agent + 章节主撰写 + 可选全局回退 */
export const AGENT_ENDPOINT_KEYS = [
  'agent1',
  'agent2',
  'agent3',
  'agent4',
  'agent5',
  'agent6',
  'chapter_draft',
];

/** UI 展示用 */
export const AGENT_ENDPOINT_LABELS = {
  agent1: 'Agent1 · 剧情丰满',
  agent2: 'Agent2 · 人设/世界观审查',
  agent3: 'Agent3 · 时空与信息传播',
  agent4: 'Agent4 · 文风一致性',
  agent5: 'Agent5 · 流畅度 / Peek 重写 / 批量重写',
  agent6: 'Agent6 · 本章总结与设定回写',
  chapter_draft: '章节主撰写 · 远程初稿生成',
};

/**
 * @typedef {Object} AgentEndpointConfig
 * @property {string} providerId
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {boolean} useMock
 */

/**
 * @returns {Record<string, AgentEndpointConfig>}
 */
function defaultAll() {
  /** @type {Record<string, AgentEndpointConfig>} */
  const o = {};
  const preset = getPresetById('openai');
  const base = preset?.baseUrl ?? 'https://api.openai.com/v1';
  const model = preset?.defaultModel ?? 'gpt-4o-mini';
  for (const key of AGENT_ENDPOINT_KEYS) {
    o[key] = {
      providerId: 'openai',
      baseUrl: base,
      apiKey: '',
      model: model,
      useMock: true,
    };
  }
  return o;
}

/**
 * @returns {Record<string, AgentEndpointConfig>}
 */
export function loadAgentApiConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAll();
    const parsed = JSON.parse(raw);
    const base = defaultAll();
    for (const key of AGENT_ENDPOINT_KEYS) {
      if (parsed[key] && typeof parsed[key] === 'object') {
        base[key] = { ...base[key], ...parsed[key] };
      }
    }
    return base;
  } catch {
    return defaultAll();
  }
}

/**
 * @param {Record<string, AgentEndpointConfig>} config
 */
export function saveAgentApiConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * 应用服务商预设到某一 Agent（不覆盖 apiKey，除非传 fillKey）
 * @param {AgentEndpointConfig} current
 * @param {string} providerId
 * @param {{ fillApiKey?: string }} [opt]
 * @returns {AgentEndpointConfig}
 */
export function applyPresetToAgent(current, providerId, opt = {}) {
  const preset = getPresetById(providerId);
  if (!preset) return { ...current, providerId };
  const next = {
    ...current,
    providerId,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
  };
  if (opt.fillApiKey !== undefined) next.apiKey = opt.fillApiKey;
  return next;
}

/**
 * @param {string} agentId
 * @returns {AgentEndpointConfig}
 */
export function getAgentConfig(agentId) {
  const all = loadAgentApiConfig();
  return all[agentId] ?? defaultAll()[agentId];
}
