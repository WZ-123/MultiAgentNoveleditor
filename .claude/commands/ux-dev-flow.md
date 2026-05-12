---
description: 交互式 UX 开发流程——以人类交互视角驱动功能开发，设计测试用例，自动捕获错误，修复循环直至全流程打通
argument-hint: [功能名称或需求描述]
allowed-tools: Read, Write, Edit, Bash, WebFetch
---

# 交互式 UX 开发流程

## 参考文档
完整方法论见 `knowledge-base/ux-dev-flow.md`

## 当前状态
!`git status --short`

## 步骤

### Step 1: 需求分析 → UX 流程设计
理解需求: $ARGUMENTS

以"用户操作路径"为主线，描述完整的用户体验流程。格式：
```
功能: [名称]
触发条件: ...
操作路径:
  1. 用户看到什么
  2. 用户做什么
  3. 系统响应什么
  ...
成功状态: ...
失败状态: ...
```

### Step 2: 测试用例设计
设计四类用例：
- **T（正常流程）** — 用户按预期操作
- **E（异常流程）** — 错误和中断
- **B（边界条件）** — 极端输入、空状态
- **S（状态转换）** — loading/empty/error/data 切换

每条用例包含：编号、操作步骤、预期结果、验证方式。

参考 `knowledge-base/edge-cases.md` 中已有的边际情况审计模式。

### Step 3: 启动 Dev Server
!`npm run dev &`

### Step 4: 执行交互测试
按 T → E → B → S 顺序执行测试。

### Step 5: 错误捕获
从浏览器控制台、终端输出、React 组件三个来源捕获所有错误。

### Step 6: 修复循环
分析错误 → 定位根因 → 修复 → 重测，直到无错误。

**铁律**：不能只看函数执行通过，必须验证 UI 控件真正加载和显示。追踪完整数据链路：IPC → handler → service → file → React → DOM。

### Step 7: 验收
对照 UX 流程逐条确认。

---

完整方法论详见 `knowledge-base/ux-dev-flow.md`
