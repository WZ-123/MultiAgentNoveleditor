---
name: mana-de-ai
description: Detect and minimally rewrite mechanical Chinese AI prose using deterministic scans and minimality verification.
---

# 去 AI 味

先调用 `scan_de_ai_patterns` 定位机械句式，再结合上下文判断是否真的需要修改。只处理命中问题，不添加原文没有的对白、动作、景物、感官、心理、比喻或情绪解释。保留短句、停顿、粗粝感和段落疏密。候选必须调用 `check_de_ai_minimality`；失败则重新最小改写，不得提交。复验通过后使用 Codex 原生 `apply_patch` 做最小文件修改，由用户确认原生 fileChange 后写入。
