'use strict';

const { app, session, net } = require('electron');

async function main() {
  const target = process.argv[2] || 'https://chii.in';
  await app.whenReady();
  try {
    const proxy = await session.defaultSession.resolveProxy(target);
    console.log(`PROXY ${proxy}`);
  } catch (err) {
    console.log(`PROXY_ERR ${err.message || String(err)}`);
  }

  try {
    const res = await net.fetch(target, {
      method: 'GET',
      headers: {
        'User-Agent': 'MultiAgentNovelAssistant/1.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const text = await res.text();
    console.log(`FETCH_STATUS ${res.status}`);
    console.log(`FETCH_LEN ${text.length}`);
    console.log(text.slice(0, 400).replace(/\s+/g, ' '));
  } catch (err) {
    console.log(`FETCH_ERR ${err.message || String(err)}`);
  }

  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
