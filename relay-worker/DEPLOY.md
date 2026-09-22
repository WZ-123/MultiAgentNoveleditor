# Relay V2 deployment

Relay V2 has one routing and authorization implementation:
`src/relay-core.cjs`. `src/index.js` is the Cloudflare adapter and
`src/scf-entry.cjs` is the Tencent SCF adapter. Do not paste or fork either
adapter into another hand-maintained server.

## Security model

- The desktop package contains only the HTTPS Relay URL and public ES256 JWKS.
- Access tokens live for 15 minutes and remain in desktop memory only.
- Offline leases live for at most seven days and are encrypted with Electron
  `safeStorage`.
- `/api/v1/auth/verify` and the two V1 feedback routes always return HTTP 426
  `upgrade_required`; there is no shared-key compatibility path.
- Relay private keys, Feishu credentials and the auth-code pepper live only in
  the platform secret store.

## Required secrets

Configure these values independently on Cloudflare and Tencent SCF:

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_APP_TOKEN
FEISHU_AUTH_TABLE_ID
FEISHU_TABLE_ID
RELAY_SIGNING_KID
RELAY_SIGNING_PRIVATE_JWK
RELAY_PUBLIC_JWKS
RELAY_ISSUER
RELAY_AUTH_CODE_PEPPER
RELAY_REDIS_URL
```

`RELAY_ISSUER` must equal the release `relayBaseUrl`. Keep active and next
public keys in `RELAY_PUBLIC_JWKS`; retain a previous verification key for at
least one seven-day Offline Lease period after rotation.

For local development, copy `.dev.vars.example` to the ignored `.dev.vars` and
run `node ../scripts/start-real-feishu-relay.js`. Never commit `.dev.vars`.

## Cloudflare

Use Node 24.19.0, install with `npm ci`, run `npm test` and
`npm run deploy:dry-run`, then add each secret with `wrangler secret put`.
Production deployment is performed only by the protected
`.github/workflows/deploy-relay.yml` environment.

Bind a D1 database as `RELAY_DB` and apply `migrations/` before traffic is
enabled. Missing D1 state fails closed; in-memory rate limits are never used in
production.

## Tencent SCF

Package exactly these files:

```text
src/relay-core.cjs
src/scf-entry.cjs
```

Set the function handler to `src/scf-entry.main_handler`, configure the same
secret set plus a TLS `RELAY_REDIS_URL`, and use API Gateway binary-safe request forwarding. Do not deploy
the local HTTP adapter under `scripts/`.

## Verification

Run the shared contract test for both platform adapters, then set
`RELAY_TEST_BASE_URL` and a protected `RELAY_TEST_AUTH_CODE` and run:

```bash
npm run test:deployed
```

The smoke verifies V2 health, the V1 tombstone and session exchange. Logs must
contain only stable error codes and diagnostic IDs, never bodies, tokens,
credentials or Feishu response text.
