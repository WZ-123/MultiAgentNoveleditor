# MCP 工具参考

MultiAgentNovelAssistant 通过 MCP 协议暴露 32 个工具，供 Claude Code 等 AI 客户端调用。

## 角色管理

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `list_characters` | 列出当前小说的所有角色（id/name/aliases/role/faction） | 否 |
| `read_character` | 读取单个角色的完整信息。参数：`id` (必填) | 否 |
| `read_character_context` | 读取场景过滤后的角色信息。参数：`id`(必填), `sceneContext`, `needBackground`, `outfit` | 否 |
| `create_character` | 创建新角色卡。参数：`name`(必填), `aliases`, `faction`, `role`, `attributes`, `relationships`, `arc`, `bio` | **是** |
| `update_character` | 修改角色字段。参数：`id`(必填), `patch`(必填) | **是** |

## 大纲管理

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `read_outline` | 读取大纲 Markdown。参数：`name` (可选，默认 "main") | 否 |
| `read_outline_nodes` | 读取结构化大纲节点列表 | 否 |
| `write_outline_nodes` | 保存结构化大纲节点（覆盖）。参数：`nodes`(必填) | 否 |
| `assemble_scene_context` | 自动装配场景上下文（读取节点元数据 + 角色过滤信息）。参数：`nodeId`(必填) | 否 |

## 章节管理

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `read_chapter` | 读取章节正文。参数：`name`(必填，如 `第一章.md`) | 否 |

## 世界观

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `query_world` | 查询世界观 lore + 地名表 | 否 |
| `update_world` | 修改世界观。参数：`lore`, `places` | **是** |

## 时间线

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `query_timeline` | 查询时间线事件。参数：`participant`, `chapterRef`, `since`, `until` | 否 |
| `check_timeline_feasibility` | 检查角色在时间线上移动的可行性。参数：`characterId`(必填), `transport` | 否 |
| `append_timeline` | 追加时间线事件。参数：`chapterRef`, `when`, `where`, `participants`, `description`, `physical`, `communication` | 否 |

## 资产/物品

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `list_assets` | 列出所有资产 | 否 |
| `read_asset` | 读取单个资产。参数：`id`(必填) | 否 |
| `grant_asset` | 将资产授予角色。参数：`assetId`(必填), `charId`(必填) | 否 |
| `revoke_asset` | 回收资产。参数：`assetId`(必填), `charId`(必填) | 否 |

## 文风与摘要

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `read_style_memory` | 读取文风记忆 | 否 |
| `append_style_memory` | 追加文风笔记。参数：`delta`(必填) | 否 |
| `append_summary` | 追加章节摘要。参数：`chapterRef`(必填), `summary`(必填), `supplementMarkdown` | 否 |
| `append_timeline` | 追加时间线事件 | 否 |

## 搜索

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `search_index` | 搜索知识库索引。参数：`query`(必填) | 否 |
| `read_skill` | 读取全局 skill 文档（写作助手参考） | 否 |

## 小说项目管理

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `list_novels` | 列出所有小说项目 | 否 |
| `create_novel` | 创建新小说项目。参数：`title`(必填), `dir`(可选) | 否 |

## 暂存/导入

| 工具 | 描述 | 需要确认 |
|------|------|---------|
| `list_staging_projects` | 列出所有进行中的导入项目 | 否 |
| `get_staging_project` | 读取导入项目的完整数据。参数：`importId`(必填) | 否 |
| `get_staging_characters` | 读取导入项目的角色列表。参数：`importId`(必填) | 否 |
| `save_staging_characters` | 保存导入项目的角色。参数：`importId`(必填), `characters`(必填) | **是** |
| `enrich_staging_characters` | 对导入角色进行联网补全。参数：`importId`(必填), `characterIds`(必填) | **是** |
| `promote_staging_to_novel` | 将导入项目提升为正式小说。参数：`importId`(必填) | **是** |

## 活跃小说上下文

所有需要操作小说数据的工具都需要活跃小说上下文。上下文按以下优先级解析：

1. **每次工具调用的 `_meta` 注入**（最可靠）— 由 `serverManager.callTool()` 注入 `mana_activeNovelId` / `mana_activeNovelDir`
2. **进程级 `set-active-novel` IPC 消息** — 由父进程通过 IPC 设置
3. **novelsStore 按 ID 查询** — 如果只有 ID 没有 dir，自动从存储解析

当没有活跃小说时，工具返回错误："No active novel: this tool requires an open novel."

## 确认机制

部分写工具要求用户确认（`requiresConfirmation: true`）。在 AI 聊天上下文中：
- 调用 MCP 工具时如需绕过确认，需要 `autoConfirm: true`
- `chatAgent.callMcpTool()` 默认 autoConfirm=true
- `runSubagent.mcpClient.callTool()` 默认 autoConfirm=true
