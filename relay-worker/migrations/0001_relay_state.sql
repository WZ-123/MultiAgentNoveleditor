CREATE TABLE IF NOT EXISTS relay_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  claim_token TEXT NOT NULL,
  result_json TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_rate_limits_expiry ON relay_rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS relay_idempotency_expiry ON relay_idempotency(expires_at);
