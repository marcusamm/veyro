// Produktkatalog: import med forhåndsvisning, genimport uden dubletter, søgning, valg af vare på et
// job og adskillelsen mellem katalog og lager. Bruger demoens fiktive katalog (Nordlys Demo, Demo VVS).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfFrom, demoLogin, opFrom, startStack } from './harness.mjs';

const COLUMNS = {
  manufacturer: 'Producent',
  mpn: 'Varenummer',
  ean: 'EAN',
  name: 'Produktnavn',
  description: 'Beskrivelse',
  category: 'Varegruppe',
  variant: 'Variant',
  dimensions: 'Mål',
  material: 'Materiale',
  unit: 'Enhed',
  pack_size: 'Pakning',
  price: 'Listepris ekskl. moms',
  currency: 'Valuta',
  source_updated: 'Opdateret',
};
const MAPPING = JSON.stringify({ columns: COLUMNS, header_row: 1, currency: 'DKK', vat: 'ekskl', price_type: 'listepris' });

/** Semikolonsepareret CSV med anførselstegn (som demofilen) til rækker med Veyros felter. */
function csvRows(text) {
  const lines = [];
  let row = [];
  let cell = '';
  let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';') row.push(cell), (cell = '');
    else if (ch === '\n') row.push(cell), lines.push(row), (row = []), (cell = '');
    else if (ch !== '\r') cell += ch;
  }
  const [head, ...data] = lines;
  return data.map((cells, i) => {
    const values = {};
    for (const [f, col] of Object.entries(COLUMNS)) values[f] = cells[head.indexOf(col)] ?? '';
    return { row_no: i + 2, values };
  });
}

describe('Produktkatalog', () => {
  let stack;
  let owner;
  let staff;
  let src;
  let jobId;
  const one = (q) => stack.sql(q)[0];
  const cat = (mpn) => one(`SELECT * FROM catalog_products WHERE mpn = '${mpn}'`);
  const search = async (client, q, extra = '') => JSON.parse((await client.get(`/katalog/sog?q=${encodeURIComponent(q)}&n=10${extra}`)).html);
  /** Fysisk lager, reservationer, bevægelser, indkøb og modtagelser: må ikke ændres af en import. */
  const stockSnapshot = () =>
    JSON.stringify([
      stack.sql('SELECT id, stock, reserved, purchase_price FROM products ORDER BY id'),
      stack.sql('SELECT COUNT(*) n, COALESCE(SUM(qty), 0) q FROM movements'),
      stack.sql('SELECT id, qty, ordered, received FROM purchase_lines ORDER BY id'),
      stack.sql('SELECT id, subtotal, total, status FROM invoices ORDER BY id'),
      stack.sql('SELECT id, version, subtotal, total FROM job_quotes ORDER BY id'),
    ]);

  async function importFile(name) {
    const page = await owner.get('/lager/katalog/import');
    const csrf = csrfFrom(page.html);
    const rows = csvRows((await owner.get(`/lager/katalog/demofil/${name}`)).html);
    const created = await owner.post('/lager/katalog/import', { _csrf: csrf, source_id: String(src), mapping: MAPPING, filename: name });
    expect(created.status, created.html).toBe(200);
    const { id } = JSON.parse(created.html);
    for (let i = 0; i < rows.length; i += 10) {
      const r = await owner.post(`/lager/katalog/import/${id}/rader`, { _csrf: csrf, rows: JSON.stringify(rows.slice(i, i + 10)) });
      expect(r.status, r.html).toBe(200);
    }
    const done = await owner.post(`/lager/katalog/import/${id}/klar`, { _csrf: csrf });
    expect(JSON.parse(done.html).url).toBe(`/lager/katalog/import/${id}`);
    return id;
  }

  beforeAll(async () => {
    stack = await startStack({ demo: true, email: false, devMode: true });
    owner = await demoLogin(stack, 'ejer');
    staff = await demoLogin(stack, 'medarbejder');
    src = one("SELECT id FROM catalog_sources WHERE kind = 'demo' AND name LIKE 'Demokatalog%'").id;
    jobId = one("SELECT id FROM jobs WHERE status = 'aktiv' ORDER BY id LIMIT 1").id;
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('demoen har et tydeligt mærket, fiktivt katalog og en tom KEMPER-kilde', async () => {
    expect(one('SELECT COUNT(*) n FROM catalog_products').n).toBe(25);
    expect(one("SELECT COUNT(*) n FROM catalog_products WHERE mpn NOT LIKE 'DEMO-%'").n).toBe(0);
    const kemper = one("SELECT * FROM catalog_sources WHERE name = 'KEMPER'");
    expect(kemper.kind).toBe('producent');
    expect(one(`SELECT COUNT(*) n FROM catalog_products WHERE source_id = ${kemper.id}`).n).toBe(0);
    const { html } = await owner.get('/lager/katalog');
    expect(html).toContain('Demokatalog (fiktive varer)');
    expect(html).toContain('Ingen fil importeret endnu');
    // EAN gemmes som tekst med indledende nul
    expect(cat('DEMO-GP13-0925').ean).toBe('02000000000138');
  });

  it('søger på navn, flere ord, varenummer, EAN og med stavefejl', async () => {
    const byName = await search(owner, 'gipsplade 13');
    expect(byName.total).toBeGreaterThanOrEqual(4);
    expect(byName.hits.every((h) => /gips/i.test(h.name))).toBe(true);

    const words = await search(owner, 'udekran 450');
    expect(words.hits[0].codes).toContain('DEMO-UK12-450');

    const mpn = await search(owner, 'demo-uk12-300');
    expect(mpn.hits[0].codes).toContain('DEMO-UK12-300');

    const ean = cat('DEMO-PV18').ean;
    const byEan = await search(owner, ean);
    expect(byEan.hits[0].codes).toContain('DEMO-PV18');
    expect(byEan.hits[0].price).toBe('38 kr. ekskl. moms');

    const typo = await search(owner, 'kuglehne');
    expect(typo.corrected[0].to).toContain('kuglehane');
    expect(typo.hits.length).toBe(3);

    const filtered = await search(owner, 'messing', '&producent=demo%20vvs&kategori=VVS');
    expect(filtered.total).toBe(6);

    // Varer uden pris kan findes og viser "Pris mangler" (aldrig 0 kr.)
    const noPrice = await search(owner, 'DEMO-UK12-450');
    expect(noPrice.hits[0].price).toBe('Pris mangler');

    // Medarbejdere søger også, men ser ingen beløb
    const st = await search(staff, 'DEMO-PV18');
    expect(st.hits[0].price).toBe('Har katalogpris');
    expect((await staff.get('/job/katalog?q=kuglehane')).html).toContain('DEMO-KH34');
    expect((await staff.get('/lager/katalog')).status).not.toBe(200);
  });

  it('viser produktdetaljer med ukendte felter, prisens kilde og varianter', async () => {
    const id = cat('DEMO-UK12-450').id;
    const { html } = await owner.get(`/katalog/${id}`);
    expect(html).toContain('Udekran frostsikker');
    expect(html).toContain('Ukendt');
    expect(html).toContain('Pris mangler');
    expect(html).toContain('DEMO-UK12-200');
    expect(html).toContain('DEMO-UK12-300');
    const priced = await owner.get(`/katalog/${cat('DEMO-UK12-300').id}`);
    expect(priced.html).toContain('Producentens listepris');
    expect(priced.html).not.toMatch(/STARK-pris|indkøbspris: 419/i);
  });

  it('materialesiden har katalogsøgningen som standard og beholder manuel oprettelse', async () => {
    const { html } = await owner.get(`/job/${jobId}/materialer?q=kuglehane`);
    expect(html).toContain('Søg efter varenavn, varenummer eller EAN');
    expect(html).toContain(`/job/${jobId}/materialer/katalog/${cat('DEMO-KH34').id}`);
    expect(html).toContain('Findes varen ikke? Opret den manuelt');
    expect(html).toContain('name="kind" value="fri"');
  });

  it('vælger en variant uden pris: varen oprettes uden lager og kommer på jobbet med "Pris mangler"', async () => {
    const before = stockSnapshot();
    const cp = cat('DEMO-UK12-450');
    const url = `/job/${jobId}/materialer/katalog/${cp.id}`;
    const page = await owner.get(url);
    expect(page.html).toContain('Pris mangler');
    expect(page.html).toContain('value="stk."');
    const res = await owner.post(url, { _csrf: csrfFrom(page.html), op: opFrom(page.html), qty: '2', unit: 'stk.', handling: 'forventet' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('besked=materiale_tilfojet');

    const p = one(`SELECT * FROM products WHERE catalog_product_id = ${cp.id}`);
    expect(p.stock).toBe(0);
    expect(p.reserved).toBe(0);
    expect(p.mpn).toBe('DEMO-UK12-450');
    expect(p.ean).toBe(cp.ean);
    expect(p.sku).toBe(`VK-${String(cp.id).padStart(6, '0')}`);
    expect(stack.sql(`SELECT kind, qty FROM movements WHERE product_id = ${p.id}`)).toEqual([{ kind: 'oprettet', qty: 0 }]);
    const item = one(`SELECT * FROM job_items WHERE job_id = ${jobId} AND product_id = ${p.id}`);
    expect(item.catalog_product_id).toBe(cp.id);
    expect(item.qty).toBe(2000);
    expect(item.price).toBeNull();
    // Øvrige varers lager er uændret
    const after = JSON.parse(stockSnapshot());
    const b = JSON.parse(before);
    expect(after[0].filter((r) => r.id !== p.id)).toEqual(b[0]);

    const mat = await owner.get(`/job/${jobId}/materialer`);
    expect(mat.html).toContain('Fra produktkataloget');
    expect(mat.html).toContain('Pris mangler');

    // Samme vare igen opretter ikke en ny reference
    const again = await owner.get(url);
    await owner.post(url, { _csrf: csrfFrom(again.html), op: opFrom(again.html), qty: '1', unit: 'stk.', handling: 'reserver' });
    expect(one(`SELECT COUNT(*) n FROM products WHERE catalog_product_id = ${cp.id}`).n).toBe(1);
  });

  it('vælger en vare, der allerede er på lager, og reserverer den', async () => {
    const cp = cat('DEMO-GP13-0925');
    const own = one(`SELECT * FROM products WHERE catalog_product_id = ${cp.id}`);
    expect(own.sku).toBe('GIP-13');
    const url = `/job/${jobId}/materialer/katalog/${cp.id}`;
    const page = await owner.get(url);
    expect(page.html).toContain('readonly');
    const res = await owner.post(url, { _csrf: csrfFrom(page.html), op: opFrom(page.html), qty: '1', unit: own.unit, handling: 'reserver' });
    expect(res.headers.get('location')).toMatch(/besked=katalog_(reserveret|mangler)/);
    const p = one(`SELECT * FROM products WHERE id = ${own.id}`);
    expect(p.stock).toBe(own.stock);
    expect(p.reserved).toBeGreaterThanOrEqual(own.reserved);
    expect(one(`SELECT catalog_product_id FROM job_items WHERE job_id = ${jobId} AND product_id = ${own.id}`).catalog_product_id).toBe(cp.id);
  });

  it('bruger katalogets pris som manuel pris kun efter valg, mærket med kilde og type', async () => {
    const cp = cat('DEMO-UK12-300');
    const url = `/job/${jobId}/materialer/katalog/${cp.id}`;
    const page = await owner.get(url);
    await owner.post(url, { _csrf: csrfFrom(page.html), op: opFrom(page.html), qty: '1', unit: 'stk.', handling: 'forventet', use_price: '1' });
    const item = one(`SELECT ji.* FROM job_items ji JOIN products p ON p.id = ji.product_id WHERE ji.job_id = ${jobId} AND p.catalog_product_id = ${cp.id}`);
    expect(item.price).toBe(41900);
    expect(item.found_name).toBe('Producentens listepris fra Demokatalog (fiktive varer)');
    expect(one(`SELECT purchase_price FROM products WHERE catalog_product_id = ${cp.id}`).purchase_price).toBeNull();
  });

  it('importerer version 2 med forhåndsvisning og ændrer intet lager, tilbud eller faktura', async () => {
    const before = stockSnapshot();
    const itemsBefore = JSON.stringify(stack.sql('SELECT id, qty, price, name FROM job_items ORDER BY id'));
    const id = await importFile('demokatalog-v2.csv');
    const imp = one(`SELECT * FROM catalog_imports WHERE id = ${id}`);
    expect([imp.status, imp.rows_new, imp.rows_updated, imp.rows_error, imp.rows_missing]).toEqual(['klar', 1, 3, 1, 1]);
    expect(imp.rows_same).toBe(21);
    // Intet er ændret før godkendelse
    expect(one('SELECT COUNT(*) n FROM catalog_products').n).toBe(25);
    const preview = await owner.get(`/lager/katalog/import/${id}`);
    expect(preview.html).toContain('DEMO-KH114');
    expect(preview.html).toContain('Mangler i filen');
    const errs = await owner.get(`/lager/katalog/import/${id}?vis=fejl`);
    expect(errs.html).toContain('Slangetyl');

    const ok = await owner.post(`/lager/katalog/import/${id}/godkend`, { _csrf: csrfFrom(preview.html) });
    expect(ok.headers.get('location')).toContain('besked=import_godkendt');
    // Godkendelse to gange ændrer intet
    const twice = await owner.post(`/lager/katalog/import/${id}/godkend`, { _csrf: csrfFrom(preview.html) });
    expect(twice.status).toBe(303);

    expect(one('SELECT COUNT(*) n FROM catalog_products').n).toBe(26);
    expect(one(`SELECT amount FROM catalog_prices WHERE catalog_product_id = ${cat('DEMO-UK12-300').id}`).amount).toBe(43900);
    expect(one(`SELECT amount FROM catalog_prices WHERE catalog_product_id = ${cat('DEMO-GP13-0927').id}`).amount).toBe(7100);
    expect(cat('DEMO-GP13-1225').description).toContain('12,5 mm');
    expect(cat('DEMO-PV15').source_updated).not.toBe(stack.sql(`SELECT source_updated FROM catalog_import_rows WHERE import_id = 1 LIMIT 1`)[0].source_updated);
    // Udgået vare markeres til gennemgang, slettes ikke
    expect(cat('DEMO-KH1').status).toBe('gennemgang');
    expect((await owner.get('/lager/katalog/gennemgang')).html).toContain('DEMO-KH1');

    expect(stockSnapshot()).toBe(before);
    // Jobbets linjer (også prisen sat fra kataloget) ændres ikke af en ny katalogpris
    expect(JSON.stringify(stack.sql('SELECT id, qty, price, name FROM job_items ORDER BY id'))).toBe(itemsBefore);
  });

  it('genimport af samme fil giver ingen dubletter', async () => {
    const id = await importFile('demokatalog-v2.csv');
    const imp = one(`SELECT * FROM catalog_imports WHERE id = ${id}`);
    expect([imp.rows_new, imp.rows_updated, imp.rows_error]).toEqual([0, 0, 1]);
    const page = await owner.get(`/lager/katalog/import/${id}`);
    await owner.post(`/lager/katalog/import/${id}/godkend`, { _csrf: csrfFrom(page.html) });
    expect(one('SELECT COUNT(*) n FROM catalog_products').n).toBe(26);
    expect(one('SELECT COUNT(*) n FROM (SELECT maker_key, mpn_key FROM catalog_products GROUP BY 1, 2 HAVING COUNT(*) > 1)').n).toBe(0);

    // Version 1 igen: den udgåede vare er tilbage i filen og bliver aktiv; ingen nye varer
    const v1 = await importFile('demokatalog-v1.csv');
    const i1 = one(`SELECT * FROM catalog_imports WHERE id = ${v1}`);
    expect(i1.rows_new).toBe(0);
    const p1 = await owner.get(`/lager/katalog/import/${v1}`);
    await owner.post(`/lager/katalog/import/${v1}/godkend`, { _csrf: csrfFrom(p1.html) });
    expect(one('SELECT COUNT(*) n FROM catalog_products').n).toBe(26);
  });

  it('afviser demovarer i en rigtig producents kilde', async () => {
    const kemper = one("SELECT id FROM catalog_sources WHERE name = 'KEMPER'").id;
    const page = await owner.get('/lager/katalog/import');
    expect(page.html).toMatch(new RegExp(`<option value="${src}" selected>Demokatalog`));
    const csrf = csrfFrom(page.html);
    const rows = csvRows((await owner.get('/lager/katalog/demofil/demokatalog-v1.csv')).html).slice(0, 3);
    const { id } = JSON.parse((await owner.post('/lager/katalog/import', { _csrf: csrf, source_id: String(kemper), mapping: MAPPING, filename: 'forkert.csv' })).html);
    await owner.post(`/lager/katalog/import/${id}/rader`, { _csrf: csrf, rows: JSON.stringify(rows) });
    await owner.post(`/lager/katalog/import/${id}/klar`, { _csrf: csrf });
    const imp = one(`SELECT * FROM catalog_imports WHERE id = ${id}`);
    expect([imp.rows_new, imp.rows_error]).toEqual([0, 3]);
    const cancel = await owner.get(`/lager/katalog/import/${id}`);
    await owner.post(`/lager/katalog/import/${id}/annuller`, { _csrf: csrfFrom(cancel.html) });
    expect(one(`SELECT COUNT(*) n FROM catalog_products WHERE source_id = ${kemper}`).n).toBe(0);
  });

  it('opretter en katalogvare i varekartoteket fra lagerportalen uden beholdning', async () => {
    const cp = cat('DEMO-PV22');
    const page = await owner.get(`/katalog/${cp.id}`);
    const res = await owner.post(`/lager/katalog/${cp.id}/opret`, { _csrf: csrfFrom(page.html), unit: 'stk.' });
    expect(res.headers.get('location')).toContain('besked=katalog_oprettet');
    const p = one(`SELECT * FROM products WHERE catalog_product_id = ${cp.id}`);
    expect([p.stock, p.reserved]).toEqual([0, 0]);
    expect((await owner.get(`/lager/varer/${p.id}`)).html).toContain('Knyttet til produktkataloget');
    expect((await owner.get('/lager/varer/ny?q=pressfitting')).html).toContain('DEMO-PV15');
  });

  it('søger hurtigt i 10.000 syntetiske DEMO-varer med sideinddeling på serveren', async () => {
    const page = await owner.get('/lager/katalog');
    const r = await owner.post('/lager/katalog/demo/belastning', { _csrf: csrfFrom(page.html) });
    expect(r.status).toBe(303);
    expect(one("SELECT COUNT(*) n FROM catalog_products WHERE mpn LIKE 'DEMO-LT-%'").n).toBe(10_000);

    const timings = [];
    for (const q of ['syntetisk skrue 42', 'DEMO-LT-04242', 'kabel', 'fliserr']) {
      const t = Date.now();
      const res = await search(owner, q);
      timings.push(Date.now() - t);
      expect(res.total).toBeGreaterThan(0);
      if (q === 'DEMO-LT-04242') expect(res.hits[0].codes).toContain('DEMO-LT-04242');
    }
    console.log('Søgetider med 10.000 varer (ms):', timings.join(', '));
    expect(Math.max(...timings)).toBeLessThan(2000);
    const p3 = JSON.parse((await owner.get('/katalog/sog?q=kabel&n=20&side=3')).html);
    expect(p3.hits.length).toBe(20);
    const full = await owner.get('/lager/katalog?q=kabel&side=2');
    expect(full.html).toContain('side 2 af');

    const del = await owner.get('/lager/katalog');
    await owner.post('/lager/katalog/demo/belastning/fjern', { _csrf: csrfFrom(del.html) });
    expect(one("SELECT COUNT(*) n FROM catalog_products WHERE mpn LIKE 'DEMO-LT-%'").n).toBe(0);
  }, 120_000);
});
