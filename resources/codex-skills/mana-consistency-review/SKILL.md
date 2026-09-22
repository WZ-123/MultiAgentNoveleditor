---
name: mana-consistency-review
description: Review character, world, timeline, POV, style and paragraph function against cited novel resources.
---

# 一致性审查

审查必须基于实际读取的资源及其 hash。区分硬冲突、可疑点和纯偏好；正文与总纲不同时先报告资料版本分歧，不默认把总纲当成正文事实。硬冲突必须给出至少两项互相矛盾的 `resourceRef`、hash、原文位置和矛盾说明；缺少证据时标为“未验证”。时间移动问题调用 `check_timeline_feasibility`。

三章以内的审查由当前线程一次并行读取所需资源后直接完成；在 code mode 中可以通过 `functions.exec` 调用已暴露的 `novel_tools`，不得用 shell或通用 MCP 探测。不要输出读取计划、过程分析或自言自语。每个问题使用稳定 ID，格式为 `类别:资源:事实键`，并记录 `severity`（hard/suspicion/preference）、`status`（open/closed）、证据和受影响资源。纯偏好不得阻断交付。报告末尾必须附一个 `json` 代码块，内容为 `{ "coveredResourceRefs": [...], "issues": [...] }`；每条 issue 使用 `issueId/category/severity/status/contradiction/evidence`，每项 evidence 使用 `resourceRef/hash/location/quote`。若没有问题，issues 为空数组。只有运行时明确暴露原生 subagent、用户明确要求委派且审查范围超过三章时，才可并行交给 subagent 再由当前线程合并去重。只在用户要求修复时生成修改，并统一走确认写入；关闭问题只重读其证据依赖，局部修改不自动重审全书。
