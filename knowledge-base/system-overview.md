# 系统说明

最后更新：2026-05-07

## 项目概览

- 项目名：MultiAgentNovelAssistant
- 形态：Electron + Vite + React 桌面应用
- 目标：为 AI IDE（Claude Code）提供小说创作工作流的基础设施支撑

## 核心理念

本软件不是"自己做所有 AI 分析"，而是"为 AI IDE 提供完成分析所需的工具与指引"。

AI IDE（Claude Code）负责：
- 世界观分析与角色建档的**决策**
- 剧情编排与文风审查的**判断**
- 联网搜索与信息补全的**策略执行**

本软件负责：
- MCP 数据持久化工具（角色卡、世界观、时间线、大纲等）
- DAG + Subagent 工作流程指引
- Staging 系统、冲突检测、合并等文件管理基础设施
- 必要的文本编辑与查询能力（chapter 读写、风格记忆等）

## 执行模式

### 主路径：Claude Code Driver（`claude-code-vscode` / `claude-code-cli`）

```
用户输入 → DAGSpec
                ↓
        dagToPrompt() → 自然语言工作流指南
                ↓
        写入 .claude/agents/*.md + mcp-config.json
                ↓
        spawn claude --mcp-config <path> --append-system-prompt <指南>
                ↓
        Claude Code 自主编排：
        - 调用 Task/Agent 工具委派 subagent
        - 调用 mcp__novel-tools__* 工具读写数据
        - 调用 Read/Grep 工具查看文件
                ↓
        归一化 NDJSON → AgentEvent → UI 展示
```

特点：
- **自主编排**：Claude Code 自行决定步骤顺序、重试策略、异常处理
- **Skill 驱动**：业务规则（搜索策略、写作指南）以 skill.md 形式注入
- **确认受限**：Phase 7 暂不支持跨进程 tool confirmation，写操作自动通过或需 `requiresConfirmation: false`

### 替补路径：Direct API Driver（`direct-api`）

```
用户输入 → DAGSpec
                ↓
        workflowOrchestrator 逐节点执行
                ↓
        每个 subagent 调用内部 LLM API（providerManager）
                ↓
        结果直接返回
```

特点：
- **精确执行**：按 DAG 拓扑严格逐节点运行
- **完全可控**：工具确认、事件流、重试逻辑均在 App 内部
- **功能完整**：支持 tool confirmation、human-in-loop 等全部功能
- **使用场景**：无 Claude Code 环境、需要严格可重现性、需要 human-in-loop

## 技术栈

- 前端：React + TailwindCSS
- 桌面容器：Electron
- 构建与开发：Vite
- AI 驱动：Claude Code（外部）/ 内置 provider-agnostic runtime（替补）
- 数据存储：文件系统（JSON + Markdown）

## 安全边界

- 打包交付给用户的客户端不得包含开发者本地填写的任何 API Key，也不得包含飞书 `appId/appSecret/appToken/tableId`。
- 打包客户端不得保留直连飞书多维表格的运行链路；用户侧涉及飞书的能力统一走腾讯云 SCF Web Function 中继实现。
- 对用户客户端而言，“从飞书查询数据”“写入授权码使用记录”“将 bug 反馈发送到飞书”这三类能力都必须经腾讯云函数完成；Cloudflare Worker 仅保留为备份实现，不是主生产路径。
- 开发者环境可以保留直连飞书能力，仅用于本地 AI 联调、飞书表查询、反馈回放和 bug 收集；这类脚本和适配器不应进入发布包。

## 目录与模块

- `src/components`：UI 组件（状态监控、配置面板、手动干预入口）
- `src/services`：编排、模型调用、配置管理等核心逻辑
- `src/main/mcp/`：MCP 工具定义与 stdio server（数据持久化层）
- `src/main/runtime/drivers/`：AgentRuntimeDriver 抽象层及实现
- `src/main/import/`：导入流程基础设施（staging、解析、冲突检测）
- `src/main/seeds/`：内置 subagent 定义
- `src/main/store/skills/`：Skill 文档（搜索策略、写作指南等）
- `main.js` / `preload.js`：Electron 主进程与预加载逻辑

## 关键抽象

| 抽象层 | 职责 | 主路径对应 | 替补路径对应 |
|--------|------|-----------|-------------|
| DAG | 工作流定义 | dagToPrompt → Claude Code 自主编排 | workflowOrchestrator 逐节点执行 |
| Subagent | 任务角色定义 | `.claude/agents/*.md` | 内置 prompt + 工具白名单 |
| MCP Tools | 数据持久化 | `mcp__novel-tools__*` | 同一套 tools.js |
| Skill | 业务策略文档 | `read_skill` 注入 prompt | 直接嵌入 prompt |
| Driver | 执行引擎 | `claude-code-vscode` / `cli` | `direct-api` |

## 当前已知问题

- 开发环境日志显示 `@heroui/react` 与 `@heroui/theme` 依赖解析失败
- 该问题会影响 `vite` 开发运行时的页面加载与样式处理
- Claude Code driver Phase 7 暂不支持跨进程 tool confirmation（TCP relay 为下一步）

## 运行与维护约定

- 新功能完成后，同步更新本知识库
- 关键决策必须记录在 `vibe-coding-dialogues.md`
- Skill 文档（`skills/*.md`）变更无需代码发布即可生效
- 每个迭代结束，更新 `progress.md` 的下一步计划
