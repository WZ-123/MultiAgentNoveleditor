'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { paths } = require('../store/paths');

function getPlatformAssetPattern() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') {
    return { ext: '.dmg', pattern: /\.dmg$/ };
  }
  if (platform === 'win32') {
    return { ext: '.exe', pattern: /\.exe$/ };
  }
  return { ext: '.AppImage', pattern: /\.AppImage$/ };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function downloadUpdate(release, version) {
  const { pattern, ext } = getPlatformAssetPattern();
  const asset = release.assets?.find((a) => pattern.test(a.name));
  if (!asset) {
    throw new Error(`未找到适用于当前平台 (${process.platform}) 的安装包`);
  }

  const updateDir = ensureDir(path.join(paths().root, 'updates'));
  const fileName = `MultiAgentNovelAssistant-${version}${ext}`;
  const filePath = path.join(updateDir, fileName);

  // Skip if already downloaded
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.size > 0) {
      return { downloaded: true, filePath, skipped: true };
    }
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    const req = https.get(asset.browser_download_url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (!loc) { reject(new Error('Redirect without location')); return; }
        https.get(loc, (res2) => {
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve({ downloaded: true, filePath }); });
        }).on('error', (err) => { fs.unlink(filePath, () => {}); reject(err); });
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve({ downloaded: true, filePath }); });
    });
    req.on('error', (err) => { fs.unlink(filePath, () => {}); reject(err); });
    req.setTimeout(120000, () => { req.destroy(); fs.unlink(filePath, () => {}); reject(new Error('Download timeout')); });
  });
}

module.exports = { downloadUpdate, getPlatformAssetPattern };
