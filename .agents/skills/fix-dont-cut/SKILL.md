---
name: fix-dont-cut
description: 功能出现权限/阻塞问题时不应当直接移除功能。先找到阻塞点，用自动化/配置/预授权的方式消除阻塞，而非砍功能。
allowed-tools: Read, Write, Edit, Bash, Grep
context: fork
---

# 修复而非砍功能

## 原则

功能因权限、配置、环境阻塞时不直接移除该功能。先理解阻塞机制，然后用自动化/预配置的方式消除阻塞。

## 案例：WebSearch/WebFetch 权限被拒

**问题：** 驱动路径（`Codex --print` 无头模式）下，WebSearch/WebFetch 被 Codex 拒绝，提示 `Codex requested permissions to use WebSearch/WebFetch, but you haven't granted it yet.`

**错误的修复：** 从 `DEFAULT_BUILTIN_TOOLS` 中移除 WebSearch/WebFetch。AI 失去网页搜索能力。

**正确的修复：** 在 tmpdir 中写入 `.Codex/settings.json`，预授权这些工具：

```javascript
await fs.writeFile(settingsPath, JSON.stringify({
  permissions: { allow: ['WebSearch', 'WebFetch', 'Read', 'Grep'] },
}, null, 2), 'utf8');
```

Codex 启动时读取项目级 `.Codex/settings.json`，`permissions.allow` 中的工具自动获得授权。

## 检查清单

当功能因权限/阻塞不工作时：

1. **理解阻塞机制** — 是权限弹窗？配置缺失？环境变量？
2. **搜索替代方案** — 有没有 CLI flag、配置文件、环境变量可以消除阻塞？
3. **优先选自动化** — `settings.json`、`--flag`、`env var` 优于人工操作
4. **只有真的不可行才考虑砍功能**
5. **在 commit message 和文件注释中记录理由**

## 常见可配置阻塞点

| 阻塞类型 | 解决方案 |
|----------|----------|
| Codex 工具权限 | `.Codex/settings.json` → `permissions.allow` |
| CLI 工具需要确认 | `--permission-mode accept-all` 或 `--yes` |
| 网络访问限制 | 代理 env var、MCP 工具兜底 |
| 文件系统访问 | `allowedToolPrefixes`、工作目录设置 |
