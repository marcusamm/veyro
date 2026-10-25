// Import af kundeemner fra Excel/CSV (forhåndsvisning, dubletter, blacklist, slet fil, fortryd) og statusser på forespørgsler.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, startStack } from './harness.mjs';

let stack;
let admin;

function sql(query) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--json', '--command', query],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0].results;
}

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const stripeCalls = async () => (await fetch(stack.mock.url + '/__mock/calls')).json();
const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();

/** Windows-1252 (som ældre Excel gemmer CSV på dansk) */
function cp1252(s) {
  return Buffer.from([...s].map((ch) => ch.charCodeAt(0)));
}

// ---------- Minimal .xlsx-bygger (rigtigt komprimeret ZIP) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const nameB = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameB.length, 26);
    locals.push(h, nameB, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Object.keys(files).length, 8);
  e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

function xlsx({ macro = false } = {}) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Noter" sheetId="1" r:id="rId1"/><sheet name="Kunder Øst" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Virksomhed</t></si><si><t>Telefon</t></si><si><t>Mail</t></si><si><t>Område</t></si><si><r><t>Ærø </t></r><r><t>Bryghus ApS</t></r></si><si><t>Søby</t></si><si><t>bo@aeroebryg.dk</t></si><si><t>Kontakt</t></si><si><t>Blåbær &amp; Co</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Bare noter</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>7</v></c></row>
      <row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>4562526789</v></c><c r="C2" t="s"><v>6</v></c><c r="D2" t="s"><v>5</v></c><c r="E2" t="str"><f>CONCAT("Bo ","Ø")</f><v>Bo Ø</v></c></row>
      <row r="4"><c r="A4" t="s"><v>8</v></c><c r="B4" t="inlineStr"><is><t>+45 0012 3456</t></is></c><c r="D4" t="inlineStr"><is><t>Århus C</t></is></c></row>
    </sheetData></worksheet>`,
  };
  if (macro) files['xl/vbaProject.bin'] = 'binær';
  return zip(files);
}

// ---------- Hjælpere ----------

async function upload(name, bytes, client = admin) {
  const page = await client.get('/admin/kundeemner/import');
  const fd = new FormData();
  fd.set('_csrf', csrfFrom(page.html));
  fd.set('file', new Blob([bytes]), name);
  const res = await fetch(stack.base + '/admin/kundeemner/import', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: client.cookieHeader(), Origin: stack.base, 'CF-Connecting-IP': client.ip },
    body: fd,
  });
  const html = await res.text();
  const loc = res.headers.get('location');
  return { status: res.status, html, id: loc ? Number(loc.match(/import\/(\d+)/)[1]) : null };
}

/** Bekræfter med de kolonner, forhåndsvisningen viste (skjulte felter i bekræftelsesformularen) */
async function confirm(id, extra = {}, query = '') {
  const page = await admin.get(`/admin/kundeemner/import/${id}${query}`);
  const form = page.html.match(/<form method="post" action="\/admin\/kundeemner\/import\/\d+\/bekraeft"[\s\S]*?<\/form>/)[0];
  const fields = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.append(m[1], m[2].replace(/&amp;/g, '&'));
  for (const [k, v] of Object.entries(extra)) for (const x of [].concat(v)) fields.append(k, x);
  return postRaw(`/admin/kundeemner/import/${id}/bekraeft`, fields);
}

async function postRaw(p, params) {
  const res = await fetch(stack.base + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: admin.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': admin.ip },
    body: params.toString(),
  });
  return Object.assign(res, { html: await res.text() });
}

async function send(pageUrl, action, form = {}) {
  const page = await admin.get(pageUrl);
  return admin.post(action, { _csrf: csrfFrom(page.html), ...form });
}

const prospectsOf = (id) => sql(`SELECT * FROM prospects WHERE import_id = ${id} ORDER BY import_row`);
const contactsOf = (pid) => sql(`SELECT kind, value FROM prospect_contacts WHERE prospect_id = ${pid} ORDER BY kind, id`);

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  admin = (await login(stack, ADMIN_EMAIL)).client;
}, 120_000);

afterAll(async () => {
  await stack?.stop();
});

describe('adgang', () => {
  it('kræver admin på serveren, også for originalfilen', async () => {
    const anon = new Client(stack.base);
    for (const p of ['/admin/kundeemner/import', '/admin/kundeemner/import/1', '/admin/kundeemner/import/1/fil', '/admin/kundeemner/import/1/fortryd']) {
      expect((await anon.get(p)).status, p).toBe(303);
    }
    sql(`INSERT INTO customers (email, name, created_at, updated_at) VALUES ('ikke-admin@example.com', 'Kunde', 1, 1)`);
    const { client } = await login(stack, 'ikke-admin@example.com');
    expect((await client.get('/admin/kundeemner/import')).status).toBe(403);
    const r = await upload('x.csv', Buffer.from('Firma\nA\n'), client);
    expect(r.status).toBe(403);
  });
});

describe('validering af filen på serveren', () => {
  it('afviser makroer, forkerte filtyper, falske .xlsx og for store filer', async () => {
    let r = await upload('makro.xlsx', xlsx({ macro: true }));
    expect(r.status).toBe(400);
    expect(text(r.html)).toContain('indeholder makroer');
    r = await upload('makro.xlsm', xlsx());
    expect(r.status).toBe(400);
    r = await upload('falsk.xlsx', Buffer.from('Firma;Tlf\nA;1\n'));
    expect(r.status).toBe(400);
    expect(text(r.html)).toContain('ikke en Excel-projektmappe');
    r = await upload('billede.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(r.status).toBe(400);
    r = await upload('stor.csv', Buffer.alloc(5_000_001, 0x41));
    expect(r.status).toBe(400);
    expect(text(r.html)).toContain('større end 5 MB');
    expect(sql('SELECT COUNT(*) AS n FROM prospect_imports')[0].n).toBe(0);
  });
});

let csvImportId;

describe('CSV med semikolon og danske tegn (Windows-1252)', () => {
  it('genkender kolonner, viser fejl og importerer først efter bekræftelse', async () => {
    const csv =
      'Firmanavn;Kontaktperson;Mail;Tlf.;Website;By/område;Bemærkninger\r\n' +
      'Østergaard Blomster ApS;Søren Ærbø;soren@oestergaard-blomster.dk;0045 12 34 56 78;oestergaard-blomster.dk;Næstved;Ring efter kl. 10\r\n' +
      'Håndværkerhuset;;info@haandvaerkerhuset.dk;01234567;;Køge;\r\n' +
      ';Uden Firma;;;;;\r\n' +
      'Dårlig Mail A/S;;ikke-en-mail;;;;\r\n' +
      ';;;;;;\r\n' +
      '"Citat; med semikolon";;;+4587654321;;"Aabenraa";"Linje 1\nLinje 2"\r\n';
    const up = await upload('kunder øst.csv', cp1252(csv));
    expect(up.status).toBe(303);
    csvImportId = up.id;
    const page = await admin.get(`/admin/kundeemner/import/${up.id}`);
    expect(page.status).toBe(200);
    const t = text(page.html);
    expect(t).toContain('Tegnsæt: Windows-1252');
    expect(t).toContain('fundet: semikolon');
    // Automatisk kolonnegenkendelse
    expect(page.html).toMatch(/<select id="k-phone" name="k_phone">[\s\S]*?<option value="3" selected>/);
    expect(page.html).toMatch(/<select id="k-email" name="k_email">[\s\S]*?<option value="2" selected>/);
    expect(page.html).toMatch(/<select id="k-website" name="k_website">[\s\S]*?<option value="4" selected>/);
    expect(page.html).toMatch(/<select id="k-city" name="k_city">[\s\S]*?<option value="5" selected>/);
    expect(t).toContain('Rækker med data 5');
    expect(t).toContain('Gyldige og klar til import 3');
    expect(t).toContain('Rækker med fejl 2');
    expect(t).toContain('Tomme rækker (ignoreres) 1');
    expect(t).toContain('Virksomhedsnavn mangler');
    expect(t).toContain('"ikke-en-mail" er ikke en gyldig e-mailadresse');
    expect(t).toContain('Østergaard Blomster ApS');
    // Intet er oprettet ved upload og forhåndsvisning
    expect(prospectsOf(up.id)).toHaveLength(0);

    // Fejl uden valg om at springe over: afvises
    const no = await confirm(up.id);
    expect(no.status).toBe(400);
    expect(text(no.html)).toContain('2 rækker har fejl');
    expect(prospectsOf(up.id)).toHaveLength(0);

    const before = { stripe: (await stripeCalls()).length, mails: (await emails()).length };
    const ok = await confirm(up.id, { spring_fejl: '1' });
    expect(ok.status).toBe(303);
    const rows = prospectsOf(up.id);
    expect(rows.map((r) => r.company)).toEqual(['Østergaard Blomster ApS', 'Håndværkerhuset', 'Citat; med semikolon']);
    const [a, b, c] = rows;
    expect(a.contact_name).toBe('Søren Ærbø');
    expect(a.city).toBe('Næstved');
    expect(a.notes).toBe('Ring efter kl. 10');
    expect(a.website).toBe('https://oestergaard-blomster.dk/');
    expect(a.domain).toBe('oestergaard-blomster.dk');
    expect(a.status).toBe('undersoeges');
    expect(a.customer_id).toBeNull();
    expect(a.import_row).toBe(2);
    expect(contactsOf(a.id)).toEqual([
      { kind: 'email', value: 'soren@oestergaard-blomster.dk' },
      { kind: 'phone', value: '0045 12 34 56 78' },
    ]);
    // Foranstillet nul og landekode bevares som tekst
    expect(contactsOf(b.id)).toContainEqual({ kind: 'phone', value: '01234567' });
    expect(contactsOf(c.id)).toContainEqual({ kind: 'phone', value: '+4587654321' });
    expect(c.notes).toBe('Linje 1\nLinje 2');
    expect(c.city).toBe('Aabenraa');
    // Ingen mails, ingen Stripe-kald, ingen kunder
    expect((await stripeCalls()).length).toBe(before.stripe);
    expect((await emails()).length).toBe(before.mails);
    expect(sql("SELECT COUNT(*) AS n FROM customers WHERE email LIKE '%oestergaard%'")[0].n).toBe(0);

    const imp = sql(`SELECT * FROM prospect_imports WHERE id = ${up.id}`)[0];
    expect(imp).toMatchObject({ status: 'importeret', created_count: 3, skipped_errors: 2, skipped_duplicates: 0, imported_by: ADMIN_EMAIL });
    const summary = text((await admin.get(`/admin/kundeemner/import/${up.id}`)).html);
    expect(summary).toContain('Oprettet 3');
    expect(summary).toContain('Sprunget over: fejl 2');
    const ev = sql(`SELECT body FROM prospect_events WHERE prospect_id = ${a.id} AND kind = 'created'`)[0];
    expect(ev.body).toContain('Importeret fra kunder øst.csv (række 2)');
  });

  it('gentagen bekræftelse og genforsøg opretter ikke dobbelt', async () => {
    const again = await confirm(csvImportId, { spring_fejl: '1' }).catch(() => null);
    // Bekræftelsesformularen vises ikke længere; et direkte genforsøg sendes til resultatet
    const direct = await postRaw(
      `/admin/kundeemner/import/${csvImportId}/bekraeft`,
      new URLSearchParams({ _csrf: csrfFrom((await admin.get('/admin/kundeemner/import')).html), kolonner: '1', k_company: '0', spring_fejl: '1' }),
    );
    expect(direct.status).toBe(303);
    expect(again).toBeNull();
    expect(prospectsOf(csvImportId)).toHaveLength(3);
  });

  it('samtidige bekræftelser opretter kun én gang', async () => {
    const up = await upload('samtidig.csv', Buffer.from('Firma,Mail\nSamtidig Et,et@samtidig-et.dk\nSamtidig To,to@samtidig-to.dk\n'));
    const page = await admin.get(`/admin/kundeemner/import/${up.id}`);
    const form = page.html.match(/<form method="post" action="\/admin\/kundeemner\/import\/\d+\/bekraeft"[\s\S]*?<\/form>/)[0];
    const fields = new URLSearchParams();
    for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.append(m[1], m[2]);
    const res = await Promise.all([1, 2, 3].map(() => postRaw(`/admin/kundeemner/import/${up.id}/bekraeft`, fields)));
    expect(res.every((r) => r.status === 303)).toBe(true);
    expect(prospectsOf(up.id)).toHaveLength(2);
    expect(sql(`SELECT created_count FROM prospect_imports WHERE id = ${up.id}`)[0].created_count).toBe(2);
  });
});

let dupImportId;

describe('CSV med komma, manglende valgfrie felter og dubletter', () => {
  it('markerer dubletter, springer dem over som standard og overskriver aldrig', async () => {
    const existing = sql(`SELECT * FROM prospects WHERE company = 'Østergaard Blomster ApS'`)[0];
    const csv =
      '﻿Company,Website\n' +
      'Østergaard Blomster ApS,\n' + // samme navn
      'Andet Navn,https://www.oestergaard-blomster.dk/kontakt\n' + // samme domæne
      'Ny Café Ø,cafe-oe.dk\n' +
      'Ny Café Ø,\n' + // dublet inde i filen
      'Helt Ny Virksomhed,\n';
    const up = await upload('dubletter.csv', Buffer.from(csv, 'utf8'));
    dupImportId = up.id;
    const page = await admin.get(`/admin/kundeemner/import/${up.id}`);
    const t = text(page.html);
    expect(t).toContain('Tegnsæt: UTF-8');
    expect(t).toContain('fundet: komma');
    expect(t).toContain('Mulige dubletter 3');
    expect(t).toContain('Samme virksomhedsnavn: kundeemnet "Østergaard Blomster ApS"');
    expect(t).toContain('Samme domæne (oestergaard-blomster.dk)');
    expect(t).toContain('Samme virksomhedsnavn som række 4 i filen');
    // Opret række 3 (samme domæne) alligevel; de andre dubletter springes over
    const res = await confirm(up.id, { dublet_ok: '3' });
    expect(res.status).toBe(303);
    const rows = prospectsOf(up.id);
    expect(rows.map((r) => r.company)).toEqual(['Andet Navn', 'Ny Café Ø', 'Helt Ny Virksomhed']);
    expect(rows.every((r) => r.city === null && r.contact_name === null && r.notes === null)).toBe(true);
    const after = sql(`SELECT * FROM prospects WHERE id = ${existing.id}`)[0];
    expect(after).toEqual(existing);
    expect(sql(`SELECT skipped_duplicates FROM prospect_imports WHERE id = ${up.id}`)[0].skipped_duplicates).toBe(2);
  });
});

describe('blacklistede virksomheder', () => {
  it('importeres ikke igen uden udtrykkeligt valg og begrundelse, og blokeringen gælder fortsat', async () => {
    sql(`INSERT INTO prospect_blocks (scope, value, company, reason, created_at, created_by) VALUES ('domain', 'spaerret.dk', 'Spærret ApS', 'Ønsker ikke kontakt', 1, '${ADMIN_EMAIL}')`);
    const up = await upload('blokeret.csv', Buffer.from('Firma;Mail\nSpærret ApS;salg@spaerret.dk\nTilladt ApS;hej@tilladt.dk\n'));
    const t = text((await admin.get(`/admin/kundeemner/import/${up.id}`)).html);
    expect(t).toContain('Blacklistede 1');
    expect(t).toContain('er blacklistet (Ønsker ikke kontakt)');
    // Uden begrundelse: afvist
    const noReason = await confirm(up.id, { medtag_blokerede: '1' });
    expect(noReason.status).toBe(400);
    expect(prospectsOf(up.id)).toHaveLength(0);
    // Standard: springes over
    const up2 = await upload('blokeret2.csv', Buffer.from('Firma;Mail\nSpærret ApS;salg@spaerret.dk\n'));
    expect((await confirm(up2.id)).status).toBe(303);
    expect(prospectsOf(up2.id)).toHaveLength(0);
    expect(sql(`SELECT skipped_blocked FROM prospect_imports WHERE id = ${up2.id}`)[0].skipped_blocked).toBe(1);
    // Med valg og begrundelse: oprettes som blacklistet
    expect((await confirm(up.id, { medtag_blokerede: '1', blokering_aarsag: 'Ny ejer har bedt om tilbud' })).status).toBe(303);
    const rows = prospectsOf(up.id);
    expect(rows.find((r) => r.company === 'Spærret ApS').blacklisted).toBe(1);
    expect(rows.find((r) => r.company === 'Tilladt ApS').blacklisted).toBe(0);
    expect(sql("SELECT lifted_at FROM prospect_blocks WHERE value = 'spaerret.dk'")[0].lifted_at).toBeNull();
  });
});

let xlsxImportId;

describe('Excel med flere ark', () => {
  it('lader mig vælge arket, læser danske tegn og beregner ikke formler', async () => {
    const up = await upload('emner.xlsx', xlsx());
    expect(up.status).toBe(303);
    xlsxImportId = up.id;
    let page = await admin.get(`/admin/kundeemner/import/${up.id}`);
    expect(page.html).toContain('Kunder Øst');
    expect(text(page.html)).toContain('Vælg, hvilken kolonne der indeholder virksomhedsnavnet');
    page = await admin.get(`/admin/kundeemner/import/${up.id}?ark=1`);
    const t = text(page.html);
    expect(t).toContain('Ærø Bryghus ApS');
    expect(t).toContain('1 celle indeholder en formel');
    expect(t).toContain('Gyldige og klar til import 2');
    // Kontaktpersonen (formelresultatet) vælges manuelt, og Mail fravælges
    const res = await confirm(up.id, {}, '?ark=1&kolonner=1&k_company=0&k_phone=1&k_city=3&k_contact_name=4');
    expect(res.status).toBe(303);
    const rows = prospectsOf(up.id);
    expect(rows.map((r) => [r.company, r.city, r.contact_name, r.import_row])).toEqual([
      ['Ærø Bryghus ApS', 'Søby', 'Bo Ø', 2],
      ['Blåbær & Co', 'Århus C', null, 4],
    ]);
    expect(contactsOf(rows[0].id)).toEqual([{ kind: 'phone', value: '4562526789' }]);
    expect(contactsOf(rows[1].id)).toEqual([{ kind: 'phone', value: '+45 0012 3456' }]);
  });
});

describe('slet fil', () => {
  it('fjerner originalfilen fra lagringen og admin, men bevarer kundeemnerne', async () => {
    expect(sql(`SELECT COUNT(*) AS n FROM prospect_import_chunks WHERE import_id = ${xlsxImportId}`)[0].n).toBeGreaterThan(0);
    const dl = await admin.get(`/admin/kundeemner/import/${xlsxImportId}/fil`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    const page = await admin.get(`/admin/kundeemner/import/${xlsxImportId}`);
    expect(text(page.html)).toContain('De 2 kundeemner, der blev oprettet ved importen, bevares');
    // Uden bekræftelse: intet slettes
    let r = await admin.post(`/admin/kundeemner/import/${xlsxImportId}/slet-fil`, { _csrf: csrfFrom(page.html) });
    expect(r.status).toBe(400);
    r = await admin.post(`/admin/kundeemner/import/${xlsxImportId}/slet-fil`, { _csrf: csrfFrom(page.html), confirm: '1' });
    expect(r.status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM prospect_import_chunks WHERE import_id = ${xlsxImportId}`)[0].n).toBe(0);
    expect(prospectsOf(xlsxImportId)).toHaveLength(2);
    expect((await admin.get(`/admin/kundeemner/import/${xlsxImportId}/fil`)).status).toBe(404);
    const list = text((await admin.get('/admin/kundeemner/import')).html);
    expect(list).toContain('Fil slettet');
    expect(sql(`SELECT status, file_deleted_by FROM prospect_imports WHERE id = ${xlsxImportId}`)[0]).toEqual({ status: 'importeret', file_deleted_by: ADMIN_EMAIL });
  });

  it('kan slette filen før import, hvorefter importen ikke kan gennemføres', async () => {
    const up = await upload('fortrudt.csv', Buffer.from('Firma\nAldrig Importeret\n'));
    const page = await admin.get(`/admin/kundeemner/import/${up.id}`);
    await admin.post(`/admin/kundeemner/import/${up.id}/slet-fil`, { _csrf: csrfFrom(page.html), confirm: '1' });
    expect(sql(`SELECT status FROM prospect_imports WHERE id = ${up.id}`)[0].status).toBe('annulleret');
    const r = await postRaw(`/admin/kundeemner/import/${up.id}/bekraeft`, new URLSearchParams({ _csrf: csrfFrom(page.html), kolonner: '1', k_company: '0' }));
    expect(r.status).toBe(303);
    expect(prospectsOf(up.id)).toHaveLength(0);
  });
});

describe('fortryd import', () => {
  it('sletter kun uberørte kundeemner fra importen og aldrig eksisterende eller aktive kunder', async () => {
    const rows = prospectsOf(csvImportId);
    const [edited, converted, untouched] = rows;
    const preExisting = sql(`SELECT id FROM prospects WHERE company = 'Østergaard Blomster ApS' AND import_id = ${csvImportId}`)[0];
    expect(preExisting.id).toBe(edited.id);
    // Kontakt registreret på ét, et andet konverteret til kunde
    await send(`/admin/kundeemner/${edited.id}`, `/admin/kundeemner/${edited.id}/kontakt`, { channel: 'telefon', at: `${new Date(Date.now() - 86400_000).toISOString().slice(0, 10)}T10:00`, staff: ADMIN_EMAIL, body: 'Ringede' });
    sql(`INSERT INTO customers (email, name, created_at, updated_at) VALUES ('kunde@haandvaerkerhuset.dk', 'Håndværkerhuset', 1, 1)`);
    const cust = sql(`SELECT id FROM customers WHERE email = 'kunde@haandvaerkerhuset.dk'`)[0].id;
    await send(`/admin/kundeemner/${converted.id}`, `/admin/kundeemner/${converted.id}/kunde`, { customer: String(cust) });
    expect(sql(`SELECT customer_id FROM prospects WHERE id = ${converted.id}`)[0].customer_id).toBe(cust);
    expect(sql(`SELECT last_contact_at FROM prospects WHERE id = ${edited.id}`)[0].last_contact_at).not.toBeNull();
    const page = await admin.get(`/admin/kundeemner/import/${csvImportId}/fortryd`);
    const t = text(page.html);
    expect(t).toContain('Kan slettes (1)');
    expect(t).toContain('Slettes ikke automatisk (2)');
    expect(t).toContain('Har fået kontaktaktivitet');
    expect(t).toContain('Er konverteret til aktiv kunde');
    // Et eksisterende kundeemne fra en anden import og de beskyttede sendes med; kun det uberørte må slettes
    const other = prospectsOf(dupImportId)[0];
    const otherExisting = sql(`SELECT id FROM prospects WHERE import_id IS NULL LIMIT 1`)[0];
    const ids = [edited.id, converted.id, untouched.id, other.id, ...(otherExisting ? [otherExisting.id] : [])];
    const params = new URLSearchParams({ _csrf: csrfFrom(page.html), confirm: '1' });
    for (const id of ids) params.append('id', String(id));
    const res = await postRaw(`/admin/kundeemner/import/${csvImportId}/fortryd`, params);
    expect(res.status).toBe(200);
    expect(text(res.html)).toContain('1 kundeemne er slettet. 2 blev ikke slettet');
    expect(sql(`SELECT id FROM prospects WHERE id = ${untouched.id}`)).toHaveLength(0);
    expect(sql(`SELECT id FROM prospects WHERE id IN (${edited.id}, ${converted.id}, ${other.id})`)).toHaveLength(3);
    expect(sql(`SELECT COUNT(*) AS n FROM customers WHERE id = ${cust}`)[0].n).toBe(1);
    expect(sql(`SELECT COUNT(*) AS n FROM prospect_contacts WHERE prospect_id = ${untouched.id}`)[0].n).toBe(0);
    expect(sql(`SELECT status, undone_count FROM prospect_imports WHERE id = ${csvImportId}`)[0]).toEqual({ status: 'delvist_fortrudt', undone_count: 1 });
  });

  it('bevarer blacklisting, når et importeret kundeemne slettes', async () => {
    const blockedImport = sql("SELECT import_id FROM prospects WHERE company = 'Spærret ApS'")[0].import_id;
    const rows = prospectsOf(blockedImport);
    const page = await admin.get(`/admin/kundeemner/import/${blockedImport}/fortryd`);
    const params = new URLSearchParams({ _csrf: csrfFrom(page.html), confirm: '1' });
    for (const r of rows) params.append('id', String(r.id));
    await postRaw(`/admin/kundeemner/import/${blockedImport}/fortryd`, params);
    expect(prospectsOf(blockedImport)).toHaveLength(0);
    expect(sql(`SELECT status FROM prospect_imports WHERE id = ${blockedImport}`)[0].status).toBe('fortrudt');
    expect(sql("SELECT lifted_at FROM prospect_blocks WHERE value = 'spaerret.dk'")[0].lifted_at).toBeNull();
    // En ny import af samme virksomhed bliver stadig fanget af blokeringen
    const up = await upload('igen.csv', Buffer.from('Firma;Mail\nSpærret ApS;salg@spaerret.dk\n'));
    expect(text((await admin.get(`/admin/kundeemner/import/${up.id}`)).html)).toContain('Blacklistede 1');
  });

  it('viser importoversigten med filnavn, tidspunkt, bruger, antal og status', async () => {
    const page = await admin.get('/admin/kundeemner/import');
    const t = text(page.html);
    expect(t).toContain('kunder øst.csv');
    expect(t).toContain('Delvist fortrudt');
    expect(t).toContain('Fortrudt');
    expect(t).toContain(ADMIN_EMAIL);
    expect(t).toContain('1 fortrudt, 2 tilbage');
    const list = await admin.get(`/admin/kundeemner?visning=alle&import=${dupImportId}`);
    expect(text(list.html)).toContain('3 kundeemner');
  });
});

describe('forespørgsler: flere statusser', () => {
  it('kan sætte status manuelt, filtrere og se historik uden mails, betalinger eller kunder', async () => {
    const now = Math.floor(Date.now() / 1000);
    sql(`INSERT INTO leads (kind, name, email, phone, message, fields, status, created_at, updated_at) VALUES ('kontakt', 'Telefon Tina', 'tina@telefon.dk', '12345678', 'Ring mig op', '{}', 'ny', ${now}, ${now})`);
    const lead = sql("SELECT id FROM leads WHERE email = 'tina@telefon.dk'")[0];
    const before = { stripe: (await stripeCalls()).length, mails: (await emails()).length, customers: sql('SELECT COUNT(*) AS n FROM customers')[0].n };
    const detail = await admin.get(`/admin/forespoergsler/${lead.id}`);
    for (const l of ['I dialog', 'Demo oprettet', 'I prøveperiode', 'Besvaret', 'Tilbud sendt', 'Blev kunde', 'Lukket', 'Spam']) expect(detail.html).toContain(l);
    for (const st of ['dialog', 'demo', 'proeve']) {
      const r = await admin.post(`/admin/forespoergsler/${lead.id}`, { _csrf: csrfFrom(detail.html), status: st, note: 'Talt sammen i telefon' });
      expect(r.status).toBe(303);
      expect(sql(`SELECT status FROM leads WHERE id = ${lead.id}`)[0].status).toBe(st);
    }
    // Gem uden statusændring giver ingen ny historik
    await admin.post(`/admin/forespoergsler/${lead.id}`, { _csrf: csrfFrom(detail.html), status: 'proeve', note: 'Ny note' });
    const events = sql(`SELECT kind, actor, old_value, new_value FROM lead_events WHERE lead_id = ${lead.id} ORDER BY id`);
    expect(events).toEqual([
      { kind: 'status', actor: ADMIN_EMAIL, old_value: 'ny', new_value: 'dialog' },
      { kind: 'status', actor: ADMIN_EMAIL, old_value: 'dialog', new_value: 'demo' },
      { kind: 'status', actor: ADMIN_EMAIL, old_value: 'demo', new_value: 'proeve' },
    ]);
    const page = text((await admin.get(`/admin/forespoergsler/${lead.id}`)).html);
    expect(page).toContain('Status: I prøveperiode');
    expect(page).toContain('Status ændret fra Demo oprettet til I prøveperiode');
    expect(page).toContain(ADMIN_EMAIL);
    // Filtrering
    expect(text((await admin.get('/admin/forespoergsler?status=proeve')).html)).toContain('Telefon Tina');
    expect(text((await admin.get('/admin/forespoergsler?status=dialog')).html)).not.toContain('Telefon Tina');
    const open = await admin.get('/admin/forespoergsler');
    expect(text(open.html)).toContain('Telefon Tina');
    expect(text(open.html)).toContain('I prøveperiode');
    // Ingen bivirkninger
    expect((await stripeCalls()).length).toBe(before.stripe);
    expect((await emails()).length).toBe(before.mails);
    expect(sql('SELECT COUNT(*) AS n FROM customers')[0].n).toBe(before.customers);
    // Ugyldig status afvises
    expect((await admin.post(`/admin/forespoergsler/${lead.id}`, { _csrf: csrfFrom(detail.html), status: 'aktiv' })).status).toBe(400);
  });

  it('sletning af en forespørgsel sletter også dens historik', async () => {
    const lead = sql("SELECT id FROM leads WHERE email = 'tina@telefon.dk'")[0];
    const page = await admin.get(`/admin/forespoergsler/${lead.id}`);
    await admin.post(`/admin/forespoergsler/${lead.id}/slet`, { _csrf: csrfFrom(page.html), confirm: '1' });
    expect(sql(`SELECT COUNT(*) AS n FROM lead_events WHERE lead_id = ${lead.id}`)[0].n).toBe(0);
  });
});
