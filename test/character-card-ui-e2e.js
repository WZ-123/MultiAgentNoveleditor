'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-character-card-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const dir = path.join(tmpRoot, 'novel-' + Date.now());
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: '角色卡 UI 验收小说', dir });
  const np = novelPaths(dir);

  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), '# 第一章\n\n吴老狗出场，楚岚与其对峙。', 'utf8');

  const wuRaw = {
    id: 'wu-laogou',
    name: '吴老狗',
    aliases: ['仙公', '吴老狗', '老登'],
    faction: '邪修-厉鬼',
    role: '反派-厉鬼',
    attributes: {
      生前身份: '80年代流窜于闽赣交界山区的卖货郎。四十来岁，穿藏蓝色涤卡中山装，推一辆锈迹斑斑的永久牌自行车，车后架竹筐上层摆针头线脑，下层藏染血邪修残卷',
      外貌: '右脸有块烫伤疤痕（偷看寡妇洗澡被泼开水所致）。死后以霉菌/菌丝形态存在，真身为一摊长着半张童脸的鲜红血肉夹杂黑色菌丝',
      语言特点: '闽南方言（闽赣交界口音），如后生仔、正港真仙等。记忆残缺导致声音乱码，像信号不良的老式收音机',
      现存形态: '菌丝体寄居于废弃山庙，吞噬前往该地的孩童魂魄，以此为根基从怨鬼晋升为半步厉鬼',
      自称: '仙公',
    },
    bio: '吴老狗，80年代流窜于闽赣交界山区的卖货郎。死后化为怨鬼，盘踞在废弃山庙中四十余年。被困在山庙中的吴老狗以菌丝形态苟延残喘，渴望吞噬活人以补全自己缺失的记忆和人格。',
    relationships: [],
    arc: { status: 'active', 当前阶段: '被楚岚重创但未被彻底消灭，真身是否已灭存疑' },
  };

  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'char-mozhzdvn.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'char-mozhzdvn',
    __raw: JSON.stringify(wuRaw) + '}',
    aliases: ['吴老狗'],
    attributes: {
      自称: '自称为仙公',
      现存形态: '菌丝体寄居于废弃山庙，吞噬前往该地的孩童魂魄，以此为根基从怨鬼晋升为半步厉鬼',
    },
    bio: '吴老狗被楚岚重创但未被彻底消灭。',
  }, null, 2), 'utf8');

  await fs.writeFile(path.join(np.characters, 'chu-lan.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'chu-lan',
    name: '楚岚',
    role: '主角',
    appearance: '山东青岛人，崂山道门传人，常以白花蛇草水、青岛啤酒和黑面大雷公驱邪。',
    personality: '重情重义，讲科学，幽默，把道术和现代技术混用，不迷信教条。',
    background: '楚岚原本是程序员，失业后翻出家传崂山道门典籍，自学驱鬼，还开直播。',
    quotes: '因为科学和道术，好用的就是好法子。',
    attributes: {
      驱魔标配: '崂山白花蛇草水、青岛啤酒、桃木剑、备用手枪',
      战斗风格: '先用科技手段侦查取证，再以氙灯和黑面雷公压制',
    },
    bio: '楚岚失业后回家翻出道门典籍，自学驱鬼，还开直播。',
  }, null, 2), 'utf8');

  return { entry, cleanupRoot: tmpRoot };
}

async function runCharacterCardUiE2E(mainWindow) {
  const ROOT = path.resolve(__dirname, '..');
  let cleanupRoot = '';

  await delay(1500);

  const results = { total: 0, passed: 0, failed: 0 };
  function pass(name, detail) {
    results.total++; results.passed++;
    console.log(`TEST_PASS ${name}${detail ? ': ' + detail : ''}`);
  }
  function fail(name, reason) {
    results.total++; results.failed++;
    console.log(`TEST_FAIL ${name}: ${reason}`);
  }

  let entry = null;
  try {
    const seeded = await seedNovel(ROOT);
    entry = seeded.entry;
    cleanupRoot = seeded.cleanupRoot;
    pass('CHAR_ui_seed_novel', entry.id);
  } catch (err) {
    fail('CHAR_ui_seed_novel', err.message || String(err));
    console.log('');
    console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
    console.log('TEST_DONE');
    return results;
  }

  try {
    const r = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const novelId = ${JSON.stringify(entry.id)};
        await window.mana.novel.open(novelId);

        const startedAt = Date.now();
        let opened = false;
        let snapshot = { body: '' };

        while (Date.now() - startedAt < 15000) {
          const bodyText = document.body.innerText || '';
          const buttons = Array.from(document.querySelectorAll('button'));
          const openButtons = buttons.filter((button) => button.textContent.trim() === '打开');
          const characterOpen = openButtons.find((button) => {
            const rowText = button.parentElement?.textContent || '';
            return rowText.includes('角色卡');
          });
          if (!opened && characterOpen) {
            characterOpen.click();
            opened = true;
          }

          snapshot = {
            body: bodyText,
            hasTitle: bodyText.includes('角色卡 (2)'),
            hasWu: bodyText.includes('吴老狗'),
            hasChu: bodyText.includes('楚岚'),
            hasDetailLabel: bodyText.includes('细节:'),
            hasArchiveLabel: bodyText.includes('档案:'),
            hasWuNarrative: bodyText.includes('被困在山庙中的吴老狗以菌丝形态苟延残喘'),
            hasWuDetail: bodyText.includes('现存形态:') && bodyText.includes('菌丝体寄居于废弃山庙'),
            hasChuDetail: bodyText.includes('驱魔标配:') && bodyText.includes('崂山白花蛇草水'),
            hasChuQuote: bodyText.includes('因为科学和道术，好用的就是好法子。'),
          };

          if (
            snapshot.hasTitle &&
            snapshot.hasWu &&
            snapshot.hasChu &&
            snapshot.hasDetailLabel &&
            snapshot.hasArchiveLabel &&
            snapshot.hasWuNarrative &&
            snapshot.hasWuDetail &&
            snapshot.hasChuDetail &&
            snapshot.hasChuQuote
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        return {
          ...snapshot,
          ok: snapshot.hasTitle && snapshot.hasWu && snapshot.hasChu && snapshot.hasDetailLabel && snapshot.hasArchiveLabel && snapshot.hasWuNarrative && snapshot.hasWuDetail && snapshot.hasChuDetail && snapshot.hasChuQuote,
        };
      })()
    `);

    if (r?.ok) {
      pass('CHAR_ui_card_content', 'legacy card and clean card both rendered with detail/archive text');
    } else {
      fail('CHAR_ui_card_content', JSON.stringify({
        hasTitle: r?.hasTitle,
        hasWu: r?.hasWu,
        hasChu: r?.hasChu,
        hasDetailLabel: r?.hasDetailLabel,
        hasArchiveLabel: r?.hasArchiveLabel,
        hasWuNarrative: r?.hasWuNarrative,
        hasWuDetail: r?.hasWuDetail,
        hasChuDetail: r?.hasChuDetail,
        hasChuQuote: r?.hasChuQuote,
        body: r?.body?.slice(0, 1200),
      }));
    }
  } catch (err) {
    fail('CHAR_ui_card_content', err.message || String(err));
  }

  try {
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failure
  }

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runCharacterCardUiE2E };