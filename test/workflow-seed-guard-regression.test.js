'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runWorkflowSeedGuardRegressionTest() {
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

  const subagentsStore = require(path.join(ROOT, 'src/main/store/subagents'));
  const dagsStore = require(path.join(ROOT, 'src/main/store/dags'));
  const registry = require(path.join(ROOT, 'src/main/runtime/drivers/registry'));

  const originalEnsureBuiltinSubagents = subagentsStore.ensureBuiltinSeeds;
  const originalEnsureBuiltinDags = dagsStore.ensureBuiltinSeeds;
  const originalRegistryGet = registry.get;
  const originalRegistryGetActive = registry.getActive;

  let ensuredSubagents = 0;
  let ensuredDags = 0;

  try {
    subagentsStore.ensureBuiltinSeeds = async () => { ensuredSubagents += 1; };
    dagsStore.ensureBuiltinSeeds = async () => { ensuredDags += 1; };

    const fakeDriver = {
      id: 'fake-driver',
      async prepare(spec) {
        return { driverId: 'fake-driver', runId: spec.runId, resources: { spec } };
      },
      async run(handle) {
        return { output: 'ok', runId: handle.runId || 'run-seed-check' };
      },
      async dispose() {},
    };
    registry.get = () => fakeDriver;
    registry.getActive = async () => fakeDriver;

    const workflowOrchestratorPath = path.join(ROOT, 'src/main/runtime/workflowOrchestrator');
    delete require.cache[require.resolve(workflowOrchestratorPath)];
    const workflowOrchestrator = require(workflowOrchestratorPath);

    await workflowOrchestrator.runWorkflow({ mode: 'subagent', subagentId: 'sa-lore-updater', input: '检查 seeds' });
    assert.ok(ensuredSubagents >= 1);
    assert.equal(ensuredDags, 0);
    pass('WSG1_subagent_workflows_ensure_builtin_subagents', 'workflowOrchestrator now ensures builtin subagents before subagent execution');

    ensuredSubagents = 0;
    ensuredDags = 0;
    delete require.cache[require.resolve(workflowOrchestratorPath)];
    const workflowOrchestrator2 = require(workflowOrchestratorPath);
    registry.get = () => fakeDriver;
    registry.getActive = async () => fakeDriver;

    await workflowOrchestrator2.runWorkflow({ mode: 'pipeline', dag: { id: 'dag-x', nodes: [] }, input: '检查 DAG seeds' });
    assert.ok(ensuredSubagents >= 1);
    assert.ok(ensuredDags >= 1);
    pass('WSG2_pipeline_workflows_ensure_builtin_dags', 'pipeline execution now ensures both builtin subagents and dags before runtime dispatch');
  } catch (err) {
    fail('WSG_harness', err?.stack || String(err));
  } finally {
    subagentsStore.ensureBuiltinSeeds = originalEnsureBuiltinSubagents;
    dagsStore.ensureBuiltinSeeds = originalEnsureBuiltinDags;
    registry.get = originalRegistryGet;
    registry.getActive = originalRegistryGetActive;
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runWorkflowSeedGuardRegressionTest };

if (require.main === module) {
  runWorkflowSeedGuardRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}