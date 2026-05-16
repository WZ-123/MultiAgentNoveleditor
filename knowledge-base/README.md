# 项目知识库（Knowledge Base）

这个目录用于沉淀项目的长期上下文，便于在不同设备上快速恢复开发状态。

## 目录说明

- `goals.md`：短期 / 中期 / 长期目标
- `system-overview.md`：系统说明（架构、模块、依赖、约束）
- `progress.md`：开发进展与里程碑
- `vibe-coding-dialogues.md`：vibe coding 关键对话与决策记录
- `handover-checklist.md`：跨设备续接时的快速检查清单
- `quick-feedback-design.md`：用户快速反馈功能设计（字段、快照、脱敏、发送策略）
- `feishu-feedback-sync-design.md`：飞书多维表格反馈同步设计（outbox、同步层、附件、重试、联调）

## 建议更新节奏

- 每次开始开发前：先看 `progress.md` 与 `vibe-coding-dialogues.md`
- 每次结束开发后：至少更新一次 `progress.md`
- 有关键决策时：追加到 `vibe-coding-dialogues.md`
- 目标调整时：更新 `goals.md`

## 快速续接流程（换设备）

1. 打开本目录，先读 `handover-checklist.md`
2. 根据 `progress.md` 定位当前里程碑与下一步
3. 根据 `vibe-coding-dialogues.md` 恢复上下文与关键决策
4. 开始前补充今天的会话计划，结束时回写结果
