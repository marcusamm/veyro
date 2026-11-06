import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSite } from '../src/site/content';
import { warmUp } from '../src/site/engine';
import { canonicalLanguageUrl, isSwedishHost, localizedPath, localizeLinks, requestLanguage } from '../src/site/localization';
import { renderSitePage } from '../src/site/render';

let site;
beforeAll(async () => {
  warmUp();
  site = await loadSite({ prepare: () => ({ all: async () => ({ results: [] }) }) });
});
const render = (handle, { host = 'veyro.se', language = 'sv', canonicalOrigin = 'https://veyro.dk' } = {}) => renderSitePage(site, {
  type: handle ? 'page' : 'index', path: handle ? `/pages/${handle}` : '/',
  page: handle ? site.pages.find(page => page.handle === handle) : undefined,
  language, host, canonicalOrigin, cart: [],
});
const schemas = html => [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));

describe('Swedish public domain rendering', () => {
  it('uses root URLs, Swedish text and the existing SEK prices', () => {
    const html = render();
    expect(html).toContain('lang="sv"');
    expect(html).toContain('<link rel="canonical" href="https://veyro.se/">');
    expect(html).toContain('<meta property="og:url" content="https://veyro.se/">');
    expect(html).toContain('href="/pages/kontakt"');
    expect(html).toContain('href="/#proces"');
    expect(html).toContain('href="/demo/holm-tomrer/"');
    expect(html).toContain('href="https://kunde.veyro.dk/login"');
    expect(html).toContain('data-plan-link="/pages/kontakt?ydelse=pakke-webshop#formular"');
    expect(html).toContain('data-summary-price>299 SEK</strong>');
    for (const price of ['449 SEK', '599 SEK', '749 SEK']) expect(html).toContain(`data-price="${price}"`);
    expect(html).not.toMatch(/(?:href|data-plan-link)="\/sv(?:\/|\?)/);
    expect(html).toContain('//veyro.se/assets/');
    const organization = schemas(html).find(item => item['@type'] === 'ProfessionalService');
    expect(organization['@id']).toBe('https://veyro.dk/#organization');
    expect(organization.address.addressCountry).toBe('DK');
    expect(schemas(html).find(item => item['@type'] === 'WebSite')).toMatchObject({
      '@id': 'https://veyro.se/#website', url: 'https://veyro.se/', alternateName: 'veyro.se',
      publisher: { '@id': 'https://veyro.dk/#organization' },
    });
  });

  it('publishes reciprocal canonical language alternatives and preserves same-origin forms', () => {
    const html = render('kontakt');
    for (const [code, url] of [
      ['da', 'https://veyro.dk/pages/kontakt'],
      ['en', 'https://veyro.dk/en/pages/kontakt'],
      ['sv', 'https://veyro.se/pages/kontakt'],
    ]) {
      expect(html).toContain(`<link rel="alternate" hreflang="${code}" href="${url}">`);
      expect(html).toContain(`href="${url}?lang=${code}" lang="${code}"`);
    }
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://veyro.dk/pages/kontakt">');
    expect(html).toMatch(/<form method="post" action="\/contact#[^"]+"/);
    expect(html).toContain('name="return_to" value="/pages/kontakt"');
    expect(html).toContain('name="site_language" value="sv"');
    expect(html).toContain('name="contact[Ydelse]"');
    expect(html).toContain('value="Pakke: Webshop"');
  });

  it('keeps previews local while advertising production canonicals', () => {
    const html = render('hosting', { host: 'ny.veyro.dk' });
    expect(html).toContain('href="/sv/pages/kontakt?ydelse=hosting-og-vedligeholdelse#formular"');
    expect(html).toContain('href="/sv/pages/hosting?lang=sv" lang="sv"');
    expect(html).toContain('<link rel="canonical" href="https://veyro.se/pages/hosting">');
    expect(schemas(html).find(item => item['@type'] === 'BreadcrumbList').itemListElement.map(item => item.item)).toEqual([
      'https://veyro.se/', 'https://veyro.se/pages/ydelser', 'https://veyro.se/pages/hosting',
    ]);
    const local = render('kontakt', { host: 'localhost:52194', canonicalOrigin: 'http://localhost:52194' });
    expect(local).toContain('<link rel="canonical" href="http://localhost:52194/sv/pages/kontakt">');
    expect(local).toContain('href="/en/pages/kontakt?lang=en" lang="en"');
    expect(local).toContain('name="return_to" value="/sv/pages/kontakt"');
  });

  it.each(['da', 'en'])('points the %s production switcher to Swedish root paths', language => {
    const html = render('webshop', { language, host: 'veyro.dk' });
    expect(html).toContain('href="https://veyro.se/pages/webshop?lang=sv" lang="sv"');
    expect(html).toContain(`<link rel="canonical" href="https://veyro.dk${language === 'en' ? '/en' : ''}/pages/webshop">`);
  });

  it.each([
    ['en', 'veyro.dk', 'https://veyro.dk', 'https://veyro.dk/en/findes-ikke'],
    ['sv', 'veyro.se', 'https://veyro.dk', 'https://veyro.se/findes-ikke'],
    ['en', 'localhost:52194', 'http://localhost:52194', 'http://localhost:52194/en/findes-ikke'],
    ['sv', 'localhost:52194', 'http://localhost:52194', 'http://localhost:52194/sv/findes-ikke'],
  ])('preserves arbitrary localized 404 paths for %s on %s', (language, host, canonicalOrigin, expected) => {
    const html = renderSitePage(site, { type: '404', path: '/findes-ikke', language, host, canonicalOrigin, cart: [] });
    expect(html).toContain(`<link rel="canonical" href="${expected}">`);
    expect(html).toContain(`<meta property="og:url" content="${expected}">`);
  });
});

describe('Host-aware public URL helpers', () => {
  it('matches only supported Swedish hosts', () => {
    for (const host of ['veyro.se', 'www.veyro.se', 'VEYRO.SE']) expect(isSwedishHost(host)).toBe(true);
    for (const host of ['veyro.dk', 'ny.veyro.dk', 'veyro.se.evil.example', 'evilveyro.se', 'localhost']) expect(isSwedishHost(host)).toBe(false);
    expect(requestLanguage('/pages/kontakt', 'veyro.se')).toBe('sv');
    expect(requestLanguage('/en/pages/kontakt', 'veyro.dk')).toBe('en');
    expect(requestLanguage('/', 'veyro.dk')).toBe('da');
  });
  it('separates navigation paths from canonical cross-domain URLs', () => {
    expect(localizedPath('/pages/kontakt?x=1#formular', 'sv', 'veyro.se')).toBe('/pages/kontakt?x=1#formular');
    expect(localizedPath('/pages/kontakt', 'sv')).toBe('/sv/pages/kontakt');
    for (const path of ['/assets/theme.js', '/demo/lervaerk/', '/contact', '/files/1', 'https://kunde.veyro.dk/login', '#formular']) expect(localizedPath(path, 'sv', 'veyro.se')).toBe(path);
    expect(canonicalLanguageUrl('/pages/kontakt', 'sv')).toBe('https://veyro.se/pages/kontakt');
    expect(canonicalLanguageUrl('/pages/kontakt', 'en')).toBe('https://veyro.dk/en/pages/kontakt');
    expect(canonicalLanguageUrl('/pages/kontakt', 'da', 'https://veyro.se')).toBe('https://veyro.dk/pages/kontakt');
    expect(canonicalLanguageUrl('/pages/kontakt', 'en', 'https://veyro.se')).toBe('https://veyro.dk/en/pages/kontakt');
    expect(canonicalLanguageUrl('/pages/kontakt', 'sv', 'https://veyro.se')).toBe('https://veyro.se/pages/kontakt');
    expect(canonicalLanguageUrl('/', 'sv', 'http://localhost:52194')).toBe('http://localhost:52194/sv/');
    expect(canonicalLanguageUrl('/findes-ikke', 'en')).toBe('https://veyro.dk/en/findes-ikke');
    expect(canonicalLanguageUrl('/findes-ikke', 'sv')).toBe('https://veyro.se/findes-ikke');
    expect(localizedPath('/findes-ikke', 'en')).toBe('/findes-ikke');
    const html = '<a href="/pages/priser">Priser</a><a data-language-link href="https://veyro.dk/en/">English</a><input value="/pages/priser"><script>"/pages/priser"</script>';
    expect(localizeLinks(html, 'sv', 'veyro.se')).toBe(html);
  });
});

function switcherFixture(origin, pathname, hrefs, { search = '?kontakt=ok&form=Contact-form&webshop_niveau=60&tag=one&tag=two', hash = '#formular', service = null, tier = null } = {}) {
  const links = hrefs.map(([lang, href]) => ({ lang, href, getAttribute() { return this.href; } }));
  const handlers = new Map();
  const switcher = { querySelectorAll: () => links, addEventListener() {}, contains: () => false };
  const location = { origin, pathname, search, hash };
  const document = {
    querySelector: selector => selector === '[data-language-switch]' ? switcher : selector === 'select[name="contact[Ydelse]"]' ? service : selector === '[data-webshop-enquiry-select]' ? tier : null,
    addEventListener: (event, handler) => handlers.set(event, handler),
  };
  const context = { document, location, window: { addEventListener: (event, handler) => handlers.set(event, handler) }, URL };
  vm.runInNewContext(readFileSync(new URL('../site/theme/assets/language-switch.js', import.meta.url), 'utf8'), context);
  return { links, handlers, location };
}

describe('Language switch keeps destination origins and current enquiry state', () => {
  it('switches from Danish to Swedish without dropping the .se origin', () => {
    const service = { value: 'Pakke: Webshop', selectedOptions: [{ dataset: { key: 'pakke-webshop' } }] };
    const { links, handlers, location } = switcherFixture('https://veyro.dk', '/pages/kontakt', [['sv', 'https://veyro.se/pages/kontakt?lang=sv']], { service, tier: { value: '200' } });
    const target = new URL(links[0].href);
    expect(target.origin).toBe('https://veyro.se');
    expect(target.pathname).toBe('/pages/kontakt');
    expect(target.searchParams.get('lang')).toBe('sv');
    expect(target.searchParams.get('ydelse')).toBe('pakke-webshop');
    expect(target.searchParams.get('webshop_niveau')).toBe('200');
    expect(target.searchParams.getAll('tag')).toEqual(['one', 'two']);
    expect(target.searchParams.has('kontakt')).toBe(false);
    expect(target.searchParams.has('form')).toBe(false);
    expect(target.hash).toBe('#formular');
    location.hash = '#webshop-niveauer';
    handlers.get('hashchange')();
    expect(new URL(links[0].href).hash).toBe('#webshop-niveauer');
  });
  it('returns from Swedish to the Danish/English domains and preserves local previews', () => {
    const { links } = switcherFixture('https://veyro.se', '/pages/priser', [
      ['da', 'https://veyro.dk/pages/priser?lang=da'], ['en', 'https://veyro.dk/en/pages/priser?lang=en'],
    ]);
    expect(new URL(links[0].href).origin).toBe('https://veyro.dk');
    expect(new URL(links[0].href).pathname).toBe('/pages/priser');
    expect(new URL(links[1].href).pathname).toBe('/en/pages/priser');
    const preview = switcherFixture('https://ny.veyro.dk', '/en/pages/priser', [['sv', '/sv/pages/priser?lang=sv']]);
    expect(new URL(preview.links[0].href).origin).toBe('https://ny.veyro.dk');
    expect(new URL(preview.links[0].href).pathname).toBe('/sv/pages/priser');
  });
});

describe('Legacy section anchors', () => {
  it.each([
    ['veyro.se', 'sv', '/pages/ydelser', '/pages/priser'],
    ['www.veyro.se', 'sv', '/pages/ydelser', '/pages/priser'],
    ['veyro.dk', 'en', '/en/pages/ydelser', '/en/pages/priser'],
    ['ny.veyro.dk', 'sv', '/sv/pages/ydelser', '/sv/pages/priser'],
    ['veyro.dk', 'da', '/pages/ydelser', '/pages/priser'],
  ])('keeps %s section redirects on the correct public path', (hostname, language, pathname, expected) => {
    let ready, redirected;
    const document = {
      documentElement: { lang: language }, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: (type, callback) => { if (type === 'DOMContentLoaded') ready = callback; },
    };
    const window = {
      matchMedia: () => ({ matches: true }),
      location: { hostname, pathname, hash: '#pakke-basis', search: '?webshop_niveau=120', replace: value => { redirected = value; } },
    };
    vm.runInNewContext(readFileSync(new URL('../site/theme/assets/theme.js', import.meta.url), 'utf8'), { window, document, URLSearchParams });
    ready();
    expect(redirected).toBe(`${expected}?webshop_niveau=120#pakke-hjemmeside`);
  });
});
