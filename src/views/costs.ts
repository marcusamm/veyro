// Internt: Tid og omkostninger (på kundeemner og kundekort) og fælles udgifter. Kun admin.
import { html } from 'hono/html';
import {
  EXPENSE_TYPE_LABEL,
  EXPENSE_TYPES,
  INTERVAL_LABEL,
  INTERVALS,
  PURPOSE_LABEL,
  PURPOSE_SHORT,
  PURPOSES,
  formatMinutes,
  subjectKey,
  type AllocationRow,
  type Bucket,
  type CostSummary,
  type ExpenseRow,
  type HistoryRow,
  type Subject,
} from '../lib/costs';
import { formatDateShort, formatDateTime, formatKr } from '../lib/format';
import { staffName } from '../lib/prospects';
import { alert, csrfField, type H } from './layout';

const kr = (o: number) => formatKr(o, { decimals: true });
const rateInput = (o: number) => (o / 100).toFixed(2).replace('.', ',');
const dk = (day: string) => {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
};

export const COST_FLASH: Record<string, string> = {
  'tid-gemt': 'Tidsregistreringen er gemt.',
  'tid-rettet': 'Tidsregistreringen er rettet.',
  'tid-slettet': 'Tidsregistreringen er slettet. Den står stadig i ændringshistorikken.',
  'udgift-gemt': 'Udgiften er gemt.',
  'udgift-rettet': 'Udgiften er rettet.',
  'udgift-slettet': 'Udgiften er slettet. Den står stadig i ændringshistorikken.',
  'periode-gemt': 'Perioden er registreret som afholdt.',
  'periode-findes': 'Perioden var allerede registreret. Den er ikke talt med to gange.',
  'periode-slettet': 'Registreringen af perioden er fjernet.',
  'fordeling-gemt': 'Fordelingen er gemt.',
  'fordeling-slettet': 'Fordelingen er fjernet.',
};

function staffSelect(name: string, id: string, staff: string[], selected: string): H {
  return html`<select id="${id}" name="${name}" required>${staff.map((s) => html`<option value="${s}"${s === selected ? html` selected` : ''}>${staffName(s)} (${s})</option>`)}</select>`;
}

function purposeSelect(name: string, id: string, selected: string): H {
  return html`<select id="${id}" name="${name}" required>${PURPOSES.map((p) => html`<option value="${p}"${p === selected ? html` selected` : ''}>${PURPOSE_LABEL[p]}</option>`)}</select>`;
}

function bucketCells(b: Bucket): H {
  return html`<td class="num" data-label="Tid">${formatMinutes(b.minutes)}</td><td class="num" data-label="Tidsværdi">${kr(b.timeValue)}</td><td class="num" data-label="Udgifter">${kr(b.expenses)}</td><td class="num" data-label="I alt"><strong>${kr(b.total)}</strong></td>`;
}

export function bucketTable(rows: [string, Bucket][], firstCol = 'Kategori'): H {
  return html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th scope="col">${firstCol}</th><th scope="col" class="num">Tid</th><th scope="col" class="num">Tidsværdi</th><th scope="col" class="num">Eksterne udgifter</th><th scope="col" class="num">I alt</th></tr></thead>
    <tbody>${rows.map(([label, b]) => html`<tr><td data-label="${firstCol}">${label}</td>${bucketCells(b)}</tr>`)}</tbody></table></div>`;
}

function timeForm(args: { action: string; csrf: string; back: string; staff: string[]; me: string; today: string; rate: number; entry?: CostSummary['time'][number]; idp: string }): H {
  const e = args.entry;
  const v = (k: string, d: string) => (e ? String((e as any)[k] ?? '') : d);
  return html`<form method="post" action="${args.action}" class="stack">
    ${csrfField(args.csrf)}<input type="hidden" name="back" value="${args.back}">${e ? html`<input type="hidden" name="version" value="${e.version}">` : ''}
    <div class="grid grid-3">
      <div class="field"><label for="${args.idp}-date">Dato for arbejdet</label><input id="${args.idp}-date" name="work_date" type="date" required value="${v('work_date', args.today)}"></div>
      <div class="field"><label for="${args.idp}-staff">Medarbejder</label>${staffSelect('staff', `${args.idp}-staff`, args.staff, e?.staff ?? args.me)}</div>
      <div class="field"><label for="${args.idp}-cat">Kategori</label>${purposeSelect('category', `${args.idp}-cat`, e?.category ?? '')}</div>
      <div class="field"><label for="${args.idp}-h">Timer</label><input id="${args.idp}-h" name="hours" type="number" inputmode="numeric" min="0" max="24" step="1" value="${e ? Math.floor(e.minutes / 60) : ''}" placeholder="0"></div>
      <div class="field"><label for="${args.idp}-m">Minutter</label><input id="${args.idp}-m" name="minutes" type="number" inputmode="numeric" min="0" max="1440" step="1" value="${e ? e.minutes % 60 : ''}" placeholder="30"></div>
      <div class="field"><label for="${args.idp}-rate">Intern timesats (kr. ekskl. moms)</label><input id="${args.idp}-rate" name="rate" type="text" inputmode="decimal" maxlength="12" value="${rateInput(e ? e.rate : args.rate)}"></div>
    </div>
    <div class="field"><label for="${args.idp}-desc">Beskrivelse</label><input id="${args.idp}-desc" name="description" type="text" required maxlength="1000" value="${v('description', '')}" placeholder="Fx Opringning og opfølgning på tilbud"></div>
    <p class="hint">Kategorien er arbejdets formål, ikke datoen. Satsen gemmes på registreringen, så en senere ændring af standardsatsen ikke ændrer historikken. Satsen er en intern tidsværdi, ikke en lønudbetaling eller en faktureringspris.</p>
    <div class="row"><button class="btn btn-primary btn-small" type="submit">${e ? 'Gem rettelse' : 'Registrér tid'}</button></div>
  </form>`;
}

function expenseForm(args: { action: string; csrf: string; back: string; staff: string[]; me: string; today: string; idp: string; entry?: ExpenseRow; shared?: boolean }): H {
  const e = args.entry;
  return html`<form method="post" action="${args.action}" class="stack" enctype="multipart/form-data">
    ${csrfField(args.csrf)}<input type="hidden" name="back" value="${args.back}">${e ? html`<input type="hidden" name="version" value="${e.version}">` : ''}
    <div class="grid grid-3">
      <div class="field"><label for="${args.idp}-date">Dato (startdato hvis tilbagevendende)</label><input id="${args.idp}-date" name="spent_on" type="date" required value="${e?.spent_on ?? args.today}"></div>
      <div class="field"><label for="${args.idp}-amount">Beløb (kr. ekskl. moms)</label><input id="${args.idp}-amount" name="amount" type="text" inputmode="decimal" required maxlength="15" value="${e ? rateInput(e.amount) : ''}" placeholder="50,00"></div>
      <div class="field"><label for="${args.idp}-type">Type</label><select id="${args.idp}-type" name="type" required>${EXPENSE_TYPES.map((t) => html`<option value="${t}"${e?.type === t ? html` selected` : ''}>${EXPENSE_TYPE_LABEL[t]}</option>`)}</select></div>
      <div class="field"><label for="${args.idp}-purpose">Formål</label>${purposeSelect('purpose', `${args.idp}-purpose`, e?.purpose ?? '')}</div>
      <div class="field"><label for="${args.idp}-supplier">Leverandør (valgfri)</label><input id="${args.idp}-supplier" name="supplier" type="text" maxlength="150" value="${e?.supplier ?? ''}"></div>
      <div class="field"><label for="${args.idp}-by">Registreret af</label>${staffSelect('registered_by', `${args.idp}-by`, args.staff, e?.registered_by ?? args.me)}</div>
    </div>
    <div class="field"><label for="${args.idp}-desc">Beskrivelse</label><input id="${args.idp}-desc" name="description" type="text" required maxlength="500" value="${e?.description ?? ''}" placeholder="Fx Domæne firma.dk (1 år)"></div>
    ${args.shared ? html`<div class="field"><label for="${args.idp}-basis">Fordelingsgrundlag</label><input id="${args.idp}-basis" name="basis" type="text" maxlength="300" required placeholder="Fx Ligeligt på de tre kunder på samme server"></div>` : ''}
    <fieldset class="stack-xs">
      <label class="row" style="gap:8px;font-weight:500"><input type="checkbox" name="recurring" value="1" style="width:20px;height:20px"${e?.recurring ? html` checked` : ''}> Tilbagevendende udgift</label>
      <div class="grid grid-2">
        <div class="field"><label for="${args.idp}-int">Interval</label><select id="${args.idp}-int" name="interval">${INTERVALS.map((i) => html`<option value="${i}"${e?.interval === i ? html` selected` : ''}>${INTERVAL_LABEL[i]}</option>`)}</select></div>
        <div class="field"><label for="${args.idp}-end">Slutdato (valgfri)</label><input id="${args.idp}-end" name="end_on" type="date" value="${e?.end_on ?? ''}"></div>
      </div>
      <p class="hint">En tilbagevendende udgift viser hver periode som <em>forventet</em>, indtil den er registreret som afholdt. Hver periode kan kun registreres én gang, så den aldrig tælles dobbelt.</p>
    </fieldset>
    ${e ? '' : html`<div class="field"><label for="${args.idp}-file">Bilag (valgfrit: PDF, PNG, JPG, højst 2 MB)</label><input id="${args.idp}-file" name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp"></div>`}
    <div class="row"><button class="btn btn-primary btn-small" type="submit">${e ? 'Gem rettelse' : 'Registrér udgift'}</button></div>
  </form>`;
}

const ACTION_LABEL: Record<string, string> = { oprettet: 'Oprettet', rettet: 'Rettet', slettet: 'Slettet' };
const ENTITY_LABEL: Record<string, string> = { time: 'Tid', expense: 'Udgift', period: 'Periode', allocation: 'Fordeling', setting: 'Indstilling' };

function historyText(h: HistoryRow): string {
  try {
    const b = h.before ? JSON.parse(h.before) : null;
    const a = h.after ? JSON.parse(h.after) : null;
    const show = (x: any) =>
      x
        ? [
            x.work_date ?? x.spent_on ?? x.period,
            x.minutes ? formatMinutes(x.minutes) : null,
            x.rate !== undefined ? `${kr(x.rate)}/t` : null,
            x.amount !== undefined ? kr(x.amount) : null,
            x.category ? PURPOSE_SHORT[x.category as keyof typeof PURPOSE_SHORT] : x.purpose ? PURPOSE_SHORT[x.purpose as keyof typeof PURPOSE_SHORT] : null,
          ]
            .filter(Boolean)
            .join(', ')
        : '';
    if (h.action === 'rettet') return `${show(b)} → ${show(a)}`;
    return show(a ?? b);
  } catch {
    return '';
  }
}

export interface CostSectionArgs {
  csrf: string;
  subject: Subject;
  title: string;
  summary: CostSummary;
  history: (HistoryRow & { label: string })[];
  staff: string[];
  me: string;
  today: string;
  rate: number;
  back: string;
  period: { key: string; from: string | null; to: string | null };
  /** Kundekortet: poster fra tilknyttede kundeemner (tidligere salgsarbejde) mærkes */
  linkedProspects?: { id: number; company: string }[];
  files?: { id: number; expense_id: number; name: string }[];
  flash?: string | null;
  error?: string | null;
}

export function costSection(a: CostSectionArgs): H {
  const s = a.summary;
  const sk = subjectKey(a.subject);
  const prospectName = new Map((a.linkedProspects ?? []).map((p) => [p.id, p.company]));
  const origin = (pid: number | null) => (a.subject.kind === 'customer' && pid ? html`<br><span class="small muted">Fra kundeemnet ${prospectName.get(pid) ?? `#${pid}`}</span>` : '');
  const periods: [string, string][] = [['alt', 'Hele perioden'], ['maaned', 'Denne måned'], ['30', '30 dage'], ['90', '90 dage'], ['365', '12 måneder']];
  const files = new Map<number, { id: number; name: string }[]>();
  for (const f of a.files ?? []) files.set(f.expense_id, [...(files.get(f.expense_id) ?? []), f]);
  return html`<section class="card stack" id="omkostninger">
  <div class="row between"><h2 style="margin:0">${a.title}</h2><span class="badge b-neutral">Kun for Veyro</span></div>
  ${a.flash && COST_FLASH[a.flash] ? alert('ok', COST_FLASH[a.flash]!) : ''}
  ${a.error ? alert('err', a.error) : ''}
  <p class="hint" style="margin:0">Internt overblik. Vises aldrig i kundepanelet, i mails til kunden eller på fakturaer, og opretter ingen fakturaer eller betalinger.</p>
  <nav class="row tabs" aria-label="Periode">${periods.map(
    ([k, l]) => html`<a class="btn btn-small ${a.period.key === k ? 'btn-primary' : 'btn-secondary'}" href="${a.back}?periode=${k}#omkostninger"${a.period.key === k ? html` aria-current="page"` : ''}>${l}</a>`,
  )}</nav>
  <div class="grid kpi-grid">
    <div class="card kpi"><div class="muted small">Tidsforbrug</div><div class="kpi__value">${formatMinutes(s.totals.minutes)}</div></div>
    <div class="card kpi"><div class="muted small">Tidsværdi</div><div class="kpi__value">${kr(s.totals.timeValue)}</div></div>
    <div class="card kpi"><div class="muted small">Eksterne udgifter</div><div class="kpi__value">${kr(s.totals.expenses)}</div></div>
    <div class="card kpi"><div class="muted small">Samlet kalkuleret omkostning</div><div class="kpi__value">${kr(s.totals.total)}</div></div>
  </div>
  <p class="hint" style="margin:0">Tidsværdi = minutter / 60 × registreringens timesats. Samlet kalkuleret omkostning = tidsværdi + registrerede eksterne udgifter (ekskl. moms).${s.expected.length ? ` Forventede, ikke registrerede perioder (${kr(s.expected.reduce((x, e) => x + e.amount, 0))}) er ikke talt med.` : ''}</p>
  <h3>Fordeling på kategorier</h3>
  ${bucketTable(PURPOSES.map((p) => [PURPOSE_SHORT[p], s.byPurpose[p]]))}
  ${Object.keys(s.byStaff).length ? html`<h3>Fordeling på medarbejdere</h3>${bucketTable(Object.entries(s.byStaff).map(([k, b]) => [staffName(k), b]), 'Medarbejder')}<p class="hint">Udgifter fordeles efter, hvem der har registreret dem.</p>` : ''}

  <details${s.time.length === 0 ? html` open` : ''}><summary>Registrér tid</summary>
    ${timeForm({ action: `/admin/omkostninger/tid?emne=${sk}`, csrf: a.csrf, back: a.back, staff: a.staff, me: a.me, today: a.today, rate: a.rate, idp: 'nt' })}
  </details>
  <details><summary>Registrér udgift</summary>
    ${expenseForm({ action: `/admin/omkostninger/udgift?emne=${sk}`, csrf: a.csrf, back: a.back, staff: a.staff, me: a.me, today: a.today, idp: 'ne' })}
  </details>

  <h3>Tidsregistreringer</h3>
  ${s.time.length === 0
    ? html`<p class="empty">Ingen tid registreret i perioden.</p>`
    : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Dato</th><th scope="col">Medarbejder</th><th scope="col">Kategori</th><th scope="col">Beskrivelse</th><th scope="col" class="num">Tid</th><th scope="col" class="num">Sats</th><th scope="col" class="num">Tidsværdi</th><th scope="col"><span class="visually-hidden">Handlinger</span></th></tr></thead>
      <tbody>${s.time.slice(0, 300).map(
        (t) => html`<tr id="tid-${t.id}">
          <td data-label="Dato">${dk(t.work_date)}</td>
          <td data-label="Medarbejder">${staffName(t.staff)}</td>
          <td data-label="Kategori">${PURPOSE_SHORT[t.category]}</td>
          <td data-label="Beskrivelse">${t.description}${origin(t.prospect_id)}</td>
          <td data-label="Tid" class="num">${formatMinutes(t.minutes)}</td>
          <td data-label="Sats" class="num">${kr(t.rate)}</td>
          <td data-label="Tidsværdi" class="num">${kr(t.value)}</td>
          <td data-label="">
            <details><summary>Ret</summary>
              ${timeForm({ action: `/admin/omkostninger/tid/${t.id}`, csrf: a.csrf, back: a.back, staff: a.staff, me: a.me, today: a.today, rate: a.rate, entry: t, idp: `t${t.id}` })}
              <form method="post" action="/admin/omkostninger/tid/${t.id}/slet" data-confirm="Slet tidsregistreringen? Den bevares i ændringshistorikken." style="margin-top:8px">${csrfField(a.csrf)}<input type="hidden" name="back" value="${a.back}"><button class="btn btn-danger btn-small" type="submit">Slet registrering</button></form>
            </details>
          </td>
        </tr>`,
      )}</tbody></table></div>`}

  <h3>Eksterne udgifter</h3>
  ${s.lines.length === 0 ? html`<p class="empty">Ingen registrerede udgifter i perioden.</p>` : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Dato</th><th scope="col">Beskrivelse</th><th scope="col">Type</th><th scope="col">Formål</th><th scope="col" class="num">Beløb ekskl. moms</th><th scope="col"><span class="visually-hidden">Handlinger</span></th></tr></thead>
      <tbody>${s.lines.map((l) => {
        const own = !l.shared && s.expenses.find((x) => x.id === l.expense_id);
        return html`<tr>
          <td data-label="Dato">${dk(l.date)}</td>
          <td data-label="Beskrivelse">${l.description}${l.supplier ? html`<br><span class="small muted">${l.supplier}</span>` : ''}${l.shared ? html`<br><span class="small muted">Andel af fælles udgift. Grundlag: ${l.basis ?? '–'}</span>` : ''}${origin(l.prospect_id)}
            ${(files.get(l.expense_id) ?? []).map((f) => html`<br><a class="small" href="/admin/omkostninger/bilag/${f.id}">Bilag: ${f.name}</a>`)}</td>
          <td data-label="Type">${EXPENSE_TYPE_LABEL[l.type]}</td>
          <td data-label="Formål">${PURPOSE_SHORT[l.purpose]}</td>
          <td data-label="Beløb" class="num">${kr(l.amount)}</td>
          <td data-label="">${l.period_id && !l.shared
            ? html`<form method="post" action="/admin/omkostninger/periode/${l.period_id}/slet" class="inline" data-confirm="Fjern registreringen af perioden?">${csrfField(a.csrf)}<input type="hidden" name="back" value="${a.back}"><button class="linkbtn small" type="submit">Fjern periode</button></form>`
            : ''}</td>
        </tr>`;
        void own;
      })}</tbody></table></div>`}

  ${s.expected.length
    ? html`<h3>Forventede perioder (ikke registreret)</h3>
      <ul class="list">${s.expected.map(
        (e) => html`<li class="row between"><span>${dk(e.period)} · ${e.description} · ${kr(e.amount)} <span class="badge b-warn">Forventet</span></span>
          <form method="post" action="/admin/omkostninger/udgift/${e.expense_id}/periode" class="row" style="gap:8px">${csrfField(a.csrf)}<input type="hidden" name="back" value="${a.back}"><input type="hidden" name="period" value="${e.period}">
            <label class="visually-hidden" for="pa-${e.expense_id}-${e.period}">Faktisk beløb</label><input id="pa-${e.expense_id}-${e.period}" name="amount" type="text" inputmode="decimal" value="${rateInput(e.amount)}" style="width:120px;min-height:36px;padding:6px 10px">
            <button class="btn btn-secondary btn-small" type="submit">Registrér som afholdt</button></form></li>`,
      )}</ul>`
    : ''}

  ${s.expenses.filter((x) => !x.shared).length
    ? html`<details><summary>Ret eller slet udgiftsposter (${s.expenses.filter((x) => !x.shared).length})</summary><ul class="list">${s.expenses
        .filter((x) => !x.shared)
        .map(
          (x) => html`<li><strong>${x.description}</strong> · ${kr(x.amount)}${x.recurring ? ` ${INTERVAL_LABEL[x.interval ?? 'month'].toLowerCase()} fra ${dk(x.spent_on)}${x.end_on ? ` til ${dk(x.end_on)}` : ''}` : ` · ${dk(x.spent_on)}`}
            <details><summary>Ret</summary>${expenseForm({ action: `/admin/omkostninger/udgift/${x.id}`, csrf: a.csrf, back: a.back, staff: a.staff, me: a.me, today: a.today, idp: `e${x.id}`, entry: x })}
            <form method="post" action="/admin/omkostninger/udgift/${x.id}/slet" data-confirm="Slet udgiften og dens registrerede perioder fra opgørelsen? Den bevares i ændringshistorikken." style="margin-top:8px">${csrfField(a.csrf)}<input type="hidden" name="back" value="${a.back}"><button class="btn btn-danger btn-small" type="submit">Slet udgift</button></form></details></li>`,
        )}</ul></details>`
    : ''}

  <details><summary>Ændringshistorik (${a.history.length})</summary>
    ${a.history.length === 0 ? html`<p class="empty">Ingen ændringer endnu.</p>` : html`<ul class="list">${a.history.map(
      (h) => html`<li class="small"><strong>${ACTION_LABEL[h.action] ?? h.action}</strong> · ${ENTITY_LABEL[h.entity] ?? h.entity}: ${h.label} · ${historyText(h)}<div class="meta">${formatDateTime(h.at)} af ${staffName(h.actor)}</div></li>`,
    )}</ul>`}
  </details>
  <p class="small"><a href="/admin/omkostninger/eksport.csv?emne=${sk}">Download tid og omkostninger (CSV)</a></p>
</section>`;
}

// ---------- Fælles udgifter ----------

export function sharedExpensesPage(args: {
  csrf: string;
  staff: string[];
  me: string;
  today: string;
  expenses: (ExpenseRow & { allocated: number })[];
  allocations: Map<number, (AllocationRow & { name: string | null })[]>;
  subjects: { key: string; label: string }[];
  expected: Map<number, string[]>;
  flash: string | null;
  error: string | null;
}): H {
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin/statistik/omkostninger">← Omkostningsoverblik</a></p><h1>Fælles udgifter</h1>
    <p class="lead">Udgifter, der deles af flere kunder eller kundeemner, fx en fælles server. Fordelingen kan ikke overstige udgiften, og grundlaget står ved hver andel.</p></div>
  ${args.flash && COST_FLASH[args.flash] ? alert('ok', COST_FLASH[args.flash]!) : ''}
  ${args.error ? alert('err', args.error) : ''}
  <section class="card"><h2>Ny fælles udgift</h2>${expenseForm({ action: '/admin/omkostninger/udgift?emne=faelles', csrf: args.csrf, back: '/admin/omkostninger/faelles', staff: args.staff, me: args.me, today: args.today, idp: 'fe', shared: true })}</section>
  ${args.expenses.length === 0
    ? html`<section class="card"><p class="empty">Ingen fælles udgifter.</p></section>`
    : args.expenses.map((x) => {
        const allocs = args.allocations.get(x.id) ?? [];
        const left = x.amount - x.allocated;
        return html`<section class="card stack" id="u-${x.id}">
          <div class="row between"><h2 style="margin:0">${x.description}</h2><span>${kr(x.amount)}${x.recurring ? ` ${INTERVAL_LABEL[x.interval ?? 'month'].toLowerCase()}` : ''}</span></div>
          <p class="small muted" style="margin:0">${EXPENSE_TYPE_LABEL[x.type]} · ${PURPOSE_SHORT[x.purpose]} · ${dk(x.spent_on)}${x.supplier ? ` · ${x.supplier}` : ''} · Grundlag: ${x.basis ?? '–'}</p>
          <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Fordelt på</th><th scope="col" class="num">Andel</th><th scope="col"></th></tr></thead><tbody>
            ${allocs.map((al) => html`<tr><td data-label="Fordelt på">${al.name ?? '–'}</td><td data-label="Andel" class="num">${kr(al.amount)}</td>
              <td><form method="post" action="/admin/omkostninger/fordeling/${al.id}/slet" class="inline">${csrfField(args.csrf)}<input type="hidden" name="back" value="/admin/omkostninger/faelles"><button class="linkbtn small" type="submit">Fjern</button></form></td></tr>`)}
            <tr><td data-label="Ikke fordelt"><em>Ikke fordelt</em></td><td class="num" data-label="Rest">${kr(left)}</td><td></td></tr>
          </tbody></table></div>
          ${left > 0
            ? html`<form method="post" action="/admin/omkostninger/udgift/${x.id}/fordeling" class="row">${csrfField(args.csrf)}<input type="hidden" name="back" value="/admin/omkostninger/faelles">
                <label class="visually-hidden" for="fa-${x.id}">Kunde eller kundeemne</label>
                <select id="fa-${x.id}" name="emne" required style="width:auto;min-width:220px"><option value="">Vælg kunde eller kundeemne</option>${args.subjects.map((s) => html`<option value="${s.key}">${s.label}</option>`)}</select>
                <label class="visually-hidden" for="fb-${x.id}">Andel i kr.</label><input id="fb-${x.id}" name="amount" type="text" inputmode="decimal" required placeholder="Andel i kr." style="width:140px">
                <button class="btn btn-secondary btn-small" type="submit">Fordel</button></form>`
            : ''}
          ${x.recurring
            ? html`<p class="hint">Andelene beregnes af hver registreret periode. Forventede perioder tælles først med, når de er registreret som afholdt.</p>
              ${(args.expected.get(x.id) ?? []).map((d) => html`<form method="post" action="/admin/omkostninger/udgift/${x.id}/periode" class="row" style="gap:8px">${csrfField(args.csrf)}<input type="hidden" name="back" value="/admin/omkostninger/faelles"><input type="hidden" name="period" value="${d}">
                <span>${dk(d)} <span class="badge b-warn">Forventet</span></span><label class="visually-hidden" for="sp-${x.id}-${d}">Faktisk beløb</label><input id="sp-${x.id}-${d}" name="amount" type="text" inputmode="decimal" value="${rateInput(x.amount)}" style="width:120px;min-height:36px;padding:6px 10px">
                <button class="btn btn-secondary btn-small" type="submit">Registrér som afholdt</button></form>`)}`
            : ''}
          <form method="post" action="/admin/omkostninger/udgift/${x.id}/slet" data-confirm="Slet den fælles udgift og dens fordeling fra opgørelsen?" class="inline">${csrfField(args.csrf)}<input type="hidden" name="back" value="/admin/omkostninger/faelles"><button class="btn btn-danger btn-small" type="submit">Slet udgift</button></form>
        </section>`;
      })}
</div>`;
}
