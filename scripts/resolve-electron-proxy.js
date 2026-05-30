'use strict';

const { app, session } = require('electron');

async function main() {
  const target = process.argv[2] || 'https://example.com';
  await app.whenReady();
  try {
    const raw = await session.defaultSession.resolveProxy(target);
    const line = String(raw || '').trim();
    if (!line || /^DIRECT$/i.test(line)) {
      console.log('');
      app.exit(0);
      return;
    }
    const match = line.match(/PROXY\s+([^\s;]+)/i);
    const value = match ? match[1] : line;
    console.log(value);
    app.exit(0);
  } catch (err) {
    console.error(err.message || String(err));
    app.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  app.exit(1);
});
