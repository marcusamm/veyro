import { html } from 'hono/html';
import type { JobRow, MovementRow, NoticeRow, SupplierRow } from '../env';
import type { ProductOverview } from '../lib/catalog';
import { formatDateTime, formatDay, formatKr, formatQty, oereToInput, qtyInput, qtyUnit } from '../lib/format';
import { ADJUST_LABEL, type AdjustKind } from '../lib/inventory';
import { MOVE_LABEL } from '../lib/ledger';
import { lineStatus, outstanding, type LineView } from '../lib/purchasing';
import { LEVEL, safetyText, STATUS_LABEL, type StockStatus } from '../lib/stock';
import { errors, flash, lineTag, meter, pageHead, qtyOrMissing, rowClass, stockTag } from './common';
import { alert, csrfField, opField, type H } from './layout';
import { veyroId } from '../lib/produktkatalog';

export type MovementView = MovementRow & { product_name: string | null; product_unit: string | null; sku: string | null; job_number: string | null; job_name: string | null };

export function moveText(m: MovementView): H {
  const unit = m.product_unit ?? '';
  const parts: string[] = [];
  if (m.stock_delta) parts.push(`lager ${m.stock_delta > 0 ? '+' : ''}${formatQty(m.stock_delta)}`);
  if (m.reserved_delta) parts.push(`reserveret ${m.reserved_delta > 0 ? '+' : ''}${formatQty(m.reserved_delta)}`);
  return html`${formatQty(m.qty)} ${unit}${parts.length ? html` <span class="muted">(${parts.join(', ')})</span>` : ''}`;
}

function alertItem(p: ProductOverview, open: LineView[], csrf: string, op: string): H {
  const u = p.unit;
  const cls = p.plan.status === 'ingen' ? 'is-out' : p.plan.status === 'kritisk' ? 'is-crit' : '';
  const reorderPlaced = p.refill_ordered > 0;
  return html`<li class="${cls}">
  <div class="row-between"><a href="/lager/varer/${p.id}"><strong>${p.name}</strong> <span class="xs">${p.sku}</span></a>
    <span class="row">${stockTag(p.plan.status)}${reorderPlaced ? html`<span class="tag tag-ordered">Genbestilling oprettet</span>` : p.refill_pending > 0 ? html`<span class="tag tag-ready">På indkøbsliste</span>` : ''}</span></div>
  <span>Fysisk ${qtyUnit(p.stock, u)} · reserveret ${qtyUnit(p.reserved, u)} · <strong>disponibel ${qtyUnit(p.plan.available, u)}</strong></span>
  <span>Sikkerhedslager ${qtyUnit(p.plan.safety, u)} · genbestillingspunkt ${qtyUnit(p.plan.rop, u)}</span>
  <span>${p.supplier_name ?? 'Ingen leverandør'} · leveringstid ${p.plan.leadDays ?? '?'} dage</span>
  ${open.length
    ? html`<span>Åbne indkøb: ${open.map(
        (l, i) =>
          html`${i ? ', ' : ''}${formatQty(outstanding(l))} ${u} ${l.job_number ? `til ${l.job_number}` : 'til lager'} (${lineTag(lineStatus(l))}${l.expected_date ? html` forventet ${formatDay(l.expected_date)}` : ''})`,
      )}</span>`
    : html`<span>Ingen åbne indkøb.</span>`}
  <form method="post" action="/lager/varer/${p.id}/genbestil" class="row" style="margin-top:6px">
    ${csrfField(csrf)}${opField(op)}
    <label class="sr-only" for="g${p.id}">Mængde til lageropfyldning</label>
    <input id="g${p.id}" class="in-num in-sm" name="qty" inputmode="decimal" value="${p.suggest ? qtyInput(p.suggest) : ''}" placeholder="Mængde" required>
    <span class="xs">${u}</span>
    <button class="btn btn-dark btn-small" type="submit">Tilføj til lageropfyldning</button>
  </form>
</li>`;
}

export function dashboardPage(d: {
  products: ProductOverview[];
  openByProduct: Map<number, LineView[]>;
  deviations: (NoticeRow & { job_number: string | null })[];
  waitingJobs: (Pick<JobRow, 'id' | 'number' | 'name' | 'planned_date'> & { lines: number })[];
  moves: MovementView[];
  csrf: string;
  ops: string[];
  flashCode?: string;
  demo: boolean;
}): H {
  const count = (s: StockStatus) => d.products.filter((p) => p.plan.status === s).length;
  const alerts = d.products.filter((p) => LEVEL[p.plan.status] > 0).sort((a, b) => LEVEL[b.plan.status] - LEVEL[a.plan.status] || a.name.localeCompare(b.name));
  const missing = d.products.filter((p) => p.plan.status === 'mangler');
  return html`<div class="stack-lg">
  ${pageHead(
    'Lagerportal',
    'Lageroversigt',
    html`<a class="btn btn-secondary" href="/lager/modtagelse">Varemodtagelse</a><a class="btn btn-primary" href="/lager/varer/ny">+ Ny vare</a>`,
  )}
  ${flash(d.flashCode)}
  ${d.demo ? html`<div class="alert alert-info">Demo: se hele forløbet trin for trin under <a href="/lager/demo"><strong>Demoforløb</strong></a>.</div>` : ''}
  <div class="stats">
    <a class="stat" href="/lager/varer?status=genbestil"><span class="n">${count('genbestil')}</span><span class="l">Genbestilling nødvendig</span></a>
    <a class="stat" href="/lager/varer?status=kritisk"><span class="n">${count('kritisk')}</span><span class="l">Kritisk</span></a>
    <a class="stat" href="/lager/varer?status=ingen"><span class="n">${count('ingen')}</span><span class="l">Ingen disponible varer</span></a>
    <a class="stat" href="/lager/varer?status=mangler"><span class="n">${missing.length}</span><span class="l">Mangler opsætning</span></a>
  </div>
  <div class="app">
    <div class="app-bar"><span class="app-name">Advarsler og genbestilling</span>
      ${alerts.length ? html`<a class="app-toast" href="/lager/indkob"><span class="app-toast-dot"></span>${alerts.length} ${alerts.length === 1 ? 'vare' : 'varer'} skal bestilles hjem</a>` : ''}</div>
    <div class="app-grid">
      <section class="app-panel">
        <div class="app-title"><h2>Lageradvarsler</h2><a class="xs" href="/lager/varer">Alle varer</a></div>
        ${alerts.length
          ? html`<ul class="app-alerts">${alerts.map((p, i) => alertItem(p, d.openByProduct.get(p.id) ?? [], d.csrf, d.ops[i] ?? ''))}</ul>`
          : html`<p class="muted small">Alle varer er over genbestillingspunktet.</p>`}
      </section>
      <section class="app-panel">
        <div class="app-title"><h2>Job, der afventer materialer</h2><a class="xs" href="/job">Alle job</a></div>
        ${d.waitingJobs.length
          ? html`<ul class="app-log">${d.waitingJobs.map(
              (j) => html`<li><a href="/job/${j.id}">${j.number} ${j.name}</a><em>${j.lines} ${j.lines === 1 ? 'vare mangler' : 'varer mangler'}${j.planned_date ? ` · ${formatDay(j.planned_date)}` : ''}</em></li>`,
            )}</ul>`
          : html`<p class="muted small">Ingen job mangler materialer.</p>`}
        ${d.deviations.length
          ? html`<div class="app-title" style="margin-top:20px"><h2>Afvigelser</h2></div>
            <ul class="app-alerts">${d.deviations.map((n) => html`<li class="is-info"><a href="/job/${n.job_id}">${n.message}</a></li>`)}</ul>`
          : ''}
        ${missing.length
          ? html`<div class="app-title" style="margin-top:20px"><h2>Mangler opsætning</h2></div>
            <ul class="app-log">${missing.slice(0, 6).map((p) => html`<li><a href="/lager/varer/${p.id}">${p.name}</a><em>${p.plan.missing.join(', ')}</em></li>`)}</ul>`
          : ''}
      </section>
      <section class="app-panel app-panel--alerts">
        <div style="grid-column:1/-1">
          <div class="app-title"><h2>Seneste bevægelser</h2><a class="xs" href="/lager/historik">Hele historikken</a></div>
          ${movesTable(d.moves, true)}
        </div>
      </section>
    </div>
  </div>
</div>`;
}

export function movesTable(moves: MovementView[], compact = false): H {
  if (!moves.length) return html`<p class="muted small">Ingen bevægelser endnu.</p>`;
  return html`<div class="table-wrap"><table class="${compact ? 'mini' : 'list stackable dense'}">
  <thead><tr><th>Tidspunkt</th><th>Hændelse</th><th>Vare</th><th>Job</th><th class="num">Mængde</th>${compact ? '' : html`<th class="num">Fysisk efter</th><th class="num">Reserveret efter</th>`}<th>Medarbejder</th>${compact ? '' : html`<th>Årsag</th>`}</tr></thead>
  <tbody>${moves.map(
    (m) => html`<tr>
    <td class="nowrap" data-label="Tidspunkt">${formatDateTime(m.created_at)}</td>
    <td data-label="Hændelse">${MOVE_LABEL[m.kind] ?? m.kind}</td>
    <td data-label="Vare">${m.product_id ? html`<a href="/lager/varer/${m.product_id}">${m.product_name}</a>` : m.reason || '–'}</td>
    <td data-label="Job">${m.job_id ? html`<a href="/job/${m.job_id}">${m.job_number}</a>` : '–'}</td>
    <td class="num" data-label="Mængde">${moveText(m)}</td>
    ${compact
      ? ''
      : html`<td class="num" data-label="Fysisk efter">${m.product_id ? formatQty(m.stock_after) : '–'}</td><td class="num" data-label="Reserveret efter">${m.product_id ? formatQty(m.reserved_after) : '–'}</td>`}
    <td data-label="Medarbejder">${m.actor_name || m.actor}</td>
    ${compact ? '' : html`<td data-label="Årsag" class="small">${m.reason}</td>`}
  </tr>`,
  )}</tbody></table></div>`;
}

const FILTERS: [string, string][] = [
  ['', 'Alle'],
  ['genbestil', 'Genbestilling nødvendig'],
  ['kritisk', 'Kritisk'],
  ['ingen', 'Ingen disponible'],
  ['mangler', 'Mangler opsætning'],
  ['normal', 'Normal'],
];

export function productsPage(d: { products: ProductOverview[]; status: string; q: string; flashCode?: string }): H {
  const all = d.products;
  const words = d.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter(
    (p) =>
      (!d.status || p.plan.status === d.status) &&
      words.every((w) => `${p.sku} ${p.name} ${p.category} ${p.supplier_name ?? ''}`.toLowerCase().includes(w)),
  );
  return html`<div class="stack-lg">
  ${pageHead('Lagerportal', 'Varer og lager', html`<a class="btn btn-primary" href="/lager/varer/ny">+ Ny vare</a>`, 'Disponibel beholdning er fysisk beholdning minus reservationer til job.')}
  ${flash(d.flashCode)}
  <div class="toolbar">
    <nav class="tabs" aria-label="Filtrér efter status">${FILTERS.map(
      ([k, label]) =>
        html`<a href="/lager/varer${k ? `?status=${k}` : ''}"${d.status === k ? html` aria-current="page"` : ''}>${label} <span class="c">${k ? all.filter((p) => p.plan.status === k).length : all.length}</span></a>`,
    )}</nav>
    <form method="get" action="/lager/varer" class="row grow" role="search">
      ${d.status ? html`<input type="hidden" name="status" value="${d.status}">` : ''}
      <input type="search" name="q" value="${d.q}" placeholder="Søg på varenummer, navn eller leverandør" aria-label="Søg">
    </form>
  </div>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
    <thead><tr>
      <th>Vare</th><th>Enhed</th><th class="num">Fysisk</th><th class="num">Reserveret</th><th class="num">Disponibel</th>
      <th class="num">Bestilt</th><th class="num">Forbrug/dag</th><th>Leverandør</th><th class="num">Levering</th>
      <th class="num">Sikkerhedslager</th><th class="num">Genbestillingspunkt</th><th>Status</th>
    </tr></thead>
    <tbody>${shown.length
      ? shown.map(
          (p) => html`<tr class="row-link ${rowClass(p.plan.status)}" data-href="/lager/varer/${p.id}">
        <td class="cell-main"><a class="title" href="/lager/varer/${p.id}">${p.name}</a><span class="sku">${p.sku}</span></td>
        <td data-label="Enhed">${p.unit}</td>
        <td class="num" data-label="Fysisk">${formatQty(p.stock)}</td>
        <td class="num" data-label="Reserveret">${formatQty(p.reserved)}</td>
        <td class="num" data-label="Disponibel"><strong>${formatQty(p.plan.available)}</strong>${meter(p.plan)}</td>
        <td class="num" data-label="Bestilt">${p.on_order ? html`${formatQty(p.on_order)}<small>${p.next_date ? formatDay(p.next_date) : 'ingen dato'}</small>` : '–'}</td>
        <td class="num" data-label="Forbrug/dag">${qtyOrMissing(p.avg_daily_usage)}</td>
        <td data-label="Leverandør">${p.supplier_name ?? html`<span class="miss">Ingen</span>`}</td>
        <td class="num" data-label="Leveringstid">${p.plan.leadDays === null ? html`<span class="miss">Mangler opsætning</span>` : `${p.plan.leadDays} dage`}</td>
        <td class="num" data-label="Sikkerhedslager">${qtyOrMissing(p.plan.safety)}<small>${safetyText(p)}</small></td>
        <td class="num" data-label="Genbestillingspunkt">${qtyOrMissing(p.plan.rop)}</td>
        <td data-label="Status">${stockTag(p.plan.status)}${p.refill_ordered > 0 ? html` <span class="tag tag-ordered">Genbestilling oprettet</span>` : ''}${p.active ? '' : html` <span class="tag tag-off">Inaktiv</span>`}</td>
      </tr>`,
        )
      : html`<tr><td colspan="12" class="empty">Ingen varer matcher.</td></tr>`}</tbody>
  </table></div></div>
</div>`;
}

export interface ProductFormValues {
  sku: string;
  name: string;
  unit: string;
  whole_units: boolean;
  category: string;
  supplier_id: string;
  lead_time_days: string;
  avg_daily_usage: string;
  safety_method: string;
  safety_qty: string;
  buffer_days: string;
  max_stock: string;
  purchase_price: string;
  sale_price: string;
  ean: string;
  mpn: string;
  brand: string;
  variant: string;
  active: boolean;
  initial_stock: string;
}

export function productValues(p: ProductOverview | null): ProductFormValues {
  return {
    sku: p?.sku ?? '',
    name: p?.name ?? '',
    unit: p?.unit ?? 'stk.',
    whole_units: p ? !!p.whole_units : true,
    category: p?.category ?? '',
    supplier_id: p?.supplier_id ? String(p.supplier_id) : '',
    lead_time_days: p?.lead_time_days === null || p?.lead_time_days === undefined ? '' : String(p.lead_time_days),
    avg_daily_usage: qtyInput(p?.avg_daily_usage),
    safety_method: p?.safety_method ?? 'antal',
    safety_qty: qtyInput(p?.safety_qty),
    buffer_days: p?.buffer_days === null || p?.buffer_days === undefined ? '' : String(p.buffer_days),
    max_stock: qtyInput(p?.max_stock),
    purchase_price: p?.purchase_price === null || p?.purchase_price === undefined ? '' : oereToInput(p.purchase_price),
    sale_price: p?.sale_price === null || p?.sale_price === undefined ? '' : oereToInput(p.sale_price),
    ean: p?.ean ? p.ean.replace(/^0(?=\d{13}$)/, '') : '',
    mpn: p?.mpn ?? '',
    brand: p?.brand ?? '',
    variant: p?.variant ?? '',
    active: p ? !!p.active : true,
    initial_stock: '',
  };
}

function productForm(v: ProductFormValues, d: { csrf: string; suppliers: SupplierRow[]; isNew: boolean; action: string; errs: string[] }): H {
  return html`<form method="post" action="${d.action}" class="stack-lg">
  ${csrfField(d.csrf)}
  ${errors(d.errs)}
  <fieldset class="card stack">
    <legend>Vare</legend>
    <div class="fields fields-2">
      <div class="field"><label for="sku">Varenummer</label><input id="sku" name="sku" required maxlength="40" value="${v.sku}"></div>
      <div class="field"><label for="name">Varenavn</label><input id="name" name="name" required maxlength="120" value="${v.name}"></div>
    </div>
    <div class="fields fields-3">
      <div class="field"><label for="unit">Enhed</label><input id="unit" name="unit" required maxlength="20" value="${v.unit}"><p class="hint">Fx stk., m, L, pk.</p></div>
      <div class="field"><label for="category">Kategori</label><input id="category" name="category" maxlength="60" value="${v.category}"></div>
      <div class="field"><label for="supplier_id">Leverandør</label><select id="supplier_id" name="supplier_id">
        <option value="">Ingen</option>
        ${d.suppliers.map((s) => html`<option value="${s.id}"${String(s.id) === v.supplier_id ? html` selected` : ''}>${s.name}${s.lead_time_days !== null ? ` (${s.lead_time_days} dage)` : ''}</option>`)}
      </select></div>
    </div>
    <label class="check"><input type="checkbox" name="whole_units" value="1"${v.whole_units ? html` checked` : ''}> Håndteres kun i hele enheder (mængder rundes op)</label>
    ${d.isNew
      ? html`<div class="field"><label for="initial_stock">Startbeholdning</label><input id="initial_stock" class="in-num" name="initial_stock" inputmode="decimal" value="${v.initial_stock}" placeholder="0"><p class="hint">Registreres som første bevægelse i historikken.</p></div>`
      : html`<label class="check"><input type="checkbox" name="active" value="1"${v.active ? html` checked` : ''}> Aktiv (kan vælges på job og indkøb)</label>`}
  </fieldset>
  <fieldset class="card stack">
    <legend>Genbestilling</legend>
    <p class="muted small">Genbestillingspunkt = dagligt forbrug × leveringstid + sikkerhedslager. Alt regnes i kalenderdage. Tomme felter vises som "Mangler opsætning".</p>
    <div class="fields fields-3">
      <div class="field"><label for="avg_daily_usage">Gennemsnitligt dagligt forbrug</label><input id="avg_daily_usage" class="in-num" name="avg_daily_usage" inputmode="decimal" value="${v.avg_daily_usage}"><p class="hint">Pr. kalenderdag, i varens enhed.</p></div>
      <div class="field"><label for="lead_time_days">Leveringstid i dage</label><input id="lead_time_days" class="in-num" name="lead_time_days" inputmode="numeric" value="${v.lead_time_days}"><p class="hint">Tom = leverandørens leveringstid.</p></div>
      <div class="field"><label for="max_stock">Ønsket maksimumbeholdning</label><input id="max_stock" class="in-num" name="max_stock" inputmode="decimal" value="${v.max_stock}"><p class="hint">Bruges til forslag til indkøbsmængde.</p></div>
    </div>
    <div class="field">
      <span class="label" style="display:block;font-weight:600;font-size:14px;margin-bottom:6px">Sikkerhedslager</span>
      <div class="radio-cards">
        <label class="radio-card"><input type="radio" name="safety_method" value="antal"${v.safety_method === 'antal' ? html` checked` : ''}><span><strong>Fast antal</strong><span class="muted small">Et manuelt antal enheder</span></span></label>
        <label class="radio-card"><input type="radio" name="safety_method" value="dage"${v.safety_method === 'dage' ? html` checked` : ''}><span><strong>Bufferdage</strong><span class="muted small">Dagligt forbrug × bufferdage</span></span></label>
      </div>
    </div>
    <div class="field" data-safety="antal"><label for="safety_qty">Sikkerhedslager (antal)</label><input id="safety_qty" class="in-num" name="safety_qty" inputmode="decimal" value="${v.safety_qty}"></div>
    <div class="field" data-safety="dage"><label for="buffer_days">Bufferdage</label><input id="buffer_days" class="in-num" name="buffer_days" inputmode="numeric" value="${v.buffer_days}"><p class="hint">Sikkerhedslager = dagligt forbrug × bufferdage, rundet op.</p></div>
    <p class="muted small">Sikkerhedslageret er en advarselsgrænse, ikke en låst mængde: varerne må gerne bruges.</p>
  </fieldset>
  <fieldset class="card stack">
    <legend>Priser</legend>
    <div class="fields fields-2">
      <div class="field"><label for="purchase_price">Indkøbspris pr. enhed (kr.)</label><input id="purchase_price" class="in-num" name="purchase_price" inputmode="decimal" value="${v.purchase_price}"><p class="hint">Opdateres med den faktiske pris ved varemodtagelse.</p></div>
      <div class="field"><label for="sale_price">Salgspris pr. enhed (kr.)</label><input id="sale_price" class="in-num" name="sale_price" inputmode="decimal" value="${v.sale_price}"><p class="hint">Tom = indkøbspris plus jobbets påslag.</p></div>
    </div>
    <p class="muted small">Priser vises kun for ejer og indkøber.</p>
  </fieldset>
  <fieldset class="card stack">
    <legend>Produktdata til prisestimat</legend>
    <p class="muted small">Bruges til at finde præcis samme vare hos byggemarkeder og trælaster. EAN giver det sikreste match; ellers producentens varenummer sammen med mærke og variant.</p>
    <div class="fields fields-2">
      <div class="field"><label for="ean">EAN/GTIN</label><input id="ean" class="in-num" name="ean" inputmode="numeric" maxlength="20" value="${v.ean}"></div>
      <div class="field"><label for="mpn">Producentens varenummer</label><input id="mpn" name="mpn" maxlength="60" value="${v.mpn}"></div>
    </div>
    <div class="fields fields-2">
      <div class="field"><label for="brand">Mærke</label><input id="brand" name="brand" maxlength="60" value="${v.brand}"></div>
      <div class="field"><label for="variant">Variant</label><input id="variant" name="variant" maxlength="60" value="${v.variant}"><p class="hint">Fx farve, længde eller kvalitet.</p></div>
    </div>
  </fieldset>
  <div class="row"><button class="btn btn-primary" type="submit">${d.isNew ? 'Opret vare' : 'Gem vare'}</button><a class="btn btn-ghost" href="${d.isNew ? '/lager/varer' : d.action}">Annullér</a></div>
</form>`;
}

export function newProductPage(v: ProductFormValues, d: { csrf: string; suppliers: SupplierRow[]; errs: string[]; catalog?: H }): H {
  return html`<div class="stack-lg" style="max-width:860px">
  ${pageHead('Varer og lager', 'Ny vare')}
  ${d.catalog ? html`<section class="card stack"><h2>Find varen i produktkataloget</h2><p class="hint" style="margin:0">Vælg varen i kataloget, så navn, numre og enhed udfyldes. Varen oprettes uden lagerbeholdning.</p>${d.catalog}</section><script src="/static/katalog.js" defer></script><h2>Eller opret varen manuelt</h2>` : ''}
  ${productForm(v, { ...d, isNew: true, action: '/lager/varer/ny' })}
</div>`;
}

export function productPage(d: {
  p: ProductOverview;
  values: ProductFormValues;
  suppliers: SupplierRow[];
  open: LineView[];
  jobs: { job_id: number; number: string; name: string; reserved: number; waiting: number }[];
  moves: MovementView[];
  csrf: string;
  op: string;
  op2: string;
  errs: string[];
  moveError?: string;
  flashCode?: string;
  pagesCard?: H;
}): H {
  const p = d.p;
  const u = p.unit;
  const plan = p.plan;
  const formula =
    plan.rop !== null
      ? `${formatQty(plan.avgDaily)} × ${plan.leadDays} + ${formatQty(plan.safety)} = ${formatQty(plan.rop)} ${u}`
      : `Mangler opsætning: ${plan.missing.join(', ')}`;
  const kinds: AdjustKind[] = ['modtagelse', 'returvare', 'optaelling', 'svind', 'leverandorretur'];
  return html`<div class="stack-lg">
  ${pageHead('Varer og lager', html`${p.name} <span class="sku" style="font-size:16px">${p.sku}</span>`, html`<a class="btn btn-ghost" href="/lager/varer">← Alle varer</a><form method="post" action="/lager/varer/${p.id}/slet" class="inline" data-confirm="Slet varen? Har den historik eller beholdning, bliver den i stedet gjort inaktiv.">${csrfField(d.csrf)}<button class="btn btn-danger" type="submit">Slet vare</button></form>`)}
  ${flash(d.flashCode)}
  ${p.catalog_product_id ? html`<p class="hint" style="margin:0">Knyttet til produktkataloget: <a href="/katalog/${p.catalog_product_id}">${veyroId(p.catalog_product_id)}</a>. Kataloget ændrer aldrig beholdningen.</p>` : ''}
  <div class="layout-side">
    <div class="stack-lg">
      <div class="card stack">
        <div class="row-between"><h2>Lagerstatus</h2><span class="row">${stockTag(plan.status)}${p.refill_ordered > 0 ? html`<span class="tag tag-ordered">Genbestilling oprettet</span>` : ''}</span></div>
        <div class="stats" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat"><span class="n">${formatQty(p.stock)}</span><span class="l">Fysisk (${u})</span></div>
          <div class="stat"><span class="n">${formatQty(p.reserved)}</span><span class="l">Reserveret</span></div>
          <div class="stat"><span class="n">${formatQty(plan.available)}</span><span class="l">Disponibel</span></div>
        </div>
        <dl class="kv">
          <dt>Sikkerhedslager</dt><dd>${qtyOrMissing(plan.safety, u)} <span class="muted small">(${safetyText(p)})</span></dd>
          <dt>Genbestillingspunkt</dt><dd>${formula}</dd>
          <dt>Leveringstid</dt><dd>${plan.leadDays === null ? html`<span class="miss">Mangler opsætning</span>` : `${plan.leadDays} dage${plan.leadFromSupplier ? ' (leverandørens)' : ''}`}</dd>
          <dt>Leverandør</dt><dd>${p.supplier_name ?? '–'}</dd>
          <dt>Bestilt, ikke modtaget</dt><dd>${p.on_order ? html`${qtyUnit(p.on_order, u)}${p.next_date ? `, første forventet ${formatDay(p.next_date)}` : ''}` : '–'}</dd>
        </dl>
        ${LEVEL[plan.status] > 0 && p.refill_ordered > 0 ? alert('warn', 'Der er oprettet en genbestilling, men varerne er ikke modtaget endnu, så advarslen er stadig aktiv.') : ''}
      </div>
      <div class="card stack">
        <h2>Åbne indkøb</h2>
        ${d.open.length
          ? html`<div class="table-wrap"><table class="mini"><thead><tr><th>Til</th><th class="num">Mængde</th><th>Status</th><th>Forventet</th><th>Liste</th></tr></thead><tbody>${d.open.map(
              (l) => html`<tr><td>${l.job_number ? html`<a href="/job/${l.job_id}">${l.job_number}</a>` : 'Lager'}</td><td class="num">${qtyUnit(outstanding(l), u)}</td><td>${lineTag(lineStatus(l))}</td><td>${formatDay(l.expected_date)}</td><td><a href="/lager/indkob/${l.list_id}">${l.list_name}</a></td></tr>`,
            )}</tbody></table></div>`
          : html`<p class="muted small">Ingen åbne indkøb.</p>`}
        <form method="post" action="/lager/varer/${p.id}/genbestil" class="row">
          ${csrfField(d.csrf)}${opField(d.op2)}
          <label for="gq" class="sr-only">Mængde</label>
          <input id="gq" class="in-num" name="qty" inputmode="decimal" value="${p.suggest ? qtyInput(p.suggest) : ''}" placeholder="Mængde" required>
          <span class="muted">${u}</span>
          <button class="btn btn-dark btn-small" type="submit">Tilføj til lageropfyldning</button>
        </form>
        <p class="hint">Forslaget fylder op til ${p.max_stock !== null ? `den ønskede maksimumbeholdning (${qtyUnit(p.max_stock, u)})` : 'genbestillingspunktet plus én leveringstids forbrug'}, minus det, der allerede er på vej. Indkøberen godkender mængden.</p>
      </div>
      ${d.pagesCard ?? ''}
      <div class="card stack">
        <h2>Reserveret til job</h2>
        ${d.jobs.length
          ? html`<ul class="app-log">${d.jobs.map(
              (j) => html`<li><a href="/job/${j.job_id}">${j.number} ${j.name}</a><em>${j.reserved ? `${qtyUnit(j.reserved, u)} reserveret` : ''}${j.reserved && j.waiting ? ' · ' : ''}${j.waiting ? `${qtyUnit(j.waiting, u)} afventer indkøb` : ''}</em></li>`,
            )}</ul>`
          : html`<p class="muted small">Ingen reservationer.</p>`}
      </div>
      <div class="card stack">
        <h2>Historik</h2>
        ${movesTable(d.moves, true)}
      </div>
    </div>
    <aside class="side side-first stack-lg">
      <form method="post" action="/lager/varer/${p.id}/bevaegelse" class="card stack">
        ${csrfField(d.csrf)}${opField(d.op)}
        <h2>Registrér bevægelse</h2>
        ${d.moveError ? alert('err', d.moveError) : ''}
        <div class="field"><label for="kind">Type</label><select id="kind" name="kind">${kinds.map((k) => html`<option value="${k}">${ADJUST_LABEL[k]}</option>`)}</select></div>
        <div class="field"><label for="mq">Mængde (${u})</label><input id="mq" class="in-num" name="qty" inputmode="decimal" required><p class="hint">Ved optælling: den optalte beholdning.</p></div>
        <div class="field"><label for="mp">Indkøbspris pr. enhed (kun modtagelse)</label><input id="mp" class="in-num" name="price" inputmode="decimal" placeholder="${p.purchase_price !== null ? oereToInput(p.purchase_price) : ''}"></div>
        <div class="field"><label for="mr">Årsag eller bemærkning</label><input id="mr" name="reason" maxlength="200"></div>
        <button class="btn btn-primary" type="submit">Registrér</button>
        <p class="hint">Varer fra en indkøbsliste modtages under Varemodtagelse, så de knyttes til den rigtige bestilling og det rigtige job.</p>
      </form>
      <div class="card stack"><h2>Priser</h2><dl class="kv"><dt>Indkøbspris</dt><dd>${formatKr(p.purchase_price)}</dd><dt>Salgspris</dt><dd>${p.sale_price === null ? 'Indkøbspris + påslag' : formatKr(p.sale_price)}</dd></dl></div>
    </aside>
  </div>
  <h2>Indstillinger for varen</h2>
  <div style="max-width:860px">${productForm(d.values, { csrf: d.csrf, suppliers: d.suppliers, isNew: false, action: `/lager/varer/${p.id}`, errs: d.errs })}</div>
</div>`;
}

export function historyPage(d: { moves: MovementView[]; kind: string; page: number; more: boolean }): H {
  const kinds = Object.entries(MOVE_LABEL);
  return html`<div class="stack-lg">
  ${pageHead('Lagerportal', 'Historik', '', 'Alle lagerbevægelser med tidspunkt, medarbejder, mængde, årsag og job.')}
  <form method="get" action="/lager/historik" class="toolbar">
    <select name="type" data-autosubmit aria-label="Type"><option value="">Alle typer</option>${kinds.map(
      ([k, l]) => html`<option value="${k}"${d.kind === k ? html` selected` : ''}>${l}</option>`,
    )}</select>
    <noscript><button class="btn btn-secondary btn-small" type="submit">Vis</button></noscript>
    <a class="btn btn-ghost btn-small" href="/lager/historik.csv${d.kind ? `?type=${d.kind}` : ''}">Hent CSV</a>
  </form>
  <div class="card card-flush">${movesTable(d.moves)}</div>
  <div class="pager">${d.page > 1 ? html`<a class="btn btn-secondary btn-small" href="?page=${d.page - 1}${d.kind ? `&type=${d.kind}` : ''}">Nyere</a>` : ''}${d.more
    ? html`<a class="btn btn-secondary btn-small" href="?page=${d.page + 1}${d.kind ? `&type=${d.kind}` : ''}">Ældre</a>`
    : ''}</div>
</div>`;
}

export { STATUS_LABEL };
