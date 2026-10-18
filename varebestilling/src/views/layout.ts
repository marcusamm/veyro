import { html, raw } from 'hono/html';
import { DEFAULT_ACCENT, isHexColor, safeUrl, type Settings } from '../lib/settings';

export type H = ReturnType<typeof html>;

export type AdminNav = 'oversigt' | 'ordrer' | 'varer' | 'import' | 'historik' | 'indstillinger';

/** Tekstfarve på accentfarven: den af mørk og hvid, der giver bedst kontrast (WCAG). */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.0555 >= 1.05 / (L + 0.05) ? '#0F0F0D' : '#FFFFFF';
}

function themeStyle(s: Settings): H {
  const accent = isHexColor(s.accent_color) ? s.accent_color : DEFAULT_ACCENT;
  const n = parseInt(accent.slice(1), 16);
  const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  // Værdierne er valideret (hex-farve), så de kan indsættes direkte
  return html`<style>${raw(`:root{--accent:${accent};--accent-ink:${inkOn(accent)};--accent-rgb:${rgb};--accent-soft:rgba(${rgb},.1)}`)}</style>`;
}

function head(title: string, s: Settings, opts: { noindex?: boolean; description?: string }): H {
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.noindex ? html`<meta name="robots" content="noindex, nofollow">` : ''}
${opts.description ? html`<meta name="description" content="${opts.description}">` : ''}
<meta name="color-scheme" content="light">
<title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/static/inter-tight.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css?v=2">
${themeStyle(s)}
<script src="/static/app.js?v=2" defer></script>`;
}

function footer(s: Settings): H {
  const terms = safeUrl(s.terms_url);
  const privacy = safeUrl(s.privacy_url);
  const site = safeUrl(s.website_url);
  const contact = [s.address, s.contact_phone].filter(Boolean).join(' · ');
  return html`<footer class="site-footer">
  <div class="wrap">
    <span>© ${s.shop_name}${contact ? html` · ${contact}` : ''}${s.contact_email
      ? html` · <a href="mailto:${s.contact_email}">${s.contact_email}</a>`
      : ''}</span>
    <nav aria-label="Links">
      ${site ? html`<a href="${site}">Til hjemmesiden</a>` : ''}
      ${terms ? html`<a href="${terms}">Handelsbetingelser</a>` : ''}
      ${privacy ? html`<a href="${privacy}">Privatlivspolitik</a>` : ''}
    </nav>
  </div>
</footer>`;
}

export function shopLayout(opts: { title: string; settings: Settings; cartCount: number; description?: string; noindex?: boolean }, body: H): H {
  const s = opts.settings;
  return html`<!doctype html>
<html lang="da">
<head>
${head(opts.title === s.shop_name ? s.shop_name : `${opts.title} · ${s.shop_name}`, s, { description: opts.description, noindex: opts.noindex })}
</head>
<body>
<a class="skip" href="#indhold">Spring til indhold</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/"><span class="brand-dot" aria-hidden="true"></span><span class="brand-name">${s.shop_name}</span></a>
    <div class="header-right">
      <a class="cart-link" href="/kurv" aria-label="Kurv, ${opts.cartCount} varer">Kurv <span class="badge-count">${opts.cartCount}</span></a>
    </div>
  </div>
</header>
<main id="indhold"><div class="wrap">${body}</div></main>
${footer(s)}
</body>
</html>`;
}

function navLink(href: string, label: string, active: boolean, count?: number): H {
  return html`<li><a href="${href}"${active ? html` aria-current="page"` : ''}>${label}${count
    ? html`<span class="nav-count" aria-label="${count} nye">${count}</span>`
    : ''}</a></li>`;
}

export function adminLayout(
  opts: { title: string; settings: Settings; email?: string | null; csrf: string; nav?: AdminNav; newCount?: number },
  body: H,
): H {
  const s = opts.settings;
  const loggedIn = !!opts.email;
  return html`<!doctype html>
<html lang="da">
<head>
${head(`${opts.title} · ${s.shop_name} admin`, s, { noindex: true })}
</head>
<body>
<a class="skip" href="#indhold">Spring til indhold</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/admin"><span class="brand-dot" aria-hidden="true"></span><span class="brand-name">${s.shop_name}</span><span class="tag hide-sm">Admin</span></a>
    <div class="header-right">
      ${loggedIn
        ? html`<a class="btn btn-ghost btn-small hide-sm" href="/" target="_blank" rel="noopener">Se webshop</a>
          <form method="post" action="/admin/logout" class="inline">
            <input type="hidden" name="_csrf" value="${opts.csrf}">
            <button class="btn btn-secondary btn-small" type="submit">Log ud</button>
          </form>`
        : ''}
    </div>
  </div>
</header>
${loggedIn
  ? html`<nav class="admin-nav" aria-label="Adminmenu"><div class="wrap"><ul>
      ${navLink('/admin', 'Oversigt', opts.nav === 'oversigt')}
      ${navLink('/admin/ordrer', 'Ordrer', opts.nav === 'ordrer', opts.newCount)}
      ${navLink('/admin/varer', 'Varer og lager', opts.nav === 'varer')}
      ${navLink('/admin/import', 'Import', opts.nav === 'import')}
      ${navLink('/admin/historik', 'Lagerhistorik', opts.nav === 'historik')}
      ${navLink('/admin/indstillinger', 'Indstillinger', opts.nav === 'indstillinger')}
    </ul></div></nav>`
  : ''}
<main id="indhold"><div class="wrap">${body}</div></main>
</body>
</html>`;
}

export function csrfField(token: string): H {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

export function alert(kind: 'info' | 'ok' | 'warn' | 'err', content: H | string): H {
  const role = kind === 'err' || kind === 'warn' ? 'alert' : 'status';
  return html`<div class="alert alert-${kind}" role="${role}">${content}</div>`;
}

export function favicon(s: Settings): string {
  const accent = isHexColor(s.accent_color) ? s.accent_color : DEFAULT_ACCENT;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${accent}"/></svg>`;
}
