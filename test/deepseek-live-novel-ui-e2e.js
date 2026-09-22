'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const novelData = require('../src/main/store/novelData');
const novels = require('../src/main/store/novels');
const modelConfig = require('../src/main/modelConfig');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'qa-screenshots');
const CHAPTERS = [
  ['chapter-001.md', '退潮来信'], ['chapter-002.md', '没有寄件人的地址'], ['chapter-003.md', '旧钟楼的回声'],
  ['chapter-004.md', '被删去的七分钟'], ['chapter-005.md', '雨夜投递'], ['chapter-006.md', '灯塔下的证词'],
  ['chapter-007.md', '第二封未来信'], ['chapter-008.md', '逆潮'], ['chapter-009.md', '天亮前的回信'],
];
const LONG_TURN_TIMEOUT = 900_000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function cjkCount(text) { return (String(text || '').match(/[\u3400-\u9fff]/gu) || []).length; }

async function screenshot(win, name) {
  await fsp.mkdir(SHOTS, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(SHOTS, name);
  await fsp.writeFile(file, image.toPNG());
  return file;
}

async function waitFor(win, expression, timeout = 300_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(200);
  }
  const uiError = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="codex-error"]')?.innerText || ''`, true).catch(() => '');
  throw new Error(`UI wait timed out: ${expression}${uiError ? `; UI error: ${uiError}` : ''}`);
}

async function assistantCount(win) {
  return win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="codex-message-assistant"]').length`, true);
}

async function send(win, text, skillName) {
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]') && !document.querySelector('[data-testid="codex-input"]').disabled && !document.querySelector('button[aria-label="停止"]')`);
  const before = await assistantCount(win);
  await win.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new CustomEvent('mana:codex-prompt', { detail: { text: ${JSON.stringify(text)}, skillName: ${JSON.stringify(skillName || '')} } }));
  })()`, true);
  await waitFor(win, `document.querySelector('[data-testid="codex-input"]').value.length > 0`);
  await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送"]').click()`, true);
  await waitFor(win, `document.querySelector('button[aria-label="停止"]')`);
  return before;
}

async function waitForAssistant(win, before, timeout = 300_000) {
  await waitFor(win, `document.querySelector('[data-testid="codex-error"]') || (document.querySelectorAll('[data-testid="codex-message-assistant"]').length > ${before} && !document.querySelector('button[aria-label="停止"]'))`, timeout);
  const error = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="codex-error"]')?.innerText || ''`, true);
  if (error) throw new Error(`Codex UI error: ${error}`);
}

async function confirmedTurn(win, { text, skillName, screenshotName, allowNoConfirmation = false }) {
  const startedAt = Date.now();
  const before = await send(win, text, skillName);
  await waitFor(win, `document.querySelector('[data-testid="codex-error"]') || document.querySelector('[data-testid="codex-confirmation-card"]') || (!document.querySelector('button[aria-label="停止"]') && document.querySelectorAll('[data-testid="codex-message-assistant"]').length > ${before})`, LONG_TURN_TIMEOUT);
  const hasCard = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="codex-confirmation-card"]'))`, true);
  if (!hasCard) {
    const reply = await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-message-assistant"]')].at(-1)?.innerText || ''`, true);
    if (allowNoConfirmation) return { wrote: false, reply, durationMs: Date.now() - startedAt };
    throw new Error(`Turn completed without a confirmation card: ${reply.slice(0, 500)}`);
  }
  if (screenshotName) await screenshot(win, screenshotName);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-confirmation-card"] button')].filter((button) => button.innerText.includes('确认写入')).at(-1)?.click()`, true);
  await waitForAssistant(win, before, LONG_TURN_TIMEOUT);
  return { wrote: true, durationMs: Date.now() - startedAt };
}

async function plainTurn(win, { text, skillName }) {
  const startedAt = Date.now();
  const before = await send(win, text, skillName);
  await waitForAssistant(win, before, LONG_TURN_TIMEOUT);
  const reply = await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid="codex-message-assistant"]')].at(-1)?.innerText || ''`, true);
  return { durationMs: Date.now() - startedAt, reply };
}

async function runDeepSeekLiveNovelUiE2E(win) {
  if (process.env.MANA_LIVE_NOVELLA_27 === '1') return require('./deepseek-live-novella-ui-e2e').runDeepSeekLiveNovellaUiE2E(win);
  const results = { passed: 0, failed: 0, screenshots: [], chapterCounts: {} };
  const modelId = (await modelConfig.load()).activeSelection?.modelId;
  if (!modelId) throw new Error('Live acceptance model was not configured');
  const novelId = String(process.env.MANA_LIVE_NOVEL_ID || '');
  const novel = await novels.getNovelById(novelId);
  if (!novel) throw new Error('Live acceptance novel was not prepared');
  const pass = (condition, message) => { if (!condition) throw new Error(message); results.passed += 1; };

  win.setSize(1440, 960);
  win.show();
  await waitFor(win, `document.querySelector('[data-testid="codex-chat-panel"]')`);
  await waitFor(win, `document.querySelector('[data-testid="codex-status"]')?.innerText.includes(${JSON.stringify(modelId)})`);
  pass(true, 'Flash runtime did not become ready');
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="codex-chat-panel"] > div > div button')?.click()`, true);
  await waitFor(win, `[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === '新对话')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.innerText.trim() === '新对话').click()`, true);
  await waitFor(win, `document.querySelectorAll('[data-testid^="codex-message-"]').length === 0 && !document.querySelector('button[aria-label="停止"]')`);

  if (process.env.MANA_LIVE_LATENCY_ONLY === '1') {
    const plainTargetCjk = Math.max(300, Number(process.env.MANA_LIVE_PLAIN_TARGET_CJK) || 500);
    const plainStarted = Date.now();
    await plainTurn(win, {
      text: `写一段约${plainTargetCjk}个汉字的完整中文小说正文，只输出正文。场景：沿海邮局停电后，代理局长在柜台下找到一封受潮的旧信。要有动作、对白和明确变化；不需要计算、报告或复核字数，场景完成即止。`,
    });
    const plainMs = Date.now() - plainStarted;
    const toolStarted = Date.now();
    await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      text: '为延迟验收写一段约500个汉字的小说正文，立即提交到 chapter:chapter-001.md。不要计算、报告或复核字数，场景完成即止；不要读取无关资料，不要提问。资源不存在用 create，若为空占位可用 replace。完成后调用 Codex 原生 apply_patch 并等待确认。',
      screenshotName: 'deepseek-live-latency-confirmation.png',
    });
    const toolMs = Date.now() - toolStarted;
    const content = await novelData.readChapter(novel.dir, 'chapter-001.md');
    const count = cjkCount(content);
    pass(count >= 300 && count <= 900, `latency probe length is invalid: ${count}`);
    await fsp.writeFile(path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'latency-result.json'), JSON.stringify({ modelId, reasoningEffort: 'none', plainMs, toolMs, cjkCount: count, completedAt: new Date().toISOString() }, null, 2));
    console.log(`deepseek-live-latency-ui: ok (plain=${plainMs}ms, tool=${toolMs}ms, cjk=${count})`);
    return results;
  }

  const existingOutline = await novelData.readOutlineMaster(novel.dir);
  if (!existingOutline.includes('退潮来信')) {
    await confirmedTurn(win, {
      skillName: 'mana-outline', screenshotName: 'deepseek-live-outline-confirmation.png',
      text: `为当前小说《潮汐邮局》创建总纲并立即写入 outline:master。不要提问。先读取该资源取得 hash，然后用 Codex 原生 apply_patch 的 replace 模式提交。\n\n类型：现实质感的沿海奇幻悬疑，第三人称限知，克制、具体、避免套话。\n核心设定：临潮镇连续七夜出现“逆潮”，废弃邮筒会吐出写成却从未寄出的信。信在天亮前送达可以改变收信人的一段记忆，但投递者会失去一段同等重量的真实记忆。\n主线：29 岁的临潮邮局代理局长林霁收到失踪十二年的姐姐林汐写给“明天的林霁”的信。潮汐测绘师周既白与退休邮差宋栖卷入调查。林霁逐步发现林汐当年为封住海底旧隧道的潮压裂隙而失踪，宋栖隐瞒了一封关键来信。最终林霁拒绝用抹除姐姐记忆换取虚假的团圆，改为把真相信交给十二年前的自己与全镇，众人共同完成撤离和封隧。\n九章固定映射：1 退潮来信；2 没有寄件人的地址；3 旧钟楼的回声；4 被删去的七分钟；5 雨夜投递；6 灯塔下的证词；7 第二封未来信；8 逆潮；9 天亮前的回信。\n总纲必须写清每章目标、冲突、线索、转折、人物状态与章末钩子，并锁定时间线和伏笔回收。`,
    });
  }
  pass((await novelData.readOutlineMaster(novel.dir)).includes('天亮前的回信'), 'master outline was not written');

  const characters = await novelData.listCharacters(novel.dir);
  if (characters.length < 3) {
    await confirmedTurn(win, {
      skillName: 'mana-character-roleplay', screenshotName: 'deepseek-live-character-world-confirmation.png',
      text: `为《潮汐邮局》建立并立即写入以下小说资料，不要提问。先读取现有资源/列出资源获得当前 hash，再用一次 Codex 原生 apply_patch 原子提交：\n1. character:lin-ji（林霁，29，代理局长；精确、寡言，恐惧遗忘姐姐，行动目标是查明信件来源；包含外貌、履历、欲望、恐惧、秘密、说话习惯、关系和人物弧）；\n2. character:zhou-jibai（周既白，30，潮汐测绘师；林霁旧友，理性但不是冷漠工具人；包含完整人物卡）；\n3. character:song-qi（宋栖，68，退休邮差；隐瞒关键来信源于错误的保护欲；包含完整人物卡）；\n4. world:lore：逆潮、记忆代价、旧隧道、临潮镇邮政史、七夜规则及严格限制；\n5. style:memory：第三人称限知、短中句交替、以动作和物件承载情绪、对白有潜台词、禁止滥用比喻/不是而是/仿佛/难以言喻/总结式升华；\n6. timeline:all：从十二年前台风到七夜逆潮及九章事件的 JSON 数组。\n角色资源不存在时用 create；空白但可读取的 world/style/timeline 用 replace。每张角色卡必须是合法 JSON 且 id 与 resourceRef 一致。`,
    });
  }
  pass((await novelData.listCharacters(novel.dir)).length >= 3, 'character cards were not written');
  pass((await novelData.readWorld(novel.dir)).lore.length > 300, 'world lore was not written');
  pass((await novelData.readStyleMemory(novel.dir)).length > 100, 'style memory was not written');

  for (let index = 0; index < CHAPTERS.length; index += 1) {
    const [fileName, title] = CHAPTERS[index];
    let existing = await novelData.readChapter(novel.dir, fileName).catch(() => '');
    for (let attempt = 0; attempt < 3 && cjkCount(existing) < 2800; attempt += 1) {
      await confirmedTurn(win, {
        // A newly opened editor tab may be either absent or a zero-byte
        // placeholder. Both create and hash-checked replace are safe first
        // writes; the acceptance test asserts confirmation and persisted
        // content instead of pinning Codex's internal choice.
        skillName: 'mana-fiction-writing',
        screenshotName: index === 0 && attempt === 0 ? 'deepseek-live-chapter-1-confirmation.png' : undefined,
        text: `写作并立即提交《潮汐邮局》第${index + 1}章《${title}》，目标资源 chapter:${fileName}。不要提问。由你按需读取相关小说资料和必要的相邻章节，严格承接既有事实；不要为了形式完整而读取全部前文。正文必须是可直接出版的中文小说章节，第三人称限知林霁，包含场景行动、有效对白、线索推进和章末落点。不得写创作说明，不得重复总纲，不得使用“不是……而是……”式解释，不得堆砌比喻。篇幅约3600个中文汉字，不需要计算、报告或复核字数，完成本章场景和落点即止。${existing ? '当前草稿缺少足够完整的场景展开，请保留有效内容，补齐人物进入场景、阻力升级、选择发生及后果落定的动作因果与对白交锋，整体重写后用 Codex 原生 apply_patch；不要靠重复或解释凑篇幅。' : '资源不存在，请用 create。'}完成后调用 Codex 原生 apply_patch 展示完整 diff，等待确认。`,
      });
      existing = await novelData.readChapter(novel.dir, fileName);
    }
    const content = existing || await novelData.readChapter(novel.dir, fileName);
    results.chapterCounts[fileName] = cjkCount(content);
    pass(results.chapterCounts[fileName] >= 2800, `${fileName} is too short: ${results.chapterCounts[fileName]} CJK chars`);
  }

  const chapterTwo = await novelData.readChapter(novel.dir, 'chapter-002.md');
  await confirmedTurn(win, {
    skillName: 'mana-fiction-writing', screenshotName: 'deepseek-live-local-edit-confirmation.png',
    text: `对 chapter:chapter-002.md 做一次真实局部编辑：先读取全文，只精简开头第一段中最拖沓的一处，保留事实、视角和节奏，总改动不超过 80 个汉字。必须使用 Codex 原生 apply_patch 的最小 diff，不能 replace 整章。立即提交并等待确认。`,
  });
  pass((await novelData.readChapter(novel.dir, 'chapter-002.md')) !== chapterTwo, 'local text edit did not change chapter 2');

  const chapterEight = await novelData.readChapter(novel.dir, 'chapter-008.md');
  await confirmedTurn(win, {
    skillName: 'mana-fiction-writing', screenshotName: 'deepseek-live-whole-chapter-rewrite-confirmation.png',
    text: `整章重写 chapter:chapter-008.md《逆潮》。先读取总纲、人物、世界、时间线、第7章、第8章原文和第9章。保持全部既定事实、线索顺序、人物关系和第9章承接点，但让决策冲突更具体、动作因果更清楚、宋栖的选择更可信。篇幅约3600个中文汉字，不需要计算、报告或复核字数，场景完成即止。必须使用 Codex 原生 apply_patch 提交整章 diff 并等待确认。`,
  });
  pass((await novelData.readChapter(novel.dir, 'chapter-008.md')) !== chapterEight, 'whole-chapter rewrite did not change chapter 8');

  const outlineBefore = await novelData.readOutlineMaster(novel.dir);
  await confirmedTurn(win, {
    skillName: 'mana-outline',
    text: `修订 outline:master：先读取总纲和九章正文，在不改变九章标题、核心结局和既有事实的前提下，为每章补充“已落地线索/回收状态”，并修正与成稿不一致的细节。用 Codex 原生 apply_patch 提交，不要改正文。`,
  });
  pass((await novelData.readOutlineMaster(novel.dir)) !== outlineBefore, 'outline revision did not persist');

  const linBefore = JSON.stringify(await novelData.readCharacter(novel.dir, 'lin-ji'));
  await confirmedTurn(win, {
    skillName: 'mana-character-roleplay',
    text: `读取九章成稿和 character:lin-ji，依据实际完成的人物弧更新林霁角色卡中的经历、关系变化、最终认知和仍保留的矛盾，不改写无关字段。用 Codex 原生 apply_patch 提交角色卡并等待确认。`,
  });
  pass(JSON.stringify(await novelData.readCharacter(novel.dir, 'lin-ji')) !== linBefore, 'character card revision did not persist');

  await confirmedTurn(win, {
    skillName: 'mana-de-ai', screenshotName: 'deepseek-live-de-ai-confirmation.png',
    allowNoConfirmation: true,
    text: `对 chapter:chapter-003.md 执行完整去 AI 味流程：先调用 scan_de_ai_patterns，只对命中的高置信模式做最小改写，调用 check_de_ai_minimality 复验；只有复验通过才用 Codex 原生 apply_patch 提交。不得添加新情节、对白、比喻、心理或氛围。若没有命中则明确说明，不要写入。`,
  });

  // Natural scene endings matter more than exact per-chapter counts. If the
  // aggregate is still short, expand the shortest chapter without asking the
  // model to count or recheck its own output.
  for (let expansion = 0; expansion < 5; expansion += 1) {
    const measured = await Promise.all(CHAPTERS.map(async ([fileName, title]) => ({
      fileName,
      title,
      count: cjkCount(await novelData.readChapter(novel.dir, fileName)),
    })));
    const currentTotal = measured.reduce((sum, chapter) => sum + chapter.count, 0);
    if (currentTotal >= 30_000) break;
    const shortest = measured.sort((a, b) => a.count - b.count)[0];
    await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      text: `自然扩写 chapter:${shortest.fileName}《${shortest.title}》。读取本章及必要的相邻章节，保留全部事实、视角、线索顺序和章末承接；重点补足被略过的动作因果、对白交锋和人物选择过程，整体重写后用 Codex 原生 apply_patch 提交。不要新增支线，不要重复，不要写说明，也不要计算、报告或复核字数。`,
    });
  }

  await plainTurn(win, {
    skillName: 'mana-consistency-review',
    text: `审查《潮汐邮局》九章成稿的人物、世界规则、时间线、POV、段落功能和伏笔回收。必须实际读取总纲、角色卡、世界观、时间线和九章正文；只给证据化报告，不写入。报告结尾明确给出“可交付”或“需修订”。`,
  });
  results.screenshots.push(await screenshot(win, 'deepseek-live-consistency-review.png'));

  const counts = {};
  let total = 0;
  for (const [fileName] of CHAPTERS) {
    const count = cjkCount(await novelData.readChapter(novel.dir, fileName));
    counts[fileName] = count;
    total += count;
  }
  results.chapterCounts = counts;
  results.totalCjk = total;
  pass(total >= 30_000, `novel total is below 30,000 CJK chars: ${total}`);
  await fsp.mkdir(path.join(ROOT, 'artifacts', 'deepseek-live-acceptance'), { recursive: true });
  await fsp.writeFile(path.join(ROOT, 'artifacts', 'deepseek-live-acceptance', 'result.json'), JSON.stringify({ novelId, novelDir: novel.dir, modelId, counts, totalCjk: total, completedAt: new Date().toISOString() }, null, 2));
  results.screenshots.push(await screenshot(win, 'deepseek-live-nine-chapter-complete.png'));
  console.log(`deepseek-live-novel-ui: ok (${results.passed} checks, ${total} CJK chars)`);
  return results;
}

module.exports = { assistantCount, cjkCount, confirmedTurn, plainTurn, runDeepSeekLiveNovelUiE2E, screenshot, waitFor };
