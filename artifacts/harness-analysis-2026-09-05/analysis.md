# Codex harness 空转与过度审校原因分析

分析日期：2026-09-05。读取了用户引用的 Codex 任务 `01a05926-1dd9-7de2-ade9-1346d530047c`、当前实现及原始验收日志。没有运行生产 API，没有重新审查小说正文，没有修改运行时源码。

接入官方 Codex App Server 属实，但当前链路还包含自写的 DeepSeek 协议转换层和大量验收流程控制。使用 App Server 不能单独证明任务范围、工具协议、审校收敛和耗时满足产品要求。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)描述了会话、审批和流式事件等集成能力。

## 1. 原验收统计漏掉失败，也不能证明没有空转

按引用任务的执行时间窗，逐个读取验收目录的原始 session 事件，按原生 turn ID 去重。为避免混入其他验收，主要结论仅使用明确包含该小说 novelId 的回合。

| 统计项 | 明确绑定该小说的原始记录 |
| --- | ---: |
| 回合启动 | 638 |
| 有完成事件 | 628 |
| 未找到完成事件 | 10 |
| 已完成且超过 60 秒 | 19 |
| 最长已完成回合 | 137.640 秒 |
| 分批一致性审校启动 | 260 |
| 最终综合审校启动 | 25 |
| unsupported call 工具错误 | 738 |

这包括开发修复前后的历史，不能据此声称当前每轮仍同样慢。更直接的当前反例是：**最终被报告为 passed 的最后一次验收，仍包含一个 14.897 秒的回合：8 次 token 使用事件、17 次 unsupported call、0 次成功进入 MCP 的调用，最后承认无法读取资源。** 它随后被另一轮重试替代。旧报告同时显示 MCP 错误 0 和补丁失败 0，因此“无错误/无空转”并未被实际验证。

该反例位于 [原始 session，第 17 行起](/Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/deepseek-live-acceptance/provider-user-data/codex-home/sessions/2026/09/01/rollout-2026-09-01T13-57-26-01a05b8b-397f-7992-89b1-8e8d3b40faab.jsonl:17)。前三次调用反复尝试不可用的 spawn_agent，随后尝试两个错误小说工具命名空间。

统计代码存在四个具体问题：

- [recordTurn](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test/deepseek-live-novella-ui-e2e.js:50)按 label 覆盖旧记录，397 是保存下来的唯一标签数，不是所有执行尝试的数量。
- 同一函数在写账本之前检查 60 秒并抛错，超时失败不会由本次调用落盘。
- [auditCodexSessions](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test/deepseek-live-novella-ui-e2e.js:126)仅审计本次脚本启动后的事件。最终报告的 221,774 token 和 33 个所谓物理调用，只覆盖最后 12 个回合，约 2 分 25 秒。
- 审计器只统计进入 MCP 的错误和 patch_apply_end 失败；未路由成功的 unsupported call 不进入这两个计数。超过 8 次调用才失败，恰好 8 次无进展仍可通过性能门槛。token_count 事件数量也不是完整的上游 HTTP 请求与重试计数。

明确绑定小说的 usage 事件合计 8,557,697 token；包括重复上下文和缓存输入，并有 9 个事件缺少 usage。这是已有日志的使用量口径，不是完整账单，也不是外层执行者 5.6 Sol 的 token。验收目录整个时间窗还包括其他测试，不能把其总数全部归给这部小说。

## 2. 当前协议转换并非透明，仍会改变 harness 的行为

[架构契约](/Users/potablewater/Desktop/MultiAgentNovelAssistant/knowledge-base/codex-native-runtime-contract.md:25)写着不存在 Responses 协议桥；实际 [CodexSessionService](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/codex-runtime/codexSessionService.js:167)在 DeepSeek none 模式启用 bridge。[bridge 主分支](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/codex-runtime/deepseekNoReasoningBridge.js:363)再把请求转成 Chat Completions，然后封装回 Responses 事件。

以下问题已从当前代码和离线调用中验证：

- [上游调用](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/codex-runtime/deepseekNoReasoningBridge.js:290)使用 stream:false，等待完整 JSON，再一次性生成 SSE。用户等待时看到的静止，部分来自失去了真正的增量输出。
- 宣称的审校 1,200-token 上限只进入 normalizeNoReasoningRequest；主要 Flash 分支直接进入 chatCompletionAsResponses，实际仍允许 6,000。现有测试断言了前一个函数，没覆盖审校主分支的请求参数。
- [消息转换](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/codex-runtime/deepseekNoReasoningBridge.js:52)将 developer 角色降成 user，改变原生指令的优先级。
- 工具名称、namespace、参数包装和补丁语法依赖大量事后修补。原始日志证明协议漂移仍存在。具体某次工具不可用是模型生成错误还是请求工具定义未完整转换，需要该次线上请求 schema 才能进一步拆分；不能只相信模型声称“工具不存在”。

## 3. “无关章节被读取”有一个可确定复现的当前缺陷

[explicitResourceRefs / normalizeChatToolCalls](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/codex-runtime/deepseekNoReasoningBridge.js:212)收集整个输入历史里的用户资源引用。如果模型给 read_novel_resource 空参数，就从这个历史列表依次补齐，且每个响应重新从头计数。

离线复现：第一条历史消息要求读第 1 章，当前消息明确只审查第 27 章，模型给出空参数读取。转换后的 resourceRef 是第 1 章。这是桥接层替模型猜任务目标造成的越界读取，不能归因于 Codex 自主判断。

另一个次要开销是 [syncNativeNovelWorkspace](/Users/potablewater/Desktop/MultiAgentNovelAssistant/src/main/codex-runtime/nativeNovelWorkspace.js:64)在每次小说工具任务前删除并重新复制全部映射资源。它增加本地 I/O，但不等于模型把这些正文全部读入上下文，应与 MCP 读取和 token 消耗区分。

## 4. 全书缓存失效与主观质量闸门形成不收敛的循环

[buildConsistencyFingerprint](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test/deepseek-live-novella-ui-e2e.js:109)把 27 章正文、全部章纲和 world:lore 合成一个指纹。[缓存判定](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test/deepseek-live-novella-ui-e2e.js:542)一旦发现任意修改，就丢弃全部九批审校结果。不存在按章节或依赖关系局部失效。

每批又按固定清单审查人物、规则、时间线、POV、段落功能、记忆代价和伏笔，而不是依据此次改动选择检查维度。末尾只按“可交付/需修订”的自然语言字样判定成功，没有结构化的稳定问题 ID、严重度阈值、已关闭问题记录或全流程迭代预算。

因此形成：局部补一句 → 全书重读 → 新一轮发现另一种疑点 → 修改 → 全书再读。日志中每个三章批次被审查 27–34 次，综合审校 25 次。

引用任务甚至记录过“无坐实硬冲突”但因几个“张力点”继续拒绝交付，并将反复发现边缘冲突解释为“严格门禁在发挥作用”。这里的工程判断把疑点不断升级成阻断项，缺少判断审校是否还在产生有价值进展的条件。并非所有修订都无效，但没有证据支持把整条循环称为没有空转。

## 5. 60 秒验收衡量的是拆细步骤，而非用户完成任务

[正文生成脚本](/Users/potablewater/Desktop/MultiAgentNovelAssistant/test/deepseek-live-novella-ui-e2e.js:270)每段新建会话、只取一项章纲证据和短尾文，先要求输出约 800 字，再发另一轮要求原字提交；有时还额外发一轮让模型逐字复制草稿以恢复上下文。

这能减少单次上下文和输出，但同时增加模型往返、提交成本、会话重建，并弱化连续上下文。至少不能据此证明普通用户直接发出整章任务时也同样高效。

仅把已保存账本中同一章的步骤耗时相加，第 1 章就是 181.086 秒，第 4 章 113.208 秒，第 12 章 108.141 秒；这些还不包含被覆盖或漏记的失败、外层排障及后续全书复审。

## 6. 当前没有任务总时限与无进展约束

生产 startTurn 没有 60 秒任务截止，60 秒主要是测试结束后的检查。bridge 的 18/50 秒只约束一个上游请求，provider 还配置了请求重试和流重试；多个工具往返及重试的总时间仍可超限。缩短单个请求的 timeout 不等于约束整个用户任务。

原生 harness 承担工具循环，不会自动获得这个小说产品定义的“哪些章节相关、哪些疑点值得阻断、多久必须产生可交付结果”的标准。基础指令虽写着不要读无关资源，但运行时没有基于明确任务范围的读取记录、重复无效调用预算或任务级进展判定。

## 应优先修正的边界

1. 将全部尝试追加记录，独立保存任务、模型请求、工具调用和失败；统计完整用户任务的耗时，所有 unsupported call 纳入错误与进展判定。
2. 核验真实 provider 请求与工具定义，保持角色优先级、流式输出、工具名称和参数语义；空参数不得从历史任务猜目标。
3. 为明确的用户任务设置总时间和重试预算，连续无进展时返回可解释状态；保留用户请求的功能。
4. 审校按修改及依赖增量失效，区分硬冲突、待确认疑点与偏好；维护问题状态与收敛标准，全书审校由任务需要触发。
5. 使用普通用户会输入的整章、局部改写和连续多轮任务验收。不要以每段新会话、精确提示和额外复制步骤替代真实体验。

这些属于产品与协议边界的修复，不需要另造一套 agent 循环，也不需要删掉审校或上下文读取功能。5.6 Sol 在引用任务中的主要问题是对这些边界及统计口径的判断失准；实际小说执行模型是 v4 Flash，不能把两者的行为或 token 混为一谈。

可复核数据：[evidence.json](/Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/harness-analysis-2026-09-05/evidence.json)。复现脚本：[collect-evidence.cjs](/Users/potablewater/Desktop/MultiAgentNovelAssistant/artifacts/harness-analysis-2026-09-05/collect-evidence.cjs)，只读既有日志并执行无网络 mock。
