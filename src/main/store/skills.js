'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');
const { readJson, writeJson, listJsonFiles } = require('./jsonStore');

const SCHEMA_VERSION = 2;
const BUILTIN_NAMES = ['mana-novel-workspace', 'mana-fiction-writing', 'mana-de-ai', 'mana-consistency-review', 'mana-outline', 'mana-character-roleplay', 'mana-import-enrichment'];
function root() { return path.join(paths().root, 'codex-home', 'skills'); }
function indexFile() { return path.join(root(), 'index.json'); }
function builtinRoot() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'codex-skills');
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', '..', '..', 'resources', 'codex-skills');
}
function safeName(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!raw) throw new Error('Skill 名称无效');
  return raw.startsWith('mana-user-') ? raw : `mana-user-${raw}`;
}
function stripFrontMatter(content) { return String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim(); }
function frontMatter(name, description, content) {
  return ['---', `name: ${name}`, `description: ${String(description || name).replace(/[\r\n]+/gu, ' ').slice(0, 200)}`, '---', '', stripFrontMatter(content), ''].join('\n');
}
async function loadIndex() { return readJson(indexFile(), { schemaVersion: SCHEMA_VERSION, skills: [] }); }
async function saveIndex(index) { await writeJson(indexFile(), { schemaVersion: SCHEMA_VERSION, skills: index.skills || [] }, { mode: 0o600 }); }
async function writeMigratedSkill(name, description, content, source) {
  const skillName = safeName(name);
  const dir = path.join(root(), skillName);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), frontMatter(skillName, description, content), { encoding: 'utf8', mode: 0o600 });
  return { name: skillName, description: String(description || skillName), enabled: true, builtIn: false, source };
}
async function unusedBackupTarget(directory, name) {
  for (let index = 0; index < 100; index += 1) {
    const candidate = path.join(directory, index === 0 ? name : `${name}-${index}`);
    try { await fsp.access(candidate); } catch { return candidate; }
  }
  throw new Error(`无法为 ${name} 创建迁移备份目录`);
}
async function makeTreeReadOnly(target) {
  const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(child);
    else await fsp.chmod(child, 0o400).catch(() => {});
  }
  await fsp.chmod(target, 0o500).catch(() => {});
}
async function migrateLegacy() {
  const marker = path.join(paths().root, 'migrations', 'codex-native-v1.json');
  if (await readJson(marker, null)) return;
  await fsp.mkdir(root(), { recursive: true, mode: 0o700 });
  const migrated = [];
  const legacyIndex = await readJson(paths().skillsIndex, { skills: [] });
  for (const entry of legacyIndex.skills || []) {
    const file = path.join(paths().skills, `${entry.id}.md`);
    let content = '';
    try { content = await fsp.readFile(file, 'utf8'); } catch { continue; }
    migrated.push(await writeMigratedSkill(entry.id, entry.description || entry.name, content, 'skill'));
  }
  for (const file of await listJsonFiles(paths().subagentsUser)) {
    const value = await readJson(file, null);
    if (!value?.id) continue;
    const content = ['# 原自定义 Subagent', '', value.systemPrompt || value.prompt || value.instructions || '', '', '## 允许工具提示', '', (value.allowedTools || []).map((tool) => `- ${tool}`).join('\n') || '- 仅使用当前 Codex 会话允许的 novel-tools。'].join('\n');
    migrated.push(await writeMigratedSkill(value.id, value.description || value.displayName || value.id, content, 'subagent'));
  }
  for (const file of await listJsonFiles(paths().pipelinesUser)) {
    const value = await readJson(file, null);
    if (!value?.id) continue;
    const nodes = (value.nodes || []).map((node) => `- ${node.id || node.name}: ${node.description || node.instruction || ''}; dependsOn=${JSON.stringify(node.dependsOn || node.dependencies || [])}`).join('\n');
    migrated.push(await writeMigratedSkill(value.id, value.description || value.name || value.id, `# 原自定义工作流\n\n按以下节点与依赖关系执行；由 Codex 自主规划工具调用和原生 subagent。\n\n${nodes}`, 'dag'));
  }
  await saveIndex({ skills: migrated });
  const backup = path.join(paths().root, 'migration-backups', 'codex-native-v1');
  await fsp.mkdir(backup, { recursive: true, mode: 0o700 });
  for (const [source, name] of [[paths().skills, 'legacy-skills'], [path.join(paths().root, 'subagents'), 'legacy-subagents'], [path.join(paths().root, 'pipelines'), 'legacy-pipelines']]) {
    try {
      const target = await unusedBackupTarget(backup, name);
      await fsp.rename(source, target);
      await makeTreeReadOnly(target);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  await writeJson(marker, { schemaVersion: 1, marker: 'codex-native-v1', migratedAt: new Date().toISOString(), migrated: migrated.map((item) => ({ name: item.name, source: item.source })) }, { mode: 0o600 });
}
async function listSkills() {
  await migrateLegacy();
  const index = await loadIndex();
  const builtins = await Promise.all(BUILTIN_NAMES.map(async (name) => ({ id: name, name, description: name, enabled: true, builtIn: true, content: await fsp.readFile(path.join(builtinRoot(), name, 'SKILL.md'), 'utf8') })));
  const custom = await Promise.all((index.skills || []).map(async (entry) => ({ id: entry.name, ...entry, content: await fsp.readFile(path.join(root(), entry.name, 'SKILL.md'), 'utf8').catch(() => '') })));
  return [...builtins, ...custom];
}
async function getSkill(id) { return (await listSkills()).find((skill) => skill.id === id || skill.name === id) || null; }
async function saveSkill(skill) {
  await migrateLegacy();
  if (BUILTIN_NAMES.includes(skill?.id) || skill?.builtIn) throw new Error('内置 Skill 只读');
  const entry = await writeMigratedSkill(skill?.id || skill?.name, skill?.description, skill?.content, 'user');
  entry.enabled = skill?.enabled !== false;
  const index = await loadIndex();
  index.skills = (index.skills || []).filter((item) => item.name !== entry.name);
  index.skills.push(entry);
  await saveIndex(index);
  return { id: entry.name, ...entry, content: await fsp.readFile(path.join(root(), entry.name, 'SKILL.md'), 'utf8') };
}
async function deleteSkill(id) {
  await migrateLegacy();
  if (BUILTIN_NAMES.includes(id)) throw new Error('内置 Skill 不能删除');
  const name = safeName(id);
  const index = await loadIndex();
  index.skills = (index.skills || []).filter((item) => item.name !== name);
  await saveIndex(index);
  await fsp.rm(path.join(root(), name), { recursive: true, force: true });
}
async function setSkillEnabled(id, enabled) {
  await migrateLegacy();
  if (BUILTIN_NAMES.includes(id)) throw new Error('内置 Skill 始终启用');
  const name = safeName(id);
  const index = await loadIndex();
  const entry = (index.skills || []).find((item) => item.name === name);
  if (!entry) throw new Error('Skill 不存在');
  entry.enabled = enabled === true;
  await saveIndex(index);
  return entry;
}
async function exportSkill(id) { const skill = await getSkill(id); if (!skill) throw new Error('Skill 不存在'); return { schemaVersion: 2, type: 'codex-skill', name: skill.name, description: skill.description, content: skill.content }; }
async function importSkill(bundle) { if (!bundle || !['codex-skill', 'mana-skill'].includes(bundle.type)) throw new Error('无效 Skill 文件'); return saveSkill({ id: bundle.name || bundle.id, description: bundle.description, content: bundle.content, enabled: true }); }

module.exports = { BUILTIN_NAMES, SCHEMA_VERSION, deleteSkill, exportSkill, getSkill, importSkill, listSkills, migrateLegacy, saveSkill, setSkillEnabled };
