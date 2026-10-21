// Digitale fuldmagter: hele forløbet fra udfyldning til sletning, og adskillelse mellem kunder.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, seedCustomer, startStack, waitFor } from './harness.mjs';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const dk = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date(Date.now() + offsetDays * DAY * 1000));
let stack;
let admin;
let anna;
let bo;

// wrangler d1 execute (sql()) tager et par sekunder; imens kan wrangler dev lukke en keep-alive-forbindelse.
// Et enkelt nyt forsøg ved "other side closed" gør testene stabile uden at skjule rigtige fejl.
for (const m of ['get', 'post']) {
  const orig = Client.prototype[m];
  Client.prototype[m] = async function (...args) {
    try {
      return await orig.apply(this, args);
    } catch (err) {
      if (err?.cause?.code !== 'UND_ERR_SOCKET') throw err;
      return orig.apply(this, args);
    }
  };
}

const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();

function sql(command) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', command],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0].results;
}

/** Formular som par, så "powers" kan forekomme flere gange */
function formPairs(csrf, fields) {
  const pairs = [['_csrf', csrf]];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) pairs.push([k, x]);
    else pairs.push([k, v]);
  }
  return pairs;
}

const BASE_FORM = {
  company_name: 'Anna Byg ApS',
  cvr: '12345678',
  address: 'Testvej 1',
  postal_city: '4200 Slagelse',
  contact_name: 'Anna Jensen',
  receipt_email: 'anna@example.dk',
  approver_name: 'Anna Jensen',
  approver_title: 'Direktør',
  project: 'Webshop på annabyg.dk',
  purpose: 'Vedligehold af webshop og kontakt til hosting om drift.',
  parties: 'Simply.com\nShopify',
  expires_on: '',
};

async function newDraft(client, fields, next = 'review') {
  const page = await client.get('/konto/fuldmagter/ny');
  expect(page.status).toBe(200);
  const idem = page.html.match(/name="_idem" value="([^"]+)"/)[1];
  const res = await client.post('/konto/fuldmagter/ny', formPairs(csrfFrom(page.html), { ...fields, _idem: idem, next }));
  return { res, idem, csrf: csrfFrom(page.html) };
}

async function approveFlow(client, id, email) {
  const review = await client.get(`/konto/fuldmagter/${id}/oversigt`);
  expect(review.status).toBe(200);
  const hash = review.html.match(/name="hash" value="([0-9a-f]{64})"/)[1];
  const before = (await emails()).length;
  const sent = await client.post(`/konto/fuldmagter/${id}/kode`, { _csrf: csrfFrom(review.html), hash });
  expect(sent.status).toBe(303);
  const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === email && /Engangskode/.test(e.subject)));
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  const page = await client.get(`/konto/fuldmagter/${id}/oversigt?kode=sendt`);
  expect(page.html).toContain('Godkend fuldmagt');
  return { code, hash, csrf: csrfFrom(page.html) };
}

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  await seedCustomer(stack, { email: 'anna@example.dk', name: 'Anna Jensen', cus: 'cus_PA', sub: 'sub_PA', price: 'price_business_test', start: now() - 10 * DAY });
  await seedCustomer(stack, { email: 'bo@example.dk', name: 'Bo Hansen', cus: 'cus_PB', sub: 'sub_PB', price: 'price_starter_test', start: now() - 10 * DAY });
  admin = (await login(stack, ADMIN_EMAIL)).client;
  anna = (await login(stack, 'anna@example.dk')).client;
  bo = (await login(stack, 'bo@example.dk')).client;
});

afterAll(async () => {
  if (process.env.POA_LOG) (await import('node:fs')).writeFileSync(process.env.POA_LOG, stack?.logs() ?? '');
  await stack?.stop();
});

describe('Fuldmagter: adgang og opsætning', () => {
  it('er lukket for kunder, indtil Veyro åbner for dem', async () => {
    const list = await anna.get('/konto/fuldmagter');
    expect(list.status).toBe(200);
    expect(list.html).toContain('ikke åbnet for din konto');
    expect((await anna.get('/konto/fuldmagter/ny')).status).toBe(303);
    expect((await anna.get('/konto')).html).not.toContain('Aftaler og dokumenter');
  });

  it('kunder kan ikke åbne Veyros administration', async () => {
    expect((await anna.get('/admin/fuldmagter')).status).toBe(403);
    expect((await new Client(stack.base).get('/admin/fuldmagter')).status).toBe(303);
  });

  it('Veyros oplysninger: kun de kendte er udfyldt, og godkendelse blokeres, til alle er udfyldt', async () => {
    const page = await admin.get('/admin/fuldmagter/indstillinger');
    expect(page.html).toContain('value="46857569"');
    expect(page.html).toContain('Albert Ibsensvej 28, 2. tv, 4200 Slagelse');
    expect(page.html).toContain('value="kontakt@veyro.dk"');
    expect(page.html).toMatch(/id="s-veyro_legal_name" name="veyro_legal_name" type="text" maxlength="200" value=""/);
    const listPage = await admin.get('/admin/fuldmagter');
    expect(listPage.html).toContain('Mangler: Juridisk virksomhedsnavn, Kontaktperson');
    // Kan ikke åbne for alle, før teksten er godkendt
    const bad = await admin.post('/admin/fuldmagter/indstillinger', {
      _csrf: csrfFrom(page.html), veyro_legal_name: '', veyro_cvr: '46857569', veyro_address: 'Albert Ibsensvej 28, 2. tv, 4200 Slagelse',
      veyro_contact_name: '', veyro_contact_email: 'kontakt@veyro.dk', require_veyro_acceptance: '1', launched: '1', pilot_emails: '',
    });
    expect(bad.status).toBe(400);
    // Pilot: Anna og Bo. Veyros juridiske navn mangler stadig.
    const ok = await admin.post('/admin/fuldmagter/indstillinger', {
      _csrf: csrfFrom(page.html), veyro_legal_name: '', veyro_cvr: '46857569', veyro_address: 'Albert Ibsensvej 28, 2. tv, 4200 Slagelse',
      veyro_contact_name: '', veyro_contact_email: 'kontakt@veyro.dk', require_veyro_acceptance: '1', pilot_emails: 'anna@example.dk\nbo@example.dk',
    });
    expect(ok.status).toBe(303);
    expect((await anna.get('/konto')).html).toContain('Aftaler og dokumenter');
  });
});

let annaPoa;

describe('Fuldmagter: udfyldning og validering', () => {
  it('ingen beføjelser er valgt på forhånd, og Veyros oplysninger indsættes', async () => {
    const page = await anna.get('/konto/fuldmagter/ny');
    expect(page.html).not.toMatch(/name="powers" value="[a-z_]+" id="p-[a-z_]+" checked/);
    expect(page.html).toContain('46857569');
    expect(page.html).toContain('Mangler – udfyldes af Veyro');
    expect(page.html).toContain('Udkast:');
    expect(page.html).toContain('value="Anna Jensen"');
  });

  it('gemmer kladde én gang, selv ved dobbeltklik', async () => {
    const { res, idem, csrf } = await newDraft(anna, { ...BASE_FORM, powers: ['admin'] }, 'draft');
    expect(res.status).toBe(303);
    const again = await anna.post('/konto/fuldmagter/ny', formPairs(csrf, { ...BASE_FORM, powers: ['admin'], _idem: idem, next: 'draft' }));
    expect(again.headers.get('location')).toBe(res.headers.get('location'));
    const list = await anna.get('/konto/fuldmagter');
    expect(list.html.match(/FM-\d{4}-\d{4}/g).filter((x, i, a) => a.indexOf(x) === i)).toHaveLength(1);
    expect(list.html).toContain('Kladde');
  });

  it('blokerer godkendelse uden beføjelser og ved ugyldige bestillingsbetingelser', async () => {
    const { res } = await newDraft(anna, { ...BASE_FORM, powers: [] });
    const id = res.headers.get('location').match(/fuldmagter\/(\d+)/)[1];
    const review = await anna.get(`/konto/fuldmagter/${id}/oversigt`);
    expect(review.html).toContain('Vælg mindst én beføjelse.');
    expect(review.html).not.toContain('Send engangskode');

    const { res: bad } = await newDraft(anna, { ...BASE_FORM, powers: ['orders'], order_max_per_order: '10.000', order_max_per_month: '5.000' });
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('Beløbet pr. bestilling kan ikke være større end månedsgrænsen.');
    const { res: r2 } = await newDraft(anna, { ...BASE_FORM, powers: ['orders', 'other'], order_max_per_order: '1.000', order_max_per_month: '5.000' });
    const id2 = r2.headers.get('location').match(/fuldmagter\/(\d+)/)[1];
    const rv2 = await anna.get(`/konto/fuldmagter/${id2}/oversigt`);
    expect(rv2.html).toContain('Skriv mindst én godkendt leverandør.');
    expect(rv2.html).toContain('Beskriv præcist, hvilken beføjelse Veyro får');
    // Ugyldigt format afvises allerede ved gem
    const { res: r3 } = await newDraft(anna, { ...BASE_FORM, cvr: '123', powers: ['admin'] });
    expect(r3.status).toBe(400);
    expect(r3.html).toContain('CVR-nummeret skal være 8 cifre.');
  });

  it('blokerer godkendelse, så længe Veyros juridiske navn og kontaktperson mangler', async () => {
    const { res } = await newDraft(anna, {
      ...BASE_FORM,
      powers: ['admin', 'orders'],
      order_max_per_order: '5.000',
      order_max_per_month: '8.000',
      order_suppliers: 'Simply.com\nBygma',
      order_types: 'Domæner\nHosting',
      order_start: dk(0),
      order_end: dk(60),
      expires_on: dk(90),
    });
    annaPoa = res.headers.get('location').match(/fuldmagter\/(\d+)/)[1];
    const review = await anna.get(`/konto/fuldmagter/${annaPoa}/oversigt`);
    expect(review.html).toContain('Veyros oplysninger er ikke udfyldt endnu');
    const hash = review.html.match(/name="hash" value="([0-9a-f]{64})"/)?.[1] ?? 'x';
    const r = await anna.post(`/konto/fuldmagter/${annaPoa}/kode`, { _csrf: csrfFrom(review.html), hash });
    expect(r.status).toBe(400);

    const page = await admin.get('/admin/fuldmagter/indstillinger');
    const saved = await admin.post('/admin/fuldmagter/indstillinger', {
      _csrf: csrfFrom(page.html), veyro_legal_name: 'TEST Veyro juridisk navn', veyro_cvr: '46857569', veyro_address: 'Albert Ibsensvej 28, 2. tv, 4200 Slagelse',
      veyro_contact_name: 'TEST kontaktperson', veyro_contact_email: 'kontakt@veyro.dk', require_veyro_acceptance: '1', pilot_emails: 'anna@example.dk\nbo@example.dk',
    });
    expect(saved.status).toBe(303);
  });
});

describe('Fuldmagter: godkendelse, kvittering og PDF', () => {
  it('kræver begge bekræftelser og korrekt engangskode', async () => {
    const { code, hash, csrf } = await approveFlow(anna, annaPoa, 'anna@example.dk');
    const noConfirm = await anna.post(`/konto/fuldmagter/${annaPoa}/godkend`, { _csrf: csrf, hash, code });
    expect(noConfirm.html).toContain('Sæt flueben ved begge bekræftelser.');
    const wrong = await anna.post(`/konto/fuldmagter/${annaPoa}/godkend`, { _csrf: csrf, hash, code: code === '000000' ? '111111' : '000000', confirm1: '1', confirm2: '1' });
    expect(wrong.html).toContain('Engangskoden er forkert.');
    const staleHash = await anna.post(`/konto/fuldmagter/${annaPoa}/godkend`, { _csrf: csrf, hash: 'f'.repeat(64), code, confirm1: '1', confirm2: '1' });
    expect(staleHash.html).toContain('er ændret, siden du åbnede siden');

    const before = (await emails()).length;
    const ok = await anna.post(`/konto/fuldmagter/${annaPoa}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/konto/fuldmagter/${annaPoa}?godkendt=1`);
    // Dobbeltklik giver ingen ny godkendelse
    const dbl = await anna.post(`/konto/fuldmagter/${annaPoa}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(dbl.status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM poa_events WHERE poa_id = ${annaPoa} AND type = 'approved'`)[0].n).toBe(1);

    const receipt = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'anna@example.dk' && /Kvittering/.test(e.subject)));
    expect(receipt.subject).toContain('afventer Veyros accept');
    expect(receipt.text).toContain('IKKE aktiv endnu');
    expect(receipt.text).toContain('Tilbagekald fuldmagt');
    expect(receipt.text).toContain(`/konto/fuldmagter/${annaPoa}`);
    expect(receipt.attachments).toHaveLength(1);
    const pdf = Buffer.from(receipt.attachments[0].content, 'base64');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const staff = (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@veyro.dk' && /godkendt af kunden/.test(e.subject));
    expect(staff).toBeTruthy();

    const page = await anna.get(`/konto/fuldmagter/${annaPoa}?godkendt=1`);
    expect(page.html).toContain('Tak – fuldmagten er godkendt');
    expect(page.html).toContain('Afventer Veyros accept');
    expect(page.html).toContain('Sendt til anna@example.dk');
    expect(page.html).toContain('ikke en MitID-signatur');
  });

  it('gemmer godkender, tid, metode og den præcise tekst, og den godkendte version kan ikke ændres', async () => {
    const row = sql(`SELECT status, approver_name, approver_title, approver_email, approval_method, approved_at, content_hash, text_version, snapshot_json, draft_json FROM poas WHERE id = ${annaPoa}`)[0];
    expect(row.status).toBe('pending');
    expect(row.approver_name).toBe('Anna Jensen');
    expect(row.approver_title).toBe('Direktør');
    expect(row.approver_email).toBe('anna@example.dk');
    expect(row.approval_method).toContain('engangskode');
    expect(row.approved_at).toBeGreaterThan(0);
    expect(row.draft_json).toBeNull();
    const snap = JSON.parse(row.snapshot_json);
    expect(snap.powers.filter((p) => p.granted).map((p) => p.key)).toEqual(['admin', 'orders']);
    expect(snap.orders.max_per_order_oere).toBe(500000);
    expect(snap.veyro.legal_name).toBe('TEST Veyro juridisk navn');
    expect(snap.text_draft).toBe(true);
    // Databasen afviser ændringer af en godkendt version
    expect(() => sql(`UPDATE poas SET snapshot_json = '{}' WHERE id = ${annaPoa}`)).toThrow();
    // Siden til redigering er lukket
    const edit = await anna.get(`/konto/fuldmagter/${annaPoa}/rediger`);
    expect(edit.headers.get('location')).toContain('ikke-kladde');
  });

  it('PDF hentes kun af ejeren og har en statusside foran det uændrede dokument', async () => {
    const res = await fetch(`${stack.base}/konto/fuldmagter/${annaPoa}/pdf`, { headers: { Cookie: anna.cookieHeader() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const orig1 = Buffer.from(await (await fetch(`${stack.base}/konto/fuldmagter/${annaPoa}/pdf?original=1`, { headers: { Cookie: anna.cookieHeader() } })).arrayBuffer());
    const orig2 = Buffer.from(await (await fetch(`${stack.base}/konto/fuldmagter/${annaPoa}/pdf?original=1`, { headers: { Cookie: anna.cookieHeader() } })).arrayBuffer());
    expect(orig1.equals(orig2)).toBe(true);
    // Uden login og for andre kunder
    expect((await fetch(`${stack.base}/konto/fuldmagter/${annaPoa}/pdf`, { redirect: 'manual' })).status).toBe(303);
    expect((await bo.get(`/konto/fuldmagter/${annaPoa}/pdf`)).status).toBe(404);
  });
});

describe('Fuldmagter: kunder ser kun egne dokumenter', () => {
  it('Bo kan ikke se, ændre, tilbagekalde eller slette Annas fuldmagt', async () => {
    expect((await bo.get(`/konto/fuldmagter/${annaPoa}`)).status).toBe(404);
    expect((await bo.get(`/konto/fuldmagter/${annaPoa}/tilbagekald`)).status).toBe(404);
    const page = await bo.get('/konto/fuldmagter');
    expect(page.html).not.toContain('Anna Byg');
    const r = await bo.post(`/konto/fuldmagter/${annaPoa}/tilbagekald`, { _csrf: csrfFrom(page.html) });
    expect(r.status).toBe(404);
    const d = await bo.post(`/konto/fuldmagter/${annaPoa}/slet`, { _csrf: csrfFrom(page.html), revoke_first: '1' });
    expect(d.status).toBe(303);
    expect(sql(`SELECT status, deletion_status FROM poas WHERE id = ${annaPoa}`)[0]).toEqual({ status: 'pending', deletion_status: 'none' });
  });
});

describe('Fuldmagter: Veyros accept og handlinger', () => {
  it('handlinger blokeres, mens fuldmagten afventer', async () => {
    const page = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    expect(page.html).toContain('Afventer');
    const r = await admin.post(`/admin/fuldmagter/${annaPoa}/handlinger`, { _csrf: csrfFrom(page.html), power: 'admin', party: 'Simply.com', description: 'Opdater DNS', amount: '', planned_for: '' });
    expect(r.status).toBe(400);
    expect(r.html).toContain('afventer godkendelse');
  });

  it('Veyro accepterer, fuldmagten bliver aktiv, og kunden får en ny besked med PDF', async () => {
    const page = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    const before = (await emails()).length;
    const r = await admin.post(`/admin/fuldmagter/${annaPoa}/accepter`, { _csrf: csrfFrom(page.html) });
    expect(r.status).toBe(303);
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => /er nu aktiv/.test(e.subject)));
    expect(mail.attachments[0].filename).toContain('aktiv');
    const view = await anna.get(`/konto/fuldmagter/${annaPoa}`);
    expect(view.html).toContain('>Aktiv<');
  });

  it('kontrollerer beføjelse, leverandør og beløbsgrænser på serveren', async () => {
    const page = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    const csrf = csrfFrom(page.html);
    const post = (f) => admin.post(`/admin/fuldmagter/${annaPoa}/handlinger`, { _csrf: csrf, amount: '', planned_for: '', ...f });
    expect((await post({ power: 'data', party: 'Shopify', description: 'Ret varer i shoppen' })).html).toContain('er ikke givet i fuldmagten');
    const unk = await post({ power: 'orders', party: 'Ukendt ApS', description: 'Køb af materialer', amount: '100' });
    expect(unk.html.match(/alert-err[^>]*>([^<]*)/)?.[1]).toContain('er ikke en godkendt leverandør');
    expect((await post({ power: 'orders', party: 'Bygma', description: 'Køb af materialer', amount: '6.000' })).html).toContain('grænsen pr. bestilling');
    expect((await post({ power: 'orders', party: 'bygma', description: 'Køb af mursten', amount: '4.000' })).status).toBe(303);
    const over = await post({ power: 'orders', party: 'Simply.com', description: 'Hosting', amount: '4.500' });
    expect(over.status).toBe(400);
    expect(over.html).toContain('månedsgrænsen');
    expect((await post({ power: 'admin', party: 'Simply.com', description: 'Opdaterede DNS' })).status).toBe(303);
    expect((await post({ power: 'admin', party: 'Shopify', description: 'Planlagt opdatering af tema', planned_for: dk(5) })).status).toBe(303);
    const actions = sql(`SELECT status FROM poa_actions WHERE poa_id = ${annaPoa} ORDER BY id`).map((a) => a.status);
    expect(actions).toEqual(['done', 'done', 'planned']);
  });

  it('medarbejdere kan ikke ændre en godkendt fuldmagt', async () => {
    const page = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    expect(page.html).not.toContain(`/konto/fuldmagter/${annaPoa}/rediger`);
    const r = await admin.post(`/konto/fuldmagter/${annaPoa}/rediger`, { _csrf: csrfFrom(page.html), company_name: 'Hack' });
    expect([303, 404]).toContain(r.status);
    expect(sql(`SELECT company_name FROM poas WHERE id = ${annaPoa}`)[0].company_name).toBe('Anna Byg ApS');
  });
});

describe('Fuldmagter: tilbagekaldelse', () => {
  it('stopper med det samme, også fra en side, der allerede er åben', async () => {
    const adminPage = await admin.get(`/admin/fuldmagter/${annaPoa}`); // åbnet før tilbagekaldelsen
    const confirm = await anna.get(`/konto/fuldmagter/${annaPoa}/tilbagekald`);
    expect(confirm.html).toContain('Du er ved at tilbagekalde fuldmagten. Når du bekræfter, stopper Veyros mulighed for at udføre nye handlinger under denne fuldmagt. Allerede gennemførte handlinger annulleres ikke automatisk.');
    const before = (await emails()).length;
    const r = await anna.post(`/konto/fuldmagter/${annaPoa}/tilbagekald`, { _csrf: csrfFrom(confirm.html) });
    expect(r.status).toBe(303);
    const row = sql(`SELECT status, revoked_at FROM poas WHERE id = ${annaPoa}`)[0];
    expect(row.status).toBe('revoked');
    expect(row.revoked_at).toBeGreaterThan(0);

    const blocked = await admin.post(`/admin/fuldmagter/${annaPoa}/handlinger`, { _csrf: csrfFrom(adminPage.html), power: 'admin', party: 'Simply.com', description: 'Ny ændring', amount: '', planned_for: '' });
    expect(blocked.status).toBe(400);
    expect(blocked.html).toContain('tilbagekaldt');
    // Planlagt handling er stoppet og kan ikke udføres
    const planned = sql(`SELECT id, status FROM poa_actions WHERE poa_id = ${annaPoa} AND planned_for IS NOT NULL`)[0];
    expect(planned.status).toBe('cancelled');
    const run = await admin.post(`/admin/fuldmagter/${annaPoa}/handlinger/${planned.id}/udfoer`, { _csrf: csrfFrom(adminPage.html) });
    expect(run.status).toBe(400);

    // Opgaver til Veyro: adgange + underretning af de leverandører, fuldmagten er brugt over for
    const tasks = sql(`SELECT kind, party FROM poa_tasks WHERE poa_id = ${annaPoa} ORDER BY kind, party`);
    expect(tasks).toEqual([
      { kind: 'followup', party: null },
      { kind: 'third_party', party: 'Simply.com' },
      { kind: 'third_party', party: 'bygma' },
    ]);
    await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'anna@example.dk' && /tilbagekaldt/.test(e.subject)));
    await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@veyro.dk' && /tilbagekaldt/.test(e.subject)));

    const view = await anna.get(`/konto/fuldmagter/${annaPoa}`);
    expect(view.html).toContain('Veyro orienterer');
    expect(view.html).toContain('skal I selv orientere dem');
    expect(view.html).not.toContain(`/konto/fuldmagter/${annaPoa}/tilbagekald"`);
  });

  it('kan ikke genaktiveres', async () => {
    const page = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    const r = await admin.post(`/admin/fuldmagter/${annaPoa}/accepter`, { _csrf: csrfFrom(page.html) });
    expect(r.headers.get('location')).toContain('fejl=1');
    expect(() => sql(`UPDATE poas SET status = 'active' WHERE id = ${annaPoa}`)).toThrow();
  });

  it('PDF er bevaret, og downloadet har den aktuelle status', async () => {
    const res = await fetch(`${stack.base}/konto/fuldmagter/${annaPoa}/pdf`, { headers: { Cookie: anna.cookieHeader() } });
    const buf = Buffer.from(await res.arrayBuffer());
    const orig = Buffer.from(await (await fetch(`${stack.base}/konto/fuldmagter/${annaPoa}/pdf?original=1`, { headers: { Cookie: anna.cookieHeader() } })).arrayBuffer());
    const pages = (b) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages(buf)).toBe(pages(orig) + 1);
    expect(res.headers.get('content-disposition')).toContain('-status.pdf');
  });

  it('Veyro registrerer underretning af tredjeparter', async () => {
    const page = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    const tid = page.html.match(/action="\/admin\/fuldmagter\/\d+\/opgaver\/(\d+)"/)[1];
    expect((await admin.post(`/admin/fuldmagter/${annaPoa}/opgaver/${tid}`, { _csrf: csrfFrom(page.html) })).status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM poa_tasks WHERE poa_id = ${annaPoa} AND status = 'done' AND done_by = '${ADMIN_EMAIL}'`)[0].n).toBe(1);
  });
});

describe('Fuldmagter: sletning', () => {
  it('kladder slettes helt efter bekræftelse', async () => {
    const { res } = await newDraft(bo, { ...BASE_FORM, company_name: 'Bo Tømrer', receipt_email: 'bo@example.dk', powers: ['quotes'] }, 'draft');
    const id = res.headers.get('location').match(/fuldmagter\/(\d+)/)[1];
    const page = await bo.get(`/konto/fuldmagter/${id}/slet`);
    expect(page.html).toContain('Slet kladden');
    const r = await bo.post(`/konto/fuldmagter/${id}/slet`, { _csrf: csrfFrom(page.html) });
    expect(r.headers.get('location')).toContain('kladde-slettet');
    expect(sql(`SELECT COUNT(*) AS n FROM poas WHERE id = ${id}`)[0].n).toBe(0);
    expect(sql(`SELECT COUNT(*) AS n FROM poa_events WHERE poa_id = ${id}`)[0].n).toBe(0);
  });

  it('godkendt fuldmagt med handlinger: dokumentationen opbevares med begrundelse og dato', async () => {
    const page = await anna.get(`/konto/fuldmagter/${annaPoa}/slet`);
    expect(page.html).toContain('i 3 år efter ophøret');
    expect(page.html).toContain('fjerner ikke PDF');
    const r = await anna.post(`/konto/fuldmagter/${annaPoa}/slet`, { _csrf: csrfFrom(page.html) });
    expect(r.headers.get('location')).toContain('sletning-anmodet');
    const list = await anna.get('/konto/fuldmagter');
    expect(list.html).toContain('Modtaget – afventer behandling');
    expect(list.html).toContain('Tilbagekaldt'); // gyldighed og sletning vises hver for sig

    const adm = await admin.get(`/admin/fuldmagter/${annaPoa}`);
    const rid = adm.html.match(/action="\/admin\/fuldmagter\/sletning\/(\d+)"/)[1];
    const before = (await emails()).length;
    expect((await admin.post(`/admin/fuldmagter/sletning/${rid}`, { _csrf: csrfFrom(adm.html), mode: 'policy' })).status).toBe(303);
    const row = sql(`SELECT deletion_status, retain_until, status FROM poas WHERE id = ${annaPoa}`)[0];
    expect(row.deletion_status).toBe('retained');
    expect(row.status).toBe('revoked');
    expect(row.retain_until).toBeGreaterThan(now() + 3 * 360 * DAY);
    expect(sql(`SELECT COUNT(*) AS n FROM poa_mails WHERE poa_id = ${annaPoa}`)[0].n).toBe(0);
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => /Sletning af fuldmagt/.test(e.subject)));
    expect(mail.subject).toContain('delvist');
    expect(mail.text).toContain('forældelsesfrist');
    const after = await anna.get('/konto/fuldmagter');
    expect(after.html).toContain('Delvist slettet');
    expect(after.html).not.toContain('Gennemført – slettet');
  });

  it('aktiv fuldmagt uden handlinger: tilbagekaldes i samme forløb og slettes helt', async () => {
    // Uden Veyros accept bliver fuldmagten aktiv med det samme
    const s = await admin.get('/admin/fuldmagter/indstillinger');
    await admin.post('/admin/fuldmagter/indstillinger', {
      _csrf: csrfFrom(s.html), veyro_legal_name: 'TEST Veyro juridisk navn', veyro_cvr: '46857569', veyro_address: 'Albert Ibsensvej 28, 2. tv, 4200 Slagelse',
      veyro_contact_name: 'TEST kontaktperson', veyro_contact_email: 'kontakt@veyro.dk', pilot_emails: 'anna@example.dk\nbo@example.dk',
    });
    const { res } = await newDraft(bo, { ...BASE_FORM, company_name: 'Bo Tømrer', receipt_email: 'bo@example.dk', approver_name: 'Bo Hansen', powers: ['tech_contact'] });
    const id = res.headers.get('location').match(/fuldmagter\/(\d+)/)[1];
    const { code, hash, csrf } = await approveFlow(bo, id, 'bo@example.dk');
    await bo.post(`/konto/fuldmagter/${id}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(sql(`SELECT status FROM poas WHERE id = ${id}`)[0].status).toBe('active');

    const page = await bo.get(`/konto/fuldmagter/${id}/slet`);
    expect(page.html).toContain('Trin 1: Fuldmagten tilbagekaldes først.');
    const noRevoke = await bo.post(`/konto/fuldmagter/${id}/slet`, { _csrf: csrfFrom(page.html) });
    expect(noRevoke.status).toBe(400);
    expect(sql(`SELECT status FROM poas WHERE id = ${id}`)[0].status).toBe('active');
    await bo.post(`/konto/fuldmagter/${id}/slet`, { _csrf: csrfFrom(page.html), revoke_first: '1' });
    expect(sql(`SELECT status, deletion_status FROM poas WHERE id = ${id}`)[0]).toEqual({ status: 'revoked', deletion_status: 'requested' });

    const adm = await admin.get(`/admin/fuldmagter/${id}`);
    const rid = adm.html.match(/action="\/admin\/fuldmagter\/sletning\/(\d+)"/)[1];
    await admin.post(`/admin/fuldmagter/sletning/${rid}`, { _csrf: csrfFrom(adm.html), mode: 'policy' });
    for (const t of ['poas WHERE id', 'poa_documents WHERE poa_id', 'poa_events WHERE poa_id', 'poa_mails WHERE poa_id']) {
      expect(sql(`SELECT COUNT(*) AS n FROM ${t} = ${id}`)[0].n).toBe(0);
    }
    const list = await bo.get('/konto/fuldmagter');
    expect(list.html).toContain('Gennemført – slettet');
    expect((await bo.get(`/konto/fuldmagter/${id}`)).status).toBe(404);
  });
});

describe('Fuldmagter: udløb', () => {
  it('markeres automatisk som udløbet og blokerer handlinger', async () => {
    const { res } = await newDraft(bo, { ...BASE_FORM, company_name: 'Bo Tømrer', receipt_email: 'bo@example.dk', powers: ['admin'], expires_on: dk(0) });
    const id = res.headers.get('location').match(/fuldmagter\/(\d+)/)[1];
    const { code, hash, csrf } = await approveFlow(bo, id, 'bo@example.dk');
    await bo.post(`/konto/fuldmagter/${id}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(sql(`SELECT status FROM poas WHERE id = ${id}`)[0].status).toBe('active');
    // Udløbsdatoen er låst i den godkendte version; testen flytter den til i går uden om låsen.
    sql(`DROP TRIGGER poas_snapshot_locked; UPDATE poas SET expires_on = '${dk(-1)}' WHERE id = ${id};`);
    sql(`CREATE TRIGGER poas_snapshot_locked BEFORE UPDATE OF snapshot_json, content_hash, text_version, approver_name, approver_title, approver_email, approval_method, approved_at, company_name, project, expires_on, number, version, customer_id ON poas WHEN OLD.snapshot_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'En godkendt fuldmagt kan ikke ændres'); END;`);
    const page = await admin.get(`/admin/fuldmagter/${id}`);
    expect(page.html).toContain('>Udløbet<');
    const r = await admin.post(`/admin/fuldmagter/${id}/handlinger`, { _csrf: csrfFrom(page.html), power: 'admin', party: 'Simply.com', description: 'Ændring', amount: '', planned_for: '' });
    expect(r.status).toBe(400);
    expect((await bo.get(`/konto/fuldmagter/${id}`)).html).toContain('kan ikke genaktiveres');
  });
});

describe('Fuldmagter: skabelon på veyro.dk', () => {
  it('siden findes, står i menuen og linker til skabelonen som PDF', async () => {
    const page = await fetch(`${stack.site}/pages/fuldmagt`);
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const label of ['Digital administration', 'Teknisk kontakt', 'Data og registreringer', 'Indhente tilbud og oplysninger', 'Bestille varer eller ydelser', 'Andre beføjelser']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('/fuldmagt-skabelon.pdf');
    expect(html).toContain('Fuldmagten giver ikke adgang til bankkonti, betalingskort, lån eller kundens penge.');
    expect(await (await fetch(`${stack.site}/`)).text()).toContain('/pages/fuldmagt');
    const pdf = await fetch(`${stack.site}/fuldmagt-skabelon.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
