'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');

const LEGACY_DE_AI_BLOCK = [
  '### 1. 避免「不是……而是」对照句式',
  '- 错误：「她不是愤怒，而是感到一种深深的悲哀。」',
  '- 正确：「她感到一种深深的悲哀。」',
  '- 这种 not-but 结构是 GPT 系列最明显的特征之一。',
  '',
  '### 2. 避免「不是……更像是／不是，是」句式',
  '- 错误：「那不是愤怒，更像是疲惫。」',
  '- 错误：「不是他不愿意，是他做不到。」',
  '- 正确：直接写「他疲惫不堪。」或「他做不到。」',
  '- 所有「不是X，(而)是Y」变体都要砍掉。直接说 Y。',
].join('\n');

async function runDeAiPromptRegressionTest() {
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

  const ROOT = path.resolve(__dirname, '..');
  const originalUserDataRoot = process.env.MANA_USER_DATA_ROOT;
  const tmpUserDataRoot = path.join(ROOT, 'tmp-test-de-ai-prompt-userdata');

  try {
    await fsp.rm(tmpUserDataRoot, { recursive: true, force: true });
    process.env.MANA_USER_DATA_ROOT = tmpUserDataRoot;

    const pathsModulePath = path.join(ROOT, 'src/main/store/paths');
    const skillsModulePath = path.join(ROOT, 'src/main/store/skills');
    delete require.cache[require.resolve(pathsModulePath)];
    delete require.cache[require.resolve(skillsModulePath)];

    const skillsStore = require(skillsModulePath);
    await skillsStore.saveSkill({
      id: 'de-ai-ify',
      name: '去 AI 味写作指南',
      description: 'legacy',
      tags: ['writing', 'style'],
      assignedSubagentIds: ['sa-chat', 'sa-writer'],
      content: [
        '# 去 AI 味写作指南',
        '',
        '## 核心原则',
        '避免 AI 生成文本的常见痕迹，让文字读起来像人类作者写的。',
        '',
        '## 句法禁忌',
        '',
        LEGACY_DE_AI_BLOCK,
      ].join('\n'),
    });

    await skillsStore.ensureSeeds('# seed');
    const upgraded = await skillsStore.getSkill('de-ai-ify');

    assert.ok(upgraded?.content.includes('不是……，也不是……，而是……'));
    assert.ok(upgraded?.content.includes('不是……，不是……，是'));
    assert.ok(upgraded?.content.includes('并非……抑或……而是……'));
    assert.ok(upgraded?.content.includes('绝对避免「然后她笑了」式独立短反应句'));
    assert.ok(upgraded?.content.includes('那是一个……'));
    assert.ok(upgraded?.content.includes('跨段拆开的套句也要算'));
    assert.ok(upgraded?.content.includes('上一段是「然后她笑了。」、下一段才是「那是一个……」'));
    assert.ok(upgraded?.content.includes('连续否定铺排'));
    assert.ok(upgraded?.content.includes('不是A、不是B、不是C'));
    assert.ok(upgraded?.content.includes('比喻堆叠'));
    assert.ok(upgraded?.content.includes('出场说明书式全描写'));
    assert.ok(upgraded?.content.includes('对比引入句式'));
    assert.ok(upgraded?.content.includes('全知作者跳出做总结'));
    assert.ok(upgraded?.content.includes('不是被强迫的服从式的笑，而是一种——满足'));
    assert.ok(upgraded?.content.includes('不是敌意。更像是一种——确认'));
    assert.ok(upgraded?.content.includes('那不是一个温柔的吻——'));
    assert.ok(upgraded?.content.includes('没有A，没有B，只是C'));
    assert.ok(upgraded?.content.includes('一丝难以察觉的微笑'));
    assert.ok(upgraded?.content.includes('没有一点阴霾的笑容'));
    assert.ok(upgraded?.content.includes('AI 式章末三段式收尾'));
    assert.ok(upgraded?.content.includes('过度依赖「……」分隔线'));
    assert.ok(upgraded?.content.includes('过度依赖破折号'));
    assert.ok(upgraded?.content.includes('跨章重复意象'));
    assert.ok(upgraded?.content.includes('声音中带着一丝'));
    assert.ok(upgraded?.content.includes('感官清单式枚举'));
    assert.ok(upgraded?.content.includes('避免机械的一句一段'));
    assert.ok(upgraded?.content.includes('按段落功能组织自然段'));
    assert.deepEqual(upgraded?.assignedSubagentIds, ['sa-de-ai-ifier']);
    pass('DAI1_existing_de_ai_skill_is_upgraded', 'legacy seeded content picked up the new anti-cliche guidance');
  } catch (err) {
    fail('DAI1_existing_de_ai_skill_is_upgraded', err?.message || String(err));
  } finally {
    if (originalUserDataRoot == null) delete process.env.MANA_USER_DATA_ROOT;
    else process.env.MANA_USER_DATA_ROOT = originalUserDataRoot;
    try { await fsp.rm(tmpUserDataRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  try {
    const { BUILTIN_SUBAGENTS } = require(path.join(ROOT, 'src/main/seeds/builtinSubagents'));
    const proseQuality = BUILTIN_SUBAGENTS.find((subagent) => subagent.id === 'sa-prose-quality');
    const deAiRewriter = BUILTIN_SUBAGENTS.find((subagent) => subagent.id === 'sa-de-ai-ifier');
    const writer = BUILTIN_SUBAGENTS.find((subagent) => subagent.id === 'sa-writer');

    assert.ok(proseQuality?.systemPrompt.includes('不是……，也不是……，而是……'));
    assert.ok(proseQuality?.systemPrompt.includes('不是……，不是……，是……'));
    assert.ok(proseQuality?.systemPrompt.includes('避免用另一句固定模板替换原模板'));
    assert.ok(proseQuality?.systemPrompt.includes('然后她笑了。'));
    assert.ok(proseQuality?.systemPrompt.includes('那是一个……'));
    assert.ok(proseQuality?.systemPrompt.includes('如果一个 AI 套句被拆到了相邻两段之间'));
    assert.ok(proseQuality?.systemPrompt.includes('paragraphIds'));
    assert.ok(proseQuality?.systemPrompt.includes('连续否定铺排'));
    assert.ok(proseQuality?.systemPrompt.includes('不是A、不是B、不是C'));
    assert.ok(proseQuality?.systemPrompt.includes('比喻堆叠'));
    assert.ok(proseQuality?.systemPrompt.includes('出场说明书'));
    assert.ok(proseQuality?.systemPrompt.includes('全知作者跳出'));
    assert.ok(proseQuality?.systemPrompt.includes('解释型旁白'));
    assert.ok(proseQuality?.systemPrompt.includes('AI八股金句套话'));
    assert.ok(proseQuality?.systemPrompt.includes('不是被强迫的服从式的笑，而是一种——满足'));
    assert.ok(proseQuality?.systemPrompt.includes('不是敌意。更像是一种——确认'));
    assert.ok(proseQuality?.systemPrompt.includes('那不是一个温柔的吻——'));
    assert.ok(proseQuality?.systemPrompt.includes('没有A，没有B，只是C'));
    assert.ok(proseQuality?.systemPrompt.includes('一丝难以察觉的微笑'));
    assert.ok(proseQuality?.systemPrompt.includes('没有一点阴霾的笑容'));
    assert.ok(proseQuality?.systemPrompt.includes('AI 式章末三段式收尾'));
    assert.ok(proseQuality?.systemPrompt.includes('过密使用「……」作为转场分隔线'));
    assert.ok(proseQuality?.systemPrompt.includes('过度依赖破折号「——」制造节奏'));
    assert.ok(proseQuality?.systemPrompt.includes('跨章重复意象'));
    assert.ok(proseQuality?.systemPrompt.includes('她的声音中带着一丝'));
    assert.ok(proseQuality?.systemPrompt.includes('感官清单式枚举'));
    assert.ok(proseQuality?.systemPrompt.includes('机械的一句一段'));
    assert.ok(proseQuality?.systemPrompt.includes('段落功能审查'));
    assert.ok(proseQuality?.systemPrompt.includes('styleBaseline'));
    assert.ok(proseQuality?.systemPrompt.includes('不符合通用“优美文风”就报错'));
    assert.ok(deAiRewriter?.systemPrompt.includes('采用最小必要修改'));
    assert.ok(deAiRewriter?.systemPrompt.includes('不得新增原文没有的动作、对白、景物、感官、心理、比喻'));
    assert.ok(deAiRewriter?.systemPrompt.includes('自然不等于圆润'));
    assert.ok(deAiRewriter?.systemPrompt.includes('不要把短句批量接成长句'));
    assert.ok(deAiRewriter?.systemPrompt.includes('不追求“更优美”'));
    assert.ok(writer?.systemPrompt.includes('项目的文风记忆、用户本轮指令和既有正文声线优先'));
    assert.ok(writer?.systemPrompt.includes('完整的去 AI 味规则由独立审校阶段处理'));
    assert.ok(writer?.systemPrompt.includes('简体中文正文使用全角中文标点'));
    assert.equal(writer?.systemPrompt.includes('不是被强迫的服从式的笑，而是一种——满足'), false);
    assert.equal(writer?.systemPrompt.includes('嘴角微微上扬'), false);
    assert.ok(writer.systemPrompt.length < proseQuality.systemPrompt.length);
    pass('DAI2_review_keeps_full_rules_while_writer_uses_short_positive_principles', 'first-draft writer no longer receives the duplicated anti-cliche checklist');
  } catch (err) {
    fail('DAI2_builtin_subagent_prompts_cover_new_patterns', err?.message || String(err));
  }

  try {
    const agentPromptsText = fs.readFileSync(path.join(ROOT, 'src/services/agentPrompts.js'), 'utf8');
    const writingOrchestratorText = fs.readFileSync(path.join(ROOT, 'src/services/writingOrchestrator.js'), 'utf8');

    assert.ok(agentPromptsText.includes('不是……，也不是……，而是……'));
    assert.ok(agentPromptsText.includes('不是……，不是……，是……'));
    assert.ok(agentPromptsText.includes('并非……抑或……而是……'));
    assert.ok(agentPromptsText.includes('然后她笑了。'));
    assert.ok(agentPromptsText.includes('那是一个……'));
    assert.ok(agentPromptsText.includes('如果一个 AI 套句被拆到了相邻两段之间'));
    assert.ok(agentPromptsText.includes('paragraphIds'));
    assert.ok(agentPromptsText.includes('标点必须使用全角中文标点'));
    assert.ok(agentPromptsText.includes('连续否定铺排'));
    assert.ok(agentPromptsText.includes('比喻堆叠'));
    assert.ok(agentPromptsText.includes('出场说明书'));
    assert.ok(agentPromptsText.includes('全知作者跳出'));
    assert.ok(agentPromptsText.includes('不是被强迫的服从式的笑，而是一种——满足'));
    assert.ok(agentPromptsText.includes('不是敌意。更像是一种——确认'));
    assert.ok(agentPromptsText.includes('那不是一个温柔的吻——'));
    assert.ok(agentPromptsText.includes('没有A，没有B，只是C'));
    assert.ok(agentPromptsText.includes('一丝难以察觉的微笑'));
    assert.ok(agentPromptsText.includes('没有一点阴霾的笑容'));
    assert.ok(agentPromptsText.includes('AI 式章末三段式收尾'));
    assert.ok(agentPromptsText.includes('过密使用「……」作为转场分隔线'));
    assert.ok(agentPromptsText.includes('过度依赖破折号「——」制造节奏'));
    assert.ok(agentPromptsText.includes('跨章重复意象'));
    assert.ok(agentPromptsText.includes('她的声音中带着一丝'));
    assert.ok(agentPromptsText.includes('感官清单式枚举'));
    assert.ok(agentPromptsText.includes('段落以叙事功能为单位'));
    assert.ok(agentPromptsText.includes('机械的一句一段'));
    assert.ok(writingOrchestratorText.includes('buildQualityReviewPayload'));
    assert.ok(writingOrchestratorText.includes('detectCrossParagraphQualityAnnotations'));
    assert.ok(writingOrchestratorText.includes('paragraphIds'));
    pass('DAI3_legacy_prompt_paths_cover_new_patterns', 'legacy draft and review prompt paths were updated too');
  } catch (err) {
    fail('DAI3_legacy_prompt_paths_cover_new_patterns', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  if (results.failed > 0) process.exitCode = 1;
  return results;
}

module.exports = { runDeAiPromptRegressionTest };

if (require.main === module) {
  runDeAiPromptRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
