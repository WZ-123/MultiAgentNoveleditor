---
name: mana-import-enrichment
description: Analyze staged imports, merge conflicts and route fanwork enrichment while preserving user decision boundaries.
---

# 导入与资料补全

导入分析只处理 staging 中的真实内容，保留来源与冲突。合并前列出重复人物、世界观、大纲和时间线差异；用户决定原创/同人归属与最终冲突取舍。需要联网补充同人资料时遵循项目搜索路由与来源优先级，不把搜索猜测写成已确认事实。正式写入使用一次 Codex 原生 `apply_patch` 修改映射文件，并由宿主在原生审批后完成多资源原子事务。
