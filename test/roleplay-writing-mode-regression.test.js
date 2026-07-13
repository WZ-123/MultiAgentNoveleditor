'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

async function runRoleplayWritingModeRegressionTest() {
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
    process.env.MANA_USER_DATA_ROOT = path.join(ROOT, 'tmp-test-roleplay-writing-userdata');
    await fs.rm(process.env.MANA_USER_DATA_ROOT, { recursive: true, force: true });

    const appConfig = require(path.join(ROOT, 'src/main/store/appConfig'));
    const cfg = await appConfig.load();
    assert.equal(cfg.writing.mode, 'command_driven');
    assert.equal(cfg.writing.roleplayInteractionLevel, 'director_mediated');
    assert.equal(cfg.writing.roleplayProfileGate, 'block_and_ask');
    assert.equal(cfg.writing.roleplayChatVisibility, 'compact');
    assert.equal(cfg.writing.roleplayPauseOnRisk, true);
    pass('RWM1_default_config_keeps_command_driven', 'new installs do not opt into roleplay writing');

    const saved = await appConfig.save({ writing: { mode: 'roleplay_driven', roleplayInteractionLevel: 'deep_interaction', roleplayMaxInteractionRounds: 101, roleplayPauseOnRisk: false } });
    assert.equal(saved.writing.mode, 'roleplay_driven');
    assert.equal(saved.writing.roleplayInteractionLevel, 'deep_interaction');
    assert.equal(saved.writing.roleplayMaxInteractionRounds, 99);
    assert.equal(saved.writing.roleplayChatVisibility, 'compact');
    assert.equal(saved.writing.roleplayPauseOnRisk, false);
    assert.equal(saved.writing.characterMemoryUpdate, 'after_confirmed_write');
    pass('RWM2_writing_config_persists_partial_updates', 'partial setting saves preserve defaults and clamps deep interaction rounds');

    const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
    const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));
    const novelDir = path.join(ROOT, 'tmp-test-roleplay-writing-novel');
    await fs.rm(novelDir, { recursive: true, force: true });
    const np = novelPaths(novelDir);
    await fs.mkdir(np.characters, { recursive: true });
    await novelData.writeCharacter(novelDir, {
      id: 'hero',
      name: '楚岚',
      personality: '理性克制，但面对重要的人会短暂失去冷静。',
      speechStyle: '句子简短，先问事实，再给判断。',
      appearance: '黑发青年，常穿深色外套。',
      relationships: { ally: '阿宁' },
      storyArc: '从自保逐渐转向主动承担风险。',
    });
    await novelData.patchCharacterMemory(novelDir, 'hero', {
      lastUpdatedChapterRef: 'chapter-001.md',
      factsKnown: [{ id: 'fact-1', text: '阿宁知道旧案线索。' }],
    });
    const characters = await novelData.listCharacters(novelDir);
    assert.equal(characters.length, 1);
    assert.equal(characters[0].id, 'hero');
    const memory = await novelData.readCharacterMemory(novelDir, 'hero');
    assert.equal(memory.factsKnown.length, 1);
    pass('RWM3_character_memory_does_not_pollute_character_list', 'characters/*.memory.json is excluded from character cards');

    const roleplay = require(path.join(ROOT, 'src/main/runtime/chapterRoleplayService'));
    const scenes = roleplay._testScenePacketsFromContext(
      { name: 'chapter-002.md', displayName: '第二章' },
      { outlineNodes: [{ id: 'scene-a', title: '重逢', summary: '楚岚与阿宁重逢。', characters: ['hero', 'ally'], location: '天台' }] }
    );
    assert.equal(scenes.length, 1);
    assert.deepEqual(scenes[0].appearingCharacterIds, ['hero', 'ally']);
    assert.equal(roleplay._testTextFieldQuality({ personality: '' }, 'personality'), 'missing');
    assert.equal(roleplay._testTextFieldQuality({ personality: '冷静' }, 'personality'), 'weak');
    pass('RWM4_roleplay_scene_packets_and_profile_quality_gate_are_stable', 'scene character ids and weak profile fields are detected');

    const longText = '这是一段非常长的角色提案。'.repeat(40);
    const compactProposal = roleplay._testCompactActorProposal({
      characterId: 'hero',
      currentObjective: longText,
      emotionalState: longText,
      speechCandidates: [{ text: longText }, { text: '第二条台词' }, { text: '第三条应被折叠' }],
      actionCandidates: [{ text: longText }],
      innerStateCandidates: [{ text: longText }],
      wouldResistOutline: true,
      risks: [{ type: 'outline_drift', note: longText }],
    }, { id: 'hero', name: '楚岚' });
    assert.equal(compactProposal.characterName, '楚岚');
    assert.equal(compactProposal.speechCandidates.length, 2);
    assert.ok(compactProposal.currentObjective.length < longText.length);
    assert.equal(compactProposal.wouldResistOutline, true);
    const compactDirector = roleplay._testCompactDirectorDecision({
      sceneId: 'scene-a',
      outlineCompliance: 'risk',
      approvedBeats: [{ type: 'dialogue', characterId: 'hero', content: longText }],
      rejectedProposals: [{ sourceProposal: 'hero/speech-2', reason: longText }],
      remainingRisks: [{ type: 'outline_drift', note: longText }],
    });
    assert.equal(compactDirector.approvedBeats.length, 1);
    assert.ok(compactDirector.approvedBeats[0].content.length < longText.length);
    assert.equal(roleplay._testHasDirectorRisk(compactDirector), true);
    assert.equal(roleplay._testHasDirectorRisk({ outlineCompliance: 'pass', remainingRisks: [] }), false);
    pass('RWM5_roleplay_events_are_compacted_and_risk_is_detected', 'actor/director event payloads are bounded and risky director output pauses writing');
  } catch (err) {
    fail('RWM_harness', err?.stack || String(err));
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runRoleplayWritingModeRegressionTest };

if (require.main === module) {
  runRoleplayWritingModeRegressionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
