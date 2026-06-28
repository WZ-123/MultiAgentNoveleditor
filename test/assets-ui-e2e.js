'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const novelData = require(path.join(ROOT, 'src/main/store/novelData'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));
  const mcpClient = require(path.join(ROOT, 'src/main/mcp/mcpClientStdio'));

  const tmpRoot = path.join(ROOT, 'tmp-test-assets-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });
  const entry = await novelsStore.createNovel({ title: '资产管理 UI 验收小说', dir });
  const np = novelPaths(dir);

  await novelData.writeCharacter(dir, { id: 'hero', name: '主角' });
  await novelData.writeCharacter(dir, { id: 'rival', name: '对手' });
  await fs.writeFile(np.assetsMain, JSON.stringify({
    schemaVersion: 1,
    assets: [{
      id: 'moon-key',
      name: '月钥',
      type: '钥匙',
      description: '旧资产索引中的关键物品',
      exclusive: true,
      grantedTo: [
        { charId: 'hero', at: '2026-01-01T00:00:00.000Z', note: '初始持有' },
        { charId: 'rival', at: '2026-01-02T00:00:00.000Z', note: '制造审计问题' },
      ],
    }],
  }, null, 2), 'utf8');

  await novelsStore.openNovel(entry.id);
  await mcpClient.setActiveNovel(entry.id, dir);
  return { entry, cleanupRoot: tmpRoot };
}

async function runAssetsUiRegressionTest(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total += 1;
    results.passed += 1;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total += 1;
    results.failed += 1;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  let cleanupRoot = '';
  try {
    const seeded = await seedNovel(ROOT);
    cleanupRoot = seeded.cleanupRoot;
    pass('AUI1_seed_novel', seeded.entry.id);

    try {
      mainWindow.setSize(1280, 820);
      mainWindow.show();
      mainWindow.focus();
    } catch {}

    await delay(800);
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(seeded.entry.id)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        async function waitFor(predicate, message, timeout = 18000) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            const value = await predicate();
            if (value) return value;
            await sleep(120);
          }
          throw new Error(message);
        }
        const clickButton = (label, index = 0) => {
          const buttons = Array.from(document.querySelectorAll('button')).filter((item) => (item.textContent || '').includes(label));
          const button = buttons[index];
          if (!button) throw new Error('button not found: ' + label);
          const rect = button.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) throw new Error('button not visible: ' + label);
          button.click();
          return true;
        };
        const fillPrompt = async (value) => {
          const input = await waitFor(() => document.querySelector('input'), 'prompt input not found');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(80);
          clickButton('确定');
        };
        const openDataTab = async (label) => {
          await waitFor(() => Array.from(document.querySelectorAll('button')).some((button) => {
            if ((button.textContent || '').trim() !== '打开') return false;
            return (button.parentElement?.textContent || '').includes(label);
          }), 'data row not visible: ' + label);
          const button = Array.from(document.querySelectorAll('button')).find((item) => {
            if ((item.textContent || '').trim() !== '打开') return false;
            return (item.parentElement?.textContent || '').includes(label);
          });
          button.click();
        };

        await window.mana.novel.open(novelId);
        await waitFor(async () => {
          const active = await window.mana.novel.active().catch(() => null);
          if (active?.id !== novelId) {
            await window.mana.novel.open(novelId).catch(() => null);
            return false;
          }
          const body = document.body.innerText || '';
          return body.includes('资产管理 UI 验收小说') || body.includes('资产/物品');
        }, 'novel not visible', 30000);
        await openDataTab('资产/物品');
        await waitFor(() => (document.body.innerText || '').includes('月钥'), 'legacy asset not visible after migration');
        const requiredButtons = ['新建资产', '审计资产', '编辑 JSON', '授权', '回收'].every((label) =>
          Array.from(document.querySelectorAll('button')).some((button) => (button.textContent || '').includes(label) && button.getBoundingClientRect().width > 0)
        );
        if (!requiredButtons) throw new Error('asset action buttons not visible');

        clickButton('审计资产');
        await waitFor(() => (document.body.innerText || '').includes('资产审计问题') && (document.body.innerText || '').includes('独占资产'), 'asset audit issues not visible');

        clickButton('新建资产');
        await fillPrompt('sun-token');
        await fillPrompt('太阳徽记');
        await waitFor(() => (document.body.innerText || '').includes('太阳徽记'), 'created asset not visible');

        const assetsAfterCreate = await window.mana.novel.listAssets(novelId);
        const created = assetsAfterCreate.find((asset) => asset.id === 'sun-token');
        if (!created) throw new Error('created asset not persisted');

        const tokenCard = Array.from(document.querySelectorAll('div')).find((node) => (node.textContent || '').includes('太阳徽记') && (node.textContent || '').includes('当前无活跃持有人'));
        if (!tokenCard) throw new Error('created asset card not found');
        const grantButton = Array.from(tokenCard.querySelectorAll('button')).find((button) => (button.textContent || '').includes('授权'));
        if (!grantButton) throw new Error('created asset grant button not found');
        grantButton.click();
        await fillPrompt('hero');
        await waitFor(() => (document.body.innerText || '').includes('资产授权已保存'), 'grant feedback not visible');

        const assetsAfterGrant = await window.mana.novel.listAssets(novelId);
        const tokenAfterGrant = assetsAfterGrant.find((asset) => asset.id === 'sun-token');
        if (!tokenAfterGrant?.grantedTo?.some((entry) => entry.charId === 'hero' && entry.revoked !== true)) throw new Error('grant not persisted');

        const refreshedTokenCard = Array.from(document.querySelectorAll('div')).find((node) => (node.textContent || '').includes('太阳徽记') && (node.textContent || '').includes('当前持有人'));
        const revokeButton = Array.from(refreshedTokenCard.querySelectorAll('button')).find((button) => (button.textContent || '').includes('回收'));
        revokeButton.click();
        await fillPrompt('hero');
        await waitFor(() => (document.body.innerText || '').includes('资产回收已保存'), 'revoke feedback not visible');
        const assetsAfterRevoke = await window.mana.novel.listAssets(novelId);
        const tokenAfterRevoke = assetsAfterRevoke.find((asset) => asset.id === 'sun-token');
        if (!tokenAfterRevoke?.grantedTo?.some((entry) => entry.charId === 'hero' && entry.revoked === true)) throw new Error('revoke not persisted');

        return { ok: true, assetCount: assetsAfterRevoke.length };
      })()
    `);

    if (result?.ok) pass('AUI2_assets_visible_interactive_persistent', `assets=${result.assetCount}`);
    else fail('AUI2_assets_visible_interactive_persistent', JSON.stringify(result));
  } catch (err) {
    fail('AUI_harness', err?.stack || err?.message || String(err));
  } finally {
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runAssetsUiRegressionTest };
