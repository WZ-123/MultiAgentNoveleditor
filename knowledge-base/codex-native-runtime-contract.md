# Codex 原生运行契约

实现来源：[会话服务](../src/main/codex-runtime/codexSessionService.js)、[进程管理](../src/main/codex-runtime/processManager.js)、[聊天 UI](../src/components/AiChatPanel.jsx)、[任务约束](../src/components/writingTaskConstraints.mjs)。本页统一定义跨模块语义；已知违反项见 [缺陷清单](edge-cases.md)。

## 身份与能力

契约要求：`novelId`、`conversationId`、`runId`、`taskId`、`attemptId`、原生 `threadId/turnId` 各有独立用途。对话、资源、批准和最终提交必须属于同一项目；任何一方改变都不能静默挪用另一方的状态。UI 的当前项目不是旧任务的可变目标。

项目聊天绑定有效小说且模型工具验证为 `ok` 时挂载 `novel_tools` 和受控镜像，不再依赖当前页面、光标或显式 Skill。无项目或工具不可用时保留纯文本聊天并标明不能读写项目；准备失败显示错误，不宣称可操作。一次性任务和模型探针保持各自工具配置。

契约要求：分别表达供应商工具能力、本回合实际挂载能力、目标项目和写入批准状态，不可用一个“可操作”标签替代。

## 输入与线程

`additionalContext` 当前包含七项：`novelId`、`resourceRef`、`baseHash`、`selection`、`nativeWorkspace`、`resourcePath`、`taskConstraints`。资源内容通过只读小说工具获取；不要再沿用“只允许四项”的旧约定。

`resourcePath/baseHash` 是宿主根据资源生成的信息。当前没有单一编辑器资源时可能为空，不代表整个项目无资源或无权限，更不应要求用户手填 hash。

线程绑定指纹包含路由和工具模式；DeepSeek 另有工具协议版本。兼容时复用/恢复原生 thread，不兼容时创建 thread 并导入当前聊天分支。`knownThreads` 是进程内集合，不是跨启动的存活证明。分支编辑/回退由聊天 IPC 与 `reconcileBranch` 协作处理。

内置 Skill 共有七个：`mana-novel-workspace`、`mana-fiction-writing`、`mana-de-ai`、`mana-consistency-review`、`mana-outline`、`mana-character-roleplay`、`mana-import-enrichment`。正文位于 [resources/codex-skills](../resources/codex-skills)。配置中存在 Skill 不代表每次聊天都显式注入它。

## 读取、镜像和写入

1. `list_novel_resources` / `read_novel_resource` 返回资源标识、映射路径、hash 和内容/计数；分页只影响传输范围。
2. `syncNativeNovelWorkspace` 为任务创建受控镜像。模型用原生 `apply_patch` 编辑镜像相对路径。
3. App Server 请求宿主批准。批准入口先等待先前通知及提交处理完成，避免连续补丁混入同一次镜像差异；再验证路径、资源范围、可验证差异和选区限制。
4. 默认展示差异等待用户确认。项目“新增正文”授权只覆盖新章及完整保留既有正文的章末追加，不覆盖改写、删除、标题修改和结构化资料。
5. `fileChange` 完成后，宿主再次核对已批准差异、资源集合、内容 hash 和镜像变更，再经 `prepareChanges/applyPrepared` 提交正式数据。
6. 提交后更新镜像基线、读回资源、记录账本并发出 `committedResources`。保存发生在每次已批准补丁完成时，不必等整轮结束。

路径映射见 [数据与编辑器](data-and-editor.md)。单个原生补丁最多 16 个唯一资源。冲突、越界、无批准或内容不一致不能被模型文字绕过。

## 授权与任务约束的区别

`allowedWriteResourceRefs` 当前只有非空时才施加额外资源白名单；空数组不是拒绝全部，也不是免除批准。`operation: unspecified` 是未归类任务，不是拒写状态。`taskConstraintsFor` 主要通过显式 Skill 设置 operation，所有挂载项目工具的聊天均记录实际活动和保存进度，不以 operation 为开关。

`editScope` 默认为 `unrestricted`。仅显式选择 `selection` 或 `insertion` 时绑定资源、baseHash 和 start/end；宿主重新验证版本与范围，并限制只能修改该资源及对应区间。普通光标和上下文选区不产生硬限制。

## 完成与失败

必须区分模型回合结束、工具完成、镜像变化、正式保存、用户目标达成。模型说“已写入”不构成保存证据；拒绝说明也不构成真实工具失败证据。

现状：任务账本记录开始、工具、批准、提交及终态；`_evaluateTaskResult` 生成 savedResources、部分计数与 goalVerified。字数目前是非阻塞信息，完整结局和人物一致性等不能仅由提交数量证明。聊天持久化和 UI 分别展示运行状态、正式提交与目标验证；旧记录缺少证据时显示“无执行记录”。工具记录按 itemId 更新并保留原生 fileChange。

契约要求：取消保留已提交的资源，明确显示未提交部分；失败应保留可恢复上下文与已保存证据。多个任务/对话的事件必须按身份隔离，批准不能因切换界面被挪用。故障恢复不得删除能力以换取“无错误”。

## 统一发送和恢复（2026-09-22 实施）

- `startTurn` 接收项目、对话、runId、userMessageId、文本及可选 Skill、编辑上下文和 editScope；宿主负责消息入库及启动。同步占用对话，异步前置失败释放自己的占位；同项目镜像仍互斥。
- 相同 runId 和内容重放返回已有状态；内容不同拒绝。主动重试使用新 runId 和原 userMessageId。未知请求结果必须先 `getRunState`，不直接再次运行。
- `getConversationState` 返回当前/最近运行和待确认请求，`getRunState` 返回指定运行；preload、IPC、LAN 共同提供，LAN 原有限制保留。
- 状态由宿主管理：starting → running ↔ waiting-approval → finalizing → completed/failed/interrupted。事件和快照含运行身份及递增 version；前端订阅后取快照并忽略旧版本。宿主崩溃恢复增加 generation，优先级高于上一代未落盘事件，避免仍在线的 LAN 页面误保留旧确认。
- 项目与对话切换仅更换显示。草稿和当前对话按项目保存；批准与停止绑定 runId。重载查询宿主，进程重启把旧活动记录标为 interrupted，旧批准失效。
- `chat-runs/` 保存运行检查点；文本每两秒持久化，批准、正式提交和终态立即保存。终态先持久化再发布；失败保持 finalizing 并重试收尾，不重跑补丁。崩溃只恢复已持久化文字。
- 原生补丁允许带行号 diff 或能唯一精确定位的无行号上下文 diff。批准与完成事件的格式可以不同，资源、操作和变更前后内容哈希必须一致；正式磁盘仍单独核对批准证据。

当前验证范围及限制见 [实施记录](../artifacts/chat-chain-audit/report.md#实施记录2026-09-22)。

原生 apply_patch 的非空文件输出以 LF 结尾；批准证据必须对所有资源类型预测这一字节，包括人物卡 JSON 和世界观。不能只在 chapter 类型补换行，也不能通过裁剪实际内容绕过哈希校验。已有资源更新与新增资源应分别验收。
