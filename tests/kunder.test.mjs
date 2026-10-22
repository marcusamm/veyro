// Admin › Kunder: opret kunde, guidet opsætning, forhåndsvisning, godkendelse, publicering, domæner og tjenester.
// Scenarie A (kun hjemmeside), B (hjemmeside med bestilling og lager) og C (tilsluttet specialbygget side) samt
// fejlforløb. Kun syntetiske kunder. Cloudflare, DNS, HTTPS-kontrol og GitHub er simuleret i mock-server.mjs;
// selve udrulningen af kundesystemer (wrangler deploy) testes ikke her.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validerKunde } from '../scripts/deploy-kunder.mjs';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, setMockState, startStack, waitFor } from './harness.mjs';
import { CF_TOKEN, GITHUB_TOKEN } from './mock-server.mjs';

const PROV_TOKEN = 'prov_test_token_0123456789abcdef0123456789abcdef';
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let stack;
let admin;
let csrf;

function sql(query) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', query],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0].results;
}

const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();
const mockKunder = async () => (await fetch(stack.mock.url + '/__mock/kunder')).json();

/** POST som admin (felter som objekt eller som liste af par, så samme navn kan gentages) */
const post = (p, fields = {}) => admin.post(p, [['_csrf', csrf], ...(Array.isArray(fields) ? fields : Object.entries(fields))]);
const loc = (res) => new URL(res.headers.get('location'), stack.base);
const besked = (res) => loc(res).searchParams.get('besked') ?? '';
const fejl = (res) => loc(res).searchParams.get('fejl') ?? '';

async function upload(p, field, bytes, filename, type, extra = {}) {
  const fd = new FormData();
  fd.set('_csrf', csrf);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.set(field, new Blob([bytes], { type }), filename);
  return fetch(stack.base + p, { method: 'POST', redirect: 'manual', body: fd, headers: { Cookie: admin.cookieHeader(), Origin: stack.base, 'CF-Connecting-IP': admin.ip } });
}

/** Forespørgsel med et bestemt værtsnavn (som en besøgende på kundens domæne) */
function hostRequest(host, p, { method = 'GET', form, origin } = {}) {
  const u = new URL(stack.base);
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: p,
        method,
        headers: { Host: host, 'CF-Connecting-IP': '198.51.100.77', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}), ...(origin ? { Origin: origin } : {}) },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createCompany(fields) {
  const res = await post('/admin/virksomheder/ny', fields);
  expect(res.status, res.html.slice(0, 400)).toBe(303);
  return loc(res).pathname.match(/\/admin\/virksomheder\/(v_[a-z0-9x]+)\/projekter\/ny$/)[1];
}

async function createProject(cid, fields) {
  const res = await post(`/admin/virksomheder/${cid}/projekter/ny`, fields);
  expect(res.status, res.html.slice(0, 400)).toBe(303);
  const m = loc(res).pathname.match(/\/projekter\/(p_[a-z0-9x]+)\/trin\/([a-z]+)$/);
  return { pid: m[1], next: m[2], base: `/admin/virksomheder/${cid}/projekter/${m[1]}` };
}

const versionId = (pid, number) => sql(`SELECT id FROM project_versions WHERE project_id = '${pid}' AND number = ${number}`)[0].id;
const project = (pid) => sql(`SELECT * FROM projects WHERE id = '${pid}'`)[0];

beforeAll(async () => {
  stack = await startStack({
    minMonths: 0,
    extraVars: (mock) => ({
      CF_API_TOKEN: CF_TOKEN,
      CF_API_BASE: `${mock.url}/cf`,
      DOH_URL: `${mock.url}/dns-query`,
      DOMAIN_CHECK_ORIGIN: `${mock.url}/domaenetjek`,
      KUNDESIDE_DOMAENE: 'veyro.dk',
      KUNDESIDE_SAAS_CNAME: 'kunder.veyro.dk',
      PROVISIONERING_TOKEN: PROV_TOKEN,
      GITHUB_DISPATCH_TOKEN: GITHUB_TOKEN,
      GITHUB_API_BASE: `${mock.url}/gh`,
    }),
  });
  ({ client: admin } = await login(stack, ADMIN_EMAIL));
  const overview = await admin.get('/admin/virksomheder');
  csrf = csrfFrom(overview.html);
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

// ---------------------------------------------------------------------------------------------------------------
// Scenarie A: kun hjemmeside
// ---------------------------------------------------------------------------------------------------------------

const A = { cid: '', pid: '', base: '', slug: 'testfirma-tomrer', image: 0 };

describe('Scenarie A: virksomhed med kun en hjemmeside', () => {
  it('opretter virksomheden og stopper dubletter', async () => {
    const overview = await admin.get('/admin/virksomheder');
    expect(overview.html).toContain('Opret kunde');
    A.cid = await createCompany({
      name: 'Testfirma Tømrer ApS',
      cvr: '10000001',
      contact_name: 'Test Person',
      email: 'kontakt@tomrer.test',
      phone: '11 22 33 44',
      address: 'Testvej 1',
      postal_code: '8000',
      city: 'Aarhus',
      description: 'Tømrerarbejde og renovering i Østjylland.',
      internal_note: 'INTERN NOTE: aftalt pris 499 kr. pr. måned',
    });
    // Samme CVR: blokeret, tilbyder den eksisterende
    const dupCvr = await post('/admin/virksomheder/ny', { name: 'Et andet navn', cvr: '10000001' });
    expect(dupCvr.status).toBe(409);
    expect(dupCvr.html).toContain('Brug denne virksomhed');
    expect(dupCvr.html).toContain(`/admin/virksomheder/${A.cid}`);
    // Samme navn uden CVR: advarsel, og intet oprettes uden et bevidst valg
    const dupName = await post('/admin/virksomheder/ny', { name: 'testfirma tømrer aps', email: 'anden@tomrer.test' });
    expect(dupName.status).toBe(409);
    expect(dupName.html).toContain('Testfirma Tømrer ApS');
    expect(sql("SELECT COUNT(*) AS n FROM companies WHERE name_key LIKE '%testfirma%'")[0].n).toBe(1);
    // Ugyldigt CVR
    const bad = await post('/admin/virksomheder/ny', { name: 'Fejl ApS', cvr: '123' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('CVR-nummeret skal være 8 cifre.');
  });

  it('viser de tre projekttyper og opretter hjemmesiden fra et startpunkt uden opdigtet indhold', async () => {
    const page = await admin.get(`/admin/virksomheder/${A.cid}/projekter/ny`);
    expect(page.html).toContain('Ny hjemmeside ud fra et startpunkt.');
    expect(page.html).toContain('Tilslut en færdig, specialbygget hjemmeside.');
    expect(page.html).toContain('Kun interne systemer, ingen offentlig hjemmeside.');
    // Reserveret adresse
    const reserved = await post(`/admin/virksomheder/${A.cid}/projekter/ny`, { kind: 'skabelon', name: 'Hjemmeside', slug: 'ek', template: 'service' });
    expect(reserved.status).toBe(422);
    expect(reserved.html).toContain('reserveret');
    const r = await createProject(A.cid, { kind: 'skabelon', name: 'Hjemmeside', slug: A.slug, template: 'service' });
    Object.assign(A, r);
    expect(r.next).toBe('indhold');
    const draft = JSON.parse(project(A.pid).draft);
    // Kun det, kunden har givet: navn, telefon, e-mail, adresse og beskrivelse. Resten er [[pladsholdere]].
    expect(draft.info).toMatchObject({ name: 'Testfirma Tømrer ApS', phone: '11 22 33 44', email: 'kontakt@tomrer.test' });
    expect(JSON.stringify(draft)).toContain('[[');
    expect(JSON.stringify(draft)).not.toContain('INTERN NOTE');
  });

  it('kan forlades og genoptages fra oversigten', async () => {
    const overview = await admin.get('/admin/virksomheder');
    expect(overview.html).toContain('Fortsæt opsætningen: Udseende og indhold');
    expect(overview.html).toContain(`${A.base}/trin/indhold`);
    const resume = await admin.get(`${A.base}/trin/indhold`);
    expect(resume.status).toBe(200);
    expect(resume.html).toContain('Testfirma Tømrer ApS');
  });

  it('gemmer udseende og offentlige oplysninger og går videre til tjenester', async () => {
    const res = await post(`${A.base}/trin/indhold`, {
      layout: 'klassisk', primary: '#7A4B2A', background: '#FFFFFF', text: '#1A1A1A', font: 'moderne', logo: '', logo_alt: '',
      info_name: 'Testfirma Tømrer', info_tagline: 'Tømrer i Aarhus', info_phone: '11 22 33 44', info_email: 'kontakt@tomrer.test',
      info_address: 'Testvej 1, 8000 Aarhus', info_cvr: '10000001', info_opening_hours: 'Mandag–fredag 7–16', next: '1',
    });
    expect(res.status).toBe(303);
    expect(loc(res).pathname).toBe(`${A.base}/trin/tjenester`);
    expect(project(A.pid).onboarding_step).toBe('tjenester');
  });

  it('viser kun tjenester, der findes, og afviser manglende afhængigheder', async () => {
    const page = await admin.get(`${A.base}/trin/tjenester`);
    expect(page.html).toContain('Ikke tilgængelige endnu');
    expect(page.html).toContain('Onlinebetaling i bestillingen');
    expect(page.html).not.toMatch(/value="onlinebetaling"/);
    const bad = await post(`${A.base}/trin/tjenester`, [['svc', 'kontaktformular'], ['next', '1']]);
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('kræver');
    const ok = await post(`${A.base}/trin/tjenester`, [['svc', 'hjemmeside'], ['svc', 'kontaktformular'], ['next', '1']]);
    expect(ok.status).toBe(303);
    expect(loc(ok).pathname).toBe(`${A.base}/trin/opsaetning`);
  });

  it('melder manglende opsætning og går først videre, når den er udfyldt', async () => {
    const missing = await post(`${A.base}/trin/opsaetning`, { 'kontaktformular.recipients': '', next: '1' });
    expect(loc(missing).pathname).toBe(`${A.base}/trin/opsaetning`);
    expect(besked(missing)).toContain('mangler stadig');
    const page = await admin.get(`${A.base}/trin/opsaetning`);
    expect(page.html).toContain('Angiv mindst én e-mail, som henvendelser skal sendes til.');
    const ok = await post(`${A.base}/trin/opsaetning`, { 'kontaktformular.recipients': 'kontakt@tomrer.test', 'kontaktformular.subject': '', next: '1' });
    expect(loc(ok).pathname).toBe(`${A.base}/trin/gennemgang`);
  });

  it('stopper publicering, så længe der er pladsholdere, og ændrer intet', async () => {
    const review = await admin.get(`${A.base}/trin/gennemgang`);
    expect(review.html).toContain('Pladsholdere');
    expect(review.html).toContain('Kladden er ikke godkendt endnu.');
    const approve = await post(`${A.base}/godkend`);
    expect(besked(approve)).toContain('Version 1 er godkendt');
    const res = await post(`${A.base}/publicer`, { version_id: String(versionId(A.pid, 1)) });
    expect(res.status).toBe(303);
    expect(fejl(res)).toContain('stoppet, før noget blev ændret');
    expect(project(A.pid).live_version_id).toBeNull();
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).status).toBe(404);
    const pub = sql(`SELECT status, steps FROM publications WHERE project_id = '${A.pid}'`);
    expect(pub).toHaveLength(1);
    expect(pub[0].status).toBe('fejlet');
    expect(pub[0].steps).toContain('Pladsholdere');
  });

  it('skriver kundens egne tekster på siderne', async () => {
    const front = await post(`${A.base}/side/forside`, {
      title: 'Forside', seo_title: 'Tømrer i Aarhus | Testfirma Tømrer', seo_description: 'Tømrerarbejde og renovering i Østjylland.', in_nav: '1',
      s0_heading: 'Testfirma Tømrer', s0_text: 'Tømrerarbejde og renovering i Østjylland.', s0_image: '', s0_image_alt: '', s0_button_label: 'Kontakt os', s0_button_href: '/kontakt',
      s1_heading: 'Det hjælper vi med', s1_text: '', s1_items: 'Tagarbejde|Nye tage og reparationer\nVinduer og døre|Montering og udskiftning',
      s2_heading: 'Om os', s2_text: 'Syntetisk testtekst om firmaet.',
      s3_heading: 'Åbningstider',
    });
    expect(besked(front)).toContain('gemt i kladden');
    const contact = await post(`${A.base}/side/kontakt`, { title: 'Kontakt', seo_title: '', seo_description: 'Kontakt Testfirma Tømrer.', in_nav: '1', s0_heading: 'Kontakt os', s0_text: 'Skriv til os, så vender vi tilbage hurtigst muligt.' });
    expect(contact.status).toBe(303);
    const review = await admin.get(`${A.base}/trin/gennemgang`);
    expect(review.html.match(/Pladsholdere[\s\S]{0,400}/)[0]).toContain('Ingen pladsholdertekst.');
  });

  it('forhåndsviser kladden uden at sende noget og uden at være publiceret', async () => {
    const res = await post(`${A.base}/forhaandsvisning`);
    expect(res.status).toBe(303);
    const previewPath = loc(res).pathname;
    expect(previewPath).toMatch(/^\/vis\/[A-Za-z0-9_-]+\/$/);
    const page = await fetch(stack.base + previewPath);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    const body = await page.text();
    expect(body).toContain('Forhåndsvisning – ikke publiceret');
    expect(body).toContain('Tagarbejde');
    expect(body).not.toContain('INTERN NOTE');
    // En formular i forhåndsvisningen gemmes som test og sendes ikke til kunden
    const before = (await emails()).length;
    const sent = await fetch(`${stack.base}${previewPath}_kontakt`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': '198.51.100.20' },
      body: new URLSearchParams({ name: 'Test Besøgende', email: 'besoeg@person.test', message: 'Test fra forhåndsvisning', samtykke: '1', side: 'kontakt', website_url: '' }),
    });
    expect(sent.status).toBe(303);
    expect(sent.headers.get('location')).toContain('sendt=1');
    expect(sql(`SELECT test FROM project_leads WHERE project_id = '${A.pid}'`)).toEqual([{ test: 1 }]);
    await new Promise((r) => setTimeout(r, 500));
    expect((await emails()).length).toBe(before);
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).status).toBe(404);
  });

  it('giver kunden et link til gennemsyn, som kan tilbagekaldes', async () => {
    const res = await post(`${A.base}/kundelink`, { label: 'Til Test Person' });
    expect(res.status).toBe(200);
    const link = res.html.match(/http:\/\/127\.0\.0\.1:\d+\/vis\/[A-Za-z0-9_-]+\//)[0];
    expect((await fetch(link)).status).toBe(200);
    const hash = res.html.match(/\/kundelink\/([a-f0-9]{64})\/tilbagekald/)[1];
    const revoke = await post(`${A.base}/kundelink/${hash}/tilbagekald`);
    expect(besked(revoke)).toContain('tilbagekaldt');
    const after = await fetch(link);
    expect(after.status).toBe(404);
    expect(await after.text()).toContain('Linket virker ikke længere');
  });

  it('publicerer den godkendte version én gang, også ved gentagne klik', async () => {
    const approve = await post(`${A.base}/godkend`);
    expect(besked(approve)).toContain('Version 2 er godkendt');
    const v2 = String(versionId(A.pid, 2));
    const [a, b] = await Promise.all([post(`${A.base}/publicer`, { version_id: v2 }), post(`${A.base}/publicer`, { version_id: v2 })]);
    expect([a.status, b.status]).toEqual([303, 303]);
    const third = await post(`${A.base}/publicer`, { version_id: v2 });
    expect(besked(third)).toContain('allerede publiceret');
    const pubs = sql(`SELECT status FROM publications WHERE project_id = '${A.pid}' AND version_id = ${v2}`);
    expect(pubs.filter((x) => x.status === 'faerdig')).toHaveLength(1);
    const live = await fetch(`${stack.base}/s/${A.slug}/`);
    expect(live.status).toBe(200);
    expect(live.headers.get('x-veyro-version')).toBe('2');
    expect(live.headers.get('x-robots-tag')).toContain('noindex'); // /s/-adressen indekseres ikke
    const html = await live.text();
    expect(html).toContain('Tagarbejde');
    expect(html).not.toContain('INTERN NOTE');
    expect(html).not.toContain('<script');
    expect(project(A.pid).onboarding_step).toBe('faerdig');
    const svc = sql(`SELECT service, status FROM project_services WHERE project_id = '${A.pid}' ORDER BY service`);
    expect(svc).toEqual([{ service: 'hjemmeside', status: 'forbundet' }, { service: 'kontaktformular', status: 'forbundet' }]);
  });

  it('sender henvendelser fra den publicerede side til kunden', async () => {
    const before = (await emails()).length;
    const form = { name: 'Test Besøgende', email: 'besoeg@person.test', phone: '', message: 'Jeg vil gerne have et tilbud på et nyt tag.', samtykke: '1', side: 'kontakt', website_url: '' };
    const send = (f, origin = stack.base) =>
      fetch(`${stack.base}/s/${A.slug}/_kontakt`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, 'CF-Connecting-IP': '198.51.100.21' }, body: new URLSearchParams(f) });
    const res = await send(form);
    expect(res.headers.get('location')).toBe(`/s/${A.slug}/kontakt?sendt=1#kontakt`);
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@tomrer.test'));
    expect(mail.text).toContain('Jeg vil gerne have et tilbud');
    expect(mail.reply_to ?? mail.replyTo).toBeTruthy();
    // Honningkrukke: robotten får "sendt", men intet gemmes
    await send({ ...form, website_url: 'http://spam.test' });
    // Uden samtykke
    const noConsent = await send({ ...form, samtykke: '' });
    expect(noConsent.headers.get('location')).toContain('fejl=1');
    // Fra et andet site
    expect((await send(form, 'https://ondsindet.test')).status).toBe(403);
    expect(sql(`SELECT COUNT(*) AS n FROM project_leads WHERE project_id = '${A.pid}' AND test = 0`)[0].n).toBe(1);
  });

  it('holder kladdeændringer efter publicering som kladde', async () => {
    await post(`${A.base}/side/forside`, { title: 'Forside', seo_title: 'Tømrer i Aarhus | Testfirma Tømrer', seo_description: 'Tømrerarbejde og renovering i Østjylland.', in_nav: '1', s0_text: 'NY KLADDETEKST' });
    const live = await (await fetch(`${stack.base}/s/${A.slug}/`)).text();
    expect(live).not.toContain('NY KLADDETEKST');
    const hub = await admin.get(A.base);
    expect(hub.html).toContain('Kladden er ændret efter godkendelsen af version 2');
    const overview = await admin.get('/admin/virksomheder');
    expect(overview.html).toContain('Upublicerede ændringer');
    const again = await post(`${A.base}/publicer`, { version_id: String(versionId(A.pid, 2)) });
    expect(besked(again)).toContain('allerede publiceret');
  });

  it('bevarer den publicerede version, når en opdatering fejler, og publicerer efter rettelse', async () => {
    const up = await upload(`${A.base}/billeder`, 'file', PNG, 'tag.png', 'image/png');
    expect(up.status).toBe(303);
    const img = sql(`SELECT id FROM project_files WHERE project_id = '${A.pid}' ORDER BY id DESC LIMIT 1`)[0].id;
    await post(`${A.base}/side/forside`, { title: 'Forside', seo_title: 'Tømrer i Aarhus | Testfirma Tømrer', seo_description: 'Tømrerarbejde og renovering i Østjylland.', in_nav: '1', s0_text: 'Tømrerarbejde og renovering i Østjylland.', s0_image: String(img), s0_image_alt: 'Nyt tag' });
    expect(besked(await post(`${A.base}/godkend`))).toContain('Version 3 er godkendt');
    // Billedet forsvinder, før versionen publiceres (bruges ikke af den publicerede version, så det må slettes)
    expect(besked(await post(`${A.base}/billeder/${img}/slet`))).toContain('slettet');
    const failed = await post(`${A.base}/publicer`, { version_id: String(versionId(A.pid, 3)) });
    expect(fejl(failed)).toContain('stoppet, før noget blev ændret');
    const steps = sql(`SELECT steps FROM publications WHERE project_id = '${A.pid}' ORDER BY id DESC LIMIT 1`)[0].steps;
    expect(steps).toContain('Bygning');
    const still = await fetch(`${stack.base}/s/${A.slug}/`);
    expect(still.headers.get('x-veyro-version')).toBe('2');
    // Genforsøg efter rettelse
    await upload(`${A.base}/billeder`, 'file', PNG, 'tag.png', 'image/png');
    A.image = sql(`SELECT id FROM project_files WHERE project_id = '${A.pid}' ORDER BY id DESC LIMIT 1`)[0].id;
    await post(`${A.base}/side/forside`, { title: 'Forside', seo_title: 'Tømrer i Aarhus | Testfirma Tømrer', seo_description: 'Tømrerarbejde og renovering i Østjylland.', in_nav: '1', s0_image: String(A.image), s0_image_alt: 'Nyt tag' });
    expect(besked(await post(`${A.base}/godkend`))).toContain('Version 4 er godkendt');
    const ok = await post(`${A.base}/publicer`, { version_id: String(versionId(A.pid, 4)) });
    expect(besked(ok)).toContain('Publiceret');
    const live = await fetch(`${stack.base}/s/${A.slug}/`);
    expect(live.headers.get('x-veyro-version')).toBe('4');
    expect(await live.text()).toContain(`/s/${A.slug}/_filer/${A.image}`);
    const file = await fetch(`${stack.base}/s/${A.slug}/_filer/${A.image}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    // Et billede, den publicerede side bruger, kan ikke slettes
    const refused = await post(`${A.base}/billeder/${A.image}/slet`);
    expect(fejl(refused)).toContain('bruges på den publicerede side');
  });

  it('kan rulle tilbage til en tidligere version og frem igen', async () => {
    const back = await post(`${A.base}/rul-tilbage`, { version_id: String(versionId(A.pid, 2)) });
    expect(besked(back)).toContain('Rullet tilbage');
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).headers.get('x-veyro-version')).toBe('2');
    const fwd = await post(`${A.base}/publicer`, { version_id: String(versionId(A.pid, 4)) });
    expect(besked(fwd)).toContain('Publiceret');
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).headers.get('x-veyro-version')).toBe('4');
  });

  it('kalder kun en adresse på veyro.dk live, når den er verificeret', async () => {
    const host = `${A.slug}.veyro.dk`;
    const add = await post(`${A.base}/domaener`, { kind: 'veyro', hostname: host });
    expect(besked(add)).toBe(`${host}: Afventer verificering.`);
    let d = sql(`SELECT * FROM project_domains WHERE hostname = '${host}'`)[0];
    expect(d).toMatchObject({ method: 'workers_domain', status: 'verificerer' });
    const cf = await mockKunder();
    expect(cf.cfDomains[host]).toMatchObject({ service: 'veyro', zone_id: 'zone_veyro', environment: 'production' });
    expect((await admin.get('/admin/virksomheder')).html).not.toContain('Live på veyro.dk-underdomæne');
    // DNS svarer ikke endnu
    const check1 = await post(`${A.base}/domaener/${d.id}/tjek`);
    expect(besked(check1)).toBe(`${host}: Afventer verificering.`);
    // Dobbelt tilføjelse
    const dup = await post(`${A.base}/domaener`, { kind: 'veyro', hostname: host });
    expect(fejl(dup)).toContain('allerede knyttet til dette projekt');
    await setMockState(stack.mock, { dns: { [host]: 'A' }, https: { [host]: true } });
    const check2 = await post(`${A.base}/domaener/${d.id}/tjek`);
    expect(besked(check2)).toBe(`${host}: Verificeret og live.`);
    d = sql(`SELECT * FROM project_domains WHERE hostname = '${host}'`)[0];
    expect(d.verified_at).toBeGreaterThan(0);
    expect((await admin.get('/admin/virksomheder')).html).toContain('Live på veyro.dk-underdomæne');
    // Besøg på domænet
    const visit = await hostRequest(host, '/');
    expect(visit.status).toBe(200);
    expect(visit.headers['x-veyro-version']).toBe('4');
    expect(visit.headers['content-security-policy']).toContain("script-src 'none'");
    expect(visit.body).toContain('Tagarbejde');
    // Genforsøg opretter ikke dubletter hos Cloudflare
    await post(`${A.base}/domaener/${d.id}/tjek`);
    expect(Object.keys((await mockKunder()).cfDomains).filter((h) => h === host)).toHaveLength(1);
  });

  it('viser de DNS-poster, Cloudflare returnerer, for kundens eget domæne og markerer det først live efter kontrol', async () => {
    const host = 'www.tomrer-kunde.test';
    const add = await post(`${A.base}/domaener`, { kind: 'eget', hostname: `https://${host}/` });
    expect(besked(add)).toBe(`${host}: Afventer verificering.`);
    const d = sql(`SELECT * FROM project_domains WHERE hostname = '${host}'`)[0];
    expect(d.method).toBe('saas');
    const records = JSON.parse(d.records);
    expect(records).toEqual([
      { type: 'CNAME', name: host, value: 'kunder.veyro.dk', purpose: 'Sender trafikken til Veyro' },
      { type: 'TXT', name: `_cf-custom-hostname.${host}`, value: 'verif-ch_1', purpose: 'Bekræfter, at kunden ejer domænet' },
      { type: 'TXT', name: `_acme-challenge.${host}`, value: 'acme-ch_1', purpose: 'Udstedelse af HTTPS-certifikat' },
    ]);
    const hub = await admin.get(A.base);
    expect(hub.html).toContain('verif-ch_1');
    expect(hub.html).toContain('Live på veyro.dk · eget domæne afventer');
    // Cloudflare bekræfter, men DNS svarer ikke: stadig ikke live
    await setMockState(stack.mock, { cfActive: { [host]: true } });
    expect(besked(await post(`${A.base}/domaener/${d.id}/tjek`))).toBe(`${host}: Afventer verificering.`);
    await setMockState(stack.mock, { dns: { [host]: 'CNAME' }, https: { [host]: true } });
    expect(besked(await post(`${A.base}/domaener/${d.id}/tjek`))).toBe(`${host}: Verificeret og live.`);
    expect((await admin.get(A.base)).html).toContain('Live på verificeret eget domæne');
    const visit = await hostRequest(host, '/kontakt');
    expect(visit.status).toBe(200);
    expect(visit.headers['x-robots-tag']).toBeUndefined(); // kundens eget domæne må indekseres
    expect(visit.body).toContain(`<link rel="canonical" href="https://${host}/kontakt"`);
    // Kun Veyros egne bindinger er rørt: ingen DNS-poster, navneservere eller mail
    const calls = (await mockKunder()).cfCalls;
    expect(calls.filter((c) => /dns_records|nameservers|email/.test(c.path))).toEqual([]);
    expect(calls.every((c) => c.auth === `Bearer ${CF_TOKEN}`)).toBe(true);
  });

  it('kan tage siden offline og online igen uden at slette noget', async () => {
    const leads = sql(`SELECT COUNT(*) AS n FROM project_leads WHERE project_id = '${A.pid}'`)[0].n;
    expect(besked(await post(`${A.base}/offline`))).toContain('Sæt kryds');
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).status).toBe(200);
    expect(besked(await post(`${A.base}/offline`, { confirm: '1' }))).toContain('Intet er slettet');
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).status).toBe(503);
    expect(sql(`SELECT COUNT(*) AS n FROM project_leads WHERE project_id = '${A.pid}'`)[0].n).toBe(leads);
    expect(sql(`SELECT COUNT(*) AS n FROM project_versions WHERE project_id = '${A.pid}'`)[0].n).toBe(4);
    await post(`${A.base}/online`);
    expect((await fetch(`${stack.base}/s/${A.slug}/`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Scenarie B: hjemmeside med bestilling og lager
// ---------------------------------------------------------------------------------------------------------------

const B = { cid: '', pid: '', base: '', slug: 'testbageri' };
const CATALOG = 'Varenummer;Navn;Kategori;Pris;Lager;Enhed;Lagerstyring\nBRD-1;Rugbrød;Brød;35,00;5;stk.;ja\nKAG-1;Kanelsnegl;Kager;18,00;20;stk.;ja\nSRV-1;Lagkage på bestilling;Bestilling;250,00;;stk.;nej\n';

describe('Scenarie B: hjemmeside med bestilling og lager', () => {
  it('opretter virksomhed og projekt med de fire tjenester', async () => {
    B.cid = await createCompany({ name: 'Testbageriet ApS', cvr: '10000002', email: 'ordre@bageri.test', phone: '22 33 44 55', description: 'Syntetisk testbageri med brød og kager.' });
    Object.assign(B, await createProject(B.cid, { kind: 'skabelon', name: 'Hjemmeside', slug: B.slug, template: 'bestilling' }));
    await post(`${B.base}/trin/indhold`, { layout: 'markant', primary: '#8A3B12', background: '#FFFFFF', text: '#1A1A1A', font: 'moderne', info_name: 'Testbageriet', info_phone: '22 33 44 55', info_email: 'ordre@bageri.test', info_address: 'Bagervej 2, 8000 Aarhus', info_opening_hours: 'Alle dage 6–14', next: '1' });
    const svc = await post(`${B.base}/trin/tjenester`, [['svc', 'hjemmeside'], ['svc', 'kontaktformular'], ['svc', 'varebestilling'], ['svc', 'lagerstyring'], ['next', '1']]);
    expect(loc(svc).pathname).toBe(`${B.base}/trin/opsaetning`);
  });

  it('udruller ikke, før tjenesterne er sat op', async () => {
    const res = await post(`${B.base}/udrul`);
    expect(besked(res)).toContain('Udfyld først');
    expect((await mockKunder()).dispatches).toHaveLength(0);
  });

  it('viser startkataloget før import, melder fejl og overskriver kun efter bevidst valg', async () => {
    const page = await admin.get(`${B.base}/trin/opsaetning`);
    expect(page.html).toContain('eksempel-vareliste.csv');
    const sample = await admin.get('/admin/virksomheder/eksempel-vareliste.csv');
    expect(sample.headers.get('content-type')).toContain('text/csv');
    // Fejl: dobbelt varenummer og negativ pris
    const bad = await post(`${B.base}/katalog`, { op: 'preview', csv: 'Varenummer;Navn;Pris\nA-1;Vare;10,00\nA-1;Vare igen;12,00\nA-2;Minus;-5\n' });
    expect(bad.status).toBe(422);
    expect(bad.html).toMatch(/A-1/);
    // Forhåndsvisning gemmer intet
    const preview = await post(`${B.base}/katalog`, { op: 'preview', csv: CATALOG });
    expect(preview.status).toBe(200);
    expect(preview.html).toContain('Rugbrød');
    expect(JSON.parse(sql(`SELECT config FROM project_services WHERE project_id = '${B.pid}' AND service = 'varebestilling'`)[0].config).startkatalog).toBeUndefined();
    const apply = await post(`${B.base}/katalog`, { op: 'apply', csv: CATALOG });
    expect(besked(apply)).toContain('3 varer');
    // Ny fil med ændret pris: kræver bekræftelse
    const changed = CATALOG.replace('35,00', '39,00');
    const noConfirm = await post(`${B.base}/katalog`, { op: 'apply', csv: changed });
    expect(noConfirm.status).toBe(422);
    expect(noConfirm.html).toContain('Sæt kryds for at bekræfte');
    const confirmed = await post(`${B.base}/katalog`, { op: 'apply', csv: changed, confirm_replace: '1' });
    expect(besked(confirmed)).toContain('3 varer');
    const rows = JSON.parse(sql(`SELECT config FROM project_services WHERE project_id = '${B.pid}' AND service = 'varebestilling'`)[0].config).startkatalog;
    expect(rows.find((r) => r.sku === 'BRD-1')).toMatchObject({ price: 3900, stock: 5 });
    expect(rows.find((r) => r.sku === 'SRV-1').track_stock).toBe(false);
  });

  it('sætter bestilling og lager op og starter "Deploy kunder" for netop denne kunde', async () => {
    const res = await post(`${B.base}/trin/opsaetning`, {
      'kontaktformular.recipients': 'ordre@bageri.test',
      'varebestilling.admins': 'ejer@bageri.test', 'varebestilling.domaene': '', 'varebestilling.afsender': '',
      'varebestilling.pickup': '1', 'varebestilling.delivery': '1', 'varebestilling.delivery_fee_kr': '39', 'varebestilling.notify_email': 'ordre@bageri.test',
      'lagerstyring.admins': 'ejer@bageri.test', 'lagerstyring.domaene': '', 'lagerstyring.afsender': '',
      next: '1',
    });
    expect(loc(res).pathname).toBe(`${B.base}/trin/gennemgang`);
    const page = await admin.get(`${B.base}/trin/opsaetning`);
    expect(page.html).toContain('testbageri-bestilling.veyro.dk');
    expect(page.html).toContain('testbageri-lager.veyro.dk');
    const udrul = await post(`${B.base}/udrul`);
    expect(besked(udrul)).toContain('"Deploy kunder" er startet for testbageri');
    const { dispatches } = await mockKunder();
    expect(dispatches).toEqual([{ path: '/gh/repos/marcusamm/veyro/actions/workflows/deploy-kunder.yml/dispatches', body: { ref: 'main', inputs: { kunde: 'testbageri' } } }]);
    expect(sql(`SELECT service, status FROM project_services WHERE project_id = '${B.pid}' AND service IN ('varebestilling', 'lagerstyring') ORDER BY service`)).toEqual([
      { service: 'lagerstyring', status: 'afventer' },
      { service: 'varebestilling', status: 'afventer' },
    ]);
    expect(project(B.pid).slug_locked).toBe(1);
  });

  it('udleverer kun kunder med bestilt udrulning til "Deploy kunder", og kun med nøglen', async () => {
    expect((await fetch(`${stack.base}/api/provisionering`)).status).toBe(401);
    expect((await fetch(`${stack.base}/api/provisionering`, { headers: { Authorization: 'Bearer forkert-token-forkert-token-forkert' } })).status).toBe(401);
    const res = await fetch(`${stack.base}/api/provisionering`, { headers: { Authorization: `Bearer ${PROV_TOKEN}` } });
    expect(res.status).toBe(200);
    const { kunder } = await res.json();
    expect(kunder.map((k) => k.slug)).toEqual(['testbageri']);
    const k = kunder[0];
    expect(k).toMatchObject({ kilde: 'admin', projekt: B.pid, navn: 'Testbageriet ApS', udseende: { farve: '#8A3B12' }, butik: { pickup_enabled: true, delivery_enabled: true, delivery_fee: 3900, notify_email: 'ordre@bageri.test' } });
    expect(k.systemer).toEqual({ varebestilling: { admins: ['ejer@bageri.test'] }, lagerstyring: { admins: ['ejer@bageri.test'] } });
    expect(k.startkatalog.map((r) => r.sku)).toEqual(['BRD-1', 'KAG-1', 'SRV-1']);
    // Samme validering som udrulningen bruger; lageret får sin egen adresse ved siden af hjemmesidens
    const kunde = validerKunde(`admin:${k.slug}`, k.slug, k, { kundeDomaene: 'veyro.dk', fraAdmin: true });
    expect(kunde.systemer.map((s) => [s.navn, s.domaene])).toEqual([
      ['testbageri-bestilling', 'testbageri-bestilling.veyro.dk'],
      ['testbageri-lager', 'testbageri-lager.veyro.dk'],
    ]);
    // Intet fra andre kunder
    expect(JSON.stringify(kunder)).not.toContain('tomrer');
  });

  it('stopper publicering af en bestillingsknap, før bestillingssystemet er forbundet', async () => {
    await post(`${B.base}/side/forside`, { title: 'Forside', seo_title: 'Testbageriet', seo_description: 'Syntetisk testbageri med brød og kager.', in_nav: '1' });
    await post(`${B.base}/godkend`);
    const res = await post(`${B.base}/publicer`, { version_id: String(versionId(B.pid, 1)) });
    expect(fejl(res)).toContain('stoppet');
    expect(sql(`SELECT steps FROM publications WHERE project_id = '${B.pid}' ORDER BY id DESC LIMIT 1`)[0].steps).toContain('ikke udrullet og forbundet endnu');
  });

  it('viser en fejlet udrulning og forbinder tjenesten efter et vellykket genforsøg', async () => {
    const status = (body) => fetch(`${stack.base}/api/provisionering/status`, { method: 'POST', headers: { Authorization: `Bearer ${PROV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await fetch(`${stack.base}/api/provisionering/status`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await status({ projekt: B.pid, system: 'lagerstyring', ok: false, fejl: 'wrangler deploy fejlede (simuleret)' })).status).toBe(200);
    expect((await admin.get('/admin/virksomheder')).html).toContain('Intern lagerstyring er blokeret');
    expect((await admin.get(`${B.base}/trin/opsaetning`)).html).toContain('wrangler deploy fejlede (simuleret)');
    // Genforsøg
    await post(`${B.base}/udrul`);
    expect((await mockKunder()).dispatches).toHaveLength(2);
    await status({ projekt: B.pid, system: 'lagerstyring', ok: true, url: 'https://testbageri-lager.veyro.dk' });
    await status({ projekt: B.pid, system: 'varebestilling', ok: true, url: 'https://testbageri-bestilling.veyro.dk' });
    // En adresse, der ikke er https, accepteres ikke som forbundet
    await status({ projekt: B.pid, system: 'varebestilling', ok: true, url: 'http://ondsindet.test' });
    expect(sql(`SELECT status FROM project_services WHERE project_id = '${B.pid}' AND service = 'varebestilling'`)[0].status).toBe('blokeret');
    await status({ projekt: B.pid, system: 'varebestilling', ok: true, url: 'https://testbageri-bestilling.veyro.dk' });
    expect(sql(`SELECT service, status, provisioned_url FROM project_services WHERE project_id = '${B.pid}' AND service IN ('varebestilling', 'lagerstyring') ORDER BY service`)).toEqual([
      { service: 'lagerstyring', status: 'forbundet', provisioned_url: 'https://testbageri-lager.veyro.dk' },
      { service: 'varebestilling', status: 'forbundet', provisioned_url: 'https://testbageri-bestilling.veyro.dk' },
    ]);
    // Efter udrulning ændres varer i bestillingssystemets egen import
    const late = await post(`${B.base}/katalog`, { op: 'preview', csv: CATALOG });
    expect(late.status).toBe(422);
    expect(late.html).toContain('systemets egen import');
  });

  it('publicerer siden med knap til det rigtige bestillingssystem; forhåndsvisningen kan ikke bestille', async () => {
    const res = await post(`${B.base}/publicer`, { version_id: String(versionId(B.pid, 1)) });
    expect(besked(res)).toContain('Publiceret');
    const live = await (await fetch(`${stack.base}/s/${B.slug}/`)).text();
    expect(live).toContain('href="https://testbageri-bestilling.veyro.dk"');
    const pv = await post(`${B.base}/forhaandsvisning`);
    const preview = await (await fetch(stack.base + loc(pv).pathname)).text();
    expect(preview).not.toContain('href="https://testbageri-bestilling.veyro.dk"');
    expect(preview).toContain('Der oprettes ingen ordrer herfra');
  });

  it('afviser et domæne, der allerede tilhører en anden kunde', async () => {
    const res = await post(`${B.base}/domaener`, { kind: 'eget', hostname: 'www.tomrer-kunde.test' });
    expect(fejl(res)).toContain('allerede knyttet til en anden kunde');
    const veyro = await post(`${B.base}/domaener`, { kind: 'eget', hostname: 'testbageri-bestilling.veyro.dk' });
    expect(fejl(veyro)).toContain('oprettes automatisk');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Scenarie C: tilsluttet specialbygget hjemmeside
// ---------------------------------------------------------------------------------------------------------------

const C = { cid: '', pid: '', base: '', key: '', slug: 'raadgivning-test' };

describe('Scenarie C: eksisterende specialbygget hjemmeside', () => {
  it('kræver en https-adresse og bygger ikke siden om', async () => {
    C.cid = await createCompany({ name: 'Rådgivning Test ApS', cvr: '10000003', email: 'mail@raadgivning.test' });
    const bad = await post(`/admin/virksomheder/${C.cid}/projekter/ny`, { kind: 'tilsluttet', name: 'Hjemmeside', slug: C.slug, external_url: 'http://raadgivning.test' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Angiv sidens fulde adresse med https://.');
    // Lokalt (kundepanelet kører på http://127.0.0.1) accepteres mock-serverens adresse
    const r = await createProject(C.cid, { kind: 'tilsluttet', name: 'Hjemmeside', slug: C.slug, external_url: `${stack.mock.url}/ekstern` });
    Object.assign(C, r);
    expect(r.next).toBe('tjenester');
    C.key = project(C.pid).public_key;
    expect(C.key).toMatch(/^pk_/);
    // Ingen forhåndsvisning, kundelink eller domæner: siden hostes og bygges et andet sted
    expect((await post(`${C.base}/forhaandsvisning`)).status).toBe(404);
    expect((await post(`${C.base}/domaener`, { kind: 'eget', hostname: 'www.raadgivning.test' })).status).toBe(404);
  });

  it('forbinder kontaktformularen og viser integrationen', async () => {
    await post(`${C.base}/trin/tjenester`, [['svc', 'hjemmeside'], ['svc', 'kontaktformular'], ['next', '1']]);
    const res = await post(`${C.base}/trin/opsaetning`, { 'kontaktformular.recipients': 'henvendelser@raadgivning.test', next: '1' });
    expect(loc(res).pathname).toBe(`${C.base}/trin/gennemgang`);
    const setup = await admin.get(`${C.base}/trin/opsaetning`);
    expect(setup.html).toContain(`/api/kundeside/${C.key}/formular`);
    expect(setup.html).toContain(`/api/kundeside/${C.key}/config.json`);
  });

  it('stopper ved en side, der ikke svarer, og kontrollerer igen bagefter', async () => {
    await setMockState(stack.mock, { externalDown: true });
    await post(`${C.base}/godkend`);
    const failed = await post(`${C.base}/publicer`, { version_id: String(versionId(C.pid, 1)) });
    expect(fejl(failed)).toContain('stoppet');
    expect(sql(`SELECT steps FROM publications WHERE project_id = '${C.pid}' ORDER BY id DESC LIMIT 1`)[0].steps).toContain('svarede HTTP 503');
    await setMockState(stack.mock, { externalDown: false });
    const review = await admin.get(`${C.base}/trin/gennemgang`);
    expect(review.html).toContain('indeholder ikke projektets offentlige nøgle');
    await setMockState(stack.mock, { externalHtml: `<!doctype html><html><body><form method="post" action="${stack.base}/api/kundeside/${C.key}/formular"></form></body></html>` });
    expect((await admin.get(`${C.base}/trin/gennemgang`)).html).toContain('Siden bruger projektets formular-adresse.');
    const ok = await post(`${C.base}/publicer`, { version_id: String(versionId(C.pid, 1)) });
    expect(besked(ok)).toContain('Publiceret');
    expect((await admin.get('/admin/virksomheder')).html).toContain('Tilsluttet og kontrolleret');
    // /s/-adressen sender videre til kundens egen side; Veyro viser ikke en kopi
    const s = await fetch(`${stack.base}/s/${C.slug}/`, { redirect: 'manual' });
    expect(s.status).toBe(302);
    expect(s.headers.get('location')).toBe(`${stack.mock.url}/ekstern`);
  });

  it('modtager formularer fra kundens side og kun derfra', async () => {
    const send = (origin, extra = {}) =>
      fetch(`${stack.base}/api/kundeside/${C.key}/formular`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, 'CF-Connecting-IP': '198.51.100.30' },
        body: new URLSearchParams({ name: 'Test Besøgende', email: 'besoeg@person.test', message: 'Jeg vil gerne høre mere.', samtykke: '1', return_to: '/ekstern', ...extra }),
      });
    const before = (await emails()).length;
    const ok = await send(stack.mock.url);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`${stack.mock.url}/ekstern?sendt=1`);
    await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'henvendelser@raadgivning.test'));
    expect((await send('https://ondsindet.test')).status).toBe(403);
    // return_to til et andet site ignoreres
    const redirect = await send(stack.mock.url, { return_to: 'https://ondsindet.test/' });
    expect(redirect.headers.get('location')).toBe(`${stack.mock.url}/?sendt=1`);
    // En nøgle fra et andet projekt virker ikke med denne sides adresse
    const otherKey = project(A.pid).public_key;
    const cross = await fetch(`${stack.base}/api/kundeside/${otherKey}/formular`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.mock.url }, body: 'name=x' });
    expect(cross.status).toBe(403);
  });

  it('deler kun offentlige oplysninger i konfigurationen', async () => {
    const res = await fetch(`${stack.base}/api/kundeside/${C.key}/config.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const cfg = await res.json();
    expect(Object.keys(cfg).sort()).toEqual(['bestilling', 'formular', 'kontakt', 'navn', 'projekt']);
    expect(cfg.formular).toBe(`${stack.base}/api/kundeside/${C.key}/formular`);
    const all = JSON.stringify(cfg);
    expect(cfg.kontakt.email).toBe('mail@raadgivning.test'); // de offentlige kontaktoplysninger
    expect(all).not.toContain('henvendelser@raadgivning.test'); // modtageren af formularen er ikke offentlig
    expect(all).not.toMatch(/token|secret|internal|cvr/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Adskillelse mellem kunder, kundepanel og drift
// ---------------------------------------------------------------------------------------------------------------

describe('Adskillelse mellem kunder', () => {
  it('afviser adresser, hvor virksomhed og projekt ikke hører sammen', async () => {
    expect((await admin.get(`/admin/virksomheder/${A.cid}/projekter/${B.pid}`)).status).toBe(404);
    expect((await post(`/admin/virksomheder/${A.cid}/projekter/${B.pid}/publicer`, { version_id: '1' })).status).toBe(404);
    expect((await admin.get(`/admin/virksomheder/v_findesikke/projekter/${A.pid}`)).status).toBe(404);
  });

  it('bruger aldrig en anden kundes version eller billede', async () => {
    const before = project(B.pid).live_version_id;
    const res = await post(`${B.base}/publicer`, { version_id: String(versionId(A.pid, 4)) });
    expect(besked(res)).toContain('Versionen findes ikke for dette projekt.');
    expect(project(B.pid).live_version_id).toBe(before);
    expect((await fetch(`${stack.base}/s/${B.slug}/_filer/${A.image}`)).status).toBe(404);
    expect((await admin.get(`${B.base}/billeder/${A.image}`)).status).toBe(404);
    await post(`${B.base}/billeder/${A.image}/slet`);
    expect(sql(`SELECT COUNT(*) AS n FROM project_files WHERE id = ${A.image}`)[0].n).toBe(1);
    // Et billede fra en anden kunde kan ikke sættes ind på siden
    await post(`${B.base}/side/forside`, { title: 'Forside', seo_title: 'Testbageriet', seo_description: 'Syntetisk testbageri med brød og kager.', in_nav: '1', s0_image: String(A.image) });
    expect(JSON.parse(project(B.pid).draft).pages[0].sections[0].image).toBeNull();
  });

  it('giver kundens bruger adgang til egen virksomhed og intet andet', async () => {
    const before = (await emails()).length;
    const inv = await post(`/admin/virksomheder/${B.cid}/brugere`, { email: 'ejer@bageri.test' });
    expect(besked(inv)).toContain('Invitation sendt til ejer@bageri.test');
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'ejer@bageri.test'));
    expect(mail.text).toContain('/login/bekraeft?token=');
    expect(mail.text).not.toMatch(/adgangskode:/i);
    // En testhenvendelse fra forhåndsvisningen må ikke vises for kunden
    const pv = await post(`${B.base}/forhaandsvisning`);
    await fetch(`${stack.base}${loc(pv).pathname}_kontakt`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base }, body: new URLSearchParams({ name: 'Test', email: 'test@person.test', message: 'PREVIEW-TEST', samtykke: '1' }) });

    const { client: owner } = await login(stack, 'ejer@bageri.test');
    const mine = await owner.get('/konto/hjemmeside');
    expect(mine.status).toBe(200);
    expect(mine.html).toContain('Testbageriet');
    expect(mine.html).not.toContain('Testfirma Tømrer');
    expect(mine.html).not.toContain('PREVIEW-TEST');
    expect((await owner.get(`/konto/hjemmeside/${B.pid}`)).status).toBe(200);
    expect((await owner.get(`/konto/hjemmeside/${A.pid}`)).status).toBe(404);
    expect((await owner.get('/admin/virksomheder')).status).toBe(403);
    expect((await owner.get(`/admin/virksomheder/${B.cid}`)).status).toBe(403);
    const forged = await owner.post(`/admin/virksomheder/${B.cid}/projekter/${B.pid}/offline`, { _csrf: csrfFrom(mine.html), confirm: '1' });
    expect(forged.status).toBe(403);
    expect(project(B.pid).offline).toBe(0);
    // Uden login
    const anon = new Client(stack.base);
    expect((await anon.get(`/admin/virksomheder/${A.cid}`)).status).toBe(303);
  });

  it('kopierer kun design og opbygning med "Brug som startpunkt"', async () => {
    const res = await post(`${A.base}/startpunkt`, { company_id: C.cid });
    expect(besked(res)).toContain('samme opbygning');
    const pid = loc(res).pathname.match(/projekter\/(p_[a-z0-9x]+)/)[1];
    const p = project(pid);
    expect(p.company_id).toBe(C.cid);
    const draft = JSON.parse(p.draft);
    expect(draft.brand.primary).toBe('#7A4B2A');
    expect(draft.pages.map((x) => x.handle)).toEqual(['', 'kontakt']);
    const text = JSON.stringify(draft);
    for (const s of ['Tagarbejde', 'kontakt@tomrer.test', '11 22 33 44', 'Testvej', 'Testfirma']) expect(text).not.toContain(s);
    expect(draft.brand.logo).toBeNull();
    expect(draft.pages[0].sections.every((x) => x.image === null)).toBe(true);
    expect(sql(`SELECT (SELECT COUNT(*) FROM project_files WHERE project_id = '${pid}') AS f, (SELECT COUNT(*) FROM project_leads WHERE project_id = '${pid}') AS l, (SELECT COUNT(*) FROM project_domains WHERE project_id = '${pid}') AS d, (SELECT COUNT(*) FROM project_versions WHERE project_id = '${pid}') AS v`)[0]).toEqual({ f: 0, l: 0, d: 0, v: 0 });
  });

  it('logger handlinger med aktør og tidspunkt uden nøgler eller tokens', async () => {
    const page = await admin.get(`/admin/virksomheder/${A.cid}`);
    expect(page.html).toContain('Version publiceret');
    const rows = sql('SELECT actor, action, detail, at FROM customer_audit');
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.actor && r.at > 0)).toBe(true);
    const all = JSON.stringify(rows) + JSON.stringify(sql('SELECT * FROM error_log'));
    for (const secret of [PROV_TOKEN, CF_TOKEN, GITHUB_TOKEN, 'ejer@bageri.test']) expect(all).not.toContain(secret);
  });

  it('viser alle tre kunder i oversigten med status', async () => {
    const overview = await admin.get('/admin/virksomheder');
    for (const name of ['Testfirma Tømrer ApS', 'Testbageriet ApS', 'Rådgivning Test ApS']) expect(overview.html).toContain(name);
    expect(overview.html).toContain('Live på verificeret eget domæne');
    expect(overview.html).toContain('Tilsluttet og kontrolleret');
  });
});
