# 系统说明

最后更新：2026-03-29

## 项目概览

- 项目名：MultiAgentNovelAssistant
- 形态：Electron + Vite + React 桌面应用
- 目标：通过多代理协作提升小说创作与工作流效率

## 技术栈（当前已观察）

- 前端：React
- 桌面容器：Electron
- 构建与开发：Vite
- 样式：TailwindCSS（含 HeroUI 相关配置痕迹）

## 目录与模块（简要）

- `src/components`：界面组件（如工作流面板、设置面板）
- `src/services`：编排、模型调用、配置管理等核心逻辑
- `src/agents`：代理注册与编排相关定义
- `src/domain`：领域类型与通用方法
- `main.js` / `preload.js`：Electron 主进程与预加载逻辑

## 当前已知问题

- 开发环境日志显示 `@heroui/react` 与 `@heroui/theme` 依赖解析失败
- 该问题会影响 `vite` 开发运行时的页面加载与样式处理

## 运行与维护约定（建议）

- 新功能完成后，同步更新本知识库
- 关键决策必须记录在 `vibe-coding-dialogues.md`
- 每个迭代结束，更新 `progress.md` 的下一步计划
