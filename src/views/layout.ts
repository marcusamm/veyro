import { html } from 'hono/html';
import { brandMark } from './brand-mark';

export type H = ReturnType<typeof html>;

export type NavKey = 'overblik' | 'aftaler' | 'fuldmagter' | 'admin-fuldmagter' | 'admin-nda' | 'plan' | 'fakturaer' | 'henvendelser' | 'admin' | 'admin-kunder' | 'admin-henvendelser' | 'admin-fakturaer' | 'admin-abonnementer' | 'admin-tilbud' | 'admin-hjemmeside' | 'admin-forespoergsler' | 'admin-statistik' | 'admin-kasse' | 'admin-kundeemner';

export interface LayoutOpts {
  title: string;
  email?: string | null;
  csrf?: string;
  nav?: NavKey;
  isAdmin?: boolean;
  /** Vis kunde-navigation (kun når brugeren er kunde) */
  customerNav?: boolean;
  adminNav?: boolean;
  /** Vis "Aftaler og dokumenter" (kunden har adgang til fuldmagter eller har dokumenter) */
  agreementsNav?: boolean;
  /** Medarbejder i kassen uden adgang til resten af admin: kun kassens menupunkt */
  staffNav?: boolean;
  /** Kassens sider: bred side og kassens stylesheet og script */
  kasse?: boolean;
  /** Genindlæs siden efter så mange sekunder (fx mens et baggrundsjob kører) */
  refresh?: number;
}

function navLink(href: string, label: string, active: boolean, short?: string): H {
  const text = short ? html`<span class="long">${label}</span><span class="short" aria-hidden="true">${short}</span>` : label;
  return html`<li><a href="${href}"${short ? html` aria-label="${label}"` : ''}${active ? html` aria-current="page"` : ''}>${text}</a></li>`;
}

export function layout(opts: LayoutOpts, body: H): H {
  const loggedIn = !!opts.email;
  let navItems: H[] = [];
  if (opts.adminNav) {
    navItems = [
      navLink('/admin', 'Oversigt', opts.nav === 'admin'),
      navLink('/admin/kasse', 'Kasse', opts.nav === 'admin-kasse'),
      navLink('/admin/statistik', 'Statistik', opts.nav === 'admin-statistik'),
      navLink('/admin/hjemmeside', 'Hjemmeside', opts.nav === 'admin-hjemmeside'),
      navLink('/admin/kundeemner', 'Kundeemner', opts.nav === 'admin-kundeemner'),
      navLink('/admin/forespoergsler', 'Forespørgsler', opts.nav === 'admin-forespoergsler'),
      navLink('/admin/kunder', 'Kunder', opts.nav === 'admin-kunder'),
      navLink('/admin/henvendelser', 'Henvendelser', opts.nav === 'admin-henvendelser'),
      navLink('/admin/tilbud', 'Tilbud', opts.nav === 'admin-tilbud'),
      navLink('/admin/abonnementer', 'Abonnementer', opts.nav === 'admin-abonnementer'),
      navLink('/admin/fakturaer', 'Fakturaer', opts.nav === 'admin-fakturaer'),
      navLink('/admin/fuldmagter', 'Fuldmagter', opts.nav === 'admin-fuldmagter'),
      navLink('/admin/nda', 'NDA', opts.nav === 'admin-nda'),
    ];
    if (opts.customerNav) navItems.push(navLink('/konto', 'Til kundepanel', false));
  } else if (opts.customerNav) {
    navItems = [
      navLink('/konto', 'Overblik', opts.nav === 'overblik'),
      navLink('/konto/plan', 'Skift plan', opts.nav === 'plan'),
      navLink('/konto/fakturaer', 'Fakturaer og betaling', opts.nav === 'fakturaer', 'Fakturaer'),
      navLink('/konto/henvendelser', 'Ændringsønsker og support', opts.nav === 'henvendelser', 'Support'),
    ];
    if (opts.agreementsNav) navItems.push(navLink('/konto/aftaler', 'Aftaler og dokumenter', opts.nav === 'aftaler' || opts.nav === 'fuldmagter', 'Aftaler'));
    if (opts.isAdmin) navItems.push(navLink('/admin', 'Admin', false));
  } else if (opts.staffNav) {
    navItems = [navLink('/admin/kasse', 'Kasse', opts.nav === 'admin-kasse')];
  } else if (loggedIn && opts.isAdmin) {
    navItems = [navLink('/admin', 'Admin', false)];
  }

  return html`<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${opts.refresh ? html`<meta http-equiv="refresh" content="${String(opts.refresh)}">
` : ''}<meta name="color-scheme" content="light">
<meta name="theme-color" content="#F4F2EC">
<title>${opts.title} · Veyro kundepanel</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon.png">
<link rel="preload" href="/static/inter-tight.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css?v=8">
<script src="/static/app.js?v=2" defer></script>
${opts.kasse ? html`<link rel="stylesheet" href="/static/kasse.css?v=1">
<script src="/static/kasse.js?v=1" defer></script>` : ''}
</head>
<body${opts.kasse ? html` class="kasse"` : ''}>
<a class="skip" href="#indhold">Spring til indhold</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo veyro-brand-lockup" href="${loggedIn ? '/konto' : '/login'}" aria-label="Veyro kundepanel – forside">${brandMark()}<span class="veyro-brand-wordmark">Veyro<span class="veyro-brand-dot">.</span></span></a>
    <div class="header-right">
      ${loggedIn
        ? html`<span class="who" title="${opts.email}">${opts.email}</span>
          <form method="post" action="/logout" class="inline">
            <input type="hidden" name="_csrf" value="${opts.csrf ?? ''}">
            <button class="btn btn-secondary btn-small" type="submit">Log ud</button>
          </form>`
        : html`<a class="btn btn-secondary btn-small" href="https://veyro.dk/pages/kontakt#formular">Få et tilbud</a>`}
    </div>
  </div>
  ${navItems.length
    ? html`<nav class="nav" aria-label="Hovedmenu"><div class="wrap"><ul>${navItems}</ul></div></nav>`
    : ''}
</header>
<main id="indhold">
  <div class="wrap">${body}</div>
</main>
<footer class="site-footer">
  <div class="wrap">
    <span>© Veyro · <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a></span>
    <nav aria-label="Juridisk">
      <a href="https://veyro.dk">veyro.dk</a>
      <a href="https://veyro.dk/pages/privatlivspolitik">Privatlivspolitik</a>
      <a href="https://veyro.dk/pages/cookiepolitik">Cookiepolitik</a>
    </nav>
  </div>
</footer>
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
