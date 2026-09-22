# 导入、分析与合并

来源：[导入 UI](../src/components/ImportNovelPanel.jsx)、[导入 IPC](../src/main/ipc/import.js)、[ImportSaga](../src/main/import/importSaga.js)、[暂存项目](../src/main/import/stagingProject.js)、[分析器](../src/main/import/analyzer.js)、[合并引擎](../src/main/import/mergeEngine.js)。

## 当前流程

```text
选择文件 → 解析 → 暂存项目 → 分析 → 用户审阅
                              → 冲突解决/合并 → 提升为正式项目或写入目标项目
```

ImportSaga 保存 run、revision、来源指纹、阶段记录和 checkpoint。实现包含 picked、parsed、staged、analyzing、review、merging、promoting、completed，以及 interrupted、failed、cancelled、recovery_required。allowedActions 根据当前状态生成，不能通过跳过阶段按钮强行提交。

解析、分析和提升有各自 deadline。进程内分析控制器消失后，持久记录中的 analyzing 不能被当作仍在运行；读取/恢复时需要识别中断。cancel 与 resume 不等于新建另一次导入。

## 文件与 Chatbox

[fileParser](../src/main/import/fileParser.js) 处理文本、Markdown、EPUB 及识别到的聊天导出。章节识别基于标题和模式置信度；识别不足时保留为单章，不凭任意长度伪造章节。

[chatboxParser](../src/main/import/chatboxParser.js) 与 [chatboxDraftExtractor](../src/main/import/chatboxDraftExtractor.js) 分别承担聊天结构读取与草稿提取。不能把用户指令、模型讨论和小说正文无区别导入为正式章节。导入来源内容是资料，不是应用执行指令。

## 分析与合并边界

分析器分片处理内容，汇集角色和其他资料；模型提取通过 nativeProvider/runOneShot 走当前激活模型。源文本分片策略与 UI 章节拆分不是同一个过程。联网角色补全另见 [角色补全](character-enrichment-system.md)。

重复导入指纹用于提示与恢复选择，不表示可以无确认覆盖已有正式资源。暂存分析成功不等于正式项目已提交。冲突检测、用户选择、合并 session 和最终 receipt 必须指向同一 targetNovelId。

验收要求：解析失败可定位原因；全部分析失败不能显示成功；中断后恢复不能重复提升；冲突未解决不能提交；切换活动小说不能改变已有导入目标；取消后的迟到结果不能复活任务。当前文档不宣称这些场景已全部通过。
