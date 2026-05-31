# 角色联网补源最新测试用例

最后更新：2026-05-30

## 1. 目的

这份文档记录 2026-05-29 到 2026-05-30 这一轮角色联网补全改造后的最新测试用例，供后续 agent 复跑、对比和回归。

本轮改造目标有四项：

1. 保留六款中国二游的专项优化，不回退：
   - `碧蓝航线`
   - `蔚蓝档案`
   - `原神`
   - `崩坏：星穹铁道`
   - `绝区零`
   - `鸣潮`
2. 把 `Bangumi` 接入东亚通用搜索源，并提高其在 `east-asian-jp` 路由中的权重
3. 把“首信源字段不够满时，继续用第二信源交叉补源”的策略写进实际补全流程
4. 继续维护欧美文化圈通用层验证集，确保通用搜索补全的改动不会只对东亚有效

## 2. 测试项目

### 2.1 通用东亚补充集

使用补充 roster：

- [roster-famous-jp-acg.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/roster-famous-jp-acg.json)

覆盖作品：

- `东方Project`
- `Fate/stay night`
- `舰队Collection`
- `魔法禁书目录`
- `葬送的芙莉莲`
- `鬼灭之刃`

每部作品 6 个角色，结构与主 benchmark 一致：

- `latest` 2 个
- `obscure` 2 个
- `mid` 2 个

### 2.2 欧美文化圈通用集

使用补充 roster：

- [roster-famous-western-acg.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json)

覆盖作品：

- `黑袍纠察队`
- `漫威`
- `DC`
- `魔戒`
- `哈利波特`
- `RWBY`

每部作品同样是 6 个角色：

- `latest` 2 个
- `obscure` 2 个
- `mid` 2 个

### 2.3 最新单角色完整 enrich 用例

本轮额外选了 2 个角色做完整 enrich 验证：

1. `食蜂操祈` / `魔法禁书目录`
2. `爱丽丝菲尔` / `Fate/stay night`

选这两个角色的原因：

- `食蜂操祈`：适合验证 Bangumi 主源下，字段偏瘦时的交叉补源策略
- `爱丽丝菲尔`：适合验证 Fate 体系角色在 Bangumi 中的基础档案是否足够支撑完整 enrich

## 3. 模型与运行前提

### 3.1 联网补全模型

联网补全过程中的提取模型来自 `characterEnricher.js` 内部的 `modelAliases.getAlias('haiku')`。

本轮测试时实际映射为：

- alias: `haiku`
- provider: `deepseek-v4-pro`
- model: `deepseek-v4-flash`

也就是说，本轮联网补全提取实际使用的是 **`deepseek-v4-flash`**。

### 3.2 代理前提

Bangumi / `chii.in` 在浏览器内可达，但 shell 环境不一定直接可达。

本轮测试统一通过：

- [with-electron-proxy.sh](/Users/potablewater/Desktop/MultiAgentNovelAssistant/scripts/with-electron-proxy.sh)

从 Electron 会话继承真实代理，再运行命令。

## 4. 测试方法流程

### 4.1 东亚补充集 smoke

目的：

- 只验证 `search + fetch`
- 不跑 AI 提取
- 看 Bangumi 是否成为东亚主供页源

命令：

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
scripts/with-electron-proxy.sh \
node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-jp-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-jp-acg.json \
  --skip-enrich
```

观察项：

1. `searchProbes[].resultCount`
2. `searchProbes[].pageLen`
3. `searchProbes[].pageSource`
4. `searchProbes[].topSources`

### 4.2 欧美文化圈 smoke

目的：

- 验证 `western-en` 通用搜索层
- 观察 `Fandom / Wikipedia / 萌娘兜底` 是否形成有效供页链
- 验证补源思路在非东亚作品上是否也有意义

命令：

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
scripts/with-electron-proxy.sh \
node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --skip-enrich
```

观察项：

1. `searchProbes[].sphere` 是否稳定为 `western-en`
2. `searchProbes[].topSources` 是否出现 `fandom`
3. `searchProbes[].pageSource` 是否优先落在 `fandom / wikipedia / moegirl`
4. `searchProbes[].pageLen` 是否明显优于纯 Bing 脏站基线

### 4.3 单角色完整 enrich

目的：

- 验证首信源提取
- 验证完整度校验
- 验证交叉补源逻辑
- 看 `_enrichmentSource` 是否正确记录来源

做法：

1. 构造最小角色对象
2. 直接调用 `characterEnricher.enrichCharacters()`
3. 指定 `fanworkNameOverride`
4. 记录：
   - `_enrichmentStatus`
   - `_enrichmentSource`
   - `_pageUrl`
   - `_pageSnapshot`
   - 关键字段填充结果

## 5. 验收标准

### 5.1 东亚补充集 smoke 验收

最低标准：

1. 大多数 `east-asian-jp` 样本应由 `bangumi` 进入 `topSources[0]`
2. 大多数样本 `pageSource` 应为 `bangumi`
3. `pageLen=0` 的角色数应显著少于未接入 Bangumi 时

推荐标准：

1. `36` 个 probe 中，`>= 30` 个角色能拿到正文
2. `pageSource === 'bangumi'` 的角色数 `>= 24`
3. 剩余失败样本集中在 Bangumi 数据缺失，而不是抓取链路失效

### 5.2 欧美文化圈 smoke 验收

最低标准：

1. 多数角色 `sphere === 'western-en'`
2. 多数角色 `topSources` 中出现 `fandom`
3. `pageLen=0` 的数量应显著低于仅靠 Bing 的早期基线

推荐标准：

1. `36` 个 probe 中，`>= 24` 个角色拿到可用正文
2. `pageSource` 主要落在 `fandom / wikipedia / moegirl`
3. 剩余失败样本主要来自角色本身资料稀薄，而不是路由完全找错站

### 5.3 单角色完整 enrich 验收

对单角色测试，满足以下条件即可视为通过：

1. `_enrichmentStatus === 'success'`
2. `_pageUrl` 非空
3. `_pageSnapshot` 非空
4. 至少补全出以下字段中的 3 项：
   - `appearance`
   - `personality`
   - `background`
   - `height`
   - `hairColor`
   - `eyeColor`
5. 若首信源字段偏瘦，允许继续尝试第二信源，但第二信源补出的字段必须能被页面正文锚定

## 6. 本轮结果摘要

### 6.1 东亚补充集 smoke

报告：

- [benchmark-report-famous-jp-acg.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-jp-acg.json)

本轮结果：

- `probeCount = 36`
- `bangumiPages = 34`
- `bangumiTop1 = 34`
- `noPage = 2`
- `shortUnder400 = 3`

仍未拿到正文的样本：

1. `葬送的芙莉莲 / 欣梅尔`
2. `鬼灭之刃 / 胡蝶忍`

页长偏短但不再是空页的样本：

1. `葬送的芙莉莲 / 芙莉莲`
2. `葬送的芙莉莲 / 菲伦`
3. `葬送的芙莉莲 / 修塔尔克`

### 6.2 欧美文化圈 smoke

报告：

- [benchmark-report-famous-western-acg.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json)

配套说明：

- [western-enrichment-benchmark.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/western-enrichment-benchmark.md)

当前文档层面的结论：

1. 欧美线仍然是**通用层**问题，不应像六款二游那样为单个 IP 继续堆定向直链
2. `Fandom + 母语名 + 垃圾结果过滤` 仍是欧美文化圈最重要的主线
3. “字段不够满就补第二源”的思路同样适用欧美线，但前提是首轮就能稳定命中正确角色页

### 6.3 单角色完整 enrich

#### 食蜂操祈 / 魔法禁书目录

- 状态：`success`
- 主页：Bangumi
- 结果特点：
  - `appearance / personality / background / height / figure` 均有值
  - `hairColor` 已能稳定保住为 `金发`
  - `eyeColor` 仍偏弱

#### 爱丽丝菲尔 / Fate/stay night

- 状态：`success`
- 主页：Bangumi
- 结果特点：
  - `appearance / personality / background / height / figure` 均有值
  - 但 `hairColor / eyeColor` 在当前页面证据下仍可能为空

## 7. 结论

本轮测试说明四件事：

1. `Bangumi` 已经足以成为东亚通用角色补全的主供页源之一
2. “首信源不够满就继续补第二信源”的策略值得保留，而且应该继续扩展
3. 六款中国二游的专项优化仍应保留在专用 adapter 层，不应为了通用化而回退
4. 欧美文化圈仍应坚持“通用 source adapter + 母语名 + Fandom/Wikipedia”路线，而不是回到 IP 特判

## 8. 后续建议

下一步优先级建议：

1. 提高第二信源的命中率，尤其是 `moegirl / wikipedia`
2. 为 Bangumi `infobox` 再加一层更确定性的字段解析，减少对 LLM 自由抽取的依赖
3. 对 `欣梅尔`、`胡蝶忍` 这类空页样本做定向排查，确认是搜索问题还是站内数据缺失
4. 继续用欧美 36 角色集验证“补源策略”不会只对东亚成立
