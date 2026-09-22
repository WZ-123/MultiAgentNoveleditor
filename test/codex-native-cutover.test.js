'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createFakeResponsesServer } = require('./fixtures/fake-responses-server');

const ROOT = path.resolve(__dirname, '..');

function productionText() {
  const files = execFileSync('rg', ['--files', 'src/main', 'src/components', 'src/services', 'src/hooks'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter((file) => /\.(?:js|jsx|mjs|cjs)$/u.test(file));
  return files.map((file) => `${file}\n${fs.readFileSync(path.join(ROOT, file), 'utf8')}`).join('\n');
}

function waitTerminal(service, runId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${runId} timed out`)), 30_000);
    const onEvent = (event) => {
      if (event.runId !== runId || !['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) return;
      clearTimeout(timer);
      service.off('event', onEvent);
      if (event.type === 'turn_completed') resolve(event);
      else reject(new Error(event.error || event.type));
    };
    service.on('event', onEvent);
  });
}

async function run() {
  const source = productionText();
  for (const banned of ['TurnEngine', 'ProviderDriver', 'runSubagent', 'ChatCoordinator', 'TaskMachine', 'EvidencePacket', 'ProposalService', 'responses-gateway', 'mana:runtime:', 'mana:chatAgent:']) {
    assert.equal(source.includes(banned), false, `production source still contains ${banned}`);
  }
  assert.equal((source.match(/request\('turn\/start'/gu) || []).length, 1, 'turn/start must have one application call entrance');
  assert.match(source, /model_reasoning_effort:\s*route\.reasoningEffort/u, 'verified reasoning effort must persist at thread config level for every provider sub-request');
  assert.equal((source.match(/mana:codex:startTurn/gu) || []).length >= 2, true, 'desktop and LAN must expose the same Codex startTurn IPC');

  const { utf8Page, TOOLS } = require('../src/main/mcp/tools');
  const chinese = Buffer.from('甲乙丙。', 'utf8');
  const first = utf8Page(chinese, 0, 4);
  const second = utf8Page(chinese, first.end, 4);
  assert.equal(first.content.includes('\ufffd'), false);
  assert.equal(second.content.includes('\ufffd'), false);
  assert.equal(first.content + second.content, '甲乙');
  assert.deepEqual(TOOLS.filter((tool) => tool.name !== 'connection_probe').map((tool) => tool.name), [
    'list_novel_resources', 'read_novel_resource', 'search_novel_resources', 'report_writing_progress',
    'scan_de_ai_patterns',
    'check_de_ai_minimality', 'check_timeline_feasibility',
  ]);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mana-codex-native-'));
  process.env.MANA_USER_DATA_ROOT = path.join(tmp, 'user-data');
  await fsp.mkdir(process.env.MANA_USER_DATA_ROOT, { recursive: true });
  await fsp.writeFile(path.join(process.env.MANA_USER_DATA_ROOT, 'model-config.json'), JSON.stringify({
    schemaVersion: 4,
    providers: [{ id: 'legacy-anthropic', name: 'Legacy', adapterId: 'anthropic', baseUrl: 'https://example.invalid', models: [{ id: 'legacy', name: 'Legacy' }] }],
    activeProviderId: 'legacy-anthropic',
  }));

  const modelConfig = require('../src/main/modelConfig');
  const migrated = await modelConfig.load();
  assert.equal(migrated.schemaVersion, 8);
  assert.equal(migrated.credentials.length, 1);
  assert.equal(migrated.connections.length, 1);
  assert.equal(migrated.connections[0].models[0].verification.responses, 'unknown');
  assert.equal(fs.existsSync(path.join(process.env.MANA_USER_DATA_ROOT, 'migration-backups', 'responses-connections-v1', 'model-config-pre-v6.json')), true);

  const fake = await createFakeResponsesServer({ namespace: 'mcp__novel_tools', toolName: 'connection_probe', text: 'true' });
  let chatFake = null;
  const { CodexSessionService } = require('../src/main/codex-runtime/codexSessionService');
  const service = new CodexSessionService();
  try {
    await modelConfig.saveCredential({ id: 'fixture-key', name: 'Fixture Key', apiKey: 'fixture-secret' });
    await modelConfig.saveConnection({ id: 'fixture', name: 'Fixture Responses', credentialId: 'fixture-key', baseUrl: fake.origin, auth: { mode: 'bearer' }, discovery: { status: 'ok' }, models: [{ id: 'fixture-model', name: 'Fixture model' }] });
    const result = await service.verifyModel({ connectionId: 'fixture', modelId: 'fixture-model', mode: 'tools' });
    assert.equal(result.ok, true);
    assert.equal(fake.requests.length, 2, 'connection test must complete a real Responses tool loop');
    assert.equal(fake.requests[0].headers.authorization, 'Bearer fixture-secret');
    assert.equal(fake.requests[0].body.tools.some((tool) => tool.name === 'multi_agent_v1'), true, 'tool-capable Codex threads must retain native multi-agent');
    assert.equal(JSON.stringify(fake.requests[1].body.input).includes('function_call_output'), true);
    const listedSkills = await (await service.processManager.start()).request('skills/list', { cwds: [service.processManager.runDirectory], forceReload: true });
    const discoveredSkills = listedSkills.data.flatMap((group) => group.skills || []);
    const skillNames = discoveredSkills.filter((skill) => skill.enabled !== false).map((skill) => skill.name).sort();
    assert.deepEqual(skillNames, [
      'mana-character-roleplay', 'mana-consistency-review', 'mana-de-ai', 'mana-fiction-writing',
      'mana-import-enrichment', 'mana-novel-workspace', 'mana-outline',
    ], 'isolated App Server must not load project or global Codex skills');
    assert.equal(discoveredSkills.filter((skill) => !skill.name.startsWith('mana-')).every((skill) => skill.enabled === false), true, 'global skills must be disabled in the application Codex profile');
    assert.equal(service.processManager.runDirectory.startsWith(os.tmpdir()), true, 'temporary read-only cwd must live outside the project and user home tree');
    await service.verifyModel({ connectionId: 'fixture', modelId: 'fixture-model', mode: 'responses' });
    const textProbeTools = fake.requests.at(-1).body.tools.map((tool) => String(tool.name || tool.function?.name || ''));
    assert.equal(textProbeTools.some((name) => /novel_tools|apply_patch|multi_agent/u.test(name)), false, 'text-only verification must not expose novel mutation or agent tools');
    await modelConfig.setActive({ connectionId: 'fixture', modelId: 'fixture-model', reasoningEffort: null });
    chatFake = await createFakeResponsesServer({ text: 'FAKE_CHAT_OK' });
    await modelConfig.saveConnection({ id: 'fixture-chat', name: 'Fixture Chat', credentialId: 'fixture-key', baseUrl: chatFake.origin, auth: { mode: 'bearer' }, discovery: { status: 'ok' }, models: [{ id: 'fixture-model', name: 'Fixture model', verification: { responses: 'ok', tools: 'ok' } }] });
    await modelConfig.setActive({ connectionId: 'fixture-chat', modelId: 'fixture-model', reasoningEffort: null });
    const novels = require('../src/main/store/novels');
    const chatHistory = require('../src/main/store/chatHistory');
    const novel = await novels.createNovel({ title: '线程模式边界', dir: path.join(tmp, 'thread-mode-novel') });
    const thread = await chatHistory.createThread({ title: '模式切换', novelId: novel.id });
    const plainUser = { id: 'plain-user', role: 'user', text: '只写一段虚构场景，不读取项目资料。', timestamp: Date.now() };
    await chatHistory.appendMessage(thread.id, plainUser);
    const plainBefore = chatFake.requests.length;
    const plainTerminal = waitTerminal(service, 'plain-novel-chat');
    await service.startTurn({ runId: 'plain-novel-chat', conversationId: thread.id, persistence: 'chat', novelId: novel.id, userMessageId: plainUser.id, text: plainUser.text });
    await plainTerminal;
    assert.equal(chatFake.requests.length, plainBefore + 1, 'plain chat must complete in one physical provider request');
    assert.equal(chatFake.requests.at(-1).body.tools.some((tool) => /novel_tools|list_novel_resources/u.test(String(tool.name || ''))), true, 'project chat must expose novel MCP tools without an explicit Skill');
    const textBinding = (await chatHistory.getThread(thread.id)).codexBinding;

    const toolUser = { id: 'tool-user', role: 'user', text: '使用写作 Skill 检查当前项目。', timestamp: Date.now() + 1 };
    await chatHistory.appendMessage(thread.id, toolUser);
    const toolBefore = chatFake.requests.length;
    const toolTerminal = waitTerminal(service, 'tool-novel-chat');
    await service.startTurn({ runId: 'tool-novel-chat', conversationId: thread.id, persistence: 'chat', novelId: novel.id, userMessageId: toolUser.id, text: toolUser.text, skillName: 'mana-fiction-writing' });
    await toolTerminal;
    assert.equal(chatFake.requests.length, toolBefore + 1, 'fixture tool turn must not add an application-side workflow loop');
    const exposedToolNames = chatFake.requests.at(-1).body.tools.map((tool) => String(tool.name || tool.function?.name || ''));
    assert.equal(exposedToolNames.includes('mcp__novel_tools'), true, `explicit writing Skill must expose the novel MCP namespace: ${JSON.stringify(exposedToolNames)}`);
    const toolBinding = (await chatHistory.getThread(thread.id)).codexBinding;
    assert.equal(toolBinding.threadId, textBinding.threadId, 'adding a Skill must not change project tool mode or rebuild history');
    assert.equal(toolBinding.providerFingerprint, textBinding.providerFingerprint, 'project capability must remain stable across ordinary and Skill requests');

    await modelConfig.saveConnection({ id: 'fixture-header', name: 'Header Responses', credentialId: 'fixture-key', baseUrl: fake.origin, queryParams: { 'api-version': 'v6-test' }, auth: { mode: 'header', headerName: 'x-api-key' }, discovery: { status: 'ok' }, models: [{ id: 'fixture-model', name: 'Fixture model' }] });
    await service.verifyModel({ connectionId: 'fixture-header', modelId: 'fixture-model', mode: 'responses' });
    assert.equal(fake.requests.at(-1).headers.authorization, '');
    assert.equal(fake.requests.at(-1).headers.xApiKey, 'fixture-secret');
    assert.match(fake.requests.at(-1).url, /api-version=v6-test/u);
    await modelConfig.updateModelVerification({ connectionId: 'fixture-header', modelId: 'fixture-model', mode: 'tools', ok: false, errorCode: 'fixture_no_tools' });
    await modelConfig.setActive({ connectionId: 'fixture-header', modelId: 'fixture-model', reasoningEffort: null });
    await assert.rejects(() => service.startTurn({ runId: 'blocked-tools', persistence: 'one-shot', text: '改写当前章节', skillName: 'mana-fiction-writing' }), (error) => error.code === 'model_tools_unavailable');
    const codexHome = path.join(process.env.MANA_USER_DATA_ROOT, 'codex-home');
    const config = await fsp.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /persistence = "save-all"/u);
    assert.match(config, /\[skills\]\s+include_instructions = false/u);
    assert.doesNotMatch(config, /(?:multi_agent|collab|collaboration_modes)\s*=\s*false/u);
    assert.equal(fs.existsSync(codexHome), true);
  } finally {
    await service.dispose();
    await chatFake?.close();
    await fake.close();
  }
  console.log('codex-native-cutover: ok');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
