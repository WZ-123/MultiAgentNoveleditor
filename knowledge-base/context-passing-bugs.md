# 上下文传递断裂 — Bug 模式文档

最后更新：2026-05-09

## 模式描述

上下文（Context）在跨层传递时，因为**属性名不匹配**或**部分字段缺失**，导致下游收到的数据不完整，功能静默失效。

## 典型表现

- AI 提示"没有打开的小说"，但 UI 右上角明明显示了小说名
   → 根因：`editorContext.novelId` 因轮询延迟为空，但 MCP 服务器的 `activeNovel` 状态是正确的
- MCP 工具返回 `"No active novel: this tool requires an open novel."`，但 `list_novels` 能正常返回小说列表
   → 根因：`novelContext` 只传了 `novelId` 没传 `novelDir`，或属性名不匹配

## 历史案例

### 案例 1：novelContext 属性名不匹配（2026-05-09）

**涉及的函数/文件：**
- `serverManager.getActiveNovelContext()` 返回 `{id, dir}`
- `claudeCodeVscode.js:prepare()` 读取 `spec.novelContext?.novelId` 和 `.novelDir`
- `mcpConfigGen.js:buildArgs()` 检查 `p.novelId` 和 `p.novelDir`

**断裂点：** `chatAgent.js` 把 `getActiveNovelContext()` 的返回值直接塞进 `novelContext`，没有做属性名映射。`{id, dir}` 传下去，但下游读的是 `{novelId, novelDir}`，所以两个字段都是 `undefined`。

**正确模式（参考 `ipc/runtime.js`）：**
```javascript
novelContext: { novelId: ctx.id, novelDir: ctx.dir }
```

### 案例 2：editorContext 缺失 novelId（2026-05-08）

**涉及的函数/文件：**
- `App.jsx` 的 `useMemo` 没有把 `activeNovelId` 放进 `editorContext`
- `chatAgent.js` 的 `_runTurnViaProvider` 依赖 `session.editorContext?.novelId` 决定工具列表

**断裂点：** `editorContext` 没有 `novelId` 字段，AI 聊天后端以为没有活跃小说，只暴露 3 个工具。WorkspaceSwitcher（用 `useNovel` 直接查后端）能正常显示小说名，但 AI 看不到角色工具。

**修复：** `editorContext` 补上 `novelId`，并且在 `chatAgent.js` 的 tool filtering 和 system prompt 中增加 `mcpClient.getActiveNovel()` 兜底。

### 案例 3：localMsgs 作用域错误（2026-05-08）

**涉及的函数/文件：**
- `AiChatPanel.jsx:switchThread()`

**断裂点：** `const localMsgs` 定义在 `if (thread?.branch)` 块内部，但 `createSession({ messages: localMsgs })` 在块外部调用。锁屏恢复后 `branch` 为空时 `localMsgs` 未定义，抛出 `ReferenceError`。

## 检查清单

在排查"功能不工作但无明显报错"的 bug 时，按此顺序检查：

### 1. 属性名一致性
- [ ] **跨层传递的对象**：每一层的属性名是否一致？
- [ ] **API 返回 vs 使用者期望**：比如 `{id, dir}` vs `{novelId, novelDir}` 
- [ ] **映射代码是否存在**：`ipc/runtime.js` 有显式映射，其他层有没有？

典型受损场景：
- 一个函数返回 `result.id`，调用方读 `result.novelId`
- `mcpClient.getActiveNovel()` 返回字符串，下游当对象用

### 2. 字段完整性
- [ ] 只传了 `novelId` 但忘了 `novelDir`？
- [ ] `editorContext` 是否包含了所有下游需要的字段？
- [ ] 下游有 fallback 吗？如果没有，上游遗漏就变成硬错误

### 3. 异步时序
- [ ] 上游数据的更新是即时还是轮询？（如 `App.jsx` 3 秒轮询 `activeNovelId`）
- [ ] 上游和下游之间存在时序窗口吗？窗口期内下游拿到的值对不对？
- [ ] 有兜底机制吗？（如 `mcpClient.getActiveNovel()` 作为 MCP 的即时状态）

### 4. 变量作用域
- [ ] 变量是在 `if`/`try` 块内 `const` 声明的吗？
- [ ] 块外有引用吗？（特别是 `catch` 块外的正常流程中）

## 排查技巧

1. **在断裂点加日志**：在上下文交接处打印 `JSON.stringify(contextObj)`，看实际传了什么
2. **对比上下游的数据结构**：上游 `return {id, dir}` → 下游 `read spec.novelId` → 必然为 `undefined`
3. **检查 saga/action 的数据流**：`editorContext → IPC → session → session.editorContext → tool filtering`
4. **模拟时序窗口**：在 MCP 调用前加 `setTimeout`，验证轮询延迟是否会触发空值
