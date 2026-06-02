'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function runWritingFlowOptimizationRegressionTest() {
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

  try {
    const { BUILTIN_DAGS, SCHEMA_VERSION } = require(path.join(ROOT, 'src/main/seeds/builtinDags'));
    assert.equal(SCHEMA_VERSION, 2);

    for (const dag of BUILTIN_DAGS) {
      const nodeIds = new Set(dag.nodes.map((node) => node.id));
      for (const edge of dag.edges) {
        assert.ok(nodeIds.has(edge.from), `${dag.id} dangling edge.from ${edge.from}`);
        assert.ok(nodeIds.has(edge.to), `${dag.id} dangling edge.to ${edge.to}`);
      }
      for (const node of dag.nodes) {
        if (node.kind === 'parallel') {
          for (const childId of node.children || []) {
            assert.ok(nodeIds.has(childId), `${dag.id} dangling parallel child ${childId}`);
          }
        }
      }
    }
    pass('WFO1_builtin_dags_have_no_dangling_writing_edges', 'updated writing DAG seeds are internally consistent');

    const qualityWriting = BUILTIN_DAGS.find((dag) => dag.id === 'dag-quality-writing');
    assert.ok(qualityWriting.nodes.some((node) => node.subagentId === 'sa-character-reviewer'));
    assert.ok(qualityWriting.nodes.some((node) => node.subagentId === 'sa-timeline-guardian'));
    assert.ok(qualityWriting.nodes.some((node) => node.kind === 'gate' && node.expr === 'no_issues'));
    assert.ok(qualityWriting.edges.some((edge) => edge.from === 'n_gate' && edge.to === 'n_revise' && edge.when === 'block'));
    pass('WFO2_quality_writing_gates_hard_reviews', 'quality writing now routes character/timeline findings into a revision loop');

    const { _testEvaluateGate, _testBuildInputForNode } = require(path.join(ROOT, 'src/main/runtime/runPipeline'));
    const gateDag = {
      nodes: [{ id: 'n_gate', kind: 'gate', expr: 'no_issues' }, { id: 'n_revise', kind: 'subagent' }],
      edges: [{ from: 'n_review', to: 'n_gate' }, { from: 'n_gate', to: 'n_revise', when: 'block' }],
    };
    const decision = _testEvaluateGate(gateDag, gateDag.nodes[0], {
      n_review: JSON.stringify({ annotations: [{ paragraphId: 'p1', note: '跨段逻辑错误' }] }),
    });
    assert.equal(decision, 'block');
    pass('WFO3_gate_blocks_annotation_reviews', 'gate treats paragraph annotations as blocking review findings');

    const reviseInput = _testBuildInputForNode(
      gateDag,
      'n_revise',
      {
        n_writer: '{"text":"原草稿"}',
        n_review: '{"annotations":[{"note":"时空错误"}]}',
        n_gate: { decision: 'block', revisions: 1, upstream: { n_review: '{"annotations":[{"note":"时空错误"}]}' }, context: { n_writer: '{"text":"原草稿"}' } },
      },
      '用户需求',
    );
    assert.ok(reviseInput.includes('原草稿'));
    assert.ok(reviseInput.includes('时空错误'));
    pass('WFO4_revision_node_receives_draft_and_review_context', 'gate output carries enough context for actual revision');

    const { _testBuildIssueRevisionInput } = require(path.join(ROOT, 'src/main/runtime/chapterDraftService'));
    const issueRevisionInput = _testBuildIssueRevisionInput({
      mode: 'draft',
      userText: '写下一章',
      revisionIndex: 1,
      draft: { name: 'chapter-003.md', displayName: '第三章', text: '角色瞬移到了远方。' },
      issues: [{ sourceAgent: 'timeline', summary: '移动距离不合理', detail: '一小时内无法跨城。' }],
    });
    assert.ok(issueRevisionInput.includes('只针对上述人设/逻辑/时空硬伤做必要修订'));
    assert.ok(issueRevisionInput.includes('移动距离不合理'));
    pass('WFO5_chat_draft_revision_is_targeted', 'chat writing service builds targeted review-fix prompts');
  } catch (err) {
    fail('WFO_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runWritingFlowOptimizationRegressionTest };

if (require.main === module) {
  runWritingFlowOptimizationRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
