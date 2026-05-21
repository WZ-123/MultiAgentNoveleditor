# Multi-Agent Novel Assistant — Skill Reference

This is a runtime reference document used by subagents and the config-helper.

## Product Positioning

MultiAgentNovelAssistant is infrastructure for AI IDE (Claude Code). The AI IDE makes decisions and performs analysis; this app provides MCP data tools, workflow guidance (DAG/Subagent), file management, and conflict resolution. The built-in direct-api driver is a fallback when Claude Code is unavailable.

## Tier slots

A Preset bundles 3 tier slots:

- **opus** — strong reasoning / consistency review (character / timeline)
- **sonnet** — chapter-level prose writing
- **haiku** — light annotation / cheap quick passes

Subagents declare a default tier; nodes in a DAG can override.

## Built-in subagents

- sa-outline-drafter (opus)
- sa-character-reviewer (opus)
- sa-timeline-guardian (opus)
- sa-style-checker (haiku)
- sa-prose-quality (haiku)
- sa-writer (sonnet)
- sa-lore-updater (opus)
- sa-import-orchestrator (sonnet) — novel import workflow orchestration
- sa-config-helper (haiku)

## Built-in DAGs

- dag-quality-outline / dag-quality-writing — quality-first; uses parallel review and revision loops
- dag-cheap-outline / dag-cheap-writing — cost-first; flatter graph, haiku-heavy

## Cost vs quality trade-offs

- Need to lower cost? Switch to dag-cheap-* and remap opus tier to a cheaper provider/model.
- Need to improve quality? Switch to dag-quality-* and ensure opus tier uses a top-tier model.
- Timeline correctness benefits from at least sonnet-level model on sa-timeline-guardian.

## Tools (MCP)

Read-only: list_characters, read_character, list_assets, read_asset, query_timeline,
check_timeline_feasibility, query_world, read_outline, read_chapter, read_style_memory,
read_skill, search_index.

Write (auto): grant_asset, revoke_asset, append_timeline, append_summary, append_style_memory.

Write (requires user confirmation): create_character, update_character, update_world.