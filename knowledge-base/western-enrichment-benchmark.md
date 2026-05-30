# 欧美文化圈通用层 Benchmark

最后更新：2026-05-29（含 smoke v3 结果）

## 1. 定位

本轨验证 **western-en 通用搜索层**（Fandom、Wikipedia、Bing 等），与手游 BWiki 特化轨（`roster.json`）分离。

固定验收集 6 部作品：

- 黑袍纠察队
- 漫威
- DC
- 魔戒
- 哈利波特
- RWBY

**不为**漫威/DC 等单独维护直链表；改进应落在 `fandomWiki.js`、`nativeSearchName.js`、`searchEngine.js` 等通用模块。

## 1.1 通用层设计要点（2026-05-29）

- **手游 BWiki 特化轨保留**（`biligameWiki.js` / `roster.json`），本轨不改特化逻辑。
- **欧美源用母语检索名**：确定 `sourceWork` + `western-en` 后，Fandom / Wikipedia / Bing 使用英文 `nativeCharName`（见 `nativeSearchName.js`）；萌娘百科仍用中文 `作品名:角色名` 作兜底。
- **Fandom 子站自动发现**：`workSynonyms.js` 提供 6 部验收集作品的中英别名，辅助 `site:fandom.com` 发现 `*.fandom.com`。

## 2. 角色抽选规则

每部作品 **6 名角色**，分三层：

| 层级 | 数量 | 含义 |
|------|------|------|
| `latest` | 2 | 高辨识度 / 近期热门角色 |
| `obscure` | 2 | 冷门或低热度角色 |
| `mid` | 2 | 中人气角色 |

主名单见 `roster-famous-western-acg.json` 的 `works` 字段；轮换池见同文件 `pools` 字段。

### 轮换规则

1. 每次完整 benchmark 跑 `works` 中的当前 36 人。
2. 跑完后将 `作品:角色名` 追加到 `usedInRun`（脚本自动写入）。
3. 下一轮若需换血：从 `pools` 同层级选未出现在 `usedInRun` 的角色替换 `works` 对应位。
4. 若某层 pool 用尽，可清空 `usedInRun` 或从 pool 头部循环。

### 挑选原则

优先：

- 高辨识度（验证基础路由）
- 易同名混淆（验证消歧）
- 冷门（验证非头部角色）

避免：纯职位名、极短单字名（除非专门测消歧）。

## 3. 命令

### Smoke（搜索 + 抓页，无 AI）

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --skip-enrich
```

### 单作品 smoke

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --only-work=哈利波特 \
  --skip-enrich
```

### 全量补全

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --concurrency=3
```

### Acceptance

```bash
node scripts/eval-enrichment-benchmark.js \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json
```

## 4. 验证顺序

每次改通用层后：

1. `node -c` 检查语法
2. 单作品 smoke（建议：哈利波特 → 魔戒 → RWBY → 漫威/DC → 黑袍纠察队）
3. 36 人 smoke
4. 单作品全量补全
5. 36 人全量 + acceptance

## 5. Smoke 通过线（参考）

| 指标 | 目标 |
|------|------|
| `searchProbeNoPage`（pageLen &lt; 200） | 持续下降；改通用层后应明显低于仅 Bing 基线 |
| `topSources` 含 `fandom` | 多数欧美角色应出现 |
| `pageSource` | 优先 `fandom` / `wikipedia`，少 `bing` 脏站 |
| `sphere` | 全部为 `western-en` |

## 5.1 Smoke 实测记录

### 基线（仅 Bing + 脏站，改通用层前）

| 指标 | 数值 |
|------|------|
| `pageLen ≥ 200` | **8 / 36** |
| 典型问题 | `resultCount=5` 但 `pageLen=0`；顶部结果含知乎、汽车站、字典站等 |
| 文化圈路由 | 六部作品均为 `western-en` ✓ |

报告：`benchmark-report-famous-western-acg.json`（2026-05-29 早期 `--skip-enrich`）

### v3（Fandom + 萌娘兜底 + 脏站过滤，**母语名解析上线前**）

跑法：同上 smoke 命令；日志 `benchmark-run-western-smoke-v3.log`；耗时约 79 分钟。

| 指标 | 数值 |
|------|------|
| `pageLen ≥ 200` | **34 / 36** |
| `pageLen = 0` | **2**（`比利·布彻尔`、`山姆卫斯·詹吉`） |
| Wikipedia | 全程 **0 条**（本机 `zh/en.wikipedia.org` 连接超时） |
| Fandom 命中 | 哈利波特 6/6、RWBY 6/6 搜索结果含 Fandom；多数 `pageSource` 仍为萌娘百科 |
| 漫威 / DC | 基本有正文；部分 `pageLen` 偏短（如洛基 518、超人 613） |

**按作品 smoke 抓页（pageLen ≥ 200）**

| 作品 | 通过 | 失败 |
|------|------|------|
| 黑袍纠察队 | 5/6 | 比利·布彻尔 |
| 漫威 | 6/6 | — |
| DC | 6/6 | — |
| 魔戒 | 5/6 | 山姆卫斯·詹吉 |
| 哈利波特 | 6/6 | — |
| RWBY | 6/6 | — |

### v3 后补丁（母语名 `nativeSearchName.js`）

| 角色 | 中文名 | 解析后 `nativeCharName` | 说明 |
|------|--------|-------------------------|------|
| 哈利·波特 | ✓ | `Harry Potter` | Wikipedia / 萌娘外文名 |
| 祖国人 | ✓ | `Homelander` | 萌娘角色页外文名 |
| 比利·布彻尔 | v3 失败 | `Billy Butcher` | 萌娘作品页「屠夫」语境 + Fandom API；**v3 跑在补丁前** |

> 母语名补丁合并后须 **重跑 36 人 smoke** 更新本节数据。单点验证：哈利波特 6/6 全 Fandom；黑袍 5/6（补丁前）。

## 5.2 已知限制

| 限制 | 影响 | 缓解 |
|------|------|------|
| Wikipedia 超时 | `nativeSearchName` 的 langlink / en.wikipedia 链路常不可用 | 萌娘外文名、Fandom 子站 API、作品页语境推断 |
| 中文名 + 英文-only Fandom | 未解析出 `nativeCharName` 时 Fandom 搜不到 | `originalName` 字段；扩展萌娘/Fandom 回退 |
| 萌娘无独立角色页 | 如比利·布彻尔（搜 `作品:角色` 无词条） | 作品页昵称（屠夫）+ Fandom；或 `originalName` |
| Smoke 耗时长 | 36 人串行探测约 60–80 分钟 | 先用 `--only-work=` 单作品验证 |
| 抓页源偏萌娘 | v3 多数 `pageSource=moegirl` 而非 Fandom | 不影响 smoke 通过线；全量补全阶段再验提取质量 |

## 6. 故障分类

| 现象 | 优先查 |
|------|--------|
| `resultCount=0` | `discoverFandomHost`、Wikipedia 查询 |
| `resultCount>0` 但 `pageLen=0` | `nativeCharName` 是否解析为英文、Fandom API/抓页、Bing 脏 URL、`JUNK_URL_RE` |
| `pageSource=moegirl` 但正文过短或错页 | 萌娘标题打分、`_pageTextRelevant` 角色名一致性 |
| `extract-rejected` | `_validateWebInfo`、同名消歧 |
| `incomplete-base` | 页面解析、完整度校验 |

## 7. 相关文件

| 文件 | 职责 |
|------|------|
| `src/main/import/nativeSearchName.js` | 按文化圈解析母语检索名（`western-en` → 英文） |
| `src/main/import/workSynonyms.js` | 验收集 6 部作品中英别名（Fandom 子站发现） |
| `src/main/import/fandomWiki.js` | 通用 Fandom 子站发现与 MediaWiki API |
| `src/main/import/searchEngine.js` | 源注册、`western-en` 优先级、分源查询名 |
| `roster-famous-western-acg.json` | 36 人主名单 + pools |
| `ROSTER-WESTERN.md` | 人类可读角色表 |
| `benchmark-run-western-smoke-v3.log` | v3 smoke 终端日志 |
