export function createCloudflareRelayState(database) {
  if (!database?.prepare) return null;
  return {
    async consume(key, limit, windowSeconds, nowSeconds) {
      const bucket = Math.floor(nowSeconds / windowSeconds);
      const bucketKey = `${key}:${bucket}`;
      const row = await database.prepare(`
        INSERT INTO relay_rate_limits (bucket_key, count, expires_at)
        VALUES (?1, 1, ?2)
        ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1
        RETURNING count
      `).bind(bucketKey, (bucket + 2) * windowSeconds).first();
      return Number(row?.count || 0) <= limit;
    },
    async getIdempotency(key, nowSeconds) {
      const row = await database.prepare(`
        SELECT status, result_json AS resultJson
        FROM relay_idempotency
        WHERE idempotency_key = ?1 AND expires_at > ?2
      `).bind(key, nowSeconds).first();
      if (!row) return null;
      if (row.status !== 'done') return { pending: true };
      try { return JSON.parse(String(row.resultJson || '{}')); } catch { return null; }
    },
    async claimIdempotency(key, token, ttlSeconds, nowSeconds) {
      await database.prepare('DELETE FROM relay_idempotency WHERE idempotency_key = ?1 AND expires_at <= ?2')
        .bind(key, nowSeconds).run();
      const result = await database.prepare(`
        INSERT OR IGNORE INTO relay_idempotency
          (idempotency_key, status, claim_token, result_json, expires_at)
        VALUES (?1, 'pending', ?2, NULL, ?3)
      `).bind(key, token, nowSeconds + ttlSeconds).run();
      return Number(result?.meta?.changes || 0) === 1;
    },
    async completeIdempotency(key, token, value, ttlSeconds, nowSeconds) {
      const result = await database.prepare(`
        UPDATE relay_idempotency
        SET status = 'done', result_json = ?3, expires_at = ?4
        WHERE idempotency_key = ?1 AND status = 'pending' AND claim_token = ?2
      `).bind(key, token, JSON.stringify(value), nowSeconds + ttlSeconds).run();
      return Number(result?.meta?.changes || 0) === 1;
    },
    async releaseIdempotency(key, token) {
      await database.prepare(`
        DELETE FROM relay_idempotency
        WHERE idempotency_key = ?1 AND status = 'pending' AND claim_token = ?2
      `).bind(key, token).run();
    },
  };
}
