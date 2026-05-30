---
name: ux-dev-flow
description: Use when the user asks to test UX, develop interactive features, "打通用户体验流程", design UX tests, do interactive development testing, or run user-flow testing
allowed-tools: Read, Write, Edit, Bash, WebFetch
context: fork
---

# 交互式 UX 开发流程

按以下七步流程执行。完整方法论见 `knowledge-base/ux-dev-flow.md`。

## Step 1: 需求分析 → UX 流程设计
以用户操作路径为主线描述完整用户体验。**先和用户确认 UX 流程设计**再继续。

## Step 2: 测试用例设计
设计 T（正常）/ E（异常）/ B（边界）/ S（状态转换）四类用例，参考 `knowledge-base/edge-cases.md` 的审计模式。

## Step 3: 启动 Dev Server
运行 `npm run dev` 并确认无编译错误。

## Step 4: 执行交互测试
按 T → E → B → S 顺序执行。打开浏览器 DevTools 观察 Console/Network。

## Step 5: 错误捕获
从浏览器控制台、终端输出、React 组件三个来源捕获错误。

## Step 6: 修复循环
分析错误 → 定位根因 → 修复 → 重测。**铁律**：不能只看函数通过，必须验证 UI 真正加载。追踪完整数据链路：IPC → handler → service → file → React → DOM。

## Step 7: 验收
逐条确认 UX 流程和所有用例通过。
