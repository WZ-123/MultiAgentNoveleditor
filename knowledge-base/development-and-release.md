# 开发、验证与发布

开发和验收遵循 [统一工作流](ux-dev-flow.md)。本页只维护命令、验证环境和发布边界，不另行定义一套开发流程。

命令依据：[package.json](../package.json)、[test-scripts.json](../test-scripts.json)、[maintenance-scripts.json](../maintenance-scripts.json)。配置声明 Node 24.19.0；运行前核实本机版本，不把其他版本上的结果当作发布环境证明。

## 开发命令

| 目的 | 命令 |
| --- | --- |
| 开发启动 | `npm run dev`（转到 dev-start） |
| 开发认证 | `npm run dev:auth` |
| 前端构建 | `npx vite build` |
| 主测试集合 | `npm test -- test:unit` |
| 反馈构造、存储安全与同步 | `npm test -- test:feedback` |
| 反馈表单与同步状态 UI | `npm test -- test:feedback:ui` |
| 编辑保存、切项目、卷节恢复 UI | `npm test -- test:editor-workflow:ui` |
| 任务完成状态与容差 | `npm test -- test:task-completion` |
| 写作资料、阶段取消、审校证据与模型截断 | `npm test -- test:writing-workflow` |
| 写作完整用户流程与错误恢复 | `npm test -- test:writing-workflow:ui` |
| 原生模型链测试 | `npm test -- test:codex-native` |
| 资源事务测试 | `npm test -- test:mcp-mutations` |
| 原生 UI 流程 | `npm test -- test:ui-e2e` |
| 模型配置 UI | `npm test -- test:responses-config:ui` |
| 导入 UI | `npm test -- test:import-saga:ui` |
| 安全扫描 | `node scripts/run-maintenance-script.js security:scan:current` |
| 构建发布包 | `npm run build` 或平台 build 脚本 |

2026-10-19写作主干集成复核：主集合新增`writing-lifecycle-boundaries.test.js`，覆盖候选检查点失败、交付/交接中停止、目录加载中停止、预先取消审查、迟到成功/失败及评估后资料版本变化。写作UI新增独立审查停止后的终态及正式正文不变检查；可设置`MANA_WRITING_UI_EVIDENCE_DIR`将本轮截图单独存档。当前结果为50文件单元、21组写作UI及原生聊天两阶段通过，实际范围和限制见[集成审计](../artifacts/chat-chain-audit/report.md#写作重构主干集成复核2026-10-19)。

`npm test` 需要测试名称。`npm run build` 是发布构建，不是单纯 Vite 编译。真实供应商测试可能使用账号和费用，不能与本机 Fake Provider 测试混为一谈。实际服务端口取脚本输出；测试启动客户端前关闭音频。

## 验证层次

1. 纯函数/存储：资源映射、hash、锁、事务、授权、配置迁移。
2. 原生集成：本机 Fake Responses 服务 + 实际 App Server + MCP/补丁/批准/提交。
3. UI：从真实界面产生参数，覆盖切换、失败、恢复和保存读回。
4. 真实供应商：验证请求兼容与实际模型行为，记录供应商、模型、档位和时间。
5. 安装包：检查目标平台包内运行时、资源和启动流程。

不得用第二层手工补齐 Skill/resourceRef 的输入证明第三层自然语言聊天可用。`run-unit-tests.js` 的集合包含原生集成测试，可能需要本机监听；不是所有列入集合的测试都完全离线。仓库其他历史测试不一定仍对应现有 API。

## 发布边界

[build-release](../scripts/build-release.js)、[verify-release-package](../scripts/verify-release-package.js)、[聚合器](../scripts/aggregate-release-receipts.js) 和 [release workflow](../.github/workflows/release.yml) 是当前执行入口。

聚合器要求 darwin-arm64、win32-x64、win32-arm64、linux-x64、linux-arm64 五个目标的有效 receipt。包内 Skill 校验当前要求七个，名单见运行契约。安装包架构、sidecar、hash、资源、签名和对应检查结果必须与 receipt 一致；unsigned 本地验证不能代替正式签名发布。

本页不给出“已可发布”结论。旧平台验收日期、历史产物和预留的维护命令不能证明当前门禁通过。

## 知识库自身检查

更新后检查所有文档相对链接、代码路径、命令注册及脚本文件是否存在。若注册命令引用缺失脚本，标为不可用，不能继续作为必须运行的有效门禁。本次重建仅验证文档结构与引用，不重复运行产品测试或继承旧验收通过状态。


本次核对结果：`test-scripts.json` 注册的 Node 脚本均存在。`maintenance-scripts.json` 中以下两项引用缺失脚本，当前不可用，且本次未修改注册表：

| 注册名 | 缺失文件 |
| --- | --- |
| `verify:knowledge:codex-harness` | `scripts/verify-codex-harness-knowledge.js` |
| `verify:test:full-product-headless` | `scripts/verify-full-product-headless-test-contract.js` |

不能用这些命令的注册记录证明存在有效知识库门禁或全产品无头测试。


## 聊天链回归入口（2026-09-22）

- `npm test -- test:unit`：主测试含聊天身份/启动/恢复/范围及 LAN 并发回归。
- `npm test -- test:ui-e2e`：前端构建 + 静音 Electron，隔离小说与模拟 Responses。覆盖资料页普通发送、人物卡/世界观刷新、草稿冲突、跨项目确认恢复、停止与部分保存、编辑器选区/插入/旧版本拒绝、重启。
- `npm test -- test:chat-chain`：仅聊天契约及 LAN HTTP 测试，仍需要本机监听端口权限。
- `npm test -- test:chat-chain:live`：小规模真实模型读取、确认保存、拒绝。默认复用已有 live acceptance 配置；可用 `MANA_LIVE_CONFIG_ROOT` 指向已有配置目录。只复制配置到临时隔离目录，结束清理，不修改原配置或真实小说。缺少配置时失败，不用模拟服务冒充。

实际本轮证据及限制见 [聊天链审计报告](../artifacts/chat-chain-audit/report.md#实施记录2026-09-22)。


## 当前写作职责修复的验证入口（2026-10-19）

主集合新增writing-intent-context.test.js（包含R2正反例、真实隔离资料、问题状态队列与ID分配），narrative-audit.test.js改测来源/接口边界，不再把预制语义图当正确性证明。可单独运行 `node test/writing-intent-context.test.js`、`node test/narrative-audit.test.js`，完整集合仍为 `npm test -- test:unit`。

写作UI与原生聊天UI使用确定性服务、实际App Server、生产渲染器/IPC和原生批准；范围解析的只读请求与作者请求分别计数，不能把任一子任务终态当成父任务完成。真实模型用test/live-writing-modes-host.cjs的隔离小说和原始请求，失败的角色前置任务会阻止后续记忆演练，不能用后续独立请求冒充整链通过。测试客户端始终静音。

当前轮次、冻结源码、结果与未通过内容见[修复记录](../artifacts/chat-chain-audit/report.md#按r2审计实施职责修复2026-10-19)。自动回归通过不覆盖模型漏报、实际正文质量或打包运行时；不得凭报告格式齐全宣称已发布或已完整修复。

## 导入安全回归（2026-10-19，独立树）

- `npm test -- test:data-import-safety`：生产存储/IPC + 模拟模型/网页，覆盖身份、离线、角色重建、世界观保真、分析失败、合并版本/重启/部分写入、补全并发编辑和取消；包含六个设计反例的正向断言、进程退出恢复、跨进程并发和二进制恢复。
- `npm test -- test:import-saga:ui`：静音隔离 Electron，覆盖导入到正式读回、离线确认、部分结果审阅、合并冲突与角色重建的拒绝/确认。早期场景替换分析生产者；新增事实流程运行真实分析器，仅替换原生模型运输。网页审阅 UI 替换网页候选生产者，补全服务另有运输替身的关联测试。不能当作真实模型/网页验收。
- 主 `test:unit` 已纳入导入安全及相关回归；UI 测试分发已在 main.js 接通。证据放于 `artifacts/data-import-safety-audit/`，不复用聊天链测试数据。

三个 P1 的严格正向回归为 [import-transaction-p1.test.js](../test/import-transaction-p1.test.js)，已加入上述两个后端入口。检查已有值拒绝、稳定身份与原始 Markdown、各持久化分界的退出/恢复、目标持久保留、登记归属、跨进程取消、终态/回执一致、过期租约及 SIGKILL。子进程故障注入器只接收测试临时根中的运行记录；测试成功必须满足保存不变量，不能把复现错误的脚本退出 0 算作通过。UI 另从实际入口验证拒绝后的正式世界观/时间线可见、重载后的提升恢复、提交决定前后取消和初次自动提升取消。具体执行证据与边界以审计报告的最新记录为准。

本次没有发布、推送或主线集成；实际结果见 [审计报告](../artifacts/data-import-safety-audit/report.md)。

唯一状态权威回归为 [import-authority-regression.test.js](../test/import-authority-regression.test.js)，已加入 test:unit 和 test:data-import-safety；先保留四个反例的正确性断言，再检查所有入口、材料/运行写入分界、真实进程死亡、旧提升/合并接管及来源失败恢复。`npm test -- test:import-authority-audit` 另运行跨入口反例复核、取舍重置与 501 项完整集合检查。公共合并/审阅/分析 API 现在通过命令确认，宿主调用方须 await；不存在未确认即默认生效的同步取舍。旧“新服务读取必定中断分析”断言被纠正，实际进程死亡后的恢复由 SIGKILL 回归覆盖。

导入 UI 新增另一名称选择、失败取消、已有项目合并决定前后取消，以及尚无暂存 ID 的来源恢复；UI 测试使用确定性分析输入，主进程与正式存储真实执行。入口、状态、正式读回与回执是完成依据，不以测试条数代替验收。实际本轮结果见审计报告最新阶段。

2026-10-19 本独立树的唯一状态权威重做已完成冻结后验证；验收应使用审计报告最新一节的 `authority-*-release.log`、诊断回执和源码冻结清单，不能沿用同目录旧阶段的通过结果。界面验证包括原数据拒绝、合法改名、暂存前恢复、失败取消、已有项目提交决定前后竞争及正式读回；实际 SIGKILL 由隔离后端进程覆盖。完整记录见 [当前交付前审计](../artifacts/data-import-safety-audit/report.md#唯一状态权威重做与交付前反例审计2026-10-19)。
