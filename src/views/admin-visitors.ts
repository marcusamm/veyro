import { html, raw } from 'hono/html';
import { formatDateTime } from '../lib/format';
import type { AnalyticsBreakdown, AnalyticsReport, AnalyticsSession, AnalyticsSessionDetail } from '../lib/site-analytics';
import { chart } from './admin-stats';
import { alert, type H } from './layout';

const int = (n: number) => n.toLocaleString('da-DK', { maximumFractionDigits: 0 });
const decimal = (n: number) => n.toLocaleString('da-DK', { maximumFractionDigits: 1 });
const percent = (part: number, total: number) => `${decimal(total ? part / total * 100 : 0)} %`;
const countries = new Intl.DisplayNames(['da'], { type: 'region' });

function countryName(code: string): string {
  if (!code || code === 'XX' || code === 'T1') return 'Ukendt land';
  try { return countries.of(code) || code; } catch { return code; }
}

function duration(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${int(seconds)} sek.`;
  if (seconds < 3600) return `${int(Math.floor(seconds / 60))} min.${seconds % 60 ? ` ${seconds % 60} sek.` : ''}`;
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${int(Math.floor(seconds / 3600))} t.${minutes ? ` ${int(minutes)} min.` : ''}`;
}

const deviceName = (device: string): string => ({ desktop: 'Computer', mobile: 'Mobil', tablet: 'Tablet', unknown: 'Ukendt enhed', other: 'Anden enhed' })[device] || device || 'Ukendt enhed';
const sourceName = (source: string): string => ['direct', '(direct)', 'Direkte'].includes(source) ? 'Direkte / ukendt' : source || 'Direkte / ukendt';

function location(session: AnalyticsSession): string {
  return [session.city || session.region, countryName(session.country)].filter(Boolean).join(', ');
}

function metric(label: string, value: string, note: string): H {
  return html`<div class="card kpi"><div class="muted small">${label}</div><div class="kpi__value">${value}</div><p class="small muted" style="margin:0">${note}</p></div>`;
}

function breakdown(title: string, rows: AnalyticsBreakdown[], total: number, label: (v: string) => string = v => v || 'Ukendt'): H {
  return html`<section class="card stack"><h2 style="margin:0">${title}</h2>
    ${rows.length ? html`<table><thead><tr><th scope="col">${title}</th><th scope="col" class="num">Besøg</th><th scope="col" class="num">Andel</th></tr></thead><tbody>
      ${rows.map(r => html`<tr><td style="overflow-wrap:anywhere">${label(r.label)}</td><td class="num">${int(r.visits)}</td><td class="num">${percent(r.visits, total)}</td></tr>`)}
    </tbody></table>` : html`<p class="empty">Ingen registrerede besøg i perioden.</p>`}
  </section>`;
}

function sessionRows(sessions: AnalyticsSession[]): H {
  return html`<div class="table-wrap"><table class="responsive"><thead><tr>
    <th scope="col">Besøg startet</th><th scope="col">Område</th><th scope="col">Enhed / kilde</th><th scope="col">Besøgstype</th><th scope="col" class="num">Sider</th><th scope="col" class="num">Aktiv tid</th>
  </tr></thead><tbody>${sessions.map(s => html`<tr>
    <td data-label="Startet"><span class="cell"><a href="/admin/besoegende/${s.id}" aria-label="Se besøgsforløb fra ${formatDateTime(s.startedAt)}">${formatDateTime(s.startedAt)}</a></span></td>
    <td data-label="Område"><span class="cell">${location(s)}</span></td>
    <td data-label="Enhed / kilde"><span class="cell">${deviceName(s.device)}<br><span class="small muted">${sourceName(s.source)}</span></span></td>
    <td data-label="Besøgstype"><span class="cell">${s.returning ? 'Tilbagevendende' : 'Ny browser'}</span></td>
    <td data-label="Sider" class="num">${int(s.pageviews)}</td>
    <td data-label="Aktiv tid" class="num">${duration(s.activeSeconds)}</td>
  </tr>`)}</tbody></table></div>`;
}

export function visitorsPage({ report: r, months }: { report: AnalyticsReport; months: { key: string; label: string }[] }): H {
  const t = r.totals;
  const periods = [...[7, 30, 90].map(days => ({ key: String(days), label: `Sidste ${days} dage` })), ...months];
  if (!periods.some(p => p.key === r.period.key)) periods.push({ key: r.period.key, label: r.period.label });
  return html`<div class="stack-lg">
    <div><p class="eyebrow"><a href="/admin">Admin</a> / veyro.dk</p><h1>Besøgende</h1>
      <p class="lead" style="margin-bottom:0">Se, hvor besøgene kommer fra, hvor ofte browsere vender tilbage, og hvilke sider der bliver besøgt.</p></div>

    <form class="row stats-filter" method="get" action="/admin/besoegende">
      <label for="besoeg-periode">Periode</label>
      <select id="besoeg-periode" name="periode">${periods.map(p => html`<option value="${p.key}"${p.key === r.period.key ? raw(' selected') : ''}>${p.label}</option>`)}</select>
      <button class="btn btn-primary btn-small" type="submit">Vis besøg</button>
      <a class="btn btn-secondary btn-small" href="/admin/statistik?periode=${r.period.key}">Salg og alle sidevisninger →</a>
    </form>

    ${alert('info', html`<strong>Besøgsdetaljer måles efter tilvalg af statistik.</strong> Tallene nedenfor dækker de browsere, som har accepteret statistikcookies. Det samlede antal sidevisninger vises særskilt. Ældre besøg kan ikke efterfølgende få tilføjet geografi eller besøgsforløb.`)}

    <div class="grid kpi-grid">
      ${metric('Besøg', int(t.visits), 'Et nyt besøg efter 30 min. uden aktivitet')}
      ${metric('Unikke browsere', int(t.uniqueVisitors), 'Genkendes med statistikcookie')}
      ${metric('Tilbagevendende besøg', int(t.returningVisits), `${percent(t.returningVisits, t.visits)} af de målte besøg`)}
      ${metric('Gns. aktiv tid', t.visits ? duration(t.averageActiveSeconds) : '–', 'Pr. målt besøg')}
    </div>

    ${!t.visits ? html`<section class="card stack"><h2>Her kommer jeres besøgsdata</h2><p>Der er endnu ingen målte besøg i den valgte periode. Data bliver samlet, når besøgende vælger statistik i cookiebanneret. Brug også en længere periode, hvis målingen lige er startet.</p><p class="small muted" style="margin:0">Der vises ingen eksempelbesøg eller beregnede historiske besøgende.</p></section>` : ''}

    <section class="card stack">
      ${chart({ id: 'visitor-visits', title: 'Besøg pr. dag', days: r.daily.map(d => d.day), current: r.daily.map(d => d.visits), previous: [], format: int, axis: n => Number.isInteger(n) ? int(n) : '' })}
      <p class="small muted" style="margin-bottom:0">${int(t.pageviews)} målte sidevisninger · ${decimal(t.pagesPerVisit)} sider pr. besøg. Besøg placeres på startdatoen i dansk tid.</p>
      <details><summary>Vis dagstal som tabel</summary><div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Dato</th><th scope="col" class="num">Besøg</th><th scope="col" class="num">Unikke browsere</th><th scope="col" class="num">Sidevisninger</th></tr></thead><tbody>
        ${r.daily.map(d => html`<tr><td data-label="Dato">${d.day.split('-').reverse().join('.')}</td><td data-label="Besøg" class="num">${int(d.visits)}</td><td data-label="Unikke browsere" class="num">${int(d.uniqueVisitors)}</td><td data-label="Sidevisninger" class="num">${int(d.pageviews)}</td></tr>`)}
      </tbody></table></div></details>
    </section>

    <div class="grid grid-2">
      ${breakdown('Lande', r.countries, t.visits, countryName)}
      ${breakdown('Byer og områder', r.cities, t.visits)}
    </div>
    <p class="small muted">Geografi er et omtrentligt netværksområde, ikke en besøgendes adresse. VPN og mobilnet kan vise et andet område; manglende oplysninger vises som ukendte.</p>
    <div class="grid grid-2">
      ${breakdown('Trafikkilder', r.sources, t.visits, sourceName)}
      ${breakdown('Enheder', r.devices, t.visits, deviceName)}
    </div>

    <section class="card stack"><h2 style="margin:0">Mest viste sider</h2>
      ${r.pages.length ? html`<div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Side</th><th scope="col" class="num">Visninger</th><th scope="col" class="num">Aktiv tid i alt</th><th scope="col" class="num">Gns. rulledybde</th></tr></thead><tbody>
        ${r.pages.map(p => html`<tr><td data-label="Side"><span class="cell">${p.path}</span></td><td data-label="Visninger" class="num">${int(p.pageviews)}</td><td data-label="Aktiv tid i alt" class="num">${duration(p.activeSeconds)}</td><td data-label="Gns. rulledybde" class="num">${decimal(p.averageScrollDepth)} %</td></tr>`)}
      </tbody></table></div>` : html`<p class="empty">Ingen målte sidevisninger i perioden.</p>`}
      <p class="small muted" style="margin-bottom:0">Rulledybde viser, hvor langt ned på siden browseren har været. Det er ikke et bevis på, at indholdet er læst.</p>
    </section>

    <details class="card"><summary>Landingssider, seneste sider og browsere</summary><div class="stack-lg">
      <p class="small muted">En seneste side kan stadig være åben. Den er ikke nødvendigvis en afsluttet udgang fra hjemmesiden.</p>
      <div class="grid grid-2">${breakdown('Første side i besøget', r.entryPages, t.visits)}${breakdown('Seneste side i besøget', r.exitPages, t.visits)}</div>
      ${breakdown('Browsere', r.browsers, t.visits, v => v && v !== 'unknown' ? v : 'Ukendt browser')}
    </div></details>

    <section class="card stack"><div class="row between"><h2 style="margin:0">Seneste besøgsforløb</h2><span class="small muted">Op til 50 besøg i perioden</span></div>
      <p class="small muted">Åbn et besøg for at følge de registrerede sider i rækkefølge.</p>
      ${r.recentSessions.length ? sessionRows(r.recentSessions) : html`<p class="empty">Besøgsforløb vises her, når der er data.</p>`}
    </section>

    <section class="card stack"><h2 style="margin:0">Sådan skal tallene læses</h2>
      <dl class="facts" style="margin-top:0">
        <div><dt>Alle sidevisninger i perioden</dt><dd>${int(r.allPageviews)}</dd><p class="small muted" style="margin:6px 0 0">Den eksisterende tæller uden statistikcookies. Det er sidekald, ikke unikke mennesker, og dagsgrænserne er UTC.</p></div>
        <div><dt>Målte sidevisninger med samtykke</dt><dd>${int(t.pageviews)}</dd><p class="small muted" style="margin:6px 0 0">Indgår i besøgsforløb, geografien og browserstatistikken ovenfor.</p></div>
      </dl>
      <ul><li>En browser kan have flere besøg. Samme person på flere enheder kan tælle flere gange.</li><li>En tilbagevendende browser har et tidligere registreret besøg inden for den gemte historik. Slettede cookies og privat browsing kan få den til at se ny ud.</li><li>Detaljer gemmes i op til 90 dage. Statistikblokering, afvist samtykke og lukkede faner kan give huller i målingen.</li><li>Der gemmes ikke IP-adresser, formularindhold eller navne i denne besøgsoversigt.</li></ul>
      ${r.firstRecordedAt ? html`<p class="small muted" style="margin-bottom:0">Første registrerede besøg i den gemte historik: ${formatDateTime(r.firstRecordedAt)}.</p>` : ''}
    </section>
  </div>`;
}

export function visitorSessionPage({ session: s, pages }: AnalyticsSessionDetail): H {
  return html`<div class="stack-lg">
    <div><p class="eyebrow"><a href="/admin/besoegende">← Besøgende</a></p><h1>Besøgsforløb</h1><p class="lead" style="margin-bottom:0">Et registreret besøg fra ${formatDateTime(s.startedAt)}. Forløbet viser browseraktivitet, ikke en identificeret person.</p></div>
    <div class="grid kpi-grid">
      ${metric('Sidevisninger', int(s.pageviews), 'I dette besøg')}
      ${metric('Aktiv tid', duration(s.activeSeconds), 'Målt aktivitet i browseren')}
      ${metric('Registreret tidsrum', duration(s.lastSeenAt - s.startedAt), 'Fra første til seneste registrering')}
      ${metric('Besøgstype', s.returning ? 'Genbesøg' : 'Ny browser', 'Baseret på den gemte statistikcookie')}
    </div>
    <section class="card"><h2>Om besøget</h2><dl class="facts">
      <div><dt>Omtrentligt område</dt><dd>${location(s)}</dd></div>
      <div><dt>Trafikkilde</dt><dd style="overflow-wrap:anywhere">${sourceName(s.source)}</dd></div>
      <div><dt>Enhed og browser</dt><dd>${deviceName(s.device)} · ${s.browser && s.browser !== 'unknown' ? s.browser : 'Ukendt browser'} · ${s.os && s.os !== 'unknown' ? s.os : 'Ukendt system'}</dd></div>
      <div><dt>Senest registreret</dt><dd>${formatDateTime(s.lastSeenAt)}</dd></div>
      <div><dt>Første side</dt><dd style="overflow-wrap:anywhere">${s.entryPath}</dd></div>
      <div><dt>Seneste side</dt><dd style="overflow-wrap:anywhere">${s.exitPath}</dd></div>
    </dl></section>
    <section class="card stack"><h2 style="margin:0">Sider i rækkefølge</h2>
      ${pages.length < s.pageviews ? html`<p class="small muted">De første ${int(pages.length)} af ${int(s.pageviews)} sidevisninger vises her.</p>` : ''}
      <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Trin</th><th scope="col">Tidspunkt</th><th scope="col">Side</th><th scope="col" class="num">Aktiv tid</th><th scope="col" class="num">Rulledybde</th></tr></thead><tbody>
        ${pages.map((p, i) => html`<tr><td data-label="Trin">${i + 1}</td><td data-label="Tidspunkt"><span class="cell">${formatDateTime(p.viewedAt)}</span></td><td data-label="Side"><span class="cell">${p.path}</span></td><td data-label="Aktiv tid" class="num">${duration(p.activeSeconds)}</td><td data-label="Rulledybde" class="num">${decimal(p.scrollDepth)} %</td></tr>`)}
      </tbody></table></div>
      <p class="small muted" style="margin-bottom:0">Et besøg slutter efter 30 minutters inaktivitet. Den sidste registrerede side kan stadig være åben. Et browserluk eller et forbindelsesbrud kan betyde, at den sidste aktivitet mangler.</p>
    </section>
    <a class="btn btn-secondary" href="/admin/besoegende">Tilbage til besøgsoversigten</a>
  </div>`;
}
