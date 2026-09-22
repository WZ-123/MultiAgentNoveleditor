'use strict';

let sharedClient = null;
let sharedUrl = '';

function clientFor(url) {
  if (!url) return null;
  if (sharedClient && sharedUrl === url) return sharedClient;
  // Loaded only by the SCF adapter; the Cloudflare bundle never imports this
  // module and therefore never includes Node TCP support.
  const Redis = require('ioredis');
  sharedClient = new Redis(url, {
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: null,
    tls: url.startsWith('rediss:') ? {} : undefined,
  });
  sharedUrl = url;
  return sharedClient;
}

function createScfRedisRelayState(url, options = {}) {
  const redis = options.client || clientFor(String(url || '').trim());
  if (!redis) return null;
  const ready = async () => {
    if (redis.status === 'wait') await redis.connect();
    if (redis.status !== 'ready') throw Object.assign(new Error('relay Redis is unavailable'), { code: 'relay_state_unavailable' });
  };
  return {
    async consume(key, limit, windowSeconds, nowSeconds) {
      await ready();
      const bucket = Math.floor(nowSeconds / windowSeconds);
      const redisKey = `mana:relay:rate:${key}:${bucket}`;
      const count = Number(await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
        1, redisKey, String(windowSeconds * 2),
      ));
      return count <= limit;
    },
    async getIdempotency(key) {
      await ready();
      const raw = await redis.get(`mana:relay:idempotency:${key}`);
      if (!raw) return null;
      if (raw.startsWith('pending:')) return { pending: true };
      if (!raw.startsWith('done:')) return null;
      try { return JSON.parse(raw.slice(5)); } catch { return null; }
    },
    async claimIdempotency(key, token, ttlSeconds) {
      await ready();
      return await redis.set(`mana:relay:idempotency:${key}`, `pending:${token}`, 'EX', ttlSeconds, 'NX') === 'OK';
    },
    async completeIdempotency(key, token, value, ttlSeconds) {
      await ready();
      const result = await redis.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end",
        1,
        `mana:relay:idempotency:${key}`,
        `pending:${token}`,
        `done:${JSON.stringify(value)}`,
        String(ttlSeconds),
      );
      return Number(result) === 1;
    },
    async releaseIdempotency(key, token) {
      await ready();
      await redis.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
        1,
        `mana:relay:idempotency:${key}`,
        `pending:${token}`,
      );
    },
  };
}

module.exports = { createScfRedisRelayState };
