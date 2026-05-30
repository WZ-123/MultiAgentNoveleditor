# 联网人设补全基准测试项目

## 在应用内打开

1. 启动 `npm run dev`
2. 打开或注册小说：**联网人设补全基准测试（2026）**
3. 项目目录：`test-projects/web-enrichment-benchmark-2026`
4. 注册 ID：`novel-web-enrichment-benchmark-2026`

## 复跑补全

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js --concurrency=3
```

如果浏览器能连外网，但命令行抓页超时，可通过 Electron 会话继承当前代理：

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  scripts/with-electron-proxy.sh \
  node scripts/run-enrichment-benchmark.js --concurrency=3
```

仅重建角色、不补全：`--skip-enrich`

补充 smoke roster（东方 / Fate / 舰队Collection / 魔法禁书目录 / 葬送的芙莉莲 / 鬼灭之刃）：

```bash
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-jp-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-jp-acg.json \
  --skip-enrich
```

### 欧美通用层主验收集（36 角色）

作品：黑袍纠察队、漫威、DC、魔戒、哈利波特、RWBY。  
角色表与轮换池：`ROSTER-WESTERN.md`  
流程文档：`knowledge-base/western-enrichment-benchmark.md`

```bash
# Smoke（搜索+抓页，无 AI）
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --skip-enrich

# 全量补全
MANA_USER_DATA_ROOT="$HOME/Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant" \
  node scripts/run-enrichment-benchmark.js \
  --roster=test-projects/web-enrichment-benchmark-2026/roster-famous-western-acg.json \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json \
  --concurrency=3

# Acceptance
node scripts/eval-enrichment-benchmark.js \
  --report=test-projects/web-enrichment-benchmark-2026/benchmark-report-famous-western-acg.json
```

## 报告

- `benchmark-report.json` — 主 benchmark（手游特化轨）探测与补全结果
- `benchmark-report-famous-western-acg.json` — 欧美通用层验收集
- `benchmark-report.json` — 最新完整结果（v2）
- `benchmark-run-v2.log` — v2 终端日志
- `benchmark-run.log` — v1 终端日志
- `ROSTER.md` — 主 benchmark 36 名角色（手游特化轨）
- `ROSTER-WESTERN.md` — 欧美通用层 36 名角色与轮换池

## 基准对比（改代码前 v1 vs 改后 v2）

| 指标 | v1 | v2 |
|------|-----|-----|
| `success` | 16/36 (44.4%) | **22/36 (61.1%)** |
| `fetch-failed` | 12 | **3** |
| `extract-empty` | 8 | 0 |
| `extract-rejected`（误页拦截） | — | 10 |
| 平均填充字段 | 2.92 | **4.39** |
| 探测无正文 | 12 | **3** |

主要改动：结果标题打分、Bing URL 抓页、百科 API 失败时 URL 回退、蔚蓝档案改 JP 文化圈、绝区零/鸣潮 Bili slug、提取结果校验（避免尼可·莱恩写成莱卡恩）。
