# 工具路由误分类 — Bug 模式文档

最后更新：2026-05-19

## 模式描述

本应**在后端处理**的工具调用（Tool Call），因为被错误列入 `FRONTEND_TOOLS` 数组，导致在 `_runTurnViaProvider` 的分支判断中**被 `isFrontendTool()` 先行拦截**，路由到前端。前端 `handleFrontendAction` 不识别该工具，返回 `Unsupported frontend action` 错误。

## 典型表现

- AI 调用 `spawn_subagent` 后，聊天记录中显示红色错误：`错误: Unsupported frontend action: spawn_subagent`
- 子代理完全没有被触发，用户看不到任何子代理的输出
- 后端 `handleSpawnSubagent` 函数的逻辑永远不会被执行

## 根因分析

### 路由分支顺序（chatAgent.js:700-729）

```javascript
if (use.name === 'set_workflow_phase') {
  // ... 后端处理
} else if (use.name === 'confirm_outline') {
  // ... 后端处理
} else if (isFrontendTool(use.name)) {   // ← 分支 3
  toolResult = await handleFrontendTool(session, use);
} else if (use.name === 'spawn_subagent') {  // ← 分支 4，永远走不到
  toolResult = await handleSpawnSubagent(use.input, session);
} else {
  toolResult = await callMcpTool(use.name, use.input);
}
```

问题：**分支优先级决定命运**。`isFrontendTool()` 检查在 `spawn_subagent` 的专用处理分支之前。只要 `spawn_subagent` 被列在 `FRONTEND_TOOLS` 中，它就会先进入分支 3，被包装成 `frontend_action` 事件发送到渲染进程。

### 前端接收后（AiChatPanel.jsx:405-433）

```javascript
if (name === 'replace_selected_text') { ... }
else if (name === 'insert_text_at_cursor') { ... }
else if (name === 'get_full_editor_content') { ... }
else {
  result = `Unsupported frontend action: ${name}`;  // ← 走到这里
  isError = true;
}
```

前端只有 4 个 frontend action 的处理逻辑，`spawn_subagent` 不在其中，直接报错。

## 历史案例

### 案例：spawn_subagent 误分类为前端工具（2026-05-19）

**涉及的文件/代码：**

| 位置 | 作用 |
|------|------|
| `src/main/runtime/chatAgent.js:107` | `spawn_subagent` 被定义在 `FRONTEND_TOOLS` 数组中 |
| `src/main/runtime/chatAgent.js:142-144` | `isFrontendTool()` 通过查找 `FRONTEND_TOOLS` 判断 |
| `src/main/runtime/chatAgent.js:723` | `_runTurnViaProvider` 中 `isFrontendTool()` 检查在 `spawn_subagent` 专用分支之前 |
| `src/main/runtime/chatAgent.js:584-599` | `handleSpawnSubagent()` 本应执行子代理调度，但永远走不到 |
| `src/components/AiChatPanel.jsx:418` | 前端 `handleFrontendAction` 不支持 `spawn_subagent`，返回 Unsupported 错误 |

**错误配置（修复前）：**

```javascript
const FRONTEND_TOOLS = [
  { name: 'replace_selected_text', ... },
  { name: 'insert_text_at_cursor', ... },
  { name: 'replace_text_near_cursor', ... },
  { name: 'get_full_editor_content', ... },
  { name: 'spawn_subagent', ... },          // ← 错误：应在后端处理
  { name: 'set_workflow_phase', ... },      // ← 错误：已在分支1处理
  { name: 'confirm_outline', ... },         // ← 错误：已在分支2处理
];
```

**修复方案：**

不要把 `spawn_subagent`、`set_workflow_phase`、`confirm_outline` 留在 `FRONTEND_TOOLS`。这三个工具都有专门的后端处理逻辑：

- `set_workflow_phase` → 分支 1 直接修改 `session.workflowPhase`
- `confirm_outline` → 分支 2 调用 `write_outline_nodes` MCP 工具
- `spawn_subagent` → 分支 4 调用 `handleSpawnSubagent()` 通过 `workflowOrchestrator` 调度子代理

但**仅仅移出 `FRONTEND_TOOLS` 还不够**。如果 provider 路径的工具列表只拼接 `MCP tools + FRONTEND_TOOLS`，那这三个后端工具虽然不会再被误路由到前端，却会变成**对模型不可见**，导致 direct-api/provider 路径下根本无法调用。

因此正确修复是两步：

1. 从 `FRONTEND_TOOLS` 中移除这些后端工具，避免 `isFrontendTool()` 误拦截。
2. 新增独立的后端内建工具列表（例如 `BUILTIN_BACKEND_TOOLS`），并在 provider 路径下与 MCP tools 一起暴露给模型。

**正确配置（修复后）：**

```javascript
const BUILTIN_BACKEND_TOOLS = [
  { name: 'set_workflow_phase', ... },
  { name: 'confirm_outline', ... },
  { name: 'spawn_subagent', ... },
];

const FRONTEND_TOOLS = [
  { name: 'replace_selected_text', ... },
  { name: 'insert_text_at_cursor', ... },
  { name: 'replace_text_near_cursor', ... },
  { name: 'get_full_editor_content', ... },  // 只有真正需要前端参与的
];

const BUILTIN_CHAT_TOOLS = [
  ...BUILTIN_BACKEND_TOOLS,
  ...FRONTEND_TOOLS,
];
```

provider 路径下应使用：

```javascript
tools = [...mcpTools, ...BUILTIN_CHAT_TOOLS];
```

## 为什么其他两个工具（set_workflow_phase / confirm_outline）没有触发 bug？

虽然它们也在 `FRONTEND_TOOLS` 中，但 `_runTurnViaProvider` 的分支顺序是：

1. `set_workflow_phase` 专用分支（先匹配，不会走到 `isFrontendTool`）
2. `confirm_outline` 专用分支（先匹配，不会走到 `isFrontendTool`）
3. `isFrontendTool()` 检查
4. `spawn_subagent` 专用分支

所以前两个因为分支顺序的"巧合"避开了 bug，但 `spawn_subagent` 没有专用分支排在前面，就被拦截了。

## 预防措施

1. **新增工具时明确分类**：定义新工具前先判断——它需要前端 DOM/编辑器交互吗？还是纯后端逻辑？
2. **FRONTEND_TOOLS 最小化原则**：只有真正需要前端 `window.mana` API 或编辑器操作的工具才放入。后端正则处理、MCP 调用、子代理调度都不应该放入。
3. **代码审查 checklist**：修改 `FRONTEND_TOOLS` 或工具路由分支时，检查分支优先级是否与数组内容一致。
4. **单元测试覆盖**：在测试用例中验证每个工具的预期路由路径，确保不会被错误拦截。
