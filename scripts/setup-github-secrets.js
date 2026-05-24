#!/usr/bin/env node
'use strict';

/**
 * One-shot script to check latest GitHub Actions status, set relay secrets,
 * and optionally re-trigger the workflow.
 *
 * Usage:
 *   node scripts/setup-github-secrets.js
 */

const https = require('https');
const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(q, r)); }

function gitRemote() {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[\/:]([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (!m) throw new Error('Cannot parse remote URL: ' + url);
    return { owner: m[1], repo: m[2] };
  } catch (e) {
    console.error('Failed to get git remote:', e.message);
    process.exit(1);
  }
}

function githubApi(apiPath, token, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'mana-setup-script',
        'Accept': 'application/vnd.github.v3+json',
      },
    };
    if (body) options.headers['Content-Type'] = 'application/json';
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getPublicKey(owner, repo, token) {
  return githubApi(`/repos/${owner}/${repo}/actions/secrets/public-key`, token);
}

function ensureNaclDeps() {
  try {
    return {
      nacl: require('tweetnacl'),
      sealedbox: require('tweetnacl-sealedbox-js'),
    };
  } catch {
    console.log('Installing tweetnacl + tweetnacl-sealedbox-js temporarily...');
    const tmpDir = fs.mkdtempSync('/tmp/mana-nacl-');
    execSync('npm install tweetnacl tweetnacl-sealedbox-js', {
      cwd: tmpDir,
      stdio: 'inherit',
    });
    module.paths.unshift(path.join(tmpDir, 'node_modules'));
    return {
      nacl: require('tweetnacl'),
      sealedbox: require('tweetnacl-sealedbox-js'),
    };
  }
}

function encryptSecret(publicKeyBase64, value) {
  const { sealedbox } = ensureNaclDeps();
  const publicKey = Buffer.from(publicKeyBase64, 'base64');
  const message = Buffer.from(value, 'utf8');
  const encrypted = sealedbox.seal(message, publicKey);
  return Buffer.from(encrypted).toString('base64');
}

async function setSecret(owner, repo, token, name, value, keyId, publicKey) {
  const encryptedValue = encryptSecret(publicKey, value);
  await githubApi(
    `/repos/${owner}/${repo}/actions/secrets/${name}`,
    token,
    'PUT',
    { encrypted_value: encryptedValue, key_id: keyId }
  );
  console.log(`  -> Secret "${name}" set.`);
}

async function getLatestRun(owner, repo, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/actions/runs?per_page=1`, token);
  return data.workflow_runs?.[0] || null;
}

async function reRunWorkflow(owner, repo, token, runId) {
  await githubApi(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, token, 'POST');
  console.log(`Workflow run ${runId} re-triggered.`);
}

async function main() {
  const { owner, repo } = gitRemote();
  console.log(`Repository: ${owner}/${repo}\n`);

  const token = process.env.GITHUB_TOKEN || await ask('Enter GitHub Personal Access Token: ');
  if (!token) {
    console.error('Token is required.');
    process.exit(1);
  }

  // 1. Check latest run
  console.log('\nChecking latest Actions run...');
  const latestRun = await getLatestRun(owner, repo, token);
  if (latestRun) {
    console.log(`  Run #${latestRun.run_number} (${latestRun.name})`);
    console.log(`  Status: ${latestRun.status}, Conclusion: ${latestRun.conclusion || 'N/A'}`);
    console.log(`  URL: ${latestRun.html_url}`);
  } else {
    console.log('  No runs found.');
  }

  // 2. Get public key
  console.log('\nFetching repository public key...');
  const { key_id, key } = await getPublicKey(owner, repo, token);

  // 3. Set secrets
  const relayUrl = 'https://1301861337-iyb2r0f8lz.ap-guangzhou.tencentscf.com';
  const relayApiKey = 'mana-relay-7c5d98a5787f415a62c89277cdeec1fb';

  console.log('\nSetting repository secrets...');
  await setSecret(owner, repo, token, 'RELEASE_RELAY_URL', relayUrl, key_id, key);
  await setSecret(owner, repo, token, 'RELEASE_RELAY_API_KEY', relayApiKey, key_id, key);

  // 4. Auto re-trigger if there is a failed run on current tag
  if (latestRun && latestRun.conclusion === 'failure') {
    console.log('\nLatest run failed, auto re-triggering...');
    await reRunWorkflow(owner, repo, token, latestRun.id);
  }

  rl.close();
  console.log('\nDone. Check https://github.com/' + owner + '/' + repo + '/actions');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
