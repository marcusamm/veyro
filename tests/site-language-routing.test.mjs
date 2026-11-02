import { describe, expect, it } from 'vitest';
import { languageRedirect } from '../src/site/language-routing';

const ORIGIN = 'https://veyro.dk';

function visitor(path = '/', { country, cf, method = 'GET', headers = {}, origin = ORIGIN } = {}) {
  const request = new Request(origin + path, { method, headers });
  if (country !== undefined || cf !== undefined) {
    Object.defineProperty(request, 'cf', { value: { ...cf, ...(country === undefined ? {} : { country }) } });
  }
  return request;
}

function automatic(path, country, preference) {
  return languageRedirect(visitor(path, { country }), preference);
}

function expectRedirect(result, location, selectedLanguage) {
  expect(result).toEqual({ location, ...(selectedLanguage === undefined ? {} : { selectedLanguage }) });
  expect(result.location.startsWith('/')).toBe(true);
  expect(result.location.startsWith('//')).toBe(false);
}

describe('Country-based public language routing', () => {
  it.each([
    ['DK', null],
    ['SE', '/sv/'],
    ['DE', '/en/'],
    ['US', '/en/'],
    ['XX', '/en/'],
    ['T1', '/en/'],
    [undefined, '/en/'],
  ])('routes a new public visitor from %s without saving a manual choice', (country, location) => {
    const result = automatic('/', country);
    if (location === null) expect(result).toBeNull();
    else expectRedirect(result, location);
  });

  it.each(['localhost', '127.0.0.1'])('keeps %s development Danish only when country metadata is absent', host => {
    const origin = `http://${host}:52194`;
    expect(languageRedirect(visitor('/', { origin }))).toBeNull();
    expectRedirect(languageRedirect(visitor('/', { origin, country: 'SE' })), '/sv/');
    expectRedirect(languageRedirect(visitor('/', { origin, country: 'US' })), '/en/');
  });

  it('uses Cloudflare metadata rather than browser headers to choose the country', () => {
    const headers = { 'CF-IPCountry': 'SE', 'X-Country': 'SE', 'Accept-Language': 'sv-SE,sv;q=0.9' };
    expect(languageRedirect(visitor('/', { country: 'DK', headers }))).toBeNull();
    expectRedirect(languageRedirect(visitor('/', { headers })), '/en/');
    expectRedirect(languageRedirect(visitor('/', { country: 'SE', headers: { 'CF-IPCountry': 'DK', 'Accept-Language': 'da' } })), '/sv/');
  });

  it.each([
    ['/', '/sv/'],
    ['/pages/priser', '/sv/pages/priser'],
    ['/pages/priser/', '/sv/pages/priser/'],
    ['/products/business', '/sv/products/business'],
    ['/cart', '/sv/cart'],
  ])('localizes public document %s and reaches a stable target', (path, location) => {
    expectRedirect(automatic(path, 'SE'), location);
    expect(automatic(location, 'SE')).toBeNull();
  });

  it('preserves repeated and encoded query parameters, including the selected webshop tier', () => {
    const query = '?ydelse=pakke-webshop&webshop_niveau=120&utm_source=a%26b&tag=one&tag=two';
    expectRedirect(automatic('/pages/kontakt' + query, 'SE'), '/sv/pages/kontakt' + query);
  });

  it('handles HEAD as a document lookup too', () => {
    expectRedirect(languageRedirect(visitor('/pages/priser?ydelse=demo', { method: 'HEAD', country: 'SE' })), '/sv/pages/priser?ydelse=demo');
  });
});

describe('Explicit links and manual language preference', () => {
  it.each([
    ['SE', 'da', null],
    ['DK', 'sv', '/sv/'],
    ['SE', 'en', '/en/'],
    ['US', 'sv', '/sv/'],
    ['DK', 'invalid', null],
    ['SE', 'invalid', '/sv/'],
  ])('applies saved choice %s / %s before the visitor country', (country, preference, location) => {
    const result = automatic('/', country, preference);
    if (location === null) expect(result).toBeNull();
    else expectRedirect(result, location);
  });

  it.each(['/en', '/en/', '/en/pages/priser', '/sv/', '/sv/products/business', '/sv/cart'])('honors explicit localized URL %s even when preference and country disagree', path => {
    const other = path.startsWith('/en') ? 'sv' : 'en';
    expect(automatic(path, 'DK', other)).toBeNull();
  });

  it.each([
    ['/?lang=sv', 'sv', '/sv/'],
    ['/en/?lang=da', 'da', '/'],
    ['/sv?lang=en', 'en', '/en/'],
    ['/pages/priser?lang=da', 'da', '/pages/priser'],
    ['/sv/pages/kontakt?lang=en&ydelse=pakke-webshop&webshop_niveau=200', 'en', '/en/pages/kontakt?ydelse=pakke-webshop&webshop_niveau=200'],
    ['/en/products/business?lang=sv', 'sv', '/sv/products/business'],
    ['/sv/cart?lang=da', 'da', '/cart'],
  ])('manual selection in %s overrides URL, stored choice and country', (path, language, location) => {
    expectRedirect(automatic(path, 'SE', 'en'), location, language);
  });

  it('removes only the manual selection parameter and keeps duplicate unrelated values', () => {
    const result = automatic('/pages/kontakt?utm_source=a%26b&lang=sv&tag=one&tag=two&kontakt=ok&form=Contact-form', 'DK');
    expect(result.selectedLanguage).toBe('sv');
    const target = new URL(result.location, ORIGIN);
    expect(target.pathname).toBe('/sv/pages/kontakt');
    expect(target.searchParams.has('lang')).toBe(false);
    expect(target.searchParams.get('utm_source')).toBe('a&b');
    expect(target.searchParams.getAll('tag')).toEqual(['one', 'two']);
    expect(target.searchParams.get('kontakt')).toBe('ok');
    expect(target.searchParams.get('form')).toBe('Contact-form');
  });

  it('does not turn invalid manual input into a saved preference', () => {
    expectRedirect(automatic('/pages/priser?lang=fr&ydelse=demo', 'SE'), '/sv/pages/priser?lang=fr&ydelse=demo');
    expect(automatic('/sv/pages/priser?lang=fr', 'DK', 'en')).toBeNull();
  });
});

describe('Language routing boundaries', () => {
  it.each([
    '/assets/base.css',
    '/demo',
    '/demo/holm-tomrer/',
    '/files/12',
    '/favicon.ico',
    '/fuldmagt-skabelon.pdf',
    '/fortrolighedsaftale-skabelon.pdf',
    '/robots.txt',
    '/sitemap.xml',
    '/healthz',
    '/contact',
    '/cart/change?line=1&quantity=0',
    '/cart/clear.js',
    '/account',
    '/admin',
    '/findes-ikke',
    '/pages/priser/extra',
    '/products/business/extra',
    '/svindel',
  ])('leaves non-document route %s untouched even with a manual query', path => {
    expect(automatic(path, 'SE', 'en')).toBeNull();
    const url = new URL(path, ORIGIN);
    url.searchParams.set('lang', 'sv');
    expect(languageRedirect(visitor(url.pathname + url.search, { country: 'DK' }), 'en')).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('does not redirect or consume language choices on %s', method => {
    expect(languageRedirect(visitor('/pages/kontakt?lang=sv', { country: 'SE', method }), 'en')).toBeNull();
    expect(languageRedirect(visitor('/cart?lang=en', { country: 'SE', method }), 'sv')).toBeNull();
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  ])('keeps crawler URL identity stable for %s', userAgent => {
    expect(languageRedirect(visitor('/pages/priser', { country: 'SE', headers: { 'User-Agent': userAgent } }))).toBeNull();
    expectRedirect(languageRedirect(visitor('/pages/priser?lang=sv', { country: 'DK', headers: { 'User-Agent': userAgent } })), '/sv/pages/priser', 'sv');
  });

  it('recognizes verified bots without depending on their user-agent string', () => {
    const cf = { country: 'SE', botManagement: { verifiedBot: true } };
    expect(languageRedirect(visitor('/', { cf }))).toBeNull();
    expectRedirect(languageRedirect(visitor('/?lang=en', { cf })), '/en/', 'en');
  });

  it('keeps independent visitors independent when calls are interleaved', () => {
    expectRedirect(automatic('/pages/priser', 'SE'), '/sv/pages/priser');
    expect(automatic('/pages/priser', 'DK')).toBeNull();
    expectRedirect(automatic('/pages/priser', 'US'), '/en/pages/priser');
    expect(automatic('/pages/priser', 'SE', 'da')).toBeNull();
    expectRedirect(automatic('/pages/priser', 'SE'), '/sv/pages/priser');
  });
});
