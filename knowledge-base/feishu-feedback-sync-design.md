# 【功能完成声明】

用户一键反馈到飞书表格（Bitable）的全链路功能已开发完成，支持：
- 反馈内容、日志、截图等自动收集并本地入队
- 自动/手动同步到飞书Bitable表格，支持失败重试、状态回写
- 支持命令行和主程序内触发同步，配置灵活

所有关键链路已通过E2E测试和实际飞书表格验证。

如需扩展或迁移到服务端/云函数，可基于现有实现快速适配。
# 【2026-05-16 进度总结】

## 本地outbox到飞书表格同步服务进展

1. 已有完整的本地反馈队列（outbox）结构，支持多条反馈、附件（如截图）本地存储。
2. 已实现飞书Bitable API适配器（src/main/feishu/feishuAdapter.js），支持获取token、上传附件、创建/更新表格记录。
3. 已有字段映射器（src/main/feishu/fieldMapper.js），支持本地结构到表格字段的自动转换（含东八区时间、payloadJson等）。
4. 已实现自动同步worker（src/main/sync/feedbackSyncWorker.js），支持定时扫描outbox、失败重试、状态回写。
5. 支持命令行/脚本手动同步（scripts/feishu-debug.js --action=smoke / --action=playout --feedbackId=xxx）。
6. 配置项支持多来源（app-config.json/env/CLI），可灵活切换。
7. 已通过多轮冒烟测试和E2E验证，表格字段、附件、时区等均已对齐。

### 使用方法简述
- 配置好app-config.json中的feishuSync（appId、appSecret、appToken、tableId、enabled）。
- 可用脚本 `node scripts/feishu-debug.js --action=smoke` 或 `--action=playout --feedbackId=xxx` 进行手动同步。
- 也可在主程序内通过feedbackSyncWorker.triggerSync()触发全量同步。

### 结论
当前无需重写API，直接用现有的feishuAdapter + feedbackSyncWorker + fieldMapper即可实现本地outbox到飞书表格的自动/手动同步。
如需具体命令或配置模板，可随时补充。
# 飞书多维表格反馈同步设计

**状态：已实现（Phase 1–4 全部完成）**

最后更新：2026-05-16

## 目标

在现有“一键反馈”能力之上，增加一个可靠、可重试、可集中查看的同步层，把本地 feedback-outbox 中的反馈数据、截图附件和摘要信息汇总写入飞书多维表格。

本设计的核心目标不是改变用户侧反馈体验，而是在不牺牲可靠性的前提下，为开发者建立一个集中反馈台，便于：

1. 按项目、章节、线程、错误类型筛选问题
2. 快速查看截图、标题、摘要、关键错误
3. 在需要时打开完整 payload 做深度排查
4. 避免因为网络、权限或飞书接口失败导致用户反馈丢失

## 非目标

1. 不让客户侧运行依赖飞书 CLI
2. 不让渲染器直接持有飞书凭证
3. 不要求用户等待飞书写入成功后才算“提交成功”
4. 不把完整 payload 的所有字段强行摊平成多维表格列
5. 第一阶段不引入云端中转服务

## 设计原则

1. 本地优先：先写本地，再做远端同步
2. 采集与投递解耦：用户提交成功只依赖本地 outbox，不依赖飞书
3. 摘要优先：多维表格用于筛选和分派，完整 JSON 用于深度排查
4. 附件独立处理：截图单独作为附件上传，不和文本列混杂
5. 失败可恢复：所有同步失败都要能分类、记录、重试或人工回放
6. CLI 仅开发使用：飞书 CLI 用于联调、验权、回放，不进入客户运行链路

## 当前基础

现有反馈链路已经具备完整的本地采集能力：

1. [src/components/chatFeedbackPayload.mjs](../src/components/chatFeedbackPayload.mjs) 负责构造反馈 payload，包含标题、描述、项目、章节、线程、会话、最近工具调用、检查点、变更摘要、渲染器日志摘要和截图请求标记
2. [src/main/ipc/feedback.js](../src/main/ipc/feedback.js) 负责在主进程补充最近主进程日志、chatAgent 日志，并按需抓取当前窗口截图
3. [src/main/store/feedbackOutbox.js](../src/main/store/feedbackOutbox.js) 负责把反馈 JSON 和附件持久化到 feedback-outbox
4. [src/main/store/recentLogBuffer.js](../src/main/store/recentLogBuffer.js) 负责维护主进程最近日志摘要
5. [quick-feedback-design.md](./quick-feedback-design.md) 已经明确了反馈字段、脱敏规则、截图和本地持久化原则

这意味着飞书同步设计不需要重做采集层，只需要新增“同步层”。

## Outbox 概念

outbox 可以理解成“本地持久化的待发送队列”。

它和“用户点提交就立刻发网请求”的同步表单不同。outbox 的职责是：

1. 在用户点击反馈后，先把完整反馈写到本地磁盘
2. 只要本地写入成功，UI 就可以提示“反馈已保存”
3. 之后再由后台异步把这条反馈同步到飞书
4. 如果同步失败，这条记录仍然保留在本地，不会丢失
5. 系统可以稍后自动重试，也可以人工重放

在本系统里，outbox 是可靠性的核心边界。

用户侧的一键反馈只需要保证“采集成功、落盘成功”；飞书是否当场可用，是同步层要解决的问题，不应该由用户来承担。

## 目标架构

推荐架构如下：

用户点击一键反馈  
→ 渲染器构造 feedback payload  
→ 主进程补充日志和截图  
→ 写入本地 feedback-outbox  
→ 记录状态为 pending  
→ 同步 worker 异步扫描 pending 记录  
→ 通过飞书 adapter 上传截图并写入多维表格  
→ 成功后回写 sent 和 remoteRecordId  
→ 失败后回写错误信息和重试状态

这条链路里有四层：

1. 采集层  
现有聊天面板与主进程反馈提交链路，负责生成 payload、截图和日志摘要

2. 持久化层  
现有 feedback-outbox，负责 durable save

3. 同步层  
新增 feedback sync worker，负责扫描、重试、上传、状态回写

4. 飞书适配层  
新增 feishu adapter，负责 token、附件上传、记录创建、错误归一化

## 为什么不同步直接写飞书

不推荐让一键反馈的提交动作直接写飞书，原因有四个：

1. 用户提交会被远端接口阻塞，体验不稳定
2. 截图和记录通常不是单请求原子写入，容易出现半成功状态
3. 飞书鉴权、限流、字段变更、权限不足等异常都不适合暴露在前端同步动作中
4. 直接写远端会放大“提交失败即数据丢失”的风险

因此必须保留“先本地保存，再异步同步”的 outbox 模型。

## 同步层设计

### 执行位置

第一阶段推荐把同步层放在 Electron 主进程中实现。

原因：

1. 现有 outbox 已经在主进程落盘
2. 飞书凭证不应进入渲染器
3. 主进程更适合做定时扫描、重试、错误日志和互斥控制
4. 这样可以先打通产品链路，不必先建设服务端

### 触发方式

同步 worker 建议支持三种触发：

1. 应用启动后扫描一次 pending 和 retryable_failed
2. 每次新反馈提交后短延迟触发一次
3. 网络恢复、手动重试或开发者命令触发一次

### 并发与互斥

worker 需要具备单实例互斥能力，避免同一条 feedback 被重复上传。

建议规则：

1. 以 feedbackId 为粒度加锁
2. 同一时刻单条记录只允许一个同步任务运行
3. 全局并发数设置上限，避免附件上传把网络打满
4. 如果上一次同步崩溃退出，启动时应允许恢复处理 stuck in syncing 的记录

## Outbox 数据模型扩展

当前 outbox 记录已经有：

1. feedbackId
2. createdAt
3. status
4. payload
5. attachments

为了支持飞书同步，需要增加这些元数据：

1. syncStatus  
取值建议为 pending、syncing、retryable_failed、failed_terminal、sent

2. retryCount  
当前已重试次数

3. lastSendAttemptAt  
最近一次开始同步的时间

4. lastSendSucceededAt  
最近一次成功完成同步的时间

5. nextRetryAt  
下一次允许自动重试的时间

6. lastError  
最近一次错误摘要，面向开发者可读

7. lastErrorCode  
可选，保留 HTTP 或逻辑错误分类码

8. remoteRecordId  
飞书多维表格中的记录 id

9. remoteTableId  
写入目标表 id

10. remoteAttachmentTokens  
已上传附件的远端引用标识，用于补偿和复用

11. endpointProfile  
当前写入目标环境，例如 dev、staging、prod

12. transportMeta  
可选，用于保存 adapter 返回的额外信息，如 tenant、base、请求耗时

index.json 继续保持轻量摘要，不承载完整 payload。单条 JSON 文件仍是权威记录。

## 状态机设计

同步状态机建议定义为：

1. pending  
刚写入 outbox，尚未开始同步

2. syncing  
当前正在上传或创建记录

3. retryable_failed  
本次失败，但具备自动重试价值

4. failed_terminal  
本次失败且短期内自动重试无意义，需要人工修复配置或权限

5. sent  
已成功写入飞书

### 状态迁移

pending → syncing  
syncing → sent  
syncing → retryable_failed  
syncing → failed_terminal  
retryable_failed → syncing

部分异常情况下 syncing → pending 仅用于崩溃恢复，不建议正常流程使用。

### 错误分类

应归为 retryable_failed 的场景：

1. 网络中断
2. DNS/超时
3. 429 限流
4. 5xx 服务异常
5. 临时 token 失效但可刷新

应归为 failed_terminal 的场景：

1. appId/appSecret 错误
2. tableId/baseId 错误
3. 表字段缺失或字段类型不匹配
4. 权限永久不足
5. 附件列不存在
6. payload 与当前 schema 映射不兼容

## 飞书适配层设计

飞书相关逻辑不应分散在 worker 里，建议抽成独立 adapter。adapter 的职责是：

1. 获取和缓存 tenant access token
2. 校验目标多维表格与字段 schema
3. 上传截图附件
4. 创建多维表格记录
5. 更新记录中的附件列或状态列
6. 归一化飞书错误为本地可处理的错误类型

worker 只负责调度和状态回写，不直接拼 HTTP 请求。

## 飞书多维表格 Schema 设计

多维表格不应作为“完整 payload 展示器”，而应作为“可筛选的反馈索引表”。

建议列如下：

1. feedbackId
2. createdAt
3. issueTitle
4. actualBehavior
5. feedbackMode
6. severity
7. appVersion
8. platform
9. activeRuntimeDriver
10. activeProviderType
11. activeNovelId
12. activeChapterName
13. activeThreadId
14. currentSessionId
15. latestUiError
16. latestMainProcessError
17. latestChatAgentError
18. syncStatus
19. screenshot
20. payloadJson

如果飞书的大文本承载体验不理想，可以把完整 payload 改成 JSON 文件附件，同时保留一列 payloadSummary。

## 字段映射原则

### 应摊平成列的字段

适合筛选、排序、分派、快速扫描的摘要字段进入多维表格列，例如：

1. 标题
2. 实际行为
3. 严重度
4. 反馈模式
5. 项目 id
6. 章节名
7. 线程 id
8. 会话 id
9. 主要错误摘要
10. 平台、版本、driver、provider

### 不建议摊平的字段

这些结构复杂、长度不稳定或主要用于深度排查，应该保留在 payloadJson 或 JSON 附件中：

1. recentMessages
2. recentToolCalls
3. recentLogs
4. latestCheckpoint
5. latestChangedFiles
6. contentExcerpt
7. selectionText
8. 完整 attachments 元数据

### 截图处理

截图只走附件列，不进普通文本列。多维表格中只需要能直接预览或点击查看，不需要在文本字段中重复描述。

## 附件同步设计

截图是最关键的附件类型。同步顺序建议为：

1. 从 outbox 读取本地 PNG 路径
2. 校验文件存在、大小合法、格式合法
3. 上传附件到飞书
4. 获取远端附件引用标识
5. 创建或更新多维表格记录
6. 把附件挂到 screenshot 列
7. 把远端附件引用回写到 outbox

### 补偿策略

如果附件上传成功但记录创建失败：

1. 将远端附件引用写入 remoteAttachmentTokens
2. 下次重试优先复用该引用
3. 不重复上传同一张截图

如果记录创建成功但附件绑定失败：

1. 保留 remoteRecordId
2. 下次重试只做附件补挂，不再重复创建记录

## 安全与权限边界

### 客户侧边界

客户侧继续只负责：

1. 采集反馈
2. 落本地 outbox
3. 显示“已保存”或“保存失败”

客户侧不负责：

1. 飞书登录
2. 飞书 token 管理
3. 飞书 CLI 运行
4. 表结构校验
5. 远端同步异常恢复

### 主进程边界

飞书凭证和表配置只保存在主进程配置层，不暴露给渲染器。

### 隐私边界

现有 feedbackMode 规则继续保留：

1. opinion-only  
不上传 recentMessages、recentLogs、截图、完整上下文片段

2. context-with-logs  
允许同步日志摘要、线程片段、最近工具调用、截图、变更摘要

## 飞书 CLI 的定位

飞书 CLI 不进入客户运行时，只用于开发调试。

建议用途：

1. 校验飞书应用权限是否齐全
2. 检查目标多维表格字段是否与映射一致
3. 回放一条 outbox 样本到测试表
4. 诊断写入失败是 token、字段、权限还是附件问题
5. 初始化和维护测试环境

因此 CLI 是“开发者工具”，不是“产品依赖”。

## 开发期联调流程

推荐联调顺序如下：

1. 在飞书开发者后台创建测试应用
2. 创建测试多维表格和附件列
3. 用飞书 CLI 或 API 调试台验证应用权限、表权限、附件上传权限
4. 准备一条真实 outbox 样本
5. 先用 adapter 单独把文本列写入测试表
6. 再打通截图上传与附件绑定
7. 最后把 worker 接到真实 outbox 扫描链路上
8. 验证失败重试、补偿、重复启动恢复

## 运维与人工干预设计

第一阶段不一定要做正式 UI，但至少要保留这些能力：

1. 查看 outbox 记录状态
2. 手动重试某条失败记录
3. 导出单条反馈 JSON
4. 用 feedbackId 回放一次同步
5. 查看最近一次错误摘要和远端记录 id

这些能力可以先放在开发者菜单、日志命令或调试脚本里。

## 分阶段实施建议

### Phase 1：同步元数据与 Worker 骨架

目标：

1. 扩展 outbox 记录结构
2. 实现扫描、锁、状态迁移
3. 暂不接飞书

### Phase 2：飞书文本记录写入

目标：

1. 打通 token 获取
2. 创建多维表格记录
3. 回写 remoteRecordId 和 sent

### Phase 3：截图附件上传与绑定

目标：

1. 上传 PNG
2. 在表中显示截图附件
3. 实现附件补偿与复用

### Phase 4：失败重试与人工回放

目标：

1. 指数退避
2. failed_terminal 分类
3. 手动重试和单条回放

### Phase 5：视需求评估中转服务

目标：

1. 如果需要集中权限管理、跨设备汇聚或审计，再把 adapter 挪到服务端
2. 保持 outbox 协议不变，降低迁移成本

## 验证方案

### 纯逻辑验证

1. payload 到 Bitable 字段映射正确
2. opinion-only 不会同步越界字段
3. context-with-logs 会保留截图和摘要信息

### 主进程验证

1. outbox 状态机迁移正确
2. retryCount、nextRetryAt、lastError 回写正确
3. syncing 崩溃恢复正常

### 附件验证

1. 截图上传成功后记录可绑定
2. 部分失败时能补偿
3. 重试不重复上传相同附件

### 联调验证

1. 用真实测试表完成一条完整写入
2. 表内可查看摘要字段
3. 表内可预览截图
4. 可打开 payloadJson 进行深度排查

### 现有回归保留

现有 feedback 提交相关回归必须继续通过，尤其是：

1. [test/feedback-outbox-attachments.test.js](../test/feedback-outbox-attachments.test.js)
2. [test/chat-feedback-ui-e2e.js](../test/chat-feedback-ui-e2e.js)

## 实现结果

Phase 1–4 全部完成，代码已合入主干。

### 实际文件清单

| 文件 | 职责 |
|---|---|
| `src/main/store/feedbackOutbox.js` | 扩展同步元数据（syncStatus/retryCount/remoteRecordId 等），新增 `updateSyncMeta` / `listPendingForSync` / `recoverStuckSyncing` |
| `src/main/sync/syncLock.js` | 内存锁（Map），以 feedbackId 为粒度防并发 |
| `src/main/sync/feedbackSyncWorker.js` | 同步 Worker：扫描、状态机、指数退避、附件补偿、崩溃恢复 |
| `src/main/feishu/feishuAdapter.js` | 飞书 OpenAPI 适配器：token 缓存（提前 5min 刷新）、创建记录、更新记录、上传附件、查表字段、错误归一化 |
| `src/main/feishu/fieldMapper.js` | Payload → Bitable 字段映射；附件列格式 `[{file_token}]` |
| `src/main/ipc/feedbackSync.js` | IPC：`mana:feedback:listOutbox` / `getRecord` / `retrySync` / `triggerSync` |
| `src/main/ipc/feedback.js` | 提交反馈后 2s 自动触发 worker 扫描 |
| `src/main/store/appConfig.js` | 新增 `feishuSync` 配置块（默认空值 + enabled:false） |
| `src/main/index.js` | 启动时加载配置、初始化 worker、崩溃恢复 |
| `scripts/feishu-debug.js` | 开发调试脚本：`verify` / `list-fields` / `playout` |
| `test/feedback-sync.test.js` | 10 个单元测试（状态机/退避/错误分类/字段映射/锁） |

### 与设计的差异

1. **错误分类内聚在 adapter**：`normalizeError` 放在 `feishuAdapter.js` 中，worker 通过 `classifyError` 做二次分发，而非 worker 直接拼 HTTP 请求
2. **附件上传用 `drive/v1/medias/upload_all`**：实际使用 media 上传 API（而非早期设想的附件专用 API），返回的 `file_token` 直接绑定到 Bitable 附件列
3. **token 缓存是模块级单例**：`feishuAdapter.js` 内部维护 `tokenCache`，worker 不感知缓存逻辑
4. **使用 Node.js 内置 `https` 模块**：未引入 axios/node-fetch，零新增依赖

### 验证结果

- `test/feedback-sync.test.js`：**10/10 通过**
- `test/feedback-outbox-attachments.test.js`：**2/2 通过**（回归）
- `test/chat-feedback-payload.test.js`：**2/2 通过**（回归）

### 安全考量

**默认安全**：`DEFAULT_APP_CONFIG` 中 `feishuSync` 全部为空字符串 + `enabled: false`，即使被打包也无价值。

**运行时凭证位置**：`app-config.json` 位于用户本地目录（`~/Library/Application Support/.../`），不在 `.app` 包内，不会随分发泄露。

**待加固**：`appSecret` 目前与普通配置混存在 `app-config.json` 中。项目 `paths.js` 已预留 `secrets.json`，建议后续把 `appSecret` 迁移过去，实现"敏感凭证 / 普通配置"分离。

## 关键决策结论

1. 一键反馈的“提交成功”只以本地 outbox 成功为准，不以飞书写入成功为准
2. 飞书多维表格是集中收集目标，不是用户提交入口
3. 飞书 CLI 只用于开发联调，不进入客户运行链路
4. 第一阶段同步层留在主进程，不急着上服务端
5. 多维表格采用“摘要字段 + 截图附件 + 原始 payload”三层结构
6. 完整 payload 不做全量平铺，避免表结构脆弱和维护失控