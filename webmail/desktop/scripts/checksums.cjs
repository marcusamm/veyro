'use strict';
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const dist = path.join(__dirname, '../dist');
  const files = (await fs.readdir(dist)).filter((name) => /\.(dmg|exe)$/.test(name)).sort();
  if (!files.length) throw new Error('No installers in dist.');
  const sums = await Promise.all(files.map(async (name) => `${createHash('sha256').update(await fs.readFile(path.join(dist, name))).digest('hex')}  ${name}`));
  await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  console.log(sums.join('\n'));
})().catch((error) => { console.error(error); process.exitCode = 1; });
