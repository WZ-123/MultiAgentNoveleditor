#!/usr/bin/env node
'use strict';

/**
 * Upload public release configuration to GitHub Actions without embedding any
 * credential in this repository or exposing values on the command line.
 *
 * Required environment:
 *   GITHUB_REPOSITORY=owner/repository
 *   RELEASE_RELAY_URL=https://relay.example.com
 *   RELEASE_RELAY_JWKS={"keys":[...]}
 *   RELEASE_MINIMUM_CLIENT_VERSION=0.0.9
 *
 * Authentication is delegated to an existing `gh auth login` session or the
 * standard GH_TOKEN environment variable. Secret values are passed over stdin.
 */

const { spawnSync } = require('node:child_process');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePublicJwks(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('RELEASE_RELAY_JWKS must be valid JSON'); }
  if (!Array.isArray(parsed?.keys) || parsed.keys.length === 0) {
    throw new Error('RELEASE_RELAY_JWKS must contain at least one public key');
  }
  for (const key of parsed.keys) {
    if (key?.kty !== 'EC' || key?.crv !== 'P-256' || !key?.kid || !key?.x || !key?.y || key?.d) {
      throw new Error('RELEASE_RELAY_JWKS may contain only public P-256 keys with kid/x/y and no private d value');
    }
  }
  return JSON.stringify({ keys: parsed.keys });
}

function setSecret(repo, name, value) {
  const result = spawnSync('gh', ['secret', 'set', name, '--repo', repo, '--body', '-'], {
    encoding: 'utf8',
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh secret set ${name} failed: ${String(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  process.stdout.write(`Configured ${name}\n`);
}

function main() {
  const repo = required('GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY must be owner/repository');
  const relayUrl = new URL(required('RELEASE_RELAY_URL'));
  if (relayUrl.protocol !== 'https:') throw new Error('RELEASE_RELAY_URL must use HTTPS');
  const jwks = validatePublicJwks(required('RELEASE_RELAY_JWKS'));
  const minimumVersion = required('RELEASE_MINIMUM_CLIENT_VERSION');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(minimumVersion)) {
    throw new Error('RELEASE_MINIMUM_CLIENT_VERSION must be semver');
  }

  setSecret(repo, 'RELEASE_RELAY_URL', relayUrl.toString().replace(/\/$/, ''));
  setSecret(repo, 'RELEASE_RELAY_JWKS', jwks);
  setSecret(repo, 'RELEASE_MINIMUM_CLIENT_VERSION', minimumVersion);
}

try { main(); } catch (error) {
  process.stderr.write(`setup-github-secrets failed: ${error.message}\n`);
  process.exitCode = 1;
}
