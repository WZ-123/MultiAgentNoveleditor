# Chatbox HTML 导入与角色识别

最后更新：2026-05-31

## 目标

Chatbox HTML 不是普通小说文件，而是“用户设定/修订指令/AI 多版正文/寒暄解释”的混合对话记录。导入器必须从完整对话中整理出最终采用稿，再进入现有 staging、AI 分析、角色确认、promote 流程。

## 导入策略

1. 解析 HTML：`chatboxParser.js` 抽取标题、会话标题、`SYSTEM/USER/ASSISTANT` 消息和正文文本。
2. 分段整理：`chatboxDraftExtractor.js` 将 assistant 长篇创作按对话结构分批整理，长篇默认并发 3 批。
3. 版本裁决：用户的设定、人设、大纲、修改意见作为约束；同一情节多版时，以后续用户确认/纠错后的 assistant 正文为准。
4. 输出 JSON：整理器要求 provider 返回 `{ title, chapters, notes }`，但本地必须防御坏 JSON。
5. 进入常规链路：整理出的章节复用 `ImportNovelPanel -> staging -> AI分析 -> promoteToNovel`。

## JSON 防御链

Chatbox 整理结果不能假设 provider 会输出完美 JSON。当前解析链按以下顺序尝试：

1. 标准 `JSON.parse`
2. fenced JSON / 前后说明文字 / 首个平衡 `{...}` 对象
3. JSON5 风格输出：单引号、尾随逗号、非严格对象
4. 本地修复：字符串内部裸换行转义为 `\n`，清理控制字符和尾随逗号
5. 截断/未闭合代码围栏修复
6. 一次 AI JSON 修复重试

失败时错误必须包含批次序号和批次标题；UI 可保持简短，主进程日志保留原始输出片段。

## 角色识别策略

不要把完整长篇正文直接交给人物分析任务。正确流程是：

1. 对分析分片分别调用候选人名提取，只给 `sourceHints + 当前分片`。
2. 支持中文姓名、日式汉字姓名、假名、英文名、俄语/西里尔姓名、幻想系姓名。
3. 本地先清理候选：章节标题、阶段名、部分名、动作短语、外貌描述、职业泛称、synthetic id 全部剔除。
4. 合并重复候选：同一角色跨分片反复出现时，按 name/alias key 合并；不确定是否同一人物时不要强行合并。
5. 人物分析任务只接收“候选姓名 + 用户设定/大纲线索 + 候选姓名附近正文片段”，不接收全文角色汤。
6. 角色卡落盘前再次 `_sanitizeCharacterCards()`，fallback 从大纲抽名也必须经过同一过滤链。

## 反例回归

必须保留这些回归样例：

- 应剔除：`第一部分`、`第二部分`、`第三部分`、`第五阶段`、`和舞蹈生`、`和陈可一`、`金发碧眼`、`陈可的上`、`能去主动`、`都拿过世`、`角色确认`、`导入分析`
- 应保留：`陈可`、`刘燕君`、`飞鸟马时`、`调月莉音`、`上野茜`、`レム`、`Катюша`、`Иван Петров`

不要用“硬性人名白名单”解决这个问题。白名单无法覆盖日语、俄语、幻想系和用户自创姓名；正确做法是 AI 提名 + 本地反证过滤。

## UI 状态机注意事项

`character-review` 阶段：

- “开始联网补全”用于二创角色补全。
- “跳过补全”应进入 `analysis-done`，新建项目继续完成导入，已有项目进入冲突检测。
- “上一步”返回后，用户必须能再“下一步”回到角色确认，不应锁死到只能跳过。

## 角色删除与旧脏数据

旧导入可能留下文件名和卡内 id/name 不一致的角色卡，例如：

```text
characters/char-legacy-import.json
{
  "id": "和少妇",
  "name": "和少妇"
}
```

`list_characters` 展示的是卡内 `id/name`，因此 `delete_character({ id: "和少妇" })` 不能只按 `characters/和少妇.json` 删除。

当前规则：

- `novelData.readCharacter/deleteCharacter` 先按文件名找。
- 找不到时扫描 `characters/*.json`，匹配文件名、卡内 `id`、`name`、`originalName`、`aliases`。
- `delete_character` MCP 使用底层解析后的真实文件路径删除，并返回被删角色摘要。

## 关键测试

- `node test/chatbox-import-regression.test.js`
- `node test/import-analyzer-cleanup-regression.test.js`
- `node test/import-full-flow-test.js`
- `node test/tool-hardening-regression.test.js`
- `node test/anthropic-tool-schema-regression.test.js`
- `npx vite build`

真实长样本 `/Users/potablewater/Downloads/森林大美食家.html` 的已知基线：

- 143 条 Chatbox 消息
- 68 条 assistant 回复
- 11 个整理批次
- 坏 JSON、空批次、截断围栏、分批并发顺序都必须有 mock 回归覆盖
