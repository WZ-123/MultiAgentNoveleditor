# 用户快速反馈功能设计

最后更新：2026-05-15

## 目标

为用户提供一个低摩擦的“快速反馈”入口：点击一次即可把当前遇到的问题和足够的复现上下文打包发送。设计目标不是收集泛泛而谈的意见，而是让开发者在最短路径内复现问题、判断影响范围、定位到实际控制行为的代码路径。

该功能优先覆盖 AI 聊天相关问题，包括：

- AI 改错位置、改写范围异常
- 聊天线程显示/归属/切项目异常
- 工具调用卡片、已更改内容、还原检查点异常
- 聊天 UI 显示错乱、错误提示不一致
- 实际磁盘内容与 UI 显示不一致

## 非目标

- 不默认上传整本小说、全部聊天历史或全量日志
- 不要求用户手动整理复杂排查信息
- 不让用户在反馈时理解内部架构或技术术语

## 设计原则

1. 一键优先：用户点击入口后，系统先自动采集，再让用户补最少字段。
2. 证据优先：优先收集真实数据与现场状态，而不是泛化摘要。
3. 最小泄露：只上传与当前问题强相关的上下文，默认做截断和脱敏。
4. 可离线：即使发送失败，也应本地落盘，后续重试。
5. 可直接复现：反馈包应能支撑“打开同一线程/项目/章节并重放关键步骤”。

## 用户流程

### 入口位置

建议提供 4 个入口：

1. AI 聊天面板右上角：通用“反馈问题”按钮
2. 错误条：报错时在错误提示旁显示“反馈此问题”
3. 工具卡片：已更改内容 / 还原检查点 / 工具失败卡片旁显示“反馈”
4. 全局帮助菜单：兜底入口

### 交互流程

1. 用户点击“反馈问题”
2. 弹出快速反馈面板，系统先自动抓取当前上下文
3. 用户只填写最少字段
4. 用户点击“发送”
5. 应用生成 feedbackId，写入本地反馈箱，并尝试发送到目标端点
6. 若发送失败，保留本地待发送状态

### 面板字段

必须填写：

- 问题标题
- 发生了什么

建议填写：

- 我期望发生什么
- 最短复现步骤
- 是否稳定复现
- 严重程度

默认展开的只应是简短表单和“将附带当前现场信息”的提示。完整 payload 预览应默认折叠，避免吓到普通用户。

## 反馈包结构

反馈包建议采用单个 JSON 对象，便于本地持久化、离线重发和服务端处理。

```json
{
  "feedbackId": "fb-20260515-abc123",
  "createdAt": "2026-05-15T12:34:56.000Z",
  "channel": "quick-feedback",
  "userInput": {
    "issueTitle": "AI 把第二处铜钱改错了",
    "actualBehavior": "我让它改第二处，但它改了第一处",
    "expectedBehavior": "只修改我当前选中或光标附近的那一句",
    "reproductionSteps": [
      "打开项目 A 的第一章",
      "选中包含“铜钱”的句子",
      "在 AI 聊天里发送润色请求"
    ],
    "reproducibility": "always",
    "severity": "high"
  },
  "environment": {},
  "novelContext": {},
  "editorContext": {},
  "chatContext": {},
  "changeContext": {},
  "uiState": {},
  "errors": {},
  "attachments": []
}
```

## 必须包含的字段

### 1. 用户输入

| 字段 | 必须 | 作用 |
|---|---|---|
| issueTitle | 是 | 让问题可被快速分类和检索 |
| actualBehavior | 是 | 记录真实异常现象 |
| expectedBehavior | 否 | 判断是 bug、设计缺口还是误用 |
| reproductionSteps | 否 | 快速构造最短复现链 |
| reproducibility | 否 | 区分稳定缺陷与竞态/偶发问题 |
| severity | 否 | 判断优先级和止损需求 |

推荐枚举：

- reproducibility: always / often / sometimes / once / unknown
- severity: low / medium / high / critical

### 2. 环境信息

| 字段 | 必须 | 作用 |
|---|---|---|
| appVersion | 是 | 排查版本相关回归 |
| platform | 是 | 区分 macOS / Windows / Linux 差异 |
| locale | 否 | 判断语言环境影响 |
| isOnline | 是 | 区分联网失败与功能缺陷 |
| activeRuntimeDriver | 是 | 区分 direct-api / claude-code 路径 |
| activeProviderType | 是 | 区分 anthropic / openai-compat 路径 |
| activeModel | 否 | 判断模型特异性问题 |

### 3. 项目上下文

| 字段 | 必须 | 作用 |
|---|---|---|
| activeNovelId | 是 | 明确问题发生在哪个项目 |
| activeNovelTitle | 否 | 便于人工辨识 |
| isBlankProject | 是 | 空白项目链路单独判断 |

### 4. 编辑器上下文

| 字段 | 必须 | 作用 |
|---|---|---|
| editorType | 是 | 区分 chapter / blueprint / settings / none |
| activeChapterName | 条件必填 | 精确定位章节文件 |
| activeChapterTitle | 否 | 人类可读 |
| selectionText | 强烈建议 | 定位 replace_selected_text 相关问题 |
| selectionStart | 强烈建议 | 复现选区与光标位置 |
| selectionEnd | 强烈建议 | 复现选区与光标位置 |
| editorDirty | 是 | 判断 UI 与磁盘不一致是否合理 |
| contentExcerpt | 强烈建议 | 默认仅上传选区附近片段，避免整章泄露 |

contentExcerpt 推荐为当前选区或最近变更点附近的前后各 300 到 800 字符，而非整章全文。

### 5. 聊天上下文

| 字段 | 必须 | 作用 |
|---|---|---|
| activeThreadId | 是 | 精确定位聊天线程 |
| activeThreadTitle | 否 | 人类可读 |
| threadNovelId | 是 | 判断线程归属与当前项目是否一致 |
| currentSessionStatus | 是 | idle / thinking / streaming / error |
| lastUserPrompt | 强烈建议 | 直接复现用户输入 |
| recentMessages | 强烈建议 | 判断上下文污染、错误延续、错误归因 |
| recentToolCalls | 强烈建议 | 看 AI 到底调了什么工具 |

recentMessages 建议只带最近 6 到 10 条，并对每条做长度截断。recentToolCalls 至少应包含最近 3 次工具调用的名称、输入摘要、结果摘要和错误标记。

### 6. 变更与检查点上下文

这是 AI 聊天编辑问题里最关键的一组字段。

| 字段 | 必须 | 作用 |
|---|---|---|
| latestCheckpoint | 强烈建议 | 判断是否可还原、还原为何失败 |
| latestChangedFiles | 强烈建议 | 直接看到 AI 改了什么 |
| lastRestoreAttempt | 否 | 排查“UI 说恢复了，但磁盘没恢复” |

latestCheckpoint 至少应包含：

- kind
- novelId
- chapterName
- label
- beforeContent
- afterContent
- beforeMetadata
- afterMetadata
- restoreMode
- source

latestChangedFiles 至少应包含：

- kind
- novelId
- chapterName
- label
- beforeContent
- afterContent
- restoreMode

### 7. UI 状态

| 字段 | 必须 | 作用 |
|---|---|---|
| rightPanelOpen | 否 | 判断聊天面板显隐相关问题 |
| showOtherProjectThreads | 否 | 复现线程分组问题 |
| expandedChangedFiles | 否 | 复现 diff 是否已展开 |
| visibleErrorBanner | 否 | 对应用户看到的错误条 |
| activeModal | 否 | 判断是否被确认框/弹窗阻塞 |

### 8. 错误与日志

| 字段 | 必须 | 作用 |
|---|---|---|
| latestRendererError | 强烈建议 | 看前端是否已经报错 |
| latestMainProcessError | 强烈建议 | 看主进程是否抛错 |
| latestChatAgentError | 强烈建议 | 看 runTurn / provider / tool path 异常 |
| latestToolFailure | 强烈建议 | 定位失败工具调用 |
| recentLogs | 否 | 提供上下文，但应严格截断 |

recentLogs 不应是全量日志，建议只截取问题发生前后 50 到 200 行，并按类别拆分。

## 当前代码中的采集来源

为了保证设计可直接落地，反馈包字段应尽量从现有状态源读取：

| 字段组 | 主要来源 |
|---|---|
| novelContext / editorContext | `src/App.jsx` |
| activeThreadId / messages / status / error | `src/components/AiChatPanel.jsx` |
| thread 元数据与 branch | `src/main/store/chatHistory.js` |
| latestCheckpoint / latestChangedFiles | `src/components/chatToolResultMeta.mjs` |
| 章节写入前后状态 | `src/main/mcp/tools.js` 与 `src/main/store/novelData.js` |
| 项目切换状态 | `src/App.jsx` + `mana.novel.active()` |
| 磁盘章节内容 | `mana.novel.readChapter()` / `mana.novel.readChapterMeta()` |

## 建议的本地持久化方式

快速反馈不应依赖实时联网成功。建议采用“本地反馈箱 + 异步发送”模型。

### 本地目录

建议新增：

```text
<userData>/feedback-outbox/
  index.json
  fb-20260515-abc123.json
  fb-20260515-abc123-screenshot.png
```

### 状态字段

每条反馈建议带上：

- status: pending / sending / sent / failed
- lastSendAttemptAt
- sendError
- endpoint

## 脱敏与裁剪规则

默认必须做以下处理：

1. API key、token、cookie、Authorization 头一律剔除
2. 文件系统绝对路径中的用户目录可归一化，例如 `/Users/<redacted>/...`
3. recentMessages 和 recentLogs 必须截断长度
4. contentExcerpt 默认只取局部上下文，不传整章正文
5. 截图和全量线程 JSON 作为可选附件，不默认上传

## 推荐的最小可复现包

如果只允许发送一份最小反馈包，也至少应包含：

1. issueTitle
2. actualBehavior
3. expectedBehavior
4. reproducibility
5. severity
6. createdAt
7. activeNovelId
8. activeChapterName
9. activeThreadId
10. selectionText
11. lastUserPrompt
12. recentToolCalls
13. latestCheckpoint
14. latestChangedFiles
15. latestChatAgentError

这是最接近“足够复现且不过度泄露”的最小集合。

## 分阶段实现建议

### Phase 1：本地反馈箱

- 提供 UI 入口与弹窗
- 自动采集最小可复现包
- 写入本地 JSON
- 支持复制 feedbackId 和反馈摘要

### Phase 2：远端发送

- 配置 webhook / API endpoint
- 失败重试
- 发送结果状态可见

### Phase 3：增强附件

- 截图
- 当前线程 JSON 附件
- 最近工具调用链附件
- 导出为 zip

## 验收标准

- [ ] 用户在 10 秒内可完成一次反馈提交
- [ ] 不要求用户手动整理技术细节
- [ ] 反馈包能定位到具体项目、章节、线程、工具调用
- [ ] AI 编辑类问题能看到 before / after / checkpoint 信息
- [ ] 离线时反馈不会丢失
- [ ] 默认不泄露无关正文与敏感凭据
- [ ] 开发者收到反馈后，可直接据此编写聚焦回归或复现脚本
