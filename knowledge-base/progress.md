# 开发进度追踪

最后更新：2026-05-17

## 当前阶段

- 阶段：AgentRuntimeDriver 抽象层重构（按 `/Users/potablewater/.claude/plans/spicy-napping-book.md` 推进）
- 状态：**Phase 0–7 全部完成**（7 已通过 fake-claude E2E 烟测 + auto-detect IPC 烟测，UI 端的端到端联调待真 Claude Code 安装环境手动验证）。下一步是 Phase 8（claude-code-cli driver）。
- **反馈同步 relay 已完成腾讯云 SCF 部署**，端到端验证通过（health / upload / submit 全链路）。
- **GitHub Actions 多平台自动打包 + 自动更新器已上线**，打 Tag 自动构建 Release，客户端启动时检测新版本。


## 里程碑

### 2026-05-17 — GitHub Actions 多平台自动打包 + 自动更新器

#### 背景

内测版本需要自动打包分发能力。此前仅支持本地手动 `npm run build` 打包，无 CI/CD。

#### 实现内容

**GitHub Actions Workflow**（`.github/workflows/release.yml`）

- 触发条件：`push` 匹配 `v*` tag
- Matrix：macOS / Windows / Ubuntu 三平台并行
- 步骤：checkout → Node.js 18 → `npm ci` → `vite build` → `electron-builder --publish=never` → 创建 Release → 上传产物
- 产物：
  - macOS arm64 → `*.dmg`
  - Windows → `*.exe`
  - Linux → `*.AppImage`

**版本检测**（`src/main/updater/versionChecker.js`）

- 直接查询 GitHub Releases API（不依赖 `electron-updater`，无需代码签名）
- semver 比较当前版本 vs 最新版本
- 启动后延迟 5s 静默检测（`silent: true`），有更新才弹窗
- 支持"跳过此版本"写入 `appConfig.updater.skipVersion`

**自动下载**（`src/main/updater/downloadManager.js`）

- 从 Release assets 匹配当前平台文件名
- Node.js `https` 模块下载到 `<userData>/updates/`
- 下载完成后弹窗提示安装（macOS/Linux 手动运行；Windows `spawn` 启动安装程序）

**更新弹窗交互**

- `dialog.showMessageBox()` 三按钮："前往下载" / "稍后提醒" / "跳过此版本"
- Checkbox"自动下载并安装更新"（默认未勾选）
- 勾选后后台下载，完成后二次确认安装

**配置存储**（`src/main/store/appConfig.js`）

- 新增 `updater` 配置块：`skipVersion` / `autoDownload` / `lastCheckAt`
- `load()` / `save()` 深合并，空字符串不覆盖默认值

**IPC 暴露**

- `preload.js`：`mana.updater.checkNow()`
- `src/main/ipc/updater.js`：`mana:updater:checkNow` handler
- `main.js`：启动时 `setTimeout(() => checkForUpdates({silent:true}), 5000)`

#### 首次发布验证

| 平台 | 产物 | 大小 | 状态 |
|---|---|---|---|
| macOS (arm64) | `MultiAgentNovelAssistant-0.0.1-arm64.dmg` | 199 MB | ✅ |
| Windows | `MultiAgentNovelAssistant.Setup.0.0.1.exe` | 162 MB | ✅ |
| Linux | `MultiAgentNovelAssistant-0.0.1.AppImage` | 223 MB | ✅ |

Release 页面：`https://github.com/WZ-123/MultiAgentNovelAssistant/releases/tag/v0.0.1`
Workflow Run：`https://github.com/WZ-123/MultiAgentNovelAssistant/actions/runs/25991255629`

---

### 2026-05-17 — 反馈同步腾讯云 SCF 中继部署完成（Cloudflare Workers 迁移）

#### 背景

原 Cloudflare Workers 中继（`*.workers.dev`）因 GFW 阻断无法在中国大陆访问，遂迁移至**腾讯云 SCF（Serverless Cloud Function）**。

#### 目标

为内测安全隔离飞书凭证：客户端不再持有 `appId/appSecret/appToken/tableId`，只通过 SCF 中继转发反馈数据。

补充运行边界：
- 打包给用户的客户端不得包含开发者本地填写的 API Key，也不得保留直连飞书能力。
- 用户侧“从飞书查询 / 写入授权码使用记录 / 将 bug 反馈发送到飞书”统一走腾讯云 SCF。
- 开发者环境允许保留直连飞书能力，用于本地 AI 调试和 bug 收集。

#### SCF 部署信息

| 项 | 值 |
|---|---|
| 服务 | 腾讯云 SCF（Web Function，Node.js 18.15） |
| 入口文件 | `app.js`（HTTP Server 模式，`http.createServer`） |
| 函数 URL | `https://1301861337-iyb2r0f8lz.ap-guangzhou.tencentscf.com` |
| 环境变量 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_APP_TOKEN` / `FEISHU_TABLE_ID` / `RELAY_API_KEY` |
| 客户端配置 | 仅允许保存 `relayUrl` / `relayApiKey`，不得保存飞书凭证 |

#### SCF 文件

| 文件 | 职责 |
|---|---|
| `relay-worker/scf-app-final.js` | 最终版 SCF HTTP Server 入口（本地备份），含 health / upload / submit 三路由 |
| `relay-worker/scf-http-app.js` | 中间版本（已废弃） |
| `relay-worker/scf-online-index.js` | 早期 `main_handler` 事件版本（已废弃，SCF Web Function 要求 HTTP Server） |
| `relay-worker/src/scf-entry.cjs` | API Gateway 事件适配版（CJS 格式，未使用） |

#### 修改文件

| 文件 | 改动 |
|---|---|
| `src/main/store/appConfig.js` | 新增 `relayUrl` / `relayApiKey`；`load()` 合并逻辑修复：**空字符串不覆盖预置默认值**；`save()` 深合并 `feishuSync` |
| `src/main/sync/feedbackSyncWorker.js` | 当前发布路径已收敛为 relay-only；开发者环境仍可保留直连飞书调试工具，但不进入打包客户端 |
| `src/main/sync/relayClient.js` | 本地 HTTP 客户端：multipart 上传附件 + JSON submit（协议与 SCF 对齐） |

#### 关键设计选择

- **凭证完全隔离**：飞书 `appId/appSecret/appToken/tableId` 仅存在于 SCF 环境变量中；客户端只持有 `relayUrl` + `relayApiKey`
- **打包边界固定**：用户客户端不打包开发者本地填写的 API Key，也不保留直连飞书读写能力
- **协议对齐**：relayClient 与 SCF 保持相同 API：`POST /api/v1/feedback/upload`（multipart）+ `POST /api/v1/feedback/submit`（JSON）
- **SCF 无状态 token 策略**：每次请求重新获取飞书 tenant_access_token（内测低频场景，不引入缓存）
- **HTTP Server 模式**：SCF Web Function 要求启动 `http.createServer` 监听 `process.env.PORT`，而非 `exports.main_handler`

#### 端到端验证结果

| 端点 | 结果 |
|---|---|
| `GET /api/v1/health` | ✅ `{"ok":true,"mode":"scf-web-function"}` |
| `POST /api/v1/feedback/upload` | ✅ 返回 `fileToken`（附件上传成功） |
| `POST /api/v1/feedback/submit`（纯文本） | ✅ 创建记录 `recvjS3h2OB2uv` |
| `POST /api/v1/feedback/submit`（带附件） | ✅ 创建记录 `recvjS3te22GOu`，附件绑定 screenshot 列 |

#### 遗留文件（Cloudflare Workers 版本，不再使用）

| 文件 | 状态 |
|---|---|
| `relay-worker/src/index.js` | Cloudflare Worker ESM 入口（已废弃） |
| `relay-worker/wrangler.toml` | Wrangler 配置（已废弃） |
| `relay-worker/package.json` | 依赖（已废弃） |
| `relay-worker/scripts/init.js` | 初始化脚本（已废弃） |
| `relay-worker/scripts/test-relay.js` | 测试脚本（已废弃） |
| `relay-worker/DEPLOY.md` | 部署文档（已废弃） |
| `.github/workflows/deploy-relay.yml` | GitHub Actions（已废弃） |

> 废弃原因：`*.workers.dev` 域名被 GFW 阻断，中国大陆无法访问。

---

### 2026-05-16 — 飞书多维表格反馈同步实现完成（Phase 1–4）

#### 输出

- 设计文档 [feishu-feedback-sync-design.md](../knowledge-base/feishu-feedback-sync-design.md) 已更新为"已实现"状态

#### 实现内容

| 文件 | 职责 |
|---|---|
| `src/main/store/feedbackOutbox.js` | 扩展同步元数据；新增 `updateSyncMeta` / `listPendingForSync` / `recoverStuckSyncing` |
| `src/main/sync/syncLock.js` | 内存锁（feedbackId 粒度） |
| `src/main/sync/feedbackSyncWorker.js` | Worker：扫描、状态机、指数退避、附件补偿、崩溃恢复 |
| `src/main/feishu/feishuAdapter.js` | 飞书 OpenAPI：token 缓存、创建/更新记录、上传附件、查表字段、错误归一化 |
| `src/main/feishu/fieldMapper.js` | Payload → Bitable 字段映射 |
| `src/main/ipc/feedbackSync.js` | IPC：`listOutbox` / `getRecord` / `retrySync` / `triggerSync` |
| `src/main/ipc/feedback.js` | 提交后 2s 自动触发同步 |
| `src/main/store/appConfig.js` | 新增 `feishuSync` 配置块 |
| `src/main/index.js` | 启动时初始化 worker |
| `scripts/feishu-debug.js` | 调试脚本：`verify` / `list-fields` / `playout` |
| `test/feedback-sync.test.js` | 10 个单元测试 |

#### 关键设计选择

- **产品运行时不依赖飞书 CLI**：用 Node.js 内置 `https` 模块直接调 OpenAPI；CLI（`@larksuite/cli@1.0.17`）仅用于开发调试
- **本地优先**：用户提交成功以 outbox 落盘为准，飞书同步是异步后台任务
- **状态机**：`pending → syncing → sent/retryable_failed/failed_terminal`；启动时自动恢复 `syncing` 为 `pending`
- **附件补偿**：截图上传成功但记录创建失败时，复用已上传的 `file_token`；记录已创建但附件未绑定时，下次只做附件补挂
- **指数退避**：`30s × 2^retryCount`，上限 1h，最大 10 次后转 `failed_terminal`
- **错误归一化**：飞书 API 错误统一映射为 `network_error` / `rate_limited` / `auth_failed` / `permission_denied` / `table_not_found` / `field_not_found` / `invalid_schema`

#### 验证结果

- `test/feedback-sync.test.js`：**10/10 通过**
- `test/feedback-outbox-attachments.test.js`：**2/2 通过**（回归）
- `test/chat-feedback-payload.test.js`：**2/2 通过**（回归）

#### 安全状态

- 默认配置全空值 + `enabled: false`，打包无风险
- 运行时凭证从用户本地目录读取，不在 `.app` 包内
- `appSecret` 目前与常规配置混存在 `app-config.json` 中；`paths.js` 已预留 `secrets.json`，建议后续迁移实现敏感/常规配置分离

#### 待手动验证（需真实飞书应用 + 多维表格）

1. 填入 `appId`/`appSecret`/`appToken`/`tableId` → `npm run start` → 提交一条反馈
2. 2s 后 Worker 自动扫描 → 飞书表中出现记录，摘要字段正确
3. 截图正常显示在附件列
4. 断开网络 → 提交反馈 → 恢复网络 → 自动重试成功
5. `node scripts/feishu-debug.js --action=verify ...` 校验权限和字段

## 里程碑

### 2026-05-16 — 飞书多维表格反馈同步设计完成

#### 输出

- 新增 [feishu-feedback-sync-design.md](../knowledge-base/feishu-feedback-sync-design.md)

#### 设计结论

- 保留现有本地 feedback-outbox 作为唯一提交成功边界，飞书写入由异步同步层完成
- 飞书多维表格采用“摘要字段 + 截图附件 + 原始 payload”三层结构，不做全量字段平铺
- 同步层第一阶段放在 Electron 主进程，通过 worker 扫描 pending / retryable_failed 记录并回写 sent / failed 状态
- 飞书 CLI 仅用于开发期验权、联调、样本回放与故障诊断，不进入客户运行链路
- 附件同步需要显式补偿策略，处理“截图已上传但记录未创建”与“记录已创建但附件未挂载”的部分成功场景

#### 下一步建议

1. 扩展 [src/main/store/feedbackOutbox.js](../src/main/store/feedbackOutbox.js) 的同步元数据字段：syncStatus、retryCount、lastSendAttemptAt、lastError、remoteRecordId、remoteAttachmentTokens
2. 新增主进程 feedback sync worker 与 Feishu adapter，先打通纯文本记录创建，再补截图附件上传与补偿
3. 增加状态机与字段映射的 Node 级回归测试，确保 opinion-only 与 context-with-logs 不会越权同步

### 2026-05-02 — Phase 7 完成（Claude Code VSCode driver）

#### 目标

把"App 是 Claude Code 的 GUI 外壳"这条主路径打通。让 driver 能 spawn Claude Code CLI（VSCode 扩展自带的那份），写 `.claude/agents/*.md` + `mcp-config.json` 到一个 per-run tmpdir，把 DAG 序列化成自然语言指南交给 LLM 自主编排，再把 stream-json NDJSON 归一化成 AgentEvent 喂给现有 UI。

#### 新建文件

| 文件 | 说明 |
|---|---|
| [src/main/runtime/drivers/shared/agentMdWriter.js](../src/main/runtime/drivers/shared/agentMdWriter.js) | SubagentSpec[] → `<agentsDir>/<name>.md`（YAML frontmatter + body）；tier→model 映射 (`opus→claude-opus-4-7` / `sonnet→claude-sonnet-4-6` / `haiku→claude-haiku-4-5-20251001`)；MCP 工具用 `mcp__novel-tools__<tool>` 前缀；扫除残留 .md |
| [src/main/runtime/drivers/shared/mcpConfigGen.js](../src/main/runtime/drivers/shared/mcpConfigGen.js) | 写 `mcp-config.json`：`{mcpServers:{"novel-tools":{type:"stdio", command:process.execPath, args:[entry,'--user-data-root',...,'--run-id',...,'--main-port',...], env:{ELECTRON_RUN_AS_NODE:'1', MANA_RUN_ID, ...}}}}`；`defaultEntryScript()` 解析仓库根 `mcp-server-entry.js` |
| [src/main/runtime/drivers/shared/streamJsonParser.js](../src/main/runtime/drivers/shared/streamJsonParser.js) | NDJSON → AgentEvent；`createStreamParser({runId, pipelineRunId, nodeId})` 暴露 `parseLine(line)` / `finish(exitCode)` / `getStats()`；Task tool_use 维护 toolUses Map → `sub_agent_start` + 配对 `sub_agent_done`；其他 tool_use 带 `parentToolUseId`；`stream_event.content_block_delta.text_delta` → `text{delta:true}`；`thinking` → `text{thinking:true}`；`result` → `cost` + `done`；`finish()` 兜底（claude-code#1920 result 偶尔丢失）；`splitNdjson(buf)` 行缓冲 |
| [src/main/runtime/drivers/shared/dagToPrompt.js](../src/main/runtime/drivers/shared/dagToPrompt.js) | DagSpec + Subagents → 自然语言工作流指南；列出可用 subagent + tier + 允许工具；BFS 去回边渲染步骤（gate('no_issues') / parallel / human / output）；revision 上限提示；"Tools you may use" 段；cwd / 语言提示 |
| [src/main/runtime/drivers/shared/claudeProcess.js](../src/main/runtime/drivers/shared/claudeProcess.js) | spawn lifecycle helper：`buildClaudeArgs({appendSystemPrompt, mcpConfigPath, allowedTools, permissionMode, includePartialMessages})`；`buildUserMessage(text)` → `{type:"user", message:{role:"user", content:[{type:"text", text}]}}\n`；`spawnClaude(...)` 返回 `{onLine, onStderr, writeStdin, endStdin, cancel, waitClose, getStderrSnapshot, isRunning}`；cancel SIGTERM → 5s 后 SIGKILL |

#### 修改文件

| 文件 | 改动 |
|---|---|
| [src/main/runtime/drivers/claudeCodeVscode.js](../src/main/runtime/drivers/claudeCodeVscode.js) | 从 58 行的 stub 替换为完整实现：`availability()` 用 fast-glob 探测 4 类 IDE 扩展（VSCode / Insiders / Cursor / Windsurf）→ spawnSync `--version` 验证 → 缓存 `autoDetectedPath`；`prepare(spec)` 创建 `<userData>/runtime-tmp/<runId>/` + `.claude/agents/*.md` + `mcp-config.json` + 组装 appendSystemPrompt（pipeline 走 dagToPrompt；subagent 用单 Task 模板）；`run(handle, opts)` spawnClaude → onLine 调 parser.parseLine → 累积 fullOutputText + 透传 eventBus.emit；非零退出抛错；emit pipeline_started/pipeline_done；`cancel()` 调 proc.cancel + abortController.abort；`dispose()` 仅在 path 在 `<userData>/runtime-tmp/` 内才 rm（防误删） |
| [src/main/runtime/workflowOrchestrator.js](../src/main/runtime/workflowOrchestrator.js) | 加 `autoDetectDriverBinPath(id)`：调 driver._autoDetectBinPath 并返回 `{detected, path/reason}`；driver 不暴露该函数时返回 `detected:false` 而非抛错 |
| [src/main/ipc/runtime.js](../src/main/ipc/runtime.js) | 加 `mana:runtime:autoDetectDriverBinPath` IPC handler |
| [preload.js](../preload.js) | 暴露 `mana.runtime.autoDetectDriverBinPath(id)` |
| [src/components/RuntimeDriverSettings.jsx](../src/components/RuntimeDriverSettings.jsx) | 加 "自动侦测" 按钮：成功后把发现的路径写回 draft input + 显示绿色 "已侦测：<path>"；未发现显示橙色 "未发现可用安装"；4s 后清掉提示 |
| [src/i18n/messages.js](../src/i18n/messages.js) | zh-CN + en-US 加 `runtime.autoDetect / runtime.detected / runtime.noPathFound` |

#### 关键设计选择

- **autonomous 模式而非 spec 执行** —— DAG 不在我们这边逐节点跑；而是 `dagToPrompt()` 把 DAG 序列化成"指南"，由 Claude Code 拿着 Task 工具自己决定调度顺序。这与 `direct-api` 的 spec 模式形成互补：用户希望"做这种留一手的抽象层"
- **per-run tmpdir 隔离** —— 每次 run 都在 `<userData>/runtime-tmp/<runId>/` 新建 `.claude/agents/` + `mcp-config.json`，避免并发 run 互相污染；`dispose()` 加 `path.startsWith(...)` 安全检查防误删
- **MCP confirmation 暂缓** —— Phase 7 first-ship 报告 `supportsToolConfirmation: false`：外部 Claude Code fork 出的 MCP 子进程没有父 IPC channel；写工具需确认时 `mcp-server-entry.js` fail-closed 返回拒绝。built-in DAG 用的全是只读 + auto-write 工具（append_*），happy path 不受影响。TCP 中继是 plan 风险 #5 的下一步
- **stream-json `parent_tool_use_id` 是 sub-agent 标记的唯一来源** —— Phase 7 ship 简化版（只看 parent stream），sidechain JSONL 详细 transcript 留给后续（claude-code#1770）
- **fake-claude 烟测** —— 实际 Claude Code 不在 dev 机上时，[/tmp/fake-claude.js](/tmp/fake-claude.js) 用 6 行 NDJSON 模拟一次完整 run（system.init → assistant.text → tool_use Task → tool_result → assistant.text → result.success），把 driver 5 个生命周期方法 + 命令行参数 + stdin 协议全打一遍

#### 验证结果

5 组 standalone smoke-test 共 **130+ 断言全部通过**（不依赖 Electron 启动）：

1. **shared helpers**（[/tmp/mana-phase7-shared-smoke.js](/tmp/mana-phase7-shared-smoke.js)）—— agentMdWriter 写 8 个 builtIn subagent + 扫除残留；mcpConfigGen 输出 schema 正确（command / args / env / ELECTRON_RUN_AS_NODE）
2. **streamJsonParser**（[/tmp/mana-phase7-streamparser-smoke.js](/tmp/mana-phase7-streamparser-smoke.js)）—— 嵌套 Task → MCP → tool_result → text 全链路；`finish(exitCode)` 兜底；`splitNdjson` 行缓冲
3. **dagToPrompt**（[/tmp/mana-phase7-dagprompt-smoke.js](/tmp/mana-phase7-dagprompt-smoke.js)）—— 用真实 builtIn DAG（`dag-cheap-outline` / `dag-quality-outline`）生成指南；步骤、工具列表、cwd / 语言提示全有
4. **claudeProcess**（[/tmp/mana-phase7-claudeproc-smoke.js](/tmp/mana-phase7-claudeproc-smoke.js)）—— `buildClaudeArgs / buildUserMessage` 纯函数断言；用 `process.execPath` + `-e <stand-in>` 实跑 NDJSON 输出 + cancel 路径 + stderr 捕获
5. **driver E2E**（[/tmp/mana-phase7-driver-smoke.js](/tmp/mana-phase7-driver-smoke.js)）—— 用 [/tmp/fake-claude.js](/tmp/fake-claude.js) 当 binPath；35 断言覆盖 availability + capabilities + prepare（tmpdir + .md 文件 + mcp-config.json + appendSystemPrompt 内容）+ run（output 拼接 + 事件 text/sub_agent_start/sub_agent_done/done）+ fake-claude capture（appendSystemPrompt / mcpConfig / allowedTools / stdin envelope / ELECTRON_RUN_AS_NODE）+ dispose 清理
6. **autoDetect IPC**（[/tmp/mana-phase7-autodetect-smoke.js](/tmp/mana-phase7-autodetect-smoke.js)）—— stub `_autoDetectBinPath` 模拟 found / not-found；direct-api 没有 `_autoDetectBinPath` 时优雅返回 `detected:false`；未知 driver throw

`node --check` 通过 6 个 Phase 7 修改/新建文件。

**待手动验证**（需要装 Claude Code VSCode 扩展或 CLI 的环境）：在 Electron 内 `npm run start` → Settings → Runtime Driver → 点 "自动侦测" → 看到检测到的路径 → 选 vscode driver → 跑 `dag-quality-outline` → 事件流出现 `sub_agent_start{subagentId='sa-outline-drafter'}` 等真 Claude Code 自主调度的痕迹。

### 2026-05-02 — Phase 6 完成（独立 stdio MCP server）

#### 目标

把 in-process `mcp/client.js` 拆成真正的 stdio MCP server 子进程：directApi driver 通过 SDK Client 走 JSON-RPC 协议；危险写工具的确认请求跨进程往返；同时为 Phase 7 外部 driver 留出可被 `--mcp-config` 直接 spawn 的入口（`mcp-server-entry.js`）。

#### 新建文件

| 文件 | 说明 |
|---|---|
| [src/main/mcp/server.js](../src/main/mcp/server.js) | stdio MCP server 主体；用 `@modelcontextprotocol/sdk` 注册 17 个工具；`process.on('message')` 监听父进程的 `set-active-novel` / `confirm-response` / `shutdown`；无父 IPC 时确认请求 fail-closed |
| [src/main/mcp/forkChildTransport.js](../src/main/mcp/forkChildTransport.js) | 自定义 MCP Transport，接管 fork 出来的子进程的 stdin/stdout（SDK 自带 `StdioClientTransport` 只支持 3-fd spawn，没法留 IPC channel） |
| [src/main/mcp/serverManager.js](../src/main/mcp/serverManager.js) | 父侧子进程生命周期管理：lazy fork、SDK Client 连接、`pendingByServerId` ↔ `pendingByToolUseId` 双键 confirmation 映射、子进程退出时 reject 在飞 confirmation、暴露与 `mcp/client.js` 一致的接口 |
| [src/main/mcp/mcpClientStdio.js](../src/main/mcp/mcpClientStdio.js) | 薄适配层；`MANA_USE_STDIO_MCP=0/false/no/off` 时 fallback 到原 in-process `client.js`；导出 `_backend` 字段便于诊断 |
| [mcp-server-entry.js](../mcp-server-entry.js) | 仓库根入口；解析 `--user-data-root / --main-port / --run-id / --novel-id / --novel-dir` 后再 require server.js；asar-unpack 后由 Phase 7 外部 driver 通过 `--mcp-config` spawn |

#### 修改文件

| 文件 | 改动 |
|---|---|
| [src/main/store/paths.js](../src/main/store/paths.js) | `require('electron').app` 改为惰性解析 + `MANA_USER_DATA_ROOT` env var fallback，让 ELECTRON_RUN_AS_NODE 子进程也能用 paths()；解析失败时 throw 显式错误 |
| [src/main/runtime/drivers/directApi.js](../src/main/runtime/drivers/directApi.js) | `require('../../mcp/client')` → `require('../../mcp/mcpClientStdio')`；header 注释更新为 Phase 6 描述 |
| [src/main/ipc/runtime.js](../src/main/ipc/runtime.js) | `mcp/client` 引用切换到 `mcpClientStdio`；UI 触发的 `resolveToolConfirmation` / `listPendingConfirmations` 透传到 serverManager |
| [src/main/ipc/novel.js](../src/main/ipc/novel.js) | 同上切换；`setActiveNovel/getActiveNovel` 通过适配层走 |
| [src/main/ipc/mcp.js](../src/main/ipc/mcp.js) | 同上切换；`mana:mcp:listTools` / `mana:mcp:callTool` 通过适配层走 |
| [src/main/index.js](../src/main/index.js) | 同上切换；冷启动 `mcpClient.setActiveNovel(cfg.lastNovelId)` 通过适配层 |
| [package.json](../package.json) | `build.files` 加 `mcp-server-entry.js`；`build.asarUnpack` 加 `mcp-server-entry.js` / `src/main/mcp/**` / `src/main/store/**`，让外部 driver 也能 spawn 入口 |

#### 关键设计选择

- **保留 in-process client.js** —— 通过 `MANA_USE_STDIO_MCP=0` 环境变量回滚（生产默认 stdio；用户在线问题时一键回退）。`mcp/client.js` 不删
- **MCP `_meta` 字段做 ID 透传** —— `mana_runId / mana_subagentId / mana_nodeId / mana_toolUseId` 通过 `client.callTool({ ..., _meta })` 走标准协议，server 端从 `request.params._meta` 取出后再做 confirmation IPC，避免修改 SDK
- **双键 confirmation 映射** —— server 端用自增 `cf-${pid}-${seq}-${ts}` ID；UI 端用 `${runId}:${toolUseId}` key。父侧 serverManager 用两个 Map 做双向查找，IPC 用 server-side ID，事件用 UI-side key
- **lazy spawn + 自愈** —— `ensureServer()` 用 Promise dedup 防并发竞争；子进程 `exit` 事件清空 `child / client / starting`，下次 `listTools/callTool` 自动重 fork

#### 验证结果

三组 standalone smoke-test 全部通过（不依赖 Electron 启动）：

1. **基础 round-trip**（[/tmp/mana-mcp-smoke.js](/tmp/mana-mcp-smoke.js)）—— 启动 child、`listTools` 返回 20 个工具、`setActiveNovel` IPC 投递、`list_characters` 返回空数组、未知工具回 `isError=true`、`dispose` 清理
2. **Confirmation 跨进程往返**（[/tmp/mana-mcp-confirm-smoke.js](/tmp/mana-mcp-confirm-smoke.js)）—— `create_character` 触发 `awaiting_confirmation` 事件 → `resolveConfirmation({accept:true})` → 角色文件落盘；第二次 `resolveConfirmation({accept:false, reason:...})` → 工具返回 `User rejected tool call: create_character (...)` 且文件未写入
3. **SIGKILL 自愈**（[/tmp/mana-mcp-crash-smoke.js](/tmp/mana-mcp-crash-smoke.js)）—— 第一次 `listTools` 后 `kill -9 <pid>`，第二次 `listTools` 自动重 fork 并返回相同 20 个工具

`MANA_USE_STDIO_MCP=0` 回滚路径单独验证：`mcpClientStdio` 报告 `_backend='in-process'` 且 `listTools()` 返回与 stdio 路径相同的 20 个工具。

`node --check` 通过 11 个 Phase 6 修改/新建文件（paths.js / server.js / forkChildTransport.js / serverManager.js / mcpClientStdio.js / mcp-server-entry.js / directApi.js / ipc/runtime.js / ipc/novel.js / ipc/mcp.js / index.js）。

**待手动验证**：在 Electron 内 `npm run start` 跑 `dag-quality-outline`，确认 UI 看到的 tool_use / tool_result / awaiting_confirmation 事件流与 Phase 5 一致；`ps aux | grep mcp-server-entry` 看到 fork 出的子进程；`update_character` 弹窗在跨进程下仍正常。

---

### 战略方向：AI IDE 优先（进行中）

**时间：2026-05-07**

#### 方向确认

用户明确产品定位：**AI IDE（Claude Code）决策优先，App 提供基础设施与流程指引**。

- `claude-code-vscode/cli` 为主路径：Claude Code 自主编排，App 提供 MCP 工具 + DAG/Subagent 指引
- `direct-api` 降级为替补路径：在无 Claude Code 环境时独立运行
- 搜索策略、写作指南等业务规则以 skill.md 形式沉淀，独立演进

#### 已完成

- [x] `knowledge-base/goals.md` 重写——三层目标结构 + 核心定位句
- [x] `knowledge-base/system-overview.md` 更新——主/替补路径架构描述
- [x] `src/main/store/skills/character-search.md` 新建——搜索策略 skill 文档
- [x] `src/main/store/skills/skill.md` 新建——主 skill 文档（写作策略 + skill 引用指引）
- [x] `src/main/seeds/builtinSubagents.js` 新增 `sa-import-orchestrator`
- [x] `src/main/import/analyzer.js` 添加 direct-api-only 注释

#### 待验证

- [ ] `sa-import-orchestrator` 渲染为 `.claude/agents/*.md` 格式正确
- [ ] `read_skill` MCP 工具能读取 `character-search.md`
- [ ] Claude Code driver 可自主完成导入全流程（需真 Claude Code 环境手动验证）

### 2026-05-02 — 第二次方向转向 + Phase 5 完成

#### 方向转向（背景）

用户明确真实意图："此 app = Claude Code CLI 的 GUI + MCP 集成体——由 app 提供工作流（DAG）+ subagent 描述 + MCP 工具集作为 spec，由 Claude Code（外部 driver）拿着 spec 自主决定怎么调度。Spec 与 driver 解耦。"

- 第一次转向（2026-05-01）落地的"自研 provider-agnostic runtime"已完成 Phase 0–4 代码，**保留作为 fallback 不删**
- 在 spec 层之上引入 **AgentRuntimeDriver 抽象层**：spec 不动，runtime 可插拔
- Driver 优先级（用户钦定）：1. claude-code-vscode；2. claude-code-cli；3. codex；4. direct-api（保底）
- 完整方案沉淀至 [/Users/potablewater/.claude/plans/spicy-napping-book.md](/Users/potablewater/.claude/plans/spicy-napping-book.md)
- 新增项目记忆 [project_direction_shift_2.md](../../../.claude/projects/-Users-potablewater-Desktop-MultiAgentNovelAssistant/memory/project_direction_shift_2.md)

#### Phase 5 实施落地

**新建文件**

| 文件 | 说明 |
|---|---|
| [src/main/runtime/drivers/driver.d.js](../src/main/runtime/drivers/driver.d.js) | JSDoc 接口契约：DriverCapabilities / AgentEvent / WorkflowRunSpec / DriverHandle / AgentRuntimeDriver |
| [src/main/runtime/drivers/registry.js](../src/main/runtime/drivers/registry.js) | 注册 / list / 切换 active；切换时 emit `runtime:changed` 事件到渲染器 |
| [src/main/runtime/drivers/directApi.js](../src/main/runtime/drivers/directApi.js) | 包装现有 runSubagent + runPipeline，作为永远可用的 fallback |
| [src/main/runtime/drivers/claudeCodeVscode.js](../src/main/runtime/drivers/claudeCodeVscode.js) | Phase 7 占位 stub（capabilities 真实，availability 报 unavailable） |
| [src/main/runtime/drivers/claudeCodeCli.js](../src/main/runtime/drivers/claudeCodeCli.js) | Phase 8 占位 stub |
| [src/main/runtime/drivers/codex.js](../src/main/runtime/drivers/codex.js) | Phase 9 占位 stub（supportsSubagents=false） |
| [src/main/runtime/workflowOrchestrator.js](../src/main/runtime/workflowOrchestrator.js) | 顶层 IPC 入口；选 driver、调 prepare/run/cancel；track active handles |
| [src/components/RuntimeDriverSettings.jsx](../src/components/RuntimeDriverSettings.jsx) | 设置面板：driver 列表 + active 单选 + binPath 输入 + Test connection |
| [src/components/RuntimeStatusIndicator.jsx](../src/components/RuntimeStatusIndicator.jsx) | 状态栏 chip：当前 driver 名 + 可用性圆点 |

**修改文件**

| 文件 | 改动 |
|---|---|
| [src/main/store/appConfig.js](../src/main/store/appConfig.js) | 加 `activeDriverId='direct-api'` + `drivers` defaults；引入 deep-merge 防止部分 patch 丢失兄弟 driver 配置 |
| [src/main/ipc/runtime.js](../src/main/ipc/runtime.js) | 现有 `runSubagent/runPipeline/cancel/cancelPipeline/resumePipeline` 全部路由到 orchestrator；新增 5 个 channel：`listDrivers / getActiveDriver / setActiveDriver / getDriverCapabilities / driverAvailability` |
| [src/main/index.js](../src/main/index.js) | bootstrap orchestrator（注册 4 个 driver）+ attachWindow 时把 webContents 传给 registry 以便发 `runtime:changed` |
| [preload.js](../preload.js) | 暴露 `mana.runtime.{listDrivers,getActiveDriver,setActiveDriver,getDriverCapabilities,driverAvailability}` + `on()` 接受 `runtime:changed` 频道 |
| [src/components/AppSettingsPanel.jsx](../src/components/AppSettingsPanel.jsx) | 在语言之后插入 runtime accordion |
| [src/App.jsx](../src/App.jsx) | 状态栏 `<WorkspaceSwitcher/>` 旁挂 `<RuntimeStatusIndicator/>` |
| [src/i18n/messages.js](../src/i18n/messages.js) | 加 `runtime.*` 全套 key（zh-CN + en-US；其他语言走 fallback） |

**Phase 5 验证结果**

- `node --check` 全部 8 个主进程文件通过（driver.d.js / registry.js / directApi.js / workflowOrchestrator.js / appConfig.js / ipc/runtime.js / index.js / preload.js）
- esbuild 编译 4 个 JSX 文件全绿（App.jsx 30.4kb / RuntimeDriverSettings 7.4kb / AppSettingsPanel 5.7kb / RuntimeStatusIndicator 2.0kb）
- 冷启动 `orchestrator.bootstrap()` + `listDrivers()` 实际输出符合预期：
  ```
  claude-code-vscode | unavailable | autonomous
  claude-code-cli    | unavailable | autonomous
  codex              | unavailable | autonomous
  direct-api         | AVAILABLE   | spec
  ```
- 4 个 driver 在 UI 中按用户钦定优先级展示，3 个 unavailable，1 个 AVAILABLE
- direct-api 默认 active，向后兼容（现有 dag-quality-* 行为不变）

**待手动验证**：在 Electron 内 `npm run start`，进 Settings → Runtime Driver 看 UI；跑一遍 `dag-quality-outline` 确认 direct-api 行为未回归。

### 2026-05-01 — 第一次方向转向 + Phase 0–4 全部完成

#### 第一次方向转向

经多轮讨论确定项目方向：从固定 6-agent 转向 Provider-agnostic 多 Agent + DAG + 一小说一目录。
（Phase 0–4 代码作为 direct-api driver 的实现保留，参见 2026-05-02 第二次转向。）

#### Phase 0：HeroUI v3 渲染崩溃修复

- 诊断 HeroUI v3 把原 `@heroui/theme` 包合并入 `@heroui/styles`
- [tailwind.config.js](../tailwind.config.js) 移除 `@heroui/theme` 插件与 content path
- [src/index.css](../src/index.css) 顶部加 `@import "@heroui/styles"`
- `npx vite build` 通过；dev 端口 5173 正常起服

#### Phase 1：Spec 层 + 持久化

- [src/main/store/appConfig.js](../src/main/store/appConfig.js)（schemaVersion / activePresetId / language / recents / lastNovelId / lastNovelDir）
- [src/main/store/presets.js](../src/main/store/presets.js)（PresetSpec：3 个 tier 槽 opus/sonnet/haiku，type 三选 anthropic / openai-compat / claude-cli）
- [src/main/store/subagents.js](../src/main/store/subagents.js)（SubagentSpec CRUD + builtIn 锁）
- [src/main/store/dags.js](../src/main/store/dags.js)（DagSpec CRUD + builtIn 锁 + clone）
- [src/main/store/novel.js](../src/main/store/novel.js)（一小说一目录：`<novelDir>/.mana/{characters,assets,timeline,outline,chapters,style-memory,skills,index}/`）
- Seed 数据：3 个内置 preset、8 个内置 subagent（sa-outline-drafter / sa-character-reviewer / sa-timeline-guardian / sa-style-checker / sa-prose-quality / sa-writer / sa-lore-updater / sa-config-helper）、4 个内置 DAG（dag-quality-outline / dag-quality-writing / dag-cheap-outline / dag-cheap-writing）

#### Phase 2：MCP 工具层（in-process）

- [src/main/mcp/tools.js](../src/main/mcp/tools.js)：17 个工具
  - 只读 13 个：list_characters / read_character / list_assets / read_asset / query_timeline / check_timeline_feasibility / query_world / read_outline / read_chapter / read_style_memory / read_skill / search_index
  - 写自动 4 个：grant_asset / revoke_asset / append_timeline / append_summary / append_style_memory
  - 写需确认 3 个：create_character / update_character / update_world
- [src/main/mcp/feasibility.js](../src/main/mcp/feasibility.js)：时间线检查启发式
- [src/main/mcp/client.js](../src/main/mcp/client.js)：in-process 工具调用 facade，pendingConfirmations Map keyed by `${runId}:${toolUseId}`
- ✅ Phase 6 已把 client.js 替换为 stdio MCP server 子进程；`tools.js` 文件原样复用；`client.js` 保留作为 `MANA_USE_STDIO_MCP=0` 回滚路径

#### Phase 3：Runtime + Provider 层

- [src/main/runtime/eventBus.js](../src/main/runtime/eventBus.js)：emit / subscribe / 写 JSONL 到 `<userData>/logs/<runId>.jsonl`；通道 `agent:event` + `pipeline:event`
- [src/main/runtime/providers/anthropic.js](../src/main/runtime/providers/anthropic.js)：直连 Anthropic API
- [src/main/runtime/providers/openaiCompat.js](../src/main/runtime/providers/openaiCompat.js)：OpenAI 兼容（DeepSeek 等）
- ⚠️ [src/main/runtime/providers/claudeCli.js](../src/main/runtime/providers/claudeCli.js)：**Phase 4 残留桩**，仅 `claude --print` 文本桩，无 stream-json / 无 MCP / 无工具循环。**Phase 7/8 删除**，被新 driver 取代
- [src/main/runtime/runSubagent.js](../src/main/runtime/runSubagent.js)：单 subagent 执行循环，工具调用桥接 `mcpClient`，bounded by `runtimeHints.maxTurns`
- [src/main/runtime/runPipeline.js](../src/main/runtime/runPipeline.js)：DAG 执行器（worklist + AbortController + pendingHuman + maxRevisions 上限）

#### Phase 4：UI 层

- [src/components/PresetEditor.jsx](../src/components/PresetEditor.jsx)：Preset CRUD（active 单选 + tier slot）
- [src/components/SubagentEditor.jsx](../src/components/SubagentEditor.jsx)：Subagent CRUD（builtIn 只读、克隆、tier、systemPrompt、allowedTools 三档勾选、maxTurns）
- [src/components/DagEditor.jsx](../src/components/DagEditor.jsx)：基于 `@xyflow/react@12` 的图形化 DAG 编辑器
- [src/components/PipelineRunnerPanel.jsx](../src/components/PipelineRunnerPanel.jsx)：选 DAG → 输入 → Run → 实时事件流 + 工具确认弹窗 + cancel + human-resume
- [src/components/AppSettingsPanel.jsx](../src/components/AppSettingsPanel.jsx)：accordion（preset / subagent / dag / language；Phase 5 加了 runtime）
- [src/i18n/messages.js](../src/i18n/messages.js) + [src/i18n/LanguageContext.jsx](../src/i18n/LanguageContext.jsx)：zh-CN（全量）+ en-US（全量）+ ja-JP/ko-KR/de-DE/ru-RU（部分 fallback）

### 2026-03-29 — 知识库初始化

- 新增 `knowledge-base/` 目录与核心文档结构
- 建立短中长期目标、系统说明、对话沉淀、交接清单
- 新增文风记忆超长处理机制：超阈值时强制询问用户策略（压缩摘要 / 拆章 / 调高阈值 / 继续扩张）

## 当前阻塞 / 风险

### Phase 6+ 待识别风险

- **VSCode 扩展 binPath 不稳定**：Anthropic 改 extension 目录结构会破坏 auto-detect。Mitigation：fast-glob 多候选 + 用户手动覆盖 + 失败给清晰错误（Phase 7 实施时建立）
- **stream-json `result` 事件丢失**（[claude-code#1920](https://github.com/anthropics/claude-code/issues/1920)）：某些版本最终 `result` 不发。Mitigation：以 stdout EOF + exit code 作为兜底信号 emit `done`
- **Sub-agent 实时可见性受限**（[claude-code#1770](https://github.com/anthropics/claude-code/issues/1770)）：parent stream 只有 `parent_tool_use_id` tag，详细 transcript 在 sidechain JSONL。Phase 7 ship 简化版（仅 parent 视角）；后续可加 sidechain 文件 tail
- **跨进程 confirmation 延迟**：MCP server 子进程 → 主进程 → 渲染器 → 主进程 → MCP server。Mitigation：UI 明显 "Awaiting your decision" 状态；超时（默认 5min）自动 reject
- **外部 driver 用的 MCP server 与主进程的 confirmation 桥接**：外部 driver（vscode/cli）用 `--mcp-config` 让 Claude Code 自己 fork MCP server，那个子进程没有父进程 IPC channel。需在 `mcp-server-entry.js` 启动时通过环境变量 `MANA_MAIN_PORT` 拿到主进程 socket 地址，建 TCP/Unix-domain socket 回连
- **Codex flag 不确定**：Phase 9 实施时再查；如其 stream-json/MCP 支持不完整，driver 退化为基础文本模式
- **多 driver 并发切换**：用户切 driver 时若有 run 在跑需取消重置。`runtime:changed` 事件 + UI confirm 对话框防误切

### 早期遗留

- safeStorage 在 Linux 无 keyring 时退化为明文，Phase 1 已在 PresetEditor 加 keyringWarning，但需要更醒目
- DAG 长跑 cancel/resume + human-node 持久化需要 Phase 6 后单独压力测试

## 2026-05-06 — 导入流程二创检测与角色批量标记系统

### 目标
解决导入时角色联网补全被静默跳过的问题。在导入流程中显式询问二创信息，允许用户批量标记角色，让联网补全在导入阶段就准确完成。

### 新建/修改文件

| 文件 | 改动 |
|---|---|
| [src/components/ImportNovelPanel.jsx](../src/components/ImportNovelPanel.jsx) | 新增 `fanwork-check` 和 `character-review` 步骤；状态机改造；批量标记 UI |
| [src/main/ipc/import.js](../src/main/ipc/import.js) | 新增 `getStagingCharacters` / `saveStagingCharacters` / `enrichStagingCharacters` handler |

## 2026-05-15 — 用户快速反馈功能设计沉淀

### 输出

- 新增 [quick-feedback-design.md](../knowledge-base/quick-feedback-design.md)

### 设计结论

- 快速反馈应采用“一键触发 + 自动采集现场快照 + 用户补最少描述”的交互模式
- 反馈包必须覆盖项目、章节、线程、选区、最近 prompt、最近工具调用、最近检查点、最近变更摘要与错误片段
- 默认不上传整本正文或全量聊天历史，改为局部 excerpt、截断日志与可选附件
- 发送链路建议采用“本地 feedback-outbox 持久化 + 异步发送 + 失败重试”
| [src/main/import/analyzer.js](../src/main/import/analyzer.js) | 删除 `finalizeAnalyses` 中的自动 enrichCharacters 调用；修改 `TASK_PROMPTS.world` 增加 `isFanwork` / `referencedWorks` |
| [src/main/import/stagingProject.js](../src/main/import/stagingProject.js) | 支持在 `novel.json` 中持久化 `fanwork` 元数据 |
| [preload.js](../preload.js) | 暴露 3 个新的 import IPC 方法 |
| [knowledge-base/character-enrichment-system.md](character-enrichment-system.md) | 新建系统架构文档 |

### 关键设计选择

- **AI 建议 + 用户确认**：`world` 任务输出 `isFanwork` / `referencedWorks` 作为 AI 初步检测结果，在 `fanwork-check` 步骤中预填为默认值，用户可修改或拒绝
- **导入阶段不再自动补全**：`finalizeAnalyses` 删除 `characterEnricher.enrichCharacters()` 调用，补全推迟到 `character-review` 步骤，由用户触发
- **按作品分组补全**：若用户声明多部引用作品，`enrichStagingCharacters` 将角色按 `sourceWork` 分组，每组独立调用补全引擎
- **isOriginal 用户声明原则**：AI 在角色提取 prompt 中**不输出** `isOriginal` 字段，该字段仅在 `character-review` 步骤由用户批量标记

### 验证结果

- `npx vite build` 通过
- `node --check` 通过所有修改的 `.js` 文件

### 待手动验证

1. 导入原创小说：选择"否" → 分析完成后直接进入 `analysis-done`，无联网请求
2. 导入二创小说：选择"是" → 填写作品名 → 分析完成后显示角色列表 → 标记二创 → 点击补全 → 验证日志显示萌娘百科搜索结果
3. 多部作品：填写两部作品 → 角色分别选择不同作品 → 验证按作品分组调用

---

## 下一步（按 plan 推进）

### 紧接：手动验证 Phase 7（需装 Claude Code VSCode 扩展或 CLI）

1. `npm run start` 启动 Electron
2. Settings → Runtime Driver → 找到 `claude-code-vscode` 行 → 点 "自动侦测" → 应看到绿色 "已侦测：~/.vscode/extensions/anthropic.claude-code-X.Y.Z/cli/claude"（或 .cursor / .vscode-insiders 路径）
3. 点 "测试连接" → 应看到状态变 AVAILABLE 且显示版本号 v1.X.Y
4. 选中 vscode driver → 跑 `dag-quality-outline`（输入"小王和小李奔现"之类）
5. 事件面板应出现：`sub_agent_start{subagentId='sa-outline-drafter'}` → `text` (drafting...) → `sub_agent_done` → 类似的 character-reviewer / timeline-guardian
6. ⚠️ 如果用到 update_character 等需确认工具会失败（外部 driver fork 的 MCP 子进程无 IPC，Phase 7 first-ship 已知限制；built-in DAG 全用只读 + append_* 不受影响）
7. 取消按钮：5s 内子进程被 SIGKILL

### 然后：Phase 8（claude-code-cli driver，⭐ 用户优先级 2）

- 复用 Phase 7 的全部 `shared/`；只换 `claudeCodeCli.js` 的 `availability()` 用 `which claude` / spawnSync `claude --version`
- 注册到 registry；`RuntimeDriverSettings` 自然生效（同一组按钮）
- 装了 CLI 没装 VSCode 扩展的机器，`claude-code-cli` 应 AVAILABLE 且行为与 vscode driver 一致

## 已完成的两轮转向决策（速查）

| 主题 | 决策 |
|---|---|
| Runtime 选型（一轮） | 方案 A：Provider-agnostic 自建 |
| Runtime 选型（二轮） | 抽象层 + Claude Code 系优先 + direct-api 保底 |
| Driver 优先级 | vscode → cli → codex → direct-api |
| Claude CLI 定位（一轮） | 与其他 provider 平级的第三种 type |
| Claude CLI 定位（二轮） | 升级为独立 driver，不再是 provider type |
| Preset 形态 | 3 个 tier 槽：opus 强逻辑 / sonnet 文笔 / haiku 便宜 |
| Subagent 自定义 | 完全 CRUD，保留 8 个内置（不可覆写） |
| per-subagent 模型 | Claude Code 系：agent.md `model:` frontmatter；direct-api：preset tier slot |
| Pipeline 编排 | DAG 拖拽（ReactFlow）+ 2×2 内置预设 |
| 协议 | 双协议（Anthropic + OpenAI-compat） |
| 项目存储 | 一小说一目录 |
| 多小说 | 支持 |
| 写权限 | 半自动（character/world 弹确认；asset/timeline/summary 直接落盘） |
| HeroUI 路径 | 修复现有依赖（已完成） |
| MCP server 形态 | Phase 6 已切真 stdio child_process.fork；in-process client.js 通过 `MANA_USE_STDIO_MCP=0` 保留为回滚路径 |


## 2026-05-04 — AI Chat 深度集成

### 目标
将独立的 AI 聊天窗口升级为支持工具调用、编辑器上下文感知、子代理委托的交互式写作助手。

### 新建文件

| 文件 | 说明 |
|---|---|
| src/main/runtime/chatAgent.js | Chat Agent 核心：内建多轮工具调用循环，支持 MCP 工具 + 前端操作工具 + spawn_subagent |
| src/main/ipc/chatAgent.js | IPC 层：createSession / sendMessage / cancel / resolveAction / closeSession / updateContext |

### 修改文件

| 文件 | 改动 |
|---|---|
| src/main/runtime/providers/anthropic.js | 支持 thinking blocks（thinking_delta 事件 + thinking body 参数） |
| src/main/index.js | 注册 registerChatAgentIpc() |
| preload.js | 新增 chatAgent bridge（createSession/sendMessage/cancel/resolveAction/closeSession/updateContext/onEvent） |
| src/App.jsx | 新增 editorSelection 状态（textarea onSelect），editorContext useMemo，replaceSelectedText/insertTextAtCursor 操作，传 props 给 AiChatPanel |
| src/components/AiChatPanel.jsx | 完全重构为事件驱动流式 UI：支持 text_delta、thinking_delta、tool_use、tool_result、frontend_action 事件；工具调用卡片；停止生成按钮；清空对话按钮 |

### 架构

- AI 聊天通过内建 agent loop 运行（direct-api provider），复用 anthropic.js/openaiCompat.js adapter
- 每轮自动注入编辑器上下文（打开文档、选中文本）到 system prompt
- 工具集 = 全部 MCP 工具（19 个）+ 前端操作工具（replace_selected_text / insert_text_at_cursor / get_full_editor_content）+ spawn_subagent
- 前端操作通过 IPC 事件暂停 agent loop → 前端执行 → resolveAction 恢复
- 子代理委托复用 runSubagent()，自动使用当前 active driver（可以是 Claude Code）
- Thinking 支持：anthropic.js 解析 thinking_delta 事件，AiChatPanel 显示可折叠思维链

### 待验证

1. 基础对话流式输出正常
2. 工具调用（如 list_characters）显示工具卡片并返回结果
3. 前端操作（替换选中文本）正常工作
4. spawn_subagent 委托子代理正常
5. thinking blocks 显示正常（需 Claude 3.7 Sonnet + thinking enabled alias）


### 2026-05-05 — 修复无小说时的 AI 聊天行为

**问题**: 未打开小说时，AI 反复调用 create_character（失败 3 次），最终 fetch failed。

**根因**: 
1. System prompt 未明确告知 AI"没有打开小说"
2. 所有 MCP 工具（包括需要小说的）都暴露给 AI
3. AI 看到工具失败后反复重试

**修复**:
1. MCP tools.js 新增 2 个工具:
   - create_novel: 创建新小说项目（不需要已打开小说）
   - list_novels: 列出所有小说（不需要已打开小说）
2. chatAgent.js system prompt: 当没有小说时明确声明"No novel is currently open"，并告诉 AI 可用的选项（create_novel / list_novels）
3. chatAgent.js 工具过滤: 没有小说时只暴露 read_skill、create_novel、list_novels + 前端操作工具
4. 新增规则: "If a tool fails, DO NOT retry the same tool."
