// Jobbets materialer med priser, timer og løn, prisoverslag og fakturaer.

import { html } from 'hono/html';
import type { InvoiceItemRow, InvoiceRow, JobEntryRow, JobQuoteRow, LabourTypeRow, User } from '../env';
import type { RetailerView } from '../lib/estimates';
import { formatDate, formatDateTime, formatDay, formatKr, formatQty, lineAmount, oereToInput, qtyInput, qtyUnit } from '../lib/format';
import { MODE_LABEL, TYPE_LABEL, invoiceTotals, itemAmount, parseJson, type CustomerInfo, type InvoiceTotals, type Source } from '../lib/invoicing';
import { COST_BASIS_LABEL, SALE_MODE_LABEL, findUrl, otherRetailer, retailerLive, usedQty, type ItemCalc, type ItemView } from '../lib/jobitems';
import type { JobLogRow } from '../lib/jobs';
import type { LabourSummary } from '../lib/labour';
import type { MaterialView } from '../lib/materials';
import { BASIS_LABEL, SOURCE_LABEL, STALE_LABEL, type MatchBasis } from '../lib/prices';
import type { QuoteCalc } from '../lib/quotes';
import { errors, flash } from './common';
import { jobHeader, retailerOptions, stockMaterialsSection, type JobHead } from './job';
import { alert, csrfField, opField, type H } from './layout';
import { movesTable, type MovementView } from './lager';
import { addMaterialSection, type SearchPanel } from './produktkatalog';

const krIn = (o: number | null | undefined) => (o === null || o === undefined ? '' : oereToInput(o));

// --- Materialer --------------------------------------------------------------------------------

function priceInfo(it: ItemView, c: ItemCalc, now: number, maxAgeDays: number): H {
  if (otherRetailer(it)) return html`<span class="tag tag-low">Pris mangler</span><small>Prisen er fra et andet byggemarked. Slå prisen op igen.</small>`;
  if (it.price === null) {
    return html`${it.cost_basis === 'lager' && it.product_id ? html`<span class="muted">Ingen byggemarkedspris</span>` : html`<span class="tag tag-low">Pris mangler</span>`}${it.lookup_note ? html`<small>${it.lookup_note}</small>` : ''}`;
  }
  const stale = it.checked_at !== null && it.price_source !== 'manuel' && now - it.checked_at > maxAgeDays * 86400;
  const match =
    it.match === 'alternativ'
      ? it.approved_at
        ? html`<span class="tag tag-ready">Alternativ – godkendt</span>`
        : html`<span class="tag tag-low">Alternativ – kræver godkendelse</span>`
      : html`<span class="tag tag-ok">${it.price_source === 'manuel' ? 'Manuel pris' : 'Præcist match'}</span>`;
  const pack = it.pack_qty && it.pack_qty !== 1000 ? `${it.sales_unit} á ${formatQty(it.pack_qty)} ${it.unit}` : `pr. ${it.sales_unit || it.unit}`;
  const src = SOURCE_LABEL[it.price_source as keyof typeof SOURCE_LABEL] ?? it.price_source;
  return html`${match}${it.price_source === 'demodata' ? html` <span class="tag tag-demo">Demodata</span>` : ''}
    <small>${it.url ? html`<a href="${it.url}" target="_blank" rel="noopener noreferrer">${it.found_name || 'Produktside'}</a>` : it.found_name}${it.retailer_name && it.price_source !== 'manuel' ? ` · ${it.retailer_name}` : ''}</small>
    <small><strong>${formatKr(it.price)}</strong> ${pack} · ${it.vat === 'inkl' ? 'inkl.' : 'ekskl.'} moms${it.match_basis ? ` · ${BASIS_LABEL[it.match_basis as MatchBasis] ?? it.match_basis}` : ''}</small>
    <small>${src}, ${stale ? html`<span class="miss">${STALE_LABEL}</span> ` : ''}${formatDateTime(it.checked_at)}</small>
    ${it.lookup_note ? html`<small>${it.lookup_note}</small>` : ''}
    ${c.publicUnit !== null && it.pack_qty !== 1000 ? html`<small>= ${formatKr(c.publicUnit)} pr. ${it.unit} ekskl. moms</small>` : ''}`;
}

function stockState(it: ItemView): H {
  if (it.product_id) {
    const planned = it.m_planned ?? 0;
    if (!planned) return html`<span class="muted">Ikke reserveret</span>`;
    const covered = (it.m_issued ?? 0) - (it.m_returned ?? 0) + (it.m_reserved ?? 0) + (it.m_site_received ?? 0);
    const waiting = Math.max(0, planned - covered);
    return waiting
      ? html`<span class="tag tag-low">Mangler ${formatQty(waiting)}</span><small>${formatQty(it.m_reserved ?? 0)} reserveret</small>`
      : html`<span class="tag tag-ok">Dækket</span><small>${formatQty(it.m_reserved ?? 0)} reserveret</small>`;
  }
  if (it.purchase_line_id && it.pl_qty !== null) {
    if (it.pl_cancelled) return html`<span class="tag tag-off">Indkøb annulleret</span>`;
    if ((it.pl_received ?? 0) >= (it.pl_qty ?? 0)) return html`<span class="tag tag-ok">Modtaget</span>`;
    return (it.pl_ordered ?? 0) > 0 ? html`<span class="tag tag-ordered">Bestilt</span>` : html`<span class="tag tag-ready">På indkøbsliste</span>`;
  }
  return html`<span class="muted">Ikke på indkøbsliste</span>`;
}

function itemEditForm(it: ItemView, d: { csrf: string; retailers: RetailerView[]; manager: boolean; jobId: number; jobRetailer: string; defaultMarkup: number }): H {
  return html`<form method="post" action="/job/${d.jobId}/materialer/${it.id}" class="stack-sm">
    ${csrfField(d.csrf)}
    <div class="fields fields-2">
      <div class="field"><label>Forventet mængde (${it.unit})</label><input class="in-num" name="qty" inputmode="decimal" value="${qtyInput(it.qty)}" required></div>
      ${it.product_id ? html`<input type="hidden" name="unit" value="${it.unit}">` : html`<div class="field"><label>Enhed</label><input name="unit" maxlength="20" value="${it.unit}"></div>`}
    </div>
    ${it.product_id ? '' : html`<div class="field"><label>Navn</label><input name="name" maxlength="200" value="${it.name}"></div>
      <div class="fields fields-3"><div class="field"><label>EAN</label><input name="ean" inputmode="numeric" maxlength="14" value="${it.ean}"></div><div class="field"><label>Producentnr.</label><input name="mpn" maxlength="60" value="${it.mpn}"></div><div class="field"><label>Mærke</label><input name="brand" maxlength="60" value="${it.brand}"></div></div>`}
    ${d.manager
      ? html`<div class="fields fields-2">
          <div class="field"><label>Byggemarked</label><select name="retailer_id">${retailerOptions(d.retailers, it.retailer_id ? String(it.retailer_id) : '', `Jobbets (${d.jobRetailer})`)}</select></div>
          ${it.product_id ? html`<div class="field"><label>Kostpris fra</label><select name="cost_basis">${(['lager', 'byggemarked'] as const).map((b) => html`<option value="${b}"${b === it.cost_basis ? html` selected` : ''}>${COST_BASIS_LABEL[b]}</option>`)}</select></div>` : html`<input type="hidden" name="cost_basis" value="byggemarked">`}
        </div>
        <div class="fields fields-3">
          <div class="field"><label>Salgspris</label><select name="sale_mode">${(['paaslag', 'offentlig', 'manuel'] as const).map((m) => html`<option value="${m}"${m === it.sale_mode ? html` selected` : ''}>${SALE_MODE_LABEL[m]}</option>`)}</select></div>
          <div class="field"><label>Påslag (%)</label><input class="in-num" name="markup_pct" inputmode="numeric" value="${it.markup_pct ?? ''}" placeholder="${d.defaultMarkup}"></div>
          <div class="field"><label>Manuel salgspris pr. ${it.unit} (kr. ekskl. moms)</label><input class="in-num" name="sale_price" inputmode="decimal" value="${krIn(it.sale_price)}"></div>
        </div>
        <div class="field"><label>Link til varen hos byggemarkedet</label><input name="url" type="url" maxlength="500" value="${it.url}" placeholder="https://"><p class="hint">Et link til en offentlig produktside læses ved næste prisopslag (kun hos byggemarkeder, hvor det er tilladt).</p></div>
        <div class="fields fields-2"><div class="field"><label>Byggemarkedet sælger i</label><input name="sales_unit" maxlength="20" value="${it.sales_unit}" placeholder="${it.unit}"></div><div class="field"><label>Indhold pr. salgsenhed (${it.unit})</label><input class="in-num" name="pack_qty" inputmode="decimal" value="${it.pack_qty ? qtyInput(it.pack_qty) : '1'}"></div></div>`
      : ''}
    <div class="field"><label>Bemærkning</label><input name="note" maxlength="200" value="${it.note}"></div>
    <div class="row"><button class="btn btn-secondary btn-small" type="submit">Gem linjen</button></div>
  </form>`;
}

function manualPriceForm(it: ItemView, d: { csrf: string; jobId: number }): H {
  return html`<form method="post" action="/job/${d.jobId}/materialer/${it.id}/pris" class="stack-sm">
    ${csrfField(d.csrf)}
    <p class="hint">Brug prisen fra byggemarkedets offentlige produktside. Prisen gemmes som "Manuelt indtastet" og overskrives ikke af senere opslag.</p>
    <div class="fields fields-3">
      <div class="field"><label>Pris (kr.)</label><input class="in-num" name="price" inputmode="decimal" required value="${it.price_source === 'manuel' ? krIn(it.price) : ''}"></div>
      <div class="field"><label>Moms</label><select name="vat"><option value="inkl"${it.vat !== 'ekskl' ? html` selected` : ''}>inkl. moms</option><option value="ekskl"${it.vat === 'ekskl' ? html` selected` : ''}>ekskl. moms</option></select></div>
      <div class="field"><label>Pr. salgsenhed</label><input name="sales_unit" maxlength="20" value="${it.sales_unit || it.unit}"></div>
    </div>
    <div class="fields fields-2">
      <div class="field"><label>Indhold pr. salgsenhed (${it.unit})</label><input class="in-num" name="pack_qty" inputmode="decimal" value="${it.pack_qty ? qtyInput(it.pack_qty) : '1'}"></div>
      <div class="field"><label>Link (valgfrit)</label><input name="url" type="url" maxlength="500" value="${it.url}" placeholder="https://"></div>
    </div>
    <div class="row"><button class="btn btn-secondary btn-small" type="submit">Gem pris</button></div>
  </form>`;
}

export function materialsPage(d: {
  job: JobHead;
  items: { it: ItemView; c: ItemCalc }[];
  mats: MaterialView[];
  panel: SearchPanel;
  manualOpen: boolean;
  retailers: RetailerView[];
  jobRetailer: RetailerView | null;
  manager: boolean;
  csrf: string;
  ops: string[];
  reserveOp: string;
  now: number;
  maxAgeDays: number;
  defaultMarkup: number;
  flashCode?: string;
  error?: string;
  result?: { ok: boolean; text: string; list: string[] };
}): H {
  const j = d.job;
  const active = j.status === 'aktiv';
  const r = d.jobRetailer;
  const totals = d.items.reduce(
    (a, { c }) => ({
      sale: a.sale + (c.saleAmount ?? 0),
      cost: a.cost + (c.buyAmount ?? 0),
      missing: a.missing + (c.saleUnit === null ? 1 : 0),
    }),
    { sale: 0, cost: 0, missing: 0 },
  );
  const cols = d.manager ? 9 : 5;
  return html`<div class="stack-lg">
  ${jobHeader(j, 'materialer', d.manager)}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}
  ${d.result ? alert(d.result.ok ? 'ok' : 'warn', html`${d.result.text}${d.result.list.length ? html`<ul>${d.result.list.slice(0, 8).map((x) => html`<li>${x}</li>`)}</ul>` : ''}`) : ''}
  <div class="row-between">
    <p class="muted" style="margin:0">Byggemarked: <strong>${r ? r.name : 'intet valgt'}</strong>${r && !retailerLive(r) ? html` <span class="tag tag-off">Prisopslag kommer senere</span>` : r ? html` <span class="tag tag-ok">Aktiv</span>` : ''} · kan ændres pr. linje</p>
    <div class="row">
      ${d.manager && d.items.length ? html`<form method="post" action="/job/${j.id}/materialer/priser">${csrfField(d.csrf)}<button class="btn btn-secondary" type="submit">Slå priser op</button></form>` : ''}
      ${active && d.items.length ? html`<form method="post" action="/job/${j.id}/materialer/reserver" data-confirm="Reservér det, der er på lager, og sæt resten på jobbets indkøbsliste?">${csrfField(d.csrf)}${opField(d.reserveOp)}<button class="btn btn-primary" type="submit">Reservér og sæt på indkøbsliste</button></form>` : ''}
    </div>
  </div>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense items-table">
    <thead><tr><th>Materiale</th><th class="num">Forventet</th><th class="num">Brugt</th><th>Lager og indkøb</th>${d.manager ? html`<th>Pris hos byggemarked</th><th class="num">Køb</th><th class="num">Kostpris</th><th class="num">Salgspris</th>` : ''}<th></th></tr></thead>
    <tbody>${d.items.length
      ? d.items.map(({ it, c }) => {
          const used = usedQty(it);
          return html`<tr${c.saleUnit === null && d.manager ? html` class="is-low"` : ''}>
        <td class="cell-main"><strong>${it.name}</strong>${it.sku ? html`<span class="sku">${it.sku}</span>` : html`<small>Uden varenummer</small>`}${d.manager ? html`<small>${COST_BASIS_LABEL[it.cost_basis]}${it.retailer_id ? ` · ${it.retailer_name}` : ''}</small>` : ''}${it.catalog_product_id ? html`<small><a href="/katalog/${it.catalog_product_id}?job=${j.id}">Fra produktkataloget</a></small>` : ''}${it.note ? html`<small>${it.note}</small>` : ''}</td>
        <td class="num" data-label="Forventet">${qtyUnit(it.qty, it.unit)}</td>
        <td class="num" data-label="Brugt">${used ? qtyUnit(used, it.unit) : '–'}${used > it.qty ? html`<small class="miss">Mere end forventet</small>` : ''}</td>
        <td data-label="Lager og indkøb">${stockState(it)}</td>
        ${d.manager
          ? html`<td data-label="Pris hos byggemarked">${priceInfo(it, c, d.now, d.maxAgeDays)}</td>
            <td class="num" data-label="Køb">${c.buy ? html`${formatQty(c.buy.buy)} ${it.sales_unit || it.unit}${it.pack_qty && it.pack_qty !== 1000 ? html`<small>= ${formatQty(c.buy.covered)} ${it.unit}${c.buy.covered > it.qty ? `, ${formatQty(c.buy.covered - it.qty)} i overskud` : ''}</small>` : ''}<small>${formatKr(c.buyAmount)} ekskl. moms</small>` : '–'}</td>
            <td class="num" data-label="Kostpris">${c.unitCost === null ? html`<span class="miss">Mangler</span>` : html`${formatKr(c.unitCost)}<small>pr. ${it.unit}${it.actual_cost !== null ? ', faktisk' : ''}</small>`}</td>
            <td class="num" data-label="Salgspris">${c.saleUnit === null ? html`<span class="tag tag-low">Pris mangler</span><small>${c.missing}</small>` : html`<strong>${formatKr(c.saleAmount)}</strong><small>${formatKr(c.saleUnit)} pr. ${it.unit}</small><small>${it.sale_mode === 'paaslag' ? `+ ${c.markup} % påslag` : SALE_MODE_LABEL[it.sale_mode]}</small>`}</td>`
          : ''}
        <td><details class="act"><summary>Handlinger</summary><div class="act-body stack">
          ${d.manager && it.match === 'alternativ' && !it.approved_at && it.price !== null
            ? html`<div class="row"><form method="post" action="/job/${j.id}/materialer/${it.id}/godkend">${csrfField(d.csrf)}<button class="btn btn-primary btn-small" type="submit">Godkend alternativ</button></form>
                <form method="post" action="/job/${j.id}/materialer/${it.id}/afvis">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Afvis</button></form></div>`
            : ''}
          ${!it.product_id && active
            ? html`<form method="post" action="/job/${j.id}/materialer/${it.id}/forbrug" class="row">${csrfField(d.csrf)}<input class="in-num in-sm" name="qty" inputmode="decimal" aria-label="Brugt nu" placeholder="0"><span class="xs muted">${it.unit}</span>
                <select name="retning" class="in-sm" aria-label="Brugt eller retur"><option value="brugt">brugt</option><option value="retur">retur (ikke brugt)</option></select><button class="btn btn-secondary btn-small" type="submit">Registrér</button></form>`
            : ''}
          ${d.manager && it.eff_retailer_id && it.retailer_key && it.retailer_website
            ? html`<p class="small"><a href="${findUrl({ key: it.retailer_key, website: it.retailer_website }, it.name)}" target="_blank" rel="noopener noreferrer">Find varen hos ${it.retailer_name} ↗</a></p>`
            : ''}
          <details><summary>Ret linjen</summary>${itemEditForm(it, { csrf: d.csrf, retailers: d.retailers, manager: d.manager, jobId: j.id, jobRetailer: r?.name ?? 'intet', defaultMarkup: d.defaultMarkup })}</details>
          ${d.manager ? html`<details><summary>Indtast pris manuelt</summary>${manualPriceForm(it, { csrf: d.csrf, jobId: j.id })}</details>` : ''}
          ${used === 0 && !it.planned_at ? html`<form method="post" action="/job/${j.id}/materialer/${it.id}/slet" data-confirm="Fjern ${it.name} fra jobbet?">${csrfField(d.csrf)}<button class="btn btn-danger btn-small" type="submit">Fjern</button></form>` : ''}
        </div></details></td>
      </tr>`;
        })
      : html`<tr><td colspan="${cols}" class="empty">Ingen materialer endnu. Tilføj de materialer, jobbet forventes at bruge.</td></tr>`}</tbody>
    ${d.manager && d.items.length
      ? html`<tfoot><tr><td colspan="5"><strong>I alt</strong>${totals.missing ? html` <span class="tag tag-low">${totals.missing} ${totals.missing === 1 ? 'linje mangler' : 'linjer mangler'} pris</span>` : ''}</td><td class="num">${formatKr(totals.cost)}<small>købsestimat</small></td><td></td><td class="num"><strong>${formatKr(totals.sale)}</strong><small>salg ekskl. moms</small></td><td></td></tr></tfoot>`
      : ''}
  </table></div></div>
  ${d.manager ? html`<p class="hint">Forbrug, købsmængde og fakturerbar mængde holdes adskilt: købes der hele pakker, faktureres kun det forventede eller brugte, aldrig overskuddet. Priser fra byggemarkeder er offentlige forbrugerpriser, omregnet til ekskl. moms; fragt og rabatter er ikke medregnet. En linje uden pris tæller aldrig som 0 kr.</p>` : ''}
  ${active ? addMaterialSection({ jobId: j.id, panel: d.panel, manager: d.manager, csrf: d.csrf, manualOpen: d.manualOpen }) : ''}
  ${stockMaterialsSection({ job: j, mats: d.mats, csrf: d.csrf, ops: d.ops })}
</div>`;
}

// --- Timer og løn ------------------------------------------------------------------------------

export function hoursPage(d: {
  job: JobHead;
  entries: JobEntryRow[];
  summary: LabourSummary;
  users: User[];
  types: LabourTypeRow[];
  me: User;
  manager: boolean;
  csrf: string;
  rate: number | null;
  internalDefault: number | null;
  today: string;
  flashCode?: string;
  errs?: string[];
}): H {
  const j = d.job;
  const exp = d.entries.filter((e) => e.phase === 'forventet');
  const act = d.entries.filter((e) => e.phase === 'faktisk');
  const s = d.summary;
  const mine = (e: JobEntryRow) => e.worker_email === d.me.email || e.created_by === d.me.email;
  const pending = act.filter((e) => e.type === 'tid' && !e.approved_at);
  return html`<div class="stack-lg">
  ${jobHeader(j, 'timer', d.manager)}
  ${flash(d.flashCode)}${errors(d.errs ?? [])}
  ${d.manager
    ? html`<div class="stats">
      <div class="stat"><span class="l">Forventet arbejdsløn (overslag)</span><span class="n">${formatKr(s.expectedLabour)}</span><span class="l">${formatQty(s.expectedHours)} t. × timepris${s.rateMissing ? ' · timepris mangler' : ''}</span></div>
      <div class="stat"><span class="l">Faktiske timer</span><span class="n">${formatQty(s.actualHours)} t.</span><span class="l">${formatQty(s.approvedHours)} t. godkendt${s.pendingHours ? `, ${formatQty(s.pendingHours)} t. venter` : ''}</span></div>
      <div class="stat"><span class="l">Intern arbejdsomkostning</span><span class="n">${formatKr(s.internalCost)}</span><span class="l">${s.internalMissing ? html`<span class="miss">${s.internalMissing} uden intern sats</span>` : 'Faktiske timer × intern sats'}</span></div>
      <div class="stat"><span class="l">Arbejdsløn til fakturering</span><span class="n">${formatKr(s.billableLabour)}</span><span class="l">Godkendte fakturerbare timer × aftalt timepris</span></div>
    </div>
    <p class="hint">Interne omkostninger vises aldrig på prisoverslag eller faktura. Den interne sats er én samlet timeomkostning pr. medarbejdertype (løn, pension, feriepenge m.m.), ikke et lønsystem.</p>`
    : ''}
  ${d.manager && pending.length
    ? html`<form method="post" action="/job/${j.id}/timer/godkend" class="row">${csrfField(d.csrf)}${pending.map((e) => html`<input type="hidden" name="id" value="${e.id}">`)}<button class="btn btn-primary" type="submit">Godkend alle ${pending.length} ventende registreringer</button></form>`
    : ''}
  <section class="stack">
    <h2>Faktiske timer og omkostninger</h2>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Dato</th><th>Medarbejder</th><th>Beskrivelse</th><th class="num">Antal</th>${d.manager ? html`<th class="num">Intern omkostning</th><th class="num">Til slutkunden</th>` : ''}<th>Status</th><th></th></tr></thead>
      <tbody>${act.length
        ? act.map(
            (e) => html`<tr>
          <td data-label="Dato" class="nowrap">${formatDay(e.work_date)}</td>
          <td data-label="Medarbejder">${e.type === 'tid' ? html`${e.worker_name || e.worker_email}${e.worker_type ? html`<small>${e.worker_type}</small>` : ''}` : html`<span class="tag tag-src">Omkostning</span>`}</td>
          <td class="cell-main">${e.description || '–'}${e.extra ? html` <span class="tag tag-ready">Ekstraarbejde</span>` : ''}</td>
          <td class="num" data-label="Antal">${qtyUnit(e.qty, e.unit)}</td>
          ${d.manager
            ? html`<td class="num" data-label="Intern omkostning">${e.internal_cost === null ? html`<span class="miss">Mangler opsætning</span>` : html`${formatKr(lineAmount(e.internal_cost, e.qty))}<small>${formatKr(e.internal_cost)} pr. ${e.unit === 'timer' ? 'time' : e.unit}</small>`}</td>
              <td class="num" data-label="Til slutkunden">${!e.billable ? html`<span class="muted">Ikke fakturerbar</span>` : e.unit_price === null ? html`<span class="miss">Pris mangler</span>` : html`${formatKr(lineAmount(e.unit_price, e.qty))}<small>${formatKr(e.unit_price)} pr. ${e.unit === 'timer' ? 'time' : e.unit}</small>`}</td>`
            : ''}
          <td data-label="Status">${e.type === 'tid' ? (e.approved_at ? html`<span class="tag tag-ok">Godkendt</span>` : html`<span class="tag tag-ready">Venter på godkendelse</span>`) : html`<span class="tag tag-ok">Registreret</span>`}</td>
          <td>${(d.manager || (mine(e) && !e.approved_at))
            ? html`<details class="act"><summary>Handlinger</summary><div class="act-body stack-sm">
              ${d.manager && e.type === 'tid' && !e.approved_at ? html`<form method="post" action="/job/${j.id}/timer/godkend">${csrfField(d.csrf)}<input type="hidden" name="id" value="${e.id}"><button class="btn btn-primary btn-small" type="submit">Godkend</button></form>` : ''}
              ${d.manager && e.approved_at ? html`<form method="post" action="/job/${j.id}/timer/${e.id}/fortryd">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Fortryd godkendelse</button></form>` : ''}
              ${d.manager ? entryEditForm(e, j.id, d.csrf) : ''}
              <form method="post" action="/job/${j.id}/timer/${e.id}/slet" data-confirm="Slet registreringen?">${csrfField(d.csrf)}<button class="btn btn-danger btn-small" type="submit">Slet</button></form>
            </div></details>`
            : ''}</td>
        </tr>`,
          )
        : html`<tr><td colspan="8" class="empty">Ingen timer registreret endnu.</td></tr>`}</tbody>
    </table></div></div>
  </section>
  ${j.status === 'aktiv'
    ? html`<section class="card stack" id="registrer">
    <h2>Registrér timer</h2>
    <form method="post" action="/job/${j.id}/timer" class="stack-sm">
      ${csrfField(d.csrf)}<input type="hidden" name="phase" value="faktisk"><input type="hidden" name="type" value="tid">
      <div class="fields fields-3">
        ${d.manager
          ? html`<div class="field"><label for="worker">Medarbejder</label><select id="worker" name="worker">${d.users.map((u) => html`<option value="${u.email}"${u.email === d.me.email ? html` selected` : ''}>${u.name}</option>`)}</select></div>`
          : html`<input type="hidden" name="worker" value="${d.me.email}">`}
        <div class="field"><label for="work_date">Dato</label><input id="work_date" type="date" name="work_date" value="${d.today}" required></div>
        <div class="field"><label for="hours">Timer</label><input id="hours" class="in-num" name="qty" inputmode="decimal" required placeholder="7,5"></div>
      </div>
      <div class="field"><label for="desc_t">Hvad er lavet</label><input id="desc_t" name="description" maxlength="200"></div>
      ${d.manager
        ? html`<div class="row" style="flex-wrap:wrap;gap:8px 20px"><label class="check"><input type="checkbox" name="billable" value="1" checked> Fakturerbar</label><label class="check"><input type="checkbox" name="extra" value="1"> Ekstraarbejde (ud over fast pris)</label><label class="check"><input type="checkbox" name="approve" value="1"> Godkend med det samme</label></div>`
        : html`<p class="hint">Timerne godkendes af ejer eller indkøber, før de kommer på fakturaen.</p>`}
      <div class="row"><button class="btn btn-primary" type="submit">Registrér timer</button></div>
    </form>
  </section>`
    : ''}
  ${d.manager
    ? html`<section class="stack">
    <h2>Forventede timer og omkostninger (til prisoverslaget)</h2>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Beskrivelse</th><th class="num">Antal</th><th class="num">Pris pr. enhed</th><th class="num">Beløb</th><th class="num">Intern omkostning</th><th></th></tr></thead>
      <tbody>${exp.length
        ? exp.map(
            (e) => html`<tr>
          <td class="cell-main">${e.description || (e.type === 'tid' ? 'Arbejdstimer' : 'Omkostning')}${e.worker_type ? html`<small>${e.worker_type}</small>` : ''}${e.type === 'omkostning' ? html` <span class="tag tag-src">Omkostning</span>` : ''}${!e.billable ? html` <span class="tag tag-off">Ikke fakturerbar</span>` : ''}</td>
          <td class="num" data-label="Antal">${qtyUnit(e.qty, e.unit)}</td>
          <td class="num" data-label="Pris pr. enhed">${e.unit_price === null ? html`<span class="miss">Mangler</span>` : formatKr(e.unit_price)}</td>
          <td class="num" data-label="Beløb">${e.unit_price === null ? '–' : formatKr(lineAmount(e.unit_price, e.qty))}</td>
          <td class="num" data-label="Intern omkostning">${e.internal_cost === null ? '–' : formatKr(lineAmount(e.internal_cost, e.qty))}</td>
          <td><details class="act"><summary>Handlinger</summary><div class="act-body stack-sm">${entryEditForm(e, j.id, d.csrf)}<form method="post" action="/job/${j.id}/timer/${e.id}/slet" data-confirm="Slet linjen?">${csrfField(d.csrf)}<button class="btn btn-danger btn-small" type="submit">Slet</button></form></div></details></td>
        </tr>`,
          )
        : html`<tr><td colspan="6" class="empty">Ingen forventede timer endnu.</td></tr>`}</tbody>
    </table></div></div>
    <div class="grid grid-2">
      <form method="post" action="/job/${j.id}/timer" class="card stack-sm">
        ${csrfField(d.csrf)}<input type="hidden" name="phase" value="forventet"><input type="hidden" name="type" value="tid">
        <h3>Forventede timer</h3>
        <div class="fields fields-2">
          <div class="field"><label for="ft">Medarbejdertype</label><select id="ft" name="labour_type"><option value="">Standard</option>${d.types.filter((t) => t.active).map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></div>
          <div class="field"><label for="fq">Timer</label><input id="fq" class="in-num" name="qty" inputmode="decimal" required></div>
        </div>
        <div class="field"><label for="fd">Beskrivelse</label><input id="fd" name="description" maxlength="200" placeholder="Fx Montage af terrasse"></div>
        <div class="field"><label for="fr">Timepris til slutkunden (kr. ekskl. moms)</label><input id="fr" class="in-num" name="unit_price" inputmode="decimal" placeholder="${d.rate === null ? 'Ikke sat op' : krIn(d.rate)}"><p class="hint">Tom = jobbets eller typens timepris${d.rate === null ? '' : ` (${formatKr(d.rate)})`}.</p></div>
        <button class="btn btn-secondary" type="submit">Tilføj forventede timer</button>
      </form>
      <form method="post" action="/job/${j.id}/timer" class="card stack-sm">
        ${csrfField(d.csrf)}<input type="hidden" name="type" value="omkostning">
        <h3>Anden omkostning</h3>
        <div class="field"><label for="od">Beskrivelse</label><input id="od" name="description" maxlength="200" required placeholder="Fx Kørsel, containerleje, levering"></div>
        <div class="fields fields-3">
          <div class="field"><label for="oq">Antal</label><input id="oq" class="in-num" name="qty" inputmode="decimal" value="1" required></div>
          <div class="field"><label for="ou">Enhed</label><input id="ou" name="unit" maxlength="20" value="stk."></div>
          <div class="field"><label for="op_">Pris pr. enhed til slutkunden (kr.)</label><input id="op_" class="in-num" name="unit_price" inputmode="decimal"></div>
        </div>
        <div class="fields fields-2">
          <div class="field"><label for="oc">Intern omkostning pr. enhed (kr.)</label><input id="oc" class="in-num" name="internal_cost" inputmode="decimal"></div>
          <div class="field"><label for="oph">Hører til</label><select id="oph" name="phase"><option value="forventet">Prisoverslaget (forventet)</option><option value="faktisk">Faktisk afholdt</option></select></div>
        </div>
        <label class="check"><input type="checkbox" name="billable" value="1" checked> Fakturerbar</label>
        <button class="btn btn-secondary" type="submit">Tilføj omkostning</button>
      </form>
    </div>
  </section>`
    : ''}
</div>`;
}

function entryEditForm(e: JobEntryRow, jobId: number, csrf: string): H {
  return html`<form method="post" action="/job/${jobId}/timer/${e.id}" class="stack-sm">
    ${csrfField(csrf)}
    <div class="fields fields-2">
      <div class="field"><label>Antal (${e.unit})</label><input class="in-num" name="qty" inputmode="decimal" value="${qtyInput(e.qty)}" required></div>
      <div class="field"><label>Dato</label><input type="date" name="work_date" value="${e.work_date}"></div>
    </div>
    <div class="field"><label>Beskrivelse</label><input name="description" maxlength="200" value="${e.description}"></div>
    <div class="fields fields-2">
      <div class="field"><label>Pris pr. enhed til slutkunden (kr.)</label><input class="in-num" name="unit_price" inputmode="decimal" value="${krIn(e.unit_price)}"></div>
      <div class="field"><label>Intern omkostning pr. enhed (kr.)</label><input class="in-num" name="internal_cost" inputmode="decimal" value="${krIn(e.internal_cost)}"></div>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:8px 20px"><label class="check"><input type="checkbox" name="billable" value="1"${e.billable ? html` checked` : ''}> Fakturerbar</label>${e.type === 'tid' && e.phase === 'faktisk' ? html`<label class="check"><input type="checkbox" name="extra" value="1"${e.extra ? html` checked` : ''}> Ekstraarbejde</label>` : ''}</div>
    <button class="btn btn-secondary btn-small" type="submit">Gem</button>
  </form>`;
}

// --- Prisoverslag ------------------------------------------------------------------------------

function quoteStatus(q: JobQuoteRow): H {
  if (q.accepted_at) return html`<span class="tag tag-ok">Accepteret</span><small>${formatDate(q.accepted_at)}</small>`;
  if (q.shared_at) return html`<span class="tag tag-ordered">Sendt/downloadet</span><small>${formatDate(q.shared_at)}</small>`;
  return html`<span class="tag tag-off">Gemt</span>`;
}

export function quotePage(d: { job: JobHead; calc: QuoteCalc; quotes: JobQuoteRow[]; csrf: string; vatSet: boolean; flashCode?: string }): H {
  const j = d.job;
  const c = d.calc;
  const latest = d.quotes[0];
  const changed = latest && (latest.subtotal !== c.subtotal || latest.incomplete !== (c.incomplete ? 1 : 0));
  const sec = (title: string, rows: { name: string; qty: number; unit: string; price: number | null; amount: number | null; sub?: string }[]) =>
    rows.length
      ? html`<tr class="sec"><th colspan="4">${title}</th></tr>${rows.map(
          (r) => html`<tr><td class="cell-main">${r.name}${r.sub ? html`<small>${r.sub}</small>` : ''}</td><td class="num" data-label="Antal">${qtyUnit(r.qty, r.unit)}</td><td class="num" data-label="Pris pr. enhed">${r.price === null ? '–' : formatKr(r.price)}</td><td class="num" data-label="Beløb">${r.amount === null ? html`<span class="tag tag-low">Pris mangler</span>` : formatKr(r.amount)}</td></tr>`,
        )}`
      : '';
  return html`<div class="stack-lg">
  ${jobHeader(j, 'overslag', true)}
  ${flash(d.flashCode)}
  ${!d.vatSet ? alert('warn', html`Angiv under <a href="/lager/indstillinger#faktura">Indstillinger</a>, om virksomheden er momsregistreret. Indtil da beregnes 25 % moms.`) : ''}
  ${c.incomplete ? alert('warn', html`<strong>Ufuldstændigt overslag.</strong> Disse linjer mangler en pris og er ikke regnet med:<ul>${c.data.missing.map((m) => html`<li>${m}</li>`)}</ul>`) : ''}
  <div class="layout-side">
    <section class="card card-flush">
      <div style="padding:16px 16px 0"><h2>Aktuel beregning</h2><p class="hint">Bygger på jobbets materialer og forventede timer og omkostninger lige nu. Gem en version for at låse den og sende den til slutkunden.</p></div>
      <div class="table-wrap"><table class="list stackable dense quote-table">
        <thead><tr><th>Beskrivelse</th><th class="num">Antal</th><th class="num">Pris pr. enhed</th><th class="num">Beløb</th></tr></thead>
        <tbody>
          ${sec('Materialer', c.data.materials.map((m) => ({ name: m.name, qty: m.qty, unit: m.unit, price: m.sale_unit, amount: m.amount, sub: m.missing || m.basis })))}
          ${sec('Arbejdsløn', c.data.labour.map((l) => ({ name: l.description, qty: l.qty, unit: l.unit, price: l.rate, amount: l.amount })))}
          ${sec('Andre omkostninger', c.data.other.map((l) => ({ name: l.description, qty: l.qty, unit: l.unit, price: l.rate, amount: l.amount })))}
          ${!c.data.materials.length && !c.data.labour.length && !c.data.other.length ? html`<tr><td colspan="4" class="empty">Tilføj materialer og forventede timer for at beregne et overslag.</td></tr>` : ''}
        </tbody>
      </table></div>
    </section>
    <aside class="side stack">
      <section class="card stack">
        <table class="totals">
          <tr><td>Materialer</td><td>${formatKr(c.materials)}</td></tr>
          <tr><td>Arbejdsløn</td><td>${formatKr(c.labour)}</td></tr>
          <tr><td>Andre omkostninger</td><td>${formatKr(c.other)}</td></tr>
          <tr class="total"><td>I alt ekskl. moms</td><td>${formatKr(c.subtotal)}</td></tr>
          <tr><td>Moms ${c.data.vat_rate / 100} %</td><td>${formatKr(c.vat)}</td></tr>
          <tr class="total"><td>I alt inkl. moms</td><td>${formatKr(c.total)}</td></tr>
        </table>
        ${changed ? alert('info', `Beregningen er ændret siden version ${latest!.version}. Gem en ny version, før den sendes.`) : ''}
        <form method="post" action="/job/${j.id}/overslag" class="stack-sm">
          ${csrfField(d.csrf)}
          <div class="field"><label for="qnote">Bemærkning på overslaget (valgfri)</label><textarea id="qnote" name="note" maxlength="600" rows="2"></textarea></div>
          <button class="btn btn-primary btn-block" type="submit"${c.incomplete ? html` data-confirm="Overslaget er ufuldstændigt (der mangler priser). Gem det alligevel?"` : ''}>Gem som version ${(latest?.version ?? 0) + 1}</button>
        </form>
        <p class="hint">En gemt version ændres aldrig, heller ikke når priser eller jobbet ændres senere.</p>
      </section>
    </aside>
  </div>
  <section class="stack">
    <h2>Gemte versioner</h2>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Version</th><th>Gemt</th><th class="num">Ekskl. moms</th><th class="num">Inkl. moms</th><th>Status</th><th></th></tr></thead>
      <tbody>${d.quotes.length
        ? d.quotes.map(
            (q) => html`<tr>
          <td class="cell-main"><strong>Version ${q.version}</strong>${q.incomplete ? html` <span class="tag tag-low">Ufuldstændigt</span>` : ''}${q.note ? html`<small>${q.note}</small>` : ''}</td>
          <td data-label="Gemt">${formatDateTime(q.created_at)}${q.valid_until ? html`<small>Gælder til ${formatDay(q.valid_until)}</small>` : ''}</td>
          <td class="num" data-label="Ekskl. moms">${formatKr(q.subtotal)}</td>
          <td class="num" data-label="Inkl. moms">${formatKr(q.total)}</td>
          <td data-label="Status">${quoteStatus(q)}</td>
          <td><div class="row"><a class="btn btn-secondary btn-small" href="/job/${j.id}/overslag/${q.id}.pdf">PDF</a>${!q.accepted_at ? html`<form method="post" action="/job/${j.id}/overslag/${q.id}/accepteret" data-confirm="Markér version ${q.version} som accepteret af slutkunden? Salgspriserne herfra bruges på fakturaen.">${csrfField(d.csrf)}<button class="btn btn-ghost btn-small" type="submit">Markér accepteret</button></form>` : ''}</div></td>
        </tr>`,
          )
        : html`<tr><td colspan="6" class="empty">Ingen gemte versioner endnu.</td></tr>`}</tbody>
    </table></div></div>
    <p class="hint">PDF'en er mærket "Prisoverslag" med virksomhedens og slutkundens oplysninger og en note om, at den bygger på forventede mængder, timer og de viste prisforudsætninger. Et overslag er ikke en fast pris; fast pris vælges først på fakturaen.</p>
  </section>
</div>`;
}

// --- Faktura -----------------------------------------------------------------------------------

export function invoiceTag(inv: Pick<InvoiceRow, 'status' | 'kind'>): H {
  if (inv.status === 'kladde') return html`<span class="tag tag-ready">Kladde</span>`;
  return inv.kind === 'kreditnota' ? html`<span class="tag tag-low">Kreditnota udstedt</span>` : html`<span class="tag tag-ok">Udstedt</span>`;
}

function invoiceLabel(inv: Pick<InvoiceRow, 'kind' | 'number' | 'status'>): string {
  const k = inv.kind === 'kreditnota' ? 'Kreditnota' : 'Faktura';
  return inv.number ? `${k} nr. ${inv.number}` : `${k} (kladde)`;
}

export function jobBillingPage(d: {
  job: JobHead;
  invoices: InvoiceRow[];
  rest: Source[];
  pendingHours: number;
  quote: JobQuoteRow | null;
  csrf: string;
  flashCode?: string;
  error?: string;
}): H {
  const j = d.job;
  const draft = d.invoices.find((i) => i.status === 'kladde' && i.kind === 'faktura');
  const sum = (t: Source['type']) => d.rest.filter((x) => x.type === t).reduce((a, x) => a + lineAmount(x.unit_price, x.qty), 0);
  const missing = d.rest.filter((x) => x.unit_price === null).length;
  return html`<div class="stack-lg">
  ${jobHeader(j, 'faktura', true)}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}
  ${j.status === 'aktiv' ? alert('info', 'Jobbet er ikke afsluttet. Du kan godt fakturere nu (fx en delfaktura); resten kan faktureres senere uden at noget kommer med to gange.') : ''}
  ${d.pendingHours ? alert('warn', html`${formatQty(d.pendingHours)} timer venter på godkendelse og kommer ikke med, før de er godkendt. <a href="/job/${j.id}/timer">Gå til timer</a>`) : ''}
  <div class="grid grid-2">
    <section class="card stack">
      <h2>Ikke faktureret endnu</h2>
      <table class="totals">
        <tr><td>Materialer (forbrug minus returvarer)</td><td>${formatKr(sum('materiale'))}</td></tr>
        <tr><td>Godkendte fakturerbare timer</td><td>${formatKr(sum('tid'))}</td></tr>
        <tr><td>Andre omkostninger</td><td>${formatKr(sum('omkostning'))}</td></tr>
        <tr class="total"><td>I alt ekskl. moms</td><td>${formatKr(sum('materiale') + sum('tid') + sum('omkostning'))}</td></tr>
      </table>
      ${missing ? html`<p class="miss small">${missing} ${missing === 1 ? 'linje mangler' : 'linjer mangler'} en pris (tæller ikke med ovenfor).</p>` : ''}
      ${d.quote ? html`<p class="small muted">Aftalt prisoverslag: version ${d.quote.version}, ${formatKr(d.quote.subtotal)} ekskl. moms${d.quote.accepted_at ? ' (accepteret)' : ' (sendt)'}. Salgspriser for materialer tages herfra.</p>` : html`<p class="small muted">Der er ikke sendt eller accepteret et prisoverslag. Salgspriser beregnes ud fra materialelinjerne.</p>`}
    </section>
    <section class="card stack">
      <h2>${draft ? 'Fakturakladde' : 'Opret fakturakladde'}</h2>
      ${draft ? html`<p>Der er allerede en kladde. <a class="btn btn-primary btn-small" href="/job/faktura/${draft.id}">Åbn kladden</a></p><p class="hint">Opretter du kladden igen, bygges den forfra ud fra jobbet.</p>` : ''}
      <form method="post" action="/job/${j.id}/faktura" class="stack-sm"${draft ? html` data-confirm="Byg kladden forfra? Rettelser i den nuværende kladde går tabt."` : ''}>
        ${csrfField(d.csrf)}
        <fieldset class="field"><legend>Afregning</legend>
          ${(['medgaaet', 'fast', 'kombination'] as const).map((m) => html`<label class="check"><input type="radio" name="mode" value="${m}"${m === 'medgaaet' ? html` checked` : ''}> ${MODE_LABEL[m]}</label>`)}
        </fieldset>
        <div class="field"><label for="fixed">Aftalt fast pris (kr. ekskl. moms)</label><input id="fixed" class="in-num" name="fixed_amount" inputmode="decimal" placeholder="${d.quote ? krIn(d.quote.subtotal) : ''}"><p class="hint">Kun ved fast pris. Tom = overslagets beløb (ved kombination: arbejdslønnen i overslaget). Et overslag bliver aldrig automatisk en fast pris.</p></div>
        <button class="btn btn-primary" type="submit">${draft ? 'Byg kladden forfra' : 'Opret fakturakladde'}</button>
      </form>
    </section>
  </div>
  <section class="stack">
    <h2>Fakturaer og kreditnotaer</h2>
    ${invoiceTable(d.invoices, false)}
  </section>
</div>`;
}

export function invoiceTable(rows: (InvoiceRow & { job_number?: string; job_name?: string })[], withJob: boolean): H {
  return html`<div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Bilag</th>${withJob ? html`<th>Job</th><th>Slutkunde</th>` : ''}<th>Status</th><th>Dato</th><th>Betalingsfrist</th><th class="num">Inkl. moms</th></tr></thead>
    <tbody>${rows.length
      ? rows.map((i) => {
          const c = parseJson<CustomerInfo>(i.customer);
          return html`<tr class="row-link" data-href="/job/faktura/${i.id}">
        <td class="cell-main"><a class="title" href="/job/faktura/${i.id}">${invoiceLabel(i)}</a><small>${MODE_LABEL[i.mode]}</small></td>
        ${withJob ? html`<td data-label="Job">${i.job_number} ${i.job_name}</td><td data-label="Slutkunde">${c.name || '–'}</td>` : ''}
        <td data-label="Status">${invoiceTag(i)}</td>
        <td data-label="Dato">${i.issue_date ? formatDay(i.issue_date) : '–'}</td>
        <td data-label="Betalingsfrist">${i.kind === 'faktura' && i.due_date ? formatDay(i.due_date) : '–'}</td>
        <td class="num" data-label="Inkl. moms">${i.status === 'udstedt' ? formatKr(i.kind === 'kreditnota' ? -i.total : i.total) : '–'}</td>
      </tr>`;
        })
      : html`<tr><td colspan="${withJob ? 7 : 5}" class="empty">Ingen fakturaer endnu.</td></tr>`}</tbody>
  </table></div></div>`;
}

export function invoicesPage(d: { rows: (InvoiceRow & { job_number: string; job_name: string })[]; ready: { id: number; number: string; name: string; customer_name: string }[]; flashCode?: string; filter: string }): H {
  const tabs: [string, string][] = [
    ['', 'Alle'],
    ['kladde', 'Kladder'],
    ['udstedt', 'Udstedte'],
  ];
  return html`<div class="stack-lg">
  <div class="page-head"><div class="stack-sm"><div class="eyebrow">Job- og forbrugsportal</div><h1>Fakturaer</h1><p class="muted">Fakturaer og kreditnotaer for alle job. En faktura oprettes fra jobbets Faktura-fane.</p></div></div>
  ${flash(d.flashCode)}
  ${d.ready.length
    ? html`<section class="card stack"><h2>Afsluttede job, der ikke er faktureret</h2><ul>${d.ready.map((j) => html`<li><a href="/job/${j.id}/faktura">${j.number} ${j.name}</a>${j.customer_name ? ` · ${j.customer_name}` : ''}</li>`)}</ul></section>`
    : ''}
  <nav class="tabs">${tabs.map(([k, l]) => html`<a href="/job/faktura${k ? `?vis=${k}` : ''}"${d.filter === k ? html` aria-current="page"` : ''}>${l}</a>`)}<a href="/job/faktura/opfolgning">Betalingsopfølgning</a></nav>
  ${invoiceTable(d.rows, true)}
  <p class="hint"><a href="/lager/faktura">Tidligere fakturagrundlag</a> (fra før fakturering kom i jobportalen) kan stadig ses.</p>
</div>`;
}

function diffTable(t: InvoiceTotals, quote: JobQuoteRow | null): H {
  if (!quote) return html`<p class="muted small">Intet prisoverslag at sammenligne med.</p>`;
  const rows: [string, number, number | null][] = [
    ['Materialer', t.byType.materiale, quote.materials],
    ['Arbejdsløn', t.byType.tid, quote.labour],
    ['Andre omkostninger', t.byType.omkostning, quote.other],
    ['Fast pris', t.byType.fastpris, null],
  ];
  const diff = t.subtotal - quote.subtotal;
  return html`<table class="totals diff">
    <tr><td></td><td class="muted small">Overslag v${quote.version}</td><td class="muted small">Faktura</td></tr>
    ${rows.filter(([, a, b]) => a || b).map(([l, a, b]) => html`<tr><td>${l}</td><td>${b === null ? '–' : formatKr(b)}</td><td>${formatKr(a)}</td></tr>`)}
    <tr class="total"><td>Ekskl. moms</td><td>${formatKr(quote.subtotal)}</td><td>${formatKr(t.subtotal)}</td></tr>
    <tr><td><strong>Forskel</strong></td><td colspan="2"><strong>${diff === 0 ? 'Ingen' : `${diff > 0 ? '+' : ''}${formatKr(diff)}`}</strong> ${quote.subtotal ? `(${diff > 0 ? '+' : ''}${Math.round((diff / quote.subtotal) * 1000) / 10} %)` : ''}</td></tr>
  </table>`;
}

export function invoicePage(d: {
  inv: InvoiceRow;
  items: InvoiceItemRow[];
  job: { id: number; number: string; name: string };
  quote: JobQuoteRow | null;
  credited: InvoiceRow | null;
  problems: string[];
  csrf: string;
  flashCode?: string;
  errs?: string[];
  /** Betalinger og påmindelser (udstedte fakturaer) */
  payments?: H;
}): H {
  const inv = d.inv;
  const draft = inv.status === 'kladde';
  const credit = inv.kind === 'kreditnota';
  const t = draft ? invoiceTotals(d.items, inv.vat_rate) : { ...invoiceTotals(d.items, inv.vat_rate), subtotal: inv.subtotal, vat: inv.vat, total: inv.total };
  const c = parseJson<CustomerInfo>(inv.customer);
  const types: InvoiceItemRow['type'][] = ['fastpris', 'materiale', 'tid', 'omkostning'];
  return html`<div class="stack-lg">
  <div class="page-head"><div class="stack-sm"><div class="eyebrow"><a href="/job/${d.job.id}/faktura">${d.job.number} ${d.job.name}</a></div><h1>${invoiceLabel(inv)} ${invoiceTag(inv)}</h1>
    <p class="muted">${credit && d.credited ? html`Krediterer <a href="/job/faktura/${d.credited.id}">faktura nr. ${d.credited.number}</a> · ` : ''}${MODE_LABEL[inv.mode]}${inv.issued_at ? ` · udstedt ${formatDateTime(inv.issued_at)} af ${inv.issued_by}` : ''}</p></div>
    <div class="row"><a class="btn btn-secondary" href="/job/faktura/${inv.id}.pdf">Download PDF</a>${!draft && !credit ? html`<form method="post" action="/job/faktura/${inv.id}/kreditnota" data-confirm="Opret en kreditnota for faktura nr. ${inv.number}?">${csrfField(d.csrf)}<button class="btn btn-ghost" type="submit">Opret kreditnota</button></form>` : ''}</div>
  </div>
  ${flash(d.flashCode)}${errors(d.errs ?? [])}
  ${draft ? alert('info', html`Kladden er ikke en faktura endnu. Gennemse linjerne, ret det nødvendige, og udsted den. Ved udstedelse får den et fortløbende nummer og låses; senere prisopslag ændrer den aldrig. Rettelser sker derefter med en kreditnota.`) : ''}
  <div class="layout-side">
    <section class="stack">
      <div class="card stack">
        <div class="grid grid-2">
          <div><div class="eyebrow">Slutkunde</div><p>${c.name || html`<span class="miss">Navn mangler</span>`}${c.contact ? html`<br>Att. ${c.contact}` : ''}${c.address ? html`<br>${c.address.split('\n').map((l, i) => html`${i ? html`<br>` : ''}${l}`)}` : html`<br><span class="miss">Adresse mangler</span>`}${c.cvr ? html`<br>CVR ${c.cvr}` : ''}</p></div>
          <dl class="kv"><dt>Fakturadato</dt><dd>${inv.issue_date ? formatDay(inv.issue_date) : 'Ved udstedelse'}</dd><dt>Leveringsdato</dt><dd>${formatDay(inv.delivery_date)}</dd>${!credit ? html`<dt>Betalingsfrist</dt><dd>${inv.due_date ? formatDay(inv.due_date) : `${inv.payment_days} dage`}</dd>` : ''}<dt>Moms</dt><dd>${inv.vat_rate / 100} %</dd></dl>
        </div>
        ${draft
          ? html`<details><summary>Ret datoer og bemærkning</summary><form method="post" action="/job/faktura/${inv.id}/oplysninger" class="stack-sm">
              ${csrfField(d.csrf)}
              <div class="fields fields-3">
                <div class="field"><label>Leveringsdato</label><input type="date" name="delivery_date" value="${inv.delivery_date}"></div>
                ${!credit ? html`<div class="field"><label>Betalingsfrist (dage)</label><input class="in-num" name="payment_days" inputmode="numeric" value="${inv.payment_days}"></div>` : ''}
                ${inv.mode !== 'medgaaet' && !credit ? html`<div class="field"><label>Fast pris (kr. ekskl. moms)</label><input class="in-num" name="fixed_amount" inputmode="decimal" value="${krIn(inv.fixed_amount)}"></div>` : ''}
              </div>
              <div class="field"><label>Bemærkning på fakturaen</label><textarea name="note" maxlength="600" rows="2">${inv.note}</textarea></div>
              <button class="btn btn-secondary btn-small" type="submit">Gem</button>
            </form></details>`
          : inv.note ? html`<p class="muted">${inv.note}</p>` : ''}
      </div>
      <form method="post" action="/job/faktura/${inv.id}/linjer" class="card card-flush">
        ${csrfField(d.csrf)}
        <div class="table-wrap"><table class="list stackable dense invoice-lines">
          <thead><tr>${draft ? html`<th>Med</th>` : ''}<th>Beskrivelse</th><th class="num">Antal</th><th class="num">Pris pr. enhed</th><th class="num">Beløb</th></tr></thead>
          <tbody>${types.map((ty) => {
            const rows = d.items.filter((l) => l.type === ty && (draft || l.include));
            return rows.length
              ? html`<tr class="sec"><th colspan="${draft ? 5 : 4}">${TYPE_LABEL[ty]}</th></tr>${rows.map(
                  (l) => html`<tr${!l.include ? html` style="opacity:.55"` : ''}>
                ${draft ? html`<td data-label="Med"><input type="checkbox" name="inc_${l.id}" value="1"${l.include ? html` checked` : ''} aria-label="Med på fakturaen"></td>` : ''}
                <td class="cell-main">${draft ? html`<input name="desc_${l.id}" maxlength="300" value="${l.description}" aria-label="Beskrivelse">` : l.description}${l.covered ? html`<small>Indeholdt i den faste pris</small>` : ''}${l.note && !l.covered ? html`<small${l.unit_price === null ? html` class="miss"` : ''}>${l.note}</small>` : ''}</td>
                <td class="num" data-label="Antal">${draft && l.type !== 'fastpris' ? html`<input class="in-num in-sm" name="qty_${l.id}" inputmode="decimal" value="${qtyInput(l.qty)}" aria-label="Antal"> <span class="xs muted">${l.unit}</span>` : qtyUnit(l.qty, l.unit)}</td>
                <td class="num" data-label="Pris pr. enhed">${draft && !l.covered ? html`<input class="in-num in-sm" name="price_${l.id}" inputmode="decimal" value="${krIn(l.unit_price)}" placeholder="Pris mangler" aria-label="Pris pr. enhed">` : l.covered ? '–' : formatKr(l.unit_price)}</td>
                <td class="num" data-label="Beløb">${l.covered ? html`<span class="muted">Indeholdt</span>` : l.include && l.unit_price === null ? html`<span class="tag tag-low">Pris mangler</span>` : formatKr(itemAmount(l))}</td>
              </tr>`,
                )}`
              : '';
          })}${!d.items.length ? html`<tr><td colspan="5" class="empty">Ingen linjer. Der er intet at fakturere endnu.</td></tr>` : ''}</tbody>
        </table></div>
        ${draft && d.items.length ? html`<div class="row" style="padding:12px 16px"><button class="btn btn-secondary" type="submit">Gem ændringer i linjerne</button><span class="hint">Mængden kan ikke være højere end det, der er brugt og ikke faktureret.</span></div>` : ''}
      </form>
      ${draft
        ? html`<details class="card"><summary>Tilføj en linje</summary><form method="post" action="/job/faktura/${inv.id}/linje" class="stack-sm">
            ${csrfField(d.csrf)}
            <div class="field"><label>Beskrivelse</label><input name="description" maxlength="300" required></div>
            <div class="fields fields-3"><div class="field"><label>Antal</label><input class="in-num" name="qty" inputmode="decimal" value="1" required></div><div class="field"><label>Enhed</label><input name="unit" maxlength="20" value="stk."></div><div class="field"><label>Pris pr. enhed (kr. ekskl. moms)</label><input class="in-num" name="unit_price" inputmode="decimal" required></div></div>
            <button class="btn btn-secondary btn-small" type="submit">Tilføj linje</button>
          </form></details>`
        : ''}
    </section>
    <aside class="side stack">
      <section class="card stack">
        <table class="totals">
          <tr class="total"><td>I alt ekskl. moms</td><td>${formatKr(t.subtotal)}</td></tr>
          <tr><td>Moms ${inv.vat_rate / 100} %</td><td>${formatKr(t.vat)}</td></tr>
          <tr class="total"><td>${credit ? 'Krediteres inkl. moms' : 'I alt inkl. moms'}</td><td>${formatKr(t.total)}</td></tr>
        </table>
        ${!credit ? html`<h3>Overslag mod faktura</h3>${diffTable(t, d.quote)}` : ''}
      </section>
      ${draft
        ? html`<section class="card stack">
          <h2>Godkend og udsted</h2>
          ${d.problems.length ? alert('warn', html`Før ${credit ? 'kreditnotaen' : 'fakturaen'} kan udstedes:<ul>${d.problems.map((p) => html`<li>${p}</li>`)}</ul>`) : html`<p class="ok-text">Klar til udstedelse.</p>`}
          <form method="post" action="/job/faktura/${inv.id}/udsted" class="stack-sm" data-confirm="Udsted ${credit ? 'kreditnotaen' : 'fakturaen'}? Den får et fortløbende nummer og kan derefter ikke ændres.">
            ${csrfField(d.csrf)}
            <label class="check"><input type="checkbox" name="reviewed" value="1" required> Jeg har gennemset linjer, priser og slutkundens oplysninger</label>
            <button class="btn btn-primary btn-block" type="submit"${d.problems.length ? html` disabled` : ''}>Godkend og udsted</button>
          </form>
          <p class="hint">Moms og fakturakrav afhænger af virksomhedens momsforhold og af, om slutkunden er privat eller erhverv. Få det bekræftet af en revisor, før systemet bruges til rigtige fakturaer. PDF'en kan sendes til slutkunden fra din egen e-mail.</p>
          <form method="post" action="/job/faktura/${inv.id}/slet" data-confirm="Slet kladden?">${csrfField(d.csrf)}<button class="btn btn-ghost btn-small" type="submit">Slet kladden</button></form>
        </section>`
        : ''}
    </aside>
  </div>
  ${d.payments ?? ''}
</div>`;
}

// --- Historik ----------------------------------------------------------------------------------

export function historyTab(d: { job: JobHead; manager: boolean; moves: MovementView[]; log: JobLogRow[] }): H {
  return html`<div class="stack-lg">
  ${jobHeader(d.job, 'historik', d.manager)}
  <section class="stack">
    <h2>Job, overslag, timer og fakturaer</h2>
    <div class="card">${d.log.length
      ? html`<ul class="timeline">${d.log.map((l) => html`<li><strong>${l.text}</strong><br><span class="muted small">${formatDateTime(l.created_at)} · ${l.actor_name || l.actor}</span></li>`)}</ul>`
      : html`<p class="muted">Ingen hændelser endnu.</p>`}</div>
  </section>
  <section class="stack">
    <h2>Lagerbevægelser for jobbet</h2>
    <div class="card">${movesTable(d.moves, true)}</div>
  </section>
</div>`;
}
