import { html, raw } from 'hono/html';
import type { User } from '../env';
import { canManage } from '../lib/session';
import { DEFAULT_ACCENT, isHexColor, type Settings } from '../lib/settings';

export type H = ReturnType<typeof html>;

export type LagerNav = 'oversigt' | 'varer' | 'indkob' | 'modtagelse' | 'job' | 'faktura' | 'historik' | 'katalog' | 'indstillinger';
export type JobNav = 'job' | 'lager' | 'katalog' | 'indkob' | 'faktura';
export type Nav = { portal: 'lager'; tab: LagerNav } | { portal: 'job'; tab: JobNav } | { portal: 'none' };

/** Tekstfarve på accentfarven: den af mørk og hvid, der giver bedst kontrast (WCAG). */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.0555 >= 1.05 / (L + 0.05) ? '#0F0F0D' : '#FFFFFF';
}

export function accentOf(s: Settings): string {
  return isHexColor(s.accent_color) ? s.accent_color : DEFAULT_ACCENT;
}

function themeStyle(s: Settings): H {
  const accent = accentOf(s);
  const n = parseInt(accent.slice(1), 16);
  const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  // Værdierne er valideret (hex-farve), så de kan indsættes direkte
  return html`<style>${raw(`:root{--accent:${accent};--accent-ink:${inkOn(accent)};--accent-rgb:${rgb};--accent-soft:rgba(${rgb},.1)}`)}</style>`;
}

const V = '2';

function head(title: string, s: Settings): H {
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#F4F2EC">
<link rel="apple-touch-icon" href="/icons/180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${s.company_name}">
<meta name="color-scheme" content="light">
<title>${title}</title>
${s.logo_version ? html`<link rel="icon" href="/logo?v=${s.logo_version}">` : html`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`}
<link rel="preload" href="/static/inter-tight.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css?v=${V}">
${themeStyle(s)}
<script src="/static/app.js?v=${V}" defer></script>`;
}

function navLink(href: string, label: string, active: boolean, count?: number): H {
  return html`<li><a href="${href}"${active ? html` aria-current="page"` : ''}>${label}${count
    ? html`<span class="nav-count" aria-label="${count} åbne">${count}</span>`
    : ''}</a></li>`;
}

export interface LayoutOpts {
  title: string;
  settings: Settings;
  user: User | null;
  csrf: string;
  nav: Nav;
  /** Antal åbne advarsler (vises ved Oversigt) */
  alertCount?: number;
  demo?: boolean;
}

export function layout(opts: LayoutOpts, body: H): H {
  const s = opts.settings;
  const u = opts.user;
  const manager = canManage(u);
  const nav = opts.nav;
  return html`<!doctype html>
<html lang="da">
<head>
${head(`${opts.title} · ${s.company_name}`, s)}
</head>
<body>
<a class="skip" href="#indhold">Spring til indhold</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">${brandMark(s)}<span class="brand-name">${s.company_name}</span>${opts.demo
      ? html`<span class="tag tag-sim hide-sm">Demo</span>`
      : ''}</a>
    <div class="header-right">
      ${u && manager
        ? html`<nav class="portal" aria-label="Portal">
            <a href="/lager"${nav.portal === 'lager' ? html` aria-current="page"` : ''}>Lager</a>
            <a href="/job"${nav.portal === 'job' ? html` aria-current="page"` : ''}>Job</a>
          </nav>`
        : ''}
      ${u
        ? html`<span class="user-name hide-sm" title="${u.email}">${u.name}</span>
          <form method="post" action="/logout" class="inline">
            <input type="hidden" name="_csrf" value="${opts.csrf}">
            <button class="btn btn-secondary btn-small" type="submit">Log ud</button>
          </form>`
        : ''}
    </div>
  </div>
</header>
${nav.portal === 'lager'
  ? html`<nav class="admin-nav" aria-label="Lagerportal"><div class="wrap"><ul>
      ${navLink('/lager', 'Oversigt', nav.tab === 'oversigt', opts.alertCount)}
      ${navLink('/lager/varer', 'Varer og lager', nav.tab === 'varer')}
      ${navLink('/lager/indkob', 'Indkøb', nav.tab === 'indkob')}
      ${navLink('/lager/modtagelse', 'Varemodtagelse', nav.tab === 'modtagelse')}
      ${navLink('/lager/katalog', 'Produktkatalog', nav.tab === 'katalog')}
      ${navLink('/job', 'Job', false)}
      ${navLink('/job/faktura', 'Fakturaer', false)}
      ${navLink('/lager/historik', 'Historik', nav.tab === 'historik')}
      ${navLink('/lager/indstillinger', 'Indstillinger', nav.tab === 'indstillinger')}
    </ul></div></nav>`
  : nav.portal === 'job'
    ? html`<nav class="admin-nav" aria-label="Forbrugsportal"><div class="wrap"><ul>
      ${navLink('/job', 'Job', nav.tab === 'job')}
      ${navLink('/job/lager', 'Hvad er på lager', nav.tab === 'lager')}
      ${navLink('/job/katalog', 'Produktkatalog', nav.tab === 'katalog')}
      ${navLink('/job/indkob', 'Indkøbslister', nav.tab === 'indkob')}
      ${manager ? navLink('/job/faktura', 'Fakturaer', nav.tab === 'faktura') : ''}
    </ul></div></nav>`
    : ''}
<main id="indhold"><div class="wrap">${body}</div></main>
</body>
</html>`;
}

export function csrfField(token: string): H {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

/** Engangsnøgle til en registrering (se lib/ledger.ts). */
export function opField(token: string): H {
  return html`<input type="hidden" name="op" value="${token}">`;
}

export function alert(kind: 'info' | 'ok' | 'warn' | 'err', content: H | string): H {
  const role = kind === 'err' || kind === 'warn' ? 'alert' : 'status';
  return html`<div class="alert alert-${kind}" role="${role}">${content}</div>`;
}

/** Virksomhedens logo, eller en prik i accentfarven, hvis der ikke er uploadet et logo. */
export function brandMark(s: Settings): H {
  return s.logo_version
    ? html`<img class="brand-logo" src="/logo?v=${s.logo_version}" alt="">`
    : html`<span class="brand-dot" aria-hidden="true"></span>`;
}

export function favicon(s: Settings): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${accentOf(s)}"/></svg>`;
}
