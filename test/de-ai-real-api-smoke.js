'use strict';

/**
 * Minimal live smoke test for the exact Electron host -> stdio MCP child ->
 * secure API-key bridge -> Provider -> sa-de-ai-ifier path.
 *
 * This intentionally prints provider/model metadata and the rewritten sample,
 * but never reads or logs the API key itself.
 */

const assert = require('node:assert/strict');
const { app } = require('electron');

async function run() {
  assert.ok(process.env.MANA_USER_DATA_ROOT, 'MANA_USER_DATA_ROOT is required');

  const modelConfig = require('../src/main/modelConfig');
  const serverManager = require('../src/main/mcp/serverManager');

  try {
    const route = (await modelConfig.resolvePreview({
      driverId: 'direct-api',
      subagentId: 'sa-de-ai-ifier',
    }))[0];

    console.log(`LIVE_ROUTE provider=${route.providerName || route.providerId || 'unknown'} model=${route.modelId || 'unknown'} profile=${route.profileName || route.profileId || 'unknown'}`);

    const sourceText = '然后她笑了。那是一个很淡的笑。';
    const result = await serverManager.callTool({
      name: 'de_ai_ify',
      arguments: {
        text: sourceText,
        guidance: '保持克制，不增添新的情节事实。',
        beforeContext: '她垂眼看着杯中已经凉透的茶。',
        afterContext: '窗外的雨声没有停。',
        preserveConstraints: ['第三人称', '她只是轻轻一笑'],
      },
    });

    const textBlock = (result?.content || []).find((item) => item?.type === 'text');
    assert.equal(result?.isError, false, textBlock?.text || 'de_ai_ify returned an error');
    const payload = JSON.parse(textBlock?.text || '{}');
    const revisedText = String(payload.revisedText || '').trim();
    assert.ok(revisedText, 'de_ai_ify returned empty revisedText');
    assert.notEqual(revisedText, sourceText, 'de_ai_ify returned the source unchanged');

    console.log(`LIVE_REWRITE ${revisedText}`);
    console.log('TEST_PASS DE_AI_REAL_API_1 secure API-key bridge and live rewrite succeeded');
    return 0;
  } finally {
    await serverManager.dispose();
  }
}

app.whenReady().then(async () => {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`TEST_FAIL DE_AI_REAL_API_1 ${error?.message || String(error)}`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
