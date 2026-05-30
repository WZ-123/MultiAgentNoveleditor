# 联网搜索路由逻辑

最后更新：2026-05-29

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
| `east-asian-cn` | **Biligame Wiki**（已知六游子 wiki，直链优先）→ **Bangumi**（`chii.in` / `api.bgm.tv`）→ 萌娘百科 → Bing → Wikipedia（代理回退，不拖垮主链路）→ DuckDuckGo |
| `east-asian-jp` | **Bangumi**（角色 API）→ 萌娘百科 → Wikipedia → Bing → DuckDuckGo |
| `east-asian-kr` | Wikipedia → **Bangumi** → Bing → 萌娘百科 → DuckDuckGo |
| `western-en` | **Fandom Wiki**（自动发现子站；搜/抓页用英文 `nativeCharName`）→ Wikipedia → **萌娘百科**（中文角色名兜底）→ Bing → DuckDuckGo |
| `global` | **Fandom Wiki** → Wikipedia → 萌娘百科 → Bing → DuckDuckGo |

来源定义见 `src/main/import/searchEngine.js` 中的 `SOURCES` 注册表和 `sourcePriority()` 函数。

## 3. 查询语句构建

**母语搜索原则**：确定 `sourceWork` 与文化圈后，各源使用**该文化圈母语**检索名（`nativeSearchName.js`）：
- `western-en`：Fandom / Wikipedia / Bing 使用 **英文** `nativeCharName`（如 `哈利·波特` → `Harry Potter`，`比利·布彻尔` → `Billy Butcher`）
- 小说 UI 名（中文）仍用于萌娘百科等中文源，以及合并展示
- 解析顺序：`originalName` → 萌娘角色页外文名 → 萌娘作品页 wikilink → Fandom 子站 API（作品语境）→ Wikipedia langlink → en.wikipedia
- **已知限制**：本环境 `zh/en.wikipedia.org` 常连接超时；萌娘无独立角色页时需作品页语境或 `originalName`（见 `western-enrichment-benchmark.md` §5.2）

每个搜索引擎有特定的查询格式，见 `src/main/import/searchEngine.js` 中的 `buildQueries()`：

| 搜索源 | 查询格式 |
|--------|----------|
| 萌娘百科 | `作品名:角色名`（如 `碧蓝航线:爱宕`）→ 若空则回退 `作品名 角色名` |
| Biligame Wiki | 先把作品名映射到已知子 wiki slug，再在子 wiki 内搜索 `角色名` → 回退 `作品名 角色名` |
| Bangumi | 优先 `角色名 作品名`，回退 `角色名`；搜索走 `POST /v0/search/characters`，再用 `GET /v0/characters/{id}/subjects` 做作品消歧 |
| Wikipedia | `角色名 作品名 character` → 回退 `角色名 作品名` |
| Bing | `角色名 作品名 character wiki` → 回退 `角色名 作品名`；`western-en` 时用 `www.bing.com` + `en-US` |
| DuckDuckGo | 同上 Bing 格式 |
| Fandom Wiki | 先 `site:fandom.com` 发现 `{wiki}.fandom.com` 子站，再在该子站 MediaWiki API 搜 **`nativeCharName`**（`western-en` 优先 `en`，中文角色名作回退） |

**Fandom 通用策略**（`fandomWiki.js`，无作品直链表）：
- `discoverFandomHost(作品名)`：Bing `"作品名" site:fandom.com` 提取 `*.fandom.com`；合并 **作品同义词组**（`workSynonyms.js` 内 `WORK_SYNONYM_GROUPS`，覆盖欧美验收集 6 部中英别名）；必要时经 zh.wikipedia en langlink
- `fandomSearchResults`：子站内 `list=search` 使用 **`nativeCharName`**；中文名无命中时，经萌娘/Fandom 作品语境或 zh.wikipedia en langlink 得英文官方名再搜
- API 无结果时 Bing `site:{host} {角色名}` 回退
- `fandomFetchPage`：`action=parse`；失败时 URL 回退 `fetchWebPage`
- 欧美 smoke 验收集见 `roster-famous-western-acg.json` 与 `knowledge-base/western-enrichment-benchmark.md`

当前已验证并内置的 Biligame 子 wiki 映射（`biligameWiki.js`，**手游特化轨保留**）：
- `碧蓝航线` → `blhx`
- `原神` → `ys`
- `崩坏：星穹铁道` / `崩坏星穹铁道` → `sr`
- `绝区零` → `zzz`
- `鸣潮` → `wutheringwaves`

**BWiki 直链策略**：MediaWiki API 若返回 HTML（WAF），不中断搜索；`resolveBiligamePageTitle()` 级联别名表 → API → 搜索页 HTML → Bing `site:wiki.biligame.com/{slug}`，并构造 `buildBiligamePageUrl()`。`fetchPage` 失败时必走 `fetchWebPage(url)`。

标题别名维护：`test-projects/web-enrichment-benchmark-2026/bwiki-title-aliases.json`。

若作品名没有已知 slug 映射，则 Biligame 源自动跳过，不会硬猜子 wiki。

**代理**：外网请求经 `networkFetch.js` 读取 `HTTPS_PROXY`/`HTTP_PROXY`；启动前可 `export HTTPS_PROXY=...`。

**Bangumi 代理补充**：若桌面浏览器内能访问 `chii.in` / `api.bgm.tv`，但 shell/benchmark 超时，可先用 `scripts/with-electron-proxy.sh` 从 Electron 会话继承真实代理，再运行 benchmark。

## 4. 搜索结果获取

`fetchBestPage()` 在 `src/main/import/searchEngine.js` 中：
1. **优先取百科来源**（Fandom → Bangumi → 萌娘百科 → Biligame Wiki → Wikipedia）的页面内容
2. 次选通用搜索引擎结果
3. 跳过 `opensearch`、`desc.php`、合并 URL、TapTap 等脏标题/脏 URL，取首个内容质量 > 200 字符的页面
4. BWiki 正文上限 24000 字符；时装子页经 `collectSkinFollowUpUrls()` 追加（最多 6 页）
5. 页面内容传给 AI 提取；`parseSkinBlocks()` 结果与 LLM `skins[]` merge（页面优先）
6. 鸣潮 BWiki 页面额外走 `parseWutheringWavesProfile()` 基础资料兜底：只整理页面已写明的简介、属性、武器、势力、共鸣能力；发色/瞳色/身高若页面未明确公开，记为“未明确”，不允许模型脑补
7. Bangumi 页面优先走官方角色 API，把 `summary`、`infobox`、`subjects` 展平成正文文本，再交给统一提取链路
8. 若首选信源提取后基础字段仍偏瘦（常见于 Bangumi 只有简介/基础档案、缺少外貌细节），则按文化圈优先级继续搜索第二信源做**交叉补源**；只补缺失字段，不覆盖已有且已锚定字段

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
- 只能提取页面里已经明确写出的事实
- 页面信息不完整或存在歧义时，相关字段必须留空，不能根据弱线索补写
- AI 输出的发色、瞳色、身高若无法在页面正文或外貌摘要中锚定，会在完整度校验前清空，避免因推断字段导致整条角色被拒
- 首选页若字段不够满，可再取第二信源交叉补充；补充字段同样必须能在对应页面中锚定
- 若联网搜索没有发生、没有结果、或没有拿到页面正文，必须直接失败，不能使用模型训练数据补全
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
- 母语检索名 → `src/main/import/nativeSearchName.js:resolveNativeCharacterName(), resolveNativeWorkName()`
- 作品同义词（Fandom 发现）→ `src/main/import/workSynonyms.js:WORK_SYNONYM_GROUPS`
- Fandom 子站/API → `src/main/import/fandomWiki.js`
- 来源注册 + 优先级 → `src/main/import/searchEngine.js:SOURCES, sourcePriority()`
- 查询构建 → `src/main/import/searchEngine.js:buildQueries()`
- 页面选择 → `src/main/import/searchEngine.js:fetchBestPage()`
- AI 提取 → `src/main/import/characterEnricher.js:_extractFromPage()`
- 合并逻辑 → `src/main/import/characterEnricher.js:_mergeWebInfo()`
- 回退策略 → `src/main/import/characterEnricher.js:_enrichOneCharacter()`

<!-- 此文件的 Claude Code Skill 版本在 .claude/skills/search-routing/SKILL.md -->
