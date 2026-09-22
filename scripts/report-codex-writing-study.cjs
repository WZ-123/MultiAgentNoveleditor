'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('artifacts/codex-luna-medium-100k-2026-09-05');
const report = JSON.parse(fs.readFileSync(path.join(root, 'progress.json'), 'utf8'));
const results = fs.readFileSync(path.join(root, 'commands-results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const starts = fs.readFileSync(path.join(root, 'commands-starts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const totals = report.tasks.reduce((sum, task) => {
  sum.durationMs += task.durationMs || 0;
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) sum[key] = (sum[key] || 0) + (task.usage[key] || 0);
  return sum;
}, { durationMs: 0 });
const first = starts.find(x => x.action === 'turn');
const last = results.at(-1);
const elapsedMs = Date.parse(last.timestamp) - Date.parse(first.timestamp);
const fmt = value => Number(value).toLocaleString('en-US');
const selected = ['luna-chapters-011-013', 'luna-chapters-014-016', 'luna-chapters-017-020', 'luna-chapters-021-023', 'luna-chapters-024-026', 'luna-chapters-027-030-finale'];
const table = selected.map(id => report.tasks.find(x => x.id === id)).map(x => `| ${x.id.replace('luna-chapters-', '')} | ${(x.durationMs / 1000).toFixed(1)} | ${fmt(x.cjkGrowth)} | ${x.confirmations} | ${x.toolErrors.length} | ${fmt(x.usage.total_tokens)} |`).join('\n');
const toolErrors = report.tasks.flatMap(task => task.toolErrors);
const paragraphs = new Map();
for (const chapter of report.chapters) {
  const text = fs.readFileSync(path.join(root, 'novel/chapters', chapter.file), 'utf8');
  for (const paragraph of text.split(/\n\s*\n/u).map(x => x.replace(/\s/gu, '')).filter(x => (x.match(/[\u3400-\u9fff]/gu) || []).length >= 60)) {
    paragraphs.set(paragraph, [...(paragraphs.get(paragraph) || []), chapter.file]);
  }
}
const duplicates = [...paragraphs.entries()].filter(([, files]) => files.length > 1).map(([text, files]) => ({ text, files }));
const final = { generatedAt: new Date().toISOString(), model: report.model, effort: report.effort, bodyCjk: report.bodyCjk, chapters: report.chapters.length, totals, elapsedMs, toolErrorCount: toolErrors.length, patchVerificationFailureCount: toolErrors.filter(x => x.includes('apply_patch verification failed')).length, duplicateLongParagraphGroups: duplicates.length, duplicates };
fs.writeFileSync(path.join(root, 'final-metrics.json'), JSON.stringify(final, null, 2) + '\n');
const text = `# Codex 登录态 Luna medium 十万字流程验证

已形成30章验证稿，净正文 **${fmt(report.bodyCjk)}汉字**。前期DeepSeek稿件保留，后续真实生成和编辑均使用Codex登录态的gpt-5.6-luna、medium思考强度；逐章来源与hash见manuscript-provenance.json。正文、设定、角色卡、推理和测试日志分别计数，不以API token数代替小说字数。

用户反馈此前DeepSeek实验花费约30元；本次没有查询账单，不能将日志token折算为准确金额。用户已明确授权使用本机Codex登录态及向Luna发送现有稿件。本阶段使用订阅账户，不继续调用DeepSeek。

## 测试方式与边界

使用静音Electron生产构建界面、真实小说MCP工具、原生补丁确认、实际文件提交与编辑器。项目旧mock开关的实现已移除，本次通过专用测试宿主替换模型路由，使用真实登录和真实模型，不伪造正文或工具结果。它验证应用在Luna下的流程，不能宣称DeepSeek十万字生产验证已经通过，也不表示已恢复面向用户的mock设置开关。

首轮项目sidecar 0.149.0缺少code-mode-host，Luna调用工具三次均失败，134.5秒后仅返回无法工作。改用本机Codex 0.153.0与配套code-mode-host；同时采用系统已有代理。直接连接订阅服务12秒超时，使用代理约1秒得到正常的未认证401响应。随后真实登录生成成功。

所有失败、重试和修正均追加记录。原生turn completed只表示模型回合结束，不自动算任务通过。第10章首次成功保存后，模型仍错误地要求再次批准，且没有完成约定读回，已作为流程缺陷保留。

## 实测性能

| 写作批次 | 秒 | 新增资源汉字（含标题） | 确认次数 | 工具错误 | 已知累计token（含缓存） |
| --- | ---: | ---: | ---: | ---: | ---: |
${table}

第11—16章使用较短输出默认值和较多逐章字数约束。第17章起同时采用新对话、高输出详细度（思考仍为medium）、整批篇幅验收、limit:1核对完整计数、避免小段追凑的提示。多个变量同时变化，章节内容也不同，不是严格单变量A/B。

优化后若干批次由10—11次确认降至2—3次；但结局批次仍达8次确认、约9分钟，不能宣称空转完全消失。首次可见补丁仍可能等待数分钟，整批长文生成对用户的可见进度有明显限制。

本阶段${report.tasks.length}个模型回合累计 **${(totals.durationMs / 60000).toFixed(1)}分钟**。从首个测试回合启动至最后记录约 **${(elapsedMs / 60000).toFixed(1)}分钟**，两者差额包括诊断、重启和外层分析等待。已知累计usage ${fmt(totals.total_tokens)} tokens，其中输入${fmt(totals.input_tokens)}（缓存${fmt(totals.cached_input_tokens)}）、输出${fmt(totals.output_tokens)}（推理${fmt(totals.reasoning_output_tokens)}）。这些不是新增文本量、准确账单或模型纯生成耗时。

## 原因与修正

1. **运行组件和模型工具模式不匹配。** 接上App Server不保证其配套执行宿主齐全。Luna使用code mode，首轮因此没有任何正文进展。
2. **写作粒度与验收条件诱发小补丁循环。** 第14章连续追加很短的收尾段，每次再次计数。它们不是网络故障，却增加往返并破坏节奏。已改为整批验收和完整场景补充，仍需持续观察。
3. **计数字段正确，使用方式仍浪费。** 为计数重复返回刚写的全文会使上下文增长。现明确说明limit:1也返回完整资源的字数与hash；模型需要实际内容时才展开正文。原生写后读回归测试通过。
4. **正文事实与总纲不同步。** 首次审校将过时总纲直接当成正文硬矛盾。补足证据后改判为资料版本冲突，按正文同步总纲；同时真实修正第20章提前叙写到10点、第21章又从7点开始的时间重叠。
5. **审校的完成声明不可靠。** 首轮声称通读30章，实际只有14章能在模型可见工具输出中找到完整正文；部分章节只被store保存或显示章首。只补看遗漏16章后，精确全文匹配验证30/30覆盖。覆盖证明内容可见，不证明模型一定理解正确。
6. **修改后宣称关闭仍可能漏项，精确补丁也会反复失败。** 模型报告已删除旧时间节点，实际总纲另有残留。最后只修三个残留位置，仍花143.2秒、累计2,983,438 tokens（含缓存），出现7次补丁匹配失败。模型手写原文锚点时弄错空格、引号/反斜杠或Markdown列表符号，无法满足精确匹配；反复读回和重试继续放大上下文。最终保存成功，未重新审全书。本阶段共记录22次工具错误：3次缺少执行宿主、19次补丁验证失败。这里包括局部去AI编辑的一次失败，成功结果不能抹掉这些无效往返。
7. **外层测试编排也有责任。** 最后四章的固定批次目标高于全书剩余字数，导致超过十万字后继续补写。后续应按剩余总量动态分配篇幅，不把固定分章目标当成额外交付门槛。

统计本身也需校验：Codex 0.153的部分工具输出是文本块数组，最初只解析字符串的统计脚本会漏记错误。本报告已同时解析两种格式，重新从原始日志汇总上述22次错误，取代中途可能出现的“无工具错误”判断。审校覆盖30/30的hash记录对应定点修正前稿件；后续修改另行读回，最终稿hash以manuscript-provenance.json为准。

## 已执行的体验步骤

- 真实Luna登录接入、medium参数与运行事件记录。
- 从第10章继续写到第30章，正式保存、字数核对及编辑器打开。
- 总纲维护、角色记忆更新；第二幕与第三幕各三人的场景推演。第一幕三人推演在前一DeepSeek阶段已执行。
- 第8章视角改写；第14章局部去AI；第30章元叙事清理。候选最小改动校验、原生确认及提交实际执行。
- 一轮全书硬性一致性检查加遗漏覆盖补足；定点处理证据正反面/抄本关系、章节时间顺序和总纲节点。没有每改一句便重审全部章节。
- 净正文计数、逐章来源hash、全文汇编。长度至少60汉字的完全相同段落组：${duplicates.length}；这只是机械重复检查，不等于文学质量验收。

这些结果证明流程可以完成，也暴露仍需改进的模型判断、输出进度和验收可靠性。它不是出版级文学质量证明，也不能拿Luna的耗时替代DeepSeek性能结论。

## 证据

正文：逆光档案-十万字验证稿.md；provenance：manuscript-provenance.json；指标：progress.json、final-metrics.json；原始事件：commands-results.jsonl、ui-events.jsonl、ui-confirmations.jsonl、native-requests.jsonl及隔离Codex sessions；审校：consistency-review.md、consistency-review-supplement.md、consistency-fixes.md、consistency-residual-fix.md、review-coverage.json、review-fulltext-coverage.json。原始模型报告保留不准确声明，须结合本报告及修正记录解读。
`;
fs.writeFileSync(path.join(root, 'analysis.md'), text);
console.log(JSON.stringify({ bodyCjk: report.bodyCjk, tasks: report.tasks.length, modelMinutes: +(totals.durationMs / 60000).toFixed(1), elapsedMinutes: +(elapsedMs / 60000).toFixed(1), tokens: totals.total_tokens, duplicateGroups: duplicates.length }));
