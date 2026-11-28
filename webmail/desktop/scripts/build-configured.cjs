'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {loadOAuthRegistration} = require('../oauth-registration.cjs');

async function run() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !['--mac', '--win'].includes(args[0]) || !['--arm64', '--x64'].includes(args[1]) || (args[0] === '--win' && args[1] !== '--x64')) {
    throw new Error('Usage: npm run build:configured -- --mac --arm64 | --mac --x64 | --win --x64');
  }
  const project = path.join(__dirname, '..');
  const registrationFile = path.resolve(project, process.env.VEYRO_OAUTH_CONFIG_FILE || 'oauth-config.local.json');
  const registration = loadOAuthRegistration({isPackaged: false, explicitFile: registrationFile});
  if (!registration.google && !registration.microsoft) throw new Error('No registered OAuth client in the explicit local configuration.');
  const packageConfig = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).build;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'veyro-configured-build-'));
  try {
    const builderFile = path.join(temporary, 'builder.json');
    // This file contains a resource path, never credential values. The source
    // template and Git index are not changed during a configured build.
    await fs.writeFile(builderFile, JSON.stringify({...packageConfig,
      extraResources: [...(packageConfig.extraResources || []), {from: registrationFile, to: 'oauth-config.runtime.json'}],
    }), {mode: 0o600});
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('electron-builder/cli.js'), args[0], args[0] === '--mac' ? 'dmg' : 'nsis', args[1], '--publish', 'never', '--config', builderFile], {
        cwd: project, env: {...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false'}, stdio: 'inherit',
      });
      child.on('error', reject); child.on('exit', (value) => resolve(value ?? 1));
    });
    if (code !== 0) throw new Error(`Configured installer build failed (${code}).`);
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
