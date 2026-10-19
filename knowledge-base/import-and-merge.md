# 导入、分析与合并

来源：[导入 UI](../src/components/ImportNovelPanel.jsx)、[导入 IPC](../src/main/ipc/import.js)、[ImportSaga](../src/main/import/importSaga.js)、[暂存项目](../src/main/import/stagingProject.js)、[分析器](../src/main/import/analyzer.js)、[合并引擎](../src/main/import/mergeEngine.js)。

## 当前流程

### 唯一状态权威与命令转换（2026-10-19 重做契约）

本节定义本轮实现的设计约束；实际执行证据与未验证项以审计报告最新记录为准。`ImportRunStore` 的单份运行聚合拥有状态、revision、工作代次、目标绑定、唯一提交决定与最终结果。每个 importId 只关联一份 run；旧暂存首次接入在同一登记锁下认领，不能并发合成两份运行。store 的命令入口在短运行租约内重读聚合，验证允许状态、expected revision 和工作 token，再原子保存。禁止调用方保存整份旧快照来转换状态；兼容 save 只能对同状态、同版本的非权威信息做 CAS。读操作不改状态。

| 命令 / 所有入口 | 前提与状态转换 |
| --- | --- |
| start / 兼容 createStaging 接入 | picked → parsed → staged；解析、暂存结果必须匹配原工作 token；取消后的结果失效 |
| resume / startAnalyses / finalizeAnalyses | staged → analyzing → review；活动分析有可验证所有者，其他服务读取不声明中断，同进程服务复用同一工作，进程死亡后的显式恢复才使旧代次失效并重启 |
| createMerge | review → merging；长准备返回后按原 revision 安装 session，取消或目标变化使结果失效 |
| review 的 decide/finish；resolveConflict / resetMerge，包括 sessionId 兼容入口 | 事实取舍仅在 review、合并取舍仅在 merging 且尚无提交决定；同一命令租约保护选择，不能把旧 run 写回；读取 session/summary 不转换状态 |
| finalize / finalizeMerge / promoteToNovel，包括直接宿主 API | 新项目 preparing 或目标项目计划均先绑定原目标/原基线；文件检查完成后通过同一 decideCommit 命令持久化决定，再写正式资源；所有兼容入口只做 ID 解析并转发，不另写状态 |
| cancel | 无提交决定：任何可恢复状态（含 retryable failed）→ cancelled，旧工作 token 失效；有决定：保留决定并恢复原次提交，返回实际结果或明确的待恢复错误，不能返回 cancelled |
| 工作失败 / 中断恢复 | 只接收当前代次的失败；旧回调不得改新状态。已有决定只能按原计划续交；无决定才可从 interrupted/failed 重新准备 |
| completed / cancelled 重复请求 | 终态幂等；completed 返回原结果，cancelled 不允许旧任务复活 |

运行锁不覆盖长分析、目录复制或等待模型。长工作在租约外生成绑定 token/revision 的结果；只有回到命令入口后才获得继续执行的权利。新项目的 owner/manifest/目标保留和已有项目的资源计划是执行材料；提交决定保存在运行聚合，执行检查点及暂存状态是投影。恢复不能用投影终态覆盖权威。文件日志继续负责实际字节恢复，不能充当业务授权。

锁序：长准备可持项目/执行材料锁；不得持运行命令租约等待长项目工作。目标正式文件的最终版本检查、decideCommit 和开始提交在同一项目执行边界内完成；取消只需短运行命令，随后在运行租约外等待执行器清理或续交。提交决定之后的失败保留原计划与身份，不静默重定基线。

已有项目的决定绑定 runId、importId、sessionId、novelId、规范目标目录和完整文件计划（逐项原 hash 与目标字节），而非仅保存 sessionId。执行器也先通过材料事务读取取舍，不能观察尚未确认、随后回滚的选择；决定落盘后从运行记录恢复计划，修改 session 检查点不能改变提交。只有真实具名文件事务的提交证明可用于旧合并接管。

项目登记迁移、已有身份重新登记与合并执行共同持有 novelId 身份租约。迁移和合并先取身份租约，再读取登记；合并验证审阅时绑定的规范目录，不跟随新路径重定目标。正式文件锁释放后才写应用层投影，避免与普通元数据保存的应用→项目锁序倒置。

```text
选择文件 → 解析 → 暂存项目 → 分析 → 用户审阅
                              → 冲突解决/合并 → 提升为正式项目或写入目标项目
```

ImportSaga 保存 run、revision、来源指纹、阶段记录和 checkpoint。实现包含 picked、parsed、staged、analyzing、review、merging、promoting、completed，以及 interrupted、failed、cancelled、recovery_required。allowedActions 根据当前状态生成，不能通过跳过阶段按钮强行提交。

解析、分析和提升有各自 deadline。来源快照与元数据先持久保存，尚未创建暂存项目的 picked/parsed 也能从恢复列表继续。读操作不宣告任务死亡；显式 resume 验证工作 token 的磁盘租约，活动所有者仍在时等待它，同进程调用共享其工作；租约失效后生成新代次恢复。cancel 与 resume 不等于新建另一次导入。

提升的保存决定、取消与恢复遵守 [存储事务与审阅契约](data-and-editor.md#存储事务与审阅契约)。提升超时或取消后仍需等待实际保存结果，不能用结束等待代替结束写入。打开导入面板可从未完成记录恢复原目录和取舍；提升中断使用“从检查点恢复”，完成后显示原项目与保存回执。提交前取消显示未创建正式项目；提交后的取消说明项目已保存，并保留回执。

## 文件与 Chatbox

[fileParser](../src/main/import/fileParser.js) 处理文本、Markdown、EPUB 及识别到的聊天导出。章节识别基于标题和模式置信度；识别不足时保留为单章，不凭任意长度伪造章节。

[chatboxParser](../src/main/import/chatboxParser.js) 与 [chatboxDraftExtractor](../src/main/import/chatboxDraftExtractor.js) 分别承担聊天结构读取与草稿提取。不能把用户指令、模型讨论和小说正文无区别导入为正式章节。导入来源内容是资料，不是应用执行指令。

## 分析与合并边界

分析器分片处理内容，汇集角色和其他资料；模型提取通过 nativeProvider/runOneShot 走当前激活模型。源文本分片策略与 UI 章节拆分不是同一个过程。联网角色补全另见 [角色补全](character-enrichment-system.md)。

重复导入指纹用于提示与恢复选择，不表示可以无确认覆盖已有正式资源。暂存分析成功不等于正式项目已提交。冲突检测、用户选择、合并 session 和最终 receipt 必须指向同一 targetNovelId。

验收要求：解析失败可定位原因；全部分析失败不能显示成功；中断后恢复不能重复提升；冲突未解决不能提交；切换活动小说不能改变已有导入目标；取消后的迟到结果不能复活任务。当前文档不宣称这些场景已全部通过。

## 数据安全补修（2026-10-19，独立树）

用户线索与小说全文共同按偏移分片并保存完整分析来源；不再截断 sourceHints。正文片段上限 40000 字符，整个请求（提示、来源、上下文）上限 60000 字符，超限显式失败。分析按原文偏移分片，超长单段也继续拆分；每片最多 3 个分析任务，后一片在前片完成后生成上下文。`.mana/analysis-progress.json` 按输入指纹保存原始分片结果，重试可复用完整片段。`.mana/analysis-results.json` 保留失败与截断恢复对象；完整、部分、失败分别呈现。部分 JSON 不能当作完整类别覆盖暂存资料，空结果不清除已有有效世界观/时间线。人物、派系、世界观和事件生成候选事实审阅；矛盾字段不采用首值，用户逐项选择或拒绝后才进入暂存领域文件。拒绝新实体身份不会产生无名角色。未完成的审阅在 Saga 的合并/提升和直接提升入口均被阻止。重新打开导入从磁盘恢复取舍和保存目录；已有提交计划恢复原基线，不重新构造计划。

世界观统一保留 lore、timeSetting、location、society、rules、places 和二创元数据；正文设定汇入 lore，完整结构写入 world/meta.json，提升保留这些文件。原作未知为 null。原文未出现的时间线事件不得生成，第一人称不等于主角。

合并审阅列出新增及冲突的角色、世界观/地点、章节、派系、时间线、分层大纲、文风和已有暂存文本资源。地点按完整 JSON 集合审阅，以保留结构字段。每项绑定审阅时的正式文件版本；变化使该项重新待审，不能在提交时替换基线。session、逐项取舍、文件计划和 receipt 保存于用户数据目录的 import-merge-sessions；兼容 IPC 与 ImportSaga 使用同一 session/receipt。提交使用共同存储事务与实际写入意图恢复，规则唯一正文见 [存储事务与审阅契约](data-and-editor.md#存储事务与审阅契约)。每项保存都有正式读回，零写入仅允许明确保留现有内容；空计划报错。

本轮证据及未验证边界见 [数据导入安全审计](../artifacts/data-import-safety-audit/report.md)。

### 取舍与执行材料的边界

事实审阅记录是候选与选择的来源；merge session 是资源基线、选择与执行回执的来源，均不拥有导入终态。它们的公共修改 API 经过运行命令，材料修改处于其自己的文件事务中，直到运行 revision 栅栏保存后才提交。若栅栏保存失败，未确认的材料/领域修改回滚；进程中断可能保守地推进 revision 再回滚材料，旧准备结果因此失效，不能据缓存摘要授权提交。公共 session 读取先恢复材料日志，summary 是投影。

合并准备只在内存构造文件计划；目标版本检查和 decideCommit 成功后才保存计划。stale baseline 通过命令把对应资源恢复待审，不静默重定取舍。正式目标锁在更新应用/暂存投影之前释放，避免与普通元数据保存形成相反锁序。

schema 1 运行只在首次修改命令中升级。旧提升 committing/committed 记录通过运行命令接管；旧合并必须有与计划指纹匹配的共同文件事务回执，才能接管为已完成。冲突或损坏身份停止恢复。物理检查点尚未更新时，从运行中的完整提交决定续交；物理 cancelled、暂存状态或本地 Map 均不能覆盖该决定。丢弃与过期清理先经过权威取消/恢复，再处理暂存资料。
