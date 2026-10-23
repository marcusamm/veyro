#!/usr/bin/env node
// Søger efter frit licenserede billeder (Public Domain, CC0, CC BY, CC BY-SA) på Wikimedia Commons
// og gemmer små forhåndsvisninger + licensoplysninger, så billederne kan udvælges.
// Køres af workflowet "UrmagerMette: billeder" (kræver internetadgang).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UD = process.argv[2] || 'urmagermette/billeder/_kandidater';
const SOEGNINGER = {
  urmager: 'watchmaker repairing watch',
  urvaerk: 'mechanical watch movement macro',
  vaerktoej: 'watchmaker tools workbench',
  lommeur: 'pocket watch open',
  standur: 'longcase clock',
  bornholmer: 'Bornholmerur',
  bornholmer2: 'Bornholm clock',
  taffelur: 'mantel clock antique',
  vintage: 'vintage wristwatch',
  armbaandsur: 'mechanical wristwatch',
  vaerksted: 'clockmaker workshop',
};
const UA = 'UrmagerMette-demo/1.0 (https://github.com/marcusamm/veyro; billedudvaelgelse)';
const TILLADT = /^(public domain|pd|cc0|cc by(-sa)? \d(\.\d)?( \w+)?|cc-by(-sa)?-\d(\.\d)?)$/i;
const meta = {};
mkdirSync(UD, { recursive: true });
for (const [navn, q] of Object.entries(SOEGNINGER)) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '30',
    prop: 'imageinfo', iiprop: 'url|size|extmetadata|mime', iiurlwidth: '520',
  });
  let data;
  try {
    data = await (await fetch(url, { headers: { 'User-Agent': UA } })).json();
  } catch (e) {
    console.log(`Søgning fejlede: ${q}: ${e}`);
    continue;
  }
  const sider = Object.values(data.query?.pages ?? {}).sort((a, b) => a.index - b.index);
  mkdirSync(join(UD, navn), { recursive: true });
  let n = 0;
  for (const s of sider) {
    const ii = s.imageinfo?.[0];
    if (!ii || ii.mime !== 'image/jpeg' || ii.width < 1400) continue;
    const em = ii.extmetadata ?? {};
    const licens = (em.LicenseShortName?.value ?? '').trim();
    if (!TILLADT.test(licens)) continue;
    try {
      const res = await fetch(ii.thumburl, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      n++;
      const id = `${navn}-${String(n).padStart(2, '0')}`;
      writeFileSync(join(UD, navn, `${id}.jpg`), Buffer.from(await res.arrayBuffer()));
      const strip = (h) => (h ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      meta[id] = {
        titel: s.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''), fil: ii.url, side: ii.descriptionurl, fotograf: strip(em.Artist?.value),
        licens, licensUrl: em.LicenseUrl?.value ?? '', kreditering: strip(em.Credit?.value), bredde: ii.width, hoejde: ii.height,
      };
    } catch (e) {
      console.log(`Kunne ikke hente ${ii.thumburl}: ${e}`);
    }
    if (n >= 12) break;
  }
  console.log(`${q}: ${n} billeder`);
}
writeFileSync(join(UD, 'kandidater.json'), JSON.stringify(meta, null, 2));
