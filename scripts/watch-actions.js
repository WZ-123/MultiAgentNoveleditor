#!/usr/bin/env node
'use strict';

/**
 * Watch GitHub Actions release workflow and report failures.
 *
 * Usage:
 *   node scripts/watch-actions.js
 *
 * Expects `.github-token` in repo root (gitignored).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_PATH = path.join(ROOT, '.github-token');
const POLL_INTERVAL_MS = 15000;
const MAX_WAIT_MINUTES = 30;

function gitRemote() {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8', cwd: ROOT }).trim();
    const m = url.match(/github\.com[\/:]([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (!m) throw new Error('Cannot parse remote URL: ' + url);
    return { owner: m[1], repo: m[2] };
  } catch (e) {
    console.error('Failed to get git remote:', e.message);
    process.exit(1);
  }
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error(`Token file not found: ${TOKEN_PATH}`);
    console.error('Create it with your GitHub Personal Access Token.');
    process.exit(1);
  }
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

function githubApi(apiPath, token, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'mana-watch-script',
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

async function getLatestRun(owner, repo, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/actions/runs?per_page=1`, token);
  return data.workflow_runs?.[0] || null;
}

async function getRunJobs(owner, repo, token, runId) {
  const data = await githubApi(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, token);
  return data.jobs || [];
}

async function getJobLogs(owner, repo, token, jobId) {
  // GitHub redirects to a log URL; follow redirect manually
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'mana-watch-script',
        'Accept': 'application/vnd.github.v3+json',
      },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error('Redirect without location'));
          return;
        }
        // Follow redirect
        const parsed = new URL(redirectUrl);
        const redReq = https.request({
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { 'User-Agent': 'mana-watch-script' },
        }, (redRes) => {
          let data = '';
          redRes.on('data', chunk => data += chunk);
          redRes.on('end', () => resolve(data));
        });
        redReq.on('error', reject);
        redReq.end();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

function extractErrors(logText) {
  const lines = logText.split('\n');
  const errors = [];
  for (const line of lines) {
    if (line.includes('error:') || line.includes('Error:') || line.includes('ERROR:') || line.includes('FAILED')) {
      errors.push(line.trim());
    }
  }
  return errors.slice(0, 20);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const { owner, repo } = gitRemote();
  const token = loadToken();

  console.log(`Watching ${owner}/${repo} release workflow...\n`);

  const startTime = Date.now();
  let run = null;

  while (Date.now() - startTime < MAX_WAIT_MINUTES * 60 * 1000) {
    run = await getLatestRun(owner, repo, token);

    if (!run) {
      console.log('No runs found yet, waiting...');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${elapsed}s] Run #${run.run_number} | Status: ${run.status} | Conclusion: ${run.conclusion || 'N/A'}`);

    if (run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting') {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (run.conclusion === 'success') {
      console.log('\nBuild succeeded!');
      console.log(`Artifacts: ${run.html_url}`);
      process.exit(0);
    }

    if (run.conclusion === 'failure' || run.conclusion === 'cancelled') {
      console.log(`\nBuild ${run.conclusion}. Fetching logs...\n`);
      const jobs = await getRunJobs(owner, repo, token, run.id);
      for (const job of jobs) {
        if (job.conclusion === 'failure' || job.conclusion === 'cancelled') {
          console.log(`--- Job: ${job.name} (${job.conclusion}) ---`);
          try {
            const logs = await getJobLogs(owner, repo, token, job.id);
            const errors = extractErrors(logs);
            if (errors.length > 0) {
              errors.forEach(e => console.log(e));
            } else {
              console.log('(no obvious error lines found in log)');
            }
          } catch (err) {
            console.log(`Failed to fetch logs: ${err.message}`);
          }
          console.log();
        }
      }
      console.log(`Full logs: ${run.html_url}`);
      process.exit(1);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.log('\nTimed out waiting for workflow to complete.');
  process.exit(1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
