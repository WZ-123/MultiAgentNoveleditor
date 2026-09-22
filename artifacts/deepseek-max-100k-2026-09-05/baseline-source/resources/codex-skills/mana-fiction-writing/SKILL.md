---
name: mana-fiction-writing
description: Draft chapters and perform style-preserving, minimal fiction rewrites with native Codex planning and optional subagents.
---

# 小说写作

只读取当前任务真正依赖的小说证据。改写先读目标正文，再按冲突点选择相邻章节、相关人物、世界观、大纲或文风；新建资源且项目为空、用户已给出完整约束时，跳过不存在、空白或与场景无关的资料。每类资源最多列举一次，已知 `resourceRef` 时直接读取；多个独立资源应在同一轮并行读取，不要逐个试探或重复列举。

改写以用户指令为最高约束，保持叙事视角、人物声线、信息密度和段落节奏；选区任务只改必要范围。新章生成前确认章节目标和落点。复杂长章或彼此独立的审查可以按需使用 Codex 原生 subagent，但不要固定创建 Writer/Reviewer 线程。候选完成后用 Codex 原生 `apply_patch` 修改映射文件，展示原生 fileChange 差异并等待确认。`nativeWorkspace` 就是补丁根目录；`chapter:<name>.md` 的补丁路径只能是 `chapters/<name>.md`，绝不添加 `novel/`、工作区目录名或绝对路径前缀。
