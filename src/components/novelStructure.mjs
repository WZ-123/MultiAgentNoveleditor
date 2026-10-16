// Membership is keyed by on-disk filename, never by editable/duplicate titles.
export function serializeNovelStructure(novel) {
  return {
    version: 2,
    volumes: (novel?.volumes || []).map(volume => ({
      id: volume.id,
      name: volume.name,
      sections: (volume.sections || []).map(section => ({
        id: section.id,
        name: section.name,
        chapterFiles: (section.chapters || []).map(chapter => chapter.fileName).filter(Boolean),
      })),
    })),
  };
}

function indexOfPosition(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number - 1 : -1;
}

// Legacy name-only structures cannot tell us where metadata-less chapters lived.
// Keep every file visible, once, in a recovery section instead of guessing slices.
export function restoreNovelStructure(structure, chapters = []) {
  const hasStructure = Array.isArray(structure?.volumes);
  const usedIds = new Set();
  const uniqueId = (preferred, fallback) => {
    let id = String(preferred || fallback);
    while (usedIds.has(id)) id += '-copy';
    usedIds.add(id);
    return id;
  };
  const rawVolumes = hasStructure ? structure.volumes : [
    { name: '卷1', sections: [{ name: '节1' }] },
  ];
  const volumes = rawVolumes.map((volume, vi) => ({
    id: uniqueId(volume.id, `vol-${vi}`),
    name: volume.name || `卷${vi + 1}`,
    sections: (Array.isArray(volume.sections) ? volume.sections : []).map((section, si) => ({
      id: uniqueId(section.id, `sec-${vi}-${si}`),
      name: section.name || `节${si + 1}`,
      chapters: [],
    })),
  }));
  const remaining = new Map();
  for (const chapter of chapters) {
    if (chapter?.fileName && !remaining.has(chapter.fileName)) remaining.set(chapter.fileName, chapter);
  }
  const assign = (section, fileName) => {
    if (!remaining.has(fileName)) return;
    section.chapters.push(remaining.get(fileName));
    remaining.delete(fileName);
  };
  // Explicit membership takes precedence over stale numeric frontmatter.
  rawVolumes.forEach((volume, vi) => {
    (Array.isArray(volume.sections) ? volume.sections : []).forEach((section, si) => {
      for (const fileName of Array.isArray(section.chapterFiles) ? section.chapterFiles : []) {
        assign(volumes[vi].sections[si], fileName);
      }
    });
  });
  for (const [fileName, chapter] of remaining) {
    const vi = indexOfPosition(chapter.volume);
    const si = indexOfPosition(chapter.section);
    const section = volumes[vi]?.sections[si];
    if (section) assign(section, fileName);
  }
  if (remaining.size) {
    if (!hasStructure) {
      for (const fileName of remaining.keys()) assign(volumes[0].sections[0], fileName);
    } else {
      // Do not fill an explicitly empty section or discard externally added files.
      if (!volumes.length) volumes.push({ id: uniqueId(null, 'vol-recovered'), name: '卷1', sections: [] });
      const section = { id: uniqueId(null, 'sec-recovered'), name: '未分组章节', chapters: [] };
      volumes[0].sections.push(section);
      for (const fileName of remaining.keys()) assign(section, fileName);
    }
  }
  return volumes;
}

export function chapterLocationMetadata(novel, volumeId, sectionId) {
  const vi = novel.volumes.findIndex(volume => volume.id === volumeId);
  const si = novel.volumes[vi]?.sections.findIndex(section => section.id === sectionId) ?? -1;
  if (vi < 0 || si < 0) throw new Error('Chapter destination no longer exists');
  return { volume: vi + 1, section: si + 1 };
}
