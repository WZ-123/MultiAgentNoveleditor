# Cloudflare Worker 反馈中继部署指南

## 前置条件

1. 安装 Node.js 18+
2. 注册 [Cloudflare](https://dash.cloudflare.com) 账号
3. 安装 Wrangler CLI：
   ```bash
   npm install -g wrangler
   ```
4. 登录 Cloudflare：
   ```bash
   wrangler login
   ```

## 第一步：配置环境变量

创建 `.dev.vars` 用于本地开发：

```bash
cd relay-worker
cat > .dev.vars << 'EOF'
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_APP_TOKEN=xxx
FEISHU_TABLE_ID=xxx
FEISHU_AUTH_TABLE_ID=xxx
RELAY_API_KEY=your-relay-api-key
EOF
```

**`.dev.vars` 只在本地开发使用，不会上传到 Cloudflare。**

## 第二步：部署并设置生产环境变量

```bash
cd relay-worker

# 1. 安装依赖
npm install

# 2. 部署 Worker（首次部署会自动创建）
npm run deploy

# 3. 设置生产环境 Secrets（每个变量单独设置，加密存储）
wrangler secret put FEISHU_APP_ID
wrangler secret put FEISHU_APP_SECRET
wrangler secret put FEISHU_APP_TOKEN
wrangler secret put FEISHU_TABLE_ID
wrangler secret put FEISHU_AUTH_TABLE_ID
wrangler secret put RELAY_API_KEY
```

每次输入后按提示填入值即可。

## 第三步：验证部署

```bash
# 查看 Worker 日志
wrangler tail

# 在另一个终端测试
npm test
```

## 第四步：配置客户端

拿到 Workers 分配的域名（如 `https://feedback-relay.your-account.workers.dev`），配置到客户端：

```bash
node scripts/feishu-debug.js --action=configure \
  --relayUrl=https://feedback-relay.your-account.workers.dev \
  --relayApiKey=your-relay-api-key \
  --enabled=true
```

## GitHub Actions 自动部署（可选）

项目根目录已有 `.github/workflows/deploy-relay.yml`。只需在 GitHub 仓库设置两个 Secrets：

| Secret | 获取方式 |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右侧栏可见 |

配置完成后，每次 `git push` 到 `main` 分支且修改了 `relay-worker/` 目录时，自动触发部署。

## 费用说明

Cloudflare Workers 免费额度：
- **每天 10 万次请求** —— 内测场景完全够用
- **每次请求最多 10ms CPU 时间** —— I/O 等待不计入，实际够用
- **KV / Durable Objects** —— 本方案未使用，不需要

超出免费额度后：$0.50 / 百万请求。

## 与自建 relay-server 的对比

| 维度 | Cloudflare Workers | 自建 VPS |
|------|-------------------|---------|
| 部署复杂度 | `npm run deploy` | 需配置服务器、域名、SSL |
| 运维成本 | 零 | 需维护、监控、更新 |
| 全球延迟 | 边缘节点，低 | 取决于 VPS 位置 |
| 费用 | 免费额度内零成本 | 最低 ~99元/年 |
| 附件大小限制 | 100MB/请求 | 无实质限制 |
| 内网穿透 | 不需要 | 如 VPS 在国内需备案 |
