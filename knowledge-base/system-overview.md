# 系统总览

## 产品与边界

这是 Electron 桌面小说工作台：React 界面管理项目、章节编辑、结构化资料、AI 聊天、导入合并、角色联网补全、模型配置和设置；主进程负责文件、持久化、原生 Codex 运行时和周边服务。还有可配置的局域网访问入口。

源码入口：[main.js](../main.js)、[preload.js](../preload.js)、[主进程初始化](../src/main/index.js)、[App](../src/App.jsx)。渲染层通过 `window.mana` 调用宿主 API。浏览器远程访问经 LAN RPC 进入宿主已注册的处理器，需受远程访问策略限制。

## 功能与实现归属

| 功能 | UI / 宿主入口 | 业务实现 |
| --- | --- | --- |
| 项目与章节 | App、WorkspaceSwitcher、ChapterEditor；ipc/novel | store/novels、store/novelData |
| 人物、世界、大纲、时间线、素材 | NovelDataBrowser、DataTabContent | novelData、mcp/novelResources |
| AI 聊天与原生编辑 | AiChatPanel；ipc/codex | codex-runtime/codexSessionService |
| 模型接入 | ProviderSettingsPanel；ipc/modelConfig | modelConfig、providerTemplates |
| 导入与冲突处理 | ImportNovelPanel、ImportMergePanel；ipc/import | importSaga、analyzer、mergeEngine |
| 角色联网补全 | CharacterEnrichPanel；ipc/import | characterEnricher、import/searchEngine |
| 本地检索 | SearchPanel | search/searchEngine、contextRetrieval |
| 反馈、同步、更新、远程访问 | 对应设置与 IPC | sync、license、updater、lan |

表内路径除 UI 外均相对 `src/main/`。详细语义分别由目录中的领域文档负责。

## 模型执行与存储链

```text
聊天 UI → preload / IPC → CodexSessionService → 官方 App Server → 模型供应商
                                             ├─ novel_tools MCP：读取与确定性检查
                                             └─ 原生 apply_patch：修改受控镜像
                                                  → 宿主批准与差异验证
                                                  → mutationService → 正式小说
```

MCP 不承担小说写入。`apply_patch` 修改的镜像不等于正式小说；正式保存以宿主提交和读回为准。

导入分析、角色资料提取等通过 [nativeProvider](../src/main/codex-runtime/nativeProvider.js) 调用同一服务的 `runOneShot`。业务代码可以安排分片分析和合并，但不能据此称系统拥有另一条旧 Provider/自研模型工具循环。联网抓取在应用业务模块中执行，与正式小说聊天中禁用模型网页工具是不同边界。

模型原生负责推理、工具选择、线程上下文与压缩。应用负责入口上下文、工具是否挂载、任务约束、批准和落盘；因此不能笼统声称“应用不参与上下文或任务约束”。

## 状态归属

- 项目：小说注册表和项目目录；当前项目是 UI 状态，不能替代已经发起的任务目标。
- 对话：应用聊天记录保存用户可见分支与 `codexBinding`；原生线程保存模型执行历史。
- 运行：`activeRuns`、`threadRuns`、`projectRuns` 与持久任务账本。
- 编辑：章节内容、版本、脏标记和光标/选区；它们不能自动成为写入授权。
- 模型：配置中的激活选择与验证结果；供应商能力不等于本回合已挂载能力。

当前这些状态之间仍有已知不一致，见 [缺陷清单](edge-cases.md)。本总览不宣称全链路已经闭合。
