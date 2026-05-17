'use strict';

const { dialog, app, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const appConfig = require('../store/appConfig');
const { downloadUpdate } = require('./downloadManager');

const OWNER = 'WZ-123';
const REPO = 'MultiAgentNovelAssistant';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      LATEST_RELEASE_URL,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${REPO}-updater` } },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (!loc) { reject(new Error('Redirect without location')); return; }
          https.get(loc, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${REPO}-updater` } }, (res2) => {
            const chunks = [];
            res2.on('data', (c) => chunks.push(c));
            res2.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); }
            });
          }).on('error', reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function checkForUpdates(options = {}) {
  const { silent = false, force = false } = options;
  const current = app.getVersion();
  const cfg = await appConfig.load();
  const updaterCfg = cfg.updater || {};

  // Respect skip version
  if (!force && updaterCfg.skipVersion) {
    try {
      const release = await fetchLatestRelease();
      const latest = release.tag_name.replace(/^v/, '');
      if (latest === updaterCfg.skipVersion) {
        return { hasUpdate: false, reason: 'skipped' };
      }
    } catch {
      // ignore fetch error for skip check
    }
  }

  // Respect check interval in silent mode
  if (silent && updaterCfg.lastCheckAt) {
    const last = new Date(updaterCfg.lastCheckAt).getTime();
    if (Date.now() - last < CHECK_INTERVAL_MS) {
      return { hasUpdate: false, reason: 'too_soon' };
    }
  }

  let release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    if (!silent) {
      dialog.showErrorBox('更新检测失败', `无法获取最新版本信息：${err.message}`);
    }
    return { hasUpdate: false, error: err.message };
  }

  // Save check time
  await appConfig.save({ updater: { ...updaterCfg, lastCheckAt: new Date().toISOString() } });

  const latest = release.tag_name.replace(/^v/, '');
  if (!semverGt(latest, current)) {
    if (!silent) {
      dialog.showMessageBox({ type: 'info', title: '已是最新版本', message: `当前版本 ${current} 已是最新。` });
    }
    return { hasUpdate: false, current, latest };
  }

  // Show update prompt
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'info',
    title: '新版本可用',
    message: `发现新版本 ${latest}`,
    detail: `当前版本：${current}\n最新版本：${latest}\n\n发布说明：${release.body?.slice(0, 200) || '无'}`,
    checkboxLabel: '自动下载并安装更新',
    checkboxChecked: updaterCfg.autoDownload || false,
    buttons: ['前往下载', '稍后提醒', '跳过此版本'],
    defaultId: 0,
    cancelId: 1,
  });

  // Save autoDownload preference
  if (checkboxChecked !== updaterCfg.autoDownload) {
    await appConfig.save({ updater: { ...updaterCfg, autoDownload: checkboxChecked } });
  }

  if (response === 2) {
    // Skip this version
    await appConfig.save({ updater: { ...updaterCfg, skipVersion: latest } });
    return { hasUpdate: true, skipped: true, current, latest };
  }

  if (response === 1) {
    // Remind later
    return { hasUpdate: true, current, latest };
  }

  if (checkboxChecked) {
    // Auto download
    try {
      const result = await downloadUpdate(release, latest);
      if (result.downloaded) {
        const { response: installResponse } = await dialog.showMessageBox({
          type: 'info',
          title: '更新已下载',
          message: `新版本 ${latest} 已下载到本地`,
          detail: `文件位置：${result.filePath}`,
          buttons: ['立即安装', '稍后安装'],
          defaultId: 0,
        });
        if (installResponse === 0) {
          await installUpdate(result.filePath);
        }
      }
    } catch (err) {
      dialog.showErrorBox('下载失败', `自动下载更新失败：${err.message}，请前往 GitHub Release 页面手动下载。`);
      shell.openExternal(release.html_url);
    }
  } else {
    // Manual download: open browser
    shell.openExternal(release.html_url);
  }

  return { hasUpdate: true, current, latest };
}

async function installUpdate(filePath) {
  const { shell } = require('electron');
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: spawn the installer
    const { spawn } = require('node:child_process');
    spawn(filePath, [], { detached: true, shell: true });
    app.quit();
  } else if (platform === 'darwin') {
    // macOS: open the dmg
    shell.openPath(filePath);
  } else {
    // Linux: open the AppImage
    shell.openPath(filePath);
  }
}

module.exports = { checkForUpdates, installUpdate, fetchLatestRelease };
