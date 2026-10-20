#!/usr/bin/env node
// Henter de udvalgte billeder i fuld størrelse og laver webstørrelser (1600 og 800 px).
// Input: urmagermette/billeder/valgte.json  { "hero": "urvaerk-03", ... } + _kandidater/kandidater.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROD = 'urmagermette';
const UA = 'UrmagerMette-demo/1.0 (https://github.com/marcusamm/veyro; billedudvaelgelse)';
const valgte = JSON.parse(readFileSync(join(ROD, 'billeder/valgte.json'), 'utf8'));
const kandidater = JSON.parse(readFileSync(join(ROD, 'billeder/_kandidater/kandidater.json'), 'utf8'));
const ud = join(ROD, 'public/billeder');
mkdirSync(ud, { recursive: true });
const kilder = [];
for (const [navn, valg] of Object.entries(valgte)) {
  const id = typeof valg === 'string' ? valg : valg.id;
  const beskaer = typeof valg === 'string' ? null : valg.beskaer; // { left, top, width, height } i brøkdele
  const k = kandidater[id];
  if (!k) throw new Error(`Ukendt kandidat ${id}`);
  const buf = Buffer.from(await (await fetch(k.fil, { headers: { 'User-Agent': UA } })).arrayBuffer());
  let img = sharp(buf).rotate();
  if (beskaer) {
    const m = await sharp(buf).rotate().metadata();
    img = img.extract({ left: Math.round(beskaer.left * m.width), top: Math.round(beskaer.top * m.height), width: Math.round(beskaer.width * m.width), height: Math.round(beskaer.height * m.height) });
  }
  const forberedt = await img.toBuffer();
  await sharp(forberedt).resize({ width: 1600, height: 1067, fit: 'cover', position: 'attention' }).jpeg({ quality: 80, mozjpeg: true }).toFile(join(ud, `${navn}.jpg`));
  await sharp(forberedt).resize({ width: 800, height: 534, fit: 'cover', position: 'attention' }).jpeg({ quality: 78, mozjpeg: true }).toFile(join(ud, `${navn}-800.jpg`));
  kilder.push({ fil: navn, titel: k.titel, fotograf: k.fotograf, licens: k.licens, licensUrl: k.licensUrl, side: k.side });
  console.log(`${navn}: ${id}`);
}
writeFileSync(join(ROD, 'src/app/billedkilder.json'), JSON.stringify(kilder, null, 2) + '\n');
