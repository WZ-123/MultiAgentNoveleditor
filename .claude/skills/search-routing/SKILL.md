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
- `east-asian-cn`: 萌娘百科(优先) → Biligame Wiki（已知作品子 wiki）→ Bing → Wikipedia → DuckDuckGo
- `east-asian-jp`: Wikipedia → 萌娘百科 → Bing → DuckDuckGo
- `east-asian-kr`: Wikipedia → Bing → 萌娘百科 → DuckDuckGo
- `western-en/global`: Wikipedia → Bing → DuckDuckGo

### 查询构建
- 萌娘百科: `作品名:角色名`（如 `碧蓝航线:爱宕`）
- Biligame Wiki: 先映射到已知子 wiki，再在子 wiki 内搜 `角色名`
- Wikipedia: `角色名 作品名 character`
- Bing/DuckDuckGo: `角色名 作品名 character wiki`

当前内置的 Biligame 子 wiki 映射：`碧蓝航线`→`blhx`，`原神`→`ys`，`崩坏：星穹铁道`→`sr`。没有映射就跳过，不硬猜。

### 提取字段
从搜索结果页面提取 JSON：
- appearance, hairColor, eyeColor, height, figure
- personality, background, moeTraits, quotes, skins

### 合并规则
- 小说无值 → 用网络值
- 两者有值且不同 → 保留小说值，追加 `（参考原作设定: ...）`
- 全部空 → 失败：extract-empty

### 严格约束
- 没有发生真实联网搜索时，不允许接受模型直出 JSON 作为角色设定
- 没有页面正文证据时，字段必须留空或直接失败，不能靠训练数据补全

详细规则见 `knowledge-base/search-routing.md`。
