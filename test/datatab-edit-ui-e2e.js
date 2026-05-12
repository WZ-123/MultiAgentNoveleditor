'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedNovel(ROOT) {
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));
  const { novelPaths } = require(path.join(ROOT, 'src/main/store/paths'));

  const tmpRoot = path.join(ROOT, 'tmp-test-datatab-ui');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  const dir = path.join(tmpRoot, `novel-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });

  const entry = await novelsStore.createNovel({ title: 'DataTab 编辑保存 UI 验收小说', dir });
  const np = novelPaths(dir);

  await fs.mkdir(np.characters, { recursive: true });
  await fs.writeFile(path.join(np.characters, 'hero.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'hero',
    name: '主角',
    role: '主角',
    personality: '初始性格',
  }, null, 2), 'utf8');

  await fs.mkdir(np.world, { recursive: true });
  await fs.writeFile(np.worldLore, '# 初始世界观\n\n旧内容', 'utf8');
  await fs.writeFile(np.worldPlaces, JSON.stringify({ places: [{ name: '旧城', type: '城市', description: '旧地点' }] }, null, 2), 'utf8');
  await fs.writeFile(np.worldMeta, JSON.stringify({ schemaVersion: 1 }, null, 2), 'utf8');

  await fs.mkdir(np.timeline, { recursive: true });
  await fs.writeFile(np.timelineEvents, `${JSON.stringify({
    schemaVersion: 1,
    id: 'evt-1',
    when: '第一天',
    description: '旧事件',
    participants: ['hero'],
    ts: new Date().toISOString(),
  })}\n`, 'utf8');

  await fs.mkdir(np.style, { recursive: true });
  await fs.writeFile(np.styleMemory, '旧文风记录', 'utf8');

  await fs.mkdir(np.outlines, { recursive: true });
  await fs.writeFile(np.outlineMaster, '# 旧大纲\n\n旧内容', 'utf8');
  await fs.writeFile(np.outlineMain, '# 旧大纲\n\n旧内容', 'utf8');

  await fs.mkdir(np.chapters, { recursive: true });
  await fs.writeFile(path.join(np.chapters, 'chapter-001.md'), '# 第一章\n\n正文。', 'utf8');

  return { entry, cleanupRoot: tmpRoot };
}

async function runDataTabEditUiE2E(mainWindow) {
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
    pass('DATATAB_ui_seed_novel', entry.id);
  } catch (err) {
    fail('DATATAB_ui_seed_novel', err.message || String(err));
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

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        async function openDataTab(label) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 15000) {
            const buttons = Array.from(document.querySelectorAll('button'));
            const openButton = buttons.find((button) => {
              if (button.textContent.trim() !== '打开') return false;
              const rowText = button.parentElement?.textContent || '';
              return rowText.includes(label);
            });
            if (openButton) {
              openButton.click();
              await sleep(400);
              return true;
            }
            await sleep(250);
          }
          return false;
        }

        async function saveViaEditor(nextText) {
          const editButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('编辑'));
          if (!editButton) throw new Error('edit button not found');
          editButton.click();
          await sleep(200);

          const textarea = document.querySelector('textarea');
          if (!textarea) throw new Error('editor textarea not found');
          const proto = HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(textarea, nextText);
          else textarea.value = nextText;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(100);

          const saveButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('保存'));
          if (!saveButton) throw new Error('save button not found');
          saveButton.click();
          await sleep(800);
          return document.body.innerText || '';
        }

        const openedCharacters = await openDataTab('角色卡');
        if (!openedCharacters) throw new Error('failed to open characters tab');
        const charsBody = await saveViaEditor(JSON.stringify([
          { id: 'hero', name: '主角', role: '主角', personality: 'UI保存后的性格' },
          { id: 'new-role', name: '新角色', role: '配角' }
        ], null, 2));

        const openedWorld = await openDataTab('世界观');
        if (!openedWorld) throw new Error('failed to open world tab');
        const worldBody = await saveViaEditor(JSON.stringify({
          lore: '# UI新世界观\\n\\n这里是新内容',
          places: [{ name: '新城', type: '城市', description: 'UI新增地点' }]
        }, null, 2));

        const openedTimeline = await openDataTab('时间线');
        if (!openedTimeline) throw new Error('failed to open timeline tab');
        const timelineBody = await saveViaEditor(JSON.stringify([
          { id: 'evt-ui-1', when: '第二天', description: 'UI新事件', participants: ['hero'] }
        ], null, 2));

        const openedOutline = await openDataTab('大纲');
        if (!openedOutline) throw new Error('failed to open outline tab');
        const outlineBody = await saveViaEditor('# UI新大纲\\n\\n第一节');

        const openedStyle = await openDataTab('文风');
        if (!openedStyle) throw new Error('failed to open style tab');
        const styleBody = await saveViaEditor('UI新的文风记录');

        const [characters, world, timeline, style, active] = await Promise.all([
          window.mana.novel.listCharacters(novelId),
          window.mana.novel.readWorld(novelId),
          window.mana.novel.listTimeline(novelId),
          window.mana.novel.readStyleMemory(novelId),
          window.mana.novel.active(),
        ]);
        const outlineText = await window.mana.fs.readFile(active.dir + '/outlines/outline.md', 'utf8');

        return {
          charsUiSaved: charsBody.includes('UI保存后的性格') && charsBody.includes('新角色'),
          worldUiSaved: worldBody.includes('UI新世界观') && worldBody.includes('新城'),
          timelineUiSaved: timelineBody.includes('UI新事件'),
          outlineUiSaved: outlineBody.includes('UI新大纲'),
          styleUiSaved: styleBody.includes('UI新的文风记录'),
          charactersRoundtrip: Array.isArray(characters) && characters.some((item) => item.id === 'hero' && item.personality === 'UI保存后的性格') && characters.some((item) => item.id === 'new-role') && !characters.some((item) => item.description === '旧角色'),
          worldRoundtrip: world?.lore?.includes('UI新世界观') && Array.isArray(world?.places) && world.places.some((item) => item.name === '新城'),
          timelineRoundtrip: Array.isArray(timeline) && timeline.length === 1 && timeline[0]?.description === 'UI新事件',
          outlineRoundtrip: outlineText.includes('UI新大纲'),
          styleRoundtrip: style === 'UI新的文风记录',
          body: document.body.innerText || '',
          characters,
          world,
          timeline,
          outlineText,
          style,
        };
      })()
    `);

    if (r?.charsUiSaved && r?.worldUiSaved && r?.timelineUiSaved && r?.outlineUiSaved && r?.styleUiSaved) {
      pass('DATATAB_ui_edit_surface', 'all tabs accepted edited content through the UI');
    } else {
      fail('DATATAB_ui_edit_surface', JSON.stringify(r));
    }

    if (r?.charactersRoundtrip && r?.worldRoundtrip && r?.timelineRoundtrip && r?.outlineRoundtrip && r?.styleRoundtrip) {
      pass('DATATAB_ui_roundtrip', 'all tabs reloaded latest saved content');
    } else {
      fail('DATATAB_ui_roundtrip', JSON.stringify(r));
    }
  } catch (err) {
    fail('DATATAB_ui_harness', err.message || String(err));
  }

  try {
    if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
  } catch {}

  console.log('');
  console.log(`TEST_SUMMARY ${results.passed}/${results.total} passed, ${results.failed} failed`);
  console.log('TEST_DONE');
  return results;
}

module.exports = { runDataTabEditUiE2E };