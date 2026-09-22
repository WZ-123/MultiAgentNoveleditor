# 数据、资源与编辑器

来源：[paths](../src/main/store/paths.js)、[novels](../src/main/store/novels.js)、[novelData](../src/main/store/novelData.js)、[资源适配](../src/main/mcp/novelResources.js)、[镜像映射](../src/main/codex-runtime/nativeNovelWorkspace.js)。

## 两类目录

应用数据根由 `MANA_USER_DATA_ROOT` 或 Electron userData 决定，含模型配置、密钥存储、小说注册表、聊天记录、反馈 outbox、授权、进度及应用专属 codex-home。开发和测试不得默认指向用户正式数据。

小说项目根包含 `novel.json`、`chapters/`、`summaries/`、`characters/`、`factions/`、`world/`、`timeline/`、`outlines/`、`assets/`、`style/` 与 `.mana/`。具体位置只由 `novelPaths` 和业务存储函数决定，不从显示名称拼接任意路径。

## 资源不是任意文件路径

| 资源标识示例 | 原生镜像路径 | 注意事项 |
| --- | --- | --- |
| `novel:meta` | `novel/meta.json` | 正式元数据是项目根 novel.json |
| `chapter:chapter-001.md` | `chapters/chapter-001.md` | 章节名称需要校验 |
| `character:alice` | `characters/alice.json` | 结构化 JSON |
| `world:lore` | `world/lore.md` | 世界观文本 |
| `timeline:all` | `timeline/events.json` | 正式目录使用 events.jsonl |
| `outline:master` | `outlines/master.md` | 不等于正式存储文件名 |
| `outline:chapter:1:2:3` | `outlines/chapter-v001-s002-c003.md` | 正式存储有层级目录 |
| `style:memory` | `style/memory.md` | 文风资料 |

完整支持范围以双向映射函数为准，不是目录内所有文件都能由模型编辑。时间线镜像同步跳过单事件描述符，不能假定每个可读资源都已生成独立镜像文件。路径逃逸、符号链接和重复映射必须拒绝。

## 手工编辑与 AI 编辑是两个入口

手工章节编辑经 App 的保存队列和 `novel.saveChapter` 落盘，使用基线处理冲突；AI 编辑经原生镜像、批准、mutationService 落盘。两者共享正式资源，但不能互相覆盖未处理的版本冲突。

聊天发送前按绑定资源调用 `flushActiveChapterToDisk`，保存失败保留草稿并显示错误，不启动模型。编辑器菜单命令先保存，再绑定目标资源、版本和显式范围；切章不替换目标，版本变化要求重新选择。编辑器的普通选区只提供上下文，不当作修改授权。

提交事件由 `ipc/codex` 广播；App、数据面板和章节事件订阅刷新受影响内容。刷新按 committedResources 的项目与资源类型路由，不依赖工具名称。资料页正在编辑时保留草稿、提示冲突并阻止覆盖；取消编辑后重新读取正式资源。章节同步也保留脏稿。收到事件只证明需要刷新，仍需验证正式读回结果。

## 事务边界

[mutationService](../src/main/mcp/mutationService.js) 联合 [资源锁](../src/main/mcp/resourceLockService.js)、[WAL](../src/main/store/chapterPostWriteWal.js) 处理准备、版本校验、提交和恢复。多资源失败不能留下未说明的部分提交；恢复失败必须保留故障证据。

验收至少覆盖：同资源并发、旧 base hash、未知资源、新建/删除、结构化 JSON 校验、跨项目路径、批准后内容变更、写入中断及恢复。单纯看到镜像文件改变不能判定正式保存成功。
