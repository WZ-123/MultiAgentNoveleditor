# 角色带入式写作流程设计

最后更新：2026-06-02

## 背景

用户希望写作时，每个在剧情中出场的角色都能由一个 subagent 根据角色卡与角色自身记忆带入其中，生成更真实的言语、动作、心理反应；同时这些自由反应又必须服从章节大纲，不把剧情带偏。

核心张力：

- 角色必须像“活人”一样，根据自身认知、欲望、关系和记忆做反应。
- 章节必须像“小说”一样，遵循大纲中的剧情目标、转折、信息揭露节奏和结局位置。
- 角色可以抵触大纲安排，但抵触本身应成为可用的创作信号，而不是直接破坏大纲。

## 结论

不要让“每个角色 subagent 直接写正文”。推荐架构是：

```
大纲场景拆解
  → 角色私有上下文/记忆包
  → 角色反应 subagents 并行提案
  → 导演/编剧仲裁
  → Writer 成文
  → 现有人设/时空/行文审查与修订闭环
  → 写后更新角色记忆
```

也就是：角色 subagent 负责“角色会怎样真实反应”，导演层负责“哪些反应能进入大纲框架”，writer 负责“把批准后的反应写成正文”。

角色可以自由发挥，但没有直接落笔权。

## 现有系统可复用能力

### Subagent 运行能力

- `src/main/runtime/runSubagent.js`
- 支持 provider-agnostic subagent 执行。
- 支持 MCP 工具白名单。
- 支持写作 agent 的多轮 continuation。

### 角色上下文过滤

- `src/main/mcp/tools.js`
- 已有：
  - `read_character_context`
  - `assemble_scene_context`
  - `filterCharacterContext()`

当前过滤版角色上下文包含：

- id/name/aliases/role/faction
- personality
- appearance
- hairColor/eyeColor/height/figure/moeTraits/quotes
- needBackground 时包含 background
- outfit 命中时包含对应 skin

这正好可以作为角色 actor 的基础输入，避免完整角色卡导致 token 爆炸。

### 大纲节点元数据

`OutlineNode` 已有适合场景编排的字段：

- characters
- outfit
- setting
- needBackground
- pov
- location
- volumeIndex / sectionIndex / chapterIndex

这些字段可以作为场景角色调度的入口。

### 写作审查闭环

当前写作流程已包含：

- 草稿生成
- 逻辑/人设审查
- 时空审查
- 必要时修订
- 写后摘要/时间线/大纲状态同步

角色带入式写作不应替代这些审查，而应在草稿生成前增强“角色真实反应”的素材质量，生成后继续走现有审查闭环。

## 新增核心概念

### 1. 角色私有记忆包

当前角色卡没有真正的“角色自身记忆”。角色卡描述的是静态设定，时间线描述的是客观事件，摘要描述的是作者视角记录。角色 actor 需要的是“这个角色自己记得什么、误解什么、在意什么”。

建议新增文件：

```
characters/{characterId}.memory.json
```

建议结构：

```json
{
  "schemaVersion": 1,
  "characterId": "shinano",
  "lastUpdatedChapterRef": "chapter-003.md",
  "factsKnown": [
    {
      "id": "fact-001",
      "chapterRef": "chapter-001.md",
      "summary": "她知道指挥官曾在雨夜隐瞒了舰队调令。",
      "confidence": "certain"
    }
  ],
  "emotionalMemory": [
    {
      "id": "emo-001",
      "chapterRef": "chapter-002.md",
      "target": "commander",
      "emotion": "不安、依赖、轻微怨怼",
      "trigger": "对方再次以保护为由隐瞒事实"
    }
  ],
  "relationshipDeltas": [
    {
      "id": "rel-001",
      "chapterRef": "chapter-002.md",
      "targetCharacterId": "commander",
      "delta": "信任下降，但依赖加深",
      "evidence": "她没有追问，却开始单独调查。"
    }
  ],
  "unresolvedIntentions": [
    {
      "id": "intent-001",
      "summary": "想弄清指挥官隐瞒的真正原因",
      "urgency": "medium"
    }
  ],
  "privateMisbeliefs": [
    {
      "id": "belief-001",
      "summary": "她误以为调令来自上级，而不是指挥官本人。",
      "shouldRevealBy": "chapter-006.md"
    }
  ]
}
```

重点：

- 角色记忆是“角色知道的版本”，不等于客观事实。
- 允许记录误解、偏见、未完成意图。
- 每章写完后自动更新。
- 写作前只注入当前场景相关片段，不注入完整记忆文件。

### 2. 场景约束包

给每个场景生成一个 `SceneConstraintPacket`，作为角色自由发挥的边界。

建议结构：

```json
{
  "sceneId": "scene-003",
  "chapterRef": "chapter-004.md",
  "title": "雨夜对峙",
  "location": "旧码头",
  "timeHint": "深夜",
  "pov": "shinano",
  "appearingCharacterIds": ["shinano", "commander", "akagi"],
  "mustHappen": [
    "信浓发现指挥官隐瞒了调令",
    "赤城在场但不直接揭穿真相",
    "场景末尾信浓决定独自调查"
  ],
  "mustNotHappen": [
    "不能在本场景公开调令真正来源",
    "不能让信浓与指挥官彻底决裂",
    "不能改变下一场景发生地点"
  ],
  "allowedFreedom": [
    "角色可以选择沉默、试探、质问或转移话题",
    "可以增加符合人设的小动作和心理反应",
    "可以调整对话顺序，只要保留场景结果"
  ],
  "continuityFacts": [
    "上一章信浓已开始怀疑指挥官",
    "时间线显示赤城此时已经知道部分真相"
  ]
}
```

### 3. 角色反应提案

角色 actor 不输出正文，而输出结构化提案。

建议 schema：

```json
{
  "characterId": "shinano",
  "sceneId": "scene-003",
  "knownFactsUsed": ["fact-001"],
  "currentObjective": "确认指挥官是否再次隐瞒她",
  "emotionalState": "克制、不安、带有被保护后的委屈",
  "speechCandidates": [
    {
      "text": "您又打算一个人决定吗？",
      "tone": "轻声，但带质问",
      "intent": "试探对方是否承认隐瞒"
    }
  ],
  "actionCandidates": [
    {
      "text": "她没有立刻靠近，只把伞沿压低了一点。",
      "intent": "保持距离，掩饰情绪"
    }
  ],
  "innerStateCandidates": [
    {
      "text": "她已经猜到答案，却还想听他亲口说。",
      "intent": "表现依赖与失望并存"
    }
  ],
  "wouldResistOutline": true,
  "resistanceReason": "按当前记忆，她不会轻易接受指挥官的解释。",
  "outlineSafeAlternative": "她可以表面沉默离开，保留大纲要求的独自调查，而不是当场决裂。",
  "risks": [
    {
      "type": "outline_drift",
      "note": "如果她当场追问到底，会提前揭示真相。"
    }
  ]
}
```

关键：

- `wouldResistOutline` 是特性，不是错误。
- 抵触大纲时，角色必须提供“保留大纲结果的替代表达”。
- 角色 actor 只能表达自身，不负责其他角色。

### 4. 导演仲裁结果

导演层负责把多个角色提案合并成可写场景蓝图。

建议 schema：

```json
{
  "sceneId": "scene-003",
  "outlineCompliance": "pass",
  "approvedBeats": [
    {
      "order": 1,
      "type": "action",
      "characterId": "shinano",
      "content": "信浓保持距离，没有立刻靠近。",
      "sourceProposal": "shinano/action-001"
    },
    {
      "order": 2,
      "type": "dialogue",
      "characterId": "shinano",
      "content": "您又打算一个人决定吗？",
      "sourceProposal": "shinano/speech-001"
    }
  ],
  "rejectedProposals": [
    {
      "sourceProposal": "commander/speech-002",
      "reason": "会提前公开调令来源，违反 mustNotHappen。"
    }
  ],
  "directorNotesForWriter": [
    "本场景紧张感应来自克制，而不是爆发争吵。",
    "结尾必须落在信浓独自调查的决定上。"
  ],
  "remainingRisks": []
}
```

## 推荐 subagent 设计

### sa-character-actor

用途：从单一角色视角生成反应提案。

工具权限建议：

- `read_character_context`
- `query_timeline`
- 未来新增：`read_character_memory`

不允许：

- `write_chapter`
- `update_character`
- `append_timeline`
- `update_world`
- 完整 `read_character` 默认也不建议开放，除非专门处理长背景回忆。

Prompt 核心原则：

- 你只扮演一个角色，不是作者。
- 你只能依据角色知道的信息反应。
- 你可以抵触大纲安排，但必须提供保持大纲结果的替代表达。
- 不写完整正文，只输出 JSON。
- 不替其他角色说话。

### sa-scene-director

用途：合并所有角色反应，判断哪些可采纳，确保大纲不偏。

工具权限建议：

- `read_outline_nodes`
- `query_timeline`
- `query_world`
- 可选：`read_character_context`

Prompt 核心原则：

- 你是导演/编剧，不是角色。
- 优先保护大纲的 mustHappen / mustNotHappen。
- 尽量保留角色真实抵触，让它转化成更可信的达成方式。
- 输出场景蓝图，不写最终正文。

### sa-character-memory-updater

用途：章节写完后，为出场角色更新私有记忆。

工具权限建议：

- `read_chapter`
- `read_outline_nodes`
- `query_timeline`
- `read_character_memory`
- `write_character_memory` 或 `patch_character_memory`

Prompt 核心原则：

- 只记录该角色能知道/感受到/误解到的内容。
- 不把作者知道但角色不知道的真相塞进记忆。
- 记忆要短、可检索、面向后续写作。

## 推荐服务层

新增：

```
src/main/runtime/chapterRoleplayService.js
```

主要函数：

```js
async function buildRoleplayPlanForChapter({
  targetChapter,
  userText,
  compactContext,
  abortSignal,
})
```

内部流程：

1. 读取目标章节匹配的大纲节点。
2. 将章节拆成 scene packets。
3. 对每个 scene 找出出场角色。
4. 为每个角色构造 actor input。
5. 并行调用 `sa-character-actor`。
6. 调用 `sa-scene-director` 合并。
7. 输出 `roleplayPlan`，交给 writer。

示意：

```json
{
  "chapterRef": "chapter-004.md",
  "scenePlans": [
    {
      "sceneId": "scene-003",
      "approvedBeats": [],
      "directorNotesForWriter": [],
      "remainingRisks": []
    }
  ],
  "globalWriterNotes": [
    "所有角色反应已按大纲约束过滤，writer 不要新增未经批准的重大动机。"
  ]
}
```

然后在 `chapterDraftService` 中，把 `roleplayPlan` 注入 `buildDraftInput()`：

```text
角色带入式场景蓝图：
<roleplayPlan JSON>

写作要求：
- 必须遵循 scenePlans 中 approvedBeats。
- 可以润色、连缀、扩展感官细节，但不得改变 approvedBeats 的剧情含义。
- 不得新增会改变 mustHappen/mustNotHappen 的角色行动。
```

## 与 DAG 的关系

第一版不建议直接改 DAG 做复杂动态 fan-out，因为“每章出场角色数量不固定”，DAG 静态节点不适合表达“每个角色一个 subagent”。

推荐先做服务层动态 fan-out：

```
chapterDraftService
  → chapterRoleplayService
      → runSubagent(sa-character-actor) * N
      → runSubagent(sa-scene-director)
  → runSubagent(sa-writer)
  → 现有审查
```

后续如果 DAG 支持动态 map/fan-out，再把 roleplay step 提升为 DAG node kind。

## 记忆更新流程

章节写入确认后，当前已有 `chapterPostWriteService.persistChapterArtifacts()` 会做摘要、时间线、大纲回写。

建议在该服务后增加：

```
updateCharacterMemoriesForChapter(draft, analysis)
```

流程：

1. 从章节正文和 outlineContext 找出出场角色。
2. 对每个角色生成“该角色可知道的事件与情绪变化”。
3. 更新 `characters/{id}.memory.json`。
4. 若无法确定角色是否知道某事实，写入 `privateMisbeliefs` 或跳过，不能默认全知。

注意：

- 写记忆应是自动写文件，但内容必须保守。
- 如果模型返回空记忆，不应清空旧记忆。
- 如果角色未出场但被提及，一般只更新“被他人认知”，不更新该角色自身记忆。

## Token 控制策略

必须把 token 控制当成一等设计目标。

### 角色 actor 输入上限

每个角色 actor 输入建议包含：

- 场景约束：最多 800-1200 字
- 角色过滤上下文：最多 800 字
- 角色记忆：最多 8 条，每条 80-120 字
- 关系状态：最多 5 条
- 近期时间线：最多 5 条

不要给：

- 完整章节历史
- 完整大纲
- 完整角色卡
- 全部世界观

### 角色数量上限

单场景建议：

- 核心角色：最多 4 个 actor 并行
- 次要角色：由 director 或 writer 只按角色卡摘要处理
- 群体角色：合并成 group actor，例如“舰队成员”“村民”“反派小队”

### 记忆检索

未来应加入简单检索：

- 按 targetCharacterId
- 按 location
- 按 unresolvedIntentions
- 按最近章节
- 按用户本次写作需求关键词

第一版可以用最近 N 条 + 当前场景出场角色相关条目。

## 失败模式与防护

### 角色带偏大纲

防护：

- actor 输出中必须区分 proposal 和 resistance。
- director 强制检查 mustHappen / mustNotHappen。
- writer 只拿 director-approved beats。
- 写后仍跑现有逻辑/时空审查。

### 角色变成作者视角

防护：

- actor 输入中明确 `knownFacts` 和 `unknownFacts`。
- 禁止 actor 使用“读者知道但角色不知道”的信息。
- 记忆更新时只写角色可感知信息。

### 群戏互相冲突

防护：

- actor 不互相直接对话。
- actor 各自独立提案。
- director 统一排序、取舍、补桥。

### Token 爆炸

防护：

- 动态 fan-out 只对核心角色。
- 使用角色记忆包，不读全书。
- 使用过滤版角色上下文，不读完整角色卡。
- 角色 actor 只输出 JSON 提案，不写长正文。

### 角色记忆污染

防护：

- 记忆更新不覆盖旧记忆，只 append/patch。
- AI 分析失败时不清空旧记忆。
- 不确定事实不写 `factsKnown`，可写 `privateMisbeliefs` 或跳过。

### Writer 无视角色提案

防护：

- writer prompt 明确 approvedBeats 是硬约束。
- directorNotesForWriter 独立注入。
- 生成后用角色一致性审查检查是否偏离。

## 分阶段实现路线

### Phase 1：不落记忆，仅做角色反应提案

目标：验证“角色 actor → director → writer”是否提升正文真实感。

实现：

- 新增 `sa-character-actor`
- 新增 `sa-scene-director`
- 新增 `chapterRoleplayService`
- 从大纲节点和过滤角色上下文构造 actor 输入
- 把 director 输出注入 writer

暂不做：

- 独立角色记忆文件
- 写后记忆更新
- UI 配置

验收：

- 有多角色场景时，writer 输入包含 roleplayPlan。
- actor 不直接写正文。
- director 能拒绝违反大纲的角色提案。
- 现有写作回归不破。

### Phase 2：加入角色私有记忆

实现：

- 新增 store：
  - `readCharacterMemory(novelDir, characterId)`
  - `writeCharacterMemory(...)`
  - `patchCharacterMemory(...)`
- 新增 MCP：
  - `read_character_memory`
  - `patch_character_memory`
- 写作前注入相关记忆。
- 写作后更新角色记忆。

验收：

- 角色在后续章节能延续上一章情绪和误解。
- 未出场角色不被误更新。
- 模型失败不清空记忆。

### Phase 3：角色抵触大纲的可视化与用户控制

实现：

- 当 actor 返回 `wouldResistOutline=true` 且 director 无法安全调和时，向用户展示：
  - 哪个角色抵触
  - 抵触原因
  - 可选大纲保留方案
  - 可选大纲修正方案

验收：

- 用户能决定“保大纲”或“顺角色改大纲”。
- 决策进入后续 writer 输入。

### Phase 4：动态 DAG 化

前提：

- DAG 支持动态 map/fan-out 或服务节点。

实现：

- 将 roleplay service 包装为 DAG node kind。
- 在写作 DAG 中加入：
  - scene_plan
  - character_actor_map
  - scene_director
  - writer

## 建议测试

### 单元测试

- 角色 actor input 不包含完整角色卡。
- 同一场景最多选择核心 N 个角色。
- `wouldResistOutline` 的 actor 输出能被 director 保留为风险而不是直接进入正文。
- director 输出违反 mustNotHappen 时被 gate 拦截。

### 集成测试

- 给定两名角色和一个大纲场景：
  - actor A 提出符合人设但会提前揭密的台词。
  - director 拒绝该台词，并给出安全替代表达。
  - writer 输入只包含安全替代表达。

### 写后记忆测试

- 章节中 A 得知事实，B 不在场。
- 只更新 A 的 `factsKnown`。
- B 的 memory 不变化。

### 回归测试

- 无角色卡项目仍可正常写作。
- 单角色场景不触发多 actor 群戏流程。
- provider 不可用时，现有错误提示不退化。

## 推荐文件清单

第一版可能涉及：

| 文件 | 用途 |
|---|---|
| `src/main/runtime/chapterRoleplayService.js` | 动态角色 actor 编排 |
| `src/main/seeds/builtinSubagents.js` | 新增 `sa-character-actor` / `sa-scene-director` |
| `src/main/runtime/chapterDraftService.js` | 写作前注入 roleplayPlan |
| `src/main/mcp/tools.js` | Phase 2 新增角色记忆工具 |
| `src/main/store/novelData.js` | Phase 2 新增角色记忆读写 |
| `src/domain/types.js` | Phase 2 增加 CharacterMemory typedef |
| `test/character-roleplay-writing-regression.test.js` | 角色带入式写作回归 |

## 关键产品取舍

### 默认是否开启

建议第一版默认关闭，通过写作设置或用户请求开启：

- 普通章节：现有 writer 流程即可。
- 关键群戏/情感冲突：开启角色带入式流程。

原因：

- 多 actor 会增加延迟和成本。
- 不是每章都需要角色模拟。

### 何时触发

可自动触发：

- 当前章节大纲节点出场角色 >= 2
- 用户要求“角色反应真实”“不要 OOC”“群戏”
- 章节类型为冲突、对峙、告白、背叛、谈判、审讯等

可手动触发：

- “用角色带入模式写这一章”
- “让每个角色自己反应一下再写”

### 角色自由度等级

可以设计配置：

- `strict_outline`：角色只在表达方式上自由，大纲事件不可变。
- `balanced`：角色可提出替代达成方式，但结局不变。
- `character_first`：角色强抵触时允许建议修改大纲，需用户确认。

默认推荐 `balanced`。

## 最小实现提示词草案

### sa-character-actor

```text
你是单一角色带入 subagent。你不是作者，也不是旁白。

你只扮演输入中的 targetCharacter。
你只能根据该角色卡、角色记忆、当前场景中该角色能知道的信息做反应。
你不能替其他角色说话，不能写完整正文，不能改写大纲。

如果大纲要求与角色性格/记忆冲突，你必须指出 wouldResistOutline=true，并给出一个仍能保持大纲结果的替代表达。

输出只含 JSON：
{
  "characterId": "...",
  "currentObjective": "...",
  "emotionalState": "...",
  "speechCandidates": [],
  "actionCandidates": [],
  "innerStateCandidates": [],
  "wouldResistOutline": false,
  "resistanceReason": "",
  "outlineSafeAlternative": "",
  "risks": []
}
```

### sa-scene-director

```text
你是场景导演/编剧仲裁者。

你会收到 scene constraints 和多个角色反应提案。
你的任务不是写正文，而是选择、排序、调和这些提案，让它们既符合角色，又不破坏大纲。

硬规则：
- mustHappen 必须发生。
- mustNotHappen 不能发生。
- 如果角色提案会提前揭密、改变关系结局、改变地点时间线，必须拒绝或改成安全替代表达。
- 尽量保留角色的真实抵触，用沉默、回避、试探、误解等方式转化为剧情张力。

输出只含 JSON：
{
  "sceneId": "...",
  "outlineCompliance": "pass|risk|fail",
  "approvedBeats": [],
  "rejectedProposals": [],
  "directorNotesForWriter": [],
  "remainingRisks": []
}
```

## 总结

这个功能的正确边界是：

- 角色 subagent 提供真实反应。
- 导演 subagent 保护大纲。
- writer 只把批准后的反应写成正文。
- 审查流程继续负责兜底。
- 写后角色记忆让角色在后续章节持续“像自己”。

不要把它做成“多角色一起自由写正文”。那样会昂贵、难控、容易偏离大纲。

应该把它做成“角色提案系统 + 大纲约束仲裁系统”。这是既能保留角色生命力，又能维持长篇小说结构的方案。
