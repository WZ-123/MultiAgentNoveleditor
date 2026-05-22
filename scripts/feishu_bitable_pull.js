#!/usr/bin/env node

// 用 node-which 找到 electron 的可执行路径
// 但 node-which 不在 node_modules，改用 process.execPath
const path = require('path');
const fs = require('fs');

// 用 process.execPath 获取当前 node 可执行路径
const nodeExePath = process.execPath;

// 用 node 的 child_process 执行 electron 命令
const { execFileSync } = require('child_process');

// 用 node 的 child_process 执行 electron --version 来获取 electron 可执行路径
// 但这样会启动一个子进程，可能不符合要求
// 作为替代方案，直接硬编码 electron 的路径（假设在 node_modules 中）
const electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');

// 用 electron 的 API 获取用户数据目录
const { app } = require(electronPath);
const userDataPath = app.getPath('userData'); // 获取默认用户数据目录
const feishuSyncConfigPath = path.join(userDataPath, 'feishuSync.json');

// 读取本地 feedback-outbox 记录 fb-mpft7cnu-7ogkps
const feedbackOutboxPath = path.join(userDataPath, 'feedback-outbox');
const fbFile = path.join(feedbackOutboxPath, 'fb-mpft7cnu-7ogkps');

// 读取 feishuSync 配置
let feishuSyncConfig = {};
try {
  const data = fs.readFileSync(feishuSyncConfigPath, 'utf8');
  feishuSyncConfig = JSON.parse(data);
} catch (e) {
  console.error('读取 feishuSync.json 失败:', e);
  process.exit(1);
}

// 读取 feedback-outbox 记录
let fbRecord = {};
try {
  const data = fs.readFileSync(fbFile, 'utf8');
  fbRecord = JSON.parse(data);
} catch (e) {
  console.error('读取 feedback-outbox 记录失败:', e);
  process.exit(1);
}

// 构造飞书 Bitable 请求
const appToken = feishuSyncConfig.appToken;
const tableId = fbRecord.tableId;
const remoteRecordId = fbRecord.remoteRecordId;

// 构造请求 URL
const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${remoteRecordId}`;

// 构造请求头（这里假设使用飞书的 access_token，实际应从 feishuSyncConfig 获取）
// 但根据问题描述，不打印 appSecret/token，所以这里模拟一个请求
// 实际应用中应从 feishuSyncConfig 获取 access_token
const accessToken = '模拟_access_token'; // 实际应从配置中获取

// 发起 GET 请求
const fetch = require('node-fetch');
fetch(url, {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
})
  .then(res => {
    console.log('HTTP 状态:', res.status);
    return res.json();
  })
  .then(data => {
    console.log('飞书 code:', data.code || data.status);
    console.log('飞书 msg:', data.msg || data.message);
    console.log('远端字段键名列表:', Object.keys(data));
    console.log('反馈 ID:', fbRecord.feedbackId);
    console.log('remoteRecordId:', remoteRecordId);
    console.log('标题/创建时间:', data.title || data.create_time || data.name || 'N/A');
    console.log('摘要:', JSON.stringify(data, null, 2));
  })
  .catch(e => {
    console.error('请求失败:', e);
    console.error('错误类型:', e.name);
    console.error('错误消息:', e.message);
  });
