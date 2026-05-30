#!/usr/bin/env node
'use strict';

/**
 * 联网人设补全基准测试：创建/更新测试小说项目，对 ROSTER 内角色跑完整 enrichCharacters 流程。
 *
 * 用法:
 *   MANA_USER_DATA_ROOT="$HOME/Library/Application Support/.../MultiAgentNovelAssistant" \
 *     node scripts/run-enrichment-benchmark.js
 *
 * 可选:
 *   --concurrency=3
 *   --only-work=原神
 *   --roster=path/to/roster.json
 *   --report=path/to/benchmark-report.json
 *   --skip-enrich   仅建项目不写补全
 */

const fs = require('node:fs').promises;
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_DIR = path.join(ROOT, 'test-projects', 'web-enrichment-benchmark-2026');
const NOVEL_ID = 'novel-web-enrichment-benchmark-2026';

const DEFAULT_ROSTER_PATH = path.join(PROJECT_DIR, 'roster.json');
const DEFAULT_REPORT_PATH = path.join(PROJECT_DIR, 'benchmark-report.json');

async function loadRoster(rosterPath = DEFAULT_ROSTER_PATH) {
  try {
    const raw = await fs.readFile(rosterPath, 'utf8');
    const data = JSON.parse(raw);
    if (data?.works) return data;
  } catch { /* fallback below */ }
  return {
    works: {
      '碧蓝航线': { latest: ['戈达·冯·贝格海姆', '优妮可欧伊'], obscure: ['肇和', '应瑞'], mid: ['爱宕', '能代'] },
      '蔚蓝档案': { latest: ['三千留', '月夜'], obscure: ['冰室濑名', '宇泽玲纱'], mid: ['砂狼白子', '阿罗娜'] },
      '原神': { latest: ['尼可·莱恩', '洛恩'], obscure: ['蓝砚', '伊安珊'], mid: ['胡桃', '雷电将军'] },
      '崩坏：星穹铁道': { latest: ['刃', '昔涟'], obscure: ['阿兰', '希露瓦'], mid: ['三月七', '黄泉'] },
      '绝区零': { latest: ['普罗米娅', '星徽·比利'], obscure: ['可琳', '安东'], mid: ['艾莲', '朱鸢'] },
      '鸣潮': { latest: ['绯雪', '达妮娅'], obscure: ['丹瑾', '白芷'], mid: ['今汐', '长离'] },
    },
    usedInRun: [],
  };
}

function parseArgs(argv) {
  const out = {
    concurrency: 3,
    onlyWork: null,
    reportPath: DEFAULT_REPORT_PATH,
    rosterPath: DEFAULT_ROSTER_PATH,
    skipEnrich: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) out.concurrency = Math.max(1, Number(arg.split('=')[1]) || 3);
    if (arg.startsWith('--only-work=')) out.onlyWork = arg.slice('--only-work='.length);
    if (arg.startsWith('--report=')) out.reportPath = path.resolve(arg.slice('--report='.length));
    if (arg.startsWith('--roster=')) out.rosterPath = path.resolve(arg.slice('--roster='.length));
    if (arg === '--skip-enrich') out.skipEnrich = true;
  }
  return out;
}

function slugId(work, name, tag) {
  const raw = `${work}-${name}-${tag}`.toLowerCase()
    .replace(/[：:]/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw.slice(0, 80) || `char-${Date.now()}`;
}

function characterFileName(id) {
  const safe = String(id || '')
    .replace(/[：:]/g, '-')
    .replace(/[^\w\-.一-龥ぁ-んァ-ヶ가-힣]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safe || `char-${Date.now()}`}.json`;
}

function buildCharacters(rosterData) {
  const list = [];
  const tiers = ['latest', 'obscure', 'mid'];
  const roleMap = { latest: '测试-新角色', obscure: '测试-冷门', mid: '测试-中人气' };
  for (const [work, groups] of Object.entries(rosterData.works || {})) {
    for (const tag of tiers) {
      for (const name of groups[tag] || []) {
        const id = slugId(work, name, tag);
        list.push({
          id,
          name,
          sourceWork: work,
          isOriginal: false,
          role: roleMap[tag] || '测试',
          appearance: '',
          personality: '',
          background: '',
          hairColor: '',
          eyeColor: '',
          height: '',
          figure: '',
          moeTraits: '',
          quotes: '',
          skins: [],
          _benchmarkTag: tag,
        });
      }
    }
  }
  return list;
}

async function ensureProject() {
  const { ensureNovelLayout, novelPaths, generateId } = require(path.join(ROOT, 'src/main/store/paths'));
  const { writeJson, readJson } = require(path.join(ROOT, 'src/main/store/jsonStore'));
  const novelsStore = require(path.join(ROOT, 'src/main/store/novels'));

  await fs.mkdir(PROJECT_DIR, { recursive: true });
  const np = ensureNovelLayout(PROJECT_DIR);
  const meta = {
    schemaVersion: 1,
    id: NOVEL_ID,
    title: '联网人设补全基准测试（2026）',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(np.novelMeta, meta);
  await fs.mkdir(path.join(PROJECT_DIR, 'characters'), { recursive: true });
  await fs.mkdir(path.join(PROJECT_DIR, 'world'), { recursive: true });
  await writeJson(path.join(PROJECT_DIR, 'world', 'meta.json'), {
    schemaVersion: 1,
    possibleFanworkOf: '多作品同人基准测试',
    note: '各角色 sourceWork 字段指定原作；本 meta 仅作占位。',
  });
  await fs.writeFile(path.join(PROJECT_DIR, 'world', 'lore.md'), '# 基准测试世界观\n', 'utf8');
  await fs.writeFile(path.join(PROJECT_DIR, 'world', 'places.json'), JSON.stringify({ schemaVersion: 1, places: [] }), 'utf8');

  const marker = path.join(PROJECT_DIR, '.mana-project');
  await fs.writeFile(marker, JSON.stringify({
    type: 'novel', version: 1, id: NOVEL_ID, title: meta.title, createdAt: meta.createdAt,
  }, null, 2), 'utf8');

  const regPath = require(path.join(ROOT, 'src/main/store/paths')).paths().novelsRegistry;
  const reg = (await readJson(regPath, { schemaVersion: 1, novels: [] })) || { schemaVersion: 1, novels: [] };
  const novels = Array.isArray(reg.novels) ? reg.novels : [];
  const entry = {
    id: NOVEL_ID,
    title: meta.title,
    dir: PROJECT_DIR,
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };
  const idx = novels.findIndex((n) => n.id === NOVEL_ID || n.dir === PROJECT_DIR);
  if (idx >= 0) novels[idx] = entry;
  else novels.push(entry);
  await writeJson(regPath, { ...reg, novels });

  return { np, meta };
}

async function writeCharacterFiles(characters) {
  const charsDir = path.join(PROJECT_DIR, 'characters');
  for (const ch of characters) {
    await fs.writeFile(path.join(charsDir, characterFileName(ch.id)), JSON.stringify(ch, null, 2), 'utf8');
  }
}

function summarizeCharacter(ch) {
  const fields = ['appearance', 'hairColor', 'eyeColor', 'height', 'figure', 'personality', 'background', 'moeTraits', 'quotes'];
  const filled = fields.filter((f) => String(ch[f] || '').trim().length > 0);
  return {
    id: ch.id,
    name: ch.name,
    sourceWork: ch.sourceWork,
    tag: ch._benchmarkTag,
    status: ch._enrichmentStatus || 'unknown',
    source: ch._enrichmentSource || '',
    filledFields: filled,
    filledCount: filled.length,
    appearancePreview: String(ch.appearance || '').slice(0, 120),
    personalityPreview: String(ch.personality || '').slice(0, 120),
    skinsCount: Array.isArray(ch.skins) ? ch.skins.length : 0,
    pageSnapshotLen: String(ch._pageSnapshot || '').length,
    pageUrl: ch._pageUrl || '',
  };
}

async function runSearchProbe(charName, fanworkName) {
  const { searchCharacter, fetchBestPage } = require(path.join(ROOT, 'src/main/import/searchEngine'));
  const { detectSphere } = require(path.join(ROOT, 'src/main/import/culturalSphere'));
  const { sphere } = await detectSphere(fanworkName);
  const t0 = Date.now();
  let searchRes;
  try {
    searchRes = await searchCharacter({
      charName,
      fanworkName,
      userLang: 'zh-CN',
      fanworkSphere: sphere,
      preferredEngine: 'auto',
    });
  } catch (err) {
    return { sphere, searchMs: Date.now() - t0, error: err.message, results: [], pageLen: 0 };
  }
  const results = searchRes.results || [];
  let pageLen = 0;
  let pageSource = '';
  if (results.length) {
    try {
      const pagePayload = await fetchBestPage(results, 'zh-CN', { charName, fanworkName });
      pageLen = pagePayload?.text?.length || 0;
      pageSource = pagePayload?.source || results[0]?.source || '';
    } catch (err) {
      return {
        sphere,
        searchMs: Date.now() - t0,
        resultCount: results.length,
        topSources: results.slice(0, 3).map((r) => r.source),
        topTitles: results.slice(0, 3).map((r) => r.title),
        fetchError: err.message,
        pageLen: 0,
      };
    }
  }
  return {
    sphere,
    searchMs: Date.now() - t0,
    resultCount: results.length,
    topSources: results.slice(0, 3).map((r) => r.source),
    topTitles: results.slice(0, 3).map((r) => r.title),
    pageLen,
    pageSource,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MANA_USER_DATA_ROOT) {
    process.env.MANA_USER_DATA_ROOT = path.join(
      process.env.HOME || '',
      'Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant'
    );
  }

  console.log('[benchmark] MANA_USER_DATA_ROOT=', process.env.MANA_USER_DATA_ROOT);
  console.log('[benchmark] project dir=', PROJECT_DIR);

  const rosterData = await loadRoster(args.rosterPath);
  let characters = buildCharacters(rosterData);
  if (args.onlyWork) {
    characters = characters.filter((c) => c.sourceWork === args.onlyWork);
  }

  await ensureProject();
  // 清除上次补全状态，便于对比重跑结果
  for (const ch of characters) {
    delete ch._enrichmentStatus;
    delete ch._enrichmentSource;
  }
  await writeCharacterFiles(characters);
  console.log(`[benchmark] wrote ${characters.length} character stubs`);

  const report = {
    startedAt: new Date().toISOString(),
    novelId: NOVEL_ID,
    projectDir: PROJECT_DIR,
    characterCount: characters.length,
    args,
    searchProbes: [],
    enrichResults: [],
    summary: {},
  };

  // Phase 1: search-only probes (no AI)
  console.log('\n[benchmark] Phase 1: search + fetch probes...');
  for (const ch of characters) {
    const probe = await runSearchProbe(ch.name, ch.sourceWork);
    report.searchProbes.push({ name: ch.name, work: ch.sourceWork, tag: ch._benchmarkTag, ...probe });
    console.log(`  probe ${ch.sourceWork}/${ch.name}: results=${probe.resultCount ?? 0} pageLen=${probe.pageLen ?? 0} sphere=${probe.sphere}`);
  }

  if (args.skipEnrich) {
    report.summary = { skippedEnrich: true };
    await fs.writeFile(args.reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('[benchmark] report written:', args.reportPath);
    return;
  }

  // Phase 2: full enrichment per work group
  console.log('\n[benchmark] Phase 2: enrichCharacters (traditional mode)...');
  const enricher = require(path.join(ROOT, 'src/main/import/characterEnricher'));
  const appConfig = require(path.join(ROOT, 'src/main/store/appConfig'));
  const cfg = await appConfig.load();
  const prevConcurrency = cfg.enrichmentConcurrency;
  cfg.enrichmentConcurrency = args.concurrency;
  cfg.enrichmentMode = 'traditional';

  const byWork = {};
  for (const ch of characters) {
    if (!byWork[ch.sourceWork]) byWork[ch.sourceWork] = [];
    byWork[ch.sourceWork].push(ch);
  }

  const enrichedAll = [];
  for (const [workName, group] of Object.entries(byWork)) {
    console.log(`\n[benchmark] enriching work="${workName}" (${group.length} chars)...`);
    const t0 = Date.now();
    const enriched = await enricher.enrichCharacters(group, null, 'zh-CN', {
      fanworkNameOverride: workName,
      onProgress: (evt) => {
        if (evt.charName && evt.charName !== '_all' && evt.status !== 'searching') {
          console.log(`    [${evt.status}] ${evt.charName}: ${(evt.message || '').split('\n')[0].slice(0, 100)}`);
        }
      },
    });
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const ch of enriched) {
      await fs.writeFile(path.join(PROJECT_DIR, 'characters', characterFileName(ch.id)), JSON.stringify(ch, null, 2), 'utf8');
      enrichedAll.push(summarizeCharacter(ch));
    }
  }

  report.enrichResults = enrichedAll;
  const statusCounts = {};
  for (const r of enrichedAll) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }
  const avgFilled = enrichedAll.length
    ? enrichedAll.reduce((s, r) => s + r.filledCount, 0) / enrichedAll.length
    : 0;
  report.summary = {
    statusCounts,
    avgFilledFields: Number(avgFilled.toFixed(2)),
    successRate: enrichedAll.length
      ? Number((100 * (statusCounts.success || 0) / enrichedAll.length).toFixed(1))
      : 0,
    searchProbeNoPage: report.searchProbes.filter((p) => (p.pageLen || 0) < 200).length,
    searchProbeNoResults: report.searchProbes.filter((p) => (p.resultCount || 0) === 0).length,
  };
  report.finishedAt = new Date().toISOString();

  try {
    const used = characters.map((c) => `${c.sourceWork}:${c.name}`);
    rosterData.usedInRun = [...(rosterData.usedInRun || []), ...used].slice(-200);
    await fs.writeFile(args.rosterPath, JSON.stringify({ ...rosterData, schemaVersion: 1 }, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  await fs.writeFile(args.reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n[benchmark] === SUMMARY ===');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log('[benchmark] full report:', args.reportPath);
  console.log('[benchmark] novel registered as:', NOVEL_ID);
}

main().catch((err) => {
  console.error('[benchmark] FATAL:', err);
  process.exit(1);
});
