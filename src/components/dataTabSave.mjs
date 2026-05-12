function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ensurePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 数组`);
  }
  return value;
}

function buildCharacterDrafts(parsed, generateCharacterId) {
  const items = ensureArray(parsed, '角色数据');
  const seen = new Set();
  return items.map((item, index) => {
    ensurePlainObject(item, `第 ${index + 1} 个角色`);
    const next = { ...item };
    const id = normalizeText(next.id) || normalizeText(next.name) || generateCharacterId(index);
    if (!id) throw new Error(`第 ${index + 1} 个角色缺少 id 和 name，无法保存`);
    if (seen.has(id)) throw new Error(`角色 ID 重复: ${id}`);
    seen.add(id);
    next.id = id;
    return next;
  });
}

export async function saveDataTabEdit({
  mana,
  novelId,
  dataType,
  editText,
  outlineCurrentFile,
  generateCharacterId = (index) => `char-manual-${Date.now().toString(36)}-${index + 1}`,
}) {
  if (!mana?.novel || !novelId) throw new Error('未打开小说项目，无法保存');

  if (dataType === 'characters') {
    const parsed = JSON.parse(editText);
    const drafts = buildCharacterDrafts(parsed, generateCharacterId);
    const existing = await mana.novel.listCharacters(novelId);
    const nextIds = new Set(drafts.map((item) => item.id));

    for (const draft of drafts) {
      await mana.novel.writeCharacter(novelId, draft);
    }

    for (const character of existing || []) {
      const currentId = normalizeText(character?.id);
      if (currentId && !nextIds.has(currentId)) {
        await mana.novel.deleteCharacter(novelId, currentId);
      }
    }

    return { message: `已保存 ${drafts.length} 个角色`, refresh: true };
  }

  if (dataType === 'world') {
    const parsed = ensurePlainObject(JSON.parse(editText), '世界观数据');
    await mana.novel.writeWorld(novelId, parsed);
    return { message: '世界观已保存', refresh: true };
  }

  if (dataType === 'timeline') {
    const parsed = ensureArray(JSON.parse(editText), '时间线数据');
    await mana.novel.replaceTimeline(novelId, parsed);
    return { message: `已保存 ${parsed.length} 条时间线事件`, refresh: true };
  }

  if (dataType === 'style') {
    await mana.novel.writeStyleMemory(novelId, editText);
    return { message: '文风记录已保存', refresh: true };
  }

  if (dataType === 'outline') {
    let targetPath = outlineCurrentFile?.path || '';
    if (!targetPath) {
      const active = await mana.novel.active();
      if (!active?.dir) throw new Error('未找到大纲文件路径');
      targetPath = `${active.dir}/outlines/outline.md`;
    }
    await mana.fs.writeFile(targetPath, editText);
    return { message: '大纲已保存', refresh: true };
  }

  throw new Error(`不支持保存的数据类型: ${dataType}`);
}