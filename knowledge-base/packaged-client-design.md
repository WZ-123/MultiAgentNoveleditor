# 打包客户端设计

## 概述

打包客户端（Packaged Client）是面向最终用户的 Electron 发行版，通过 GitHub Actions 自动构建并发布。与开发版本相比，打包客户端具有以下核心差异：

- **Relay-only 架构**：不持有飞书凭证，所有反馈和授权校验经腾讯云 SCF 中继完成
- **预置 Relay 配置**：打包时通过 `build-release.js` 将 `relayUrl` + `relayApiKey` 注入 `DEFAULT_APP_CONFIG`
- **授权码认证**：首次启动需输入授权码，经 Relay 验证后绑定设备，支持离线缓存
- **一键反馈**：内置反馈入口，截图/日志经 Relay 上传至飞书多维表格

---

## 客户端功能

### 1. 基于 Relay 的授权码认证

**流程**：

1. 首次启动时，`verifyLicense({ silent: true })` 检测到无 `authCode`，调用 `showAuthDialog()` 弹出授权验证窗口
2. 用户输入授权码后，客户端通过 `relayUrl/api/v1/auth/verify` 向 SCF 发送验证请求（携带 `deviceId` + `code`）
3. SCF 查询飞书授权码表，校验码的有效性、过期时间和设备绑定数量（上限 5 台）
4. 验证通过后，客户端本地缓存 `verifiedUntil`（7 天有效期）和 `deviceId`
5. 后续启动时优先检查本地缓存，在缓存期内无需联网即可通过验证；缓存过期后自动后台联网续期

**关键文件**：

- `src/main/license/authVerifier.js` — 授权验证核心逻辑
- `src/main/license/authDialog.js` — 授权码输入对话框（BrowserWindow）
- `relay-worker/scf-app-final.js` — SCF 端的 `handleAuthVerify` 路由

**设备标识**：

```js
// SHA-256(hostname + username + seed) 的前 32 位
const deviceId = sha256(`${seed}:${os.hostname()}:${os.userInfo().username}`).slice(0, 32)
```

Windows 下非 ASCII 用户名时回退到 `process.env.USERNAME`。

---

### 2. 一键反馈功能

**流程**：

1. 用户通过菜单或快捷键触发反馈，弹出反馈对话框
2. 用户填写反馈内容，可选择上传截图
3. 客户端通过 `relayClient.js` 将数据发送至 `relayUrl/api/v1/feedback/submit`
4. 如有附件，先调用 `relayUrl/api/v1/feedback/upload` 上传至飞书 Drive 获取 `file_token`
5. SCF 将反馈内容和附件写入飞书多维表格

**关键文件**：

- `src/main/sync/relayClient.js` — Relay HTTP 客户端（multipart 上传 + JSON submit）
- `src/main/sync/feedbackSyncWorker.js` — 反馈同步调度器
- `relay-worker/scf-app-final.js` — SCF 端的 `handleSubmit` 和 `handleUpload` 路由

**安全设计**：

- 客户端只持有 `relayUrl` + `relayApiKey`，不持有飞书 `appId/appSecret/appToken/tableId`
- 飞书凭证仅存于腾讯云 SCF 环境变量中
- 所有请求需携带 Header `X-Relay-Api-Key`

---

## 打包流程

### GitHub Actions Workflow

文件：`.github/workflows/release.yml`

**触发条件**：

- `push` 以 `v*` 开头的 tag（如 `v0.0.7`）
- 手动触发 `workflow_dispatch`

**构建矩阵**：

| OS | Platform | 输出格式 |
|---|---|---|
| macos-latest | mac | `.dmg` |
| windows-latest | win | `.exe` (NSIS) |
| ubuntu-latest | linux | `.AppImage` |

**Secrets 依赖**：

| Secret | 用途 |
|---|---|
| `RELEASE_RELAY_URL` | SCF 服务地址，如 `https://xxx.ap-guangzhou.tencentscf.com` |
| `RELEASE_RELAY_API_KEY` | Relay API 密钥，用于客户端请求鉴权 |

**Workflow 步骤**：

1. `actions/checkout@v4` — 检出代码
2. `actions/setup-node@v4` — 安装 Node.js 18
3. `npm ci` — 安装依赖
4. `npm run build:{platform} -- --publish=never` — 构建 Electron 应用
   - 注入 `RELEASE_RELAY_URL` 和 `RELEASE_RELAY_API_KEY` 环境变量
5. `actions/upload-artifact@v4` — 上传构建产物
6. `softprops/action-gh-release@v1` — 创建 GitHub Release 并附加产物

### build-release.js 注入逻辑

文件：`scripts/build-release.js`

**运行时行为**：

1. 读取环境变量 `RELEASE_RELAY_URL` / `RELEASE_RELAY_API_KEY`（兼容旧版 `BETA_*`）
2. 临时修改 `src/main/store/appConfig.js`：
   - 将 `feishuSync.enabled` 设为 `true`
   - 注入 `relayUrl` 和 `relayApiKey`
3. 运行 `vite build` 编译前端
4. 运行 `electron-builder --{platform} --publish=never` 打包
5. **恢复**原始 `appConfig.js`（`finally` 块保证）

**关键修复**：`npm exec -- electron-builder` 必须使用 `--` 分隔符，否则 `--publish=never` 会被 npm 吃掉，导致 electron-builder 因检测到 tag 而尝试自动发版，报错 `GH_TOKEN` 缺失。

### 版本号管理

- `package.json` 的 `version` 字段为源版本号
- Git tag（如 `v0.0.7`）决定 GitHub Release 版本
- `build-release.js` 和 `electron-builder` 均读取 `package.json` 中的版本号

---

## 开发与打包的数据隔离

为避免开发版本和打包版本共享用户数据导致授权状态混乱：

- **开发模式**：`app.setName('MultiAgentNovelAssistant-dev')`，数据目录为 `AppData/Roaming/MultiAgentNovelAssistant-dev`
- **打包模式**：`app.setName('MultiAgentNovelAssistant')`，数据目录为 `AppData/Roaming/MultiAgentNovelAssistant`

判断逻辑：`process.env.NODE_ENV !== 'production' && !app.isPackaged`

---

## 发布检查清单

1. 确认 `package.json` 版本号已更新
2. 确认 `.github/workflows/release.yml` 中 Secrets 已配置
3. 本地运行 `npm run build:mac` / `build:win` / `build:linux` 验证无报错
4. 打 tag：`git tag -a vX.Y.Z -m "release: vX.Y.Z"`
5. 推送 tag：`git push origin vX.Y.Z`
6. 观察 GitHub Actions 状态：https://github.com/WZ-123/MultiAgentNovelAssistant/actions
7. 下载各平台 artifact 验证授权码和反馈功能

---

## 相关文件

| 文件 | 职责 |
|---|---|
| `.github/workflows/release.yml` | GitHub Actions 打包工作流 |
| `scripts/build-release.js` | 构建脚本：注入 relay 配置并调用 electron-builder |
| `scripts/setup-github-secrets.js` | 辅助脚本：自动设置 GitHub Secrets |
| `scripts/watch-actions.js` | 辅助脚本：监控 Actions 运行状态并抓取失败日志 |
| `src/main/license/authVerifier.js` | 授权验证逻辑 |
| `src/main/license/authDialog.js` | 授权码输入对话框 |
| `src/main/sync/relayClient.js` | Relay HTTP 客户端 |
| `relay-worker/scf-app-final.js` | 腾讯云 SCF 服务入口 |
| `relay-worker/.dev.vars` | 本地开发时的 SCF 环境变量 |

---

## 历史修复记录

- **2026-05-24**: 修复 `npm exec` 缺少 `--` 分隔符导致 `--publish=never` 失效、打包报错 `GH_TOKEN` 的问题
- **2026-05-24**: 修复 Windows 上 `authDialog` 可能因 `ready-to-show` 事件未触发而不显示的问题（增加 500ms 兜底超时）
- **2026-05-24**: 开发模式与打包模式使用独立的数据目录，防止授权缓存互相污染
