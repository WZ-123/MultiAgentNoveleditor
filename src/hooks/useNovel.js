import { useCallback, useEffect, useState } from 'react';
import { migrateLegacyToNovel } from '@/services/legacyMigration.js';

/**
 * Hook for the active novel and the global novel list. Re-fetches when invoked
 * directly via `refresh()`.
 */
export function useNovel() {
  const mana = typeof window !== 'undefined' ? window.mana : null;
  const [novels, setNovels] = useState([]);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [migrationReport, setMigrationReport] = useState(null);

  const refresh = useCallback(async () => {
    if (!mana?.novel) {
      setError('mana.novel bridge unavailable');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [list, current] = await Promise.all([
        mana.novel.list(),
        mana.novel.active(),
      ]);
      setNovels(list || []);
      setActive(current || null);
      setError('');
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [mana]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const open = useCallback(async (id) => {
    if (!mana?.novel) return null;
    const r = await mana.novel.open(id);
    try {
      const report = await migrateLegacyToNovel(id);
      if (report) setMigrationReport({ novelId: id, ...report });
    } catch (err) {
      console.warn('[useNovel] legacy migration failed:', err);
    }
    await refresh();
    return r;
  }, [mana, refresh]);

  const close = useCallback(async () => {
    if (!mana?.novel) return;
    await mana.novel.close();
    await refresh();
  }, [mana, refresh]);

  const create = useCallback(async ({ title, dir }) => {
    if (!mana?.novel) return null;
    const r = await mana.novel.create({ title, dir });
    await refresh();
    return r;
  }, [mana, refresh]);

  const importExisting = useCallback(async (dir) => {
    if (!mana?.novel) return null;
    const r = await mana.novel.importExisting(dir);
    await refresh();
    return r;
  }, [mana, refresh]);

  const remove = useCallback(async (id) => {
    if (!mana?.novel) return;
    await mana.novel.remove(id);
    await refresh();
  }, [mana, refresh]);

  return { novels, active, loading, error, refresh, open, close, create, importExisting, remove, migrationReport };
}
