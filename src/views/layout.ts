import { html } from 'hono/html';

export type H = ReturnType<typeof html>;

export type NavKey = 'overblik' | 'plan' | 'fakturaer' | 'henvendelser' | 'admin' | 'admin-kunder' | 'admin-henvendelser';

export interface LayoutOpts {
  title: string;
  email?: string | null;
  csrf?: string;
  nav?: NavKey;
  isAdmin?: boolean;
  /** Vis kunde-navigation (kun når brugeren er kunde) */
  customerNav?: boolean;
  adminNav?: boolean;
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
      navLink('/admin/kunder', 'Kunder', opts.nav === 'admin-kunder'),
      navLink('/admin/henvendelser', 'Henvendelser', opts.nav === 'admin-henvendelser'),
    ];
    if (opts.customerNav) navItems.push(navLink('/konto', 'Til kundepanel', false));
  } else if (opts.customerNav) {
    navItems = [
      navLink('/konto', 'Overblik', opts.nav === 'overblik'),
      navLink('/konto/plan', 'Skift plan', opts.nav === 'plan'),
      navLink('/konto/fakturaer', 'Fakturaer og betaling', opts.nav === 'fakturaer', 'Fakturaer'),
      navLink('/konto/henvendelser', 'Ændringsønsker og support', opts.nav === 'henvendelser', 'Support'),
    ];
    if (opts.isAdmin) navItems.push(navLink('/admin', 'Admin', false));
  } else if (loggedIn && opts.isAdmin) {
    navItems = [navLink('/admin', 'Admin', false)];
  }

  return html`<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#F4F2EC">
<title>${opts.title} · Veyro kundepanel</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css?v=1">
<script src="/static/app.js?v=1" defer></script>
</head>
<body>
<a class="skip" href="#indhold">Spring til indhold</a>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="${loggedIn ? '/konto' : '/login'}" aria-label="Veyro kundepanel – forside">Veyro<span>.</span></a>
    <div class="header-right">
      ${loggedIn
        ? html`<span class="who" title="${opts.email}">${opts.email}</span>
          <form method="post" action="/logout" class="inline">
            <input type="hidden" name="_csrf" value="${opts.csrf ?? ''}">
            <button class="btn btn-secondary btn-small" type="submit">Log ud</button>
          </form>`
        : html`<a class="btn btn-secondary btn-small" href="/bestil">Se abonnementer</a>`}
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
