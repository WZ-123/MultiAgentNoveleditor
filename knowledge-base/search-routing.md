# 联网搜索路由逻辑

最后更新：2026-05-08

> ⚠️ 此为**单一真相源**。本文件描述的搜索路由逻辑有两处使用者：
> 1. **Direct-API 搜索补全**（`characterEnricher.js` / `searchEngine.js`）—— 调用者通过 `enrich_character` MCP 工具触发
> 2. **Claude Code Skill**（`.claude/skills/search-routing/SKILL.md`）—— 系统驱动模式下告知 Claude Code agent 搜索策略
>
> 修改任意一方时，须同步更新本文件和另一方。下方每个规则末尾标记了对应的代码位置。

---

## 1. 文化圈检测

```
原作作品名 → detectSphere()
  ├── 中日韩 ACG → east-asian-{cn,jp,kr}
  ├── 欧美作品 → western-en
  └── 其他/未知 → global
```

`detectSphere()` 在 `src/main/import/culturalSphere.js` 中实现。规则：
- 作品名含中文字符 + 萌娘百科能搜到 → `east-asian-cn`
- 作品名含日文假名或知名日本 IP（如 Fate、东方） → `east-asian-jp`
- 作品名含韩文 → `east-asian-kr`
- 其他 → `western-en`

## 2. 来源优先级

每个文化圈有固定的搜索引擎优先级顺序：

| 文化圈 | 搜索源优先级 |
|--------|-------------|
| `east-asian-cn` | 萌娘百科 → Bing → Wikipedia → DuckDuckGo |
| `east-asian-jp` | Wikipedia → 萌娘百科 → Bing → DuckDuckGo |
| `east-asian-kr` | Wikipedia → Bing → 萌娘百科 → DuckDuckGo |
| `western-en` | Wikipedia → Bing → DuckDuckGo |
| `global` | Wikipedia → Bing → DuckDuckGo |

来源定义见 `src/main/import/searchEngine.js` 中的 `SOURCES` 注册表和 `sourcePriority()` 函数。

## 3. 查询语句构建

每个搜索引擎有特定的查询格式，见 `src/main/import/searchEngine.js` 中的 `buildQueries()`：

| 搜索源 | 查询格式 |
|--------|----------|
| 萌娘百科 | `作品名:角色名`（如 `碧蓝航线:爱宕`）→ 若空则回退 `作品名 角色名` |
| Wikipedia | `角色名 作品名 character` → 回退 `角色名 作品名` |
| Bing | `角色名 作品名 character wiki` → 回退 `角色名 作品名` |
| DuckDuckGo | 同上 Bing 格式 |

## 4. 搜索结果获取

`fetchBestPage()` 在 `src/main/import/searchEngine.js` 中：
1. **优先取百科来源**（萌娘百科 → Wikipedia）的页面内容
2. 次选通用搜索引擎结果
3. 取首个内容质量 > 200 字符的页面
4. 页面内容切片 12000 字符传给 AI 提取

## 5. AI 提取字段

`_extractFromPage()` 在 `src/main/import/characterEnricher.js` 中，发送页面内容给 AI 提取结构化 JSON：

```json
{
  "appearance": "外貌描写（含发色、瞳色、身高、服装）",
  "hairColor": "发色",
  "eyeColor": "瞳色",
  "height": "身高/体型",
  "figure": "身材特点",
  "personality": "性格特征",
  "background": "背景故事",
  "moeTraits": "萌点（逗号分隔）",
  "quotes": "台词（分号分隔）",
  "skins": "皮肤/服装列表"
}
```

提取规则：
- 如果页面内容不完整，可根据页面中出现的角色设定关键词合理推断
- 优先从页面内容提取，只有页面完全未提及该角色的任何信息时才留空
- 严禁无依据虚构

## 6. 合并逻辑

`_mergeWebInfo()` 在 `src/main/import/characterEnricher.js` 中：

```
对每个字段:
  小说无值 + 网络有值 → 使用网络值
  小说有值 + 网络有值 + 两者不同 → 保留小说值，追加「（参考原作设定: ...）」
  两者都无值 → 跳过 (filledCount 不变)

filledCount === 0 → 标记 extract-empty（AI 提取未产生实质内容）
filledCount > 0   → 标记 success
```

## 7. 回退策略

1. 首次搜索按文化圈来源优先级执行（并行查询）
2. 若主优先级来源返回 0 条或仅 DuckDuckGo 结果 → 回退相邻文化圈（如 cn→jp）
3. 若相邻文化圈仍无结果 → 回退全局 DuckDuckGo
4. 若全部无结果 → 标记 search-failed

---

**代码位置映射：**
- 文化圈检测 → `src/main/import/culturalSphere.js:detectSphere()`
- 来源注册 + 优先级 → `src/main/import/searchEngine.js:SOURCES, sourcePriority()`
- 查询构建 → `src/main/import/searchEngine.js:buildQueries()`
- 页面选择 → `src/main/import/searchEngine.js:fetchBestPage()`
- AI 提取 → `src/main/import/characterEnricher.js:_extractFromPage()`
- 合并逻辑 → `src/main/import/characterEnricher.js:_mergeWebInfo()`
- 回退策略 → `src/main/import/characterEnricher.js:_enrichOneCharacter()`

<!-- 此文件的 Claude Code Skill 版本在 .claude/skills/search-routing/SKILL.md -->
