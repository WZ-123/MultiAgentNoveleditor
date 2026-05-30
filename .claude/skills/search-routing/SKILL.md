---
name: search-routing
description: 联网搜索路由和策略。告知 Claude Code 在系统驱动模式下如何进行角色联网搜索补全，包括文化圈检测、来源优先级、查询构建、提取和合并逻辑。
allowed-tools: WebFetch, WebSearch, Read
context: fork
---

# 联网搜索路由策略（Skill 版）

> ⚠️ 此 skill 的**单一真相源**在 `knowledge-base/search-routing.md`。本文件是其面向 Claude Code 驱动的转述。
> 修改搜索逻辑时，须同步更新：
> 1. `knowledge-base/search-routing.md`（单一真相源）
> 2. `src/main/import/characterEnricher.js`（Direct-API 搜索补全实现）
> 3. `src/main/import/searchEngine.js`（搜索引擎注册和查询构建）
> 4. 本 skill 文件

## 使用方式

当需要为同人/二创角色联网搜索补全设定时：

1. 读取 `knowledge-base/search-routing.md` 了解完整的搜索路由策略
2. 使用 `WebFetch` 和 `WebSearch` 工具执行搜索
3. 按以下路由策略选择搜索源和构建查询

## 搜索路由策略摘要

### 文化圈判定
- 作品名含中文 → `east-asian-cn`
- 作品名含日文/知名日系IP → `east-asian-jp`
- 作品名含韩文 → `east-asian-kr`
- 其他 → `western-en`

### 来源选择
- `east-asian-cn`: **Biligame Wiki 直链优先**（六游子 wiki）→ 萌娘百科 → Bing → Wikipedia（`networkFetch` 代理）→ DuckDuckGo
- `east-asian-jp`: Wikipedia → 萌娘百科 → Bing → DuckDuckGo
- `east-asian-kr`: Wikipedia → Bing → 萌娘百科 → DuckDuckGo
- `western-en/global`: **Fandom** → Wikipedia → **萌娘百科（中文角色名）** → Bing（en-US）→ DuckDuckGo

### 查询构建
- 确定作品与文化圈后，**欧美源用英文母语名**（`nativeSearchName.js`）：`哈利·波特`→`Harry Potter`，`比利·布彻尔`→`Billy Butcher`
- 萌娘百科仍用中文：`作品名:角色名`
- Biligame: 先映射到已知子 wiki，再在子 wiki 内搜 `角色名`
- Wikipedia/Fandom/Bing（western-en）: 使用 `nativeCharName` + `nativeWorkName`
- Fandom 子站发现用 `workSynonyms.js` 的 `WORK_SYNONYM_GROUPS`

Biligame 映射：`碧蓝航线`→`blhx`，`原神`→`ys`，`星穹铁道`→`sr`，`绝区零`→`zzz`，`鸣潮`→`wutheringwaves`。API 返 HTML 时用 `biligameWiki.js` 直链；别名见 `bwiki-title-aliases.json`。外网请求走 `HTTPS_PROXY`（`networkFetch.js`）。

欧美 smoke：基线 8/36 → v3 34/36（`western-enrichment-benchmark.md`）。Wikipedia 常超时。

### 提取字段
从搜索结果页面提取 JSON（正文上限约 24k，含时装子页）：
- appearance, hairColor, eyeColor, height, figure
- personality, background, moeTraits, quotes（常服默认台词）
- skins: `[{ name, outfit, story, quotes }]`，与 `parseSkinBlocks()` 合并

### 合并规则
- 小说无值 → 用网络值
- 两者有值且不同 → 保留小说值，追加 `（参考原作设定: ...）`
- 全部空 → 失败：extract-empty

### 严格约束
- 没有发生真实联网搜索时，不允许接受模型直出 JSON 作为角色设定
- 没有页面正文证据时，字段必须留空或直接失败，不能靠训练数据补全

详细规则见 `knowledge-base/search-routing.md`。
