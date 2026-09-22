---
name: mana-character-roleplay
description: Simulate character reactions and director arbitration using canonical cards and subjective character memories.
---

# 角色驱动创作

读取角色卡、关系、相关章节和各角色主观记忆。可按场景让原生 subagent 独立扮演角色，再由当前线程承担导演仲裁；角色只知道其可知信息，不得共享隐藏事实。区分角色主观判断与作品客观事实。需要更新正文、角色卡或记忆时，在同一确认事务中提交相关资源。

创建角色卡的映射固定为 `characters/<id>.json`，不是 Markdown。每个文件必须是合法 JSON 对象，至少包含 `id` 和 `name`，其中 `id` 必须与文件名去掉 `.json` 后完全一致，例如 `characters/jiangzhao.json` 使用 `{"id":"jiangzhao","name":"江照","role":"水文工程师","attributes":{"欲望":"……","恐惧":"……","已知信息":"……","隐瞒事实":"……","说话方式":"……"}}`。角色记忆路径为 `character-memories/<id>.json`，必须包含同值 `characterId`。系统的格式校验错误不能解释为用户拒绝内容；应按具体错误修正格式。
