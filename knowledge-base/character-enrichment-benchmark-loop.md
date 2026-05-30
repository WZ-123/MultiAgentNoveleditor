# 角色联网补全 Benchmark 循环手册

最后更新：2026-05-29

## 1. 目标

这份手册用于指导 agent 循环执行角色联网补全的测试、定位、修复和复跑流程，避免每次从零摸索。

### 双轨策略

| 轨道 | Roster | 改代码范围 |
|------|--------|-----------|
| **特化轨** | `roster.json`（6 款 BWiki 手游等） | 保留 `biligameWiki.js`、作品别名、鸣潮等专用逻辑 |
| **通用轨** | `roster-famous-western-acg.json`（欧美 6 IP） | 只改搜索/抓页/解析通用层，不为单个欧美 IP 硬编码 |

欧美通用轨的抽选、轮换与验收指标见：
[knowledge-base/western-enrichment-benchmark.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/western-enrichment-benchmark.md)

适用场景：
- 扩展新的文化圈作品测试集
- 跟进某一作品或角色的补全失败
- 调整搜索源、抓页逻辑、字段提取、完整度校验
- 批量验证回归是否变好或变坏
- **加强 `western-en` 通用能力**（优先跑欧美 roster smoke）

这份流程默认服务于：
- [scripts/run-enrichment-benchmark.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/scripts/run-enrichment-benchmark.js)
- [scripts/eval-enrichment-benchmark.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/scripts/eval-enrichment-benchmark.js)
- [test-projects/web-enrichment-benchmark-2026](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026)

---

## 2. 流程总览

完整循环固定按下面顺序走：

1. 选作品和角色样本
2. 跑 `search + fetch` smoke
3. 看 `benchmark-report` 中的 `searchProbes`
4. 判断问题属于搜索、抓页、提取、还是完整度校验
5. 改对应代码
6. 先重跑单作品或补充 roster
7. 通过后再重跑主 benchmark
8. 运行 acceptance，记录结果
9. 把新流程、样本和规律写回知识库

不要一上来就跑完整 36 角色补全。先 smoke，再局部补全，再全量回归。

---

## 3. 样本选择规则

### 主 benchmark 规则

主 benchmark 每个作品使用 6 个角色：
- `latest`：2 个近期新角色
- `obscure`：2 个冷门/低热度角色
- `mid`：2 个中人气角色

角色名单放在：
- [roster.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/roster.json)

### 补充 smoke roster 规则

当要测试新文化圈或新作品群时，不直接污染主 benchmark。

做法：
- 新建一个独立 roster 文件
- 仍然保持每个作品 6 个角色，结构与主 roster 相同
- 用 `--roster=...` 和 `--report=...` 单独运行

现有补充 roster：
- [roster-famous-jp-acg.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/roster-famous-jp-acg.json)
- [roster-famous-western-acg.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json) — **通用层主验收集**（见 [western-enrichment-benchmark.md](western-enrichment-benchmark.md)、[ROSTER-WESTERN.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/ROSTER-WESTERN.md)）

### 角色挑选建议

优先选这三类：
- 高辨识度角色：验证基础搜索路由是否成立
- 容易同名混淆的角色：验证查询构建和结果排序
- 冷门角色：验证不是只对头部角色有效

避免：
- 纯泛称、纯职位名、极短单字名
- 作品内大量重名的边缘角色，除非就是要测 disambiguation

---

## 4. 命令模板

### 4.1 主 benchmark 全量

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
node scripts/run-enrichment-benchmark.js --concurrency=3
```

如果浏览器内能联网，但命令行 / benchmark 对外站超时，可改用 Electron 代理包装：

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
scripts/with-electron-proxy.sh \
  node scripts/run-enrichment-benchmark.js --concurrency=3
```

### 4.2 单作品局部复跑

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
node scripts/run-enrichment-benchmark.js --only-work=鸣潮 --concurrency=3
```

### 4.3 只跑搜索抓页 smoke

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-jp-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-jp-acg.json \
  --skip-enrich
```

`scripts/with-electron-proxy.sh` 会先调用 Electron 会话解析当前真实代理，再把 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 注入给后续命令。适用于 `bgm.tv` / `chii.in` 这类浏览器可达、shell 不可达的站点。

### 4.4 评估 acceptance

```bash
node scripts/eval-enrichment-benchmark.js
```

如果是单独报告：

```bash
node scripts/eval-enrichment-benchmark.js \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-jp-acg.json
```

### 4.5 欧美通用轨 smoke

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --skip-enrich
```

验收指标与实测记录见 [western-enrichment-benchmark.md](western-enrichment-benchmark.md)。

---

## 5. 报告怎么看

### 5.1 `benchmark-report.json`

核心字段：
- `searchProbes[]`：搜索和抓页 smoke 结果
- `enrichResults[]`：补全阶段结果
- `summary.statusCounts`：状态计数
- `summary.searchProbeNoPage`：探测时拿不到正文的数量

### 5.2 `acceptance-report.json`

核心字段：
- `successRate`
- `accuracyRate`
- `perGame`
- `details[]`

### 5.3 先看哪里

先按这个顺序看：

1. `searchProbes[].pageLen`
2. `searchProbes[].topSources` 和 `topTitles`
3. `enrichResults[].status`
4. `acceptance.details[].completeness`

经验上：
- `pageLen=0`：优先看搜索源和抓页
- `status=extract-rejected`：优先看误页、锚定失败、同名混淆
- `status=incomplete-base`：优先看页面字段是否真的缺，还是解析/兜底没做
- `status=incomplete-skins`：优先看多皮肤页面解析

---

## 6. 故障分类与处理

### A. 搜不到结果

表现：
- `resultCount=0`
- `topSources` 为空或只有失败信息

优先检查：
- [culturalSphere.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/import/culturalSphere.js)
- [searchEngine.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/import/searchEngine.js) 的 `buildQueries()` 和 `sourcePriority()`

处理方向：
- 给作品补 `KNOWN_IPS`
- 调整查询格式，强制带作品名
- 补充更适合该文化圈的搜索源

### B. 搜到了但抓不到正文

表现：
- `resultCount > 0`
- `pageLen=0` 或很短

优先检查：
- `topTitles`
- `pageSource`
- [searchEngine.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/import/searchEngine.js) 的 `fetchBestPage()`

处理方向：
- 过滤脏标题/脏 URL
- 给作品加直链候选
- 给文化圈补专用 wiki/fandom 源
- 把抓页 fallback 从搜索页切到结构更稳定的角色页

### C. 抓到页但提取错角色

表现：
- `extract-rejected`
- 页面里有角色名，但内容明显来自其他作品或其他人物

优先检查：
- [characterEnricher.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/import/characterEnricher.js) 的 `_validateWebInfo()`
- 结果排序和同名消歧规则

处理方向：
- 提高作品名和角色名在标题里的匹配权重
- 加禁止词规则
- 加页面标题与角色名的显式一致性校验

### D. 抓到页但基础字段不够

表现：
- `incomplete-base`
- 页面明明有简介/档案，但 AI 没写全

优先检查：
- [wikiContentParser.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/import/wikiContentParser.js)
- [characterEnricher.js](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/import/characterEnricher.js) 的 `_validateCompleteness()`

处理方向：
- 给该站型做确定性 profile parser
- 明确“未公开/未明确”的字段写法
- 在完整度校验前清空无法锚定的 AI 推断字段

### E. 多皮肤页面失败

表现：
- `incomplete-skins`

优先检查：
- `parseSkinBlocks()`
- `collectSkinFollowUpUrls()`
- `mergeSkinArrays()`

处理方向：
- 让抓页追加时装子页
- 提高表格/分隔符解析兼容性
- 对同站点页面单独做皮肤块解析

---

## 7. 文化圈测试策略

### 东亚作品

目标：
- 优先验证 `moegirl`、`biligame` 这类结构化百科
- 再看 Bing 兜底是否稳定

重点看：
- 同名角色是否被其他作品污染
- BWiki 直链是否可用
- 页面里的“基本资料/档案/服饰”能否被 parser 消化

### 欧美作品（通用轨主测试集）

**固定 6 部作品**：黑袍纠察队、漫威、DC、魔戒、哈利波特、RWBY（各 6 角色，共 36 人）。

完整抽选规则、轮换池、smoke 通过线与命令见 [western-enrichment-benchmark.md](western-enrichment-benchmark.md)。

目标：
- 先确认 `western-en` 路由正确
- 再确认通用源（Fandom + 母语 `nativeCharName`）能否拿到角色级正文

**实测进展**（详见 [western-enrichment-benchmark.md](western-enrichment-benchmark.md) §5.1）：

| 阶段 | `pageLen ≥ 200` | 说明 |
|------|-----------------|------|
| 基线（仅 Bing + 脏站） | **8 / 36** | 大量 `resultCount=5` 但 `pageLen=0` |
| v3（Fandom + 脏站过滤 + 萌娘兜底） | **34 / 36** | 失败：比利·布彻尔、山姆卫斯·詹吉；Wikipedia 全程 0 条（超时） |
| v3 后（`nativeSearchName.js`） | 待重跑 | 单点已验证 `Billy Butcher`、`Harry Potter`、`Homelander` |

当前经验：
- 仅靠 `Wikipedia + Bing + DuckDuckGo` 不够稳；**Fandom 通用层 + 脏站过滤** 已将 smoke 从 8/36 提升到 34/36
- **欧美源必须用英文 `nativeCharName`**，不能直接用中文 UI 名搜 Fandom
- 萌娘百科常作抓页兜底（v3 多数 `pageSource=moegirl`），smoke 通过线以 `pageLen` 为准
- **不要**为漫威/DC 等单独写直链表；作品别名仅放在 `workSynonyms.js` 供 Fandom 子站发现

单作品验证建议顺序：哈利波特 → 魔戒 → RWBY → 漫威/DC → 黑袍纠察队。

---

## 8. 修改后的验证顺序

每次改动后，按这个顺序验证：

1. `node -c` 检查改动文件语法
2. 重跑单作品或补充 roster smoke
3. 如果 smoke 变好，再跑单作品补全
4. 如果单作品通过，再跑主 benchmark
5. 最后跑 acceptance

不要跳过中间层级直接全量回归。

---

## 9. 文档同步要求

只要改了搜索路由或补全流程，至少同步这些位置：

- [knowledge-base/search-routing.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/search-routing.md)
- [knowledge-base/western-enrichment-benchmark.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/western-enrichment-benchmark.md)
- [character-enrichment-system.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/character-enrichment-system.md)
- 对应 roster 的 README 用法说明

如果新增了文化圈 smoke roster，也要把命令写进 README。

---

## 10. 推荐工作法

一个 agent 跑这套流程时，建议节奏是：

1. 先建立独立 roster 和独立 report
2. 用 smoke 把问题缩小到“搜索/抓页/提取/校验”四类之一
3. 改最小范围代码
4. 局部复跑
5. 把有效经验写回知识库

真正重要的不是一次性把所有作品补完，而是把循环做得稳定、可复现、可移交。
