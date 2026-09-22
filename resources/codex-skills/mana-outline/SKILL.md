---
name: mana-outline
description: Create and revise master outlines, hierarchy, nodes and chapter mappings while preserving established facts.
---

# 大纲

只读取当前大纲任务实际修改或引用的资源。新建或修订 `outline:master` 时先直接读取总纲；除非用户明确要求层级、节点或章节映射联动，否则不要读取 `outline:hierarchy`、`outline:nodes` 或逐章正文。已知 `resourceRef` 时不要先列举资源；多个确有依赖的独立读取应在同一轮并行发起。

创建时明确结构层级与章节目标；修订时保持未被要求改变的事实与节点稳定。长篇项目的单章详纲使用 `outline:chapter:<卷>:<节>:<章>` 独立寻址；受控 nativeWorkspace 使用扁平路径 `outlines/chapter-v<三位卷号>-s<三位节号>-c<三位章号>.md`，宿主提交后映射到真实层级目录。修改单章详纲时不要重写 `outline:master` 或聚合 nodes。需要同时更新多种大纲资源时，在一次原生 `apply_patch` 中修改对应映射文件，由宿主作为一个事务原子提交。`nativeWorkspace` 就是补丁根目录，`outline:master` 的路径只能是 `outlines/master.md`，绝不添加 `novel/` 前缀。
