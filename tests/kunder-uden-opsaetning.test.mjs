// Admin › Kunder før engangsopsætningen: uden Cloudflare-nøgle, GitHub-nøgle og udrulningsnøgle.
// Domæner må aldrig blive "live", udrulning viser det manuelle trin, og intet kalder eksterne tjenester.
// Plus regler, der ikke kræver en kørende stak (adresser, reserverede navne, tilsluttede sider).
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalSiteUrl, hostProblem } from '../src/kunder/domaener.ts';
import { slugProblem } from '../src/kunder/model.ts';
import { defaultSystemHost } from '../src/kunder/tjenester.ts';
import { ADMIN_EMAIL, csrfFrom, login, startStack } from './harness.mjs';

let stack;
let admin;
let csrf;

const post = (p, fields = {}) => admin.post(p, [['_csrf', csrf], ...(Array.isArray(fields) ? fields : Object.entries(fields))]);
const loc = (res) => new URL(res.headers.get('location'), stack.base);
const besked = (res) => loc(res).searchParams.get('besked') ?? '';

function hostGet(host, p) {
  const u = new URL(stack.base);
  return new Promise((resolve, reject) => {
    http
      .get({ host: u.hostname, port: u.port, path: p, headers: { Host: host } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', reject);
  });
}

describe('Regler uden stak', () => {
  it('accepterer kun https for tilsluttede sider i drift', () => {
    const prod = { APP_URL: 'https://kunde.veyro.dk' };
    expect(externalSiteUrl(prod, 'https://www.kunde.dk/')).toBe('https://www.kunde.dk');
    expect(externalSiteUrl(prod, 'http://www.kunde.dk')).toBeNull();
    expect(externalSiteUrl(prod, 'http://127.0.0.1:8787/')).toBeNull();
    expect(externalSiteUrl(prod, 'https://bruger:kode@www.kunde.dk')).toBeNull();
    expect(externalSiteUrl(prod, 'javascript:alert(1)')).toBeNull();
    // Kun lokalt, når kundepanelet selv kører på http://127.0.0.1
    expect(externalSiteUrl({ APP_URL: 'http://127.0.0.1:8787' }, 'http://127.0.0.1:9000/side')).toBe('http://127.0.0.1:9000/side');
  });

  it('holder hjemmesidens adresse og kundesystemernes adresser adskilt', () => {
    expect(defaultSystemHost('bageri', 'varebestilling', 'veyro.dk')).toBe('bageri-bestilling.veyro.dk');
    expect(defaultSystemHost('bageri', 'lagerstyring', 'veyro.dk')).toBe('bageri-lager.veyro.dk');
    // En adresse, der ender som et kundesystem, eller som en eksisterende kunde i kunder/, kan ikke vælges
    for (const slug of ['bageri-lager', 'bageri-bestilling', 'ek', 'einar-kornerup', 'ek-enterprise', 'kunde', 'www']) expect(slugProblem(slug)).toMatch(/reserveret/);
    expect(slugProblem('bageri')).toBeNull();
  });

  it('knytter aldrig Veyros egne domæner til en kunde', () => {
    const env = { APP_URL: 'https://kunde.veyro.dk', SITE_HOSTS: 'veyro.dk,www.veyro.dk' };
    expect(hostProblem(env, 'kunde.veyro.dk', 'eget')).toMatch(/Veyro selv/);
    expect(hostProblem(env, 'veyro.dk', 'eget')).toMatch(/Veyro selv/);
    expect(hostProblem(env, 'noget.veyro.dk', 'eget')).toMatch(/oprettes automatisk/);
    expect(hostProblem(env, 'ikke et domæne', 'eget')).toMatch(/ikke et gyldigt/);
    expect(hostProblem(env, 'www.kunde.dk', 'eget')).toBeNull();
  });
});

describe('Før engangsopsætningen', () => {
  beforeAll(async () => {
    stack = await startStack({ minMonths: 0 });
    ({ client: admin } = await login(stack, ADMIN_EMAIL));
    csrf = csrfFrom((await admin.get('/admin/virksomheder')).html);
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  let cid;
  let base;

  it('gemmer domænet som blokeret og viser det aldrig som live', async () => {
    const res = await post('/admin/virksomheder/ny', { name: 'Domænetest ApS', email: 'kontakt@domaene.test' });
    cid = loc(res).pathname.split('/')[3];
    const pr = await post(`/admin/virksomheder/${cid}/projekter/ny`, { kind: 'skabelon', name: 'Hjemmeside', slug: 'domaenetest', template: 'service' });
    const site = loc(pr).pathname.replace(/\/trin\/indhold$/, '');
    const add = await post(`${site}/domaener`, { kind: 'eget', hostname: 'www.domaene.test' });
    expect(besked(add)).toBe('www.domaene.test: Kræver engangsopsætning.');
    const hub = await admin.get(site);
    expect(hub.html).toContain('CF_API_TOKEN er ikke sat');
    expect(hub.html).not.toContain('Verificeret og live');
    // Domænet viser ikke kundens side, før det er sat op og verificeret
    const visit = await hostGet('www.domaene.test', '/');
    expect(visit.headers['x-veyro-project']).toBeUndefined();
  });

  it('viser det manuelle udrulningstrin og deler intet uden nøgle', async () => {
    const pr = await post(`/admin/virksomheder/${cid}/projekter/ny`, { kind: 'intern', name: 'Lager', slug: 'domaenetest-intern' });
    expect(loc(pr).pathname).toMatch(/\/trin\/tjenester$/);
    base = loc(pr).pathname.replace(/\/trin\/tjenester$/, '');
    // En offentlig hjemmeside passer ikke til et internt projekt
    const page = await admin.get(`${base}/trin/tjenester`);
    expect(page.html).toMatch(/value="hjemmeside" disabled/);
    await post(`${base}/trin/tjenester`, [['svc', 'lagerstyring'], ['next', '1']]);
    const setup = await post(`${base}/trin/opsaetning`, { 'lagerstyring.admins': 'ejer@domaene.test', 'lagerstyring.domaene': '', 'lagerstyring.afsender': '', next: '1' });
    expect(loc(setup).pathname).toBe(`${base}/trin/gennemgang`);
    const res = await post(`${base}/udrul`);
    expect(besked(res)).toContain('PROVISIONERING_TOKEN er ikke sat');
    expect(besked(res)).toContain('Run workflow med kunde "domaenetest-intern"');
    const overview = await admin.get('/admin/virksomheder');
    expect(overview.html).toContain('Ingen hjemmeside');
    expect(overview.html).toContain('Afventer udrulning');
    // Uden PROVISIONERING_TOKEN afvises alle, også med en vilkårlig nøgle
    expect((await fetch(`${stack.base}/api/provisionering`, { headers: { Authorization: 'Bearer ' + 'x'.repeat(40) } })).status).toBe(401);
    expect((await fetch(`${stack.base}/api/provisionering`, { headers: { Authorization: 'Bearer ' } })).status).toBe(401);
  });

  it('bevarer opsætningen, når en tjeneste slås fra og til igen', async () => {
    await post(`${base}/trin/tjenester`, [['svc', 'lagerstyring'], ['svc', 'varebestilling'], ['next', '0']]);
    await post(`${base}/trin/opsaetning`, { 'lagerstyring.admins': 'ejer@domaene.test', 'varebestilling.admins': 'ejer@domaene.test', 'varebestilling.pickup': '1', 'varebestilling.notify_email': 'ordre@domaene.test' });
    const off = await post(`${base}/trin/tjenester`, [['svc', 'lagerstyring'], ['next', '0']]);
    expect(off.status).toBe(303);
    const page = await admin.get(`${base}/trin/tjenester`);
    expect(page.html).toContain('Slået fra; opsætning og data er bevaret.');
    await post(`${base}/trin/tjenester`, [['svc', 'lagerstyring'], ['svc', 'varebestilling'], ['next', '0']]);
    const setup = await admin.get(`${base}/trin/opsaetning`);
    expect(setup.html).toContain('ordre@domaene.test');
  });
});
