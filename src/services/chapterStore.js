const STORAGE_KEY = 'mana-chapters-v1';

function ensureMarkdownFileName(name, fallback) {
  const raw = String(name || fallback || '').trim();
  if (!raw) return fallback || 'chapter.md';
  return raw.toLowerCase().endsWith('.md') ? raw : `${raw}.md`;
}

function normalizeChapter(chapter, fallbackName) {
  return {
    id: String(chapter?.id || `chapter-${Date.now()}-${Math.random()}`),
    fileName: ensureMarkdownFileName(chapter?.fileName, fallbackName),
    content: String(chapter?.content || ''),
  };
}

function normalizeSection(section, volumeIdx, sectionIdx) {
  const sectionName = String(section?.name || `节${sectionIdx + 1}`);
  const rawChapters = Array.isArray(section?.chapters) ? section.chapters : [];
  return {
    id: String(section?.id || `section-${Date.now()}-${volumeIdx}-${sectionIdx}`),
    name: sectionName,
    chapters: rawChapters.map((chapter, chapterIdx) =>
      normalizeChapter(chapter, `chapter${chapterIdx + 1}.md`)
    ),
  };
}

function normalizeVolume(volume, volumeIdx) {
  const volumeName = String(volume?.name || `卷${volumeIdx + 1}`);
  const rawSections = Array.isArray(volume?.sections) ? volume.sections : [];
  return {
    id: String(volume?.id || `volume-${Date.now()}-${volumeIdx}`),
    name: volumeName,
    sections: rawSections.map((section, sectionIdx) =>
      normalizeSection(section, volumeIdx, sectionIdx)
    ),
  };
}

function migrateFlatChaptersToNovel(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return { volumes: [] };
  }
  return {
    volumes: [
      {
        id: `volume-${Date.now()}-1`,
        name: '卷1',
        sections: [
          {
            id: `section-${Date.now()}-1`,
            name: '节1',
            chapters: chapters.map((chapter, idx) =>
              normalizeChapter(chapter, `chapter${idx + 1}.md`)
            ),
          },
        ],
      },
    ],
  };
}

export function loadNovelTree() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { volumes: [] };
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed?.volumes)) {
      return {
        volumes: parsed.volumes.map((volume, volumeIdx) =>
          normalizeVolume(volume, volumeIdx)
        ),
      };
    }

    if (Array.isArray(parsed?.chapters) || Array.isArray(parsed)) {
      const flat = Array.isArray(parsed) ? parsed : parsed.chapters;
      return migrateFlatChaptersToNovel(flat);
    }

    return { volumes: [] };
  } catch {
    return { volumes: [] };
  }
}

export function saveNovelTree(novel) {
  const rawVolumes = Array.isArray(novel?.volumes) ? novel.volumes : [];
  const volumes = rawVolumes.map((volume, volumeIdx) =>
    normalizeVolume(volume, volumeIdx)
  );

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      format: 'markdown',
      schema: 'volume-section-chapter',
      volumes,
    })
  );
}

