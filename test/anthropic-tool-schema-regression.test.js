'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function collectSchemaIssues(value, currentPath, issues) {
  if (value === null) {
    issues.push({ kind: 'null', path: currentPath || '<root>' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSchemaIssues(item, `${currentPath}[${index}]`, issues));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'array' && !Object.prototype.hasOwnProperty.call(value, 'items')) {
    issues.push({ kind: 'array-without-items', path: currentPath || '<root>' });
  }
  for (const [key, child] of Object.entries(value)) {
    collectSchemaIssues(child, currentPath ? `${currentPath}.${key}` : key, issues);
  }
}

async function runAnthropicToolSchemaRegression() {
  const ROOT = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0 };

  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }

  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  process.env.MANA_USE_STDIO_MCP = '0';
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
  const anthropicProvider = require(path.join(ROOT, 'src/main/runtime/providers/anthropic'));

  try {
    const tools = await mcpClient.listTools();
    const issues = [];
    for (const tool of tools || []) {
      const toolIssues = [];
      collectSchemaIssues(tool.inputSchema, '', toolIssues);
      if (toolIssues.length) {
        issues.push({ name: tool.name, toolIssues });
      }
    }
    assert.equal(issues.length, 0);
    pass('ATS1_mcp_tool_schemas_are_anthropic_safe', `checked ${(tools || []).length} tools`);
  } catch (err) {
    fail('ATS1_mcp_tool_schemas_are_anthropic_safe', err?.message || String(err));
  }

  const originalFetch = global.fetch;
  try {
    let capturedBody = null;
    global.fetch = async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { stop_reason: 'end_turn', content: [] };
        },
      };
    };

    await anthropicProvider.sendMessage({
      system: 'schema regression test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [
        {
          name: 'list_characters',
          description: 'test tool',
          input_schema: {
            type: 'object',
            properties: {},
            additionalProperties: null,
          },
        },
        {
          name: 'confirm_outline',
          description: 'test tool',
          input_schema: {
            type: 'object',
            properties: {
              nodes: { type: 'array' },
            },
          },
        },
      ],
      tier: {
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        model: 'test-model',
        extra: { streaming: false, maxTokens: 64 },
      },
    });

    const sentTools = capturedBody?.tools || [];
    const sentIssues = [];
    sentTools.forEach((tool) => collectSchemaIssues(tool.input_schema, '', sentIssues));
    assert.equal(sentIssues.length, 0);
    assert.deepEqual(sentTools[1]?.input_schema?.properties?.nodes?.items, {});
    assert.equal(Object.prototype.hasOwnProperty.call(sentTools[0]?.input_schema || {}, 'additionalProperties'), false);
    pass('ATS2_anthropic_provider_sanitizes_tool_schemas', 'null fields were removed and array items were filled before request dispatch');
  } catch (err) {
    fail('ATS2_anthropic_provider_sanitizes_tool_schemas', err?.message || String(err));
  } finally {
    global.fetch = originalFetch;
    try {
      await mcpClient.dispose();
    } catch {
      // ignore
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runAnthropicToolSchemaRegression };

if (require.main === module) {
  runAnthropicToolSchemaRegression().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}