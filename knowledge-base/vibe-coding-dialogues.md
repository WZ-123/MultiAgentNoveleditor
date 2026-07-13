# Vibe Coding 对话沉淀

最后更新：2026-05-17

> 目的：记录开发期间的关键对话、决策与上下文，便于跨设备快速续接。

## 记录模板

### [日期 时间] 会话标题

- 背景：
- 用户目标：
- 关键讨论：
- 决策结论：
- 实施结果：
- 未完成事项：
- 下一步：
- 涉及文件：

---

## 已记录会话

### [2026-03-29] 增加长上下文记忆压缩决策流

- 背景：文风记忆会持续增长，可能导致上下文过长
- 用户目标：当记忆过长时必须询问用户如何处理，并提供四种策略选项
- 关键讨论：不能静默截断，必须由用户做明确决策
- 决策结论：超阈值触发交互式询问，支持压缩摘要、拆章存档、调高阈值、允许继续扩张
- 实施结果：已在 `styleMemoryStore` 落地阈值管理、归档存储与交互决策流程，保存入口已接入结果回写
- 未完成事项：待在可运行环境中做一次完整 UI 流程验证
- 下一步：修复依赖后验证四种策略在真实写作流程中的体验
- 涉及文件：`src/services/styleMemoryStore.js`、`src/hooks/useWorkflowState.js`、`knowledge-base/progress.md`

### [2026-03-29] 初始化项目知识库

- 背景：需要支持跨设备恢复开发上下文
- 用户目标：新增 Markdown 知识库，包含短中长期目标、系统说明、vibe coding 对话
- 关键讨论：知识库应可持续维护，并可直接用于“继续上次开发”
- 决策结论：建立 `knowledge-base/` 独立目录与标准模板
- 实施结果：已新增 6 个核心文档文件并完成初始化内容
- 未完成事项：后续会话需按模板持续追加
- 下一步：修复当前开发环境依赖问题后，继续功能迭代并同步记录
- 涉及文件：`knowledge-base/README.md`、`knowledge-base/goals.md`、`knowledge-base/system-overview.md`、`knowledge-base/progress.md`、`knowledge-base/vibe-coding-dialogues.md`、`knowledge-base/handover-checklist.md`

### [2026-05-17] GitHub Actions 多平台自动打包 + 自动更新器上线

- 背景：内测版本需要自动打包分发能力，此前仅支持本地手动 `npm run build`
- 用户目标：
  1. 打 Tag 自动触发 GitHub Actions 多平台打包
  2. 打包产物发布到 GitHub Releases
  3. 客户端启动时检测新版本，弹窗提示用户
  4. 弹窗提供"手动下载"和"自动下载"两种选项
  5. 无代码签名证书
- 关键讨论：
  - 不使用 `electron-updater`（需代码签名），改为直接调 GitHub Releases API
  - 弹窗用 `dialog.showMessageBox()` + checkbox 控制自动下载偏好
  - 自动下载后 macOS/Linux 提示手动运行，Windows 直接 `spawn` 安装程序
  - PAT token 需要 `contents:write` + `workflows:read/write` 权限才能推送 `.github/workflows/release.yml`
- 决策结论：
  - 版本检测走 `api.github.com/repos/.../releases/latest`，semver 比较
  - 产物映射：macOS→*.dmg / Windows→*.exe / Linux→*.AppImage
  - 配置存储在 `appConfig.updater`（skipVersion / autoDownload / lastCheckAt）
- 实施结果：
  - Workflow 文件 `.github/workflows/release.yml` 已推送
  - Tag `v0.0.1` 触发首次构建，三平台全部成功
  - Release 已发布：`https://github.com/WZ-123/MultiAgentNovelAssistant/releases/tag/v0.0.1`
  - 客户端代码：`src/main/updater/versionChecker.js` + `downloadManager.js` + `ipc/updater.js`
- 未完成事项：
  - 自动更新器在真实打包后的客户端中尚未实际验证（dev 模式 `app.isPackaged` 为 false，跳过检测）
  - 需要下载一个 Release 安装包实际运行，确认弹窗、下载、安装流程
- 下一步：
  - 下载 macOS dmg 安装并测试版本检测弹窗
  - 或修改 dev 模式临时强制启用检测逻辑做冒烟测试
- 涉及文件：`.github/workflows/release.yml`、`src/main/updater/versionChecker.js`、`src/main/updater/downloadManager.js`、`src/main/ipc/updater.js`、`src/main/store/appConfig.js`、`main.js`、`preload.js`、`knowledge-base/progress.md`

### [2026-05-17] 远程设备授权系统（Feishu Bitable + SCF）

- 背景：内测需要设备级授权，避免授权码无限扩散
- 用户目标：
  1. 无授权码或授权码过期 = 应用启动即阻断
  2. 支持多设备（最多 5 台）
  3. 授权码有效期管理
  4. 凭证不保存在客户端
- 关键讨论：
  - 从 Cloudflare Workers 迁移到腾讯云 SCF（GFW 阻断 `*.workers.dev`）
  - 设备标识符用 `os.hostname() + os.userInfo().username` 做 SHA256，Windows 兼容（`os.userInfo()` 可能抛异常）
  - Feishu Bitable filter v1 API 有兼容性问题，改为 `listBitableRecords` 全量获取后 JS 端过滤
  - Bitable 日期字段要求秒级时间戳，不能传毫秒或字符串
  - `app-config.json` 中的空字符串不应覆盖预置默认值（用于 beta 构建预填 relay URL）
- 决策结论：
  - SCF Web Function 模式（HTTP Server），路由 `/api/v1/auth/verify`
  - 设备列表用逗号分隔的字符串存储在 Bitable Text 字段中（max 5）
  - dev 模式（`!app.isPackaged`）跳过验证，方便开发
  - 客户端唯一持有 `relayUrl` + `relayApiKey`，飞书凭证隔离在 SCF 环境变量
- 实施结果：
  - SCF 函数已部署：`https://1301861337-iyb2r0f8lz.ap-guangzhou.tencentscf.com`
  - 客户端 `src/main/license/authVerifier.js` 已实现
  - `main.js` 启动流程已插入 `verifyLicense()` 调用
  - 授权码已在 Feishu Bitable 中配置多条测试记录
- 未完成事项：
  - 真实打包客户端中未验证授权拦截流程
  - 设备数量达到上限时的 UX（当前仅返回 `valid:false`，无"注销其他设备"选项）
- 下一步：
  - 打包测试版验证授权流程
  - 如需支持"踢出旧设备"，在 SCF 端增加注销接口 + 客户端 UI
- 涉及文件：`relay-worker/scf-app-final.js`、`src/main/license/authVerifier.js`、`src/main/store/appConfig.js`、`main.js`

### [2026-07-13] 去 AI 味只增加文风基线与最小必要修改

- 背景：并行分片审查和上下文改写已具备，继续增加复杂判定机制可能带来新的误报、漏报。
- 用户目标：只做两项——审查/改写参考作品文风与人物声音；严格避免过度润色。
- 决策结论：
  1. 文风记忆、POV、场景线索、人物说话习惯/代表台词、当前保留段落和本章对白只作为软基线，不压过明确机械套话。
  2. 改写采用最小必要修改；禁止凭空增加动作、对白、景物、感官、心理、比喻或情绪解释，保留粗粝、跳跃、短句、停顿和不规则节奏。
  3. 不增加新的复杂 AI 味分类器；仅用高确定性漂移检查拦截无端扩写、装饰性新增和未经授权的段落压平，失败时重试一次，仍失败则保留原文。
- 实施结果：MCP、聊天选区和编辑器右键入口均接入；真实 Electron 流程与真实 Provider 调用通过。
- 涉及文件：`src/main/mcp/tools.js`、`src/main/runtime/chatAgent.js`、`src/main/seeds/builtinSubagents.js`、`src/services/deAiMinimality.mjs`、`src/App.jsx`
