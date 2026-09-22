# Multi-Agent Novel Assistant — Skill Reference

This is a runtime reference document used by subagents and the config-helper.

## Product Positioning

MultiAgentNovelAssistant uses configured Direct API model profiles as its only model execution source. Interactive chat, subagents, writing, review, and import analysis all run through Direct API. There is no alternate IDE/CLI execution source and no runtime selector.

## Natural Tool Use and Authorization

- When the user clearly asks for an in-scope read or edit, use the available tools naturally and stay within the requested scope.
- An explicit edit request already authorizes that requested scope. Never ask the user to repeat an authorization phrase, magic wording, or generic confirmation.
- Wait for user confirmation only when the runtime has produced a real pending confirmation or verified preview artifact.
- If a tool is unavailable or rejects the request, report the concrete runtime error instead of inventing an authorization requirement.

## Tier slots

A Preset bundles 3 tier slots:

- **opus** — strong reasoning / consistency review (character / timeline)
- **sonnet** — chapter-level prose writing
- **haiku** — light annotation / cheap quick passes

Subagents declare a default tier; nodes in a DAG can override.

## Built-in subagents

- sa-outline-drafter (opus)
- sa-character-reviewer (opus)
- sa-timeline-guardian (opus)
- sa-style-checker (haiku)
- sa-prose-quality (haiku)
- sa-writer (sonnet)
- sa-lore-updater (opus)
- sa-import-orchestrator (sonnet) — novel import workflow orchestration
- sa-config-helper (haiku)

## Built-in DAGs

- dag-quality-outline / dag-quality-writing — quality-first; uses parallel review and revision loops
- dag-cheap-outline / dag-cheap-writing — cost-first; flatter graph, haiku-heavy

## Cost vs quality trade-offs

- Need to lower cost? Switch to dag-cheap-* and remap opus tier to a cheaper provider/model.
- Need to improve quality? Switch to dag-quality-* and ensure opus tier uses a top-tier model.
- Timeline correctness benefits from at least sonnet-level model on sa-timeline-guardian.

## Tools (MCP)

Read-only: list_characters, read_character, list_assets, read_asset, query_timeline,
check_timeline_feasibility, query_world, read_outline, read_chapter, read_style_memory,
read_skill, search_index.

Write (auto): grant_asset, revoke_asset, append_timeline, append_summary, append_style_memory.

Write: create_character, update_character, update_world.

---

# Character Web Search Strategy

When a novel is a fanwork/derivative work, official character info (appearance, personality, background, moe traits) must be filled in for characters from the original work.

## Cultural Sphere Routing

Determine the cultural sphere from the work name to decide search source priority:

| Sphere | Priority | Works |
|--------|----------|-------|
| east-asian-cn | Moegirl → Bing → Wikipedia | Chinese works (Azur Lane, Genshin Impact, etc.) |
| east-asian-jp | Wikipedia → Moegirl → Bing | Japanese works (Fate, Touhou, etc.) |
| east-asian-kr | Wikipedia → Bing → Moegirl | Korean works (Blue Archive, Nikke, etc.) |
| western-en | Wikipedia → Bing | Western works (Harry Potter, Marvel, etc.) |
| global | Wikipedia → Bing | Undetermined |

## Query Format per Source

Always include BOTH work name and character name to avoid same-name confusion:

| Source | Preferred Query | Example |
|--------|----------------|---------|
| Moegirl | {work}:{character} | Azur Lane:Atago |
| Moegirl (fallback) | {work} {character} | Azur Lane Atago |
| Wikipedia | {character} {work} character | Atago Azur Lane character |
| Bing / DDG | {character} {work} character wiki | Atago Azur Lane character wiki |

IMPORTANT: The work name MUST be in the query. Without it, same-name characters from different works will be confused (e.g. "Atago" appears in both Azur Lane and Kantai Collection).

## Search Failure Fallback

1. Try neighboring sphere (cn ↔ jp)
2. Try global DuckDuckGo
3. Mark _enrichmentStatus = 'search-failed', continue with other characters

## Data Merge Rules

- Novel data takes priority: if the character card already has a field, append web data as reference, do not overwrite
- Only fill empty fields with web data
- Write _enrichmentSource on every enrichment (format: sphere=east-asian-cn sources=moegirl,bing)
- Write _enrichmentStatus: success | extract-empty | search-failed | fetch-failed | extract-failed | skipped

## Multi-Work Crossover

When a novel references multiple original works:
1. Each character must have an explicit sourceWork
2. Group characters by sourceWork
3. Run enrichment independently per group
4. Each work uses its own cultural sphere routing

## User Decision Boundary

- isOriginal MUST be declared by the user; AI must NOT auto-detect it
- sourceWork may be preliminarily identified by AI during extraction; the user makes the final assignment decision
- User can skip web enrichment at any time; characters keep their original extracted state

---

# 章节写作格式规范

## 核心规则
当你将大纲节点转化为章节正文时，必须移除所有大纲标记物。大纲节点的编号和标题是内部规划工具，永远不应出现在最终正文中。

## 具体做法

### 禁止的写法
- `## 1. 办公室商议`
- `### 暮色的码头`
- 任何形式的 "数字 + 小节名称" 标题
- 在正文段落之间插入带编号的分隔标记

### 正确的写法
- 章节正文是**连续叙事流**，场景切换使用原文既有的分隔符（如 `……`）做自然过渡
- 写入正文前，先读取已有章节（如 chapter-001.md），观察其排版格式并保持一致
- 每个场景的开场用描写/对话直接切入，不给场景"挂牌"

### 心里模型
把大纲当作建筑施工时的脚手架——规划阶段用它定位每个场景，但竣工交付前必须拆除。读者看到的不应该有脚手架残留。
