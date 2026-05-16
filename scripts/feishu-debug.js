'use strict';

/**
 * Feishu / Lark Bitable debug script for developers.
 *
 * Usage:
 *   node scripts/feishu-debug.js --action=show-config
 *   node scripts/feishu-debug.js --action=configure --appId=xxx --appSecret=xxx --appToken=xxx --tableId=xxx --enabled=true
 *   node scripts/feishu-debug.js --action=verify
 *   node scripts/feishu-debug.js --action=list-fields
 *   node scripts/feishu-debug.js --action=ensure-schema
 *   node scripts/feishu-debug.js --action=playout --feedbackId=fb-xxx
 *   node scripts/feishu-debug.js --action=smoke
 *   node scripts/feishu-debug.js --action=smoke --feedbackId=fb-xxx
 *
 * Config sources (highest priority first):
 *   1. CLI args: --key=value or --key value
 *   2. Environment variables
 *   3. app-config.json -> feishuSync
 *
 * Environment variables:
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID
 */

const path = require('node:path');

// Allow running from project root
const projectRoot = path.resolve(__dirname, '..');
process.env.MANA_USER_DATA_ROOT = process.env.MANA_USER_DATA_ROOT || path.join(process.env.HOME || '/tmp', 'Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant');

const feishuAdapter = require(path.join(projectRoot, 'src/main/feishu/feishuAdapter'));
const fieldMapper = require(path.join(projectRoot, 'src/main/feishu/fieldMapper'));
const feedbackOutbox = require(path.join(projectRoot, 'src/main/store/feedbackOutbox'));
const appConfig = require(path.join(projectRoot, 'src/main/store/appConfig'));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const raw = args[i].slice(2);
      const eqIndex = raw.indexOf('=');
      const key = eqIndex >= 0 ? raw.slice(0, eqIndex) : raw;
      const inlineValue = eqIndex >= 0 ? raw.slice(eqIndex + 1) : null;
      const value = inlineValue != null
        ? inlineValue
        : args[i + 1] && !args[i + 1].startsWith('--')
          ? args[i + 1]
          : 'true';
      out[key] = value;
      if (inlineValue == null && value !== 'true') i += 1;
    }
  }
  return out;
}

async function getConfig(args) {
  const saved = await appConfig.load();
  const savedFeishuSync = saved?.feishuSync && typeof saved.feishuSync === 'object' ? saved.feishuSync : {};
  return {
    appId: args.appId || process.env.FEISHU_APP_ID || savedFeishuSync.appId || '',
    appSecret: args.appSecret || process.env.FEISHU_APP_SECRET || savedFeishuSync.appSecret || '',
    appToken: args.appToken || process.env.FEISHU_APP_TOKEN || savedFeishuSync.appToken || '',
    tableId: args.tableId || process.env.FEISHU_TABLE_ID || savedFeishuSync.tableId || '',
    endpointProfile: args.endpointProfile || process.env.FEISHU_ENDPOINT_PROFILE || savedFeishuSync.endpointProfile || 'dev',
    enabled: String(args.enabled || '').toLowerCase() === 'true' || !!savedFeishuSync.enabled,
    configSource: {
      appId: args.appId ? 'arg' : process.env.FEISHU_APP_ID ? 'env' : savedFeishuSync.appId ? 'app-config' : 'missing',
      appSecret: args.appSecret ? 'arg' : process.env.FEISHU_APP_SECRET ? 'env' : savedFeishuSync.appSecret ? 'app-config' : 'missing',
      appToken: args.appToken ? 'arg' : process.env.FEISHU_APP_TOKEN ? 'env' : savedFeishuSync.appToken ? 'app-config' : 'missing',
      tableId: args.tableId ? 'arg' : process.env.FEISHU_TABLE_ID ? 'env' : savedFeishuSync.tableId ? 'app-config' : 'missing',
    },
  };
}

function validateConfig(cfg) {
  const missing = [];
  if (!cfg.appId) missing.push('appId');
  if (!cfg.appSecret) missing.push('appSecret');
  if (!cfg.appToken) missing.push('appToken');
  if (!cfg.tableId) missing.push('tableId');
  if (missing.length > 0) {
    console.error('Missing required config:', missing.join(', '));
    console.error('Provide via CLI args, FEISHU_* env vars, or app-config.json -> feishuSync');
    process.exit(1);
  }
}

function printConfigSources(cfg) {
  console.log('Config source summary:');
  console.log(`  appId: ${cfg.configSource.appId}`);
  console.log(`  appSecret: ${cfg.configSource.appSecret}`);
  console.log(`  appToken: ${cfg.configSource.appToken}`);
  console.log(`  tableId: ${cfg.configSource.tableId}`);
  console.log(`  endpointProfile: ${cfg.endpointProfile}`);
  console.log(`  enabled: ${cfg.enabled ? 'true' : 'false'}`);
}

function printConfigPresence(cfg) {
  console.log('Current effective config (presence only):');
  console.log(`  appId: ${cfg.appId ? 'set' : 'missing'}`);
  console.log(`  appSecret: ${cfg.appSecret ? 'set' : 'missing'}`);
  console.log(`  appToken: ${cfg.appToken ? 'set' : 'missing'}`);
  console.log(`  tableId: ${cfg.tableId ? 'set' : 'missing'}`);
  console.log(`  endpointProfile: ${cfg.endpointProfile}`);
  console.log(`  enabled: ${cfg.enabled ? 'true' : 'false'}`);
}

async function actionShowConfig(cfg) {
  printConfigSources(cfg);
  printConfigPresence(cfg);
}

async function actionConfigure(args) {
  const current = await appConfig.load();
  const currentFeishu = current?.feishuSync && typeof current.feishuSync === 'object' ? current.feishuSync : {};
  const nextFeishu = {
    ...currentFeishu,
    ...(args.appId ? { appId: args.appId } : {}),
    ...(args.appSecret ? { appSecret: args.appSecret } : {}),
    ...(args.appToken ? { appToken: args.appToken } : {}),
    ...(args.tableId ? { tableId: args.tableId } : {}),
    ...(args.endpointProfile ? { endpointProfile: args.endpointProfile } : {}),
    ...(args.enabled !== undefined ? { enabled: String(args.enabled).toLowerCase() === 'true' } : {}),
    ...(args.relayUrl !== undefined ? { relayUrl: args.relayUrl } : {}),
    ...(args.relayApiKey !== undefined ? { relayApiKey: args.relayApiKey } : {}),
  };

  await appConfig.save({ feishuSync: nextFeishu });
  const effective = await getConfig({});
  console.log('Feishu sync config saved to app-config.json');
  printConfigPresence(effective);
}

async function actionVerify(cfg) {
  console.log('Verifying Feishu credentials and table access...');
  printConfigSources(cfg);
  try {
    const { token } = await feishuAdapter.getTenantAccessToken(cfg.appId, cfg.appSecret);
    console.log('Token: OK (retrieved successfully)');

    const fields = await feishuAdapter.getTableFields(cfg.appToken, cfg.tableId, token);
    console.log(`Table fields (${fields.length}):`);
    for (const f of fields) {
      console.log(`  - ${f.field_name} (${f.type})`);
    }
    console.log('Verify: PASSED');
  } catch (err) {
    console.error('Verify: FAILED -', err.message);
    if (err.feishuError) {
      console.error('  Feishu code:', err.feishuError.code);
      console.error('  HTTP status:', err.feishuError.httpStatus);
    }
    process.exit(1);
  }
}

async function actionListFields(cfg) {
  try {
    printConfigSources(cfg);
    const { token } = await feishuAdapter.getTenantAccessToken(cfg.appId, cfg.appSecret);
    const fields = await feishuAdapter.getTableFields(cfg.appToken, cfg.tableId, token);
    console.log(JSON.stringify(fields, null, 2));
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
}

function buildSchemaTemplateRecord() {
  const createdAt = new Date().toISOString();
  return {
    feedbackId: 'schema-template',
    createdAt,
    syncStatus: 'pending',
    payload: {
      feedbackId: 'schema-template',
      createdAt,
      channel: 'quick-feedback-schema-template',
      userInput: {
        issueTitle: 'schema-template',
        actualBehavior: 'schema-template',
        feedbackMode: 'context-with-logs',
        severity: 'medium',
      },
      environment: {
        appVersion: 'schema-template',
        platform: process.platform,
        activeRuntimeDriver: 'direct-api',
        activeProviderType: 'anthropic',
        activeModel: 'schema-template',
      },
      novelContext: {
        activeNovelId: 'schema-template',
      },
      editorContext: {
        activeChapterName: 'schema-template',
        activeChapterTitle: 'schema-template',
      },
      chatContext: {
        activeThread: { id: 'schema-template' },
        currentSessionId: 'schema-template',
        currentSessionStatus: 'idle',
      },
      errors: {
        latestUiError: 'schema-template',
        latestMainProcessError: 'schema-template',
        latestChatAgentError: 'schema-template',
      },
      attachments: [],
    },
  };
}

function getRequiredSchemaFields() {
  const mappedFields = fieldMapper.toBitableFields(buildSchemaTemplateRecord());
  return [
    ...Object.keys(mappedFields).sort().map((fieldName) => ({
      field_name: fieldName,
      type: 1,
      property: null,
    })),
    {
      field_name: 'screenshot',
      type: 17,
      property: null,
    },
  ];
}

async function actionEnsureSchema(cfg, args) {
  console.log('Ensuring Feishu table schema...');
  printConfigSources(cfg);

  const requiredFields = getRequiredSchemaFields();
  const { token } = await feishuAdapter.getTenantAccessToken(cfg.appId, cfg.appSecret);
  const liveFields = await feishuAdapter.getTableFields(cfg.appToken, cfg.tableId, token);
  const liveByName = new Map(liveFields.map((field) => [field.field_name, field]));

  const missingFields = requiredFields.filter((field) => !liveByName.has(field.field_name));
  const mismatchedFields = requiredFields
    .map((field) => ({ expected: field, live: liveByName.get(field.field_name) || null }))
    .filter(({ expected, live }) => live && live.type !== expected.type)
    .map(({ expected, live }) => ({
      fieldName: expected.field_name,
      expectedType: expected.type,
      liveType: live.type,
    }));

  console.log(`Required fields: ${requiredFields.length}`);
  console.log(`Live fields: ${liveFields.length}`);
  console.log(`Missing fields: ${missingFields.length}`);
  if (missingFields.length > 0) {
    console.log(`  ${missingFields.map((field) => `${field.field_name}(${field.type})`).join(', ')}`);
  }

  if (mismatchedFields.length > 0) {
    console.error('Type mismatch detected:');
    for (const mismatch of mismatchedFields) {
      console.error(`  ${mismatch.fieldName}: expected ${mismatch.expectedType}, live ${mismatch.liveType}`);
    }
    process.exit(1);
  }

  const dryRun = String(args.dryRun || args.plan || '').toLowerCase() === 'true';
  if (dryRun || missingFields.length === 0) {
    console.log(dryRun ? 'Ensure-schema: DRY RUN complete' : 'Ensure-schema: table already matches expected schema');
    return;
  }

  for (const field of missingFields) {
    const created = await feishuAdapter.createField(cfg.appToken, cfg.tableId, token, field);
    console.log(`Created field: ${created.field_name} (${created.type})`);
  }

  const refreshedFields = await feishuAdapter.getTableFields(cfg.appToken, cfg.tableId, token);
  console.log(`Ensure-schema: PASSED (${refreshedFields.length} fields visible)`);
}

async function actionPlayout(cfg, args) {
  let feedbackId = args.feedbackId;
  if (feedbackId === 'latest') {
    const records = await feedbackOutbox.listAllRecords();
    feedbackId = records[0]?.feedbackId || '';
  }
  if (!feedbackId) {
    console.error('Missing --feedbackId');
    process.exit(1);
  }

  const record = await feedbackOutbox.getRecord(feedbackId);
  if (!record) {
    console.error(`Feedback ${feedbackId} not found in outbox`);
    process.exit(1);
  }

  console.log('Loaded record:', record.feedbackId);
  console.log('Current syncStatus:', record.syncStatus);

  try {
    const { token } = await feishuAdapter.getTenantAccessToken(cfg.appId, cfg.appSecret);

    // Upload attachments if present
    let attachmentTokens = [];
    const screenshotAttachment = record.payload?.attachments?.find(
      (a) => a.kind === 'window-screenshot' && a.localPath
    );
    if (screenshotAttachment) {
      console.log('Uploading attachment:', screenshotAttachment.localPath);
      const uploadResult = await feishuAdapter.uploadAttachment(cfg.appToken, screenshotAttachment.localPath, token);
      attachmentTokens.push(uploadResult.fileToken);
      console.log('Attachment uploaded, fileToken:', uploadResult.fileToken);
    }

    // Build fields and create record
    const fields = fieldMapper.toBitableFields(record);
    if (attachmentTokens.length > 0) {
      fields.screenshot = fieldMapper.toAttachmentField(attachmentTokens);
    }

    console.log('Creating record with fields:', Object.keys(fields));
    const createResult = await feishuAdapter.createRecord(cfg.appToken, cfg.tableId, token, fields);
    console.log('Record created:', createResult.recordId);
  } catch (err) {
    console.error('Playout failed:', err.message);
    if (err.feishuError) {
      console.error('  Feishu code:', err.feishuError.code);
      console.error('  Type:', err.feishuError.type);
    }
    process.exit(1);
  }
}

function buildSmokeRecord() {
  const createdAt = new Date().toISOString();
  return {
    feedbackId: `smoke-${Date.now().toString(36)}`,
    createdAt,
    syncStatus: 'pending',
    payload: {
      feedbackId: `smoke-${Date.now().toString(36)}`,
      createdAt,
      channel: 'quick-feedback-smoke',
      userInput: {
        issueTitle: '[SMOKE] Feishu sync verification',
        actualBehavior: 'Synthetic smoke record created by scripts/feishu-debug.js',
        feedbackMode: 'opinion-only',
        severity: 'low',
      },
      environment: {
        appVersion: 'smoke',
        platform: process.platform,
        activeRuntimeDriver: 'smoke',
        activeProviderType: 'smoke',
      },
      novelContext: {
        activeNovelId: '',
      },
      editorContext: {
        activeChapterName: '',
      },
      chatContext: {
        currentSessionId: '',
      },
      errors: {},
      attachments: [],
    },
  };
}

async function actionSmoke(cfg, args) {
  console.log('Running Feishu smoke test...');
  printConfigSources(cfg);
  const { token } = await feishuAdapter.getTenantAccessToken(cfg.appId, cfg.appSecret);
  console.log('Smoke step 1/3: token OK');

  const fields = await feishuAdapter.getTableFields(cfg.appToken, cfg.tableId, token);
  console.log(`Smoke step 2/3: table OK (${fields.length} fields visible)`);

  if (args.feedbackId) {
    console.log(`Smoke step 3/3: replaying feedback ${args.feedbackId}`);
    await actionPlayout(cfg, args);
    return;
  }

  const smokeRecord = buildSmokeRecord();
  const mappedFields = fieldMapper.toBitableFields(smokeRecord);
  const result = await feishuAdapter.createRecord(cfg.appToken, cfg.tableId, token, mappedFields);
  console.log(`Smoke step 3/3: synthetic record created (${result.recordId})`);
  console.log('Smoke: PASSED');
}

async function main() {
  const args = parseArgs();
  const action = args.action || 'verify';

  if (action === 'configure') {
    await actionConfigure(args);
    return;
  }

  const cfg = await getConfig(args);

  if (action === 'show-config') {
    await actionShowConfig(cfg);
    return;
  }

  if (action === 'list-fields') {
    validateConfig(cfg);
    await actionListFields(cfg);
    return;
  }

  if (action === 'ensure-schema') {
    validateConfig(cfg);
    await actionEnsureSchema(cfg, args);
    return;
  }

  if (action === 'playout') {
    validateConfig(cfg);
    await actionPlayout(cfg, args);
    return;
  }

  if (action === 'smoke') {
    validateConfig(cfg);
    await actionSmoke(cfg, args);
    return;
  }

  // Default: verify
  validateConfig(cfg);
  await actionVerify(cfg);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
