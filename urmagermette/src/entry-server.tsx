// Forudrendering af de offentlige sider til statisk HTML (hurtigt og godt for søgemaskiner).
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { App } from './app/App';
import { SEO, OFFENTLIGE_SIDER } from './app/seo';
import { DEMO } from './app/demo';
import { VIRKSOMHED } from './shared/virksomhed';

export { OFFENTLIGE_SIDER };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function render(url: string, base: string): { html: string; head: string } {
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </StrictMode>,
  );
  const m = SEO[url] ?? SEO['/404']!;
  const canonical = `${base}${url === '/' ? '/' : url}`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': `${base}/#virksomhed`,
    name: VIRKSOMHED.navn,
    description: 'Urmager i Slagelse – reparation og service af armbåndsure, vintageure, lommeure, bornholmerure, taffelure og stueure.',
    url: `${base}/`,
    telephone: VIRKSOMHED.telefon,
    email: VIRKSOMHED.email,
    image: `${base}/billeder/hero.jpg`,
    address: { '@type': 'PostalAddress', streetAddress: VIRKSOMHED.adresse, postalCode: VIRKSOMHED.postnr, addressLocality: VIRKSOMHED.by, addressCountry: 'DK' },
    areaServed: 'Slagelse',
  };
  const head = [
    `<title>${esc(m.titel)}</title>`,
    `<meta name="description" content="${esc(m.beskrivelse)}" />`,
    DEMO || url === '/404' ? '<meta name="robots" content="noindex, nofollow" />' : '',
    url !== '/404' ? `<link rel="canonical" href="${esc(canonical)}" />` : '',
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="da_DK" />`,
    `<meta property="og:site_name" content="UrmagerMette" />`,
    `<meta property="og:title" content="${esc(m.titel)}" />`,
    `<meta property="og:description" content="${esc(m.beskrivelse)}" />`,
    `<meta property="og:image" content="${esc(base)}/billeder/hero.jpg" />`,
    url === '/' ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : '',
  ].filter(Boolean).join('\n    ');
  return { html, head };
}
