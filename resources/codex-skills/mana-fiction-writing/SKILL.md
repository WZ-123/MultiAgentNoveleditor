---
name: mana-fiction-writing
description: Draft and revise fiction using canonical resources and native approved changes.
---

# 小说写作

按用户指定的范围、视角、篇幅和文风创作。先用 read_writing_context 读取任务绑定资料，按需补读相关前文。公共资料与各角色自己的主观记忆分开使用；不能将作者掌握的秘密当作焦点已知。人物信息边界、时间和因果关系由创作与语义审查负责，程序不以关键词判定内容真伪。

调用 report_writing_progress 标示当前章节。正文由模型直接创作，functions.exec 只编排工具，不用模板、循环或字符串拼接生成剧情。

使用 prepare_novel_patch 提交候选：完整原创正文用 content，精确编辑用 replacements，角色记忆用 memoryAppend。用户指定的参与者与视角已在创作前绑定，候选不能更换；只有用户未指定时才以 narrativePerspective 声明实际选择的视角。宿主管理真实读取版本、文件是否存在、新记忆ID及原生补丁，不转抄 hash 或手写 diff。已有资源编辑前实际读取；有 patch 的 preparedOnly:true 结果在同一次 exec 中将 structuredContent.patch 交 tools.apply_patch，不打印长补丁；draft_incomplete 没有 patch，用 preparationId 加 changes 补齐，带该ID的 replacements 编辑暂存正文；already_committed 表示同一候选已有正式收据，应读取保存结果而非重复取回。准备结果提供实际正文字数与目标。准备只生成候选，实际批准和正式提交才表示保存。映射路径相对于 nativeWorkspace，不加其他目录前缀；普通修改不能用删章替代。

用户要求角色记忆时，沿用任务已绑定的角色ID；用户未限定参与者时再在准备工具中用 participantCharacterRefs 声明，宿主绑定各自必写记忆；同批要求下把正文和所有这些记忆一起提交。范围不能在后续候选中静默缩小。

保存后读回正式资源。仅检查计数可读 mode:"metadata" 的 bodyChineseCharacterCount；篇幅按用户原上下限，不用容差降低目标。要求写后自查时，调用 check_writing_task 取得冻结版本的独立审查意见；要求修复的硬冲突未解决时任务不完成。工具返回的是当前实际缺项，保存与审查结果分别说明。错误须按实际原因修正，不用空 changes、整项删除或重写无关资料规避。
