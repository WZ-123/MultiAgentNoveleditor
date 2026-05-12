# 角色联网搜索策略（Character Search Strategy）

## 概述

当小说为二创/同人作品时，需要为来自原作的角色补全官方设定信息（外貌、性格、背景、萌点等）。本策略定义了多源搜索的路由规则、查询格式和失败降级机制。

## 文化圈检测与搜索优先级

根据作品名判断文化圈，决定搜索源优先级：

| 文化圈 | 搜索源优先级 | 适用作品 |
|--------|------------|---------|
| `east-asian-cn` | 萌娘百科 → Bing → Wikipedia | 中文圈作品（碧蓝航线、原神、崩坏系列等） |
| `east-asian-jp` | Wikipedia → 萌娘百科 → Bing | 日本作品（Fate、东方Project、鬼灭之刃等） |
| `east-asian-kr` | Wikipedia → Bing → 萌娘百科 | 韩国作品（蔚蓝档案、妮姬等） |
| `western-en` | Wikipedia → Bing | 欧美作品（哈利波特、漫威、DC等） |
| `global` | Wikipedia → Bing | 无法确定文化圈时 |

## 搜索源查询格式

为避免同名角色混淆，查询必须同时包含作品名和角色名：

| 搜索源 | 首选查询格式 | 示例 |
|--------|------------|------|
| 萌娘百科 | `{作品名}:{角色名}` | `碧蓝航线:爱宕` |
| 萌娘百科 (fallback) | `{作品名} {角色名}` | `碧蓝航线 爱宕` |
| Wikipedia | `{角色名} {作品名} character` | `Atago Azur Lane character` |
| Bing / DuckDuckGo | `{角色名} {作品名} character wiki` | `爱宕 碧蓝航线 character wiki` |

> **重要**：查询中必须包含作品名。没有作品名限定会导致同名角色混淆（例如"爱宕"可能指向《碧蓝航线》或《舰队Collection》的不同角色）。

## 搜索失败 Fallback 策略

当主文化圈的搜索源返回 0 结果时，按以下顺序尝试：

1. **相邻文化圈回退**：
   - `east-asian-cn` → 尝试 `east-asian-jp`
   - `east-asian-jp` → 尝试 `east-asian-cn`
   - `east-asian-kr` → 尝试 `east-asian-jp`
   - `western-en` → 尝试 `global`

2. **全局搜索回退**：使用 DuckDuckGo 进行无文化圈限制的搜索

3. **标记失败**：所有源均返回 0 结果时，标记 `_enrichmentStatus = 'search-failed'`，继续处理其他角色

## 页面获取与 AI 提取

1. 获取搜索结果中最佳页面的内容
2. 若页面内容过短（<100 字符），尝试下一个搜索结果
3. 使用 AI 从页面内容中提取结构化角色信息：
   - `appearance`：完整外貌描写（发色、瞳色、身高/体型、常服）
   - `hairColor`、`eyeColor`、`height`、`figure`
   - `personality`：性格特征（具体表现，不要标签）
   - `background`：角色背景故事
   - `moeTraits`：萌点列表（逗号分隔）
   - `quotes`：代表性台词（分号分隔，最多3句）
   - `skins`：皮肤/不同时期信息

4. 若 AI 提取返回空内容，标记 `_enrichmentStatus = 'extract-empty'`，不覆盖现有数据

## 数据合并原则

- **小说数据优先**：若角色卡已有某字段，网络数据作为参考追加，不覆盖
  - 例如：`appearance: "黑发\n（参考原作设定: 黑长直，及腰）"`
- **空字段填充**：仅当角色卡字段为空时，用网络数据填充
- **来源标记**：每次补全写入 `_enrichmentSource`
  - 格式：`sphere=east-asian-cn sources=moegirl,bing`
- **状态标记**：写入 `_enrichmentStatus`
  - `success`：成功补全至少一个字段
  - `extract-empty`：AI 提取结果为空
  - `search-failed`：所有搜索源返回 0 结果
  - `fetch-failed`：页面获取失败
  - `extract-failed`：AI 提取失败
  - `skipped`：原创角色或用户跳过

## 多作品交叉同人处理

当小说同时引用多部原作时：

1. 每个角色需明确标记 `sourceWork`（所属原作）
2. 按 `sourceWork` 分组角色
3. 对每个作品独立调用搜索补全
4. 不同作品使用各自的文化圈路由规则

## 用户决策边界

- `isOriginal`（是否为原创角色）**必须由用户声明**，AI 不得自动判断
- `sourceWork` 可由 AI 在提取阶段初步识别，但最终归属由用户确认
- 用户可随时跳过联网补全，角色保持原始提取状态
