# 模型配置与能力验证

来源：[模型配置](../src/main/modelConfig/index.js)、[供应商模板](../src/main/modelConfig/providerTemplates.js)、[模型界面](../src/components/ProviderSettingsPanel.jsx)、[会话服务](../src/main/codex-runtime/codexSessionService.js)。当前持久配置 schema 是 **8**，不是旧总览中的 6。

## 配置组成

凭据、连接、模型和激活选择分开管理；连接包含地址、认证方式、查询参数、发现结果和模型能力。支持 API 连接与 Codex 订阅账户路径。迁移逻辑负责旧格式转换，不能把迁移输入视为已验证可用连接。

密钥由宿主 secrets 管理，不写进知识库、渲染日志或报告。连接参数及凭据版本变化后，旧验证结果不能继续证明新配置可用。

## 能力语义

- 模型发现用于获得候选模型，不等于生成请求成功。
- Responses 文本验证必须通过 App Server 的实际请求。
- 工具验证要求看到 `novel_tools.connection_probe` 的成功完成事件。文本提到工具名称不算通过。
- 验证按推理档位记录；UI 展示、验证和激活应使用相同档位。
- 工具探针只证明该次工具链成立，不能替代正式小说 apply_patch、批准与保存验收。
- 工具不可用时文本聊天仍有独立用途；但不能把小说修改请求静默当作可执行任务。

## 供应商兼容

DeepSeek 正式线程关闭 code mode，使用原生函数工具和 apply_patch；线程指纹包含对应协议版本。`reasoning=none` 还有 [无推理适配器](../src/main/codex-runtime/deepseekNoReasoningBridge.js)。因此“系统完全不存在 Responses 适配层”不是当前事实；该适配器也不构成第二套业务 agent loop。

正式模型运行、文本探针、工具探针和一次性提取任务的工具配置不完全相同。探针超时、失败和取消必须清理监听、定时器及临时线程；不能让验证回合的事件污染聊天窗口。

## 验收

配置保存失败、凭据轮换、迟到验证结果、运行中切换模型、未知档位、工具失败但文本可用、订阅登录失效均需验证。主要测试入口在 [开发与发布](development-and-release.md)。本页不声称任何外部供应商、账号或实时服务当前可用。
