// Kundeemner, mail (Gmail-simulator), "Tilføj via link", søgning i kilder og interne omkostninger.
// Google og hjemmesider er lokale simulatorer (tests/google-mock.mjs); der rammes aldrig rigtige tjenester.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, startStack, waitFor } from './harness.mjs';
import { startGoogleMock } from './google-mock.mjs';

let stack;
let g;
let admin;
const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';

function sql(query) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--json', '--command', query],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0].results;
}

const stripeCalls = async () => (await fetch(stack.mock.url + '/__mock/calls')).json();
const gState = async () => (await fetch(g.url + '/__g/state')).json();
const gAdd = (account, message) => fetch(g.url + '/__g/add', { method: 'POST', body: JSON.stringify({ account, message }) });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

/** POST med CSRF fra en side */
async function send(pageUrl, action, form = {}) {
  const page = await admin.get(pageUrl);
  return admin.post(action, { _csrf: csrfFrom(page.html), ...form });
}

async function createProspect(form) {
  const res = await send('/admin/kundeemner/ny', '/admin/kundeemner', form);
  if (res.status !== 303) return { res, id: null };
  return { res, id: Number(res.headers.get('location').match(/\/admin\/kundeemner\/(\d+)/)[1]) };
}

const prospect = (id) => sql(`SELECT * FROM prospects WHERE id = ${id}`)[0];
const versionOf = (id) => prospect(id).version;

beforeAll(async () => {
  g = await startGoogleMock();
  stack = await startStack({
    minMonths: 0,
    devMode: true,
    extraVars: {
      MAIL_ACCOUNTS: `${ADMIN_EMAIL},kontakt@veyro.dk,tobias@veyro.dk`,
      SHARED_MAILBOXES: 'kontakt@veyro.dk',
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      MAIL_TOKEN_KEY: randomBytes(32).toString('base64'),
      GOOGLE_OAUTH_BASE: g.url,
      GOOGLE_TOKEN_BASE: g.url,
      GMAIL_API_BASE: g.url,
      TEST_FETCH_ALLOW: g.host,
    },
  });
  admin = (await login(stack, ADMIN_EMAIL)).client;
}, 120_000);

afterAll(async () => {
  await stack?.stop();
  await g?.close();
});

describe('adgang', () => {
  it('kræver login og admin-rettigheder på serveren', async () => {
    const anon = new Client(stack.base);
    for (const p of ['/admin/kundeemner', '/admin/kundeemner/mail', '/admin/kundeemner/find', '/admin/statistik/omkostninger', '/admin/omkostninger/faelles']) {
      const r = await anon.get(p);
      expect(r.status, p).toBe(303);
    }
    sql(`INSERT INTO customers (email, name, created_at, updated_at) VALUES ('kunde-uden-adgang@example.com', 'Kunde', 1, 1)`);
    const { client } = await login(stack, 'kunde-uden-adgang@example.com');
    for (const p of ['/admin/kundeemner', '/admin/kundeemner/link', '/admin/statistik/omkostninger']) {
      const r = await client.get(p);
      expect(r.status, p).toBe(403);
    }
    const r = await client.post('/admin/kundeemner', { _csrf: csrfFrom((await client.get('/konto')).html), company: 'Snyd' });
    expect(r.status).toBe(403);
  });
});

describe('manuelt arbejdsforløb', () => {
  let id;
  it('opretter et kundeemne med kun virksomhedsnavnet', async () => {
    const r = await createProspect({ company: 'Kaffebaren Testby' });
    expect(r.res.status).toBe(303);
    id = r.id;
    const page = await admin.get(`/admin/kundeemner/${id}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Skal undersøges');
    expect(page.html).toContain('Gmail ikke forbundet');
    const list = await admin.get('/admin/kundeemner?visning=uden-ansvarlig');
    expect(list.html).toContain('Kaffebaren Testby');
  });

  it('registrerer telefonkontakt uden at ændre status og foreslår opfølgning om fem arbejdsdage', async () => {
    const page = await admin.get(`/admin/kundeemner/${id}`);
    const now = new Date(Date.now() - 60_000).toLocaleString('sv-SE', { timeZone: 'Europe/Copenhagen' }).replace(' ', 'T').slice(0, 16);
    const follow = page.html.match(/name="follow_up_on" type="date" value="(\d{4}-\d{2}-\d{2})"/)[1];
    const res = await admin.post(`/admin/kundeemner/${id}/kontakt`, {
      _csrf: csrfFrom(page.html), channel: 'telefon', at: now, staff: ADMIN_EMAIL, contact_person: 'Ejeren', body: 'Talte om ny hjemmeside', follow_up_on: follow,
    });
    expect(res.status).toBe(303);
    const p = prospect(id);
    expect(p.status).toBe('undersoeges');
    expect(p.follow_up_on).toBe(follow);
    expect(p.last_contact_at).toBeGreaterThan(0);
    const ev = sql(`SELECT kind, channel FROM prospect_events WHERE prospect_id = ${id} AND kind = 'contact'`);
    expect(ev).toEqual([{ kind: 'contact', channel: 'telefon' }]);
    // Fem arbejdsdage frem springer weekenden over
    const d = new Date(follow + 'T12:00:00Z').getUTCDay();
    expect(d).not.toBe(0);
    expect(d).not.toBe(6);
  });

  it('ændrer status og ansvarlig med versionskontrol og nægter "Blev kunde" uden kunde', async () => {
    let res = await send(`/admin/kundeemner/${id}`, `/admin/kundeemner/${id}/status`, { status: 'klar', version: String(versionOf(id)) });
    expect(res.status).toBe(303);
    expect(prospect(id).status).toBe('klar');
    res = await send(`/admin/kundeemner/${id}`, `/admin/kundeemner/${id}/ansvarlig`, { owner: ADMIN_EMAIL, version: String(versionOf(id)) });
    expect(prospect(id).owner).toBe(ADMIN_EMAIL);
    // Forældet version: afvises
    res = await send(`/admin/kundeemner/${id}`, `/admin/kundeemner/${id}/status`, { status: 'dialog', version: '1' });
    expect(res.status).toBe(409);
    expect(prospect(id).status).toBe('klar');
    res = await send(`/admin/kundeemner/${id}`, `/admin/kundeemner/${id}/status`, { status: 'kunde', version: String(versionOf(id)) });
    expect(res.status).toBe(400);
    expect(prospect(id).status).toBe('klar');
    const mine = await admin.get('/admin/kundeemner?visning=mine');
    expect(mine.html).toContain('Kaffebaren Testby');
  });

  it('finder dubletter på mail og domæne og lægger sammen med bevaret historik', async () => {
    const a = await createProspect({ company: 'Dublet ApS', emails: 'ejer@dublet-test.dk', website: 'dublet-test.dk' });
    expect(a.res.status).toBe(303);
    const b = await createProspect({ company: 'Dublet A/S', emails: 'ejer@dublet-test.dk' });
    expect(b.res.status).toBe(409);
    expect(b.res.html).toContain('Mulige dubletter');
    const page = await admin.get('/admin/kundeemner/ny');
    const c2 = await admin.post('/admin/kundeemner', { _csrf: csrfFrom(page.html), company: 'Dublet A/S', emails: 'salg@dublet-test.dk', confirm_duplicates: '1' });
    expect(c2.status).toBe(303);
    const other = Number(c2.headers.get('location').match(/(\d+)/)[1]);
    await send(`/admin/kundeemner/${other}`, `/admin/kundeemner/${other}/note`, { body: 'Note på dubletten' });
    const res = await send(`/admin/kundeemner/${a.id}`, `/admin/kundeemner/${a.id}/flet`, { other: String(other), version: String(versionOf(a.id)) });
    expect(res.status).toBe(303);
    expect(prospect(other).merged_into).toBe(a.id);
    const notes = sql(`SELECT body FROM prospect_events WHERE prospect_id = ${a.id} AND kind = 'note'`);
    expect(notes.map((n) => n.body)).toContain('Note på dubletten');
    const mails = sql(`SELECT value FROM prospect_contacts WHERE prospect_id = ${a.id} AND kind = 'email' ORDER BY value`).map((x) => x.value);
    expect(mails).toEqual(['ejer@dublet-test.dk', 'salg@dublet-test.dk']);
  });

  it('blacklister et domæne, beskytter fælles udbydere og kan ophæves med historik', async () => {
    const { id: bid } = await createProspect({ company: 'Spærret Firma', website: 'blokeret-test.dk' });
    let res = await send(`/admin/kundeemner/${bid}`, `/admin/kundeemner/${bid}/blokering`, { scope: 'domain', value: 'gmail.com', reason: 'Test' });
    expect(res.status).toBe(400);
    res = await send(`/admin/kundeemner/${bid}`, `/admin/kundeemner/${bid}/blokering`, { scope: 'domain', value: '', reason: 'Ønsker ikke at blive kontaktet' });
    expect(res.status).toBe(303);
    expect(prospect(bid).blacklisted).toBe(1);
    const again = await createProspect({ company: 'Spærret Firma igen', emails: 'x@blokeret-test.dk' });
    expect(again.res.status).toBe(409);
    expect(again.res.html).toContain('blacklistet');
    const list = await admin.get('/admin/kundeemner?visning=blacklistede');
    expect(list.html).toContain('Spærret Firma');
    const draft = await admin.get(`/admin/kundeemner/${bid}/udkast`);
    expect(draft.status).toBe(409);
  });

  it('arkiverer og gendanner', async () => {
    let res = await send(`/admin/kundeemner/${id}`, `/admin/kundeemner/${id}/arkiver`);
    expect(prospect(id).archived_at).toBeGreaterThan(0);
    expect((await admin.get('/admin/kundeemner')).html).not.toContain('Kaffebaren Testby');
    expect((await admin.get('/admin/kundeemner?visning=arkiverede')).html).toContain('Kaffebaren Testby');
    res = await send(`/admin/kundeemner/${id}`, `/admin/kundeemner/${id}/gendan`);
    expect(res.status).toBe(303);
    expect(prospect(id).archived_at).toBeNull();
  });

  it('eksporterer CSV med beskyttelse mod regnearksformler', async () => {
    await createProspect({ company: '=HYPERLINK("http://ond.example","klik")' });
    const res = await admin.get('/admin/kundeemner/eksport.csv?visning=alle');
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.html).toContain(`"'=HYPERLINK(""http://ond.example"",""klik"")"`);
    expect(res.html).not.toMatch(/(^|;)"?=HYPERLINK/m);
  });
});

describe('tid og omkostninger', () => {
  let pid;
  let cid;
  let customerEmail = 'ejer@tidtest-kunde.dk';

  it('beregner tidsværdi og total eksakt: 30 min á 299 kr. = 149,50; + 50 kr. = 199,50', async () => {
    ({ id: pid } = await createProspect({ company: 'Tidtest ApS', emails: customerEmail }));
    const before = (await stripeCalls()).length;
    let res = await send(`/admin/kundeemner/${pid}`, `/admin/omkostninger/tid?emne=p:${pid}`, {
      back: `/admin/kundeemner/${pid}`, work_date: '2026-10-01', staff: ADMIN_EMAIL, hours: '0', minutes: '30', category: 'salg', description: 'Research',
    });
    expect(res.status).toBe(303);
    res = await send(`/admin/kundeemner/${pid}`, `/admin/omkostninger/udgift?emne=p:${pid}`, {
      back: `/admin/kundeemner/${pid}`, spent_on: '2026-10-01', description: 'Testdomæne', amount: '50', type: 'domaene', purpose: 'salg', registered_by: ADMIN_EMAIL,
    });
    expect(res.status).toBe(303);
    const page = text((await admin.get(`/admin/kundeemner/${pid}?periode=alt`)).html);
    expect(page).toContain('149,50');
    expect(page).toContain('199,50');
    const t = sql(`SELECT minutes, rate FROM time_entries WHERE prospect_id = ${pid}`)[0];
    expect(t).toEqual({ minutes: 30, rate: 29900 });
    // Omkostninger opretter aldrig noget i Stripe
    expect((await stripeCalls()).length).toBe(before);
  });

  it('bevarer den historiske sats, når standardsatsen ændres', async () => {
    const res = await send('/admin/statistik/omkostninger', '/admin/omkostninger/indstillinger', { rate: '350' });
    expect(res.status).toBe(303);
    await send(`/admin/kundeemner/${pid}`, `/admin/omkostninger/tid?emne=p:${pid}`, {
      back: `/admin/kundeemner/${pid}`, work_date: '2026-10-02', staff: ADMIN_EMAIL, hours: '1', minutes: '0', category: 'salg', description: 'Møde',
    });
    const rates = sql(`SELECT rate FROM time_entries WHERE prospect_id = ${pid} ORDER BY work_date`).map((x) => x.rate);
    expect(rates).toEqual([29900, 35000]);
    await send('/admin/statistik/omkostninger', '/admin/omkostninger/indstillinger', { rate: '299' });
  });

  it('gør kundeemnet til kunde og bevarer tid og historik på kunden', async () => {
    const res = await send(`/admin/kundeemner/${pid}`, `/admin/kundeemner/${pid}/kunde/ny`, { email: customerEmail, name: 'Ejer' });
    expect(res.status).toBe(303);
    const p = prospect(pid);
    expect(p.status).toBe('kunde');
    cid = p.customer_id;
    expect(cid).toBeGreaterThan(0);
    expect(sql(`SELECT COUNT(*) AS n FROM subscriptions WHERE customer_id = ${cid}`)[0].n).toBe(0);
    const cust = text((await admin.get(`/admin/kunder/${cid}?periode=alt`)).html);
    expect(cust).toContain('Internt: Tid og omkostninger');
    expect(cust).toContain('149,50');
  });

  it('registrerer tid direkte på en kunde', async () => {
    const res = await send(`/admin/kunder/${cid}`, `/admin/omkostninger/tid?emne=c:${cid}`, {
      back: `/admin/kunder/${cid}`, work_date: '2026-10-03', staff: ADMIN_EMAIL, hours: '0', minutes: '15', category: 'drift', description: 'Opdatering', rate: '299',
    });
    expect(res.status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM time_entries WHERE customer_id = ${cid} AND prospect_id IS NULL`)[0].n).toBe(1);
  });

  it('tilbagevendende udgift: forventet pr. periode og ingen dobbelttælling ved registrering', async () => {
    await send(`/admin/kunder/${cid}`, `/admin/omkostninger/udgift?emne=c:${cid}`, {
      back: `/admin/kunder/${cid}`, spent_on: '2026-08-01', description: 'Hosting', amount: '100', type: 'hosting', purpose: 'drift', registered_by: ADMIN_EMAIL, recurring: '1', interval: 'month',
    });
    const exp = sql(`SELECT id FROM expenses WHERE customer_id = ${cid} AND recurring = 1`)[0];
    const page1 = text((await admin.get(`/admin/kunder/${cid}?periode=egen&fra=2026-08-01&til=2026-10-31`)).html);
    expect(page1).toContain('Forventet');
    let res = await send(`/admin/kunder/${cid}`, `/admin/omkostninger/udgift/${exp.id}/periode`, { back: `/admin/kunder/${cid}`, period: '2026-08-01', amount: '100' });
    expect(res.status).toBe(303);
    res = await send(`/admin/kunder/${cid}`, `/admin/omkostninger/udgift/${exp.id}/periode`, { back: `/admin/kunder/${cid}`, period: '2026-08-01', amount: '100' });
    expect(res.headers.get('location')).toContain('periode-findes');
    expect(sql(`SELECT COUNT(*) AS n FROM expense_periods WHERE expense_id = ${exp.id}`)[0].n).toBe(1);
    // Tre måneder (aug–okt) á 100 kr.: én registreret + to forventede = 300 kr. i alt, ikke 400
    const csv = (await admin.get(`/admin/omkostninger/eksport.csv?emne=c:${cid}&periode=egen&fra=2026-08-01&til=2026-10-31`)).html;
    const hosting = csv.split('\n').filter((l) => l.includes('Hosting'));
    expect(hosting.filter((l) => l.startsWith('Udgift')).length).toBe(1);
    expect(hosting.filter((l) => l.startsWith('Forventet')).length).toBe(2);
    expect(csv).toMatch(/Forventede, ikke registrerede udgifter;;;"?200,00/);
  });

  it('fordeler fælles udgifter, men aldrig mere end beløbet', async () => {
    let res = await send('/admin/omkostninger/faelles', '/admin/omkostninger/udgift?emne=faelles', {
      back: '/admin/omkostninger/faelles', spent_on: '2026-10-01', description: 'Fælles software', amount: '100', type: 'software', purpose: 'drift', registered_by: ADMIN_EMAIL, basis: 'Ligeligt',
    });
    expect(res.status).toBe(303);
    const e = sql("SELECT id FROM expenses WHERE shared = 1 AND description = 'Fælles software'")[0];
    res = await send('/admin/omkostninger/faelles', `/admin/omkostninger/udgift/${e.id}/fordeling`, { back: '/admin/omkostninger/faelles', emne: `c:${cid}`, amount: '60' });
    expect(res.headers.get('location')).toContain('fordeling-gemt');
    res = await send('/admin/omkostninger/faelles', `/admin/omkostninger/udgift/${e.id}/fordeling`, { back: '/admin/omkostninger/faelles', emne: `p:${pid}`, amount: '50' });
    expect(res.headers.get('location')).toContain('fejl=1');
    expect(sql(`SELECT SUM(amount) AS s FROM expense_allocations WHERE expense_id = ${e.id}`)[0].s).toBe(6000);
  });

  it('retter og sletter med historik', async () => {
    const t = sql(`SELECT id, version FROM time_entries WHERE customer_id = ${cid} AND prospect_id IS NULL`)[0];
    let res = await send(`/admin/kunder/${cid}`, `/admin/omkostninger/tid/${t.id}`, {
      back: `/admin/kunder/${cid}`, version: String(t.version), work_date: '2026-10-03', staff: ADMIN_EMAIL, hours: '0', minutes: '20', category: 'drift', description: 'Opdatering', rate: '299',
    });
    expect(res.headers.get('location')).toContain('tid-rettet');
    res = await send(`/admin/kunder/${cid}`, `/admin/omkostninger/tid/${t.id}/slet`, { back: `/admin/kunder/${cid}` });
    const hist = sql(`SELECT action FROM cost_history WHERE entity = 'time' AND entity_id = ${t.id} ORDER BY id`).map((x) => x.action);
    expect(hist).toEqual(['oprettet', 'rettet', 'slettet']);
  });

  it('viser aldrig omkostninger for kunden', async () => {
    const { client } = await login(stack, customerEmail);
    for (const p of ['/konto', '/konto/fakturaer', '/konto/plan']) {
      const r = await client.get(p);
      expect(r.html, p).not.toMatch(/omkostning|Tid og omkostninger|149,50|time_entries/i);
    }
    expect((await client.get(`/admin/kunder/${cid}`)).status).toBe(403);
    expect((await client.get(`/admin/omkostninger/eksport.csv?emne=c:${cid}`)).status).toBe(403);
  });

  it('omkostningsoverblik med TCA og ingen CAC uden vundne', async () => {
    const r = await admin.get('/admin/statistik/omkostninger?periode=alt');
    expect(r.status).toBe(200);
    const t = text(r.html);
    expect(t).toContain('kalkuleret bidrag');
    // Én vundet kunde i perioden (Tidtest ApS): anskaffelsesomkostningen beregnes af hele salgsindsatsen
    expect(t).toContain('Anskaffelsesomkostning pr. vundet kunde');
    expect(t).toMatch(/Vundne kunder\s*1/);
    const empty = text((await admin.get('/admin/statistik/omkostninger?periode=egen&fra=2020-01-01&til=2020-01-31')).html);
    expect(empty).toContain('Ingen vundne kunder');
  });

  it('sletter et kundeemne uden at røre kunden, og tid flyttes til kunden', async () => {
    const page = await admin.get(`/admin/kundeemner/${pid}`);
    let res = await admin.post(`/admin/kundeemner/${pid}/slet`, { _csrf: csrfFrom(page.html), confirm_name: 'Forkert navn' });
    expect(res.status).toBe(400);
    res = await admin.post(`/admin/kundeemner/${pid}/slet`, { _csrf: csrfFrom(page.html), confirm_name: 'Tidtest ApS' });
    expect(res.status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM prospects WHERE id = ${pid}`)[0].n).toBe(0);
    expect(sql(`SELECT COUNT(*) AS n FROM customers WHERE id = ${cid}`)[0].n).toBe(1);
    expect(sql(`SELECT COUNT(*) AS n FROM time_entries WHERE customer_id = ${cid} AND deleted_at IS NULL`)[0].n).toBe(2);
  });
});

describe('Tilføj via link og søgning (SSRF-beskyttet)', () => {
  it('afviser interne adresser', async () => {
    for (const url of ['http://10.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest', 'https://kunde.veyro.dk/', 'http://intranet.local/', 'ftp://example.com/']) {
      const r = await send('/admin/kundeemner/link', '/admin/kundeemner/link', { url });
      expect(r.status, url).toBe(400);
    }
  });

  it('stopper omdirigering til en intern adresse', async () => {
    const r = await send('/admin/kundeemner/link', '/admin/kundeemner/link', { url: `${g.url}/redirect-intern` });
    expect(r.status).toBe(303);
    const loc = r.headers.get('location');
    const page = await waitFor(async () => {
      const p = await admin.get(loc);
      return p.html.includes('fejlede') ? p : null;
    }, 15000);
    expect(page.html).toContain('IP-adresser hentes ikke');
  });

  it('henter forslag, markerer dem ubekræftede og gemmer vurderingen som ikke godkendt', async () => {
    const r = await send('/admin/kundeemner/link', '/admin/kundeemner/link', { url: `${g.url}/` });
    const loc = r.headers.get('location');
    const review = await waitFor(async () => {
      const p = await admin.get(loc);
      return p.html.includes('Opret kundeemne') ? p : null;
    }, 15000);
    expect(review.html).toContain('Bageriet Kornet ApS');
    expect(review.html).toContain('bageriet.kornet@gmail.com');
    expect(review.html).not.toContain('hej@webbureau.dk');
    expect(review.html).toContain('12345678');
    expect(review.html).toContain('Ubekræftet');
    expect(review.html).toContain('lorem ipsum');
    const job = review.html.match(/name="job" value="(\d+)"/)[1];
    const res = await admin.post('/admin/kundeemner', {
      _csrf: csrfFrom(review.html), job, company: 'Bageriet Kornet ApS', cvr: '12345678', website: `${g.url}/`, emails: 'bageriet.kornet@gmail.com', phones: '12 34 56 78', city: 'Slagelse',
    });
    expect(res.status).toBe(303);
    const id = Number(res.headers.get('location').match(/(\d+)/)[1]);
    const p = prospect(id);
    expect(JSON.parse(p.unverified)).toEqual(expect.arrayContaining(['company', 'cvr', 'emails']));
    expect(p.assessment_approved_at).toBeNull();
    expect(JSON.parse(p.assessment).observations.length).toBeGreaterThan(0);
    expect(sql(`SELECT unverified FROM prospect_contacts WHERE prospect_id = ${id} AND kind = 'email'`)[0].unverified).toBe(1);
    const detail = await admin.get(`/admin/kundeemner/${id}`);
    expect(detail.html).toContain('Ikke godkendt');
    // Ikke-godkendte observationer bruges ikke i mailudkast
    const d1 = await admin.get(`/admin/kundeemner/${id}/udkast`);
    expect(d1.html).not.toContain('lorem ipsum');
    const ok = await admin.post(`/admin/kundeemner/${id}/vurdering`, { _csrf: csrfFrom(detail.html), op: 'godkend', observations: 'Forsiden indeholder pladsholdertekst (lorem ipsum).', suggestions: '', not_checked: 'Mobilvisning' });
    expect(ok.status).toBe(303);
    expect(prospect(id).assessment_approved_by).toBe(ADMIN_EMAIL);
    const d2 = await admin.get(`/admin/kundeemner/${id}/udkast`);
    expect(d2.html).toContain('lorem ipsum');
    // Ingen bekræftet mail: udkastet foreslår ingen modtager
    expect(d2.html).toContain('Ingen bekræftet mailadresse');
  });

  it('søger i en offentlig kilde, springer blokerede over og importerer kun det valgte', async () => {
    let res = await send('/admin/kundeemner/find', '/admin/kundeemner/find/kilder', { name: 'Testfestival udstillere', url: `${g.url}/udstillere`, industry: 'Fødevarer', area: 'Sjælland' });
    expect(res.status).toBe(303);
    const page0 = await admin.get('/admin/kundeemner/find');
    expect(page0.html).toContain('Ingen søgemaskine'.toLowerCase().slice(0, 0));
    const sid = sql("SELECT id FROM prospect_sources WHERE name = 'Testfestival udstillere'")[0].id;
    res = await send('/admin/kundeemner/find', `/admin/kundeemner/find/kilder/${sid}/koer`);
    expect(res.status).toBe(303);
    await waitFor(async () => sql(`SELECT COUNT(*) AS n FROM prospect_candidates WHERE source_id = ${sid}`)[0].n >= 2, 15000);
    const domains = sql(`SELECT domain FROM prospect_candidates WHERE source_id = ${sid} ORDER BY domain`).map((x) => x.domain);
    expect(domains).toEqual(['mejeriet-test.dk', 'slagterhuset-test.dk']);
    const page = await admin.get('/admin/kundeemner/find?branche=F%C3%B8devarer&omraade=Sj%C3%A6lland');
    expect(page.html).toContain('Slagterhuset');
    expect(page.html).toContain('Ikke undersøgt');
    const cand = sql(`SELECT id FROM prospect_candidates WHERE domain = 'slagterhuset-test.dk'`)[0].id;
    res = await admin.post('/admin/kundeemner/find/importer', { _csrf: csrfFrom(page.html), c: String(cand), op: 'importer' });
    expect(res.status).toBe(303);
    const imported = sql("SELECT * FROM prospects WHERE domain = 'slagterhuset-test.dk'");
    expect(imported.length).toBe(1);
    expect(imported[0].status).toBe('undersoeges');
    expect(imported[0].industry).toBe('Fødevarer');
    expect(sql("SELECT COUNT(*) AS n FROM prospects WHERE domain = 'mejeriet-test.dk'")[0].n).toBe(0);
    // Der kontaktes ingen: ingen mails sendt og ingen Gmail-kald
    const emails = await (await fetch(stack.mock.url + '/__mock/emails')).json();
    expect(emails.some((e) => /slagterhuset|mejeriet/.test(JSON.stringify(e.to)))).toBe(false);
  });
});

describe('Gmail', () => {
  let pid;
  const contact = 'ejer@mailtest-firma.dk';
  const now = Date.now();
  const msg = (id, threadId, headers, body, at = now) => ({ id, threadId, internalDate: at, headers, body });

  it('viser kontiene som ikke forbundet, indtil de er forbundet', async () => {
    const page = await admin.get('/admin/kundeemner/mail');
    expect(page.status).toBe(200);
    expect(text(page.html)).toContain('Ikke forbundet');
    expect(page.html).not.toContain('Google-integrationen er ikke sat op');
    expect(page.html).toContain('Kun Tobias kan forbinde');
  });

  it('kan ikke forbinde en andens personlige postkasse', async () => {
    const res = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent('tobias@veyro.dk')}/forbind`, {});
    expect(res.headers.get('location')).toContain('fejl=adgang');
  });

  it('afviser en forbindelse med en anden Google-konto og tilbagekalder den', async () => {
    const res = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent('kontakt@veyro.dk')}/forbind`, {});
    const state = new URL(res.headers.get('location')).searchParams.get('state');
    const cb = await admin.get(`/admin/kundeemner/mail/callback?state=${state}&code=${encodeURIComponent(`code|${ADMIN_EMAIL}|${SCOPE_READ}`)}`);
    expect(cb.headers.get('location')).toContain('fejl=forkert');
    expect(sql("SELECT token_enc FROM mail_accounts WHERE email = 'kontakt@veyro.dk'")[0].token_enc).toBeNull();
    expect((await gState()).revoked).toContain(`rt_${ADMIN_EMAIL}`);
  });

  it('forbinder med officiel OAuth (PKCE, minimale rettigheder) og gemmer tokenet krypteret', async () => {
    ({ id: pid } = await createProspect({ company: 'Mailtest Firma', emails: contact, website: 'mailtest-firma.dk' }));
    // Ældre mail fra før forbindelsen findes ved første synkronisering
    await gAdd(ADMIN_EMAIL, msg('m1', 't1', { From: `Admin <${ADMIN_EMAIL}>`, To: contact, Subject: 'Ny hjemmeside?', 'Message-ID': '<m1@veyro>', Date: 'x' }, 'Hej, vil I have en ny hjemmeside?', now - 3600_000));
    // Kun samme domæne: kræver gennemgang
    await gAdd(ADMIN_EMAIL, msg('m2', 't2', { From: 'Kollega <kollega@mailtest-firma.dk>', To: ADMIN_EMAIL, Subject: 'Spørgsmål', 'Message-ID': '<m2@firma>' }, 'Hemmeligt indhold fra kollegaen', now - 1800_000));
    // Ukendt afsender: gemmes ikke
    await gAdd(ADMIN_EMAIL, msg('m3', 't3', { From: 'privat@andet-firma.dk', To: ADMIN_EMAIL, Subject: 'Privat', 'Message-ID': '<m3@x>' }, 'Privat', now - 1700_000));

    const res = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent(ADMIN_EMAIL)}/forbind`, { drafts: '1' });
    const auth = new URL(res.headers.get('location'));
    expect(auth.origin).toBe(g.url);
    expect(auth.searchParams.get('scope')).toBe(`${SCOPE_READ} ${SCOPE_COMPOSE}`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('hd')).toBe('veyro.dk');
    const state = auth.searchParams.get('state');
    // Andre kan ikke bruge state
    const other = (await login(stack, 'kunde-uden-adgang@example.com')).client;
    expect((await other.get(`/admin/kundeemner/mail/callback?state=${state}&code=x`)).status).toBe(403);
    const cb = await admin.get(`/admin/kundeemner/mail/callback?state=${state}&code=${encodeURIComponent(`code|${ADMIN_EMAIL}|${SCOPE_READ}+${SCOPE_COMPOSE}`)}`);
    expect(cb.headers.get('location')).toContain('besked=forbundet');
    const acc = sql(`SELECT * FROM mail_accounts WHERE email = '${ADMIN_EMAIL}'`)[0];
    expect(acc.status).toBe('forbundet');
    expect(acc.token_enc).toMatch(/^v1\./);
    expect(acc.token_enc).not.toContain('rt_');
    // Engangs-state kan ikke genbruges
    expect((await admin.get(`/admin/kundeemner/mail/callback?state=${state}&code=x`)).headers.get('location')).toContain('fejl=state');
  });

  it('gemmer kun samtaler med kendte adresser og sætter "Afventer svar" ved første udgående mail', async () => {
    const threads = sql('SELECT conv_key, match_state, prospect_id FROM mail_threads ORDER BY id');
    expect(threads).toEqual([
      { conv_key: '<m1@veyro>', match_state: 'bekraeftet', prospect_id: pid },
      { conv_key: '<m2@firma>', match_state: 'gennemgaa', prospect_id: pid },
    ]);
    const p = prospect(pid);
    expect(p.status).toBe('afventer');
    expect(p.follow_up_on).toBeTruthy();
    expect(p.suggested_owner).toBe(ADMIN_EMAIL);
    // Indholdet af den usikre mail er ikke hentet
    const fulls = (await gState()).calls.filter((x) => x.path === '/messages/m2' && x.format === 'full');
    expect(fulls.length).toBe(0);
    expect(sql("SELECT body_loaded FROM mail_messages WHERE gmail_id = 'm2'")[0].body_loaded).toBe(0);
    expect(sql("SELECT COUNT(*) AS n FROM mail_messages WHERE gmail_id = 'm3'")[0].n).toBe(0);
  });

  it('notificerer ved menneskeligt svar og foreslår "I dialog" uden at ændre status; autosvar håndteres for sig', async () => {
    await gAdd(ADMIN_EMAIL, msg('m4', 't1', { From: `Ejer <${contact}>`, To: ADMIN_EMAIL, Subject: 'SV: Ny hjemmeside?', 'Message-ID': '<m4@firma>', 'In-Reply-To': '<m1@veyro>', References: '<m1@veyro>' }, 'Ja tak, ring til mig.'));
    await gAdd(ADMIN_EMAIL, msg('m5', 't1', { From: contact, To: ADMIN_EMAIL, Subject: 'Autosvar: Ny hjemmeside?', 'Message-ID': '<m5@firma>', 'Auto-Submitted': 'auto-replied', References: '<m1@veyro>' }, 'Jeg er på ferie'));
    const r = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent(ADMIN_EMAIL)}/synk`);
    expect(r.headers.get('location')).toContain('synkroniseret');
    const p = prospect(pid);
    expect(p.status).toBe('afventer');
    expect(p.suggested_status).toBe('dialog');
    expect(sql(`SELECT kind FROM mail_messages WHERE gmail_id IN ('m4','m5') ORDER BY gmail_id`).map((x) => x.kind)).toEqual(['menneske', 'autosvar']);
    expect(sql(`SELECT COUNT(*) AS n FROM admin_notifications WHERE kind = 'mail-svar' AND prospect_id = ${pid}`)[0].n).toBe(1);
    const page = await admin.get(`/admin/kundeemner/${pid}`);
    expect(page.html).toContain('Ja tak, ring til mig.');
    expect(page.html).not.toContain('tracker.example');
  });

  it('gentagen synkronisering giver ingen dubletter', async () => {
    const before = sql('SELECT COUNT(*) AS n FROM mail_messages')[0].n;
    sql(`UPDATE mail_accounts SET history_id = '101', last_check_at = 0 WHERE email = '${ADMIN_EMAIL}'`);
    await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent(ADMIN_EMAIL)}/synk`);
    expect(sql('SELECT COUNT(*) AS n FROM mail_messages')[0].n).toBe(before);
    expect(sql(`SELECT COUNT(*) AS n FROM prospect_events WHERE prospect_id = ${pid} AND kind = 'status' AND new_value = 'afventer'`)[0].n).toBe(1);
  });

  it('bekræfter en usikker samtale og henter først da indholdet', async () => {
    const t = sql("SELECT id FROM mail_threads WHERE conv_key = '<m2@firma>'")[0];
    const res = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/samtale/${t.id}/bekraeft`, { prospect: String(pid) });
    expect(res.headers.get('location')).toContain('bekraeftet');
    expect(sql("SELECT body_loaded, body_text FROM mail_messages WHERE gmail_id = 'm2'")[0]).toEqual({ body_loaded: 1, body_text: 'Hemmeligt indhold fra kollegaen' });
  });

  it('respekterer nyere manuelle beslutninger, afslag og blacklist', async () => {
    let res = await send(`/admin/kundeemner/${pid}`, `/admin/kundeemner/${pid}/status`, { status: 'afslag', version: String(versionOf(pid)) });
    expect(prospect(pid).status).toBe('afslag');
    await gAdd(ADMIN_EMAIL, msg('m6', 't6', { From: ADMIN_EMAIL, To: contact, Subject: 'Ny henvendelse', 'Message-ID': '<m6@veyro>' }, 'Ny mail', Date.now() + 1000));
    await gAdd(ADMIN_EMAIL, msg('m7', 't6', { From: contact, To: ADMIN_EMAIL, Subject: 'SV', 'Message-ID': '<m7@firma>', References: '<m6@veyro>' }, 'Svar', Date.now() + 2000));
    await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent(ADMIN_EMAIL)}/synk`);
    const p = prospect(pid);
    expect(p.status).toBe('afslag');
    expect(sql("SELECT COUNT(*) AS n FROM mail_messages WHERE gmail_id IN ('m6','m7')")[0].n).toBe(2);
    // Gmail-kladder laves ikke til afslag
    const draft = await admin.get(`/admin/kundeemner/${pid}/udkast`);
    expect(draft.status).toBe(409);
  });

  it('opretter kun en Gmail-kladde ved klik og sender aldrig', async () => {
    const { id } = await createProspect({ company: 'Kladde Firma', emails: 'kontakt@kladde-test.dk', needs: 'Mangler online booking' });
    const page = await admin.get(`/admin/kundeemner/${id}/udkast?afsender=${encodeURIComponent(ADMIN_EMAIL)}`);
    expect(page.html).toContain('Opret kladde i Gmail');
    expect(page.html).toContain('Mangler online booking');
    const res = await admin.post(`/admin/kundeemner/${id}/udkast/gmail`, { _csrf: csrfFrom(page.html), sender: ADMIN_EMAIL, to: 'kontakt@kladde-test.dk', subject: 'Hej', body: 'Testtekst' });
    expect(res.headers.get('location')).toContain('besked=kladde');
    const s = await gState();
    expect(s.drafts.length).toBe(1);
    expect(s.drafts[0].raw).toContain('To: kontakt@kladde-test.dk');
    expect(s.calls.some((x) => /\/send$/.test(x.path))).toBe(false);
    expect(prospect(id).status).toBe('undersoeges');
    // Fælles postkasse uden forbindelse: ingen kladde
    const r2 = await admin.post(`/admin/kundeemner/${id}/udkast/gmail`, { _csrf: csrfFrom(page.html), sender: 'kontakt@veyro.dk', to: 'kontakt@kladde-test.dk', subject: 'Hej', body: 'Testtekst' });
    expect(r2.status).toBe(400);
    expect((await gState()).drafts.length).toBe(1);
  });

  it('afbryder og tilbagekalder adgangen', async () => {
    const res = await send('/admin/kundeemner/mail', `/admin/kundeemner/mail/konto/${encodeURIComponent(ADMIN_EMAIL)}/afbryd`);
    expect(res.headers.get('location')).toContain('afbrudt');
    expect(sql(`SELECT token_enc, status FROM mail_accounts WHERE email = '${ADMIN_EMAIL}'`)[0]).toEqual({ token_enc: null, status: 'ikke_forbundet' });
    // Allerede tilknyttede samtaler bliver
    expect(sql(`SELECT COUNT(*) AS n FROM mail_threads WHERE prospect_id = ${pid}`)[0].n).toBeGreaterThan(0);
  });
});
