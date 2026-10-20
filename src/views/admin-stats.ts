// Statistik i admin: nøgletal med sammenligning, grafer pr. dag og Excel-download.
import { html, raw } from 'hono/html';
import { formatDateTime, formatKr } from '../lib/format';
import { change, PERIOD_DAYS, type Period, type Snapshot, type Stats } from '../lib/stats';
import { LEAD_KIND_LABEL, type LeadKind } from '../site/leads';
import { alert, type H } from './layout';

const dayLabel = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayLabel.format(new Date(Date.UTC(y!, m! - 1, d!)));
}

const int = (n: number) => n.toLocaleString('da-DK');
const kr = (oere: number) => formatKr(Math.round(oere / 100) * 100);
const pct = (x: number) => `${(x * 100).toLocaleString('da-DK', { maximumFractionDigits: 1 })} %`;

function delta(now: number, before: number): H | string {
  const c = change(now, before);
  if (c === null) return now ? html`<span class="delta">ny</span>` : '';
  if (Math.abs(c) < 0.005) return html`<span class="delta">0 %</span>`;
  const up = c > 0;
  return html`<span class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${pct(Math.abs(c))}<span class="visually-hidden"> ${up ? 'op' : 'ned'} i forhold til perioden før</span></span>`;
}

function tile(label: string, value: string, now: number | null, before: number | null, note?: string): H {
  return html`<div class="card kpi"><div class="muted small">${label}</div><div class="kpi__value">${value}</div>
    <div class="small muted">${now !== null && before !== null ? delta(now, before) : ''}${note ? html` ${note}` : ''}</div></div>`;
}

/** Søjle med afrundede hjørner i toppen og flad bund på nul-linjen */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x.toFixed(1)},${(y + h).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)}V${(y + h).toFixed(1)}Z`;
}

/** Nice-tal til y-aksen */
function niceMax(v: number): number {
  if (v <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/**
 * Linjegraf for perioden med perioden før som stiplet linje. Ren SVG (virker uden JavaScript);
 * /static/app.js tilføjer en krydslinje og et tooltip, når musen er over grafen.
 */
function chart(args: { id: string; title: string; kind?: 'line' | 'bar'; days: string[]; current: number[]; previous: number[]; format: (n: number) => string; axis: (n: number) => string }): H {
  const W = 640, H = 220, L = 44, R = 12, T = 12, B = 28;
  const n = args.days.length;
  const max = niceMax(Math.max(...args.current, ...args.previous.slice(0, n), 0));
  const bars = args.kind === 'bar';
  const band = (W - L - R) / Math.max(1, n);
  const x = (i: number) => (bars ? L + (i + 0.5) * band : L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1)));
  const barW = Math.max(2, Math.min(14, band - 2));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = (vals: number[]) => vals.slice(0, n).map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${path(args.current)}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const ticks = [0, max / 2, max];
  const labelIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const colW = bars ? band : n <= 1 ? W - L - R : (W - L - R) / (n - 1);
  const total = args.current.reduce((s, v) => s + v, 0);
  return html`<figure class="chart" aria-labelledby="${args.id}-t">
    <figcaption class="row between"><h3 id="${args.id}-t" style="margin:0">${args.title}</h3>
      <span class="chart__legend small muted"><span class="lg lg-now" aria-hidden="true"></span>Perioden <span class="lg lg-prev" aria-hidden="true"></span>Perioden før</span></figcaption>
    <svg class="chart__svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${args.title}: i alt ${args.format(total)}" data-chart>
      ${ticks.map((t) => html`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${args.axis(t)}</text>`)}
      ${labelIdx.map((i) => html`<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${fmtDay(args.days[i]!)}</text>`)}
      ${args.previous.some((v) => v) ? html`<path class="prev" d="${path(args.previous)}"/>` : ''}
      ${bars
        ? args.current.map((v, i) => (v > 0 ? html`<path class="bar" d="${barPath(x(i) - barW / 2, y(v), barW, y(0) - y(v))}"/>` : ''))
        : html`<path class="area" d="${area}"/><path class="now" d="${path(args.current)}"/>`}
      <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" hidden/>
      <circle class="dot" r="4" cx="0" cy="0" hidden/>
      ${args.days.map((d, i) => {
        const tip = `${fmtDay(d)}: ${args.format(args.current[i] ?? 0)}${args.previous[i] !== undefined ? ` · før: ${args.format(args.previous[i]!)}` : ''}`;
        return html`<rect class="hit" x="${Math.max(L, x(i) - colW / 2)}" y="${T}" width="${Math.min(colW, W - R - Math.max(L, x(i) - colW / 2))}" height="${H - T - B}" data-x="${x(i)}" data-y="${y(args.current[i] ?? 0)}" data-tip="${tip}"><title>${tip}</title></rect>`;
      })}
    </svg>
    <div class="chart__tip" hidden></div>
  </figure>`;
}

export function statsPage(args: { stats: Stats; prev: Stats; snap: Snapshot; months: { key: string; label: string }[] }): H {
  const { stats: s, prev: p, snap } = args;
  const per = s.period;
  const conv = s.views.total ? s.leads.rows.length / s.views.total : 0;
  const convPrev = p.views.total ? p.leads.rows.length / p.views.total : 0;
  const periodOptions: { key: string; label: string }[] = [
    ...PERIOD_DAYS.map((d) => ({ key: String(d), label: d === 365 ? 'Sidste 12 måneder' : `Sidste ${d} dage` })),
    ...args.months,
  ];
  const kinds = Object.entries(s.leads.byKind).sort((a, b) => b[1] - a[1]);
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin">Admin</a></p><h1>Statistik</h1>
    <p class="lead">Besøg, forespørgsler og salg for ${per.label.toLowerCase()} sammenlignet med perioden før.</p></div>

  <form class="row stats-filter" method="get" action="/admin/statistik">
    <label class="visually-hidden" for="periode">Periode</label>
    <select id="periode" name="periode">${periodOptions.map((o) => html`<option value="${o.key}"${o.key === per.key ? raw(' selected') : ''}>${o.label}</option>`)}</select>
    <button class="btn btn-secondary btn-small" type="submit">Vis</button>
    <a class="btn btn-primary btn-small" href="/admin/statistik/excel?periode=${per.key}" download>Download Excel</a>
  </form>

  <div class="grid kpi-grid">
    ${tile('Sidevisninger', int(s.views.total), s.views.total, p.views.total)}
    ${tile('Forespørgsler', int(s.leads.rows.length), s.leads.rows.length, p.leads.rows.length)}
    ${tile('Forespørgsler pr. 100 visninger', (conv * 100).toLocaleString('da-DK', { maximumFractionDigits: 1 }), conv, convPrev)}
    ${tile('Omsætning (betalt)', kr(s.revenue.total), s.revenue.total, p.revenue.total, 'inkl. moms')}
    ${tile('Tilbud sendt', int(s.offers.sent), s.offers.sent, p.offers.sent)}
    ${tile('Nye kunder', int(s.customers.rows.length), s.customers.rows.length, p.customers.rows.length)}
    ${tile('Aktive abonnementer', int(snap.activeSubscriptions), null, null, 'lige nu')}
    ${tile('Fast månedlig omsætning', kr(snap.mrr), null, null, 'lige nu, som i Stripe')}
  </div>
  ${s.revenue.error ? alert('warn', `Kunne ikke hente betalinger fra Stripe (${s.revenue.error}). Omsætningen er vist ud fra de betalinger, kundepanelet selv har registreret.`) : ''}

  <section class="card stack">
    ${chart({ id: 'c-views', title: 'Sidevisninger pr. dag', days: s.days, current: s.views.byDay, previous: p.views.byDay, format: int, axis: (n) => int(Math.round(n)) })}
  </section>
  <section class="card stack">
      ${chart({ id: 'c-leads', title: 'Forespørgsler pr. dag', kind: 'bar', days: s.days, current: s.leads.byDay, previous: p.leads.byDay, format: int, axis: (n) => (Number.isInteger(n) ? int(n) : '') })}
  </section>
  <section class="card stack">
      ${chart({ id: 'c-rev', title: 'Omsætning pr. dag', kind: 'bar', days: s.days, current: s.revenue.byDay, previous: p.revenue.byDay, format: kr, axis: (n) => (n >= 100000 ? `${int(Math.round(n / 100000))}k` : int(Math.round(n / 100))) })}
  </section>

  <div class="grid grid-2">
    <section class="card stack" aria-labelledby="sider-h">
      <h2 id="sider-h" style="margin:0">Mest viste sider</h2>
      ${s.views.byPath.length
        ? html`<table><thead><tr><th scope="col">Side</th><th scope="col" class="num">Visninger</th><th scope="col" class="num">Andel</th></tr></thead><tbody>${s.views.byPath.map(
            (r) => html`<tr><td>${r.path}</td><td class="num">${int(r.views)}</td><td class="num">${s.views.total ? pct(r.views / s.views.total) : ''}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">Ingen besøg i perioden.</p>`}
    </section>
    <section class="card stack" aria-labelledby="kilder-h">
      <h2 id="kilder-h" style="margin:0">Forespørgsler pr. kilde</h2>
      ${kinds.length
        ? html`<table><thead><tr><th scope="col">Kilde</th><th scope="col" class="num">Antal</th></tr></thead><tbody>${kinds.map(
            ([k, n]) => html`<tr><td>${LEAD_KIND_LABEL[k as LeadKind] ?? k}</td><td class="num">${int(n)}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">Ingen forespørgsler i perioden.</p>`}
      <h2 style="margin:0">Betalinger</h2>
      ${s.revenue.rows.length
        ? html`<table class="responsive"><thead><tr><th scope="col">Betalt</th><th scope="col">Kunde</th><th scope="col" class="num">Beløb</th></tr></thead><tbody>${s.revenue.rows
            .slice(-10)
            .reverse()
            .map((r) => html`<tr><td data-label="Betalt">${formatDateTime(r.paidAt)}</td><td data-label="Kunde">${r.customer || r.number || r.id}</td><td data-label="Beløb" class="num">${formatKr(r.total)}</td></tr>`)}</tbody></table>
          ${s.revenue.rows.length > 10 ? html`<p class="small muted">Viser de 10 seneste. Alle står i Excel-filen.</p>` : ''}`
        : html`<p class="empty">Ingen betalinger i perioden.</p>`}
    </section>
  </div>
  <p class="small muted">Sidevisninger tælles uden cookies og uden IP-adresser, så tallet er visninger og ikke unikke besøgende. Omsætning er betalte fakturaer i Stripe efter betalingsdato. Datoer er dansk tid.</p>
</div>`;
}
