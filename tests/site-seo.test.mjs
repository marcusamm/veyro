import { beforeAll, describe, expect, it } from 'vitest';
import { loadSite } from '../src/site/content';
import { businessPostalAddress, renderSitePage } from '../src/site/render';
import { warmUp } from '../src/site/engine';

let site;
const origin = 'https://veyro.dk';
const schemas = html => [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
const render = (language, handle) => renderSitePage(site, {
  type: handle ? 'page' : 'index', language, path: handle ? `/pages/${handle}` : '/',
  host: language === 'sv' ? 'veyro.se' : 'veyro.dk', canonicalOrigin: origin, cart: [],
  page: handle ? site.pages.find(p => p.handle === handle) : undefined,
});

beforeAll(async () => {
  warmUp();
  site = await loadSite({ prepare: () => ({ all: async () => ({ results: [] }) }) });
});

describe('Search metadata and multilingual hosting page', () => {
  it('keeps saved page content while inheriting new SEO defaults, with an explicit opt-out', async () => {
    const page = site.pages.find(p => p.handle === 'hjemmeside');
    const { seo_title, ...oldPage } = page;
    for (const saved of [{ ...oldPage, title: 'Min egen overskrift' }, { ...oldPage, seo_title: '' }]) {
      const loaded = await loadSite({ prepare: () => ({ all: async () => ({ results: [{ key: 'page:hjemmeside', value: JSON.stringify(saved), updated_at: 1 }] }) }) });
      expect(loaded.pages.find(p => p.handle === 'hjemmeside')).toMatchObject({ ...saved, seo_title: saved.seo_title ?? seo_title });
    }
  });

  it.each(['da', 'en', 'sv'])('uses one stable website and business identity in %s', language => {
    const html = render(language);
    const data = schemas(html);
    const website = data.find(d => d['@type'] === 'WebSite');
    const business = data.find(d => d['@type'] === 'ProfessionalService');
    const publicOrigin = language === 'sv' ? 'https://veyro.se' : origin;
    expect(website).toMatchObject({ '@id': `${publicOrigin}/#website`, name: 'Veyro', url: `${publicOrigin}/`, publisher: { '@id': `${origin}/#organization` } });
    expect(business).toMatchObject({ '@id': `${origin}/#organization`, url: `${origin}/` });
    expect(business.address).toMatchObject({ streetAddress: 'Albert Ibsensvej 28, 2. tv', postalCode: '4200', addressLocality: 'Slagelse', addressCountry: 'DK' });
    expect(business.identifier).toMatchObject({ propertyID: 'CVR', value: '46857569' });
    expect(business.sameAs).toContain('https://www.instagram.com/veyro.dk/');
    expect(business.sameAs).toContain('https://dk.trustpilot.com/review/veyro.dk');
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    expect(title).toMatch(/^Veyro – /);
    expect(html).toContain(`<meta property="og:title" content="${title}">`);
    const description = html.match(/<meta name="description" content="([^"]+)"/)[1];
    expect(html).toContain(`<meta property="og:description" content="${description}">`);
    if (language !== 'da') expect(description).not.toContain('bygger og driver');
  });

  it.each(['da', 'en', 'sv'])('renders useful hosting content and matching breadcrumb URLs in %s', language => {
    const html = render(language, 'hosting');
    const prefix = language === 'en' ? '/en' : '';
    const publicOrigin = language === 'sv' ? 'https://veyro.se' : origin;
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/Liquid error|MISSING:/);
    expect(html).toContain(`<link rel="canonical" href="${publicOrigin}${prefix}/pages/hosting">`);
    expect(html).toContain(`href="${prefix}/pages/kontakt?ydelse=hosting-og-vedligeholdelse#formular"`);
    expect(schemas(html).find(d => d['@type'] === 'BreadcrumbList').itemListElement.map(i => i.item)).toEqual([
      `${publicOrigin}${prefix}/`, `${publicOrigin}${prefix}/pages/ydelser`, `${publicOrigin}${prefix}/pages/hosting`,
    ]);
    expect(schemas(html).find(d => d['@type'] === 'FAQPage').mainEntity.length).toBeGreaterThanOrEqual(4);
    if (language !== 'da') expect(html).not.toContain('Hosting og vedligeholdelse løser forskellige opgaver');
  });

  it.each(['da', 'en', 'sv'])('connects real services to the same business without inventing prices in %s', language => {
    for (const handle of ['hjemmeside', 'hosting', 'booking', 'webshop', 'website-optimering', 'custom-losninger']) {
      const data = schemas(render(language, handle));
      const prefix = language === 'en' ? '/en' : '';
      const publicOrigin = language === 'sv' ? 'https://veyro.se' : origin;
      const service = data.find(d => d['@type'] === 'Service');
      expect(service).toMatchObject({
        url: `${publicOrigin}${prefix}/pages/${handle}`,
        provider: { '@id': `${origin}/#organization` },
      });
      expect(data.find(d => d['@id'] === service.provider['@id']).name).toBe('Veyro');
      expect(service.description).toBeTruthy();
      expect(service).not.toHaveProperty('offers');
      expect(data.some(d => d['@type'] === 'WebSite')).toBe(false);
    }
    expect(schemas(render(language, 'om-os')).some(d => d['@type'] === 'Service')).toBe(false);
  });

  it('keeps edited addresses authoritative and omits empty or placeholder addresses', () => {
    expect(businessPostalAddress('Anden vej 10, 8000 Aarhus C')).toMatchObject({ streetAddress: 'Anden vej 10', postalCode: '8000', addressLocality: 'Aarhus C' });
    expect(businessPostalAddress('Ny adresse')).toEqual({ '@type': 'PostalAddress', streetAddress: 'Ny adresse', addressCountry: 'DK' });
    for (const value of ['', ' ', null, '[ADRESSE]']) expect(businessPostalAddress(value)).toBeNull();
  });

  it('separates and escapes search titles without changing visible page headings', () => {
    const page = site.pages.find(p => p.handle === 'hjemmeside');
    const previous = page.seo_title;
    page.seo_title = 'Website <test> & hosting';
    const html = render('da', page.handle);
    page.seo_title = previous;
    expect(html).toContain('<title>Website &lt;test&gt; &amp; hosting – Veyro</title>');
    expect(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)[1]).not.toContain('Website &lt;test&gt;');
  });

  it.each([
    ['da', 'Webbureau i Slagelse – hjemmesider og hosting'],
    ['en', 'Web studio in Slagelse – websites and hosting'],
    ['sv', 'Webbyrå i Slagelse – hemsidor och webbhotell'],
  ])('gives the about page a descriptive title with the brand once in %s', (language, expected) => {
    const html = render(language, 'om-os');
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    expect(title).toBe(`${expected} – Veyro`);
    expect(title.match(/Veyro/g)).toHaveLength(1);
    expect(html).toContain(`<meta property="og:title" content="${title}">`);
  });

  it.each([
    ['da', 'Nej. Vi optimerer den, hvor den ligger.', 'Læs om hosting og vedligeholdelse'],
    ['en', 'No. We optimise it where it is hosted.', 'Read about hosting and maintenance'],
    ['sv', 'Nej. Vi optimerar den där den ligger.', 'Läs om webbhotell och underhåll'],
  ])('links optimisation to hosting within the translated FAQ in %s', (language, answer, label) => {
    const html = render(language, 'website-optimering');
    const prefix = language === 'en' ? '/en' : '';
    expect(html).toContain(`<p>${answer} <a href="${prefix}/pages/hosting">${label}</a>`);
  });
});
