'use strict';

/**
 * REAL AI API call test.
 * Sends "查看碧蓝牧场5的角色卡" to the configured provider and checks
 * if the AI correctly returns a tool_use for list_characters.
 *
 * This makes a REAL API call using the user's configured key (deepseek).
 * Estimated cost: < $0.01 for one message.
 */

const path = require('node:path');
const fs = require('node:fs');

const USER_DATA = path.join(
  process.env.HOME || '',
  'Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant'
);

function loadProvider() {
  const providers = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'providers.json'), 'utf8'));
  const aliases = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'modelAliases.json'), 'utf8'));

  const activeProvider = providers.providers.find(p => p.id === providers.activeProviderId);
  const sonnetAlias = aliases.aliases.find(a => a.id === 'sonnet');

  return {
    baseUrl: activeProvider.baseUrl || 'https://api.anthropic.com',
    apiKey: activeProvider.apiKey,
    model: sonnetAlias?.modelId || activeProvider.models?.[0]?.id || 'deepseek-v4-pro',
    providerName: activeProvider.name,
  };
}

async function main() {
  console.log('==========================================');
  console.log(' REAL AI Chat Flow API Test');
  console.log('==========================================\n');

  // Load provider config
  console.log('[1] Load provider');
  let provider;
  try {
    provider = loadProvider();
    console.log(`    Provider: ${provider.providerName}`);
    console.log(`    Model:    ${provider.model}`);
    console.log(`    Base URL: ${provider.baseUrl}`);
    console.log(`    API Key:  ${provider.apiKey ? provider.apiKey.slice(0, 8) + '...' : 'MISSING!'}`);
    if (!provider.apiKey) throw new Error('API key is empty');
    console.log('  ✅ Provider config loaded\n');
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
    process.exit(1);
  }

  // Build the same system prompt the chat agent would use
  console.log('[2] Build system prompt + tools');

  const system = [
    'You are the interactive writing assistant for Multi-Agent Novel Assistant.',
    '',
    '## Current Editor State',
    '- Novel ID: novel-motm5gm5-d05gmt',
    '',
    '## Available Tools',
    'You can call tools to read/write novel data and manipulate the editor:',
    '- Character tools: list_characters, read_character (read character cards), enrich_character (web enrichment for fanwork characters)',
    '',
    '## Rules',
    '1. Always use tools to inspect state before making changes.',
    '2. When the user asks about characters, first call `list_characters` to get an overview, then call `read_character` for details on a specific character.',
    '3. Respond in the same language as the user.',
  ].join('\n');

  const tools = [
    {
      name: 'list_characters',
      description: 'List all character cards in the current novel (summary of id/name/aliases/role/faction).',
      input_schema: { type: 'object', properties: {}, },
    },
    {
      name: 'read_character',
      description: 'Read a character card by ID.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Character ID' } },
        required: ['id'],
      },
    },
  ];

  console.log('  ✅ System prompt + 2 tools ready\n');

  // Make the API call
  console.log('[3] Send message: "查看碧蓝牧场5的角色卡"');

  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`;
  const body = {
    model: provider.model,
    max_tokens: 1024,
    system,
    messages: [
      { role: 'user', content: '查看碧蓝牧场5的角色卡' },
    ],
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    stream: false,
  };

  console.log(`    POST ${url}`);

  const start = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`  ❌ Network error: ${e.message}`);
    process.exit(1);
  }

  const elapsed = Date.now() - start;
  console.log(`    Status: ${res.status} (${elapsed}ms)`);

  const responseText = await res.text();

  if (!res.ok) {
    console.log(`  ❌ API error ${res.status}: ${responseText.slice(0, 300)}`);
    process.exit(1);
  }

  // Parse response
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    console.log(`  ❌ Parse error: ${e.message}`);
    console.log(`    Raw: ${responseText.slice(0, 500)}`);
    process.exit(1);
  }

  console.log(`    Stop reason: ${data.stop_reason || data.stopReason || 'unknown'}`);
  console.log(`    Content blocks: ${data.content?.length || 0}`);

  // Check response
  if (data.content && data.content.length > 0) {
    for (const block of data.content) {
      if (block.type === 'text') {
        console.log(`\n  📝 Text response (${block.text.length} chars):`);
        console.log(`    "${block.text.slice(0, 200)}${block.text.length > 200 ? '...' : ''}"`);
      } else if (block.type === 'tool_use') {
        console.log(`\n  🔧 Tool use: ${block.name}`);
        console.log(`    Input: ${JSON.stringify(block.input)}`);
      }
    }
  }

  // Determine pass/fail
  const hasToolUse = data.content?.some(b => b.type === 'tool_use');
  const hasText = data.content?.some(b => b.type === 'text');

  console.log('\n---');
  if (hasToolUse) {
    console.log('  ✅ AI correctly returned tool_use — tool calling works!');
  } else if (hasText) {
    console.log('  ⚠️  AI returned text only (no tool_use). Tool calling may not work with this provider.');
    console.log(`     Response: "${(data.content?.find(b => b.type === 'text')?.text || '').slice(0, 300)}"`);
  } else if (data.content?.length === 0) {
    console.log('  ❌ Empty response content');
    process.exit(1);
  } else {
    console.log('  ❌ Unexpected response format');
    console.log(`     ${JSON.stringify(data).slice(0, 500)}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
