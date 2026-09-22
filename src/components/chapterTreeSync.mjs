function chapterFileName(chapter) {
  return String(chapter?.fileName || '').trim();
}

function oneBasedIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : -1;
}

function mergeExistingChapter(volumes, incomingChapter) {
  const fileName = chapterFileName(incomingChapter);
  let retained = false;
  let changed = false;

  const nextVolumes = (Array.isArray(volumes) ? volumes : []).map((volume) => ({
    ...volume,
    sections: (Array.isArray(volume?.sections) ? volume.sections : []).map((section) => {
      const chapters = [];
      let sectionChanged = false;
      for (const chapter of Array.isArray(section?.chapters) ? section.chapters : []) {
        if (chapterFileName(chapter) !== fileName) {
          chapters.push(chapter);
          continue;
        }
        if (!retained) {
          chapters.push({
            ...chapter,
            ...incomingChapter,
            id: chapter.id || incomingChapter.id,
          });
          retained = true;
        }
        changed = true;
        sectionChanged = true;
      }
      return sectionChanged ? { ...section, chapters } : section;
    }),
  }));

  return { volumes: nextVolumes, found: retained, changed };
}

function resolveInsertionTarget(volumes, incomingChapter) {
  const requestedVolume = oneBasedIndex(incomingChapter?.volume);
  const requestedSection = oneBasedIndex(incomingChapter?.section);
  const safeVolumes = Array.isArray(volumes) ? volumes : [];

  if (requestedVolume >= 0 && safeVolumes[requestedVolume]) {
    const sections = Array.isArray(safeVolumes[requestedVolume].sections)
      ? safeVolumes[requestedVolume].sections
      : [];
    if (requestedSection >= 0 && sections[requestedSection]) {
      return { volumeIndex: requestedVolume, sectionIndex: requestedSection };
    }
    if (sections[0]) return { volumeIndex: requestedVolume, sectionIndex: 0 };
  }

  for (let volumeIndex = 0; volumeIndex < safeVolumes.length; volumeIndex += 1) {
    const sections = Array.isArray(safeVolumes[volumeIndex]?.sections)
      ? safeVolumes[volumeIndex].sections
      : [];
    if (sections[0]) return { volumeIndex, sectionIndex: 0 };
  }
  return null;
}

export function mergeChapterIntoNovelTree(novel, incomingChapter) {
  const fileName = chapterFileName(incomingChapter);
  if (!novel || !fileName) return novel;

  const merged = mergeExistingChapter(novel.volumes, incomingChapter);
  if (merged.found) {
    return { ...novel, volumes: merged.volumes };
  }

  const target = resolveInsertionTarget(merged.volumes, incomingChapter);
  if (!target) return novel;

  const volumes = merged.volumes.map((volume, volumeIndex) => {
    if (volumeIndex !== target.volumeIndex) return volume;
    return {
      ...volume,
      sections: volume.sections.map((section, sectionIndex) => {
        if (sectionIndex !== target.sectionIndex) return section;
        return {
          ...section,
          chapters: [...section.chapters, incomingChapter]
            .sort((left, right) => chapterFileName(left).localeCompare(chapterFileName(right))),
        };
      }),
    };
  });
  return { ...novel, volumes };
}
