'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const fg = require('fast-glob');
const novelData = require('../src/main/store/novelData');
const novels = require('../src/main/store/novels');
const { cjkCount, confirmedTurn, plainTurn, screenshot, waitFor } = require('./deepseek-live-novel-ui-e2e');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'deepseek-live-acceptance');
const REPORT_FILE = path.join(ARTIFACT_ROOT, 'novella-27-result.json');
const LEDGER_FILE = path.join(ARTIFACT_ROOT, 'novella-27-turn-ledger.json');
const REWRITE_BLOCKS_FILE = path.join(ARTIFACT_ROOT, 'novella-27-rewrite-blocks.json');
const CONSISTENCY_REPORTS_FILE = path.join(ARTIFACT_ROOT, 'novella-27-consistency-reports.json');
const SLO_MS = 60_000;
const CHAPTERS = [
  ['chapter-001.md', '雾中来电'], ['chapter-002.md', '第七码头'], ['chapter-003.md', '倒走的钟'],
  ['chapter-004.md', '失踪者名单'], ['chapter-005.md', '潮下仓库'], ['chapter-006.md', '红色航标'],
  ['chapter-007.md', '无声渡轮'], ['chapter-008.md', '伪造的遗书'], ['chapter-009.md', '第一场退潮'],
  ['chapter-010.md', '回声测站'], ['chapter-011.md', '九号潜水钟'], ['chapter-012.md', '被删的航海日志'],
  ['chapter-013.md', '旧城防空洞'], ['chapter-014.md', '沈砚的第二身份'], ['chapter-015.md', '风暴眼'],
  ['chapter-016.md', '港务局密室'], ['chapter-017.md', '失控的广播'], ['chapter-018.md', '黑潮越界'],
  ['chapter-019.md', '九人裂痕'], ['chapter-020.md', '最后的观测船'], ['chapter-021.md', '深井回声'],
  ['chapter-022.md', '倒计时七小时'], ['chapter-023.md', '叛徒的坐标'], ['chapter-024.md', '全港停电'],
  ['chapter-025.md', '沉城浮现'], ['chapter-026.md', '雾门抉择'], ['chapter-027.md', '天亮之后'],
];
const CAST = [
  ['lin-wu', '林雾', '港史档案修复师，主角'], ['shen-yan', '沈砚', '水声工程师，林雾旧友'], ['gu-lan', '顾澜', '港警支队长'],
  ['tang-qi', '唐栖', '深夜广播主持人'], ['zhou-boyuan', '周泊远', '退休引航员'], ['xu-kui', '许葵', '急诊医生'],
  ['han-chuan', '韩川', '商业潜水员'], ['lu-yao', '陆遥', '气象观测员'], ['cheng-he', '程鹤', '港务局长，秩序至上'],
];
const ACT_CAST = [
  ['lin-wu', 'shen-yan', 'gu-lan', 'tang-qi'],
  ['lin-wu', 'shen-yan', 'zhou-boyuan', 'xu-kui', 'han-chuan'],
  ['lin-wu', 'gu-lan', 'tang-qi', 'lu-yao', 'cheng-he'],
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function newConversation(win) {
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="codex-chat-panel"] > div > div button')?.click()`, true);
  await waitFor(win, `[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === '新对话')`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.innerText.trim() === '新对话').click()`, true);
  await waitFor(win, `document.querySelectorAll('[data-testid^="codex-message-"]').length === 0 && !document.querySelector('button[aria-label="停止"]')`);
  await delay(100);
}

async function recordTurn(results, label, value) {
  const durationMs = Number(value?.durationMs) || 0;
  const record = { label, durationMs, wrote: value?.wrote ?? null, verifiedAt: new Date().toISOString() };
  const index = results.turns.findIndex((turn) => turn.label === label);
  if (index >= 0) results.turns[index] = record; else results.turns.push(record);
  console.log(`NOVELLA_PROGRESS ${label} ${durationMs}ms`);
  if (!durationMs || durationMs > SLO_MS) throw new Error(`${label} exceeded the 60-second SLO: ${durationMs}ms`);
  await fsp.writeFile(LEDGER_FILE, `${JSON.stringify({ schemaVersion: 1, turns: results.turns }, null, 2)}\n`, 'utf8');
  return value;
}

function turnDone(results, label) { return results.turns.some((turn) => turn.label === label && turn.durationMs > 0 && turn.durationMs <= SLO_MS); }

function outlineSection(markdown, ...names) {
  const sections = new Map();
  for (const chunk of String(markdown || '').split(/^##\s+/gmu).slice(1)) {
    const newline = chunk.indexOf('\n');
    const name = (newline < 0 ? chunk : chunk.slice(0, newline)).trim();
    sections.set(name, (newline < 0 ? '' : chunk.slice(newline + 1)).trim());
  }
  return names.map((name) => `## ${name}\n${sections.get(name) || ''}`).join('\n\n').trim();
}

function normalizedParagraphs(text) {
  return String(text || '').split(/\n{2,}/u).map((paragraph) => paragraph.replace(/\s+/gu, '')).filter(Boolean);
}

function hasNarrativeFirstPerson(text) {
  const narration = String(text || '').replace(/[“"][\s\S]*?[”"]/gu, '');
  return /(^|[。！？\n])\s*我(?:把|在|没|想|看|听|走|伸|抬|低|攥|踩|记|觉|用|从|往|的)/u.test(narration);
}

function normalizeConsistencyReport(reply, expectedHeader) {
  const raw = String(reply || '').trim();
  const headerIndex = raw.lastIndexOf(expectedHeader);
  if (headerIndex < 0) return '';
  const report = raw.slice(headerIndex).trim();
  if (/(?:读取失败|无法读取|未能读取|工具无法|无实证|全部作废|unsupported call|resourceRef.{0,12}invalid|资源引用无效|请提供有效的资源标识|需要读取小说资源|让我(?:先|并行|直接)|我将并行读取)/iu.test(report)) return '';
  if (!/(?:硬冲突|可疑点)/u.test(report) || !/可接受项/u.test(report) || !/(?:第(?:\d+|[一二三四五六七八九十]+)章|\d+章|ch(?:apter)?:?[-\s]?\d+)/iu.test(report)) return '';
  return report;
}

async function chapterCounts(novelDir) {
  const counts = {};
  for (const [fileName] of CHAPTERS) counts[fileName] = cjkCount(await novelData.readChapter(novelDir, fileName).catch(() => ''));
  return counts;
}

async function writeProgress(results, novel) {
  const counts = await chapterCounts(novel.dir);
  const totalCjk = Object.values(counts).reduce((sum, value) => sum + value, 0);
  await fsp.mkdir(ARTIFACT_ROOT, { recursive: true });
  await fsp.writeFile(REPORT_FILE, `${JSON.stringify({ status: 'in_progress', modelId: 'deepseek-v4-flash', reasoningEffort: 'none', novelId: novel.id, novelDir: novel.dir, counts, totalCjk, completedChapters: Object.values(counts).filter((count) => count >= 2_800).length, turns: results.turns, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

function sumUsage(target, usage = {}) {
  for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) target[key] += Number(usage[key]) || 0;
}

async function buildConsistencyFingerprint(novelDir, data = novelData) {
  const hash = crypto.createHash('sha256');
  const update = (value) => hash.update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  for (let index = 0; index < CHAPTERS.length; index += 1) {
    const [fileName] = CHAPTERS[index];
    hash.update(`chapter:${fileName}\0`);
    update(await data.readChapter(novelDir, fileName));
    const section = Math.floor(index / 9) + 1;
    const chapter = index + 1;
    hash.update(`outline:1:${section}:${chapter}\0`);
    update(await data.readOutlineChapter(novelDir, 1, section, chapter));
  }
  hash.update('world:lore\0');
  update(await data.readWorld(novelDir));
  return hash.digest('hex');
}

async function auditCodexSessions(startedAt) {
  const sessionsRoot = path.join(process.env.MANA_USER_DATA_ROOT, 'codex-home', 'sessions');
  const files = await fg('**/*.jsonl', { cwd: sessionsRoot, absolute: true, onlyFiles: true });
  const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const turns = [];
  const mcpErrors = [];
  const patchFailures = [];
  for (const file of files) {
    let active = null;
    const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line);
      const timestamp = Date.parse(row.timestamp || 0);
      if (timestamp < startedAt - 2_000) continue;
      const payload = row.payload || {};
      if (row.type === 'event_msg' && payload.type === 'task_started') active = { turnId: payload.turn_id, providerCalls: 0, mcpCalls: 0, startedAt: timestamp };
      if (row.type === 'event_msg' && payload.type === 'token_count') {
        sumUsage(usage, payload.info?.last_token_usage || {});
        if (active) active.providerCalls += 1;
      }
      if (row.type === 'event_msg' && payload.type === 'mcp_tool_call_end') {
        if (active) active.mcpCalls += 1;
        if (payload.result?.Err) mcpErrors.push({ turnId: active?.turnId || '', tool: payload.invocation?.tool || '', error: String(payload.result.Err).slice(0, 500) });
      }
      if (row.type === 'event_msg' && payload.type === 'patch_apply_end' && payload.success !== true) patchFailures.push({ turnId: active?.turnId || '', error: String(payload.stderr || 'patch failed').slice(0, 500) });
      if (row.type === 'event_msg' && payload.type === 'task_complete' && active) {
        turns.push({ ...active, durationMs: Number(payload.duration_ms) || Math.max(0, timestamp - active.startedAt), timeToFirstTokenMs: Number(payload.time_to_first_token_ms) || null });
        active = null;
      }
    }
  }
  const uncachedInputTokens = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
  return { files: files.length, physicalProviderCalls: turns.reduce((sum, turn) => sum + turn.providerCalls, 0), usage, uncachedInputTokens, cacheHitRate: usage.input_tokens ? usage.cached_input_tokens / usage.input_tokens : 0, turns, mcpErrors, patchFailures };
}

async function runDeepSeekLiveNovellaUiE2E(win) {
  const startedAt = Date.now();
  const ledger = JSON.parse(await fsp.readFile(LEDGER_FILE, 'utf8').catch(() => '{"turns":[]}'));
  const results = { turns: Array.isArray(ledger.turns) ? ledger.turns : [], screenshots: [] };
  const novelId = String(process.env.MANA_LIVE_NOVEL_ID || '');
  const novel = await novels.getNovelById(novelId);
  if (!novel) throw new Error('27-chapter acceptance novel was not prepared');
  win.setSize(1440, 960);
  win.show();
  await waitFor(win, `document.querySelector('[data-testid="codex-status"]')?.innerText.includes('deepseek-v4-flash')`);

  await newConversation(win);
  let outline = await novelData.readOutlineMaster(novel.dir).catch(() => '');
  if (!outline.includes('## 27章骨架完成')) {
    const mapping = CHAPTERS.map(([file, title], index) => `${index + 1}. ${file}《${title}》`).join('；');
    await recordTurn(results, 'setup-outline-skeleton', await confirmedTurn(win, {
      skillName: 'mana-outline', screenshotName: 'deepseek-live-novella-outline-confirmation.png',
      text: `为中篇小说《雾港回声》创建 outline:master 的精简骨架并立即写入，不要提问，不要读取 hierarchy、nodes、章节或其他空资源。全书27章、目标约9万字，第三人称限知林雾，现实质感海港悬疑奇幻。规则：黑潮出现能重放死者最后七分钟声音的回声层，监听者失去等重个人记忆；二十年前港务局沉没旧城换取航道安全，九名主要人物各持冲突证据。三幕：发现回声层与第一次退潮；追查沉城和九人关系裂变；七小时倒计时中公开真相并共同选择。结局拒绝用抹除私人记忆换虚假安宁。固定映射：${mapping}。本轮只写作品定位、规则、三幕各一段、27章每章一句目标/转折和锁定结局，不展开详细线索表；末尾写独立标记“## 27章骨架完成”。补丁路径只能是 outlines/master.md。`,
    }));
    outline = await novelData.readOutlineMaster(novel.dir);
  }
  const actNames = ['第一幕', '第二幕', '第三幕'];
  const actGoals = ['发现回声层、聚合最初证据并以第一次退潮收束', '追查沉城真相、揭开身份秘密并让九人关系裂变', '七小时倒计时中重新合作、公开真相并完成共同选择'];
  for (let act = 0; act < 3; act += 1) {
    for (let chapterOffset = 0; chapterOffset < 9; chapterOffset += 1) {
      const chapterIndex = act * 9 + chapterOffset;
      const [fileName, title] = CHAPTERS[chapterIndex];
      const outlineRef = `outline:chapter:1:${act + 1}:${chapterIndex + 1}`;
      const outlinePath = `outlines/chapter-v001-s${String(act + 1).padStart(3, '0')}-c${String(chapterIndex + 1).padStart(3, '0')}.md`;
      const existingChapterOutline = await novelData.readOutlineChapter(novel.dir, 1, act + 1, chapterIndex + 1);
      if (existingChapterOutline.includes('记忆代价') && existingChapterOutline.includes('章末承接')) continue;
      const previousRef = chapterIndex > 0 ? `outline:chapter:1:${Math.floor((chapterIndex - 1) / 9) + 1}:${chapterIndex}` : '';
      await recordTurn(results, `setup-outline-chapter-${chapterIndex + 1}`, await confirmedTurn(win, {
        skillName: 'mana-outline',
        text: `创建或校准独立章大纲 ${outlineRef}，对应正文 ${fileName}《${title}》，属于${actNames[act]}，本幕目标是“${actGoals[act]}”。只读取目标资源${previousRef ? `和上一章 ${previousRef}` : ''}，已知 resourceRef 直接并行读取；不要读取 master、hierarchy、nodes、正文或其他资料。写成简洁 Markdown，包含目标、冲突、关键线索、人物选择、记忆代价、转折、章末承接七项，并与上一章衔接。只修改 ${outlinePath}，绝不添加 novel/ 前缀；原生 apply_patch 后等待确认。`,
      }));
    }
  }

  if (!turnDone(results, 'setup-world-lore')) {
    await recordTurn(results, 'setup-world-lore', await confirmedTurn(win, {
      skillName: 'mana-outline',
      text: '创建或校准《雾港回声》的 world:lore，只读取该目标资源。定义回声层、记忆等价交换、黑潮、沉城、港务系统、二十年前事故、当前七小时倒计时及严格限制，约1200个中文汉字，条理清楚，不写正文。只修改 world/lore.md，原生 apply_patch 后等待确认。',
    }));
  }
  if (!turnDone(results, 'setup-style-memory')) {
    await recordTurn(results, 'setup-style-memory', await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      text: '创建或校准《雾港回声》的 style:memory，只读取该目标资源。固定第三人称限知林雾、动作和物件承载情绪、对白有潜台词、短中句交替；列出必须保持的叙事规则及禁止套话、滥用比喻、不是而是、总结式升华。控制在600个中文汉字内。只修改 style/memory.md，原生 apply_patch 后等待确认。',
    }));
  }
  const timelineIds = ['history-01', 'history-02', 'history-03', 'history-04', 'history-05', 'black-tide-eve', ...Array.from({ length: 27 }, (_, index) => `chapter-${String(index + 1).padStart(2, '0')}`)];
  const timelineBatches = timelineIds.map((id) => [id]);
  // Recovery-only fixture cleanup. Asking the model to replace a large aggregate
  // JSON document makes apply_patch match generated bytes and can spin after a
  // mismatch. User-facing creation is validated below through addressable events.
  if (!timelineBatches.some((_ids, index) => turnDone(results, `setup-timeline-batch-${index + 1}`))) {
    await novelData.replaceTimeline(novel.dir, []);
  }
  for (let batch = 0; batch < timelineBatches.length; batch += 1) {
    const label = `setup-timeline-batch-${batch + 1}`;
    if (turnDone(results, label)) continue;
    const ids = timelineBatches[batch];
    await recordTurn(results, label, await confirmedTurn(win, {
      skillName: 'mana-outline',
      text: `创建或校准独立时间线事件 timeline:event:${ids[0]}。只直接读取这个目标，不读取 timeline:all 或其他资料。文件必须是简洁的合法 JSON 对象：id 的值只能是裸 ID "${ids[0]}"（绝不能写成 "timeline:event:${ids[0]}"），并有 when、description、chapterRef；history-01 至 05 描述二十年前沉城事故，black-tide-eve 是当前前夜，chapter-NN 对应第NN章主事件。第22章起进入七小时倒计时。只提交 timeline/event-${ids[0]}.json 并等待确认。`,
    }));
  }

  const existingCharacters = new Set((await novelData.listCharacters(novel.dir)).map((item) => item.id));
  for (let group = 0; group < CAST.length; group += 1) {
    const label = `setup-character-card-${group + 1}`;
    if (turnDone(results, label)) continue;
    const members = CAST.slice(group, group + 1);
    await recordTurn(results, label, await confirmedTurn(win, {
      skillName: 'mana-character-roleplay',
      text: `创建或校准主要人物卡 ${members.map(([id, name, role]) => `character:${id}（${name}，${role}）`).join('；')}。只直接读取这个目标，不读取其他资料。必须是合法 JSON，id 使用 resourceRef 冒号后的裸 ID，包含外貌、履历、欲望、恐惧、秘密、价值排序、误判、说话习惯、九人关系、三幕人物弧和在回声层规则下绝不轻易做出的选择。一次原生 apply_patch 提交并等待确认。`,
    }));
    for (const [id] of members) existingCharacters.add(id);
  }
  await writeProgress(results, novel);

  for (let act = 0; act < 3; act += 1) {
    await newConversation(win);
    const actStart = act * 9;
    const actEnd = actStart + 9;
    const anchorOutlines = [actStart, actStart + 4, actEnd - 1].map((index) => `outline:chapter:1:${act + 1}:${index + 1}`);
    const directorLabel = `act-${act + 1}-roleplay-director`;
    if (!turnDone(results, directorLabel)) {
      for (let actor = 0; actor < ACT_CAST[act].length; actor += 1) {
        const characterId = ACT_CAST[act][actor];
        await recordTurn(results, `act-${act + 1}-roleplay-${actor + 1}`, await plainTurn(win, {
          skillName: 'mana-character-roleplay',
          text: `进入角色驱动模式，只扮演 character:${characterId}。只读取该角色卡与本幕开端、中点、结尾三个独立章大纲 ${anchorOutlines.join('、')}，并行读取，不读取其他角色、outline:master 或正文。严格从角色当时的主观认知推演其在第${actStart + 1}至${actEnd}章会如何行动、拒绝什么、误判什么；不得替导演裁决，不写入文件，输出不超过400个中文汉字。`,
        }));
      }
      await recordTurn(results, directorLabel, await plainTurn(win, {
        skillName: 'mana-character-roleplay',
        text: `仅依据本会话刚完成的${ACT_CAST[act].length}份演员推演做第${actStart + 1}至${actEnd}章导演裁决，不再读取任何资源。只裁决演员之间或与既定章纲冲突之处，给随后九章一份不超过500个中文汉字的决策清单，不写入文件。`,
      }));
    }
    for (let index = actStart; index < actEnd; index += 1) {
      const [fileName, title] = CHAPTERS[index];
      const chapterLabel = `chapter-${String(index + 1).padStart(2, '0')}`;
      const commitLabels = Array.from({ length: 6 }, (_, part) => `${chapterLabel}-part-${part + 1}-commit`);
      if (!commitLabels.some((label) => turnDone(results, label))) {
        const failedRunContent = await novelData.readChapter(novel.dir, fileName).catch(() => '');
        if (failedRunContent) await novelData.writeChapter(novel.dir, fileName, '');
      }
      let content = await novelData.readChapter(novel.dir, fileName).catch(() => '');
      const firstPendingPart = commitLabels.findIndex((label) => !turnDone(results, label));
      for (let attempt = firstPendingPart < 0 ? 6 : firstPendingPart; attempt < 6 && cjkCount(content) < 2_800; attempt += 1) {
        await newConversation(win);
        const outlineText = await novelData.readOutlineChapter(novel.dir, 1, act + 1, index + 1);
        const tail = content ? content.slice(-240) : '';
        const finalSentence = content ? content.trim().split(/\n+/u).at(-1) : '';
        const outlineEvidence = [
          outlineSection(outlineText, '目标', '冲突'),
          outlineSection(outlineText, '关键线索'),
          outlineSection(outlineText, '人物选择'),
          outlineSection(outlineText, '记忆代价'),
          outlineSection(outlineText, '转折'),
          outlineSection(outlineText, '章末承接'),
        ][attempt];
        let draft = null;
        let draftText = '';
        for (let retry = 0; retry < 3; retry += 1) {
          if (retry > 0) await newConversation(win);
          draft = await plainTurn(win, {
            text: `只输出《雾港回声》第${index + 1}章《${title}》接下来的一个完整连续场景，在动作、对白和情绪抵达自然落点时结束，不写标题、说明或字数报告。第三人称限知林雾，以动作、物件和潜台词推进；严禁使用“不是……而是……”句式和总结式升华。${retry > 0 ? '上一稿被质量门退回；请重新创作完整场景，避开既有段落与禁用句式，不要复述尾文或解释任务。' : ''}${content ? `最后一句是“${finalSentence}”。你的第一句必须发生在这句之后，绝不能复写最后一句或以下尾文；${attempt === 5 ? '本场景完成章末落点' : '本场景继续推进但不提前收束'}。仅供衔接的尾文：\n${tail}` : '本场景完成开场并推进到首个不可逆选择，不提前收束。'}\n\n本场景唯一需要落实的章纲证据：\n${outlineEvidence}`,
          });
          draftText = String(draft.reply || '').trim();
          const invalidLength = !draftText;
          const forbiddenStyle = /不是.{0,40}而是/u.test(draftText);
          const existingParagraphs = new Set(normalizedParagraphs(content).filter((paragraph) => cjkCount(paragraph) >= 30));
          const repeatedExistingParagraph = normalizedParagraphs(draftText).some((paragraph) => cjkCount(paragraph) >= 30 && existingParagraphs.has(paragraph));
          const wrongNarrativePerson = hasNarrativeFirstPerson(draftText);
          if (!invalidLength && !forbiddenStyle && !repeatedExistingParagraph && !wrongNarrativePerson) break;
          await recordTurn(results, `${chapterLabel}-part-${attempt + 1}-draft-rejected-${retry + 1}`, draft);
          console.log(`NOVELLA_REJECT ${chapterLabel}-part-${attempt + 1} ${invalidLength ? `length=${cjkCount(draftText)}` : forbiddenStyle ? 'forbidden-style' : repeatedExistingParagraph ? 'repeated-existing-paragraph' : 'first-person-narration'}`);
          draft = null;
        }
        if (!draft) throw new Error(`${chapterLabel} part ${attempt + 1} failed the bounded draft quality retry`);
        await recordTurn(results, `${chapterLabel}-part-${attempt + 1}-draft`, draft);
        let committed = null;
        for (let retry = 0; retry < 2 && !committed; retry += 1) {
          if (retry > 0) {
            await newConversation(win);
            await recordTurn(results, `${chapterLabel}-part-${attempt + 1}-commit-reseed-${retry}`, await plainTurn(win, { text: `只输出以下待提交正文，逐字复制，不要添加说明：\n\n${draftText}` }));
          }
          const commit = await confirmedTurn(win, {
            skillName: 'mana-fiction-writing',
            screenshotName: index === 0 && attempt === 0 ? 'deepseek-live-novella-chapter-1-confirmation.png' : undefined,
            allowNoConfirmation: true,
            text: content
              ? `将上一条 assistant 输出的正文原字不动追加到 chapter:${fileName} 末尾。当前文件最后一个完整物理行是“${finalSentence}”。不要润色、重写、复述或解释；不得调用任何读取/列举/搜索工具。直接生成 chapters/${fileName} 的单个最小原生 apply_patch：上下文行必须逐字包含上述整个物理行，从第一个字到最后一个句号都不得缩短，然后等待确认。`
              : `将上一条 assistant 输出的正文原字不动写入新的 chapter:${fileName}。不要润色、重写、复述、解释或读取任何资料；新建路径只能是 chapters/${fileName}，用原生 apply_patch 提交并等待确认。`,
          });
          if (commit.wrote) committed = commit;
          else {
            await recordTurn(results, `${chapterLabel}-part-${attempt + 1}-commit-rejected-${retry + 1}`, commit);
            console.log(`NOVELLA_REJECT ${chapterLabel}-part-${attempt + 1}-commit no-confirmation`);
          }
        }
        if (!committed) throw new Error(`${chapterLabel} part ${attempt + 1} failed the bounded commit retry`);
        await recordTurn(results, commitLabels[attempt], committed);
        content = await novelData.readChapter(novel.dir, fileName).catch(() => '');
      }
      if (cjkCount(content) < 2_800) throw new Error(`${fileName} remains too short: ${cjkCount(content)} CJK chars`);
      await writeProgress(results, novel);
    }
  }

  let counts = await chapterCounts(novel.dir);
  let totalCjk = Object.values(counts).reduce((sum, value) => sum + value, 0);
  for (let expansion = 0; expansion < 4 && totalCjk < 90_000; expansion += 1) {
    const [fileName, count] = Object.entries(counts).sort((left, right) => left[1] - right[1])[0];
    const index = CHAPTERS.findIndex(([file]) => file === fileName);
    const content = await novelData.readChapter(novel.dir, fileName);
    const finalLine = content.trim().split(/\n+/u).at(-1);
    const tail = content.slice(-800);
    const outlineText = await novelData.readOutlineChapter(novel.dir, 1, Math.floor(index / 9) + 1, index + 1);
    await newConversation(win);
    let draft = null;
    let expansionText = '';
    for (let retry = 0; retry < 3; retry += 1) {
      if (retry > 0) await newConversation(win);
      draft = await plainTurn(win, {
        text: `只输出一个完整连续的插入场景，在动作因果、对白交锋和选择后果抵达自然落点时结束，不写标题、说明或字数报告。它将插在《雾港回声》第${index + 1}章《${CHAPTERS[index][1]}》最后一段之前，必须自然承接以下尾文；不改变现有事实与章末承接，严禁“不是……而是……”句式。${retry > 0 ? '上一稿被质量门退回；请重新创作完整场景，避开禁用句式，禁止复述尾文或解释任务。' : ''}\n\n尾文：\n${tail}\n\n章末证据：\n${outlineSection(outlineText, '章末承接', '人物选择')}`,
      });
      expansionText = String(draft.reply || '').trim();
      if (expansionText && !/不是.{0,40}而是/u.test(expansionText)) break;
      await recordTurn(results, `aggregate-expansion-${expansion + 1}-draft-rejected-${retry + 1}`, draft);
      console.log(`NOVELLA_REJECT aggregate-expansion-${expansion + 1}-draft quality`);
      draft = null;
    }
    if (!draft) throw new Error(`aggregate expansion ${expansion + 1} failed the bounded quality retry`);
    await recordTurn(results, `aggregate-expansion-${expansion + 1}-draft`, draft);
    await recordTurn(results, `aggregate-expansion-${expansion + 1}-commit`, await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      text: `把上一条 assistant 输出的正文原字不动插入 chapters/${fileName} 的最后一个物理行之前。当前最后一个完整物理行是“${finalLine}”。不要读取、列举或搜索资源，不要改动任何现有文字；直接用包含上述完整物理行的单个最小原生 apply_patch 完成局部插入并等待确认。`,
    }));
    counts = await chapterCounts(novel.dir);
    totalCjk = Object.values(counts).reduce((sum, value) => sum + value, 0);
    await writeProgress(results, novel);
  }
  if (totalCjk < 90_000) throw new Error(`27-chapter novel remains below 90,000 CJK chars: ${totalCjk}`);

  if (!turnDone(results, 'revision-local-edit')) {
    await newConversation(win);
    const localBefore = await novelData.readChapter(novel.dir, 'chapter-005.md');
    await recordTurn(results, 'revision-local-edit', await confirmedTurn(win, {
      skillName: 'mana-fiction-writing', screenshotName: 'deepseek-live-novella-local-edit-confirmation.png',
      text: '对 chapter:chapter-005.md 做一次真实局部修改：只精简开头三段最拖沓的一处，总改动不超过100个汉字，保持事实、视角、人物声线和节奏。必须是 chapters/chapter-005.md 的最小 diff，不能整章 replace。立即提交并等待确认。',
    }));
    if ((await novelData.readChapter(novel.dir, 'chapter-005.md')) === localBefore) throw new Error('local edit did not persist');
  }

  const rewriteBefore = await novelData.readChapter(novel.dir, 'chapter-020.md');
  let rewriteBlocks = JSON.parse(await fsp.readFile(REWRITE_BLOCKS_FILE, 'utf8').catch(() => 'null'));
  if (!Array.isArray(rewriteBlocks) || !rewriteBlocks.length) {
    const rewriteParagraphs = rewriteBefore.trim().split(/\n{2,}/u);
    const rewriteGroupSize = Math.ceil(rewriteParagraphs.length / 4);
    rewriteBlocks = Array.from({ length: 4 }, (_, part) => rewriteParagraphs.slice(part * rewriteGroupSize, Math.min(rewriteParagraphs.length, (part + 1) * rewriteGroupSize)).join('\n\n')).filter(Boolean);
    await fsp.writeFile(REWRITE_BLOCKS_FILE, `${JSON.stringify(rewriteBlocks, null, 2)}\n`, 'utf8');
  }
  const rewriteOutline = await novelData.readOutlineChapter(novel.dir, 1, 3, 20);
  const rewriteHadPending = rewriteBlocks.some((_, part) => !turnDone(results, `revision-whole-chapter-part-${part + 1}-commit`));
  for (let part = 0; part < rewriteBlocks.length; part += 1) {
    if (turnDone(results, `revision-whole-chapter-part-${part + 1}-commit`)) continue;
    const originalBlock = rewriteBlocks[part];
    await newConversation(win);
    const draft = await plainTurn(win, {
      text: `只输出 chapter-020.md《最后的观测船》第${part + 1}/4连续区块的重写正文，不写标题、说明或字数报告。逐项保留原区块全部事实、线索顺序和人物选择，把九人分裂后的合作动机、动作因果与对白潜台词写得更可信；控制在300至2500个中文汉字，不得使用“不是……而是……”。相邻区块不改。\n\n原区块：\n${originalBlock}\n\n本章大纲证据：\n${outlineSection(rewriteOutline, '目标', '冲突', '人物选择', '章末承接')}`,
    });
    const rewrittenBlock = String(draft.reply || '').trim();
    if (cjkCount(rewrittenBlock) < 300 || cjkCount(rewrittenBlock) > 2_500 || /不是.{0,40}而是/u.test(rewrittenBlock)) throw new Error(`whole chapter rewrite part ${part + 1} failed quality validation`);
    await recordTurn(results, `revision-whole-chapter-part-${part + 1}-draft`, draft);
    await recordTurn(results, `revision-whole-chapter-part-${part + 1}-commit`, await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      screenshotName: part === 0 ? 'deepseek-live-novella-whole-chapter-rewrite.png' : undefined,
      text: `将上一条 assistant 输出原字不动替换 chapters/chapter-020.md 中以下连续原文区块。不得读取任何资源，不得修改区块外文字；直接生成一个完整精确的原生 apply_patch 并等待确认。\n\n待替换原文区块：\n${originalBlock}`,
    }));
  }
  if (rewriteHadPending && (await novelData.readChapter(novel.dir, 'chapter-020.md')) === rewriteBefore) throw new Error('whole chapter rewrite did not persist');

  const outlineBefore = await novelData.readOutlineChapter(novel.dir, 1, 2, 14);
  if (!turnDone(results, 'revision-outline-commit')) {
    const outlineEvidence = [];
    for (const chapter of ['chapter-013.md', 'chapter-014.md', 'chapter-015.md']) {
      const chapterText = await novelData.readChapter(novel.dir, chapter);
      outlineEvidence.push(`## ${chapter}\n${chapterText.slice(0, 500)}\n…\n${chapterText.slice(-500)}`);
    }
    await newConversation(win);
    const outlineDraft = await plainTurn(win, {
      text: `只输出修订后的第14章完整独立章大纲，不写说明。保留现有标题、核心结局和全部 ## 标题；依据第13至15章成稿证据修正已落地线索、记忆代价、人物选择和章末承接的不一致，篇幅不得超过原稿120%。\n\n现有大纲：\n${outlineBefore}\n\n成稿证据：\n${outlineEvidence.join('\n\n')}`,
    });
    const revisedOutline = String(outlineDraft.reply || '').trim();
    if (!revisedOutline.includes('第十四章') || !revisedOutline.includes('目标') || cjkCount(revisedOutline) > cjkCount(outlineBefore) * 1.8 || /\b(?:TEST|XXX)\b/u.test(revisedOutline)) throw new Error('outline revision draft failed quality validation');
    await recordTurn(results, 'revision-outline-draft', outlineDraft);
    await recordTurn(results, 'revision-outline-commit', await confirmedTurn(win, {
      skillName: 'mana-outline',
      text: `将上一条 assistant 输出原字不动替换 outlines/chapter-v001-s002-c014.md 的全部现有内容。不得读取、列举或搜索任何资源，不得修改其他文件；直接生成一个完整精确的原生 apply_patch 并等待确认。\n\n待替换的完整原文：\n${outlineBefore}`,
    }));
    if ((await novelData.readOutlineChapter(novel.dir, 1, 2, 14)) === outlineBefore) throw new Error('outline revision did not persist');
  }

  const linBefore = JSON.stringify(await novelData.readCharacter(novel.dir, 'lin-wu'));
  const linWasPending = !turnDone(results, 'revision-character-card-1-commit');
  for (let index = 0; index < CAST.length; index += 1) {
    if (turnDone(results, `revision-character-card-${index + 1}-commit`)) continue;
    const [id, name] = CAST[index];
    const originalJson = await fsp.readFile(path.join(novel.dir, 'characters', `${id}.json`), 'utf8');
    const characterEvidence = [];
    for (const chapter of [index + 1, index + 10, index + 19]) {
      const chapterText = await novelData.readChapter(novel.dir, CHAPTERS[chapter - 1][0]);
      characterEvidence.push(`第${chapter}章：${chapterText.slice(0, 400)} … ${chapterText.slice(-400)}`);
    }
    await newConversation(win);
    const cardDraft = await plainTurn(win, {
      text: `只输出 character:${id}（${name}）修订后的完整 JSON，不要代码围栏或说明。保留现有全部键和无关字段，只依据三个跨幕采样更新经历、关系变化、最终认知、遗留矛盾和记忆损失；id 必须仍为 ${id}。\n\n现有角色卡：\n${originalJson}\n\n跨幕证据：\n${characterEvidence.join('\n\n')}`,
    });
    const renderedCard = String(cardDraft.reply || '').trim();
    const jsonStart = renderedCard.indexOf('{');
    const jsonEnd = renderedCard.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart || !new RegExp(`"id"\\s*:\\s*"${id}"`, 'u').test(renderedCard)) throw new Error(`character card ${id} draft does not expose a JSON object with the original id`);
    await recordTurn(results, `revision-character-card-${index + 1}-draft`, cardDraft);
    const commitPrompt = `用上一条 assistant 输出的 JSON 更新 characters/${id}.json。必须实际调用一次 apply_patch 工具，禁止把补丁打印成普通聊天正文。不得读取、列举或搜索任何资源，不得修改其他文件；工具输入只允许一个以“*** Update File: characters/${id}.json”开头的补丁，严禁 Delete File、Add File 或第二次补丁。只替换值确实变化的完整 JSON 字段行，每个旧行和新行都必须逐字完整；非相邻字段必须各用独立 @@ hunk，或者把中间未修改行以空格前缀作为上下文，绝不能把非相邻行伪装成一个连续块。然后等待确认。\n\n完整原 JSON：\n${originalJson}`;
    let cardCommit = null;
    for (let retry = 0; retry < 2 && !cardCommit; retry += 1) {
      if (retry > 0) {
        await newConversation(win);
        await recordTurn(results, `revision-character-card-${index + 1}-commit-reseed-${retry}`, await plainTurn(win, { text: `只输出以下完整 JSON，逐字复制，不要代码围栏或说明：\n\n${renderedCard.slice(jsonStart, jsonEnd + 1)}` }));
      }
      const attemptCommit = await confirmedTurn(win, { skillName: 'mana-character-roleplay', allowNoConfirmation: true, text: commitPrompt });
      if (attemptCommit.wrote) cardCommit = attemptCommit;
      else await recordTurn(results, `revision-character-card-${index + 1}-commit-rejected-${retry + 1}`, attemptCommit);
    }
    if (!cardCommit) throw new Error(`character card ${id} failed the bounded commit retry`);
    await recordTurn(results, `revision-character-card-${index + 1}-commit`, cardCommit);
    const committedCard = await novelData.readCharacter(novel.dir, id);
    if (!committedCard || committedCard.id !== id) throw new Error(`character card ${id} did not persist as valid JSON`);
  }
  if (linWasPending && JSON.stringify(await novelData.readCharacter(novel.dir, 'lin-wu')) === linBefore) throw new Error('character card revision did not persist');

  const povRepairChapters = [3, 5, 7, 11, 12, 15, 16, 17, 18, 19, 23, 26];
  for (const chapterNumber of povRepairChapters) {
    const label = `quality-repair-pov-${chapterNumber}`;
    if (turnDone(results, label)) continue;
    const fileName = CHAPTERS[chapterNumber - 1][0];
    const currentText = await novelData.readChapter(novel.dir, fileName);
    if (!currentText.includes('她') && !currentText.includes('李雾') && !hasNarrativeFirstPerson(currentText)) continue;
    await newConversation(win);
    await recordTurn(results, label, await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      text: `校正 chapter:${fileName} 的叙事人称，且只做这一类修改：林雾是男性，所有明确指代林雾的“她/她的”改为“他/他的”；沈砚也是男性；把引号外由林雾叙述的第一人称“我/我的”改为第三人称“林雾/他/他的”，引号内人物对白的“我”保持不变；若有“李雾”一律改回“林雾”。不得改剧情、事实、句序、段落或其他人物代词。只读取本章，提交 chapters/${fileName} 的单个最小 Update File 原生 apply_patch 并等待确认。`,
    }));
  }

  if (!turnDone(results, 'quality-repair-outline-identity')) {
    const currentOutline = await novelData.readOutlineChapter(novel.dir, 1, 2, 14);
    if (!currentOutline.includes('林雾仍是独立') || currentOutline.includes('主角真名「沈砚」')) {
      await newConversation(win);
      await recordTurn(results, 'quality-repair-outline-identity', await confirmedTurn(win, {
        skillName: 'mana-outline',
        text: '修订 outline:chapter:1:2:14 的身份冲突：林雾与沈砚是两个独立人物，林雾不是沈砚的真名或复制体；保留“沈砚的第二身份”是沉城写沉命令的参与者/原稿落款人这一揭示。只读取该章纲，只改与身份合一冲突的句子，不改标题、章末承接或正文；提交 outlines/chapter-v001-s002-c014.md 的单个最小 Update File 原生 apply_patch 并等待确认。',
      }));
    }
  }

  const ruleRepairs = [
    [2, '统一同一通神秘来电的时间为第1章已落地的00:43；若03:17是另一事件，必须用一句明确区分。回声只在退潮窗口显形，白昼残留只能是物理证据或余温，不能是新的二次回声。'],
    [6, '把与主线“首次退潮前后六天”冲突的“三星期”等跨度改为六天内的明确表述；涨潮闭合后只能保留物理痕迹，复制体和航标不得继续主动显形回应。'],
    [8, '名单必须对应九名留守者；把“二十三行/二十三个名字”等冲突改为九人名单，并保持第十格是唯一空白名字格。'],
    [22, '第十格统一为九人名单之后的唯一空白名字格，不是空间坐标或门；记忆代价统一为每次接触失去与目标记忆等重的个人记忆。'],
    [23, '第十格统一为九人名单之后的唯一空白名字格，不是空间坐标；“三层”若指单次操作产生的回声分支须明确写成单次分支数，不得与总层级混为一谈。'],
    [24, '第十格统一为九人名单之后的唯一空白名字格，不是钥匙对应的实体门；记忆代价继续遵守等重个人记忆且不可逆，不能写成可抵消。'],
  ];
  for (const [chapterNumber, guidance] of ruleRepairs) {
    const label = `quality-repair-rule-${chapterNumber}`;
    if (turnDone(results, label)) continue;
    const fileName = CHAPTERS[chapterNumber - 1][0];
    const currentText = await novelData.readChapter(novel.dir, fileName);
    const alreadyRepaired = chapterNumber === 2 ? !currentText.includes('三点十七分')
      : chapterNumber === 6 ? !currentText.includes('三星期')
        : chapterNumber === 8 ? !currentText.includes('二十三行') && !currentText.includes('李雾')
          : chapterNumber === 22
            ? /(?:九个人的名字|九个预印姓名|九名签署者)/u.test(currentText)
              && /(?:第十格还是空的|第十格仍(?:保持)?空白|第十格仍白着)/u.test(currentText)
              && !/(?:第十格.{0,12}(?:空间坐标|实体门|乘员位)|(?:空间坐标|实体门|乘员位).{0,12}第十格)/u.test(currentText)
            : chapterNumber === 23 ? currentText.includes('第十格不对应地理坐标')
              : chapterNumber === 24 ? !/(?:第十格老钥匙|第十格那扇门|第十格的方向)/u.test(currentText)
                : false;
    if (alreadyRepaired) continue;
    await newConversation(win);
    await recordTurn(results, label, await confirmedTurn(win, {
      skillName: 'mana-fiction-writing',
      text: `局部修正 chapter:${fileName} 的设定硬冲突：${guidance} 只读取本章与 world:lore，保持其他剧情、人物、句序和段落不变；只改必要的完整句，提交 chapters/${fileName} 的单个最小 Update File 原生 apply_patch 并等待确认。`,
    }));
  }
  for (const [fileName] of CHAPTERS) {
    const chapterText = await novelData.readChapter(novel.dir, fileName);
    const seenParagraphs = new Set();
    for (const paragraph of normalizedParagraphs(chapterText)) {
      if (cjkCount(paragraph) >= 50 && seenParagraphs.has(paragraph)) throw new Error(`${fileName} still contains an exact duplicate paragraph`);
      seenParagraphs.add(paragraph);
    }
    if (/(?:我无法完成这个任务|请你提供第十三章|apply_patch|assistant)/iu.test(chapterText)) throw new Error(`${fileName} still contains assistant/tool pollution`);
    if (hasNarrativeFirstPerson(chapterText)) throw new Error(`${fileName} still contains first-person narration outside dialogue`);
    if (chapterText.includes('李雾')) throw new Error(`${fileName} still contains the 李雾 typo`);
  }

  if (!turnDone(results, 'revision-de-ai-v2')) {
    await newConversation(win);
    const deAiResult = await confirmedTurn(win, {
      skillName: 'mana-de-ai', allowNoConfirmation: true,
      text: '对 chapter:chapter-012.md 执行完整去 AI 味流程：实际调用 scan_de_ai_patterns 后只改高置信命中，再实际调用 check_de_ai_minimality 复验；通过才提交 chapters/chapter-012.md 的最小 diff。不得新增情节、对白、比喻、心理或氛围；无命中则明确说明且不写入。',
    });
    if (!deAiResult.wrote && /(?:不可用|无法调用|not available|not in.*tool)/iu.test(String(deAiResult.reply || ''))) throw new Error('de-AI verification tools were not exposed to the production conversation');
    await recordTurn(results, 'revision-de-ai-v2', deAiResult);
  }
  const novelFingerprint = await buildConsistencyFingerprint(novel.dir);
  const savedReviewState = JSON.parse(await fsp.readFile(CONSISTENCY_REPORTS_FILE, 'utf8').catch(() => '{}'));
  const savedReviewReports = savedReviewState.fingerprint === novelFingerprint && savedReviewState.reports && typeof savedReviewState.reports === 'object' ? savedReviewState.reports : {};
  const savedReviewVerified = savedReviewState.fingerprint === novelFingerprint && savedReviewState.verified && typeof savedReviewState.verified === 'object' ? savedReviewState.verified : {};
  const reviewReports = [];
  for (let batch = 0; batch < 9; batch += 1) {
    const start = batch * 3;
    const chapterRefs = CHAPTERS.slice(start, start + 3).map(([file]) => `chapter:${file}`);
    const outlineRefs = CHAPTERS.slice(start, start + 3).map((_, offset) => `outline:chapter:1:${Math.floor((start + offset) / 9) + 1}:${start + offset + 1}`);
    const expectedHeader = `覆盖第${start + 1}-${start + 3}章`;
    const savedReport = normalizeConsistencyReport(savedReviewReports[batch + 1], expectedHeader);
    const savedVerification = savedReviewVerified[batch + 1];
    if (savedReport && Number(savedVerification?.durationMs) > 0 && Number(savedVerification.durationMs) <= SLO_MS) {
      reviewReports.push(savedReport);
      continue;
    }
    let review = null;
    let verifiedReport = '';
    for (let retry = 0; retry < 2 && !verifiedReport; retry += 1) {
      await newConversation(win);
      review = await plainTurn(win, {
        skillName: 'mana-consistency-review',
        text: `审查《雾港回声》第${start + 1}至${start + 3}章的九名主要人物、回声层规则、时间线、POV、段落功能、记忆代价和伏笔回收。只并行读取正文 ${chapterRefs.join('、')}、独立章大纲 ${outlineRefs.join('、')} 和 world:lore，不列举资源、不读取其他正文。调用 read_novel_resource 时每次必须传入非空 JSON，例如 {"resourceRef":"${chapterRefs[0]}"}，严禁空参数；全部读取成功后才输出报告。最终报告第一行必须写“${expectedHeader}”，总计不超过700个中文汉字，必须包含“硬冲突”（没有则写“硬冲突：无”）与“可接受项”，并给出第几章的证据；不要输出读取计划、工具说明或过程文字，不写入。`,
      });
      verifiedReport = normalizeConsistencyReport(review.reply, expectedHeader);
      if (!verifiedReport) await recordTurn(results, `final-consistency-v2-review-${batch + 1}-rejected-${retry + 1}`, review);
    }
    if (!verifiedReport) throw new Error(`consistency review ${batch + 1} did not produce verified chapter evidence after bounded retry`);
    await recordTurn(results, `final-consistency-v2-review-${batch + 1}`, review);
    reviewReports.push(verifiedReport);
    savedReviewReports[batch + 1] = verifiedReport;
    savedReviewVerified[batch + 1] = { durationMs: Number(review.durationMs), verifiedAt: new Date().toISOString() };
    await fsp.writeFile(CONSISTENCY_REPORTS_FILE, `${JSON.stringify({ fingerprint: novelFingerprint, reports: savedReviewReports, verified: savedReviewVerified }, null, 2)}\n`, 'utf8');
  }
  await newConversation(win);
  const finalReview = await plainTurn(win, {
    skillName: 'mana-consistency-review',
    text: `仅依据以下九份分批审查做最终综合，不读取任何资源。第一行必须写“覆盖全书27章”；按严重度汇总九名人物、规则、时间线、POV、段落功能、记忆代价和伏笔回收，结尾明确“可交付”或“需修订”，不超过1200个中文汉字，不写入。\n\n${reviewReports.map((report, index) => `## 批次${index + 1}\n${report}`).join('\n\n')}`,
  });
  if (!String(finalReview.reply || '').includes('覆盖全书27章')) throw new Error('final consistency synthesis did not cover all 27 chapters');
  await recordTurn(results, 'final-consistency-v2-synthesis', finalReview);

  counts = await chapterCounts(novel.dir);
  totalCjk = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const characters = await novelData.listCharacters(novel.dir);
  if (characters.length < 9) throw new Error(`expected 9 characters, found ${characters.length}`);
  const runtimeAudit = await auditCodexSessions(startedAt);
  if (runtimeAudit.mcpErrors.length) throw new Error(`MCP errors detected: ${JSON.stringify(runtimeAudit.mcpErrors.slice(0, 3))}`);
  if (runtimeAudit.patchFailures.length) throw new Error(`rejected/failed patches detected: ${JSON.stringify(runtimeAudit.patchFailures.slice(0, 3))}`);
  if (runtimeAudit.turns.some((turn) => turn.durationMs > SLO_MS)) throw new Error('Codex session log contains a turn over 60 seconds');
  if (runtimeAudit.turns.some((turn) => turn.providerCalls > 8)) throw new Error('Codex session log contains a turn with more than 8 physical provider calls');
  const uncachedPerTurn = runtimeAudit.turns.length ? runtimeAudit.uncachedInputTokens / runtimeAudit.turns.length : Infinity;
  if (uncachedPerTurn > 20_000) throw new Error(`uncached input tokens per turn are excessive: ${uncachedPerTurn}`);
  results.screenshots.push(await screenshot(win, 'deepseek-live-novella-27-complete.png'));
  const qualityConclusion = String(finalReview.reply || '').trim();
  const qualityStatus = qualityConclusion.includes('可交付') && !qualityConclusion.includes('需修订') ? 'passed' : 'needs_revision';
  const report = { status: qualityStatus, modelId: 'deepseek-v4-flash', reasoningEffort: 'none', novelId: novel.id, novelDir: novel.dir, chapterCounts: counts, totalCjk, characterCount: characters.length, conversationCountMinimum: 5, qualityConclusion, turns: results.turns, runtimeAudit, completedAt: new Date().toISOString() };
  await fsp.writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (qualityStatus !== 'passed') throw new Error('final consistency synthesis concluded that the manuscript still needs revision');
  console.log(`deepseek-live-novella-ui: ok (${CHAPTERS.length} chapters, ${totalCjk} CJK, ${characters.length} characters, ${results.turns.length} turns)`);
  return { passed: results.turns.length, failed: 0, screenshots: results.screenshots };
}

module.exports = { ACT_CAST, CAST, CHAPTERS, auditCodexSessions, buildConsistencyFingerprint, runDeepSeekLiveNovellaUiE2E };
