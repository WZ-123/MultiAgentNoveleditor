'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { listResourceDescriptors, parseResourceRef, readResource } = require('../mcp/novelResources');

function workspaceKey(novelId) {
  return crypto.createHash('sha256').update(String(novelId || '')).digest('hex').slice(0, 20);
}

function resourceRelativePath(resourceRef) {
  const parsed = parseResourceRef(resourceRef);
  if (parsed.kind === 'novel') return 'novel/meta.json';
  if (parsed.kind === 'chapter') return `chapters/${parsed.key}`;
  if (parsed.kind === 'chapter-summary') return `summaries/${parsed.key}`;
  if (parsed.kind === 'character') return `characters/${parsed.key}.json`;
  if (parsed.kind === 'character-memory') return `character-memories/${parsed.key}.json`;
  if (parsed.kind === 'asset') return `assets/${parsed.key}.json`;
  if (parsed.kind === 'timeline') return 'timeline/events.json';
  if (parsed.kind === 'timeline-event') return `timeline/event-${encodeURIComponent(parsed.key)}.json`;
  if (parsed.kind === 'style') return 'style/memory.md';
  if (parsed.kind === 'world') return parsed.key === 'lore' ? 'world/lore.md' : 'world/places.json';
  if (parsed.kind === 'outline' && parsed.key === 'chapter') return `outlines/chapter-v${String(parsed.volumeIndex).padStart(3, '0')}-s${String(parsed.sectionIndex).padStart(3, '0')}-c${String(parsed.chapterIndex).padStart(3, '0')}.md`;
  if (parsed.kind === 'outline') return parsed.key === 'master' ? 'outlines/master.md' : `outlines/${parsed.key}.json`;
  throw new Error(`该资源不能映射为原生工作区文件：${resourceRef}`);
}

function resourceRefFromRelativePath(value) {
  const relative = String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '');
  let match;
  if (relative === 'novel/meta.json') return 'novel:meta';
  if ((match = relative.match(/^chapters\/([^/]+\.md)$/u))) return `chapter:${match[1]}`;
  if ((match = relative.match(/^summaries\/([^/]+\.md)$/u))) return `chapter-summary:${match[1]}`;
  if ((match = relative.match(/^characters\/([^/]+)\.json$/u))) return `character:${match[1]}`;
  if ((match = relative.match(/^character-memories\/([^/]+)\.json$/u))) return `character-memory:${match[1]}`;
  if ((match = relative.match(/^assets\/([^/]+)\.json$/u))) return `asset:${match[1]}`;
  if (relative === 'timeline/events.json') return 'timeline:all';
  if ((match = relative.match(/^timeline\/event-(.+)\.json$/u))) return `timeline:event:${decodeURIComponent(match[1])}`;
  if (relative === 'style/memory.md') return 'style:memory';
  if (relative === 'world/lore.md') return 'world:lore';
  if (relative === 'world/places.json') return 'world:places';
  if (relative === 'outlines/master.md') return 'outline:master';
  if ((match = relative.match(/^outlines\/chapter-v(\d+)-s(\d+)-c(\d+)\.md$/u))) return `outline:chapter:${Number(match[1])}:${Number(match[2])}:${Number(match[3])}`;
  if ((match = relative.match(/^outlines\/volume-(\d+)\/section-(\d+)\/chapter-(\d+)\.md$/u))) return `outline:chapter:${Number(match[1])}:${Number(match[2])}:${Number(match[3])}`;
  if (relative === 'outlines/nodes.json') return 'outline:nodes';
  if (relative === 'outlines/hierarchy.json') return 'outline:hierarchy';
  throw new Error(`原生补丁包含未知小说文件：${relative}`);
}

async function listFiles(root, current = root) {
  const entries = await fsp.readdir(current, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error('原生小说工作区不允许符号链接');
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
    else throw new Error(`原生小说工作区包含不支持的文件类型：${entry.name}`);
  }
  return files.sort();
}

async function syncNativeNovelWorkspace(entry, workspacesRoot) {
  const root = path.join(workspacesRoot, workspaceKey(entry.id));
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const snapshots = new Map();
  const descriptors = await listResourceDescriptors(entry);
  for (const descriptor of descriptors) {
    if (descriptor.resourceRef.startsWith('timeline:event:')) continue;
    let resource;
    try { resource = await readResource(entry, descriptor.resourceRef); }
    catch (error) {
      if (error?.code === 'context_incomplete' || error?.code === 'ENOENT') continue;
      throw error;
    }
    const relativePath = resourceRelativePath(resource.resourceRef);
    const target = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.writeFile(target, resource.content, { encoding: 'utf8', mode: 0o600 });
    snapshots.set(resource.resourceRef, { ...resource, relativePath });
  }
  return { root, snapshots };
}

async function collectNativeNovelChanges(workspace) {
  const currentFiles = await listFiles(workspace.root);
  const currentRefs = new Set();
  const changes = [];
  for (const relativePath of currentFiles) {
    const resourceRef = resourceRefFromRelativePath(relativePath);
    if (currentRefs.has(resourceRef)) throw new Error(`原生工作区重复映射资源：${resourceRef}`);
    currentRefs.add(resourceRef);
    const content = await fsp.readFile(path.join(workspace.root, relativePath), 'utf8');
    const before = workspace.snapshots.get(resourceRef);
    if (!before) changes.push({ resourceRef, mode: 'create', content });
    else if (content !== before.content) changes.push({ resourceRef, baseHash: before.sourceHash, mode: 'replace', content });
  }
  for (const [resourceRef, before] of workspace.snapshots) {
    if (!currentRefs.has(resourceRef)) changes.push({ resourceRef, baseHash: before.sourceHash, mode: 'delete' });
  }
  return changes.sort((left, right) => left.resourceRef.localeCompare(right.resourceRef, 'zh-CN'));
}

module.exports = {
  collectNativeNovelChanges,
  resourceRefFromRelativePath,
  resourceRelativePath,
  syncNativeNovelWorkspace,
  workspaceKey,
};
