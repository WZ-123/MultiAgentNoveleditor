# 角色联网补全系统文档

最后更新：2026-05-31

## 1. 系统定位

角色联网补全系统是 MultiAgentNovelAssistant 导入流程的子系统，用于在小说导入阶段为二创/同人作品中的角色自动补全原作设定信息（外貌、性格、背景、萌点等）。

> 基准测试、补充 roster、回归循环的操作手册见：
> [knowledge-base/character-enrichment-benchmark-loop.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/character-enrichment-benchmark-loop.md)
>
> 最新补源测试用例与验收记录（含东亚与欧美文化圈）见：
> [knowledge-base/latest-east-asian-enrichment-test-case.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/latest-east-asian-enrichment-test-case.md)
>
> 欧美文化圈**通用层**验收集（保留 BWiki 等特化轨，欧美走通用搜索）见：
> [knowledge-base/western-enrichment-benchmark.md](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/western-enrichment-benchmark.md)

系统核心理念：
- **用户决策优先**：AI 提供检测建议，但最终是否启用补全、引用哪些作品，由用户在导入流程中显式确认
- **批量操作**：支持一次性标记多个角色的原创/二创属性，避免逐个操作
- **多作品支持**：同一部小说可能引用多部原作（crossover），每个角色可独立选择归属作品
- **搜索透明**：详细记录每个角色的搜索源、查询语句和结果片段，防止 AI 幻觉
- **候选姓名先行**：Chatbox/长篇导入时，人物分析前先分片抽取候选姓名，再用本地反证过滤剔除章节名、动作短语、外貌描述和 synthetic id；不得把全文直接丢给人物分析任务

---

## 2. 数据流图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              导入流程                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户选择文件 → 解析 → target选择 → [fanwork-check] → pick-dir/confirm      │
│                                               ↓                             │
│                                      询问是否为二创                         │
│                                      若是，填写引用作品列表                   │
│                                               ↓                             │
│                                      创建 Staging → AI 分析（6任务并行）     │
│                                               ↓                             │
│                                      [character-review]                     │
│                                               ↓                             │
│                                      展示角色列表                             │
│                                      批量标记原创/二创                        │
│                                      二创角色选择所属作品                     │
│                                               ↓                             │
│                                      点击"开始联网补全"                      │
│                                               ↓                             │
│                              ┌────────────────┐                             │
│                              │  联网补全引擎   │                             │
│                              │  （按作品分组） │                             │
│                              └────────────────┘                             │
│                                               ↓                             │
│                                      按作品分组调用 enrichCharacters         │
│                                      搜索 → 获取页面 → AI提取 → 合并         │
│                                               ↓                             │
│                                      写回 Staging → Promote → 打开小说      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 角色 JSON Schema

角色数据以单文件 JSON 存储于 `{novelDir}/characters/{id}.json`：

```json
{
  "schemaVersion": 1,
  "id": "拼音或英文唯一标识",
  "name": "小说中的名字",
  "aliases": ["别名/绰号"],
  "gender": "男/女",
  "age": "年龄",
  "role": "在故事中的定位",
  "appearance": "外貌描写",
  "hairColor": "发色",
  "eyeColor": "瞳色",
  "height": "身高/体型",
  "figure": "身材特点",
  "personality": "性格特征",
  "background": "背景故事",
  "moeTraits": "萌点列表（逗号分隔）",
  "quotes": "代表性台词（分号分隔）",
  "skins": [
    { "name": "皮肤名", "outfit": "服装妆造", "story": "故事背景", "quotes": "该皮肤台词", "scenario": "适用场景（可选）" }
  ],
  "relationships": [{ "with": "对方名字", "type": "关系类型" }],
  "storyArc": "剧情中的作用",
  "protagonist": true,
  "sourceWork": "原作名称（如果是同人/二创角色）",
  "originalName": "原作中的名字（如果与小说中的名字不同）",
  "isOriginal": false,
  "_enrichmentSource": "sphere=east-asian-cn sources=moegirl,bing",
  "_enrichmentStatus": "success"
}
```

### 关键字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `isOriginal` | `boolean` | **用户声明**。`true` = 原创角色（跳过联网补全）；`false` = 二创角色（参与补全） |
| `sourceWork` | `string` | 角色所属原作名称。由用户在 `character-review` 步骤选择，或由联网补全写入 |
| `originalName` | `string` | 角色在原作中的官方名字。当小说中的名字与原作不同时填写 |
| `_enrichmentSource` | `string` | 补全来源标记。格式：`sphere={文化圈} sources={搜索源列表}` |
| `_enrichmentStatus` | `string` | 补全状态：`success` \| `extract-empty` \| `search-failed` \| `fetch-failed` \| `extract-failed` \| `extract-rejected` \| `incomplete-skins` \| `incomplete-base` \| `skipped` |
| `_pageSnapshot` | `string` | 基准测试用：当次抓取正文片段（约 8k），供验收锚定 |
| `_pageUrl` | `string` | 当次最佳页面 URL |

> **设计原则**：`isOriginal` 必须由用户声明，AI **不得**自动判断。`sourceWork` 和 `originalName` 可由 AI 在提取阶段初步识别（从文本中找线索），但最终准确性依赖联网补全验证。

---

## 4. ImportNovelPanel 状态机

导入面板采用多步骤状态机管理流程。完整状态列表：

```
select → parse → target → fanwork-check → pick-dir → confirm → analysis → character-review → analysis-done → done → duplicate → conflict-report
```

### 状态流转条件

| 当前状态 | 用户操作 | 下一状态 | 条件/说明 |
|---------|---------|---------|----------|
| `select` | 点击"解析文件" | `parse` | 文件解析中 |
| `parse` | 解析完成且无重复 | `target` | 解析成功 |
| `parse` | 检测到重复 | `duplicate` | 显示重复导入提示 |
| `target` | 点击"下一步" | `fanwork-check` | 无论 new/existing 都进入 |
| `fanwork-check` | 点击"下一步" | `pick-dir` | targetMode === 'new' |
| `fanwork-check` | 点击"下一步" | `confirm` | targetMode === 'existing' |
| `pick-dir` | 点击"开始导入并分析" | `analysis` | 创建 staging 后开始 AI 分析 |
| `confirm` | 点击"确认导入并自动分析" | `analysis` | 同上 |
| `analysis` | 分析完成且 hasFanwork=true | `character-review` | 显示角色标记 UI |
| `analysis` | 分析完成且 hasFanwork=false | `analysis-done` | 原创小说，直接完成 |
| `character-review` | 点击"跳过补全" | `analysis-done` | 不执行联网补全 |
| `character-review` | 补全完成后点击"完成导入" | `analysis-done` | 写回角色数据并 promote |
| `analysis-done` | targetMode === 'existing' | `conflict-report` | 进入冲突检测 |
| `analysis-done` | targetMode === 'new' | `done` | 显示导入成功 |
| `duplicate` | 点击"重新导入" | `target` | 废弃旧 staging，重新走流程 |
| `duplicate` | 点击"复用已有结果" | `analysis-done` | 直接加载已有分析结果 |

---

## 5. 联网补全引擎

### 5.1 搜索源注册表

**文件**: `src/main/import/searchEngine.js`

| 源 ID | 标签 | 支持区域 | 说明 |
|-------|------|---------|------|
| `moegirl` | 萌娘百科 | `zh-CN`, `zh-TW` | 中文 ACGN 百科，匿名访问 `moegirl.icu/api.php` |
| `bangumi` | Bangumi | `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR` | 东亚角色库；优先用官方角色 API + 关联作品做消歧 |
| `fandom` | Fandom Wiki | 全球 | 自动发现 `*.fandom.com`；`western-en` 用英文 `nativeCharName` 搜/抓页 |
| `bing` | Bing 搜索 | 全球 | HTML 爬取有机结果；`western-en` 用 `www.bing.com` + `en-US` |
| `wikipedia` | Wikipedia | 全球 | API 搜索，支持多语言 |
| `duckduckgo` | DuckDuckGo | 全球 | HTML 爬取，全局 fallback |

### 5.2 文化圈路由

**文件**: `src/main/import/culturalSphere.js`

根据作品名检测文化圈，决定搜索源优先级：

| 文化圈 | 搜索源优先级 | 适用作品 |
|--------|------------|---------|
| `east-asian-cn` | Biligame Wiki → Bangumi → 萌娘百科 → Bing → Wikipedia | 中文圈作品（碧蓝航线、原神等） |
| `east-asian-jp` | Bangumi → 萌娘百科 → Wikipedia → Bing | 日本作品（Fate、东方等） |
| `east-asian-kr` | Wikipedia → Bangumi → Bing → 萌娘百科 | 韩国作品 |
| `western-en` | Fandom Wiki → Wikipedia → 萌娘百科 → Bing | 欧美作品；Fandom/Wikipedia/Bing 用英文 `nativeCharName`（`nativeSearchName.js`） |
| `global` | Wikipedia → Bing | 无法确定时 |

### 5.3 查询构建

**文件**: `src/main/import/searchEngine.js` → `buildQueries()`

按搜索源定制查询格式，避免同名混淆：

| 搜索源 | 首选查询格式 | 示例 |
|--------|------------|------|
| 萌娘百科 | `{作品名}:{角色名}` | `碧蓝航线:爱宕` |
| 萌娘百科 (fallback) | `{作品名} {角色名}` | `碧蓝航线 爱宕` |
| Fandom | `{nativeCharName}` 或 `{nativeWorkName} {nativeCharName}` | `Billy Butcher`（`比利·布彻尔`） |
| Wikipedia | `{nativeCharName}` 或 `{角色名} {作品名} character` | `Harry Potter` |
| Bing/DDG | `{nativeWorkName} {nativeCharName}`（western-en） | `The Boys Billy Butcher` |

**母语名解析**：`src/main/import/nativeSearchName.js`；作品别名（Fandom 发现）：`src/main/import/workSynonyms.js`。欧美 benchmark 见 `knowledge-base/western-enrichment-benchmark.md`。

### 5.4 双模式补全

**文件**: `src/main/import/characterEnricher.js`

#### 传统模式（`enrichmentMode === 'traditional'`）
1. `detectSphere(fanworkName)` 检测文化圈
2. `searchCharacter()` 按文化圈路由并行搜索多源
3. `fetchBestPage()` 获取最佳结果的页面内容
4. `_extractFromPage()` 调用 AI 提取结构化信息
5. 若首选信源字段偏瘦，按文化圈优先级继续取第二信源交叉补足缺失字段
6. `_mergeWebInfo()` 合并网络数据与小说数据（小说优先）

#### LLM 智能模式（`enrichmentMode === 'llm'`）
1. 构造 system prompt，定义 `web_search` tool schema
2. 调用 `provider.sendMessage({ tools: [webSearchTool] })`
3. 若返回 `tool_use`，执行搜索并将结果追加到对话
4. LLM 可自主进行多轮搜索（先搜作品确认，再搜角色）
5. 最终返回结构化 JSON

### 5.5 按作品分组补全

当小说引用多部作品时，`enrichStagingCharacters` handler 会将角色按 `sourceWork` 分组，对每个作品独立调用 `characterEnricher.enrichCharacters()`：

```js
for (const [workName, charIds] of Object.entries(workAssignments)) {
  const group = allChars.filter(c => charIds.includes(c.id));
  const enriched = await characterEnricher.enrichCharacters(
    group, null, 'zh-CN',
    { fanworkNameOverride: workName }
  );
}
```

---

## 6. 批量标记 UI

**文件**: `src/components/ImportNovelPanel.jsx` → `step === 'character-review'`

### 界面结构

```
┌─────────────────────────────────────────────┐
│  角色归属标记（共 N 个角色）                    │
├─────────────────────────────────────────────┤
│  [全部原创] [全部二创]                        │
├─────────────────────────────────────────────┤
│  ☑ 爱宕    原创 ○ 二创 ●  [碧蓝航线 ▼]      │
│  ☑ 高雄    原创 ○ 二创 ●  [碧蓝航线 ▼]      │
│  ☑ 小明    原创 ● 二创 ○  ----              │
├─────────────────────────────────────────────┤
│  [跳过补全]      [开始联网补全角色信息]        │
└─────────────────────────────────────────────┘
```

### 状态设计

```js
const [characterMarks, setCharacterMarks] = useState([
  { id, name, isOriginal: true, selected: true, sourceWork: '', data: ch },
]);
```

### 批量操作
- **全部原创**：将所有角色的 `isOriginal` 设为 `true`，清空 `sourceWork`
- **全部二创**：将所有角色的 `isOriginal` 设为 `false`，默认填充第一部作品

### 单角色操作
- **复选框**：决定是否参与补全（未勾选的角色不发送给补全引擎）
- **原创/二创单选**：切换角色类型
- **作品下拉框**：仅当二创且引用多部作品时显示，选择具体归属

---

## 7. 错误处理与降级策略

| 阶段 | 可能错误 | 降级策略 |
|------|---------|---------|
| AI 分析 | 角色提取失败 | 从大纲中 fallback 提取角色名 |
| 搜索 | 某搜索源超时/封禁 | 自动 fallback 到相邻文化圈，最后尝试 DuckDuckGo |
| 搜索 | 所有源返回 0 结果 | 标记 `_enrichmentStatus = 'search-failed'`，继续处理其他角色 |
| 页面获取 | 页面内容过短 | 尝试下一个搜索结果 |
| AI 提取 | 返回空内容 | 标记 `_enrichmentStatus = 'extract-empty'`，不覆盖现有数据 |
| 合并 | 小说已有该字段 | **小说数据优先**，网络数据作为参考追加 |

---

## 8. 配置项

**文件**: `src/main/store/appConfig.js`

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `searchEngine` | `string` | `'auto'` | 搜索源偏好：`auto` \| `moegirl` \| `wikipedia` \| `duckduckgo` \| `all` |
| `enrichmentMode` | `string` | `'traditional'` | 补全模式：`traditional` \| `llm` |
| `enrichmentConcurrency` | `number` | `10` | 并发处理角色数 |

---

## 9. 相关文件速查

| 文件 | 职责 |
|------|------|
| `src/main/import/searchEngine.js` | 多源搜索引擎、文化圈路由、查询构建 |
| `src/main/import/nativeSearchName.js` | 母语检索名解析（`western-en` → 英文） |
| `src/main/import/fandomWiki.js` | Fandom 子站发现与 MediaWiki API |
| `src/main/import/workSynonyms.js` | 验收集作品中英别名（Fandom 发现） |
| `src/main/import/characterEnricher.js` | 补全核心：搜索→获取页面→AI提取→合并 |
| `src/main/import/analyzer.js` | 导入分析器：6任务并行提取，**不再自动触发补全** |
| `src/main/import/stagingProject.js` | Staging 项目 CRUD，持久化 fanwork 元数据 |
| `src/main/ipc/import.js` | IPC 层：`getStagingCharacters` / `saveStagingCharacters` / `enrichStagingCharacters` |
| `src/components/ImportNovelPanel.jsx` | 导入面板 UI：`fanwork-check` + `character-review` 步骤 |
| `src/components/CharacterEnrichPanel.jsx` | 独立补全面板（手动触发时使用） |
| `src/components/DataTabContent.jsx` | 数据浏览：角色卡展示、批量操作 |
| `preload.js` | IPC 桥接暴露 |
| `knowledge-base/western-enrichment-benchmark.md` | 欧美通用轨 benchmark 规则与 smoke 实测 |
| `knowledge-base/character-enrichment-benchmark-loop.md` | Benchmark 循环手册（双轨策略） |
| `knowledge-base/chatbox-import.md` | Chatbox 导入最终稿整理、角色候选识别与旧脏数据删除规则 |
