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
    const writer = BUILTIN_SUBAGENTS.find((subagent) => subagent.id === 'sa-writer');

    assert.ok(proseQuality?.systemPrompt.includes('不是……，也不是……，而是……'));
    assert.ok(proseQuality?.systemPrompt.includes('不是……，不是……，是……'));
    assert.ok(proseQuality?.systemPrompt.includes('并非……抑或……而是……'));
    assert.ok(proseQuality?.systemPrompt.includes('然后她笑了。'));
    assert.ok(proseQuality?.systemPrompt.includes('那是一个……'));
    assert.ok(writer?.systemPrompt.includes('不是……，也不是……，而是……'));
    assert.ok(writer?.systemPrompt.includes('不是……，不是……，是'));
    assert.ok(writer?.systemPrompt.includes('然后她笑了。'));
    assert.ok(writer?.systemPrompt.includes('那是一个……'));
    pass('DAI2_builtin_subagent_prompts_cover_new_patterns', 'writer and prose-quality prompts both mention the new anti-cliche rule');
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
    assert.ok(writingOrchestratorText.includes('不是……，也不是……，而是……'));
    assert.ok(writingOrchestratorText.includes('并非……抑或……而是……'));
    assert.ok(writingOrchestratorText.includes('然后她笑了。'));
    assert.ok(writingOrchestratorText.includes('那是一个……'));
    pass('DAI3_legacy_prompt_paths_cover_new_patterns', 'legacy draft and review prompt paths were updated too');
  } catch (err) {
    fail('DAI3_legacy_prompt_paths_cover_new_patterns', err?.message || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runDeAiPromptRegressionTest };

if (require.main === module) {
  runDeAiPromptRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
