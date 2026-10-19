import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, csrfFrom, demoLogin, login, opFrom, startStack, waitFor } from './harness.mjs';

const K = 1000;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

describe('Demo uden e-mail (simuleret)', () => {
  let stack;
  let owner;
  let staff;
  const product = (sku) => stack.sql(`SELECT * FROM products WHERE sku = '${sku}'`)[0];
  const job = (number) => stack.sql(`SELECT * FROM jobs WHERE number = '${number}'`)[0];

  /** Sender registreringsarket for et job. Returnerer svaret og den brugte engangsnøgle. */
  async function register(client, jobId, type, qty, { op, note = '' } = {}) {
    const page = await client.get(`/job/${jobId}/registrer?type=${type}`);
    const form = { _csrf: csrfFrom(page.html), op: op ?? opFrom(page.html), type, note, ...qty };
    return { res: await client.post(`/job/${jobId}/registrer`, form), op: form.op };
  }

  beforeAll(async () => {
    stack = await startStack({ demo: true, email: false });
    owner = await demoLogin(stack, 'ejer');
    staff = await demoLogin(stack, 'medarbejder');
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('har fiktive varer, flere job og en liste til lageropfyldning', () => {
    expect(stack.sql('SELECT COUNT(*) AS n FROM products')[0].n).toBeGreaterThanOrEqual(14);
    expect(stack.sql("SELECT COUNT(*) AS n FROM jobs WHERE status = 'aktiv'")[0].n).toBeGreaterThanOrEqual(2);
    expect(stack.sql("SELECT COUNT(*) AS n FROM purchase_lists WHERE kind = 'lager'")[0].n).toBe(1);
  });

  it('demoforløbet giver de forventede tal i alle trin', async () => {
    const page = await owner.get('/lager/demo');
    const res = await owner.post('/lager/demo', { _csrf: csrfFrom(page.html) });
    expect(res.status).toBe(200);
    expect(res.html).toContain('Alle trin gav det forventede resultat.');
    expect(res.html).not.toContain('✗');
    expect(res.html).toContain('Simuleret: e-mail er ikke sat op, så listen er IKKE sendt');
  });

  it('genbestillingspunktet er 70 i eksemplet', async () => {
    const p = product('FUG-300');
    const res = await owner.get(`/lager/varer/${p.id}`);
    expect(res.html).toMatch(/10 × 5 \+ 20|10 × 5 dage \+ 20/);
    expect(res.html).toContain('70');
  });

  it('direkte forbrug trækker straks fra lageret og kan ikke registreres to gange', async () => {
    const p = product('FUG-300');
    const j = job('2026-014');
    const { res, op } = await register(staff, j.id, 'forbrug', { [`q_${p.id}`]: '30' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('besked=forbrug');
    expect(product('FUG-300')).toMatchObject({ stock: 70 * K, reserved: 0, alert_level: 1 });
    const notice = stack.sql(`SELECT * FROM notices WHERE kind = 'lager' AND open = 1 AND product_id = ${p.id}`);
    expect(notice).toHaveLength(1);
    // Samme formular igen (dobbeltklik eller genindlæsning)
    const again = await register(staff, j.id, 'forbrug', { [`q_${p.id}`]: '30' }, { op });
    expect(again.res.headers.get('location')).toContain('besked=dublet');
    expect(product('FUG-300').stock).toBe(70 * K);
    // Advarsel gentages ikke for samme behov
    expect(stack.sql(`SELECT COUNT(*) AS n FROM notices WHERE product_id = ${p.id}`)[0].n).toBe(1);
  });

  it('medarbejdere kan ikke tage mere end det disponible', async () => {
    const p = product('MAL-10');
    const j = job('2026-014');
    const { res } = await register(staff, j.id, 'forbrug', { [`q_${p.id}`]: '2' });
    expect(res.status).toBe(409);
    expect(res.html).toContain('kan ikke tages fra lageret');
    expect(product('MAL-10').stock).toBe(0);
  });

  it('planlagt forbrug ud over lageret reserverer det disponible og sætter resten på jobbets liste', async () => {
    const p = product('SIL-S');
    const j = job('2026-014');
    const before = product('SIL-S');
    const avail = before.stock - before.reserved;
    const need = avail / K + 5;
    const { res, op } = await register(staff, j.id, 'plan', { [`q_${p.id}`]: String(need) });
    expect(res.headers.get('location')).toContain('besked=planlagt_mangler');
    const after = product('SIL-S');
    expect(after.stock).toBe(before.stock);
    expect(after.reserved).toBe(before.stock);
    const lines = stack.sql(`SELECT * FROM purchase_lines WHERE job_id = ${j.id} AND product_id = ${p.id} AND cancelled = 0`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ qty: 5 * K, auto: 1, ordered: 0 });
    // Gensendt formular giver hverken ny reservation eller ny linje
    await register(staff, j.id, 'plan', { [`q_${p.id}`]: String(need) }, { op });
    expect(product('SIL-S').reserved).toBe(before.stock);
    expect(stack.sql(`SELECT COUNT(*) AS n FROM purchase_lines WHERE job_id = ${j.id} AND product_id = ${p.id}`)[0].n).toBe(1);
    const page = await staff.get(`/job/${j.id}`);
    expect(page.html).toContain('Afventer materialer');
  });

  it('to samtidige registreringer kan ikke disponere over de samme varer', async () => {
    const p = product('TAP-50'); // 24 på lager
    const j = job('2026-014');
    const a = await staff.get(`/job/${j.id}/registrer?type=forbrug`);
    const b = await owner.get(`/job/${j.id}/registrer?type=forbrug`);
    const [ra, rb] = await Promise.all([
      staff.post(`/job/${j.id}/registrer`, { _csrf: csrfFrom(a.html), op: opFrom(a.html), type: 'forbrug', [`q_${p.id}`]: '20' }),
      owner.post(`/job/${j.id}/registrer`, { _csrf: csrfFrom(b.html), op: opFrom(b.html), type: 'forbrug', [`q_${p.id}`]: '20' }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([303, 409]);
    expect(product('TAP-50').stock).toBe(4 * K);
  });

  it('udlevering, frigivelse og retur på jobbet', async () => {
    const p = product('VIN-90'); // 40 reserveret til 2026-014
    const j = job('2026-014');
    const act = async (action, qty) => {
      const page = await staff.get(`/job/${j.id}`);
      return staff.post(`/job/${j.id}/materiale/${p.id}`, { _csrf: csrfFrom(page.html), op: opFrom(page.html), action, qty });
    };
    const start = product('VIN-90');
    expect((await act('udlever', '30')).status).toBe(303);
    expect(product('VIN-90')).toMatchObject({ stock: start.stock - 30 * K, reserved: start.reserved - 30 * K });
    expect((await act('frigiv', '10')).status).toBe(303);
    expect(product('VIN-90').reserved).toBe(start.reserved - 40 * K);
    expect((await act('retur', '5')).status).toBe(303);
    expect(product('VIN-90').stock).toBe(start.stock - 25 * K);
    const m = stack.sql(`SELECT * FROM job_materials WHERE job_id = ${j.id} AND product_id = ${p.id}`)[0];
    expect(m.issued - m.returned).toBe(25 * K);
    // Mere end der er reserveret afvises med en klar besked
    const over = await act('udlever', '1');
    expect(over.status).toBe(409);
    expect(over.html).toContain('reserveret til jobbet');
  });

  it('afsendt indkøbsliste er simuleret og ændrer ikke status', async () => {
    const j = job('2026-015');
    const list = stack.sql(`SELECT * FROM purchase_lists WHERE job_id = ${j.id} ORDER BY id LIMIT 1`)[0];
    const buyer = stack.sql("SELECT * FROM users WHERE role = 'indkober'")[0];
    const page = await owner.get(`/lager/indkob/${list.id}`);
    const res = await owner.post(`/lager/indkob/${list.id}/send`, { _csrf: csrfFrom(page.html), user_id: String(buyer.id) });
    expect(res.headers.get('location')).toContain('mail=simuleret');
    const shown = await owner.get(res.headers.get('location'));
    expect(shown.html).toContain('ikke sendt');
    const mail = stack.sql(`SELECT * FROM mails WHERE list_id = ${list.id} ORDER BY id DESC LIMIT 1`)[0];
    expect(mail).toMatchObject({ status: 'simuleret', recipient: buyer.email, list_version: list.version });
    expect(mail.body_text).toContain('2026-015');
    expect(mail.body_text).toContain('Gipsplade');
    expect(stack.sql(`SELECT COUNT(*) AS n FROM purchase_lines WHERE list_id = ${list.id} AND ordered > 0 AND product_id = ${product('GIP-13').id}`)[0].n).toBe(0);
  });

  it('delvis modtagelse af jobvarer reserveres til jobbet', async () => {
    const p = product('GIP-13');
    const j = job('2026-015');
    const line = stack.sql(`SELECT * FROM purchase_lines WHERE job_id = ${j.id} AND product_id = ${p.id} AND cancelled = 0`)[0];
    expect(line.qty).toBe(12 * K);
    let page = await owner.get('/lager/indkob');
    let res = await owner.post('/lager/indkob/bestil', { _csrf: csrfFrom(page.html), op: opFrom(page.html), [`o_${line.id}`]: '12', [`d_${line.id}`]: '' });
    expect(res.status).toBe(303);
    page = await owner.get('/lager/modtagelse');
    res = await owner.post('/lager/modtagelse', { _csrf: csrfFrom(page.html), op: opFrom(page.html), [`r_${line.id}`]: '8' });
    expect(res.headers.get('location')).toContain('besked=modtaget');
    expect(product('GIP-13')).toMatchObject({ stock: 26 * K, reserved: 26 * K });
    const after = stack.sql(`SELECT * FROM purchase_lines WHERE id = ${line.id}`)[0];
    expect(after).toMatchObject({ ordered: 12 * K, received: 8 * K });
    // Ingen ny automatisk linje for det, der stadig er bestilt
    expect(stack.sql(`SELECT COUNT(*) AS n FROM purchase_lines WHERE job_id = ${j.id} AND product_id = ${p.id} AND cancelled = 0`)[0].n).toBe(1);
  });

  it('fakturakladden tæller ikke købte og brugte varer to gange', async () => {
    const j = job('2026-014');
    // Det gamle fakturagrundlag sender videre til jobbets faktura
    let res = await owner.get(`/lager/faktura/job/${j.id}`);
    expect(res.headers.get('location')).toBe(`/job/${j.id}/faktura`);
    const page = await owner.get(`/job/${j.id}/faktura`);
    res = await owner.post(`/job/${j.id}/faktura`, { _csrf: csrfFrom(page.html), mode: 'medgaaet' });
    expect(res.status).toBe(303);
    const invId = Number(res.headers.get('location').match(/faktura\/(\d+)/)[1]);
    const lines = stack.sql(`SELECT * FROM invoice_items WHERE invoice_id = ${invId}`);
    const vin = lines.filter((l) => l.source_key === `lager:${product('VIN-90').id}`);
    expect(vin.length).toBe(1);
    expect(vin[0].qty).toBe(25 * K);
    const keys = lines.map((l) => l.source_key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    const pdf = await owner.get(`/job/faktura/${invId}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });

  it('medarbejdere har ikke adgang til lagerportalen og ser ingen priser', async () => {
    const res = await staff.get('/lager/faktura');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('ingen_adgang');
    const list = stack.sql("SELECT id FROM purchase_lists WHERE kind = 'lager'")[0];
    const page = await staff.get(`/job/indkob/${list.id}`);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain('Beløb');
  });

  it('kun administratorer kan skifte logoet', async () => {
    const page = await owner.get('/lager/indstillinger');
    expect(page.html).toContain('Kontakt Veyro, hvis logoet skal skiftes.');
    expect(page.html).not.toContain('/lager/indstillinger/logo"');
    const fd = new FormData();
    fd.append('_csrf', csrfFrom(page.html));
    fd.append('logo', new Blob([PNG]), 'logo.png');
    expect((await owner.postMultipart('/lager/indstillinger/logo', fd)).html).toContain('Kun administratorer kan skifte logoet.');
    expect((await new Client(stack.base).get('/logo')).status).toBe(404);
  });

  it('en ejer, der ikke er administrator, kan ikke udnævne eller ændre administratorer', async () => {
    let page = await owner.get('/lager/indstillinger');
    expect(page.html).not.toContain('name="is_admin"');
    await owner.post('/lager/indstillinger/bruger', { _csrf: csrfFrom(page.html), name: 'Ny Ejer', email: 'ny.ejer@firma.dk', role: 'ejer', is_admin: '1' });
    expect(stack.sql("SELECT is_admin FROM users WHERE email = 'ny.ejer@firma.dk'")[0].is_admin).toBe(0);
    stack.sql("UPDATE users SET is_admin = 1 WHERE email = 'ny.ejer@firma.dk'");
    const id = stack.sql("SELECT id FROM users WHERE email = 'ny.ejer@firma.dk'")[0].id;
    page = await owner.get('/lager/indstillinger');
    const res = await owner.post(`/lager/indstillinger/bruger/${id}`, { _csrf: csrfFrom(page.html), name: 'Ny Ejer', role: 'medarbejder', active: '1' });
    expect(res.html).toContain('Kun administratorer kan ændre en administrator.');
    expect(stack.sql(`SELECT role FROM users WHERE id = ${id}`)[0].role).toBe('ejer');
    stack.sql(`DELETE FROM users WHERE id = ${id}`);
  });

  it('nulstilling lægger demodata ind igen', async () => {
    const page = await owner.get('/lager/indstillinger');
    const res = await owner.post('/lager/demo/nulstil', { _csrf: csrfFrom(page.html) });
    expect(res.headers.get('location')).toContain('nulstillet');
    expect(product('FUG-300').stock).toBe(100 * K);
  });
});

describe('Med e-mail', () => {
  let stack;
  beforeAll(async () => {
    stack = await startStack();
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
  });

  it('kræver login, og ejeren fra ADMIN_EMAILS kan logge ind med link', async () => {
    const anon = new Client(stack.base);
    const res = await anon.get('/lager');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/login');
    const owner = await login(stack, ADMIN_EMAIL);
    expect((await owner.get('/lager')).status).toBe(200);
    // Ukendte adresser får samme svar, men intet link
    const before = stack.mail.emails.length;
    const other = await anon.submit('/login', '/login', { email: 'fremmed@example.dk' });
    expect(other.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(stack.mail.emails.length).toBe(before);
  });

  it('administratoren kan uploade og fjerne et logo, og et SVG-logo kan ikke køre kode', async () => {
    const admin = await login(stack, ADMIN_EMAIL);
    const upload = async (bytes, name) => {
      const page = await admin.get('/lager/indstillinger');
      const fd = new FormData();
      fd.append('_csrf', csrfFrom(page.html));
      fd.append('logo', new Blob([bytes]), name);
      return admin.postMultipart('/lager/indstillinger/logo', fd);
    };
    expect((await upload(new TextEncoder().encode('ikke et billede'), 'logo.txt')).html).toContain('PNG-, JPG-, WebP- eller SVG-fil');
    expect((await upload(PNG, 'logo.png')).headers.get('location')).toContain('logo_gemt');
    const src = (await admin.get('/lager')).html.match(/class="brand-logo" src="([^"]+)"/)?.[1];
    expect(src).toMatch(/^\/logo\?v=\d+$/);
    expect((await new Client(stack.base).get(src)).headers.get('content-type')).toBe('image/png');

    await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg');
    const svg = await new Client(stack.base).get('/logo');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');

    const del = await admin.submit('/lager/indstillinger', '/lager/indstillinger/logo/slet');
    expect(del.headers.get('location')).toContain('logo_slettet');
    expect((await admin.get('/lager')).html).toContain('brand-dot');
    expect((await new Client(stack.base).get('/logo')).status).toBe(404);
  });

  it('administratoren kan invitere på e-mail og udnævne andre administratorer', async () => {
    const admin = await login(stack, ADMIN_EMAIL);
    let page = await admin.get('/lager/indstillinger');
    expect(page.html).toContain('name="is_admin"');
    const before = stack.mail.emails.length;
    const res = await admin.post('/lager/indstillinger/bruger', { _csrf: csrfFrom(page.html), name: 'Anna Admin', email: 'anna@firma.dk', role: 'medarbejder', is_admin: '1', invite: '1' });
    expect(res.headers.get('location')).toContain('besked=inviteret');
    const invite = await waitFor(() => stack.mail.emails.slice(before).find((e) => e.to[0] === 'anna@firma.dk'));
    expect(invite.subject).toContain('inviteret');
    expect(invite.text).toContain(`${stack.base}/login`);
    // En administrator er altid ejer
    expect(stack.sql("SELECT role, is_admin FROM users WHERE email = 'anna@firma.dk'")[0]).toEqual({ role: 'ejer', is_admin: 1 });

    // Den nye administrator kan selv skifte logoet og fjerne administratorrettigheden fra andre
    const anna = await login(stack, 'anna@firma.dk');
    page = await anna.get('/lager/indstillinger');
    expect(page.html).not.toContain('Kontakt Veyro, hvis logoet skal skiftes.');
    const fd = new FormData();
    fd.append('_csrf', csrfFrom(page.html));
    fd.append('logo', new Blob([PNG]), 'logo.png');
    expect((await anna.postMultipart('/lager/indstillinger/logo', fd)).headers.get('location')).toContain('logo_gemt');
    await anna.submit('/lager/indstillinger', '/lager/indstillinger/logo/slet');

    // Den faste administrator fra kundefilen kan ikke nedgraderes
    const fixedId = stack.sql(`SELECT id FROM users WHERE email = '${ADMIN_EMAIL}'`)[0].id;
    const down = await anna.post(`/lager/indstillinger/bruger/${fixedId}`, { _csrf: csrfFrom(page.html), name: 'Ejer', role: 'indkober', active: '1' });
    expect(down.html).toContain('er fast administrator');

    // Uden invitation sendes ingen mail
    const n = stack.mail.emails.length;
    const plain = await admin.post('/lager/indstillinger/bruger', { _csrf: csrfFrom((await admin.get('/lager/indstillinger')).html), name: 'Ole Uden', email: 'ole@firma.dk', role: 'medarbejder' });
    expect(plain.headers.get('location')).toContain('besked=oprettet');
    await new Promise((r) => setTimeout(r, 300));
    expect(stack.mail.emails.slice(n).some((e) => e.to[0] === 'ole@firma.dk')).toBe(false);

    const annaId = stack.sql("SELECT id FROM users WHERE email = 'anna@firma.dk'")[0].id;
    page = await admin.get('/lager/indstillinger');
    await admin.post(`/lager/indstillinger/bruger/${annaId}`, { _csrf: csrfFrom(page.html), name: 'Anna Admin', role: 'ejer', active: '1' });
    expect(stack.sql(`SELECT is_admin FROM users WHERE id = ${annaId}`)[0].is_admin).toBe(0);
    stack.sql("DELETE FROM users WHERE email IN ('anna@firma.dk', 'ole@firma.dk')");
  });

  it('sender advarsel og indkøbsliste, og medarbejdere får ingen priser', async () => {
    const owner = await login(stack, ADMIN_EMAIL);
    let page = await owner.get('/lager/indstillinger');
    await owner.post('/lager/indstillinger/bruger', { _csrf: csrfFrom(page.html), name: 'Ida Indkøb', email: 'ida@firma.dk', role: 'indkober', alert_mail: '1', purchase_mail: '1' });
    await owner.post('/lager/indstillinger/bruger', { _csrf: csrfFrom(page.html), name: 'Søren Svend', email: 'soren@firma.dk', role: 'medarbejder' });
    // Vare: 100 på lager, ROP 70
    page = await owner.get('/lager/varer/ny');
    let res = await owner.post('/lager/varer/ny', {
      _csrf: csrfFrom(page.html),
      sku: 'T-1',
      name: 'Testvare',
      unit: 'stk.',
      whole_units: '1',
      lead_time_days: '5',
      avg_daily_usage: '10',
      safety_method: 'antal',
      safety_qty: '20',
      purchase_price: '10',
      initial_stock: '100',
    });
    expect(res.status).toBe(303);
    const pid = stack.sql("SELECT id FROM products WHERE sku = 'T-1'")[0].id;
    page = await owner.get('/job/ny');
    res = await owner.post('/job/ny', { _csrf: csrfFrom(page.html), number: 'J-1', name: 'Testjob', planned_date: '' });
    const jobId = Number(res.headers.get('location').match(/job\/(\d+)/)[1]);
    page = await owner.get(`/job/${jobId}/registrer?type=plan`);
    res = await owner.post(`/job/${jobId}/registrer`, { _csrf: csrfFrom(page.html), op: opFrom(page.html), type: 'plan', [`q_${pid}`]: '130' });
    expect(res.headers.get('location')).toContain('planlagt_mangler');
    // Advarsel (ingen disponible) til modtagere af lageradvarsler
    const alert = await waitFor(() => stack.mail.emails.find((e) => e.to[0] === 'ida@firma.dk' && e.subject.includes('Testvare')));
    expect(alert.text).toContain('Fysisk 100');
    expect(alert.text).toContain('genbestillingspunkt 70');
    // Indkøbsliste til medarbejder (uden priser) og indkøber (med priser)
    const list = stack.sql(`SELECT id FROM purchase_lists WHERE job_id = ${jobId}`)[0];
    const users = Object.fromEntries(stack.sql('SELECT id, email FROM users').map((u) => [u.email, u.id]));
    page = await owner.get(`/lager/indkob/${list.id}`);
    await owner.post(`/lager/indkob/${list.id}/send`, { _csrf: csrfFrom(page.html), user_id: String(users['soren@firma.dk']) });
    res = await owner.post(`/lager/indkob/${list.id}/send`, { _csrf: csrfFrom(page.html), user_id: String(users['ida@firma.dk']) });
    expect(res.headers.get('location')).toContain('mail=sendt');
    const toStaff = await waitFor(() => stack.mail.emails.find((e) => e.to[0] === 'soren@firma.dk'));
    const toBuyer = await waitFor(() => stack.mail.emails.find((e) => e.to[0] === 'ida@firma.dk' && e.subject.startsWith('Indkøbsliste')));
    expect(toStaff.text).toContain('J-1 Testjob');
    expect(toStaff.text).toContain('30 stk.');
    expect(toStaff.text).not.toContain('kr.');
    expect(toBuyer.text).toContain('kr.');
    expect(stack.sql(`SELECT ordered FROM purchase_lines WHERE list_id = ${list.id}`)[0].ordered).toBe(0);
  });
});
