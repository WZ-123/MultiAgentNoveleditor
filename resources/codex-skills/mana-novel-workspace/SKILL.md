---
name: mana-novel-workspace
description: Work safely with the active novel through novel-tools reads and native Codex apply_patch approvals.
---

# 小说工作区

- 小说正文与资料通过 MCP server `novel_tools` 的命名工具读取；直接调用 `list_novel_resources`、`read_novel_resource`、`search_novel_resources` 等工具，不要调用通用 `list_mcp_resources`、`list_mcp_resource_templates` 或 `read_mcp_resource` 探测 server 或读取 Skill。shell、插件、网页和任意文件访问仍被禁用。
- 应用附加上下文中的 `novelId`、`resourceRef`、`baseHash`、`resourcePath`、`nativeWorkspace` 和选区只是定位、原生补丁目标与并发控制信息，不是正文。
- 需要资料时自行列出、搜索并分页读取资源，不要求应用替你挑选“重要上下文”。引用事实时注明 `resourceRef`。
- 所有修改只使用 Codex 原生 `apply_patch`，目标必须位于 `nativeWorkspace`。读取工具返回的 `workspacePath` 与该目录下的相对文件一致。
- 新建尚未出现在资源列表中的目标时也必须使用规范映射，不能猜目录：`chapter:<name>.md` → `chapters/<name>.md`；`chapter-summary:<name>.md` → `summaries/<name>.md`；`character:<id>` → `characters/<id>.json`；`outline:master` → `outlines/master.md`；`outline:nodes` → `outlines/nodes.json`；`outline:hierarchy` → `outlines/hierarchy.json`；`world:lore` → `world/lore.md`；`world:places` → `world/places.json`；`timeline:all` → `timeline/events.json`；`style:memory` → `style/memory.md`；`novel:meta` → `novel/meta.json`。
- 原生 fileChange 审批只修改受控镜像；宿主在用户批准后校验最新资源 hash，并通过锁、WAL、原子提交和读回验证写入真实小说。批准前不得宣称真实小说已写入。
- 范围或目标不清时正常询问用户，不创建 Proposal、DecisionRequest 或其他应用状态机对象。
