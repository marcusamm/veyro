#!/usr/bin/env node
// Søger efter frit licenserede billeder (CC0, Public Domain, CC BY, CC BY-SA) via Openverse
// og gemmer små forhåndsvisninger + licensoplysninger, så billederne kan udvælges.
// Køres af workflowet "UrmagerMette: billeder" (kræver internetadgang).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const UD = process.argv[2] || 'urmagermette/billeder/_kandidater';
const SOEGNINGER = {
  urmager: 'watchmaker',
  urvaerk: 'watch movement',
  vaerktoej: 'watchmaker tools',
  lommeur: 'pocket watch',
  standur: 'longcase clock',
  bornholmer: 'bornholm clock',
  taffelur: 'mantel clock',
  vintage: 'vintage wristwatch',
  armbaandsur: 'mechanical wristwatch',
  vaerksted: 'clock repair',
};
const UA = 'UrmagerMette-demo/1.0 (billedudvaelgelse; kontakt via github.com/marcusamm/veyro)';
const meta = {};
for (const [navn, q] of Object.entries(SOEGNINGER)) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm,by,by-sa&page_size=14&mature=false&size=large`;
  let data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    data = await res.json();
  } catch (e) {
    console.log(`Søgning fejlede: ${q}: ${e}`);
    continue;
  }
  mkdirSync(join(UD, navn), { recursive: true });
  let n = 0;
  for (const r of data.results ?? []) {
    try {
      const res = await fetch(r.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const info = await sharp(buf).metadata();
      if ((info.width ?? 0) < 1200) continue;
      n++;
      const id = `${navn}-${String(n).padStart(2, '0')}`;
      await sharp(buf).rotate().resize({ width: 520 }).jpeg({ quality: 70 }).toFile(join(UD, navn, `${id}.jpg`));
      meta[id] = { url: r.url, side: r.foreign_landing_url, titel: r.title, fotograf: r.creator, fotografUrl: r.creator_url, licens: r.license, licensVersion: r.license_version, licensUrl: r.license_url, kilde: r.source, bredde: info.width, hoejde: info.height };
    } catch (e) {
      console.log(`Kunne ikke hente ${r.url}: ${e}`);
    }
  }
  console.log(`${q}: ${n} billeder`);
}
writeFileSync(join(UD, 'kandidater.json'), JSON.stringify(meta, null, 2));
