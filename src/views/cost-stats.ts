// Internt omkostningsoverblik under Statistik: kundetilgang (TCA), oprettelse, drift og udvikling.
import { html } from 'hono/html';
import { PURPOSE_LABEL, PURPOSE_SHORT, PURPOSES, formatMinutes, subjectKey, type Bucket, type CostFilter, type CostSummary } from '../lib/costs';
import { formatDate, formatKr } from '../lib/format';
import { staffName } from '../lib/prospects';
import { bucketTable } from './costs';
import { alert, csrfField, type H } from './layout';

export interface Revenue {
  ok: boolean;
  error: string | null;
  invoiced: number; // øre ekskl. moms
  paid: number; // øre ekskl. moms
  count: number;
}

const kr = (o: number) => formatKr(o, { decimals: true });
const dk = (day: string | null) => (day ? day.split('-').reverse().join('.') : '');

function tile(label: string, value: string, note?: H | string): H {
  return html`<div class="card kpi"><div class="muted small">${label}</div><div class="kpi__value">${value}</div>${note ? html`<div class="small muted">${note}</div>` : ''}</div>`;
}

export function costOverviewPage(a: {
  csrf: string;
  filter: CostFilter;
  period: { key: string; from: string | null; to: string | null };
  staff: string[];
  subjects: { key: string; label: string }[];
  all: CostSummary;
  sales: CostSummary;
  lost: Bucket;
  won: { id: number; company: string; at: number }[];
  revenue: Revenue;
  rate: number;
  flash: string | null;
  error: string | null;
  query: string;
}): H {
  const f = a.filter;
  const periodText = a.period.from || a.period.to ? `${dk(a.period.from) || 'start'} – ${dk(a.period.to) || 'i dag'}` : 'hele perioden';
  const cac = a.won.length ? Math.round(a.sales.totals.total / a.won.length) : null;
  const opts: [string, string][] = [['alt', 'Hele perioden'], ['maaned', 'Denne måned'], ['30', 'Sidste 30 dage'], ['90', 'Sidste 90 dage'], ['aar', 'I år'], ['365', 'Sidste 12 måneder'], ['egen', 'Valgfri periode']];
  const contribution = a.revenue.ok ? a.revenue.paid - a.all.totals.total : null;
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin/statistik">← Statistik</a></p><h1>Omkostningsoverblik</h1>
    <p class="lead">Intern tidsværdi og eksterne udgifter på kundeemner og kunder. Bruges til at følge kundetilgang (TCA) og kundeøkonomi. Ikke et regnskab.</p></div>
  ${a.flash === 'sats' ? alert('ok', 'Standardsatsen er gemt. Den gælder for nye registreringer; eksisterende registreringer beholder deres egen sats.') : ''}
  ${a.error ? alert('err', a.error) : ''}
  <form method="get" action="/admin/statistik/omkostninger" class="card stack">
    <div class="grid grid-3">
      <div class="field"><label for="cs-p">Periode</label><select id="cs-p" name="periode">${opts.map(([k, l]) => html`<option value="${k}"${a.period.key === k ? html` selected` : ''}>${l}</option>`)}</select></div>
      <div class="field"><label for="cs-f">Fra (valgfri periode)</label><input id="cs-f" name="fra" type="date" value="${a.period.key === 'egen' ? a.period.from ?? '' : ''}"></div>
      <div class="field"><label for="cs-t">Til</label><input id="cs-t" name="til" type="date" value="${a.period.key === 'egen' ? a.period.to ?? '' : ''}"></div>
      <div class="field"><label for="cs-s">Medarbejder</label><select id="cs-s" name="medarbejder"><option value="">Alle</option>${a.staff.map((s) => html`<option value="${s}"${f.staff === s ? html` selected` : ''}>${staffName(s)}</option>`)}</select></div>
      <div class="field"><label for="cs-k">Kategori</label><select id="cs-k" name="kategori"><option value="">Alle</option>${PURPOSES.map((p) => html`<option value="${p}"${f.purpose === p ? html` selected` : ''}>${PURPOSE_LABEL[p]}</option>`)}</select></div>
      <div class="field"><label for="cs-e">Kunde eller kundeemne</label><select id="cs-e" name="emne"><option value="">Alle</option>${a.subjects.map((s) => html`<option value="${s.key}"${f.subject && subjectKey(f.subject) === s.key ? html` selected` : ''}>${s.label}</option>`)}</select></div>
    </div>
    <div class="row"><button class="btn btn-primary btn-small" type="submit">Vis</button><a class="small" href="/admin/statistik/omkostninger">Nulstil</a>
      <a class="small" href="/admin/omkostninger/eksport.csv${a.query ? `?${a.query}` : ''}">Download tid og omkostninger (CSV)</a><a class="small" href="/admin/omkostninger/faelles">Fælles udgifter</a></div>
  </form>

  <section class="stack">
    <h2>Fordelt på formål · ${periodText}</h2>
    <div class="grid kpi-grid">${PURPOSES.map((p) => tile(PURPOSE_SHORT[p], kr(a.all.byPurpose[p].total), `${formatMinutes(a.all.byPurpose[p].minutes)} + ${kr(a.all.byPurpose[p].expenses)} udgifter`))}</div>
    ${bucketTable([...PURPOSES.map((p): [string, Bucket] => [PURPOSE_SHORT[p], a.all.byPurpose[p]]), ['I alt', a.all.totals]])}
    ${a.all.expected.length ? html`<p class="hint">Forventede, ikke registrerede perioder af tilbagevendende udgifter (${kr(a.all.expected.reduce((s, e) => s + e.amount, 0))}) er ikke talt med.</p>` : ''}
  </section>

  <section class="card stack">
    <h2 style="margin:0">Kundetilgang (TCA)</h2>
    <div class="grid kpi-grid">
      ${tile('Samlet salgsindsats', kr(a.sales.totals.total), `${formatMinutes(a.sales.totals.minutes)} · ${kr(a.sales.totals.expenses)} udgifter`)}
      ${tile('Heraf på emner med afslag', kr(a.lost.total), `${formatMinutes(a.lost.minutes)} · ${kr(a.lost.expenses)} udgifter`)}
      ${tile('Vundne kunder', String(a.won.length), periodText)}
      ${tile('Anskaffelsesomkostning pr. vundet kunde', cac === null ? 'Ingen vundne kunder' : kr(cac), cac === null ? 'Beregnes ikke uden vundne kunder' : `${kr(a.sales.totals.total)} / ${a.won.length}`)}
    </div>
    <dl class="small" style="margin:0">
      <dt><strong>Salgsindsats</strong></dt><dd style="margin:0 0 8px">Al tid og alle udgifter med formålet "${PURPOSE_LABEL.salg}" i perioden (${periodText}) på alle kundeemner og kunder, både vundne, tabte og åbne${f.staff ? `, registreret af ${staffName(f.staff)}` : ''}${f.subject ? ', for det valgte emne' : ''}. Formålet afgør kategorien, ikke datoen.</dd>
      <dt><strong>Vundne kunder</strong></dt><dd style="margin:0 0 8px">Kundeemner, der i perioden fik en faktisk kundetilknytning og har status "Blev kunde".</dd>
      <dt><strong>Anskaffelsesomkostning pr. vundet kunde</strong></dt><dd style="margin:0">Tæller: samlet salgsindsats i perioden (${kr(a.sales.totals.total)}). Nævner: antal vundne kunder i perioden (${a.won.length}). Vises ikke ved nul vundne kunder. Salgsarbejde kan ligge i en anden periode end vundet-datoen; vælg en længere periode for et mere retvisende tal.</dd>
    </dl>
    ${a.won.length ? html`<details><summary>Vundne kunder i perioden (${a.won.length})</summary><ul>${a.won.map((w) => html`<li><a href="/admin/kundeemner/${w.id}">${w.company}</a> · ${formatDate(w.at)}</li>`)}</ul></details>` : ''}
  </section>

  <section class="card stack">
    <h2 style="margin:0">Oprettelse, drift og udvikling</h2>
    <div class="grid kpi-grid">
      ${tile('Omkostning ved oprettelse', kr(a.all.byPurpose.oprettelse.total))}
      ${tile('Løbende drift og support', kr(a.all.byPurpose.drift.total))}
      ${tile('Ekstra udvikling', kr(a.all.byPurpose.udvikling.total))}
      ${tile('Løbende kundeomkostninger i alt', kr(a.all.byPurpose.drift.total + a.all.byPurpose.udvikling.total), 'Drift og support + ekstra udvikling')}
    </div>
  </section>

  <section class="card stack">
    <h2 style="margin:0">Faktureret, betalt og kalkuleret bidrag</h2>
    ${a.revenue.ok
      ? html`<div class="grid kpi-grid">
          ${tile('Faktureret ekskl. moms', kr(a.revenue.invoiced), `${a.revenue.count} fakturaer udstedt i perioden`)}
          ${tile('Betalt ekskl. moms', kr(a.revenue.paid), 'Betalt i perioden')}
          ${tile('Kalkulerede omkostninger', kr(a.all.totals.total), 'Tidsværdi + registrerede udgifter')}
          ${tile('Kalkuleret bidrag', kr(contribution!), 'Betalt ekskl. moms − kalkulerede omkostninger')}
        </div>
        <p class="hint" style="margin:0">Fra Stripe. Alle tal er ekskl. moms. Kalkuleret bidrag er beregnet ud fra registreringerne her og er ikke virksomhedens fulde regnskabsresultat. Tidsværdien er en intern sats, ikke lønudgift.</p>`
      : html`<p class="small muted" style="margin:0">${a.revenue.error}</p>`}
  </section>

  <section class="card stack">
    <h2 style="margin:0">Fordelt på medarbejdere</h2>
    ${Object.keys(a.all.byStaff).length ? bucketTable(Object.entries(a.all.byStaff).map(([k, b]): [string, Bucket] => [staffName(k), b]), 'Medarbejder') : html`<p class="empty">Ingen registreringer.</p>`}
    <p class="hint" style="margin:0">Udgifter tælles hos den, der har registreret dem.</p>
  </section>

  <section class="card stack">
    <h2 style="margin:0">Standard-timesats</h2>
    <form method="post" action="/admin/omkostninger/indstillinger" class="row">${csrfField(a.csrf)}
      <label for="rate">Kr. pr. time ekskl. moms</label><input id="rate" name="rate" type="text" inputmode="decimal" value="${(a.rate / 100).toFixed(2).replace('.', ',')}" style="width:140px">
      <button class="btn btn-secondary btn-small" type="submit">Gem</button></form>
    <p class="hint" style="margin:0">Bruges som forslag ved nye registreringer. Hver registrering gemmer sin egen sats, så en ændring her ændrer ikke historiske beregninger. Satsen er en intern tidsværdi, ikke en dokumenteret lønudbetaling eller faktureringspris.</p>
  </section>
</div>`;
}
