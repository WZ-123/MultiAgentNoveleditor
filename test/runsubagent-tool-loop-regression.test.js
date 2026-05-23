'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

async function runRunSubagentToolLoopRegressionTest() {
  const ROOT = path.resolve(__dirname, '..');
  const runSubagentPath = path.join(ROOT, 'src/main/runtime/runSubagent.js');
  const eventBusPath = path.join(ROOT, 'src/main/runtime/eventBus.js');
  const anthropicPath = path.join(ROOT, 'src/main/runtime/providers/anthropic.js');
  const openaiCompatPath = path.join(ROOT, 'src/main/runtime/providers/openaiCompat.js');
  const providerManagerPath = path.join(ROOT, 'src/main/providerManager/index.js');
  const modelAliasesPath = path.join(ROOT, 'src/main/modelAliases/index.js');
  const subagentsStorePath = path.join(ROOT, 'src/main/store/subagents.js');
  const skillsStorePath = path.join(ROOT, 'src/main/store/skills.js');

  const originals = new Map();
  const touched = [
    runSubagentPath,
    eventBusPath,
    anthropicPath,
    openaiCompatPath,
    providerManagerPath,
    modelAliasesPath,
    subagentsStorePath,
    skillsStorePath,
  ];
  for (const target of touched) originals.set(target, require.cache[target]);
  const originalUserDataRoot = process.env.MANA_USER_DATA_ROOT;

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

  try {
    process.env.MANA_USER_DATA_ROOT = path.join(os.tmpdir(), 'mana-runsubagent-tool-loop-regression');
    const emitted = [];
    let providerTurn = 0;
    let toolCalls = 0;

    require.cache[eventBusPath] = {
      id: eventBusPath,
      filename: eventBusPath,
      loaded: true,
      exports: {
        ensureRunId: (provided) => provided || 'run-regression',
        emit: async (payload) => {
          emitted.push(payload);
        },
      },
    };

    require.cache[anthropicPath] = {
      id: anthropicPath,
      filename: anthropicPath,
      loaded: true,
      exports: {
        sendMessage: async () => {
          providerTurn += 1;
          if (providerTurn === 1) {
            return {
              stopReason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: { query: '碧蓝航线 爱宕' } }],
            };
          }
          return {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: '搜索完成，任务继续执行。' }],
          };
        },
      },
    };

    require.cache[openaiCompatPath] = {
      id: openaiCompatPath,
      filename: openaiCompatPath,
      loaded: true,
      exports: require.cache[anthropicPath].exports,
    };

    require.cache[providerManagerPath] = {
      id: providerManagerPath,
      filename: providerManagerPath,
      loaded: true,
      exports: {
        getActiveProvider: async () => ({ apiKey: 'test-key', models: [{ id: 'stub-model' }] }),
        inferProviderType: () => 'anthropic',
      },
    };

    require.cache[modelAliasesPath] = {
      id: modelAliasesPath,
      filename: modelAliasesPath,
      loaded: true,
      exports: { getAlias: async () => null },
    };

    require.cache[subagentsStorePath] = {
      id: subagentsStorePath,
      filename: subagentsStorePath,
      loaded: true,
      exports: {
        ensureBuiltinSeeds: async () => {},
        getSubagent: async () => ({
          id: 'sa-test',
          displayName: 'Test Agent',
          systemPrompt: 'Test',
          tier: 'sonnet',
          runtimeHints: { maxTurns: 3 },
          allowedTools: ['WebSearch'],
        }),
      },
    };

    require.cache[skillsStorePath] = {
      id: skillsStorePath,
      filename: skillsStorePath,
      loaded: true,
      exports: {
        listSkills: async () => [],
        getSkill: async () => null,
      },
    };

    delete require.cache[runSubagentPath];
    const { runSubagent } = require(runSubagentPath);
    const result = await runSubagent({
      subagentId: 'sa-test',
      input: '请联网补全并继续任务',
      mcpClient: {
        listTools: async () => [{ name: 'WebSearch' }],
        callTool: async ({ name, arguments: args }) => {
          toolCalls += 1;
          return { isError: false, content: [{ type: 'text', text: `${name}:${args.query}` }] };
        },
      },
    });

    assert.equal(toolCalls, 1);
    assert.equal(providerTurn, 2);
    assert.equal(result.output, '搜索完成，任务继续执行。');
    assert.ok(emitted.some((payload) => payload.kind === 'tool_result'));
    pass('RSL1_tool_use_blocks_continue_even_without_tool_stop_reason', result.output);
  } catch (err) {
    fail('RSL_harness', err?.stack || String(err));
  } finally {
    if (originalUserDataRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = originalUserDataRoot;
    for (const target of touched) {
      if (originals.get(target)) require.cache[target] = originals.get(target);
      else delete require.cache[target];
    }
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runRunSubagentToolLoopRegressionTest };

if (require.main === module) {
  runRunSubagentToolLoopRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}