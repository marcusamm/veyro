'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
const env = {...process.env, VEYRO_DESKTOP_TEST: '1'};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, '../tests/electron-smoke.cjs')], {env, stdio: 'inherit'});
const timer = setTimeout(() => { child.kill(); console.error('Desktop smoke timed out.'); process.exitCode = 1; }, 90000);
child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
