import { html } from 'hono/html';
import type { JobRow, User } from '../env';
import type { ProductOverview } from '../lib/catalog';
import { formatDay, formatKr, formatQty, lineAmount, qtyInput, qtyUnit } from '../lib/format';
import { materialStatus, type MaterialView } from '../lib/materials';
import { lineStatus, listStatus, outstanding, type LineView, type ListOverview } from '../lib/purchasing';
import { errors, flash, lineTag, pageHead, stockTag } from './common';
import { alert, csrfField, opField, type H } from './layout';
import { movesTable, type MovementView } from './lager';

export type JobListRow = JobRow & { mat_count: number; waiting_count: number; responsible_name: string | null };

const JOB_STATUS: Record<JobRow['status'], string> = { aktiv: 'Aktiv', afsluttet: 'Afsluttet', annulleret: 'Annulleret' };

export function materialTag(st: 'klar' | 'afventer' | 'ingen'): H {
  return st === 'afventer'
    ? html`<span class="tag tag-low">Afventer materialer</span>`
    : st === 'klar'
      ? html`<span class="tag tag-ok">Materialer klar</span>`
      : html`<span class="tag tag-off">Ingen materialer endnu</span>`;
}

function jobTag(j: Pick<JobRow, 'status'>, waiting: number, count: number): H {
  if (j.status !== 'aktiv') return html`<span class="tag tag-off">${JOB_STATUS[j.status]}</span>`;
  return materialTag(count ? (waiting ? 'afventer' : 'klar') : 'ingen');
}

export function jobsPage(d: { jobs: JobListRow[]; filter: string; q: string; flashCode?: string; mine: string }): H {
  const words = d.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = d.jobs.filter((j) => words.every((w) => `${j.number} ${j.name} ${j.customer_name} ${j.site_address}`.toLowerCase().includes(w)));
  const tabs: [string, string][] = [
    ['', 'Aktive'],
    ['mine', 'Mine job'],
    ['afsluttet', 'Afsluttede'],
  ];
  return html`<div class="stack-lg">
  ${pageHead('Forbrugsportal', 'Job', html`<a class="btn btn-primary" href="/job/ny">+ Nyt job</a>`, 'Vælg et job for at registrere materialebehov og forbrug.')}
  ${flash(d.flashCode)}
  <div class="toolbar">
    <nav class="tabs">${tabs.map(([k, l]) => html`<a href="/job${k ? `?vis=${k}` : ''}"${d.filter === k ? html` aria-current="page"` : ''}>${l}</a>`)}</nav>
    <form method="get" action="/job" class="row grow" role="search">${d.filter ? html`<input type="hidden" name="vis" value="${d.filter}">` : ''}<input type="search" name="q" value="${d.q}" placeholder="Søg på jobnummer, navn, kunde eller adresse" aria-label="Søg"></form>
  </div>
  ${shown.length
    ? html`<div class="job-cards">${shown.map(
        (j) => html`<a class="job-card" href="/job/${j.id}">
        <span class="row-between"><span class="no">${j.number}</span>${jobTag(j, j.waiting_count, j.mat_count)}</span>
        <strong>${j.name}</strong>
        <span class="muted small">${[j.customer_name, j.site_address].filter(Boolean).join(' · ') || 'Ingen kunde angivet'}</span>
        <span class="muted xs">${j.planned_date ? `Materialer bruges ${formatDay(j.planned_date)}` : 'Ingen dato'}${j.responsible_name ? ` · ${j.responsible_name}` : ''}</span>
      </a>`,
      )}</div>`
    : html`<div class="card empty">Ingen job${d.q ? ' matcher søgningen' : ''}.</div>`}
</div>`;
}

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

export function jobPage(d: {
  job: JobRow & { responsible_name: string | null };
  mats: MaterialView[];
  lists: (ListOverview & { lines: LineView[] })[];
  moves: MovementView[];
  manager: boolean;
  csrf: string;
  ops: string[];
  flashCode?: string;
  error?: string;
  result?: string;
}): H {
  const j = d.job;
  const active = j.status === 'aktiv';
  const st = materialStatus(d.mats);
  return html`<div class="stack-lg">
  ${pageHead(
    html`Job <span class="sku">${j.number}</span>`,
    j.name,
    html`<a class="btn btn-ghost" href="/job">← Alle job</a>${d.manager ? html`<a class="btn btn-secondary" href="/lager/faktura/job/${j.id}">Fakturagrundlag</a>` : ''}<a class="btn btn-secondary" href="/job/${j.id}/ret">Ret job</a>`,
  )}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}${d.result ? alert('ok', d.result) : ''}
  <div class="row">${j.status === 'aktiv' ? materialTag(st) : html`<span class="tag tag-off">${JOB_STATUS[j.status]}</span>`}
    <span class="muted small">${[j.customer_name, j.site_address, j.planned_date && `Materialer bruges ${formatDay(j.planned_date)}`, j.responsible_name && `Ansvarlig: ${j.responsible_name}`]
      .filter(Boolean)
      .join(' · ')}</span></div>
  ${active
    ? html`<div class="big-actions">
        <a class="big-action primary" href="/job/${j.id}/registrer?type=forbrug"><strong>Registrér forbrug</strong><span>Materialer brugt eller udleveret nu. Trækkes straks fra lageret.</span></a>
        <a class="big-action" href="/job/${j.id}/registrer?type=plan"><strong>Planlæg materialer</strong><span>Reservér til senere. Det, der mangler, kommer på jobbets indkøbsliste.</span></a>
      </div>`
    : alert('info', 'Jobbet er afsluttet. Genåbn det for at registrere flere materialer.')}
  <section class="stack">
    <h2>Materialer</h2>
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
        : html`<tr><td colspan="9" class="empty">Ingen materialer registreret endnu.</td></tr>`}</tbody>
    </table></div></div>
    <p class="hint">Mangler = behov, der endnu ikke er på lager eller arbejdsstedet. Det står automatisk på jobbets indkøbsliste, indtil varerne er modtaget.</p>
  </section>
  <section class="stack">
    <div class="row-between"><h2>Indkøbslister</h2>${d.manager ? html`<form method="post" action="/lager/indkob/ny" class="row">${csrfField(d.csrf)}<input type="hidden" name="job_id" value="${j.id}"><input name="name" placeholder="Navn på ny liste" required maxlength="80" class="in-sm" style="max-width:220px"><button class="btn btn-secondary btn-small" type="submit">+ Ny liste</button></form>` : ''}</div>
    ${d.lists.length
      ? d.lists.map(
          (l) => html`<div class="card card-flush">
        <div class="row-between" style="padding:14px 16px"><span class="row"><strong>${d.manager ? html`<a href="/lager/indkob/${l.id}">${l.name}</a>` : html`<a href="/job/indkob/${l.id}">${l.name}</a>`}</strong>${lineTag(listStatus(l.lines))}</span>
          <span class="muted small">${l.wanted_date ? `Ønsket levering ${formatDay(l.wanted_date)}` : ''}</span></div>
        ${l.lines.length
          ? html`<div class="table-wrap"><table class="mini" style="margin:0 8px 8px"><thead><tr><th>Vare</th><th class="num">Mængde</th><th class="num">Modtaget</th><th>Leverandør</th><th>Forventet</th><th>Status</th></tr></thead><tbody>${l.lines.map(
              (x) => html`<tr${x.cancelled ? html` style="opacity:.55"` : ''}><td>${x.name}${x.deliver_to === 'arbejdssted' ? html`<small>Til arbejdssted</small>` : ''}</td><td class="num">${qtyUnit(Math.max(x.qty, x.ordered), x.unit)}</td><td class="num">${formatQty(x.received)}</td><td>${x.supplier_name ?? '–'}</td><td>${formatDay(x.expected_date)}</td><td>${lineTag(lineStatus(x))}</td></tr>`,
            )}</tbody></table></div>`
          : html`<p class="muted small" style="padding:0 16px 14px">Listen er tom.</p>`}
      </div>`,
        )
      : html`<p class="muted">Jobbet har ingen indkøbslister.</p>`}
  </section>
  <section class="stack">
    <h2>Historik for jobbet</h2>
    <div class="card">${movesTable(d.moves, true)}</div>
  </section>
  <form method="post" action="/job/${j.id}/status" class="row" data-confirm="${active ? 'Afslut jobbet? Reservationer, der ikke er udleveret, frigives.' : 'Genåbn jobbet?'}">
    ${csrfField(d.csrf)}${opField(d.ops[d.mats.length] ?? '')}<input type="hidden" name="status" value="${active ? 'afsluttet' : 'aktiv'}">
    <button class="btn ${active ? 'btn-secondary' : 'btn-dark'}" type="submit">${active ? 'Afslut job' : 'Genåbn job'}</button>
  </form>
</div>`;
}

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
      : 'Skriv, hvad der er brugt eller udleveret nu. Det tages først fra jobbets reservation og derefter fra den disponible beholdning.',
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

export interface JobFormValues {
  number: string;
  name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_address: string;
  site_address: string;
  responsible: string;
  planned_date: string;
  markup_pct: string;
  note: string;
}

export function jobValues(j: JobRow | null, nextNumber = ''): JobFormValues {
  return {
    number: j?.number ?? nextNumber,
    name: j?.name ?? '',
    customer_name: j?.customer_name ?? '',
    customer_email: j?.customer_email ?? '',
    customer_phone: j?.customer_phone ?? '',
    customer_address: j?.customer_address ?? '',
    site_address: j?.site_address ?? '',
    responsible: j?.responsible ?? '',
    planned_date: j?.planned_date ?? '',
    markup_pct: j?.markup_pct === null || j?.markup_pct === undefined ? '' : String(j.markup_pct),
    note: j?.note ?? '',
  };
}

export function jobFormPage(v: JobFormValues, d: { csrf: string; users: User[]; action: string; isNew: boolean; manager: boolean; errs: string[]; defaultMarkup: number }): H {
  return html`<form method="post" action="${d.action}" class="stack-lg" style="max-width:860px">
  ${csrfField(d.csrf)}
  ${pageHead('Job', d.isNew ? 'Nyt job' : `Ret ${v.number}`)}
  ${errors(d.errs)}
  <fieldset class="card stack"><legend>Job</legend>
    <div class="fields fields-2">
      <div class="field"><label for="number">Jobnummer</label><input id="number" name="number" required maxlength="30" value="${v.number}"></div>
      <div class="field"><label for="name">Jobnavn</label><input id="name" name="name" required maxlength="120" value="${v.name}"></div>
    </div>
    <div class="fields fields-2">
      <div class="field"><label for="responsible">Ansvarlig medarbejder</label><select id="responsible" name="responsible"><option value="">Ikke valgt</option>${d.users.map(
        (u) => html`<option value="${u.email}"${u.email === v.responsible ? html` selected` : ''}>${u.name}</option>`,
      )}</select></div>
      <div class="field"><label for="planned_date">Materialerne bruges</label><input id="planned_date" type="date" name="planned_date" value="${v.planned_date}"></div>
    </div>
    <div class="field"><label for="site_address">Arbejdsadresse</label><input id="site_address" name="site_address" maxlength="200" value="${v.site_address}"></div>
  </fieldset>
  <fieldset class="card stack"><legend>Kunde</legend>
    <div class="fields fields-2">
      <div class="field"><label for="customer_name">Kunde</label><input id="customer_name" name="customer_name" maxlength="120" value="${v.customer_name}"></div>
      <div class="field"><label for="customer_address">Kundeadresse</label><input id="customer_address" name="customer_address" maxlength="200" value="${v.customer_address}"></div>
    </div>
    <div class="fields fields-2">
      <div class="field"><label for="customer_email">E-mail</label><input id="customer_email" type="email" name="customer_email" maxlength="254" value="${v.customer_email}"></div>
      <div class="field"><label for="customer_phone">Telefon</label><input id="customer_phone" type="tel" name="customer_phone" maxlength="40" value="${v.customer_phone}"></div>
    </div>
  </fieldset>
  ${d.manager
    ? html`<fieldset class="card stack"><legend>Fakturering</legend>
      <div class="field"><label for="markup_pct">Aftalt avance på materialer (%)</label><input id="markup_pct" class="in-num" name="markup_pct" inputmode="numeric" value="${v.markup_pct}" placeholder="${d.defaultMarkup}"><p class="hint">Bruges, når en vare ikke har en salgspris. Tom = standard (${d.defaultMarkup} %).</p></div>
    </fieldset>`
    : html`<input type="hidden" name="markup_pct" value="${v.markup_pct}">`}
  <div class="field"><label for="note">Bemærkning</label><textarea id="note" name="note" maxlength="1000">${v.note}</textarea></div>
  <div class="row"><button class="btn btn-primary" type="submit">${d.isNew ? 'Opret job' : 'Gem job'}</button><a class="btn btn-ghost" href="/job">Annullér</a></div>
</form>`;
}

export function availabilityPage(d: { products: ProductOverview[]; q: string }): H {
  const words = d.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = d.products.filter((p) => words.every((w) => `${p.sku} ${p.name} ${p.category}`.toLowerCase().includes(w)));
  return html`<div class="stack-lg">
  ${pageHead('Forbrugsportal', 'Hvad er på lager', '', 'Disponibelt = det, der kan tages nu. Reserverede varer tilhører andre job.')}
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
  ${pageHead('Forbrugsportal', 'Indkøbslister', '', 'Følg, hvad der er bestilt og modtaget til jobbene.')}
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
