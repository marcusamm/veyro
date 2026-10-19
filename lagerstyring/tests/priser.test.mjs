// Prisestimat på indkøbslister: demodata, valg af forhandler, manuelle priser, prisfiler og feed.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfFrom, demoLogin, opFrom, startStack } from './harness.mjs';

const DISCLAIMER =
  'Vejledende prisestimat baseret på offentlige priser. Endelig pris, tilgængelighed, fragt og eventuelle rabatter bekræftes hos leverandøren.';

describe('Prisestimat', () => {
  let stack;
  let owner;
  let staff;
  let feed;
  let feedBody = '';
  let listId;
  const line = (where) => stack.sql(`SELECT * FROM purchase_lines WHERE list_id = ${listId} AND ${where}`)[0];
  const retailer = (key) => stack.sql(`SELECT * FROM retailers WHERE key = '${key}'`)[0];
  const page = () => owner.get(`/lager/indkob/${listId}`);
  const post = async (action, form = {}) => {
    const p = await page();
    return owner.post(action, { _csrf: csrfFrom(p.html), ...form });
  };
  /** Estimatets total, som den står på siden. */
  const total = (html) => html.match(/Estimat i alt \(ekskl\. moms\)[^<]*<\/span><strong class="big">([^<]+)<\/strong>/)?.[1];

  beforeAll(async () => {
    feed = http.createServer((req, res) => {
      if (req.url === '/feed.csv' && feedBody) res.writeHead(200, { 'Content-Type': 'text/csv' }).end(feedBody);
      else res.writeHead(404).end();
    });
    await new Promise((r) => feed.listen(0, '127.0.0.1', r));
    stack = await startStack({ demo: true, email: false, devMode: true });
    owner = await demoLogin(stack, 'ejer');
    staff = await demoLogin(stack, 'medarbejder');
    listId = stack.sql("SELECT l.id FROM purchase_lists l JOIN jobs j ON j.id = l.job_id WHERE j.number = '2026-015' ORDER BY l.id LIMIT 1")[0].id;
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
    await new Promise((r) => feed?.close(r));
  });

  it('viser præcist match, hele pakker, alternativ, manglende pris og et korrekt estimat med demodata', async () => {
    const { html } = await page();
    expect(html).toContain('Præcist match');
    expect(html).toContain('Alternativ – kræver godkendelse');
    expect(html).toContain('Pris mangler');
    expect(html).toContain('Demodata');
    expect(html).toContain('Tidligere pris – ikke bekræftet');
    expect(html).toContain('Laveste fundne materialepris');
    // 12 vinkelbeslag i pakker á 10: 2 pakker = 20 stk. til 200 kr. inkl. moms = 160 kr. ekskl.
    expect(html).toMatch(/Foreslået køb: <strong>2 pk\.<\/strong> = 20 stk\./);
    // 12 gipsplader × 72,50 = 870 kr. inkl. = 696 kr. ekskl. + 160 kr. = 856 kr.
    expect(total(html)).toBe('856 kr.');
    expect(html).toContain('2 varer uden pris');
    expect(html).toContain('Fragt og eventuelle gebyrer er ikke medregnet');
    expect(html).toContain(DISCLAIMER);
    // Demodata har ingen opdigtede produktlinks
    expect(html).not.toMatch(/href="https:\/\/[^"]*demo/);
  });

  it('godkendt alternativ tæller med, men ændrer ikke varen på listen', async () => {
    const mal = line("sku = 'MAL-10'");
    const est = stack.sql(`SELECT id FROM price_estimates WHERE line_id = ${mal.id} AND match = 'alternativ' AND status = 'aktuel'`)[0];
    const res = await post(`/lager/indkob/estimat/${est.id}/godkend`);
    expect(res.status).toBe(303);
    const { html } = await page();
    expect(total(html)).toBe('1.894,40 kr.'); // + 2 × 649 kr. inkl. = 1.038,40 kr. ekskl.
    expect(line(`id = ${mal.id}`)).toMatchObject({ name: mal.name, product_id: mal.product_id, qty: mal.qty });
  });

  it('den billigste pris bruges altid, også efter "Opdatér priser"', async () => {
    const vin = line("sku = 'VIN-90'");
    const res = await post(`/lager/indkob/${listId}/priser`);
    expect(res.status).toBe(200);
    expect(res.html).toContain('Priserne er opdateret');
    expect(res.html).not.toContain(`/lager/indkob/linje/${vin.id}/forhandler`);
    // Vinkelbeslag: Nord 2 pk. = 160 kr. ekskl. er billigere end Syd 1 pk. á 25 = 175,20 kr.
    expect(total(res.html)).toBe('1.894,40 kr.');
  });

  it('manuel pris kræver link til forhandleren og markeres "Manuelt indtastet"', async () => {
    const special = line("name LIKE 'Specialbeslag%'");
    const stark = retailer('stark');
    const form = { retailer_id: String(stark.id), match: 'praecis', name: 'Specialbeslag', sales_unit: 'stk.', pack_qty: '1', content_unit: 'stk.', price: '25', vat: 'inkl', min_qty: '1' };
    const bad = await post(`/lager/indkob/linje/${special.id}/pris`, { ...form, url: 'https://andet.example/x' });
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('Linket skal pege på stark.dk');
    const ok = await post(`/lager/indkob/linje/${special.id}/pris`, { ...form, url: 'https://www.stark.dk/specialbeslag' });
    expect(ok.status).toBe(303);
    const { html } = await page();
    expect(html).toContain('Manuelt indtastet');
    expect(total(html)).toBe('1.974,40 kr.'); // + 4 × 25 kr. inkl. = 80 kr. ekskl.
    expect(html).not.toContain('uden pris:');
  });

  it('en ny pris fra en prisfil overskriver ikke en manuel pris uden accept', async () => {
    const gip = line("sku = 'GIP-13'");
    const stark = retailer('stark');
    await post(`/lager/indkob/linje/${gip.id}/pris`, {
      retailer_id: String(stark.id), match: 'praecis', name: 'Gipsplade 13 mm', url: 'https://www.stark.dk/gips', sales_unit: 'stk.', pack_qty: '1', content_unit: 'stk.', price: '70', vat: 'inkl', min_qty: '1',
    });
    const ean = stack.sql("SELECT ean FROM products WHERE sku = 'GIP-13'")[0].ean;
    const csv = `varenr;ean;navn;link;pris;moms\nST-1;${ean};Gipsplade 13 mm 900x2500;https://www.stark.dk/p/st-1;75,00;inkl\n`;
    const p = await owner.get('/lager/priser');
    const fd = new FormData();
    fd.set('_csrf', csrfFrom(p.html));
    fd.set('public', '1');
    fd.set('file', new Blob([csv], { type: 'text/csv' }), 'stark.csv');
    const up = await owner.postMultipart(`/lager/priser/${stark.id}/prisfil`, fd);
    expect(up.html).toContain('1 pris fra STARK er indlæst');
    await post(`/lager/indkob/${listId}/priser`);
    const live = stack.sql(`SELECT * FROM price_estimates WHERE line_id = ${gip.id} AND retailer_id = ${stark.id} AND status IN ('aktuel', 'forslag') ORDER BY id`);
    expect(live.map((e) => [e.source, e.status, e.price])).toEqual([
      ['manuel', 'aktuel', 7000],
      ['prisfil', 'forslag', 7500],
    ]);
    expect((await page()).html).toContain('Ny pris fundet hos STARK');
    await post(`/lager/indkob/estimat/${live[1].id}/accepter`);
    const after = stack.sql(`SELECT source, status FROM price_estimates WHERE line_id = ${gip.id} AND retailer_id = ${stark.id} ORDER BY id`);
    expect(after).toEqual([
      { source: 'manuel', status: 'erstattet' },
      { source: 'prisfil', status: 'aktuel' },
    ]);
  });

  it('henter et officielt feed på serveren, og en fejl hos forhandleren stopper ikke lister eller forbrug', async () => {
    const bauhaus = retailer('bauhaus');
    const url = `http://127.0.0.1:${feed.address().port}/feed.csv`;
    const p = await owner.get('/lager/priser');
    await owner.post(`/lager/priser/${bauhaus.id}`, { _csrf: csrfFrom(p.html), active: '1', feed_url: url });
    // Feedet svarer 404: fejlen vises, men listen virker
    let res = await post(`/lager/indkob/${listId}/priser`);
    expect(res.status).toBe(200);
    expect(res.html).toContain('BAUHAUS: <strong>fejlede</strong>');
    expect(retailer('bauhaus').last_error).toContain('404');
    const jobId = stack.sql("SELECT id FROM jobs WHERE number = '2026-014'")[0].id;
    const reg = await staff.get(`/job/${jobId}/registrer?type=forbrug`);
    const vin = stack.sql("SELECT id FROM products WHERE sku = 'VIN-90'")[0].id;
    const used = await staff.post(`/job/${jobId}/registrer`, { _csrf: csrfFrom(reg.html), op: opFrom(reg.html), type: 'forbrug', note: '', [`q_${vin}`]: '1' });
    expect(used.headers.get('location')).toContain('besked=forbrug');
    // Nu leverer feedet en pris
    const ean = stack.sql("SELECT ean FROM products WHERE sku = 'VIN-90'")[0].ean;
    feedBody = `varenr;ean;navn;link;salgsenhed;indhold;indholdsenhed;pris;moms\nBH-9;${ean};Vinkelbeslag 90 mm 12 stk;https://www.bauhaus.dk/vinkel;pk.;12;stk.;96,00;inkl\n`;
    res = await post(`/lager/indkob/${listId}/priser`);
    expect(res.html).toContain('BAUHAUS: 1 pris hentet');
    expect(stack.sql(`SELECT COUNT(*) AS n FROM retailer_products WHERE retailer_id = ${bauhaus.id}`)[0].n).toBe(1);
    expect(res.html).toContain('https://www.bauhaus.dk/vinkel');
    // BAUHAUS er nu billigst på vinkelbeslag (1 pk. á 12 = 96 kr. inkl. = 76,80 kr. ekskl.) og bruges automatisk
    expect(stack.sql(`SELECT COUNT(*) AS n FROM price_estimates WHERE retailer_id = ${bauhaus.id} AND status = 'aktuel'`)[0].n).toBe(1);
    expect(res.html).toMatch(/76,80 kr\.<\/strong> <span class="small muted">ekskl\. moms hos BAUHAUS/);
  });

  it('prisopslag og afsendelse bestiller intet, og e-mailen har estimatet og ansvarsteksten', async () => {
    const before = stack.sql(`SELECT id, qty, ordered, ready, unit_price, actual_price FROM purchase_lines WHERE list_id = ${listId} ORDER BY id`);
    const buyer = stack.sql("SELECT * FROM users WHERE role = 'indkober'")[0];
    const worker = stack.sql("SELECT * FROM users WHERE role = 'medarbejder'")[0];
    await post(`/lager/indkob/${listId}/priser`);
    await post(`/lager/indkob/${listId}/send`, { user_id: String(buyer.id), split: '1' });
    await post(`/lager/indkob/${listId}/send`, { user_id: String(worker.id) });
    expect(stack.sql(`SELECT id, qty, ordered, ready, unit_price, actual_price FROM purchase_lines WHERE list_id = ${listId} ORDER BY id`)).toEqual(before);
    const [toWorker, toBuyer] = stack.sql(`SELECT * FROM mails WHERE list_id = ${listId} ORDER BY id DESC LIMIT 2`);
    expect(toBuyer.body_text).toContain('2026-015');
    expect(toBuyer.body_text).toContain('Estimat i alt (ekskl. moms)');
    expect(toBuyer.body_text).toContain('Trælast Syd (demo)');
    expect(toBuyer.body_text).toContain('BAUHAUS');
    expect(toBuyer.body_text).toContain('Prisdata fra');
    expect(toBuyer.body_text).toContain('Fragt og eventuelle gebyrer er ikke medregnet.');
    expect(toBuyer.body_text).toContain(DISCLAIMER);
    expect(toWorker.body_text).not.toContain('Estimat');
  });

  it('medarbejdere har ikke adgang til forhandlere og prisfiler', async () => {
    const res = await staff.get('/lager/priser');
    expect(res.status).not.toBe(200);
  });
});
