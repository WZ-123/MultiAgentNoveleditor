# 目标管理

最后更新：2026-05-07

## 产品定位

> MultiAgentNovelAssistant 是为 AI IDE（Claude Code）提供小说创作工作流支撑的基础设施。
>
> AI IDE 负责决策、分析与创意生成；本软件提供 MCP 数据工具、流程指引（DAG/Subagent）、文件管理与冲突解决能力。内置的 `direct-api` driver 作为替补，在无 Claude Code 环境时独立运行。

## 核心理念

- **AI IDE 决策优先**：世界观分析、角色建档、人设补全、剧情编排等分析工作默认交给 Claude Code 自主完成
- **App 提供基础设施**：staging 系统、MCP 数据持久化工具、冲突检测/合并、DAG 编排引擎、配置管理
- **Skill 驱动策略**：搜索策略、分析指南等业务规则以 skill/subagent prompt 形式沉淀，独立演进无需改代码
- **双 driver 共存**：`claude-code-vscode/cli` 为主路径（自主编排），`direct-api` 为替补路径（spec 执行）

---

## 短期目标（1-2 周）

- [ ] 完成知识库文档与 subagent 定义的战略对齐
- [ ] 新建 `sa-import-orchestrator` subagent 并通过 smoke-test
- [ ] 将搜索策略沉淀为可独立维护的 skill 文档
- [ ] 所有内置 DAG 的 subagent prompt 明确指导 Claude Code 使用 MCP 工具完成分析

## 中期目标（1-2 个月）

- [ ] 所有内置 DAG 均适配 Claude Code 自主编排模式
- [ ] `direct-api` 与 `claude-code` 双 driver 的 happy path 均稳定可用
- [ ] 角色联网补全流程可由 Claude Code 通过 MCP 工具自主完成
- [ ] 导入流程（上传 → 分析 → 补全 → 提升）在 Claude Code driver 下全程无需人工干预

## 长期目标（3-6 个月）

- [ ] 用户可完全通过 Claude Code 完成"导入 → 分析 → 补全 → 写作 → 审查"全流程
- [ ] App GUI 退化为状态监控、配置管理、手动干预入口
- [ ] 搜索策略、写作指南等 skill 可独立演进，无需修改代码
- [ ] 支持多 AI IDE（Claude Code、Codex、未来可能的 Cursor Agent 等）

---

## 调整记录

- 2026-03-29：初始化目标分层与跟踪模板
- 2026-05-02：第二次方向转向——引入 AgentRuntimeDriver 抽象层，App = Claude Code 的 GUI + MCP 集成体
- 2026-05-07：**第三次方向确认**——明确 AI IDE 决策优先，App 提供基础设施与流程指引；direct-api 降级为替补
