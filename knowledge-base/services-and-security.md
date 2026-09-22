# 周边服务与安全边界

此页描述代码职责，不报告实时部署状态。旧文档中的 release-blocked、已轮换或已上线结论不能在没有新证据时继承。

## 反馈与同步

[反馈 IPC](../src/main/ipc/feedback.js) 收集用户反馈及按选项提供的附件，处理截图和敏感设置脱敏，写入 [feedbackOutbox](../src/main/store/feedbackOutbox.js)。[反馈同步](../src/main/sync/feedbackSyncWorker.js) 通过 [relayClient](../src/main/sync/relayClient.js) 异步提交；反馈 IPC 还支持列出、查询和重试。

本地 outbox 写入成功与远端飞书提交成功是两个状态。上传 checkpoint、重复 feedbackId、附件 hash 和重试结果应明确归属同一记录。未经实际同步回执不能显示远端成功。

Relay 的 Cloudflare / SCF 入口位于 [relay-worker](../relay-worker)，共享 relay-core 和 feishu-handlers。服务端配置与客户端公共配置分离；客户端不能携带飞书服务端 Secret 或旧共享认证密钥。具体 endpoint 和认证细节以共享核心及 contract tests 为准，不把密钥写进本页。

## 许可、更新与局域网

[license](../src/main/license) 负责许可验证与开发认证引导；[updater](../src/main/updater) 负责版本检查与下载。代码存在不能证明生产认证服务或发布源可用。

[remoteServer](../src/main/lan/remoteServer.js) 和 [ipcBridge](../src/main/lan/ipcBridge.js) 提供 LAN 访问；bridge 注册了处理器不等于这些处理器可向未认证远端开放。验收需覆盖访问码/会话、允许调用范围、文件访问、事件身份以及桌面和远端同时操作。

## 安全要求与操作边界

- 密钥只由宿主 secrets 与服务端环境持有；日志、截图、反馈、安装包和模型上下文必须检查敏感内容。
- 资源路径与项目目录关系必须验证；用户给出的导入正文、网页和模型输出均不能成为任意宿主命令。
- 提权、证书操作、生产发布、凭据轮换和历史重写是单独运维动作，不因读到知识库就自动执行。
- 发现泄漏后保留证据并安排撤销/轮换与清理；不要通过删除当前文件声称历史泄漏已解决。

可用扫描与发布入口见 [开发与发布](development-and-release.md)。本次知识库重建没有执行生产检查、密钥轮换、Git 历史改写或部署。
