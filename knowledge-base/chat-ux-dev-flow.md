# AI 聊天交互开发流程

## 问题域

每次修改 AI 聊天相关代码时，需要验证：
1. 文字流是否正常（text_delta → assistant message）
2. 工具调用是否显示正确（tool_use → tool_call card）
3. 错误恢复是否可靠
4. 驱动切换（direct-api ↔ claude-code）不影响体验

强制规则：只要改动涉及聊天相关功能，就必须在模拟聊天环境中测试完整聊天链路，至少验证一次消息发送、事件分发、UI 渲染或错误展示。只跑 MCP 工具层、store 层、或子代理层测试，不算完成聊天功能验证。

## 架构要点

### 查询软件内 AI 聊天记录

排查聊天问题时，默认先看软件自己的聊天存档，不要先看 Copilot/Claude 对话转录。软件内聊天记录由 [src/main/store/chatHistory.js](src/main/store/chatHistory.js) 持久化，根路径由 [src/main/store/paths.js](src/main/store/paths.js) 的 paths().root 决定，存储结构固定为：

```
<userData>/chat-threads/
  index.json
  thread-*.json
```

查询步骤：
1. 先打开 chat-threads/index.json，按 title、updatedAt、novelId 找目标线程。
2. 再打开对应的 thread-*.json，看 messages、currentNodeId 和每条 assistant message 上的 toolCalls。
3. 排查 MCP/聊天异常时，以 thread-*.json 里的真实 toolCalls 为准，不要用和 Copilot 的对话记录代替。

当前 macOS 常见路径：
1. 开发环境：~/Library/Application Support/MultiAgentNovelAssistant-dev/MultiAgentNovelAssistant/chat-threads/
2. 生产环境：~/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant/chat-threads/

命令行快速查询示例：
1. 列出线程索引：cat ~/Library/Application\ Support/MultiAgentNovelAssistant-dev/MultiAgentNovelAssistant/chat-threads/index.json
2. 按标题筛线程：rg '拿去ai味工具审查2-6章|为第五章去除一下AI味' ~/Library/Application\ Support/MultiAgentNovelAssistant-dev/MultiAgentNovelAssistant/chat-threads/index.json
3. 打开指定线程：cat ~/Library/Application\ Support/MultiAgentNovelAssistant-dev/MultiAgentNovelAssistant/chat-threads/thread-xxxxx.json
4. 只看工具调用：rg 'toolCalls|review_de_ai_style|apply_chapter_patch|replace_chapter_text|spawn_subagent' ~/Library/Application\ Support/MultiAgentNovelAssistant-dev/MultiAgentNovelAssistant/chat-threads/thread-xxxxx.json

最常见的取证入口：
1. index.json：确认到底是哪一条会话。
2. thread-xxx.json：按时间顺序看 user/assistant/toolCalls。
3. 如果用户反馈“你看的不是这条聊天”，先回到 index.json 对线程标题和时间，再继续分析。

### 事件流路径

```
用户输入 → preload.js bridge → IPC
  → chatAgent.runTurn()
    → _runTurnViaProvider (direct-api 时)
       → provider.sendMessage() → onEvent({kind:'text',data:{delta:'...'}})
    → _runTurnViaDriver (claude-code 时)
       → workflowOrchestrator.runWorkflow()
         → driver.run() → streamJsonParser → eventBus
  → emitEvent(sessionId, 'text_delta', {delta})
    → IPC 'chatAgent:event'
      → AiChatPanel.handleEvent → setMessages → {String(m.text ?? '')}
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/main/runtime/chatAgent.js` | 会话管理、事件分发、两条执行路径 |
| `src/main/runtime/runSubagent.js` | provider 循环、MCP 工具执行 |
| `src/main/runtime/drivers/directApi.js` | direct-api 驱动实现 |
| `src/main/runtime/drivers/claudeCodeVscode.js` | Claude Code VSCode 驱动 |
| `src/main/runtime/drivers/shared/streamJsonParser.js` | claude-code NDJSON → AgentEvent 转换 |
| `src/components/AiChatPanel.jsx` | React UI 组件，事件处理与渲染 |
| `test/chat-tests.js` | 聊天 E2E 测试模块 |
| `test/chat-e2e.sh` | 聊天 E2E 测试 runner |

### 事件格式差异

| 来源 | kind | data 字段 | 备注 |
|------|------|-----------|------|
| Anthropic provider | `text` | `{ delta: '...' }` | 流式增量 |
| openai-compat provider | `text` | `{ delta: '...' }` | 流式增量 |
| claude-code NDJSON | `text` | `{ text: '...' }` | 完整文本块 |
| claude-code NDJSON (streaming) | `text` | `{ text: '...', delta: true }` | 流式块 |

`_runTurnViaDriver` 的 eventBus 订阅者必须兼容 `{ delta }` 和 `{ text }` 两种格式。

### turn_done fallback

当 text_delta 事件被丢弃时（如 claude-code → {text} 格式未被识别），turn_done 必须能从 `ev.data.text` 创建 assistant 消息：

```javascript
case 'turn_done': {
  if (last && last.isStreaming) {
    // 正常路径
  } else if (ev.data?.text && !prev.some(m => m.isStreaming)) {
    // fallback: 从 turn_done 创建消息
    next.push({ role: 'assistant', text: ev.data.text, isStreaming: false });
  }
}
```

## 测试场景设计

### 正常流程（T1-T4）
- 多段 text_delta 流式渲染
- tool_use + tool_result 顺序显示
- 多次工具调用链

### 断流与错误（E1-E4）
- text_delta 全部丢失（模拟 claude-code 事件格式差异）
- text_delta 部分丢失（turn_done 补充完整文本）
- MCP 工具返回错误
- API 断连/超时

### 边界条件（B1-B3）
- text_delta 传输数字（{ delta: 42 }），验证 String() 安全
- 超长回复流式渲染性能
- 无小说的空状态提示

## 自动化测试编写规范

### 测试文件结构

```
test/chat-tests.js    — 测试模块（导出 runChatTests）
test/chat-e2e.sh      — 测试 runner（构建 → 启动 → 解析结果 → 退出码）
main.js               — --test-chat 标志入口
```

### 测试方法

1. 通过 `mainWindow.webContents.executeJavaScript` 注入环境
2. 在渲染进程安装事件监听器（`window.__chatTestEvents`）
3. 通过 `webContents.send('chatAgent:event', payload)` 模拟事件流
4. 通过 `executeJavaScript` 轮询事件并断言
5. 清理资源和监听器

### 断言规则

| 检查点 | 方法 |
|--------|------|
| 事件到达 | 检查 `window.__chatTestEvents` 长度 |
| 事件类型 | 检查 `kind === 'text_delta'` |
| 事件内容 | 检查 `data.delta`, `data.text`, `data.name` 等 |
| 错误状态 | 检查 `data.isError === true` |
| 跨测试隔离 | 每个测试前调用 resetEvents() |

## 修复循环流程

1. **先写测试** — 从当前 bug 场景提炼测试用例
2. **运行聊天环境测试** — 在模拟聊天环境中确认当前场景失败（红），不能只跑工具层测试替代
3. **读代码定位** — 追踪事件流路径，找到根因
4. **修复** — 修改最少的代码使测试通过
5. **重跑聊天环境测试** — 确认聊天链路测试通过（绿）
6. **回归** — 运行 `bash test/ui-e2e.sh` 和 `bash test/chat-e2e.sh`
7. **手动验证** — 启动应用，实际使用聊天功能
8. **循环** — 直到所有测试通过

## 验收标准

- [ ] `bash test/ui-e2e.sh` ✅ 全部通过
- [ ] `bash test/chat-e2e.sh` ✅ 全部通过
- [ ] `npx vite build` ✅ 构建通过
- [ ] 至少有一条测试运行在模拟聊天环境中，验证的是真实聊天链路，不是单独工具层
- [ ] 手动：聊天输入文字，流式文字正常显示
- [ ] 手动：工具调用卡片正常显示（折叠/展开）
- [ ] 手动：断流/错误情况下 UI 显示合理错误信息
- [ ] 所有 event 格式（{delta} 和 {text}）均正确处理
