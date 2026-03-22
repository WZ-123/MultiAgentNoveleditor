/**
 * 主流服务商的 OpenAI 兼容 Chat Completions 端点预设。
 * baseUrl 为「不含 /chat/completions」的前缀；拼接规则见 remoteAI.js。
 */

/** @typedef {Object} ProviderPreset
 * @property {string} id
 * @property {string} label
 * @property {string} baseUrl
 * @property {string} defaultModel
 * @property {string} [docsUrl]
 */

/** @type {ProviderPreset[]} */
export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat/create',
  },
  {
    id: 'gemini',
    label: 'Google Gemini（OpenAI 兼容）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    docsUrl:
      'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    docsUrl: 'https://docs.x.ai/docs/guides/chat-completions',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    docsUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'model-name',
  },
];

/**
 * @param {string} id
 * @returns {ProviderPreset | undefined}
 */
export function getPresetById(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
