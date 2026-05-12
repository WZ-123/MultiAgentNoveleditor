/**
 * Migrates legacy localStorage data (chapters + style memory) into a
 * file-system-backed novel directory. Idempotent — sets a per-novel flag in
 * localStorage to prevent re-running.
 *
 * Designed to be called immediately after a novel is opened. Returns a summary
 * of what was migrated, or `null` if there was nothing to migrate.
 */

const CHAPTER_KEY = 'mana-chapters-v1';
const STYLE_KEY = 'mana-style-memory-v1';
const MIGRATION_FLAG_PREFIX = 'mana-migrated-to-novel-';

function readLocal(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function setLocal(key, val) {
  try { localStorage.setItem(key, val); }
  catch { /* ignore */ }
}

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function flattenChapters(novelTree) {
  const out = [];
  const volumes = Array.isArray(novelTree?.volumes) ? novelTree.volumes : [];
  for (const vol of volumes) {
    const sections = Array.isArray(vol?.sections) ? vol.sections : [];
    for (const sec of sections) {
      const chapters = Array.isArray(sec?.chapters) ? sec.chapters : [];
      for (const ch of chapters) {
        out.push({
          volumeName: vol.name || '',
          sectionName: sec.name || '',
          fileName: ch.fileName || `chapter-${out.length + 1}.md`,
          content: ch.content || '',
        });
      }
    }
  }
  return out;
}

/**
 * @param {string} novelId
 * @returns {Promise<{migratedChapters: number, migratedStyleMemoryChars: number} | null>}
 */
export async function migrateLegacyToNovel(novelId) {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  if (!mana?.novel) return null;
  if (!novelId) return null;

  const flagKey = `${MIGRATION_FLAG_PREFIX}${novelId}`;
  if (readLocal(flagKey) === '1') return null;

  let migratedChapters = 0;
  let migratedStyleChars = 0;

  // ---- Chapters ----
  try {
    const raw = readLocal(CHAPTER_KEY);
    if (raw) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      const tree = parsed && Array.isArray(parsed.volumes)
        ? parsed
        : (Array.isArray(parsed) ? { volumes: [{ sections: [{ chapters: parsed }] }] } : null);
      if (tree) {
        const chapters = flattenChapters(tree);
        // Only migrate if target chapters/ is empty
        const existing = await mana.novel.listChapters(novelId).catch(() => []);
        if (existing.length === 0) {
          for (let i = 0; i < chapters.length; i += 1) {
            const ch = chapters[i];
            const safeName = `chapter-${pad(i + 1, 3)}.md`;
            const header = ch.volumeName || ch.sectionName
              ? `<!-- migrated from ${ch.volumeName || ''}${ch.sectionName ? ` / ${ch.sectionName}` : ''} (${ch.fileName}) -->\n\n`
              : '';
            await mana.novel.saveChapter(novelId, safeName, header + ch.content);
            migratedChapters += 1;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[legacyMigration] chapter migration failed:', err);
  }

  // ---- Style memory ----
  try {
    const raw = readLocal(STYLE_KEY);
    if (raw && typeof mana.novel.writeStyleMemory === 'function') {
      const existing = await mana.novel.readStyleMemory(novelId).catch(() => '');
      if (!existing) {
        const header = `<!-- migrated from localStorage on ${new Date().toISOString()} -->\n\n`;
        await mana.novel.writeStyleMemory(novelId, header + raw);
        migratedStyleChars = raw.length;
      }
    }
  } catch (err) {
    console.warn('[legacyMigration] style memory migration failed:', err);
  }

  setLocal(flagKey, '1');

  if (migratedChapters === 0 && migratedStyleChars === 0) return null;
  return { migratedChapters, migratedStyleMemoryChars: migratedStyleChars };
}
