import { html } from 'hono/html';
import type { JobRow, JobStage, User } from '../env';
import type { ProductOverview } from '../lib/catalog';
import type { RetailerView } from '../lib/estimates';
import { formatDay, formatKr, formatQty, lineAmount, qtyInput, qtyUnit } from '../lib/format';
import { retailerLive } from '../lib/jobitems';
import { STAGES, STAGE_LABEL, STAGE_TAG } from '../lib/jobs';
import type { MaterialView } from '../lib/materials';
import { lineStatus, listStatus, outstanding, type LineView, type ListOverview } from '../lib/purchasing';
import { errors, flash, lineTag, pageHead, stockTag } from './common';
import { alert, csrfField, opField, type H } from './layout';

export type JobListRow = JobRow & {
  mat_count: number;
  waiting_count: number;
  responsible_name: string | null;
  staff_names: string | null;
  quote_subtotal: number | null;
  quote_version: number | null;
  quote_incomplete: number | null;
  hours: number;
  hours_expected: number;
  used_lines: number;
  mat_cost: number;
  inv_issued: number;
  inv_drafts: number;
  inv_credits: number;
  inv_total: number;
};

export function stageTag(stage: JobStage): H {
  return html`<span class="tag ${STAGE_TAG[stage]}">${STAGE_LABEL[stage]}</span>`;
}

export function billingTag(r: Pick<JobListRow, 'inv_issued' | 'inv_drafts' | 'inv_credits'>): H {
  if (r.inv_issued > 0) return html`<span class="tag tag-ok">Faktureret</span>${r.inv_drafts ? html`<small>Ny kladde</small>` : r.inv_credits ? html`<small>Krediteret</small>` : ''}`;
  return r.inv_drafts ? html`<span class="tag tag-ready">Fakturakladde</span>` : html`<span class="tag tag-off">Ikke faktureret</span>`;
}

function period(j: Pick<JobRow, 'start_date' | 'end_date'>): string {
  if (!j.start_date && !j.end_date) return 'Ingen dato';
  return `${formatDay(j.start_date)} – ${formatDay(j.end_date)}`;
}

export function jobsPage(d: { jobs: JobListRow[]; filter: string; q: string; flashCode?: string; manager: boolean }): H {
  const words = d.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = d.jobs.filter((j) =>
    words.every((w) => `${j.number} ${j.name} ${j.customer_name} ${j.customer_contact} ${j.site_address} ${j.customer_address} ${j.staff_names ?? ''}`.toLowerCase().includes(w)),
  );
  const tabs: [string, string][] = [
    ['', 'Aktive'],
    ['mine', 'Mine job'],
    ['afsluttet', 'Afsluttede'],
    ['alle', 'Alle'],
  ];
  return html`<div class="stack-lg">
  ${pageHead('Job- og forbrugsportal', 'Job', html`<a class="btn btn-primary" href="/job/ny">+ Nyt job</a>`, 'Vælg et job for at registrere materialer, forbrug og timer.')}
  ${flash(d.flashCode)}
  <div class="toolbar">
    <nav class="tabs">${tabs.map(([k, l]) => html`<a href="/job${k ? `?vis=${k}` : ''}"${d.filter === k ? html` aria-current="page"` : ''}>${l}</a>`)}</nav>
    <form method="get" action="/job" class="row grow" role="search">${d.filter ? html`<input type="hidden" name="vis" value="${d.filter}">` : ''}<input type="search" name="q" value="${d.q}" placeholder="Søg på jobnummer, titel, slutkunde, adresse eller medarbejder" aria-label="Søg"></form>
  </div>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable job-table">
    <thead><tr><th>Job</th><th>Slutkunde</th><th>Arbejdsadresse</th><th>Ansvarlige</th><th>Periode</th><th>Status</th>${d.manager ? html`<th class="num">Prisoverslag</th>` : ''}<th class="num">Forbrug</th>${d.manager ? html`<th>Faktura</th>` : ''}</tr></thead>
    <tbody>${shown.length
      ? shown.map(
          (j) => html`<tr class="row-link" data-href="/job/${j.id}">
        <td class="cell-main"><a class="title" href="/job/${j.id}"><span class="sku">${j.number}</span> ${j.name}</a>${j.description ? html`<small>${j.description.length > 90 ? `${j.description.slice(0, 90)}…` : j.description}</small>` : ''}</td>
        <td data-label="Slutkunde">${j.customer_name || '–'}${j.customer_contact ? html`<small>Kontakt: ${j.customer_contact}</small>` : ''}${j.customer_address ? html`<small>${j.customer_address.split('\n').join(', ')}</small>` : ''}</td>
        <td data-label="Arbejdsadresse">${j.site_address || html`<span class="muted">Som faktureringsadressen</span>`}</td>
        <td data-label="Ansvarlige">${j.staff_names || j.responsible_name || '–'}</td>
        <td data-label="Periode" class="nowrap">${period(j)}</td>
        <td data-label="Status">${stageTag(j.stage)}</td>
        ${d.manager
          ? html`<td class="num" data-label="Prisoverslag">${j.quote_subtotal === null ? html`<span class="muted">Intet</span>` : html`${formatKr(j.quote_subtotal)}<small>v${j.quote_version} ekskl. moms${j.quote_incomplete ? ', ufuldstændigt' : ''}</small>`}</td>`
          : ''}
        <td class="num" data-label="Forbrug">${formatQty(j.hours)} t.${j.hours_expected ? html`<small>af ${formatQty(j.hours_expected)} t. forventet</small>` : ''}<small>${j.used_lines} ${j.used_lines === 1 ? 'vare' : 'varer'} brugt${d.manager && j.mat_cost ? `, ${formatKr(j.mat_cost)} kostpris` : ''}</small></td>
        ${d.manager ? html`<td data-label="Faktura">${billingTag(j)}${j.inv_total ? html`<small>${formatKr(j.inv_total)} inkl. moms</small>` : ''}</td>` : ''}
      </tr>`,
        )
      : html`<tr><td colspan="9" class="empty">Ingen job${d.q ? ' matcher søgningen' : ''}.</td></tr>`}</tbody>
  </table></div></div>
</div>`;
}

// --- Jobbets faneblade -------------------------------------------------------------------------

export type JobTab = 'overblik' | 'materialer' | 'timer' | 'overslag' | 'indkob' | 'faktura' | 'bilag' | 'historik';

export type JobHead = JobRow & { responsible_name: string | null };

export function jobHeader(j: JobHead, tab: JobTab, manager: boolean): H {
  const tabs: [JobTab, string, string, boolean][] = [
    ['overblik', 'Overblik', `/job/${j.id}`, true],
    ['materialer', 'Materialer', `/job/${j.id}/materialer`, true],
    ['timer', 'Timer og løn', `/job/${j.id}/timer`, true],
    ['overslag', 'Prisoverslag', `/job/${j.id}/overslag`, manager],
    ['indkob', 'Indkøbslister', `/job/${j.id}/indkob`, true],
    ['faktura', 'Faktura', `/job/${j.id}/faktura`, manager],
    ['bilag', 'Bilag', `/job/bilag?job=${j.id}`, true],
    ['historik', 'Historik', `/job/${j.id}/historik`, true],
  ];
  return html`${pageHead(
    html`<a href="/job">Job</a> · <span class="sku">${j.number}</span>`,
    html`${j.name} ${stageTag(j.stage)}`,
    html`<a class="btn btn-secondary" href="/job/${j.id}/ret">Ret job</a>`,
    [j.customer_name, j.site_address || j.customer_address.split('\n')[0], period(j)].filter(Boolean).join(' · '),
  )}
  <nav class="tabs job-tabs" aria-label="Jobbet">${tabs
    .filter((t) => t[3])
    .map(([k, l, href]) => html`<a href="${href}"${tab === k ? html` aria-current="page"` : ''}>${l}</a>`)}</nav>`;
}

export interface JobSummary {
  quote: { version: number; subtotal: number; total: number; incomplete: number; shared_at: number | null; accepted_at: number | null } | null;
  estimate: { subtotal: number; incomplete: boolean };
  actualMaterials: number | null;
  actualLabour: number;
  internalCost: number;
  /** Godkendte udgifter fra bilag uden lagerpåvirkning (indgår i internCost) */
  bilagCost: number;
  internalMissing: number;
  hours: number;
  hoursExpected: number;
  pendingHours: number;
  billing: Pick<JobListRow, 'inv_issued' | 'inv_drafts' | 'inv_credits'>;
}

export function overviewPage(d: {
  job: JobHead;
  staff: { email: string; name: string }[];
  retailer: RetailerView | null;
  retailerFromSettings: boolean;
  waiting: number;
  manager: boolean;
  summary: JobSummary | null;
  csrf: string;
  op: string;
  flashCode?: string;
  error?: string;
}): H {
  const j = d.job;
  const active = j.status === 'aktiv';
  const s = d.summary;
  return html`<div class="stack-lg">
  ${jobHeader(j, 'overblik', d.manager)}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}
  ${j.stage === 'afventer' ? alert('warn', html`Jobbet afventer materialer: ${d.waiting} ${d.waiting === 1 ? 'vare mangler' : 'varer mangler'}. Se <a href="/job/${j.id}/indkob">indkøbslisterne</a>.`) : ''}
  ${active
    ? html`<div class="big-actions">
        <a class="big-action primary" href="/job/${j.id}/registrer?type=forbrug"><strong>Registrér forbrug</strong><span>Materialer brugt eller udleveret nu. Trækkes straks fra lageret.</span></a>
        <a class="big-action" href="/job/${j.id}/timer#registrer"><strong>Registrér timer</strong><span>Arbejdstimer på jobbet. Godkendes af ejer eller indkøber før fakturering.</span></a>
        <a class="big-action" href="/job/bilag/ny?job=${j.id}&fra=job"><strong>Upload bilag</strong><span>Kvittering eller faktura til jobbet. Ændrer ikke lageret.</span></a>
        <a class="big-action" href="/job/${j.id}/materialer"><strong>Materialer og indkøb</strong><span>Forventede materialer, priser, reservation og indkøbsliste.</span></a>
      </div>`
    : alert('info', `Jobbet er ${STAGE_LABEL[j.stage].toLowerCase()}. Genåbn det for at registrere mere.`)}
  ${s
    ? html`<div class="stats">
        <div class="stat"><span class="l">Prisoverslag ekskl. moms</span><span class="n">${s.quote ? formatKr(s.quote.subtotal) : formatKr(s.estimate.subtotal)}</span><span class="l">${s.quote ? `Version ${s.quote.version}${s.quote.accepted_at ? ', accepteret' : s.quote.shared_at ? ', sendt' : ', ikke sendt'}` : 'Aktuel beregning, ikke gemt'}${(s.quote ? s.quote.incomplete : s.estimate.incomplete) ? ' · ufuldstændigt' : ''}</span></div>
        <div class="stat"><span class="l">Faktisk til fakturering</span><span class="n">${formatKr((s.actualMaterials ?? 0) + s.actualLabour)}</span><span class="l">Materialer ${s.actualMaterials === null ? 'mangler pris' : formatKr(s.actualMaterials)} · arbejdsløn ${formatKr(s.actualLabour)}</span></div>
        <div class="stat"><span class="l">Timer</span><span class="n">${formatQty(s.hours)} t.</span><span class="l">${formatQty(s.hoursExpected)} t. forventet${s.pendingHours ? ` · ${formatQty(s.pendingHours)} t. venter på godkendelse` : ''}</span></div>
        <div class="stat"><span class="l">Intern omkostning</span><span class="n">${formatKr(s.internalCost)}</span><span class="l">${s.internalMissing ? `${s.internalMissing} registreringer mangler intern sats` : 'Materialer (kostpris) og timer'}${s.bilagCost ? ` · heraf ${formatKr(s.bilagCost)} fra godkendte bilag` : ''}</span></div>
      </div>
      <p class="row">Fakturastatus: ${billingTag(s.billing)} <a href="/job/${j.id}/faktura">Til faktura</a></p>`
    : ''}
  <div class="grid grid-2">
    <section class="card stack">
      <h2>Slutkunde</h2>
      <dl class="kv">
        <dt>Navn</dt><dd>${j.customer_name || html`<span class="miss">Mangler</span>`}${j.customer_cvr ? html` <span class="muted">(CVR ${j.customer_cvr})</span>` : ''}</dd>
        <dt>Kontakt</dt><dd>${j.customer_contact || '–'}</dd>
        <dt>Telefon</dt><dd>${j.customer_phone || '–'}</dd>
        <dt>E-mail</dt><dd>${j.customer_email || '–'}</dd>
        <dt>Faktureringsadresse</dt><dd>${j.customer_address ? html`${j.customer_address.split('\n').map((l, i) => html`${i ? html`<br>` : ''}${l}`)}` : html`<span class="miss">Mangler</span>`}</dd>
        <dt>Arbejdsadresse</dt><dd>${j.site_address || 'Samme som faktureringsadressen'}</dd>
      </dl>
    </section>
    <section class="card stack">
      <h2>Jobbet</h2>
      <dl class="kv">
        <dt>Periode</dt><dd>${period(j)}</dd>
        <dt>Ansvarlige</dt><dd>${d.staff.length ? d.staff.map((x) => x.name).join(', ') : '–'}</dd>
        <dt>Byggemarked</dt><dd>${d.retailer ? html`${d.retailer.name}${d.retailerFromSettings ? html` <span class="muted">(foretrukket)</span>` : ''}${retailerLive(d.retailer) ? '' : html` <span class="tag tag-off">Prisopslag kommer senere</span>`}` : html`<span class="muted">Intet valgt</span>`}</dd>
        ${d.manager ? html`<dt>Timepris</dt><dd>${j.hour_rate === null ? 'Standard' : `${formatKr(j.hour_rate)} pr. time ekskl. moms`}</dd><dt>Påslag</dt><dd>${j.markup_pct === null ? 'Standard' : `${j.markup_pct} %`}</dd>` : ''}
      </dl>
      ${j.description ? html`<p>${j.description}</p>` : ''}
      ${j.note ? html`<p class="muted small">${j.note}</p>` : ''}
    </section>
  </div>
  <section class="card stack">
    <h2>Status</h2>
    <form method="post" action="/job/${j.id}/status" class="row" data-confirm-select>
      ${csrfField(d.csrf)}${opField(d.op)}
      <label class="sr-only" for="stage">Status</label>
      <select id="stage" name="stage">${STAGES.map((st) => html`<option value="${st}"${st === j.stage ? html` selected` : ''}>${STAGE_LABEL[st]}</option>`)}</select>
      <button class="btn btn-secondary" type="submit" data-confirm="Skift status? Afsluttes eller annulleres jobbet, frigives reservationer, der ikke er udleveret.">Skift status</button>
    </form>
    <p class="hint">Systemet sætter selv "Afventer materialer", når der mangler varer, og "I gang", når der registreres forbrug eller timer. Afsluttes jobbet, frigives ubrugte reservationer.</p>
  </section>
</div>`;
}

// --- Lagermaterialer (reservation, udlevering og retur) --------------------------------------

function actionForm(jobId: number, pid: number, action: string, label: string, value: number, d: { csrf: string; op: string }, unit: string, danger = false, confirm = ''): H {
  return html`<form method="post" action="/job/${jobId}/materiale/${pid}"${confirm ? html` data-confirm="${confirm}"` : ''}>
    ${csrfField(d.csrf)}${opField(d.op)}<input type="hidden" name="action" value="${action}">
    <input class="in-num in-sm" name="qty" inputmode="decimal" value="${qtyInput(value)}" aria-label="${label}, mængde" required><span class="xs muted">${unit}</span>
    <button class="btn ${danger ? 'btn-danger' : 'btn-secondary'} btn-small" type="submit">${label}</button>
  </form>`;
}

function materialActions(jobId: number, m: MaterialView, d: { csrf: string; op: string; active: boolean }): H {
  const net = m.issued - m.returned;
  const onSite = m.site_received - m.site_used - m.site_returned;
  const u = m.unit;
  return html`<details class="act"><summary>Handlinger</summary><div class="act-body">
    ${d.active && m.reserved > 0 ? actionForm(jobId, m.product_id, 'udlever', 'Udlevér', m.reserved, d, u) : ''}
    ${m.reserved > 0 ? actionForm(jobId, m.product_id, 'frigiv', 'Frigiv reservation', m.reserved, d, u, true, 'Frigiv reservationen? Varerne bliver disponible for andre job.') : ''}
    ${net > 0 ? actionForm(jobId, m.product_id, 'retur', 'Returnér til lager', 0, d, u) : ''}
    ${d.active && onSite > 0 ? actionForm(jobId, m.product_id, 'brug_arbejdssted', 'Brugt fra arbejdssted', onSite, d, u) : ''}
    ${onSite > 0 ? actionForm(jobId, m.product_id, 'arbejdssted_til_lager', 'Flyt til lager', 0, d, u) : ''}
    ${d.active ? actionForm(jobId, m.product_id, 'behov', 'Ret samlet behov', m.planned, d, u) : ''}
  </div></details>`;
}

export function stockMaterialsSection(d: { job: JobRow; mats: MaterialView[]; csrf: string; ops: string[] }): H {
  const j = d.job;
  const active = j.status === 'aktiv';
  return html`<section class="stack">
    <div class="row-between"><h2>Lager: reserveret, udleveret og returneret</h2>${active ? html`<a class="btn btn-secondary btn-small" href="/job/${j.id}/registrer?type=plan">Planlæg flere varer fra lageret</a>` : ''}</div>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Vare</th><th class="num">Behov</th><th class="num">Reserveret</th><th class="num">Udleveret</th><th class="num">Returneret</th><th class="num">Arbejdssted</th><th class="num">På indkøb</th><th class="num">Mangler</th><th></th></tr></thead>
      <tbody>${d.mats.length
        ? d.mats.map((m, i) => {
            const onSite = m.site_received - m.site_used - m.site_returned;
            return html`<tr class="${m.waiting ? 'is-low' : ''}">
          <td class="cell-main"><strong>${m.name}</strong><span class="sku">${m.sku}</span></td>
          <td class="num" data-label="Behov">${qtyUnit(m.planned, m.unit)}</td>
          <td class="num" data-label="Reserveret">${formatQty(m.reserved)}</td>
          <td class="num" data-label="Udleveret">${formatQty(m.issued)}</td>
          <td class="num" data-label="Returneret">${formatQty(m.returned)}</td>
          <td class="num" data-label="Arbejdssted">${m.site_received ? html`${formatQty(onSite)} på stedet<small>${formatQty(m.site_used)} brugt</small>` : '–'}</td>
          <td class="num" data-label="På indkøb">${m.pending ? html`${formatQty(m.pending)}<small>${m.onOrder ? `${formatQty(m.onOrder)} bestilt` : 'ikke bestilt'}</small>` : '–'}</td>
          <td class="num" data-label="Mangler">${m.waiting ? html`<strong>${formatQty(m.waiting)}</strong>${m.uncovered ? html`<small>ikke på liste</small>` : ''}` : '–'}</td>
          <td>${materialActions(j.id, m, { csrf: d.csrf, op: d.ops[i] ?? '', active })}</td>
        </tr>`;
          })
        : html`<tr><td colspan="9" class="empty">Ingen varer fra lageret endnu.</td></tr>`}</tbody>
    </table></div></div>
    <p class="hint">Mangler = behov, der endnu ikke er på lager eller arbejdsstedet. Det står automatisk på jobbets indkøbsliste, indtil varerne er modtaget. Varer modtaget til jobbet reserveres til jobbet; varer leveret direkte til arbejdsstedet lægges ikke på hovedlageret.</p>
  </section>`;
}

// --- Indkøbslister på jobbet --------------------------------------------------------------------

export function jobListsPage(d: { job: JobHead; lists: (ListOverview & { lines: (LineView & { retailer_name?: string | null })[] })[]; manager: boolean; csrf: string }): H {
  const j = d.job;
  return html`<div class="stack-lg">
  ${jobHeader(j, 'indkob', d.manager)}
  <div class="row-between"><h2>Indkøbslister</h2>${d.manager ? html`<form method="post" action="/lager/indkob/ny" class="row">${csrfField(d.csrf)}<input type="hidden" name="job_id" value="${j.id}"><input name="name" placeholder="Navn på ny liste" required maxlength="80" class="in-sm" style="max-width:220px"><button class="btn btn-secondary btn-small" type="submit">+ Ny liste</button></form>` : ''}</div>
  <p class="hint">Det, der mangler til jobbet, kommer automatisk på jobbets indkøbsliste. En sendt liste markerer aldrig noget som bestilt; bestilling og modtagelse registreres for sig.</p>
  ${d.lists.length
    ? d.lists.map(
        (l) => html`<div class="card card-flush">
      <div class="row-between" style="padding:14px 16px"><span class="row"><strong>${d.manager ? html`<a href="/lager/indkob/${l.id}">${l.name}</a>` : html`<a href="/job/indkob/${l.id}">${l.name}</a>`}</strong>${lineTag(listStatus(l.lines))}</span>
        <span class="muted small">${l.wanted_date ? `Ønsket levering ${formatDay(l.wanted_date)}` : ''}</span></div>
      ${l.lines.length
        ? html`<div class="table-wrap"><table class="list stackable dense"><thead><tr><th>Vare</th><th class="num">Mangler/købes</th><th class="num">Bestilt</th><th class="num">Modtaget</th><th class="num">Udestår</th><th>Byggemarked</th><th>Forventet</th><th>Status</th>${d.manager ? html`<th class="num">Estimat</th>` : ''}</tr></thead><tbody>${l.lines.map(
            (x) => html`<tr${x.cancelled ? html` style="opacity:.55"` : ''}><td class="cell-main">${x.name}${x.deliver_to === 'arbejdssted' ? html`<small>Til arbejdsstedet</small>` : ''}${x.note ? html`<small>${x.note}</small>` : ''}</td><td class="num" data-label="Mangler/købes">${qtyUnit(Math.max(x.qty, x.ordered), x.unit)}</td><td class="num" data-label="Bestilt">${formatQty(x.ordered)}</td><td class="num" data-label="Modtaget">${formatQty(x.received)}</td><td class="num" data-label="Udestår">${formatQty(outstanding(x))}</td><td data-label="Byggemarked">${x.retailer_name ?? x.supplier_name ?? '–'}</td><td data-label="Forventet">${formatDay(x.expected_date)}</td><td data-label="Status">${lineTag(lineStatus(x))}</td>${d.manager ? html`<td class="num" data-label="Estimat">${x.unit_price === null ? '–' : formatKr(lineAmount(x.unit_price, Math.max(x.qty, x.ordered)))}</td>` : ''}</tr>`,
          )}</tbody></table></div>`
        : html`<p class="muted small" style="padding:0 16px 14px">Listen er tom.</p>`}
    </div>`,
      )
    : html`<p class="muted">Jobbet har ingen indkøbslister endnu.</p>`}
</div>`;
}

// --- Registrér forbrug eller planlæg fra lageret --------------------------------------------------

export function registerPage(d: {
  job: JobRow;
  type: 'forbrug' | 'plan';
  products: (ProductOverview & { job_reserved: number })[];
  values: Record<number, string>;
  note: string;
  csrf: string;
  op: string;
  errs: string[];
}): H {
  const plan = d.type === 'plan';
  return html`<form method="post" action="/job/${d.job.id}/registrer" class="sheet-form stack-lg">
  ${csrfField(d.csrf)}${opField(d.op)}<input type="hidden" name="type" value="${d.type}">
  ${pageHead(
    html`<a href="/job/${d.job.id}">${d.job.number} ${d.job.name}</a>`,
    plan ? 'Planlæg materialer' : 'Registrér forbrug',
    html`<a class="btn btn-ghost" href="/job/${d.job.id}">Annullér</a>`,
    plan
      ? 'Skriv det samlede ekstra behov. Det, der er disponibelt, reserveres til jobbet; resten kommer automatisk på jobbets indkøbsliste.'
      : 'Skriv, hvad der er brugt eller udleveret nu. Det tages først fra jobbets reservation og derefter fra den disponible beholdning. Varer uden varenummer registreres under Materialer.',
  )}
  ${errors(d.errs)}
  <div class="toolbar"><input type="search" data-sheet-search placeholder="Søg i varer" aria-label="Søg i varer"></div>
  <div class="card card-flush sheet-wrap"><table class="sheet">
    <thead><tr><th>Vare</th><th class="c-sku">Varenr.</th><th class="right">Disponibel</th><th class="right">Reserveret til jobbet</th><th class="c-qty right">${plan ? 'Behov' : 'Brugt nu'}</th></tr></thead>
    <tbody>${d.products.map(
      (p) => html`<tr class="sheet-row" data-search="${`${p.sku} ${p.name} ${p.category}`.toLowerCase()}">
      <td><label for="q${p.id}">${p.name}</label><span class="sheet-sub"><span class="c-sku">${p.sku}</span>${stockTag(p.plan.status)}</span></td>
      <td class="c-sku">${p.sku}</td>
      <td class="right num">${qtyUnit(p.plan.available, p.unit)}</td>
      <td class="right num">${p.job_reserved ? qtyUnit(p.job_reserved, p.unit) : '–'}</td>
      <td class="c-qty right"><input id="q${p.id}" class="sheet-qty" name="q_${p.id}" inputmode="decimal" autocomplete="off" value="${d.values[p.id] ?? ''}" aria-label="${plan ? 'Behov' : 'Brugt'}, ${p.name} (${p.unit})"></td>
    </tr>`,
    )}<tr class="sheet-none hidden"><td colspan="5" class="empty">Ingen varer matcher søgningen.</td></tr></tbody>
  </table></div>
  <div class="field" style="max-width:560px"><label for="note">Bemærkning (valgfri)</label><input id="note" name="note" maxlength="200" value="${d.note}"></div>
  <div class="sheet-bar"><div class="sheet-bar-inner">
    <div class="sheet-total"><span class="muted"><span data-count>0</span> varer valgt</span><strong>${d.job.number}</strong></div>
    <button class="btn btn-primary" type="submit">${plan ? 'Planlæg og reservér' : 'Registrér forbrug'}</button>
  </div></div>
</form>`;
}

// --- Opret og ret job ------------------------------------------------------------------------------

export interface JobFormValues {
  number: string;
  name: string;
  description: string;
  stage: string;
  customer_name: string;
  customer_contact: string;
  customer_cvr: string;
  customer_email: string;
  customer_phone: string;
  customer_address: string;
  site_address: string;
  responsible: string;
  staff: string[];
  start_date: string;
  end_date: string;
  retailer_id: string;
  hour_rate: string;
  markup_pct: string;
  note: string;
}

export function jobValues(j: JobRow | null, staff: string[] = [], nextNumber = ''): JobFormValues {
  return {
    number: j?.number ?? nextNumber,
    name: j?.name ?? '',
    description: j?.description ?? '',
    stage: j?.stage ?? 'planlagt',
    customer_name: j?.customer_name ?? '',
    customer_contact: j?.customer_contact ?? '',
    customer_cvr: j?.customer_cvr ?? '',
    customer_email: j?.customer_email ?? '',
    customer_phone: j?.customer_phone ?? '',
    customer_address: j?.customer_address ?? '',
    site_address: j?.site_address ?? '',
    responsible: j?.responsible ?? '',
    staff,
    start_date: j?.start_date ?? '',
    end_date: j?.end_date ?? '',
    retailer_id: j?.retailer_id ? String(j.retailer_id) : '',
    hour_rate: j?.hour_rate === null || j?.hour_rate === undefined ? '' : (j.hour_rate / 100).toFixed(2).replace('.', ',').replace(/,00$/, ''),
    markup_pct: j?.markup_pct === null || j?.markup_pct === undefined ? '' : String(j.markup_pct),
    note: j?.note ?? '',
  };
}

export function retailerOptions(retailers: RetailerView[], selected: string, emptyLabel: string): H {
  return html`<option value="">${emptyLabel}</option>${retailers.map(
    (r) => html`<option value="${r.id}"${String(r.id) === selected ? html` selected` : ''}>${r.name}${retailerLive(r) ? '' : ' (prisopslag kommer senere)'}</option>`,
  )}`;
}

export function jobFormPage(
  v: JobFormValues,
  d: { csrf: string; users: User[]; retailers: RetailerView[]; preferred: string; action: string; isNew: boolean; manager: boolean; errs: string[]; defaultMarkup: number; defaultRate: number },
): H {
  return html`<form method="post" action="${d.action}" class="stack-lg" style="max-width:900px">
  ${csrfField(d.csrf)}
  ${pageHead('Job', d.isNew ? 'Nyt job' : `Ret ${v.number}`)}
  ${errors(d.errs)}
  <fieldset class="card stack"><legend>Job</legend>
    <div class="fields fields-2">
      <div class="field"><label for="number">Jobnummer</label><input id="number" name="number" required maxlength="30" value="${v.number}"></div>
      <div class="field"><label for="name">Titel</label><input id="name" name="name" required maxlength="120" value="${v.name}"></div>
    </div>
    <div class="field"><label for="description">Beskrivelse af opgaven</label><textarea id="description" name="description" maxlength="2000" rows="3">${v.description}</textarea></div>
    <div class="fields fields-3">
      <div class="field"><label for="start_date">Startdato</label><input id="start_date" type="date" name="start_date" value="${v.start_date}"></div>
      <div class="field"><label for="end_date">Forventet slutdato</label><input id="end_date" type="date" name="end_date" value="${v.end_date}"></div>
      ${d.isNew
        ? html`<div class="field"><label for="stage">Status</label><select id="stage" name="stage">${(['kladde', 'planlagt', 'i_gang'] as const).map((st) => html`<option value="${st}"${st === v.stage ? html` selected` : ''}>${STAGE_LABEL[st]}</option>`)}</select></div>`
        : ''}
    </div>
    <div class="fields fields-2">
      <div class="field"><label for="responsible">Ansvarlig</label><select id="responsible" name="responsible"><option value="">Ikke valgt</option>${d.users.map(
        (u) => html`<option value="${u.email}"${u.email === v.responsible ? html` selected` : ''}>${u.name}</option>`,
      )}</select></div>
      <fieldset class="field"><legend>Øvrige medarbejdere på jobbet</legend><div class="row" style="flex-wrap:wrap;gap:4px 16px">${d.users.map(
        (u) => html`<label class="check"><input type="checkbox" name="staff" value="${u.email}"${v.staff.includes(u.email) ? html` checked` : ''}> ${u.name}</label>`,
      )}</div></fieldset>
    </div>
  </fieldset>
  <fieldset class="card stack"><legend>Slutkunde</legend>
    <p class="hint">Den person eller virksomhed, jobbet udføres for. Oplysningerne bruges på prisoverslag og faktura.</p>
    <div class="fields fields-2">
      <div class="field"><label for="customer_name">Navn</label><input id="customer_name" name="customer_name" maxlength="120" value="${v.customer_name}"></div>
      <div class="field"><label for="customer_contact">Kontaktperson</label><input id="customer_contact" name="customer_contact" maxlength="120" value="${v.customer_contact}"></div>
    </div>
    <div class="fields fields-3">
      <div class="field"><label for="customer_email">E-mail</label><input id="customer_email" type="email" name="customer_email" maxlength="254" value="${v.customer_email}"></div>
      <div class="field"><label for="customer_phone">Telefon</label><input id="customer_phone" type="tel" name="customer_phone" maxlength="40" value="${v.customer_phone}"></div>
      <div class="field"><label for="customer_cvr">CVR (erhvervskunde)</label><input id="customer_cvr" name="customer_cvr" inputmode="numeric" maxlength="12" value="${v.customer_cvr}"></div>
    </div>
    <div class="fields fields-2">
      <div class="field"><label for="customer_address">Faktureringsadresse</label><textarea id="customer_address" name="customer_address" maxlength="300" rows="3">${v.customer_address}</textarea></div>
      <div class="field"><label for="site_address">Arbejdsadresse (hvis en anden)</label><textarea id="site_address" name="site_address" maxlength="200" rows="3">${v.site_address}</textarea></div>
    </div>
  </fieldset>
  ${d.manager
    ? html`<fieldset class="card stack"><legend>Priser</legend>
      <div class="fields fields-3">
        <div class="field"><label for="retailer_id">Byggemarked</label><select id="retailer_id" name="retailer_id">${retailerOptions(d.retailers, v.retailer_id, `Foretrukket (${d.preferred || 'intet valgt'})`)}</select><p class="hint">Bruges til prisopslag. Kan ændres pr. materiale.</p></div>
        <div class="field"><label for="hour_rate">Timepris til slutkunden (kr. ekskl. moms)</label><input id="hour_rate" class="in-num" name="hour_rate" inputmode="decimal" value="${v.hour_rate}" placeholder="${d.defaultRate ? formatKr(d.defaultRate).replace(' kr.', '') : ''}"><p class="hint">Tom = standard${d.defaultRate ? ` (${formatKr(d.defaultRate)})` : ' (ikke sat op)'}.</p></div>
        <div class="field"><label for="markup_pct">Påslag på materialer (%)</label><input id="markup_pct" class="in-num" name="markup_pct" inputmode="numeric" value="${v.markup_pct}" placeholder="${d.defaultMarkup}"><p class="hint">Tom = standard (${d.defaultMarkup} %).</p></div>
      </div>
    </fieldset>`
    : html`<input type="hidden" name="markup_pct" value="${v.markup_pct}"><input type="hidden" name="hour_rate" value="${v.hour_rate}"><input type="hidden" name="retailer_id" value="${v.retailer_id}">`}
  <div class="field"><label for="note">Intern bemærkning</label><textarea id="note" name="note" maxlength="1000">${v.note}</textarea></div>
  <div class="row"><button class="btn btn-primary" type="submit">${d.isNew ? 'Opret job' : 'Gem job'}</button><a class="btn btn-ghost" href="/job">Annullér</a></div>
</form>`;
}

// --- Lager og indkøbslister for medarbejdere -----------------------------------------------------

export function availabilityPage(d: { products: ProductOverview[]; q: string }): H {
  const words = d.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = d.products.filter((p) => words.every((w) => `${p.sku} ${p.name} ${p.category}`.toLowerCase().includes(w)));
  return html`<div class="stack-lg">
  ${pageHead('Job- og forbrugsportal', 'Hvad er på lager', '', 'Disponibelt = det, der kan tages nu. Reserverede varer tilhører andre job.')}
  <form method="get" action="/job/lager" class="toolbar" role="search"><input type="search" name="q" value="${d.q}" placeholder="Søg i varer" aria-label="Søg"></form>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
    <thead><tr><th>Vare</th><th class="num">Disponibel</th><th class="num">Reserveret</th><th class="num">På vej</th><th>Status</th></tr></thead>
    <tbody>${shown.map(
      (p) => html`<tr>
      <td class="cell-main"><strong>${p.name}</strong><span class="sku">${p.sku}</span></td>
      <td class="num" data-label="Disponibel"><strong>${qtyUnit(p.plan.available, p.unit)}</strong></td>
      <td class="num" data-label="Reserveret">${formatQty(p.reserved)}</td>
      <td class="num" data-label="På vej">${p.on_order ? html`${formatQty(p.on_order)}<small>${p.next_date ? formatDay(p.next_date) : ''}</small>` : '–'}</td>
      <td data-label="Status">${stockTag(p.plan.status)}</td>
    </tr>`,
    )}</tbody>
  </table></div></div>
</div>`;
}

export function staffListsPage(d: { lists: ListOverview[] }): H {
  return html`<div class="stack-lg">
  ${pageHead('Job- og forbrugsportal', 'Indkøbslister', '', 'Følg, hvad der er bestilt og modtaget til jobbene.')}
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Liste</th><th>Job</th><th>Status</th><th class="num">Linjer</th><th>Ønsket levering</th></tr></thead>
    <tbody>${d.lists.length
      ? d.lists.map(
          (l) => html`<tr class="row-link" data-href="/job/indkob/${l.id}"><td class="cell-main"><a class="title" href="/job/indkob/${l.id}">${l.name}</a></td>
        <td data-label="Job">${l.job_id ? html`${l.job_number} ${l.job_name}` : 'Lageropfyldning'}</td><td data-label="Status">${lineTag(l.status)}</td><td class="num" data-label="Linjer">${l.line_count}</td><td data-label="Ønsket levering">${formatDay(l.wanted_date)}</td></tr>`,
        )
      : html`<tr><td colspan="5" class="empty">Ingen lister.</td></tr>`}</tbody>
  </table></div></div>
</div>`;
}

export function staffListPage(d: { list: ListOverview; lines: LineView[]; prices: boolean }): H {
  const l = d.list;
  return html`<div class="stack-lg">
  ${pageHead(l.job_id ? html`<a href="/job/${l.job_id}">${l.job_number} ${l.job_name}</a>` : 'Lageropfyldning', html`${l.name} ${lineTag(listStatus(d.lines))}`, html`<a class="btn btn-ghost" href="/job/indkob">← Indkøbslister</a>${d.prices ? html`<a class="btn btn-secondary" href="/lager/indkob/${l.id}">Rediger i lagerportalen</a>` : ''}`)}
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
    <thead><tr><th>Vare</th><th class="num">Mængde</th><th class="num">Bestilt</th><th class="num">Modtaget</th><th class="num">Udestår</th><th>Leverandør</th><th>Forventet</th><th>Status</th>${d.prices ? html`<th class="num">Beløb</th>` : ''}</tr></thead>
    <tbody>${d.lines.map(
      (x) => html`<tr${x.cancelled ? html` style="opacity:.55"` : ''}>
      <td class="cell-main"><strong>${x.name}</strong>${x.sku ? html`<span class="sku">${x.sku}</span>` : ''}${x.deliver_to === 'arbejdssted' ? html`<small>Leveres til arbejdsstedet</small>` : ''}</td>
      <td class="num" data-label="Mængde">${qtyUnit(Math.max(x.qty, x.ordered), x.unit)}</td><td class="num" data-label="Bestilt">${formatQty(x.ordered)}</td><td class="num" data-label="Modtaget">${formatQty(x.received)}</td><td class="num" data-label="Udestår">${formatQty(outstanding(x))}</td>
      <td data-label="Leverandør">${x.supplier_name ?? '–'}</td><td data-label="Forventet">${formatDay(x.expected_date)}</td><td data-label="Status">${lineTag(lineStatus(x))}</td>
      ${d.prices ? html`<td class="num" data-label="Beløb">${x.unit_price === null ? '–' : formatKr(lineAmount(x.unit_price, Math.max(x.qty, x.ordered)))}</td>` : ''}
    </tr>`,
    )}</tbody>
  </table></div></div>
</div>`;
}
