'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : process.platform === 'win32' ? path.join(root, 'node_modules/electron/dist/electron.exe') : path.join(root, 'node_modules/electron/dist/electron');
const child = spawn(executable, ['test/writing-workflow-ui-e2e.cjs', '--mute-audio'], { cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, MANA_DISABLE_AUDIO: '1' }, stdio: 'inherit' });
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 240000);
child.on('error', error => { console.error(error); clearTimeout(timeout); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
