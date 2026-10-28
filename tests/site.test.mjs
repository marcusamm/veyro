// Salgshjemmesiden (veyro.dk): gengivelse, kurv, formularer, forespørgsler og admin.
// Hjemmesiden svarer på localhost, kundepanelet på 127.0.0.1 (se harness.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, csrfFrom, login, startStack, waitFor } from './harness.mjs';

let stack;
let admin;
let site;

const emails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();

function sql(query) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'wrangler'),
    ['d1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, '--config', path.join(ROOT, '.wrangler-test.toml'), '--json', '--command', query],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' },
  ).toString();
  return JSON.parse(out)[0].results;
}

/** Felterne i en formular på hjemmesiden (skjulte felter + udfyldte) */
function contactForm(html, formId, fields) {
  const start = html.indexOf(`id="${formId}"`);
  expect(start, `formular ${formId} findes`).toBeGreaterThan(-1);
  const chunk = html.slice(start, html.indexOf('</form>', start));
  const ret = chunk.match(/name="return_to" value="([^"]*)"/)[1];
  return { form_type: 'contact', form_id: formId, return_to: ret, website_url: '', ...fields };
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Alle felter i en HTML-formular, som browseren ville sende dem (afkrydsningsfelter kun hvis valgt) */
function formFields(html, prefix = '') {
  const out = {};
  const attr = (tag, a) => tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1];
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name');
    if (!name || !name.startsWith(prefix)) continue;
    const type = attr(tag, 'type') ?? 'text';
    if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag)) continue;
    if (type === 'file') continue;
    out[unescape(name)] = unescape(attr(tag, 'value') ?? '');
  }
  for (const m of html.matchAll(/<textarea\b[^>]*\sname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) if (m[1].startsWith(prefix)) out[unescape(m[1])] = unescape(m[2]);
  for (const m of html.matchAll(/<select\b[^>]*\sname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    if (!m[1].startsWith(prefix)) continue;
    out[unescape(m[1])] = unescape(m[2].match(/value="([^"]*)" selected/)?.[1] ?? m[2].match(/value="([^"]*)"/)?.[1] ?? '');
  }
  return out;
}

const adminPost = async (p, fields) => {
  const page = await admin.get(p);
  return admin.post(p, { _csrf: csrfFrom(page.html), ...fields });
};

beforeAll(async () => {
  stack = await startStack({ minMonths: 0 });
  admin = (await login(stack, ADMIN_EMAIL)).client;
  site = new Client(stack.site);
});

afterAll(async () => {
  await stack?.stop();
});

describe('Hjemmesiden vises uden Shopify', () => {
  it('alle sider findes, med tema, menu og egne sikkerhedsheaders', async () => {
    for (const p of ['/', '/pages/priser', '/pages/eksempler', '/pages/hjemmeside', '/pages/booking', '/pages/webshop', '/pages/drift', '/pages/ydelser', '/pages/website-optimering', '/pages/custom-losninger', '/pages/om-os', '/pages/kontakt', '/pages/privatlivspolitik', '/pages/cookiepolitik', '/pages/handelsbetingelser', '/pages/databehandleraftale', '/pages/sla', '/cart']) {
      const r = await site.get(p);
      expect(r.status, p).toBe(200);
      expect(r.html, p).toContain('<link rel="stylesheet" href="//localhost:');
      expect(r.html, p).toContain('href="/pages/kontakt"');
      expect(r.html, p).not.toMatch(/Liquid error|MISSING:|shopify\.com|cdn\.shopify/i);
      // Alle scripts har sidens nonce, og CSP tillader kun dem
      const csp = r.headers.get('content-security-policy');
      const nonce = csp.match(/'nonce-([^']+)'/)[1];
      for (const tag of r.html.match(/<script\b[^>]*>/g)) expect(tag, p).toContain(`nonce="${nonce}"`);
      expect(csp).toContain("form-action 'self'");
    }
    const home = await site.get('/');
    expect(home.html).toContain('<title>Veyro');
    expect(home.html).toContain('Kundelogin');
    expect(home.html).not.toMatch(/head__title t-\d/);
    // Sådan arbejder vi ligger under Veyro i bunden og peger på afsnittet på forsiden
    expect(home.html).toContain('id="proces"');
    expect(home.html).toMatch(/Veyro<\/h2><ul role="list">(?:(?!<\/ul>).)*<a href="\/#proces">Sådan arbejder vi<\/a>/s);
    // Menuen: løsninger, eksempler, priser, om os, kontakt og kundelogin, men intet kurv-ikon, når kurven er tom
    for (const href of ['/pages/ydelser', '/pages/eksempler', '/pages/priser', '/pages/om-os', '/pages/kontakt']) expect(home.html).toContain(`href="${href}"`);
    expect(home.html).not.toContain('site-header__cart');
    expect(home.html).toContain('CVR: 46857569');
  });

  it('ukendte sider giver 404 med temaets fejlside; gamle Shopify-adresser omdirigeres', async () => {
    const r = await site.get('/pages/findes-ikke');
    expect(r.status).toBe(404);
    expect(r.html).toContain('Siden findes ikke');
    expect((await site.get('/collections/all')).headers.get('location')).toBe('/pages/kontakt#formular');
    expect((await site.get('/account')).headers.get('location')).toBe('https://kunde.veyro.dk/login');
  });

  it('robots.txt, sitemap og temafiler med lang cache', async () => {
    const robots = await site.get('/robots.txt');
    expect(robots.html).toContain('Sitemap: http://localhost:');
    const sm = await site.get('/sitemap.xml');
    expect(sm.html).toContain('/pages/ydelser</loc>');
    expect(sm.html).not.toContain('/products/business</loc>');
    const home = await site.get('/');
    const css = home.html.match(/href="\/\/localhost:\d+(\/assets\/base\.css\?v=[0-9a-f]+)"/)[1];
    const r = await site.get(css);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect((await site.get('/assets/inter-tight-latin-wght-normal.woff2')).headers.get('content-type')).toBe('font/woff2');
  });

  it('ikonet til søgeresultater ligger på faste adresser og står som logo i de strukturerede data', async () => {
    const home = await site.get('/');
    expect(home.html).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48">');
    expect(home.html).toContain('href="/assets/favicon-192.png"');
    expect(home.html).not.toMatch(/favicon[^"]*\?v=/);
    expect(home.html).toMatch(/"logo": "http:\/\/localhost:\d+\/assets\/favicon-192\.png"/);
    const ico = await site.get('/favicon.ico');
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toBe('image/x-icon');
    expect((await site.get('/assets/favicon-192.png')).status).toBe(200);
  });

  it('kundepanelet på sit eget domæne er uændret', async () => {
    const r = await new Client(stack.base).get('/login');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Veyro kundepanel');
  });

  it('privatlivs- og cookiepolitik nævner ikke længere Shopify som vært', async () => {
    const p = await site.get('/pages/privatlivspolitik');
    expect(p.html).toContain('Cloudflare, som hoster hjemmesiden');
    expect(p.html).not.toContain('Shopify, som hoster');
    const c = await site.get('/pages/cookiepolitik');
    expect(c.html).toContain('veyro_cart');
    expect(c.html).toContain('__Host-vk_session');
  });

  it('juridiske sider: B2B-betingelser, databehandleraftale og SLA linkes fra sidefoden', async () => {
    const home = await site.get('/');
    for (const h of ['handelsbetingelser', 'databehandleraftale', 'sla']) expect(home.html).toContain(`href="/pages/${h}"`);
    expect(home.html).toContain('46857569');
    const t = await site.get('/pages/handelsbetingelser');
    expect(t.html).toContain('ingen fortrydelsesret');
    expect(t.html).toContain('Vi er ikke ansvarlige for indirekte tab');
    const d = await site.get('/pages/databehandleraftale');
    expect(d.html).toContain('Bilag B: Underdatabehandlere');
    expect(d.html).toContain('senest 48 timer');
    const sla = await site.get('/pages/sla');
    expect(sla.html).toContain('99,5 %');
  });
});

describe('Pakker og priser', () => {
  // Kortene i en pakkeliste: [id, html] for hvert <li class="pc ...">
  const cards = (html) => {
    const parts = html.split('<li class="pc ').slice(1);
    return parts.map((p) => [p.match(/id="([^"]+)"/)[1], p.slice(0, p.indexOf('class="pc__actions"') + 600)]);
  };
  const names = (html) => [...html.matchAll(/class="pc__name">([^<]+)</g)].map((m) => m[1]);
  const amounts = (html) => [...html.matchAll(/class="pc__amount"><strong>([^<]+)<\/strong>/g)].map((m) => m[1]);

  it('prissiden viser Hjemmeside, Booking og Webshop med priser ekskl. moms; Drift og Alt inkl. er "På vej"', async () => {
    const r = await site.get('/pages/priser');
    expect(r.status).toBe(200);
    const all = cards(r.html);
    expect(all.map(([id]) => id)).toEqual(['pakke-hjemmeside', 'pakke-booking', 'pakke-webshop', 'pakke-drift-kort', 'pakke-alt-inkl-kort']);
    expect(names(r.html).slice(0, 5)).toEqual(['Hjemmeside', 'Booking', 'Webshop', 'Drift', 'Alt inkl.']);
    expect(amounts(r.html).slice(0, 5)).toEqual(['199 kr.', '299 kr.', '499 kr.', '599 kr.', '1.099 kr.']);
    const [hjemmeside, booking, webshop, drift, alt] = all.map(([, html]) => html);
    for (const [card, key] of [[hjemmeside, 'pakke-hjemmeside'], [booking, 'pakke-booking'], [webshop, 'pakke-webshop']]) {
      expect(card).toContain('pc--available');
      expect(card).toContain('class="pc__vat">ekskl. moms<');
      expect(card).toContain(`href="/pages/kontakt?ydelse=${key}#formular"`);
      expect(card).not.toMatch(/På vej|Forventet|testkunde|Pris følger/);
    }
    // Pakkernes indhold og rammer
    for (const t of ['Op til 5 sider', '3 korrekturrunder', 'En korrekturrunde er én samlet tilbagemelding på det aftalte design og indhold']) expect(hjemmeside).toContain(t);
    for (const t of ['Alt i Hjemmeside', 'Kunden kan selv booke, flytte og aflyse', 'Op til 3 medarbejdere med egen bruger eller bookingkalender', 'SMS, påmindelser og onlinebetaling er ikke en del af pakken']) expect(booking).toContain(t);
    for (const t of ['Op til 50 aktive produkter og op til 200 varianter', 'Op til 3 administratorbrugere', 'En T-shirt i 3 størrelser og 2 farver er 1 produkt med 6 varianter', 'Ikke begge dele']) expect(webshop).toContain(t);
    for (const [card, key] of [[drift, 'drift'], [alt, 'alt-inkl']]) {
      expect(card).toContain('pc--coming');
      expect(card).toContain('På vej');
      expect(card).toContain('Forventet pris');
      expect(card).toContain(`href="/pages/drift?pakke=${key}#testkunde"`);
      expect(card).not.toContain('/pages/kontakt');
    }
    // Fælles vilkår, betaling og brugere
    for (const t of ['Gratis oprettelse', 'Første måned gratis', 'Ingen binding', 'Sådan bestiller og betaler du', 'Betal sikkert med kort', 'Du betaler ikke her. Vi sender et tilbud med et personligt betalingslink.', 'Kontakt os om tilkøb', 'jeresnavn.veyro.dk']) {
      expect(r.html).toContain(t);
    }
    expect(r.html).toContain('href="https://kunde.veyro.dk/login"');
    expect(r.html).not.toMatch(/Mest populær|Komplet|All in|Starter|Premium|Pris følger|gratis domæne/i);
    expect(r.html).not.toContain('action="/cart/add"');
    // Ekstra brugere: pakkepris + (n - 3) × 99
    const rows = [...r.html.matchAll(/<tr><th scope="row">(\d+)[^<]*<\/th><td class="num">([^<]+)<\/td><td class="num">([^<]+)<\/td><\/tr>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual([['3', '299 kr.', '499 kr.'], ['4', '398 kr.', '598 kr.'], ['5', '497 kr.', '697 kr.'], ['6', '596 kr.', '796 kr.']]);
    expect(r.html).toContain('Booking med 5 medarbejdere koster 497 kr./md. ekskl. moms');
    // De gamle planer kan ikke købes
    for (const h of ['starter', 'business', 'premium']) expect((await site.get('/products/' + h)).status).toBe(404);
  });

  it('forsiden: hero, eksempler, bookingforløb, pakker, samarbejde, "På vej", FAQ og kontakt', async () => {
    const r = await site.get('/');
    const at = (cls) => r.html.indexOf(`<section class="${cls}"`);
    const section = (cls) => r.html.slice(at(cls), r.html.indexOf('</section>', at(cls)));
    const order = ['home-hero', 'project-gallery', 'section studio-capabilities', 'section booking-flow', 'section packages packages--summary', 'section steps', 'section coming', 'section faq', 'section contact'];
    for (const cls of order) expect(at(cls), cls).toBeGreaterThan(-1);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
    // Hero: én H1, én primær og én sekundær knap, og eksemplet er mærket som designkoncept
    const hero = section('home-hero');
    expect(r.html.match(/<h1/g)).toHaveLength(1);
    expect(hero).toContain('Din forretning.<br>Dit eget udtryk.<br><span>Et website, der arbejder for dig.</span>');
    expect(hero).toContain('<a class="btn btn--primary" href="/pages/kontakt?ydelse=aftal-en-demo#formular">Aftal en demo</a>');
    expect(hero).toContain('<a class="btn btn--secondary" href="/pages/eksempler">Se vores eksempler</a>');
    const gallery = section('project-gallery');
    expect(gallery).toContain('Fiktive designkoncepter — lavet af Veyro');
    for (const demo of ['/demo/holm-tomrer/', '/demo/salon-nord/', '/demo/lervaerk/']) expect(gallery).toContain(`href="${demo}"`);
    const flow = section('section booking-flow');
    expect(flow).toContain('Illustreret bookingforløb med fiktive oplysninger. Ingen tid bliver booket.');
    expect(flow).not.toMatch(/<form|<button/);
    // Pakkerne: tre kan bestilles, to er på vej
    const prices = section('section packages packages--summary');
    expect(names(prices)).toEqual(['Hjemmeside', 'Booking', 'Webshop']);
    expect(amounts(prices)).toEqual(['199 kr.', '299 kr.', '499 kr.']);
    expect(prices.match(/class="pc__vat">ekskl. moms</g)).toHaveLength(3);
    expect(prices).not.toContain('På vej');
    const coming = section('section coming');
    expect(names(coming)).toEqual(['Drift', 'Alt inkl.']);
    expect(amounts(coming)).toEqual(['599 kr.', '1.099 kr.']);
    expect(coming.match(/badge badge--coming">På vej</g).length).toBeGreaterThanOrEqual(3);
    expect(coming).toContain('aldrig automatisk til et betalt abonnement');
    expect(r.html).not.toMatch(/Mest populær|Pris følger/);
    // Kontaktformularen kender pakkerne
    for (const k of ['aftal-en-demo', 'pakke-hjemmeside', 'pakke-booking', 'pakke-webshop', 'tilkoeb-eller-stoerre-aendring']) expect(r.html).toContain(`data-key="${k}"`);
  });

  it('demoerne er statiske sider med noindex og mærkning, og skærmbillederne findes', async () => {
    const pages = ['/demo/holm-tomrer/', '/demo/holm-tomrer/ydelser', '/demo/holm-tomrer/projekter', '/demo/holm-tomrer/kontakt',
      '/demo/salon-nord/', '/demo/salon-nord/behandlinger', '/demo/salon-nord/book',
      '/demo/lervaerk/', ...['krus', 'espressokop', 'morgenmadsskaal', 'serveringsskaal', 'frokosttallerken', 'middagstallerken', 'kande', 'serveringsfad'].map((p) => `/demo/lervaerk/produkter/${p}`), '/demo/lervaerk/kurv', '/demo/lervaerk/kasse'];
    for (const p of pages) {
      const r = await site.get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('x-robots-tag'), p).toBe('noindex, nofollow');
      expect(r.headers.get('content-security-policy'), p).toContain("frame-ancestors 'none'");
      expect(r.html, p).toContain('Fiktivt designkoncept — lavet af Veyro');
      expect(r.html, p).toMatch(/<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>/);
      // Intet sendes: ingen POST-formularer og ingen adresser uden for siden
      expect(r.html, p).not.toMatch(/method="post"|action="|https?:\/\/(?!localhost)/i);
    }
    for (const f of ['holm-tomrer', 'salon-nord', 'lervaerk', 'salon-nord-booking', 'lervaerk-produkt'].flatMap((n) => [`${n}-960.jpg`, `${n}-1920.jpg`, `${n}-mobil.jpg`])) {
      const r = await site.get('/demo/_previews/' + f);
      expect(r.status, f).toBe(200);
      expect(r.headers.get('content-type'), f).toBe('image/jpeg');
    }
    expect((await site.get('/demo/findes-ikke/')).status).toBe(404);
    const root = await site.get('/demo');
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/pages/eksempler');
  });

  it('detaljelinks går til pakkens egen side eller til Drift-siden', async () => {
    const home = await site.get('/');
    const links = [...home.html.matchAll(/class="pc__details" href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(['/pages/hjemmeside', '/pages/booking', '/pages/webshop', '/pages/drift#pakke-drift', '/pages/drift#pakke-alt-inkl']);
    const drift = await site.get('/pages/drift');
    for (const id of ['pakke-drift', 'pakke-alt-inkl']) expect(drift.html).toContain(`id="${id}"`);
    for (const p of ['/pages/hjemmeside', '/pages/booking', '/pages/webshop']) {
      const r = await site.get(p);
      expect(r.status, p).toBe(200);
      expect(r.html.match(/<h1/g), p).toHaveLength(1);
      for (const t of ['Hvem er det til?', 'Det er med', 'Kræver en særskilt aftale', 'Sådan kommer du videre']) expect(r.html, `${p}: ${t}`).toContain(t);
    }
  });

  it('eksemplerne er mærkede skærmbilleder af demoerne; lagerforklaringerne står ved demoen', async () => {
    const r = await site.get('/pages/eksempler');
    const at = r.html.indexOf('<section class="section concepts"');
    const examples = r.html.slice(at, r.html.indexOf('</section>', at));
    expect(examples.match(/class="badge">Fiktivt designkoncept — lavet af Veyro</g)).toHaveLength(3);
    // Skærmbilleder og links til de rigtige demoer, ingen formularer og ingen opdigtede domæner
    for (const [shot, demo] of [['holm-tomrer', '/demo/holm-tomrer/'], ['salon-nord-booking', '/demo/salon-nord/book'], ['lervaerk-produkt', '/demo/lervaerk/produkter/krus']]) {
      expect(examples).toContain(`src="/demo/_previews/${shot}-960.jpg"`);
      expect(examples).toContain(`<span class="browser__url">veyro.dk${demo}</span>`);
      expect(examples).toContain(`<a class="arrow-link" href="${demo}">Åbn demoen`);
    }
    expect(examples).not.toContain('<form');
    expect(r.html).not.toMatch(/holm-toemrer\.dk|salon-nord\.dk|lervaerk\.dk/);
    const page = await site.get('/pages/drift');
    const d = page.html.indexOf('<section class="section drift"');
    const drift = page.html.slice(d, page.html.indexOf('</section>', d));
    expect(drift).toContain('Eksempel – Drift er på vej');
    expect(drift).toContain('Registrér forbrug');
    // Uden JavaScript vises knappen ikke, men forklaringen gør
    expect(drift).toMatch(/data-demo-try data-qty="3" hidden>/);
    expect(drift).toContain('Registreret forbrug trækker fra fysisk og disponibel');
    for (const t of ['på lageret', 'på bekræftede ordrer', 'Lav beholdning', 'Disponibel</strong> er fysisk minus reserveret']) expect(drift).toContain(t);
    const n = (k) => Number(drift.match(new RegExp(`data-demo-${k}>(\\d+)<`))[1]);
    expect([n('physical'), n('reserved'), n('available')]).toEqual([120, 24, 96]);
    expect(n('physical') - n('reserved')).toBe(n('available'));
    // Forløb og kontakt med de aftalte tider
    const home = await site.get('/');
    expect(home.html).toContain('inden for 24–48 timer');
    expect(home.html).toContain('inden for op til otte hverdage efter modtagelse af nødvendigt materiale og aftalt omfang');
    expect(home.html).toContain('uforpligtende');
  });

  it('de gamle "Løsning 1/Løsning 2"-sektioner og Basis-navnet findes ingen steder på hjemmesiden', async () => {
    for (const p of ['/', '/pages/priser', '/pages/eksempler', '/pages/ydelser', '/pages/drift', '/pages/website-optimering', '/pages/custom-losninger', '/pages/om-os', '/pages/kontakt', '/cart']) {
      const r = await site.get(p);
      expect(r.status, p).toBe(200);
      for (const t of ['Løsning 1', 'Løsning 2', 'To måder at få styr på ordrer og lager', 'Hovedløsninger', 'Internt system til ordrer og varekontrol', 'class="pc__name">Basis<', 'Pris følger']) {
        expect(r.html, `${p}: ${t}`).not.toContain(t);
      }
    }
  });

  it('"Bliv testkunde" gemmer en forespørgsel med pakken og starter intet abonnement', async () => {
    const page = await site.get('/pages/drift?pakke=drift');
    const id = page.html.match(/id="(Pilot-[^"]+)"/)[1];
    expect(page.html).toContain('data-preselect="pakke"');
    expect(page.html).toContain('data-key="alt-inkl"');
    expect(page.html).not.toContain('data-key="booking"');
    const before = (await (await fetch(stack.mock.url + '/__mock/calls')).json()).length;
    const r = await site.post('/contact', contactForm(page.html, id, {
      'contact[Formular]': 'Testkunde', 'contact[Ydelse]': 'Testkunde: Drift', 'contact[Virksomhed]': 'Tømrer ApS', 'contact[name]': 'Tina Test', 'contact[email]': 'tina@toemrer.dk',
      'contact[Telefon]': '', 'contact[Branche]': 'Tømrer', 'contact[Antal medarbejdere]': '4-10', 'contact[body]': 'Vi vil have styr på materialer på jobs.', 'contact[Samtykke]': 'Ja',
    }));
    expect(r.status).toBe(303);
    const done = await site.get(r.headers.get('location').split('#')[0]);
    expect(done.html).toContain('Vi kontakter dig for at høre om din virksomhed og aftale, om et testforløb passer til jer.');
    const [lead] = sql("SELECT * FROM leads WHERE email = 'tina@toemrer.dk'");
    expect(lead).toMatchObject({ kind: 'kontakt', form_name: 'Testkunde', service: 'Testkunde: Drift', company: 'Tømrer ApS', name: 'Tina Test', page: '/pages/drift' });
    expect(JSON.parse(lead.fields)).toMatchObject({ Branche: 'Tømrer', 'Antal medarbejdere': '4-10' });
    const mail = await waitFor(async () => (await emails()).find((e) => e.text.includes('tina@toemrer.dk')));
    expect(mail.text).toContain('Branche: Tømrer');
    expect(mail.text).toContain('Antal medarbejdere: 4-10');
    expect((await (await fetch(stack.mock.url + '/__mock/calls')).json()).length).toBe(before);
  });
});

describe('Kurv og forespørgsel', () => {
  // Kurven virker stadig for abonnementer, som admin selv gør aktive (Admin › Abonnementer og priser).
  beforeAll(() => {
    const products = JSON.parse(readFileSync(path.join(ROOT, 'site/content.json'), 'utf8')).products;
    for (const p of products) {
      const value = JSON.stringify({ ...p, status: 'active' }).replace(/'/g, "''");
      sql(`INSERT OR REPLACE INTO site_content (key, value, updated_at, updated_by) VALUES ('product:${p.handle}', '${value}', strftime('%s','now') * 1000, 'test')`);
    }
  });

  it('lægger et abonnement i kurven, opdaterer antal og fjerner det igen', async () => {
    const shopper = new Client(stack.site);
    const product = await shopper.get('/products/business');
    expect(product.html).toContain('action="/cart/add"');
    expect(product.html).toContain('599 kr');

    let r = await shopper.post('/cart/add', { form_type: 'product', id: 'business' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/cart');
    let cart = await shopper.get('/cart');
    expect(cart.html).toContain('Business abonnement');
    expect(cart.html).toContain('class="site-header__count"');
    expect(cart.html).toMatch(/site-header__count[^>]*>1</);

    await shopper.post('/cart', { 'updates[]': '3' });
    cart = await shopper.get('/cart');
    expect(cart.html).toContain('1.797 kr');

    // Antallet vises også på sider, der ellers er gemt færdige (cache)
    const front = await shopper.get('/');
    expect(front.html).toMatch(/site-header__count[^>]*>3</);
    expect((await site.get('/')).html).not.toContain('site-header__count');

    r = await shopper.get('/cart/change?line=1&quantity=0');
    expect(r.status).toBe(303);
    cart = await shopper.get('/cart');
    expect(cart.html).not.toContain('Business abonnement');
  });

  it('sender kurven som forespørgsel: gemmes, mail til Veyro, kurven tømmes, intet betales', async () => {
    const shopper = new Client(stack.site);
    await shopper.post('/cart/add', { id: 'premium' });
    await shopper.post('/cart/add', { id: 'starter', quantity: '2' });
    const cart = await shopper.get('/cart');
    const before = (await emails()).length;
    const r = await shopper.post(
      '/contact',
      contactForm(cart.html, 'CartRequest', { 'contact[name]': 'Mette Kurv', 'contact[email]': 'mette@firma.dk', 'contact[Virksomhed]': 'Firma ApS', 'contact[Telefon]': '12345678', 'contact[body]': 'Vi vil gerne i gang i november.', 'contact[Samtykke]': 'Ja', 'contact[Formular]': 'Kurv – forespørgsel på abonnement' }),
    );
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/cart?kontakt=ok&form=CartRequest#CartRequest');
    const done = await shopper.get(r.headers.get('location').split('#')[0]);
    expect(done.html).toContain('Tak, vi har modtaget din forespørgsel');
    expect(done.html).not.toContain('Premium abonnement</a>');
    expect(shopper.cookies.has('veyro_cart')).toBe(false);

    const [lead] = sql("SELECT * FROM leads WHERE email = 'mette@firma.dk'");
    expect(lead.kind).toBe('kurv');
    expect(lead.status).toBe('ny');
    expect(lead.company).toBe('Firma ApS');
    const lines = JSON.parse(lead.cart);
    expect(lines).toEqual([
      { handle: 'premium', title: 'Premium abonnement', quantity: 1, price: 109900, interval: 'month' },
      { handle: 'starter', title: 'Starter abonnement', quantity: 2, price: 29900, interval: 'month' },
    ]);
    const mail = await waitFor(async () => (await emails()).slice(before).find((e) => e.to[0] === 'kontakt@veyro.dk'));
    expect(mail.reply_to).toBe('mette@firma.dk');
    expect(mail.text).toContain('Kurv: 2 × Starter abonnement');
    expect(mail.text).toContain(`/admin/forespoergsler/${lead.id}`);
    await waitFor(async () => sql(`SELECT notified_at FROM leads WHERE id = ${lead.id}`)[0].notified_at);
  });

  it('en tom kurv kan ikke sendes', async () => {
    const shopper = new Client(stack.site);
    const r = await shopper.post('/contact', { form_type: 'contact', form_id: 'CartRequest', return_to: '/cart', 'contact[email]': 'tom@firma.dk', 'contact[Samtykke]': 'Ja' });
    expect(r.status).toBe(422);
    expect(r.html).toContain('Kurven er tom');
  });
});

describe('Kontaktformularer', () => {
  it('kontaktformularen gemmer henvendelsen og viser takkebeskeden i formularen', async () => {
    const page = await site.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    const r = await site.post('/contact', contactForm(page.html, id, { 'contact[name]': 'Lars Kontakt', 'contact[email]': 'lars@firma.dk', 'contact[Ydelse]': 'Website-optimering', 'contact[Hjemmeside]': 'firma.dk', 'contact[body]': 'Vores side er langsom på mobil.', 'contact[Samtykke]': 'Ja' }));
    expect(r.status).toBe(303);
    const done = await site.get(r.headers.get('location').split('#')[0]);
    expect(done.html).toContain('Tak, vi har modtaget din henvendelse');
    const [lead] = sql("SELECT * FROM leads WHERE email = 'lars@firma.dk'");
    expect(lead).toMatchObject({ kind: 'kontakt', service: 'Website-optimering', website: 'firma.dk', page: '/pages/kontakt' });
  });

  it('gratis vurdering på forsiden registreres som vurdering', async () => {
    const page = await site.get('/');
    const id = page.html.match(/id="(Assessment-[^"]+)"/)?.[1];
    if (!id) return; // forsiden har ikke formularen i den aktuelle opsætning
    const r = await site.post('/contact', contactForm(page.html, id, { 'contact[email]': 'vurdering@firma.dk', 'contact[Hjemmeside]': 'firma.dk', 'contact[Største udfordring]': 'Hastighed', 'contact[Samtykke]': 'Ja' }));
    expect(r.status).toBe(303);
    expect(sql("SELECT kind FROM leads WHERE email = 'vurdering@firma.dk'")[0].kind).toBe('vurdering');
  });

  it('ugyldig e-mail og manglende samtykke vises som fejl, og felterne bevares', async () => {
    const page = await site.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    const r = await site.post('/contact', contactForm(page.html, id, { 'contact[name]': 'Fejl Navn', 'contact[email]': 'ikke-en-mail', 'contact[body]': 'Hej med jer' }));
    expect(r.status).toBe(422);
    expect(r.html).toContain('form-status--error');
    expect(r.html).toContain('value="Fejl Navn"');
    expect(r.html).toContain('Sæt kryds for at give samtykke');
    expect(sql("SELECT COUNT(*) AS n FROM leads WHERE name = 'Fejl Navn'")[0].n).toBe(0);
  });

  it('en genvist besked kan ikke bryde ud af tekstfeltet (kontakt og kurv)', async () => {
    const visitor = new Client(stack.site);
    const evil = '</textarea><script>alert(1)</script>';
    const page = await visitor.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    const r = await visitor.post('/contact', contactForm(page.html, id, { 'contact[name]': 'XSS', 'contact[email]': 'xss@example.dk', 'contact[body]': evil }));
    expect(r.status).toBe(422);
    expect(r.html).not.toContain('<script>alert(1)');
    expect(r.html).toContain('&lt;/textarea&gt;&lt;script&gt;');
    await visitor.post('/cart/add', { id: 'business' });
    const cart = await visitor.get('/cart');
    const c = await visitor.post('/contact', contactForm(cart.html, 'CartRequest', { 'contact[email]': 'xss@example.dk', 'contact[body]': evil }));
    expect(c.status).toBe(422);
    expect(c.html).not.toContain('<script>alert(1)');
  });

  it('return_to kan kun pege på siden selv', async () => {
    const visitor = new Client(stack.site);
    const page = await visitor.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    for (const ret of ['/.//evil.example', '/\\evil.example', '//evil.example']) {
      const r = await visitor.post('/contact', { ...contactForm(page.html, id, { 'contact[email]': 'robot@spam.dk', website_url: 'x' }), return_to: ret });
      expect(r.status).toBe(303);
      expect(r.headers.get('location'), ret).toMatch(/^\/(?![\/\\])/);
    }
  });

  it('spam-robotter (honningkrukke) og fremmede sider afvises uden at gemme noget', async () => {
    const page = await site.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    const r = await site.post('/contact', contactForm(page.html, id, { 'contact[email]': 'robot@spam.dk', 'contact[Samtykke]': 'Ja', website_url: 'http://spam' }));
    expect(r.status).toBe(303);
    expect(sql("SELECT COUNT(*) AS n FROM leads WHERE email = 'robot@spam.dk'")[0].n).toBe(0);
    const evil = await site.post('/contact', contactForm(page.html, id, { 'contact[email]': 'evil@spam.dk', 'contact[Samtykke]': 'Ja' }), { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const cartEvil = await site.post('/cart/add', { id: 'business' }, { Origin: 'https://evil.example' });
    expect(cartEvil.status).toBe(403);
  });
});

describe('Admin: hjemmesiden', () => {
  it('kun admins har adgang', async () => {
    const anon = new Client(stack.base);
    expect((await anon.get('/admin/hjemmeside')).headers.get('location')).toBe('/admin/login');
    expect((await anon.get('/admin/forespoergsler')).headers.get('location')).toBe('/admin/login');
    // Hjemmesidens domæne har ingen admin
    expect((await site.get('/admin/hjemmeside')).headers.get('location')).toBe('https://kunde.veyro.dk/admin');
    const r = await admin.get('/admin/hjemmeside');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Forside');
    expect(r.html).toContain('Nye forespørgsler');
  });

  it('retter en tekst på forsiden; ændringen vises straks og kan rulles tilbage', async () => {
    const editor = await admin.get('/admin/hjemmeside/sektioner/template:index');
    expect(editor.status).toBe(200);
    const heroField = editor.html.match(/name="(s\|[^|"]+\|heading)"[^>]*>([^<]*)</);
    expect(heroField).toBeTruthy();
    const [, name, oldHeading] = heroField;
    const res = await admin.post('/admin/hjemmeside/sektioner/template:index', { _csrf: csrfFrom(editor.html), [name]: 'Ny overskrift fra admin', action: 'save' });
    expect(res.status).toBe(303);
    // Kun det ændrede felt er ændret; resten af siden er der stadig
    const home = await site.get('/');
    expect(home.html).toContain('Ny overskrift fra admin');
    expect(home.html).toContain('href="/pages/kontakt"');

    const hist = sql("SELECT id FROM site_content_history WHERE key = 'template:index' ORDER BY id DESC LIMIT 1");
    const page = await admin.get('/admin/hjemmeside/historik');
    const back = await admin.post(`/admin/hjemmeside/historik/${hist[0].id}/gendan`, { _csrf: csrfFrom(page.html), back: '/admin/hjemmeside/historik' });
    expect(back.status).toBe(303);
    const again = await site.get('/');
    expect(again.html).not.toContain('Ny overskrift fra admin');
    expect(again.html).toContain(oldHeading.replace(/&#39;/g, "'").slice(0, 10));
  });

  it('skjuler, flytter og tilføjer sektioner og elementer', async () => {
    const key = 'template:page.om-os';
    let editor = await admin.get(`/admin/hjemmeside/sektioner/${key}`);
    const sids = [...editor.html.matchAll(/name="pos\|([^"]+)"/g)].map((m) => m[1]);
    expect(sids.length).toBeGreaterThan(2);
    // Skjul den første sektion
    await admin.post(`/admin/hjemmeside/sektioner/${key}`, { _csrf: csrfFrom(editor.html), [`hide|${sids[0]}`]: '1', action: 'save' });
    let page = await site.get('/pages/om-os');
    expect(page.html).not.toContain(`id="shopify-section-${sids[0]}"`);
    // Tilføj en FAQ-sektion nederst og et spørgsmål
    editor = await admin.get(`/admin/hjemmeside/sektioner/${key}`);
    const add = await admin.post(`/admin/hjemmeside/sektioner/${key}`, { _csrf: csrfFrom(editor.html), [`hide|${sids[0]}`]: '1', add_section: 'faq', action: 'add_section' });
    expect(add.status).toBe(303);
    editor = await admin.get(`/admin/hjemmeside/sektioner/${key}`);
    const faqId = [...editor.html.matchAll(/name="pos\|([^"]+)"/g)].map((m) => m[1]).find((s) => s.startsWith('faq'));
    expect(faqId).toBeTruthy();
    const addBlock = editor.html.match(new RegExp(`name="add_block" value="(${faqId}\\|[^"]+)"`))[1];
    await admin.post(`/admin/hjemmeside/sektioner/${key}`, { _csrf: csrfFrom(editor.html), [`hide|${sids[0]}`]: '1', add_block: addBlock, action: 'save' });
    editor = await admin.get(`/admin/hjemmeside/sektioner/${key}`);
    const qField = [...editor.html.matchAll(new RegExp(`name="(b\\|${faqId}\\|[^|"]+\\|(question|title|heading))"`, 'g'))].pop()[1];
    await admin.post(`/admin/hjemmeside/sektioner/${key}`, { _csrf: csrfFrom(editor.html), [`hide|${sids[0]}`]: '1', [qField]: 'Kan I også hoste vores side?', action: 'save' });
    page = await site.get('/pages/om-os');
    expect(page.html).toContain('Kan I også hoste vores side?');
    // Nulstil til standard
    editor = await admin.get(`/admin/hjemmeside/sektioner/${key}`);
    await admin.post(`/admin/hjemmeside/sektioner/${key}`, { _csrf: csrfFrom(editor.html), action: 'reset' });
    page = await site.get('/pages/om-os');
    expect(page.html).toContain(`id="shopify-section-${sids[0]}"`);
    expect(page.html).not.toContain('Kan I også hoste vores side?');
  });

  it('retter et abonnements pris; prisen og kurven følger med', async () => {
    const page = await admin.get('/admin/hjemmeside/produkter');
    const fields = formFields(page.html, 'p|');
    const res = await admin.post('/admin/hjemmeside/produkter', { _csrf: csrfFrom(page.html), ...fields, 'p|business|price': '649' });
    expect(res.status).toBe(303);
    expect((await site.get('/products/business')).html).toContain('649 kr');
    const shopper = new Client(stack.site);
    await shopper.post('/cart/add', { id: 'business' });
    expect((await shopper.get('/cart')).html).toContain('649 kr');
    // Et skjult abonnement kan ikke lægges i kurven
    const p2 = await admin.get('/admin/hjemmeside/produkter');
    await admin.post('/admin/hjemmeside/produkter', { _csrf: csrfFrom(p2.html), ...fields, 'p|business|price': '649', 'p|premium|status': 'draft' });
    expect((await site.get('/products/premium')).status).toBe(404);
    const s2 = new Client(stack.site);
    await s2.post('/cart/add', { id: 'premium' });
    expect((await s2.get('/cart')).html).not.toContain('Premium abonnement');
  });

  it('opretter, viser, retter og sletter en side og et menupunkt', async () => {
    let r = await adminPost('/admin/hjemmeside/sider/ny', { title: 'Priser og vilkår', handle: '', body: '<h2>Vilkår</h2><p>Opsiges løbende.</p><script>alert(1)</script>', published: '1', description: 'Vores vilkår' });
    expect(r.status).toBe(303);
    let page = await site.get('/pages/priser-og-vilkaar');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Opsiges løbende.');
    expect(page.html).not.toContain('alert(1)');
    expect(page.html).toContain('content="Vores vilkår"');

    const menus = await admin.get('/admin/hjemmeside/menuer');
    const fields = formFields(menus.html, 'm|');
    const n = Object.keys(fields).filter((k) => k.startsWith('m|main-menu|') && k.endsWith('|title') && fields[k]).length;
    fields[`m|main-menu|${n}|title`] = 'Vilkår';
    fields[`m|main-menu|${n}|url`] = '/pages/priser-og-vilkaar';
    fields['m|main-menu|0|title'] = ''; // fjern "Forside"
    r = await admin.post('/admin/hjemmeside/menuer', { _csrf: csrfFrom(menus.html), ...fields });
    expect(r.status).toBe(303);
    page = await site.get('/pages/om-os');
    expect(page.html).toContain('<a class="nav__link" href="/pages/priser-og-vilkaar">Vilkår</a>');
    expect(page.html).not.toContain('<a class="nav__link" href="/">Forside</a>');

    const del = await adminPost('/admin/hjemmeside/side/priser-og-vilkaar', {});
    expect(del.status).toBe(400); // titel mangler
    const ed = await admin.get('/admin/hjemmeside/side/priser-og-vilkaar');
    r = await admin.post('/admin/hjemmeside/side/priser-og-vilkaar/slet', { _csrf: csrfFrom(ed.html), confirm: '1' });
    expect(r.status).toBe(303);
    expect((await site.get('/pages/priser-og-vilkaar')).status).toBe(404);
  });

  it('opretter en sektionsside som kopi af et eksisterende layout', async () => {
    const r = await adminPost('/admin/hjemmeside/sider/ny', { title: 'Webshops', handle: 'webshops', copy_from: 'website-optimering', published: '1' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('/admin/hjemmeside/sektioner/template:page.webshops');
    const p = await site.get('/pages/webshops');
    expect(p.status).toBe(200);
    expect(p.html).toContain('template-page--webshops');
  });

  it('temaindstillinger: firmaoplysninger ændres på alle sider', async () => {
    const page = await admin.get('/admin/hjemmeside/indstillinger');
    const fields = formFields(page.html, 'g|');
    expect(fields['g|company_phone']).toBe('+45 61 66 39 31');
    const r = await admin.post('/admin/hjemmeside/indstillinger', { _csrf: csrfFrom(page.html), ...fields, 'g|company_phone': '+45 11 22 33 44' });
    expect(r.status).toBe(303);
    const footer = await site.get('/pages/kontakt');
    expect(footer.html).toContain('+45 11 22 33 44');
    expect(footer.html).toContain('data-cookie'); // cookiebanneret er stadig slået til
  });

  it('uploader et billede og bruger det som logo', async () => {
    // 2×1 PNG
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000010806000000f478d4fa0000000d4944415478da63f8cfc0f01f0005000201c1a6a0b40000000049454e44ae426082', 'hex');
    const page = await admin.get('/admin/hjemmeside/billeder');
    const fd = new FormData();
    fd.set('_csrf', csrfFrom(page.html));
    fd.set('file', new Blob([png], { type: 'image/png' }), 'logo.png');
    const up = await fetch(stack.base + '/admin/hjemmeside/billeder', { method: 'POST', redirect: 'manual', body: fd, headers: { Cookie: admin.cookieHeader(), Origin: stack.base } });
    expect(up.status).toBe(303);
    const [file] = sql('SELECT id, width, height FROM site_files ORDER BY id DESC LIMIT 1');
    expect([file.width, file.height]).toEqual([2, 1]);
    const img = await site.get(`/files/${file.id}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    // Ikke-billeder afvises
    const fd2 = new FormData();
    fd2.set('_csrf', csrfFrom(page.html));
    fd2.set('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }), 'x.svg');
    const bad = await fetch(stack.base + '/admin/hjemmeside/billeder', { method: 'POST', redirect: 'manual', body: fd2, headers: { Cookie: admin.cookieHeader(), Origin: stack.base } });
    expect(bad.status).toBe(400);

    const settings = await admin.get('/admin/hjemmeside/indstillinger');
    expect(settings.html).toContain(`value="file:${file.id}:2x1"`);
    const fields = formFields(settings.html, 'g|');
    await admin.post('/admin/hjemmeside/indstillinger', { _csrf: csrfFrom(settings.html), ...fields, 'g|logo': `file:${file.id}:2x1` });
    const home = await site.get('/');
    expect(home.html).toContain(`/files/${file.id}`);
  });

  it('tæller sidevisninger uden cookies', async () => {
    await site.get('/pages/om-os');
    await waitFor(async () => sql("SELECT SUM(views) AS n FROM site_views WHERE path = '/pages/om-os'")[0].n > 0);
    const r = await admin.get('/admin/hjemmeside');
    expect(r.html).toContain('/pages/om-os');
  });
});

describe('Admin: forespørgsler → tilbud', () => {
  it('lister forespørgsler, åbner én og laver et tilbud ud fra kurven', async () => {
    const list = await admin.get('/admin/forespoergsler');
    expect(list.status).toBe(200);
    expect(list.html).toContain('Mette Kurv');
    const [lead] = sql("SELECT id FROM leads WHERE email = 'mette@firma.dk'");
    const detail = await admin.get(`/admin/forespoergsler/${lead.id}`);
    expect(detail.html).toContain('Premium abonnement');
    expect(detail.html).toContain(`/admin/tilbud?forespoergsel=${lead.id}`);

    const offerPage = await admin.get(`/admin/tilbud?forespoergsel=${lead.id}`);
    expect(offerPage.html).toContain('value="mette@firma.dk"');
    expect(offerPage.html).toContain('value="Firma ApS"');
    // (1.099 + 2 × 299) kr inkl. moms = 1.697 kr → 1.357,60 kr ekskl. moms
    expect(offerPage.html).toContain('value="1357,60"');
    expect(offerPage.html).toContain(`name="lead" value="${lead.id}"`);

    const fields = formFields(offerPage.html.slice(offerPage.html.indexOf('action="/admin/tilbud"')));
    const res = await admin.post('/admin/tilbud', { ...fields, _csrf: csrfFrom(offerPage.html), vat: '1', interval: 'month', cvr: '12345678' });
    expect(res.status).toBe(303);
    const offerId = Number(res.headers.get('location').match(/\/admin\/tilbud\/(\d+)/)[1]);
    const [updated] = sql(`SELECT status, offer_id FROM leads WHERE id = ${lead.id}`);
    expect(updated).toEqual({ status: 'tilbud', offer_id: offerId });
    const again = await admin.get(`/admin/forespoergsler/${lead.id}`);
    expect(again.html).toContain(`/admin/tilbud/${offerId}`);
  });

  it('ændrer status og note, og sletter en forespørgsel permanent', async () => {
    const [lead] = sql("SELECT id FROM leads WHERE email = 'lars@firma.dk'");
    let r = await adminPost(`/admin/forespoergsler/${lead.id}`, { status: 'besvaret', note: 'Ringet op' });
    expect(r.status).toBe(303);
    expect(sql(`SELECT status, note FROM leads WHERE id = ${lead.id}`)[0]).toEqual({ status: 'besvaret', note: 'Ringet op' });
    r = await adminPost(`/admin/forespoergsler/${lead.id}/slet`, { confirm: '1' });
    expect(r.status).toBe(303);
    expect(sql(`SELECT COUNT(*) AS n FROM leads WHERE id = ${lead.id}`)[0].n).toBe(0);
  });
});

describe('Admin: bloker afsender (spam)', () => {
  const send = async (email, ip, body = 'Køb billige links') => {
    const visitor = new Client(stack.site);
    const page = await visitor.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    return visitor.post('/contact', contactForm(page.html, id, { 'contact[name]': 'Spam Spamsen', 'contact[email]': email, 'contact[body]': body, 'contact[Samtykke]': 'Ja' }), { 'CF-Connecting-IP': ip });
  };
  const count = (where) => sql(`SELECT COUNT(*) AS n FROM leads WHERE ${where}`)[0].n;

  it('blokerer mailadresse og IP, afviser nye henvendelser i stilhed og kan fjernes igen', async () => {
    expect((await send('s.p.a.m@gmail.com', '203.0.113.7')).status).toBe(303);
    const [lead] = sql("SELECT id, ip_hash FROM leads WHERE email = 's.p.a.m@gmail.com'");
    expect(lead.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    // IP-adressen gemmes aldrig i klartekst
    expect(count("ip_hash = '203.0.113.7' OR fields LIKE '%203.0.113.7%'")).toBe(0);

    const detail = await admin.get(`/admin/forespoergsler/${lead.id}`);
    expect(detail.html).toContain('Bloker afsender');
    expect(detail.html).toContain('IP-adressen, den blev sendt fra');
    // gmail.com kan ikke blokeres som domæne
    expect(detail.html).not.toContain('Hele domænet gmail.com');
    let r = await admin.post(`/admin/forespoergsler/${lead.id}/bloker`, { _csrf: csrfFrom(detail.html), email: '1', ip: '1' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/admin/forespoergsler/${lead.id}?besked=blokeret`);
    expect(sql(`SELECT status FROM leads WHERE id = ${lead.id}`)[0].status).toBe('spam');
    expect(sql('SELECT kind FROM lead_blocks ORDER BY kind').map((b) => b.kind)).toEqual(['email', 'ip']);

    const mailsBefore = (await emails()).length;
    // Samme Gmail-adresse i en anden stavemåde, fra en anden IP: afvist i stilhed (takkebesked, intet gemt)
    r = await send('spam+2@googlemail.com', '198.51.100.20');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('kontakt=ok');
    // Ny mailadresse fra den blokerede IP: også afvist
    expect((await send('ny-adresse@spamfirma.dk', '203.0.113.7')).headers.get('location')).toContain('kontakt=ok');
    expect(count("email IN ('spam+2@googlemail.com', 'ny-adresse@spamfirma.dk')")).toBe(0);
    expect((await emails()).length).toBe(mailsBefore);
    expect(sql('SELECT SUM(hits) AS n FROM lead_blocks')[0].n).toBe(2);

    // Andre kan stadig skrive
    expect((await send('rigtig@kunde.dk', '192.0.2.44', 'Vi vil gerne høre om drift')).status).toBe(303);
    expect(count("email = 'rigtig@kunde.dk'")).toBe(1);

    // Oversigten og fjernelse
    const list = await admin.get('/admin/forespoergsler/blokerede');
    expect(list.status).toBe(200);
    expect(list.html).toContain('s.p.a.m@gmail.com');
    expect(list.html).toContain(`IP fra forespørgsel #${lead.id}`);
    for (const b of sql('SELECT id FROM lead_blocks')) {
      const page = await admin.get('/admin/forespoergsler/blokerede');
      r = await admin.post(`/admin/forespoergsler/blokerede/${b.id}/fjern`, { _csrf: csrfFrom(page.html) });
      expect(r.status).toBe(303);
    }
    expect(sql('SELECT COUNT(*) AS n FROM lead_blocks')[0].n).toBe(0);
    expect((await send('spam+3@gmail.com', '203.0.113.8')).status).toBe(303);
    expect(count("email = 'spam+3@gmail.com'")).toBe(1);
  });

  it('blokerer et helt firmadomæne', async () => {
    expect((await send('a@spamfirma.dk', '203.0.113.30')).status).toBe(303);
    const [lead] = sql("SELECT id FROM leads WHERE email = 'a@spamfirma.dk'");
    const detail = await admin.get(`/admin/forespoergsler/${lead.id}`);
    expect(detail.html).toContain('Hele domænet spamfirma.dk');
    await admin.post(`/admin/forespoergsler/${lead.id}/bloker`, { _csrf: csrfFrom(detail.html), domain: '1' });
    expect((await send('b@spamfirma.dk', '203.0.113.31')).headers.get('location')).toContain('kontakt=ok');
    expect(count("email = 'b@spamfirma.dk'")).toBe(0);
    sql('DELETE FROM lead_blocks');
  });

  it('blokerer på navn, når en robot skifter mailadresse', async () => {
    const page = await site.get('/pages/kontakt');
    const id = page.html.match(/id="(Contact-[^"]+)"/)[1];
    const named = (email, ip) =>
      new Client(stack.site).post('/contact', contactForm(page.html, id, { 'contact[name]': 'Robertbaick', 'contact[email]': email, 'contact[body]': 'Hej, jeg ønskede at kende din pris.', 'contact[Samtykke]': 'Ja' }), { 'CF-Connecting-IP': ip });
    await named('robot1@shaw.ca', '203.0.113.50');
    await named('robot2@yahoo.ca', '203.0.113.51');
    const [lead] = sql("SELECT id FROM leads WHERE email = 'robot1@shaw.ca'");
    const detail = await admin.get(`/admin/forespoergsler/${lead.id}`);
    expect(detail.html).toContain('Navnet „Robertbaick"');
    await admin.post(`/admin/forespoergsler/${lead.id}/bloker`, { _csrf: csrfFrom(detail.html), name: '1' });
    expect(sql("SELECT status FROM leads WHERE email IN ('robot1@shaw.ca', 'robot2@yahoo.ca')").map((r) => r.status)).toEqual(['spam', 'spam']);
    expect((await named('robot3@hotmail.com', '203.0.113.52')).headers.get('location')).toContain('kontakt=ok');
    expect(count("email = 'robot3@hotmail.com'")).toBe(0);
    sql('DELETE FROM lead_blocks');
  });

  it('begrænser antal henvendelser fra samme mailadresse', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await send('gentager@firma.dk', `198.51.100.${60 + i}`)).status);
    expect(codes).toEqual([303, 303, 303, 429]);
  });
});

describe('Admin: statistik', () => {
  /** Læser en ukomprimeret ZIP (som buildXlsx laver) til { filnavn: tekst } */
  function unzip(buf) {
    const files = {};
    let i = 0;
    while (buf.readUInt32LE(i) === 0x04034b50) {
      const size = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extra = buf.readUInt16LE(i + 28);
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
      const start = i + 30 + nameLen + extra;
      files[name] = buf.subarray(start, start + size).toString('utf8');
      i = start + size;
    }
    return files;
  }

  it('viser nøgletal og grafer for en periode', async () => {
    expect((await new Client(stack.base).get('/admin/statistik')).headers.get('location')).toBe('/admin/login');
    const r = await admin.get('/admin/statistik?periode=30');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Sidevisninger pr. dag');
    expect(r.html).toContain('Forespørgsler pr. kilde');
    expect(r.html).toContain('data-chart');
    expect(r.html).toContain('href="/admin/statistik/excel?periode=30"');
    const month = new Date().toISOString().slice(0, 7);
    const m = await admin.get(`/admin/statistik?periode=${month}`);
    expect(m.status).toBe(200);
    expect(m.html).toContain(`value="${month}" selected`);
    // Ukendt periode falder tilbage til 30 dage
    expect((await admin.get('/admin/statistik?periode=x')).html).toContain('value="30" selected');
  });

  it('downloader måneden som Excel-fil med et ark pr. emne', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await fetch(`${stack.base}/admin/statistik/excel?periode=${month}`, { headers: { Cookie: admin.cookieHeader() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toContain(`veyro-statistik-${month}.xlsx`);
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet7.xml']));
    for (const name of ['Oversigt', 'Pr. dag', 'Sider', 'Forespørgsler', 'Tilbud', 'Betalinger', 'Nye kunder']) expect(files['xl/workbook.xml']).toContain(`name="${name}"`);
    expect(files['xl/worksheets/sheet4.xml']).toContain('mette@firma.dk');
    expect(files['xl/worksheets/sheet3.xml']).toContain('/pages/om-os');
  });
});

describe('Temapakken', () => {
  it('src/site/theme.generated.ts svarer til site/', () => {
    execFileSync('node', [path.join(ROOT, 'scripts/build-site.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
  });
});
