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

    const reviewDomain = require(path.join(ROOT, 'src/domain/chapterReview.cjs'));
    const unifiedIssues = reviewDomain.normalizeReviewIssues([
      { source: 'style', paragraphId: 'p-0', note: '文风偏离角色口吻。' },
      { sourceAgent: 'prose_quality', paragraphIds: ['p-1'], summary: 'AI 味套句。', excerpt: '不是……而是……' },
      { source: 'style', paragraphId: 'p-0', note: '文风偏离角色口吻。' },
    ], {
      paragraphs: [
        { id: 'p-0', index: 0, text: '第一段。' },
        { id: 'p-1', index: 1, text: '不是沉默，而是等待。' },
      ],
    });
    assert.equal(unifiedIssues.length, 2);
    assert.ok(unifiedIssues.every((issue) => issue.status === 'open'));
    assert.ok(reviewDomain.hasBlockingReviewIssues(unifiedIssues));
    assert.equal(unifiedIssues[0].severity, 'blocking');
    pass('WFO4b_unified_review_issue_schema_blocks_open_style_quality', 'shared issue schema normalizes and blocks style/prose findings');

    const {
      _testBuildIssueRevisionInput,
      _testBuildCompactWritingContext,
      _testBuildDraftInput,
      _testBuildReviewInput,
    } = require(path.join(ROOT, 'src/main/runtime/chapterDraftService'));
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

    const paragraphScopedRevisionInput = _testBuildIssueRevisionInput({
      mode: 'draft',
      userText: '写下一章',
      revisionIndex: 1,
      draft: {
        name: 'chapter-003.md',
        displayName: '第三章',
        text: '上一段铺垫。\n\n角色瞬移到了远方。\n\n下一段承接。',
      },
      issues: [{
        sourceAgent: 'timeline',
        summary: '移动距离不合理',
        detail: '一小时内无法跨城。',
        paragraphIds: ['p-1'],
      }],
    });
    assert.ok(paragraphScopedRevisionInput.includes('审查定位上下文'));
    assert.ok(paragraphScopedRevisionInput.includes('第2段：角色瞬移到了远方。'));
    assert.ok(paragraphScopedRevisionInput.includes('上一段：上一段铺垫。'));
    assert.ok(paragraphScopedRevisionInput.includes('下一段：下一段承接。'));
    assert.ok(paragraphScopedRevisionInput.includes('不要顺手重写无关段落'));
    pass('WFO5b_chat_draft_revision_includes_paragraph_context', 'review-fix prompts carry scoped paragraph context when reviewers provide paragraphIds');

    const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));
    const originalCallTool = mcpClient.callTool;
    const calls = [];
    try {
      mcpClient.callTool = async ({ name, arguments: args }) => {
        calls.push({ name, args });
        if (name === 'read_outline_nodes') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                nodes: [{
                  id: 'scene-auto-1',
                  title: '天台重逢',
                  summary: '楚岚与阿宁在天台重逢。',
                  characters: ['hero', 'ally'],
                  location: '天台',
                  setting: '夜晚',
                  pov: 'hero',
                  chapterIndex: 3,
                }],
              }),
            }],
          };
        }
        if (name === 'assemble_scene_context') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                nodeId: args.nodeId,
                title: '天台重逢',
                setting: '夜晚',
                location: '天台',
                pov: 'hero',
                characters: [{
                  id: 'hero',
                  name: '楚岚',
                  role: '主角',
                  personality: '克制，遇到阿宁时会短暂停顿。',
                  appearance: '黑发，深色外套。',
                }],
              }),
            }],
          };
        }
        if (name === 'query_timeline') {
          return { content: [{ type: 'text', text: JSON.stringify({ events: [] }) }] };
        }
        if (name === 'retrieve_context') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                query: args.query,
                resultCount: 1,
                items: [{ type: 'world_lore', sourceRef: 'world:lore:1', title: '天台规则', snippet: '天台暗号只能在夜晚使用。', score: 9 }],
                contextText: '# Retrieved Novel Context\n\n## 天台规则\n- sourceRef: world:lore:1\n\n天台暗号只能在夜晚使用。',
              }),
            }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      };
      const compactContext = await _testBuildCompactWritingContext({ name: 'chapter-003.md', displayName: '第三章' }, '写楚岚和阿宁在天台重逢');
      assert.ok(calls.some((call) => call.name === 'assemble_scene_context' && call.args.nodeId === 'scene-auto-1'));
      assert.ok(calls.some((call) => call.name === 'retrieve_context' && call.args.chapterName === 'chapter-003.md'));
      assert.equal(compactContext.sceneCharacterContexts.length, 1);
      assert.equal(compactContext.sceneCharacterContexts[0].characters[0].name, '楚岚');
      assert.ok(compactContext.retrievedContext.contextText.includes('world:lore:1'));
      const draftInput = _testBuildDraftInput({
        mode: 'draft',
        userText: '写下一章',
        pendingChapterDraft: null,
        targetChapter: { name: 'chapter-003.md', displayName: '第三章', titleHint: '第三章' },
        editorContext: {},
        compactContext,
      });
      assert.ok(draftInput.includes('场景角色上下文（系统已按大纲节点自动装配'));
      assert.ok(draftInput.includes('相关设定检索上下文'));
      assert.ok(draftInput.includes('world:lore:1'));
      assert.ok(draftInput.includes('不要重复读取完整角色卡'));
      assert.equal((draftInput.match(/sceneCharacterContexts/g) || []).length, 0);
      const reviewInput = _testBuildReviewInput({
        mode: 'draft',
        userText: '写下一章',
        draft: {
          name: 'chapter-003.md',
          displayName: '第三章',
          title: '天台',
          summary: '',
          text: '楚岚来到天台。',
          eventLedger: {
            events: [{
              order: 1,
              when: '夜晚',
              where: '天台',
              participants: ['楚岚'],
              action: '楚岚来到天台',
              infoKnownBy: ['楚岚'],
              communication: '',
              uncertainty: '',
            }],
          },
        },
        retrievedContext: compactContext.retrievedContext,
      });
      const reviewPayload = JSON.parse(reviewInput);
      assert.ok(reviewPayload.retrievedContext.contextText.includes('world:lore:1'));
      assert.equal(reviewPayload.eventLedger.events[0].where, '天台');
      pass('WFO6_chat_draft_preloads_scene_character_retrieval_and_event_ledger', 'chapter draft harness auto-assembles filtered context and passes eventLedger only to reviewers');
    } finally {
      mcpClient.callTool = originalCallTool;
    }
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
