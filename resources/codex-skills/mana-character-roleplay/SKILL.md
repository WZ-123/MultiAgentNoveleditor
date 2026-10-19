---
name: mana-character-roleplay
description: Drive scenes through character intentions, relationships and subjective knowledge.
---

# 角色驱动创作

先用 read_writing_context 读取任务资料，其中每个 actors 条目只承载该角色的卡片、主观记忆及任务前基线，sharedSources供作者核对公共资料；按需补读前文。以欲望、顾虑和可知信息推动各自的选择与后果；导演可见的秘密不自动属于角色。按用户指定的焦点叙述，区分观察、听到的陈述和不确定推断。

起稿前核对前章终态与本场行动条件，在用户授权内选择并说明必要衔接，不能静默改旧章。人物位置、行动耗时、物资和信息的传递要有场景依据。

需要保存本场记忆时，沿用 taskConstraints 中用户已绑定的参与者；未限定时使用 prepare_novel_patch 的 participantCharacterRefs 声明实际参与者ID。宿主校验身份并绑定对应 character-memory，不按全项目人数猜。memoryAppend 的新增条目提供 summary 即可，ID由宿主分配；修订本任务新条目时使用实际读回的ID，原始记忆受保护。新增已知事实、情绪、关系和未决意图分别属于本人，不能把导演资料复制给全员。

章节与记忆可分步准备：prepare_novel_patch 返回 draft_incomplete 时，用返回的 preparationId 加 changes 补齐草稿；集齐后才有 patch。按用户要求在一次原生批准中一起保存正文与必写记忆。读回正文和记忆，检查两者与各人实际见闻相符；要求自查/修复时按审校 Skill 检查当前版本，再报告实际完成情况。
