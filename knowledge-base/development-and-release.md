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
| 原生模型链测试 | `npm test -- test:codex-native` |
| 资源事务测试 | `npm test -- test:mcp-mutations` |
| 原生 UI 流程 | `npm test -- test:ui-e2e` |
| 模型配置 UI | `npm test -- test:responses-config:ui` |
| 导入 UI | `npm test -- test:import-saga:ui` |
| 安全扫描 | `node scripts/run-maintenance-script.js security:scan:current` |
| 构建发布包 | `npm run build` 或平台 build 脚本 |

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
