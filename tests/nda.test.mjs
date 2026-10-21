// Fortrolighedsaftaler (NDA): hele forløbet med to testvirksomheder, adskillelse mellem kunder,
// ny godkendelse ved ændringer, PDF fra den gemte version, ophør, sletning og ærlig mailstatus.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, seedCustomer, setMockState, startStack, waitFor } from './harness.mjs';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
let stack;
let admin;
let anna;
let bo;
let annaNda; // id
let boNda;

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
  let out;
  try {
    out = run(command);
  } catch (err) {
    throw new Error(`${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
  return JSON.parse(out)[0].results;
}

function run(command) {
  return execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', command],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
}

const ANNA_FORM = {
  company_name: 'Anna Byg ApS',
  cvr: '12345678',
  address: 'Testvej 1',
  postal_code: '4200',
  city: 'Slagelse',
  contact_name: 'Anna Jensen',
  contact_email: 'anna@example.dk',
  approver_name: 'Anna Jensen',
  approver_title: 'Direktør',
  project: 'Webshop på annabyg.dk og lagerstyring',
};

async function getBytes(client, p) {
  const res = await fetch(stack.base + p, { headers: { Cookie: client.cookieHeader(), 'CF-Connecting-IP': client.ip } });
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function createFor(email, project) {
  const page = await admin.get('/admin/nda/ny');
  expect(page.status).toBe(200);
  const cid = page.html.match(new RegExp(`<option value="(\\d+)"[^>]*>[^<]*\\(${email.replace('.', '\\.')}\\)`))[1];
  const idem = page.html.match(/name="_idem" value="([^"]+)"/)[1];
  const res = await admin.post('/admin/nda/ny', { _csrf: csrfFrom(page.html), _idem: idem, customer_id: cid, project });
  expect(res.status).toBe(303);
  // Dobbeltklik giver samme aftale
  const again = await admin.post('/admin/nda/ny', { _csrf: csrfFrom(page.html), _idem: idem, customer_id: cid, project });
  expect(again.headers.get('location')).toBe(res.headers.get('location'));
  return Number(res.headers.get('location').match(/\/admin\/nda\/(\d+)/)[1]);
}

async function customerOtp(client, id, email) {
  const page = await client.get(`/konto/nda/${id}`);
  const hash = page.html.match(/name="hash" value="([0-9a-f]{64})"/)[1];
  const before = (await emails()).length;
  const sent = await client.post(`/konto/nda/${id}/kode`, { _csrf: csrfFrom(page.html), hash });
  expect(sent.status).toBe(303);
  const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === email && /Engangskode/.test(e.subject)));
  return { code: mail.text.match(/\b(\d{6})\b/)[1], hash, csrf: csrfFrom(page.html) };
}

async function veyroApprove(id) {
  const page = await admin.get(`/admin/nda/${id}`);
  const hash = page.html.match(/name="hash" value="([0-9a-f]{64})"/)[1];
  const before = (await emails()).length;
  const sent = await admin.post(`/admin/nda/${id}/kode`, { _csrf: csrfFrom(page.html), hash });
  expect(sent.status).toBe(303);
  const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === ADMIN_EMAIL && /Engangskode/.test(e.subject)));
  const code = mail.text.match(/\b(\d{6})\b/)[1];
  return admin.post(`/admin/nda/${id}/godkend`, { _csrf: csrfFrom(page.html), hash, name: 'Test Medarbejder', title: 'Partner', confirm1: '1', confirm2: '1', code });
}

beforeAll(async () => {
  stack = await startStack({ minMonths: 0, extraVars: { NDA_SIGNERS: ADMIN_EMAIL, TEST_LABEL: 'Testmiljø' } });
  await seedCustomer(stack, { email: 'anna@example.dk', name: 'Anna Jensen', cus: 'cus_NA', sub: 'sub_NA', price: 'price_business_test', start: now() - 10 * DAY });
  await seedCustomer(stack, { email: 'bo@example.dk', name: 'Bo Hansen', cus: 'cus_NB', sub: 'sub_NB', price: 'price_starter_test', start: now() - 10 * DAY });
  admin = (await login(stack, ADMIN_EMAIL)).client;
  anna = (await login(stack, 'anna@example.dk')).client;
  bo = (await login(stack, 'bo@example.dk')).client;
});

afterAll(async () => {
  await stack?.stop();
});

describe('Oprettelse og udfyldning', () => {
  it('Veyro opretter kladder til to virksomheder; kunderne ser kun deres egne', async () => {
    annaNda = await createFor('anna@example.dk', 'Webshop på annabyg.dk og lagerstyring');
    boNda = await createFor('bo@example.dk', 'Bookingsystem til Bo Tømrer');
    const list = await anna.get('/konto/aftaler');
    expect(list.status).toBe(200);
    expect(list.html).toContain('Aftaler og dokumenter');
    expect(list.html).toContain('Fortrolighedsaftaler');
    const [a] = sql(`SELECT number FROM ndas WHERE id = ${annaNda}`);
    const [b] = sql(`SELECT number FROM ndas WHERE id = ${boNda}`);
    expect(list.html).toContain(a.number);
    expect(list.html).not.toContain(b.number);
    expect(list.html).toContain('Kladde');
    // Bo kan hverken se, hente eller ændre Annas aftale
    for (const p of [`/konto/nda/${annaNda}`, `/konto/nda/${annaNda}/udkast.pdf`, `/konto/nda/${annaNda}/aftale.pdf`, `/konto/nda/${annaNda}/ophoer`]) {
      expect((await bo.get(p)).status).toBe(404);
    }
    const boPage = await bo.get('/konto/nda');
    for (const p of [`/konto/nda/${annaNda}`, `/konto/nda/${annaNda}/kode`, `/konto/nda/${annaNda}/godkend`, `/konto/nda/${annaNda}/slet`]) {
      expect((await bo.post(p, { _csrf: csrfFrom(boPage.html), ...ANNA_FORM })).status).toBe(404);
    }
    // Kunder har ikke adgang til admin
    expect((await anna.get('/admin/nda')).status).toBe(403);
  });

  it('viser testmærkning, opsummering og hele teksten; ingen felter er afkrydset på forhånd', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Testmiljø');
    expect(page.html).toContain('Aftalen beskytter både din virksomheds og Veyros fortrolige oplysninger');
    for (const h of ['1 Formål', '2 Pligt til fortrolighed', '3 Undtagelser fra fortrolighedspligten', '4 Varighed og håndtering ved ophør', '5 Overtrædelse af aftalen', '6 Lovvalg og tvister', '7 Underskrifter']) {
      expect(page.html).toContain(h);
    }
    expect(page.html).toContain('AI-tjenester');
    expect(page.html).toContain('Underleverandører');
    expect(page.html).toContain('Tilbagelevering og sletning');
    // Kendte oplysninger er udfyldt på forhånd
    expect(page.html).toContain('value="anna@example.dk"');
    expect(page.html).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  it('gemmer kladden (overlever genindlæsning) og validerer felterne', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}`);
    const bad = await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(page.html), ...ANNA_FORM, cvr: '123', next: 'draft' });
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('CVR-nummeret skal være 8 cifre.');
    const ok = await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(page.html), ...ANNA_FORM, approver_title: '', next: 'draft' });
    expect(ok.status).toBe(303);
    const again = await anna.get(`/konto/nda/${annaNda}`);
    expect(again.html).toContain('value="Anna Byg ApS"');
    expect(again.html).toContain('value="12345678"');
  });

  it('kan ikke sendes til godkendelse, før Veyros juridiske navn er udfyldt centralt', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}`);
    const res = await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(page.html), ...ANNA_FORM, next: 'send' });
    expect(res.status).toBe(400);
    expect(res.html).toContain('Veyros juridisk navn er ikke udfyldt');
    expect(sql(`SELECT status FROM ndas WHERE id = ${annaNda}`)[0].status).toBe('draft');
    const adminList = await admin.get('/admin/nda');
    expect(adminList.html).toContain('juridisk navn');

    const s = await admin.get('/admin/fuldmagter/indstillinger');
    const saved = await admin.post('/admin/fuldmagter/indstillinger', {
      _csrf: csrfFrom(s.html), veyro_legal_name: 'TEST Veyro juridisk navn', veyro_cvr: '46857569', veyro_address: 'Albert Ibsensvej 28, 2. tv, 4200 Slagelse',
      veyro_contact_name: 'TEST kontaktperson', veyro_contact_email: 'kontakt@veyro.dk', require_veyro_acceptance: '1', pilot_emails: '',
    });
    expect(saved.status).toBe(303);
  });

  it('låser versionen og kan downloade et tydeligt mærket udkast', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}`);
    const res = await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(page.html), ...ANNA_FORM, next: 'send' });
    expect(res.status).toBe(303);
    // Dobbeltklik ændrer ikke noget
    await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(page.html), ...ANNA_FORM, next: 'send' });
    const [row] = sql(`SELECT n.status, v.state, v.version, v.content_hash FROM ndas n JOIN nda_versions v ON v.nda_id = n.id WHERE n.id = ${annaNda}`);
    expect(row).toMatchObject({ status: 'awaiting_customer', state: 'sent', version: 1 });
    const view = await anna.get(`/konto/nda/${annaNda}`);
    expect(view.html).toContain('Afventer kunden');
    expect(view.html).toContain('TEST Veyro juridisk navn');
    const { res: pdfRes, bytes } = await getBytes(anna, `/konto/nda/${annaNda}/udkast.pdf`);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    expect(pdfRes.headers.get('content-disposition')).toContain('UDKAST');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toMatch(/^UDKAST – Fortrolighedsaftale NDA-\d{4}-\d{4} version 1$/);
  });
});

describe('Godkendelse fra begge parter', () => {
  it('kræver begge bekræftelser og en korrekt engangskode', async () => {
    const { code, hash, csrf } = await customerOtp(anna, annaNda, 'anna@example.dk');
    const noConfirm = await anna.post(`/konto/nda/${annaNda}/godkend`, { _csrf: csrf, hash, code, confirm1: '1' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.html).toContain('begge bekræftelser');
    const wrong = await anna.post(`/konto/nda/${annaNda}/godkend`, { _csrf: csrf, hash, code: code === '000000' ? '111111' : '000000', confirm1: '1', confirm2: '1' });
    expect(wrong.status).toBe(400);
    expect(wrong.html).toContain('Engangskoden er forkert');
    const before = (await emails()).length;
    const ok = await anna.post(`/konto/nda/${annaNda}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toContain('besked=godkendt');
    // Dobbeltklik registrerer ikke en ekstra godkendelse
    const dup = await anna.post(`/konto/nda/${annaNda}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(dup.status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM nda_events WHERE nda_id = ${annaNda} AND type = 'approved_customer'`)[0].n).toBe(1);
    const receipt = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'anna@example.dk' && /Kvittering/.test(e.subject)));
    expect(receipt.subject).toContain('afventer Veyro');
    expect(receipt.text).toContain('AFVENTER VEYRO');
    await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@veyro.dk' && /afventer Veyro/.test(e.subject)));
    const [v] = sql(`SELECT customer_name, customer_title, customer_company, customer_email, customer_method, customer_approved_at FROM nda_versions WHERE nda_id = ${annaNda}`);
    expect(v).toMatchObject({ customer_name: 'Anna Jensen', customer_title: 'Direktør', customer_company: 'Anna Byg ApS', customer_email: 'anna@example.dk' });
    expect(v.customer_method).toContain('Ikke en MitID-underskrift');
    expect(sql(`SELECT status FROM ndas WHERE id = ${annaNda}`)[0].status).toBe('awaiting_veyro');
    const page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.html).toContain('Afventer Veyro');
  });

  it('en godkendt version kan ikke ændres i databasen', async () => {
    expect(() => sql(`UPDATE nda_versions SET form_json = '{}' WHERE nda_id = ${annaNda}`)).toThrow(/kan ikke ændres/);
    expect(() => sql(`UPDATE nda_versions SET customer_approved_at = NULL WHERE nda_id = ${annaNda}`)).toThrow(/kan ikke ændres/);
  });

  it('en ændring efter første godkendelse kræver ny godkendelse fra begge parter', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}`);
    const res = await anna.post(`/konto/nda/${annaNda}/ret`, { _csrf: csrfFrom(page.html) });
    expect(res.headers.get('location')).toContain('besked=ny-version');
    const rows = sql(`SELECT version, state, customer_approved_at FROM nda_versions WHERE nda_id = ${annaNda} ORDER BY version`);
    expect(rows.map((r) => [r.version, r.state])).toEqual([[1, 'superseded'], [2, 'draft']]);
    expect(rows[0].customer_approved_at).toBeTruthy();
    expect(rows[1].customer_approved_at).toBeNull();
    const edit = await anna.get(`/konto/nda/${annaNda}`);
    expect(edit.html).toContain('version 2');
    const sent = await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(edit.html), ...ANNA_FORM, project: 'Webshop på annabyg.dk, lagerstyring og bookingmodul', next: 'send' });
    expect(sent.status).toBe(303);
    // Veyro godkender først denne gang
    const v = await veyroApprove(annaNda);
    expect(v.status).toBe(303);
    expect(sql(`SELECT status FROM ndas WHERE id = ${annaNda}`)[0].status).toBe('awaiting_customer');
    const adminPage = await admin.get(`/admin/nda/${annaNda}`);
    expect(adminPage.html).toContain('Mangler at godkende');
    expect(adminPage.html).toMatch(/Mangler at godkende<\/dt><dd>kunden</);
  });

  it('bliver aktiv ved den sidste godkendelse og sender PDF til begge parter', async () => {
    const { code, hash, csrf } = await customerOtp(anna, annaNda, 'anna@example.dk');
    const before = (await emails()).length;
    const ok = await anna.post(`/konto/nda/${annaNda}/godkend`, { _csrf: csrf, hash, code, confirm1: '1', confirm2: '1' });
    expect(ok.headers.get('location')).toContain('besked=aktiv');
    const [n] = sql(`SELECT n.status, n.effective_at, v.customer_approved_at, v.veyro_approved_at, v.state, v.version FROM ndas n JOIN nda_versions v ON v.nda_id = n.id AND v.version = n.current_version WHERE n.id = ${annaNda}`);
    expect(n).toMatchObject({ status: 'active', state: 'approved', version: 2 });
    expect(n.effective_at).toBe(Math.max(n.customer_approved_at, n.veyro_approved_at));
    const finals = await waitFor(async () => {
      const f = (await emails()).slice(before).filter((e) => /godkendt af begge parter/.test(e.subject));
      return f.length >= 2 ? f : null;
    });
    expect(finals.map((e) => e.to[0]).sort()).toEqual(['anna@example.dk', 'kontakt@veyro.dk']);
    for (const f of finals) {
      expect(f.attachments).toHaveLength(1);
      expect(f.attachments[0].filename).toMatch(/^Fortrolighedsaftale-NDA-\d{4}-\d{4}-v2\.pdf$/);
    }
    // PDF'en i mailen er den samme som den gemte i portalen
    const { bytes } = await getBytes(anna, `/konto/nda/${annaNda}/aftale.pdf`);
    expect(Buffer.from(bytes).toString('base64')).toBe(finals[0].attachments[0].content);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toMatch(/^Fortrolighedsaftale NDA-\d{4}-\d{4} version 2$/);
    const page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.html).toContain('Aktiv');
    expect(page.html).toContain('Afslut aftalen for fremtidig udveksling');
  });

  it('PDF\'en svarer præcist til den godkendte version, også efter en ny standardskabelon', async () => {
    const [stored] = sql(`SELECT sha256 FROM nda_documents WHERE nda_id = ${annaNda} AND kind = 'final'`);
    const [ver] = sql(`SELECT snapshot_json, content_hash FROM nda_versions WHERE nda_id = ${annaNda} AND state = 'approved'`);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(ver.snapshot_json).digest('hex')).toBe(ver.content_hash);
    const snap = JSON.parse(ver.snapshot_json);
    expect(snap.project).toBe('Webshop på annabyg.dk, lagerstyring og bookingmodul');
    expect(snap.version).toBe(2);
    expect(snap.test).toBe('Testmiljø');

    const t = await admin.get('/admin/nda/skabeloner');
    const body = t.html.match(/<textarea id="tb" name="body"[^>]*>([\s\S]*?)<\/textarea>/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const saved = await admin.post('/admin/nda/skabeloner', { _csrf: csrfFrom(t.html), body: body.replace('# 5 Overtrædelse af aftalen', '# 5 Overtrædelse af aftalen (NY TEKST V2)'), footnote: 'Fodnote v2', note: 'Test' });
    expect(saved.status).toBe(303);
    const { bytes } = await getBytes(anna, `/konto/nda/${annaNda}/aftale.pdf`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(stored.sha256);
    const page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.html).not.toContain('NY TEKST V2');
    // Nye aftaler bruger den nye skabelon
    const page2 = await bo.get(`/konto/nda/${boNda}`);
    expect(page2.html).not.toContain('NY TEKST V2'); // oprettet før skabelonen
    const third = await createFor('bo@example.dk', 'Ny hjemmeside til Bo Tømrer');
    const page3 = await bo.get(`/konto/nda/${third}`);
    expect(page3.html).toContain('NY TEKST V2');
    sql(`DELETE FROM ndas WHERE id = ${third}`);
  });

  it('en aktiv aftale kan ikke redigeres eller åbnes for rettelser', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}`);
    const edit = await anna.post(`/konto/nda/${annaNda}`, { _csrf: csrfFrom(page.html), ...ANNA_FORM, company_name: 'Ændret ApS', next: 'draft' });
    expect(edit.headers.get('location')).toContain('ikke-muligt');
    const reopen = await anna.post(`/konto/nda/${annaNda}/ret`, { _csrf: csrfFrom(page.html) });
    expect(reopen.headers.get('location')).toContain('ikke-muligt');
    const adminEdit = await admin.post(`/admin/nda/${annaNda}/ret`, { _csrf: csrfFrom((await admin.get(`/admin/nda/${annaNda}`)).html) });
    expect(adminEdit.headers.get('location')).toContain('ikke-muligt');
    expect(sql(`SELECT company_name FROM ndas WHERE id = ${annaNda}`)[0].company_name).toBe('Anna Byg ApS');
  });
});

describe('Ophør og fortsat fortrolighed', () => {
  it('registrerer ophøret, viser ærligt at meddelelsen ikke er leveret, og opretter en opgave', async () => {
    await setMockState(stack.mock, { failEmailTo: ['kontakt@veyro.dk'] });
    const confirm = await anna.get(`/konto/nda/${annaNda}/ophoer`);
    expect(confirm.status).toBe(200);
    expect(confirm.html).toContain('Fortrolighedsforpligtelserne for allerede modtagne oplysninger fortsætter efter aftalens vilkår');
    expect(confirm.html).toContain('opsiger ikke i sig selv dit abonnement');
    const res = await anna.post(`/konto/nda/${annaNda}/ophoer`, { _csrf: csrfFrom(confirm.html) });
    expect(res.headers.get('location')).toContain('besked=ophoert');
    await waitFor(async () => sql(`SELECT status FROM nda_mails WHERE nda_id = ${annaNda} AND kind = 'termination_notice'`)[0]?.status === 'failed');
    const [n] = sql(`SELECT status, terminated_party, terminated_by, termination_notice FROM ndas WHERE id = ${annaNda}`);
    expect(n).toMatchObject({ status: 'terminated', terminated_party: 'kunde', terminated_by: 'anna@example.dk' });
    expect(n.termination_notice).toContain('afslutter hermed fortrolighedsaftale');
    expect(sql(`SELECT COUNT(*) AS n FROM nda_tasks WHERE nda_id = ${annaNda} AND status = 'open'`)[0].n).toBe(1);
    const page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.html).toContain('Ophørt for fremtidig udveksling');
    expect(page.html).toContain('ikke leveret');
    const section = page.html.slice(page.html.indexOf('id="end-h"'), page.html.indexOf('Se meddelelsen'));
    expect(section).toContain('Fejlede');
    expect(section).not.toContain('Afleveret til mailudbyderen');
    // Abonnementet er ikke berørt
    expect((await anna.get('/konto')).html).toContain('Business');
    // Kan ikke genaktiveres
    expect(() => sql(`UPDATE ndas SET status = 'active' WHERE id = ${annaNda}`)).toThrow(/genaktiveres/);
  });

  it('Veyro kan forsøge igen; først da vises meddelelsen som leveret', async () => {
    await setMockState(stack.mock, { failEmailTo: [] });
    const page = await admin.get(`/admin/nda/${annaNda}`);
    expect(page.html).toContain('kunne ikke leveres');
    const [m] = sql(`SELECT id FROM nda_mails WHERE nda_id = ${annaNda} AND kind = 'termination_notice'`);
    const retry = await admin.post(`/admin/nda/${annaNda}/mails/${m.id}`, { _csrf: csrfFrom(page.html) });
    expect(retry.headers.get('location')).toContain('mail-sendt');
    const view = await anna.get(`/konto/nda/${annaNda}`);
    expect(view.html).toContain('Afleveret til mailudbyderen');
    expect(view.html).toContain('ikke en bekræftelse af, at modtageren har læst den');
    const { res, bytes } = await getBytes(anna, `/konto/nda/${annaNda}/ophoer.pdf`);
    expect(res.status).toBe(200);
    expect((await PDFDocument.load(bytes)).getTitle()).toContain('Kvittering for ophør');
    // Veyro kan også hente kvitteringen
    expect((await getBytes(admin, `/admin/nda/${annaNda}/ophoer.pdf`)).res.status).toBe(200);
  });

  it('beregner kun en vejledende slutdato, når samarbejdets ophør er kendt', async () => {
    let page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.html).toContain('Kan ikke beregnes endnu');
    expect(page.html).toContain('Ingen oplysninger bliver automatisk frie til brug');
    const a = await admin.get(`/admin/nda/${annaNda}`);
    const future = await admin.post(`/admin/nda/${annaNda}/samarbejde`, { _csrf: csrfFrom(a.html), cooperation: 'ended', ended_on: '2099-01-01' });
    expect(future.status).toBe(400);
    const ok = await admin.post(`/admin/nda/${annaNda}/samarbejde`, { _csrf: csrfFrom(a.html), cooperation: 'ended', ended_on: '2026-01-15' });
    expect(ok.status).toBe(303);
    // Det seneste af samarbejdets ophør (15/1 2026) og aftalens ophør (i dag) + 5 år
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
    const expected = `${Number(today.slice(0, 4)) + 5}${today.slice(4)}`;
    const fmt = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(expected + 'T00:00:00Z'));
    page = await anna.get(`/konto/nda/${annaNda}`);
    expect(page.html).toContain(fmt);
    expect(page.html).toContain('Forretningshemmeligheder er beskyttet, så længe de har den karakter');
  });
});

describe('Sletning og tilbagelevering', () => {
  let infoReq;
  it('anmodning om tilbagelevering/sletning af delte oplysninger med begrundelse for det, der beholdes', async () => {
    const form = await anna.get(`/konto/nda/${annaNda}/oplysninger`);
    expect(form.status).toBe(200);
    const idem = form.html.match(/name="_idem" value="([^"]+)"/)[1];
    const bad = await anna.post(`/konto/nda/${annaNda}/oplysninger`, { _csrf: csrfFrom(form.html), _idem: idem, description: 'Lagerdata' });
    expect(bad.status).toBe(400);
    const before = (await emails()).length;
    const res = await anna.post(`/konto/nda/${annaNda}/oplysninger`, { _csrf: csrfFrom(form.html), _idem: idem, choice: 'delete', description: 'Lagerdata og leverandørpriser sendt i marts' });
    expect(res.status).toBe(303);
    const dup = await anna.post(`/konto/nda/${annaNda}/oplysninger`, { _csrf: csrfFrom(form.html), _idem: idem, choice: 'delete', description: 'Lagerdata og leverandørpriser sendt i marts' });
    expect(dup.headers.get('location')).toBe(res.headers.get('location'));
    infoReq = Number(res.headers.get('location').match(/anmodninger\/(\d+)/)[1]);
    await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@veyro.dk' && /Ny anmodning/.test(e.subject)));
    // Bo kan ikke se anmodningen
    expect((await bo.get(`/konto/nda/anmodninger/${infoReq}`)).status).toBe(404);

    const a = await admin.get(`/admin/nda/anmodninger/${infoReq}`);
    expect(a.html).toContain('Lagerdata og leverandørpriser sendt i marts');
    const missingReason = await admin.post(`/admin/nda/anmodninger/${infoReq}`, { _csrf: csrfFrom(a.html), outcome: 'retained', result_text: 'Lagerdata er slettet fra udviklingsmiljøet.', retained_info: 'Faktura', retention_reason: '', retain_until: '2031-12-31' });
    expect(missingReason.status).toBe(400);
    const done = await admin.post(`/admin/nda/anmodninger/${infoReq}`, {
      _csrf: csrfFrom(a.html), outcome: 'retained', result_text: 'Lagerdata er slettet fra udviklingsmiljøet og vores sikkerhedskopier følger backupcyklussen.',
      retained_info: 'Leverandørprisliste vedlagt faktura', retention_reason: 'Lovpligtig opbevaring efter bogføringsloven', retain_until: '2031-12-31',
    });
    expect(done.status).toBe(303);
    const view = await anna.get(`/konto/nda/anmodninger/${infoReq}`);
    expect(view.html).toContain('Gennemført – noget beholdes');
    expect(view.html).toContain('Lovpligtig opbevaring efter bogføringsloven');
    expect(view.html).toContain('31. december 2031');
    await waitFor(async () => (await emails()).find((e) => e.to[0] === 'anna@example.dk' && /Resultat af din anmodning/.test(e.subject)));
    // Aftalen er uændret
    expect(sql(`SELECT status FROM ndas WHERE id = ${annaNda}`)[0].status).toBe('terminated');
  });

  it('sletning af et godkendt aftaledokument kræver vurdering og sletter rigtigt', async () => {
    const page = await anna.get(`/konto/nda/${annaNda}/slet`);
    expect(page.html).toContain('Anmod om sletning af aftaledokumentet');
    expect(page.html).toContain('ophæver ikke aftalens forpligtelser');
    const idem = page.html.match(/name="_idem" value="([^"]+)"/)[1];
    const res = await anna.post(`/konto/nda/${annaNda}/slet`, { _csrf: csrfFrom(page.html), _idem: idem });
    expect(res.status).toBe(303);
    const rid = Number(res.headers.get('location').match(/anmodninger\/(\d+)/)[1]);
    // Sletteanmodningen vises særskilt fra aftalens status
    const [n] = sql(`SELECT status, deletion_status FROM ndas WHERE id = ${annaNda}`);
    expect(n).toMatchObject({ status: 'terminated', deletion_status: 'requested' });
    const list = await anna.get('/konto/nda');
    expect(list.html).toContain('Sletning anmodet');
    expect(list.html).toContain('Ophørt for fremtidig udveksling');

    const a = await admin.get(`/admin/nda/anmodninger/${rid}`);
    const done = await admin.post(`/admin/nda/anmodninger/${rid}`, { _csrf: csrfFrom(a.html), outcome: 'completed', result_text: 'Aftalen, versioner, godkendelser, PDF og mails er slettet i kundeportalen.' });
    expect(done.status).toBe(303);
    for (const t of ['ndas WHERE id', 'nda_versions WHERE nda_id', 'nda_documents WHERE nda_id', 'nda_mails WHERE nda_id', 'nda_events WHERE nda_id']) {
      expect(sql(`SELECT COUNT(*) AS n FROM ${t} = ${annaNda}`)[0].n).toBe(0);
    }
    expect((await anna.get(`/konto/nda/${annaNda}`)).status).toBe(404);
    // Kunden kan stadig se resultatet af begge anmodninger
    const view = await anna.get(`/konto/nda/anmodninger/${rid}`);
    expect(view.status).toBe(200);
    expect(view.html).toContain('Gennemført');
    expect(view.html).toContain('ophæver ikke aftalens forpligtelser');
    expect((await anna.get(`/konto/nda/anmodninger/${infoReq}`)).status).toBe(200);
  });

  it('en kladde uden godkendelser kan slettes direkte', async () => {
    const page = await bo.get(`/konto/nda/${boNda}/slet`);
    expect(page.html).toContain('Slet kladden');
    const res = await bo.post(`/konto/nda/${boNda}/slet`, { _csrf: csrfFrom(page.html), _idem: page.html.match(/name="_idem" value="([^"]+)"/)[1] });
    expect(res.headers.get('location')).toContain('kladde-slettet');
    expect(sql(`SELECT COUNT(*) AS n FROM ndas WHERE id = ${boNda}`)[0].n).toBe(0);
  });
});

describe('Mobil og adgang', () => {
  it('siderne har mobilvenlig opsætning og kræver login', async () => {
    const page = await anna.get('/konto/nda');
    expect(page.html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    const anon = new Client(stack.base);
    expect((await anon.get('/konto/nda')).status).toBe(303);
    expect((await anon.get('/admin/nda')).status).toBe(303);
  });
});
