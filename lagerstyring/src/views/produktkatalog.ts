// Produktkatalog: søgning efter materialer, produktdetaljer, valg af vare til et job og import
// af produktfiler med forhåndsvisning.

import { html } from 'hono/html';
import type { ProductRow } from '../env';
import { formatDate, formatDateTime, formatDay, formatKr, formatQty, qtyUnit } from '../lib/format';
import { HANDLING_LABEL, usablePrice, type Handling } from '../lib/katalogvalg';
import {
  CATALOG_FIELDS,
  CATALOG_VAT_LABEL,
  FIELD_LABEL,
  PRICE_TYPE_LABEL,
  SOURCE_KIND_LABEL,
  hitPrice,
  veyroId,
  type CatalogDetail,
  type CatalogImportRow,
  type CatalogPriceRow,
  type CatalogProductRow,
  type CatalogSourceRow,
  type HitPrice,
  type PreviewRow,
  type SearchHit,
  type SearchResult,
} from '../lib/produktkatalog';
import { errors, flash, pageHead } from './common';
import { jobHeader, type JobHead } from './job';
import { alert, csrfField, opField, type H } from './layout';

export const SEARCH_LABEL = 'Søg efter varenavn, varenummer eller EAN';

export type Ctx = { kind: 'job'; jobId: number } | { kind: 'lager' } | { kind: 'portal' } | { kind: 'ny' };

/** Hvor et søgeresultat fører hen i den aktuelle sammenhæng. */
export function hitHref(h: Pick<SearchHit, 'kind' | 'id' | 'product_sku'>, ctx: Ctx): string {
  if (ctx.kind === 'job') return h.kind === 'katalog' ? `/job/${ctx.jobId}/materialer/katalog/${h.id}` : `/job/${ctx.jobId}/materialer/vare/${h.id}`;
  if (ctx.kind === 'lager' || ctx.kind === 'ny') return h.kind === 'katalog' ? `/katalog/${h.id}${ctx.kind === 'ny' ? '?fra=ny' : ''}` : `/lager/varer/${h.id}`;
  return h.kind === 'katalog' ? `/katalog/${h.id}` : `/job/lager?q=${encodeURIComponent(h.product_sku ?? '')}`;
}

function amountText(amount: number, currency: string): string {
  if (currency === 'DKK') return formatKr(amount);
  const n = formatKr(amount).replace(/ kr\.$/, '');
  return currency ? `${n} ${currency}` : `${n} (valuta ukendt)`;
}

/** Pris med kilde og type, fx "123 kr. ekskl. moms · Producentens listepris fra KEMPER". */
export function priceLine(p: Pick<HitPrice, 'amount' | 'currency' | 'vat' | 'price_type' | 'per' | 'seller'> & { source: string }): string {
  return `${amountText(p.amount, p.currency)} ${CATALOG_VAT_LABEL[p.vat]}${p.per ? ` pr. ${p.per}` : ''} · ${PRICE_TYPE_LABEL[p.price_type]} fra ${p.source}${p.seller ? ` (${p.seller})` : ''}`;
}

function priceCell(h: SearchHit, manager: boolean): H {
  if (h.kind === 'lager') return html`<span class="muted xs">Se varen</span>`;
  const p = hitPrice(h);
  if (!p) return html`<span class="tag tag-low">Pris mangler</span>`;
  if (!manager) return html`<span class="tag tag-ok">Har katalogpris</span>`;
  return html`<strong>${amountText(p.amount, p.currency)}</strong><small>${CATALOG_VAT_LABEL[p.vat]}${p.per ? ` pr. ${p.per}` : ''}</small><small>${PRICE_TYPE_LABEL[p.price_type]}, ${p.source}</small>`;
}

function stockCell(h: SearchHit): H {
  if (h.product_id === null || h.stock === null) return html`<span class="muted xs">Ikke i varekartoteket</span>`;
  const avail = (h.stock ?? 0) - (h.reserved ?? 0);
  return html`${avail > 0 ? html`<strong>${formatQty(avail)}</strong> disponibel` : html`<span class="tag tag-out">0 disponibel</span>`}<small>${h.product_sku}</small>`;
}

function codeLine(h: Pick<SearchHit, 'mpn' | 'dealer_sku' | 'ean'>): string {
  return [h.mpn && `Varenr. ${h.mpn}`, h.dealer_sku && `Forh.nr. ${h.dealer_sku}`, h.ean && `EAN ${h.ean}`].filter(Boolean).join(' · ');
}

function demoTag(isDemo: number | boolean, kind?: string): H | '' {
  return isDemo || kind === 'demo' ? html` <span class="tag tag-demo">Demodata</span>` : '';
}

function qs(o: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '' && v !== 0) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface SearchPanel {
  action: string;
  ctx: Ctx;
  q: string;
  maker: string;
  category: string;
  facets: { makers: { key: string; name: string; n: number }[]; categories: { name: string; n: number }[] };
  result: SearchResult | null;
  manager: boolean;
  /** Ekstra parametre i søgeformularen (fx fane) */
  hidden?: Record<string, string>;
  anchor?: string;
  autofocus?: boolean;
}

export function searchPanel(d: SearchPanel): H {
  const r = d.result;
  const jobId = d.ctx.kind === 'job' ? String(d.ctx.jobId) : '';
  const pageHref = (page: number) => `${d.action}${qs({ ...d.hidden, q: d.q, producent: d.maker, kategori: d.category, side: page > 1 ? page : null })}${d.anchor ? `#${d.anchor}` : ''}`;
  return html`<div class="stack katalog-search">
  <form method="get" action="${d.action}${d.anchor ? `#${d.anchor}` : ''}" class="stack-sm" role="search">
    ${Object.entries(d.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <label for="katalog-q"><strong>${SEARCH_LABEL}</strong></label>
    <div class="suggest-wrap">
      <div class="toolbar">
        <input id="katalog-q" type="search" name="q" value="${d.q}" placeholder="Fx gipsplade 13, DEMO-GP13-0925 eller 2000000000138" autocomplete="off" maxlength="100"
          data-katalog-suggest data-ctx="${d.ctx.kind}" data-job="${jobId}" aria-autocomplete="list" aria-controls="katalog-forslag" aria-expanded="false"${d.autofocus ? html` autofocus` : ''}>
        <button class="btn btn-primary" type="submit">Søg</button>
      </div>
      <ul id="katalog-forslag" class="suggest" role="listbox" hidden></ul>
    </div>
    <div class="toolbar">
      <select name="producent" aria-label="Producent" data-katalog-filter><option value="">Alle producenter</option>${d.facets.makers.map((m) => html`<option value="${m.key}"${m.key === d.maker ? html` selected` : ''}>${m.name} (${m.n})</option>`)}</select>
      <select name="kategori" aria-label="Kategori" data-katalog-filter><option value="">Alle kategorier</option>${d.facets.categories.map((c) => html`<option value="${c.name}"${c.name === d.category ? html` selected` : ''}>${c.name} (${c.n})</option>`)}</select>
    </div>
  </form>
  ${r
    ? html`${r.corrected.length ? html`<p class="hint">Viser også resultater for ${r.corrected.map((c, i) => html`${i ? ', ' : ''}<strong>${c.to.join(' / ')}</strong> (i stedet for "${c.from}")`)}.</p>` : ''}
      <p class="muted small" style="margin:0" aria-live="polite">${r.total === 0 ? 'Ingen varer fundet.' : `${r.total.toLocaleString('da-DK')} ${r.total === 1 ? 'vare' : 'varer'} fundet${r.total > r.perPage ? `, side ${r.page} af ${Math.ceil(r.total / r.perPage)}` : ''}.`}</p>
      ${r.hits.length ? resultsTable(r.hits, d.ctx, d.manager) : ''}
      ${r.total > r.perPage
        ? html`<div class="pager">${r.page > 1 ? html`<a class="btn btn-secondary btn-small" href="${pageHref(r.page - 1)}">Forrige</a>` : ''}${r.page * r.perPage < r.total ? html`<a class="btn btn-secondary btn-small" href="${pageHref(r.page + 1)}">Næste</a>` : ''}</div>`
        : ''}`
    : ''}
</div>`;
}

function resultsTable(hits: SearchHit[], ctx: Ctx, manager: boolean): H {
  const choose = ctx.kind === 'job' ? 'Vælg' : 'Åbn';
  return html`<div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
    <thead><tr><th>Vare</th><th>Varenummer</th><th>Enhed</th><th>Eget lager</th><th>Pris</th><th></th></tr></thead>
    <tbody>${hits.map((h) => {
      const href = hitHref(h, ctx);
      return html`<tr class="row-link" data-href="${href}">
        <td class="cell-main"><a class="title" href="${href}">${h.name}</a>${h.variant || h.dimensions ? html`<small>${[h.variant, h.dimensions].filter(Boolean).join(' · ')}</small>` : ''}<small>${h.manufacturer || 'Producent ukendt'} · ${h.source_name}${demoTag(h.is_demo, h.source_kind)}${h.status === 'gennemgang' ? html` <span class="tag tag-low">Til gennemgang</span>` : ''}</small></td>
        <td data-label="Varenummer" class="xs">${codeLine(h) || '–'}${h.kind === 'katalog' ? html`<small>${veyroId(h.id)}</small>` : html`<small>Eget varekartotek</small>`}</td>
        <td data-label="Enhed">${h.unit || html`<span class="miss">Ukendt</span>`}${h.pack_size ? html`<small>${h.pack_size}</small>` : ''}</td>
        <td data-label="Eget lager">${stockCell(h)}</td>
        <td data-label="Pris">${priceCell(h, manager)}</td>
        <td><a class="btn btn-secondary btn-small" href="${href}">${choose}</a></td>
      </tr>`;
    })}</tbody>
  </table></div></div>`;
}

/** Forslag under indtastning (JSON til browseren). */
export function suggestJson(r: SearchResult, ctx: Ctx, manager: boolean) {
  return {
    total: r.total,
    corrected: r.corrected,
    hits: r.hits.map((h) => {
      const p = hitPrice(h);
      return {
        href: hitHref(h, ctx),
        name: h.name,
        detail: [h.variant, h.dimensions, h.manufacturer].filter(Boolean).join(' · '),
        codes: [codeLine(h), h.kind === 'katalog' ? veyroId(h.id) : 'Eget varekartotek'].filter(Boolean).join(' · '),
        unit: h.unit || 'Enhed ukendt',
        stock: h.product_id !== null && h.stock !== null ? `${formatQty((h.stock ?? 0) - (h.reserved ?? 0))} disponibel` : 'Ikke på lager',
        price: h.kind === 'lager' ? '' : !p ? 'Pris mangler' : manager ? `${amountText(p.amount, p.currency)} ${CATALOG_VAT_LABEL[p.vat]}` : 'Har katalogpris',
        demo: !!h.is_demo || h.source_kind === 'demo',
      };
    }),
  };
}

// --- Produktdetaljer ---------------------------------------------------------------------------

function kv(label: string, value: string | H, unknown = 'Ukendt'): H {
  return html`<dt>${label}</dt><dd>${value === '' ? html`<span class="muted">${unknown}</span>` : value}</dd>`;
}

export function productFacts(c: CatalogDetail): H {
  return html`<dl class="kv">
    ${kv('Veyro produkt-ID', html`<span class="sku">${veyroId(c.id)}</span>`)}
    ${kv('Producent', c.manufacturer)}
    ${kv('Producentens varenummer', c.mpn ? html`<span class="sku">${c.mpn}</span>` : '')}
    ${c.dealer_sku ? kv('Forhandlerens varenummer', html`<span class="sku">${c.dealer_sku}</span>`) : ''}
    ${kv('EAN/GTIN', c.ean ? html`<span class="sku">${c.ean}</span>${c.gtin ? '' : html` <span class="tag tag-low">Ugyldigt kontrolciffer</span>`}` : '')}
    ${kv('Kategori', c.category)}
    ${kv('Variant', c.variant)}
    ${kv('Dimensioner', c.dimensions)}
    ${kv('Materiale', c.material)}
    ${kv('Enhed', c.unit)}
    ${kv('Pakkestørrelse', c.pack_size)}
    ${kv('Produktlink', c.url ? html`<a href="${c.url}" target="_blank" rel="noopener noreferrer">${c.url.replace(/^https?:\/\//, '').slice(0, 60)} ↗</a>` : '')}
    ${kv('Datakilde', html`${c.source_name} (${SOURCE_KIND_LABEL[c.source_kind]})${demoTag(c.is_demo, c.source_kind)}`)}
    ${kv('Opdateret ifølge filen', c.source_updated ? formatDay(c.source_updated) : '')}
    ${kv('Seneste import', formatDateTime(c.imported_at))}
    ${c.status !== 'aktiv' ? kv('Status', html`<span class="tag tag-low">${c.status === 'gennemgang' ? 'Til gennemgang' : 'Skjult'}</span> ${c.review_note}`) : ''}
  </dl>${c.description ? html`<p class="small" style="white-space:pre-line">${c.description}</p>` : ''}`;
}

export function pricesBlock(prices: (CatalogPriceRow & { source_name: string })[], manager: boolean): H {
  if (!prices.length)
    return html`<div class="stack-sm"><p style="margin:0"><span class="tag tag-low">Pris mangler</span></p><p class="hint">Filen har ingen pris for varen. Varen kan stadig vælges; prisen kan slås op hos byggemarkedet eller indtastes manuelt på jobbet.</p></div>`;
  if (!manager) return html`<p class="muted small" style="margin:0">Kataloget har en pris for varen. Priser vises kun for ejer og indkøber.</p>`;
  return html`<ul class="stack-sm" style="margin:0;padding-left:18px">${prices.map(
    (p) => html`<li>${priceLine({ ...p, source: p.source_name })}<small class="muted"> · indlæst ${formatDate(p.imported_at)}</small></li>`,
  )}</ul><p class="hint">En listepris fra en producent er hverken en bestemt forhandlers pris eller virksomhedens indkøbspris.</p>`;
}

function variantsBlock(variants: CatalogProductRow[], hrefOf: (id: number) => string, currentId: number): H | '' {
  if (!variants.length) return '';
  return html`<section class="stack-sm"><h2>Varianter</h2><div class="table-wrap"><table class="mini"><thead><tr><th>Variant</th><th>Varenummer</th><th>Enhed</th><th></th></tr></thead><tbody>${variants.map(
    (v) => html`<tr${v.id === currentId ? html` aria-current="true"` : ''}><td>${[v.variant, v.dimensions, v.pack_size].filter(Boolean).join(' · ') || v.name}</td><td class="xs">${codeLine(v) || '–'}</td><td>${v.unit || 'Ukendt'}</td><td><a href="${hrefOf(v.id)}">Vælg denne</a></td></tr>`,
  )}</tbody></table></div></section>`;
}

export function detailPage(d: {
  c: CatalogDetail;
  prices: (CatalogPriceRow & { source_name: string })[];
  variants: CatalogProductRow[];
  own: (ProductRow & { linked: boolean }) | null;
  manager: boolean;
  csrf: string;
  fromNew: boolean;
  flashCode?: string;
}): H {
  const c = d.c;
  const back = d.manager ? '/lager/katalog' : '/job/katalog';
  return html`<div class="stack-lg" style="max-width:960px">
  ${pageHead(html`<a href="${back}">Produktkatalog</a> · <span class="sku">${veyroId(c.id)}</span>`, html`${c.name}${demoTag(c.is_demo, c.source_kind)}`, html`<a class="btn btn-ghost" href="${back}">← Søg</a>`, [c.variant, c.dimensions, c.manufacturer].filter(Boolean).join(' · '))}
  ${flash(d.flashCode)}
  <div class="grid grid-2">
    <section class="card stack"><h2>Produktoplysninger</h2>${productFacts(c)}</section>
    <div class="stack">
      <section class="card stack-sm"><h2>Pris</h2>${pricesBlock(d.prices, d.manager)}</section>
      <section class="card stack-sm"><h2>Virksomhedens lager</h2>
        ${d.own
          ? html`<p style="margin:0"><strong>${qtyUnit(d.own.stock - d.own.reserved, d.own.unit)}</strong> disponibel (${formatQty(d.own.stock)} fysisk, ${formatQty(d.own.reserved)} reserveret)</p>
            <p class="muted small" style="margin:0">Varekartotek: <span class="sku">${d.own.sku}</span>${d.own.linked ? '' : ' · samme EAN eller producentnr. (knyttes ved første valg)'}</p>
            ${d.manager ? html`<a href="/lager/varer/${d.own.id}">Åbn varen i varekartoteket →</a>` : ''}`
          : html`<p style="margin:0" class="muted">Varen findes ikke i virksomhedens varekartotek. Når den vælges, oprettes en reference uden lagerbeholdning.</p>
            ${d.manager
              ? html`<form method="post" action="/lager/katalog/${c.id}/opret" class="stack-sm">${csrfField(d.csrf)}
                  <div class="field"><label for="unit_o">Enhed i varekartoteket</label><input id="unit_o" name="unit" maxlength="20" required value="${c.unit}" placeholder="Fx stk."></div>
                  <button class="btn ${d.fromNew ? 'btn-primary' : 'btn-secondary'}" type="submit">Opret i varekartoteket</button>
                  <p class="hint">Opretter kun varen. Lageret ændres først ved varemodtagelse eller optælling.</p></form>`
              : ''}`}
      </section>
      <p class="hint">Kataloget viser, hvilke produkter der findes. Virksomhedens lager viser, hvad I selv har. En import ændrer aldrig lageret.</p>
    </div>
  </div>
  ${variantsBlock(d.variants, (id) => `/katalog/${id}`, c.id)}
</div>`;
}

// --- Valg af vare til et job ---------------------------------------------------------------------

export function selectPage(d: {
  job: JobHead;
  c: CatalogDetail | null;
  own: (ProductRow & { linked?: boolean }) | null;
  prices: (CatalogPriceRow & { source_name: string })[];
  variants: CatalogProductRow[];
  manager: boolean;
  csrf: string;
  op: string;
  values: { qty: string; unit: string; handling: Handling; note: string; use_price: boolean };
  errs: string[];
}): H {
  const j = d.job;
  const c = d.c;
  const own = d.own;
  const action = c ? `/job/${j.id}/materialer/katalog/${c.id}` : `/job/${j.id}/materialer/vare/${own!.id}`;
  const unitLocked = !!own;
  const price = d.prices[0] ?? null;
  const avail = own ? own.stock - own.reserved : 0;
  return html`<div class="stack-lg">
  ${jobHeader(j, 'materialer', d.manager)}
  ${errors(d.errs)}
  <div><a href="/job/${j.id}/materialer#tilfoj">← Tilbage til søgningen</a></div>
  <div class="grid grid-2">
    <section class="card stack">
      <h2>${c ? c.name : own!.name}${c ? demoTag(c.is_demo, c.source_kind) : ''}</h2>
      ${c
        ? productFacts(c)
        : html`<dl class="kv">${kv('Varenummer', html`<span class="sku">${own!.sku}</span>`)}${kv('Enhed', own!.unit)}${kv('Kategori', own!.category)}${kv('EAN', own!.ean)}${kv('Producentnr.', own!.mpn)}${kv('Mærke', own!.brand)}</dl>`}
      ${c ? html`<div class="stack-sm"><h3>Pris</h3>${pricesBlock(d.prices, d.manager)}</div>` : ''}
    </section>
    <section class="card stack">
      <h2>Tilføj til jobbet</h2>
      <div class="stack-sm">
        <h3>Virksomhedens lager</h3>
        ${own
          ? html`<p style="margin:0"><strong>${qtyUnit(Math.max(0, avail), own.unit)}</strong> disponibel <span class="muted">(${formatQty(own.stock)} fysisk, ${formatQty(own.reserved)} reserveret til job)</span></p>
            <p class="muted xs" style="margin:0">Varekartotek: ${own.sku}${c && own.linked === false ? ' · samme EAN eller producentnr., knyttes til katalogvaren' : ''}</p>`
          : html`<p style="margin:0"><span class="tag tag-out">Ikke på lager</span> Varen findes ikke i varekartoteket. Der oprettes en reference uden lagerbeholdning.</p>`}
      </div>
      <form method="post" action="${action}" class="stack-sm">
        ${csrfField(d.csrf)}${opField(d.op)}
        <div class="fields fields-2">
          <div class="field"><label for="qty_k">Antal</label><input id="qty_k" class="in-num" name="qty" inputmode="decimal" required value="${d.values.qty}" autofocus></div>
          <div class="field"><label for="unit_k">Enhed</label>${unitLocked
            ? html`<input id="unit_k" name="unit" value="${own!.unit}" readonly aria-describedby="unit_hint"><p class="hint" id="unit_hint">Enheden fra varekartoteket.${c && c.unit && c.unit !== own!.unit ? ` Kataloget skriver "${c.unit}".` : ''}</p>`
            : html`<input id="unit_k" name="unit" maxlength="20" required value="${d.values.unit}" placeholder="Fx stk." aria-describedby="unit_hint"><p class="hint" id="unit_hint">${c && c.unit ? `Fra kataloget: ${c.unit}${c.pack_size ? `, pakning ${c.pack_size}` : ''}`.replace(/\.$/, '') + '. Kontrollér enheden.' : 'Kataloget har ingen enhed. Angiv den enhed, I bruger.'}</p>`}</div>
        </div>
        <fieldset class="stack-sm"><legend>Håndtering</legend>
          ${(['reserver', 'brugt', 'forventet'] as Handling[]).map(
            (h) => html`<label class="check"><input type="radio" name="handling" value="${h}"${d.values.handling === h ? html` checked` : ''}${h === 'brugt' && avail <= 0 ? html` disabled` : ''}> ${HANDLING_LABEL[h]}</label>`,
          )}
          ${avail <= 0 ? html`<p class="hint">Der er intet disponibelt på lageret, så hele mængden kommer på jobbets indkøbsliste ved reservation.</p>` : ''}
        </fieldset>
        ${d.manager && c && price
          ? usablePrice(price)
            ? html`<label class="check"><input type="checkbox" name="use_price" value="1"${d.values.use_price ? html` checked` : ''}> Brug katalogets pris som manuel pris på linjen (${priceLine({ ...price, source: price.source_name })})</label>`
            : html`<p class="hint">Katalogets pris har ${price.currency ? 'ukendt momsgrundlag' : 'ukendt valuta'} og bruges ikke som pris på jobbet.</p>`
          : ''}
        ${d.manager && c && !price ? html`<p class="hint">Prisen mangler. Efter tilføjelsen kan du slå prisen op hos byggemarkedet ("Slå priser op") eller indtaste den manuelt på linjen.</p>` : ''}
        <div class="field"><label for="note_k">Bemærkning (valgfri)</label><input id="note_k" name="note" maxlength="200" value="${d.values.note}"></div>
        <div class="row"><button class="btn btn-primary" type="submit">Tilføj til jobbet</button><a class="btn btn-ghost" href="/job/${j.id}/materialer#tilfoj">Annullér</a></div>
      </form>
    </section>
  </div>
  ${c ? variantsBlock(d.variants, (id) => `/job/${j.id}/materialer/katalog/${id}`, c.id) : ''}
</div>`;
}

/** Søgning og manuel oprettelse på jobbets materialeside. */
export function addMaterialSection(d: { jobId: number; panel: SearchPanel; manager: boolean; csrf: string; manualOpen: boolean }): H {
  return html`<section class="card stack" id="tilfoj">
    <h2>Tilføj materiale</h2>
    ${searchPanel(d.panel)}
    <details${d.manualOpen ? html` open` : ''}><summary>Findes varen ikke? Opret den manuelt</summary>
      <form method="post" action="/job/${d.jobId}/materialer/ny" class="stack-sm" style="margin-top:12px">
        ${csrfField(d.csrf)}<input type="hidden" name="kind" value="fri">
        <div class="field"><label for="name_f">Vare uden varenummer (købes til jobbet)</label><input id="name_f" name="name" maxlength="200" required placeholder="Fx Terrassebræt 28x120 mm trykimprægneret"></div>
        <div class="fields fields-2"><div class="field"><label for="qty_f">Forventet mængde</label><input id="qty_f" class="in-num" name="qty" inputmode="decimal" required></div><div class="field"><label for="unit_f">Enhed</label><input id="unit_f" name="unit" maxlength="20" value="stk."></div></div>
        ${d.manager ? html`<div class="field"><label for="url_f">Link til varen hos byggemarkedet (valgfrit)</label><input id="url_f" name="url" type="url" maxlength="500" placeholder="https://"></div><div class="field"><label for="ean_f">EAN (valgfrit)</label><input id="ean_f" name="ean" inputmode="numeric" maxlength="14"></div>` : ''}
        <button class="btn btn-secondary" type="submit">Tilføj vare</button>
      </form>
    </details>
  </section>
  <script src="/static/katalog.js" defer></script>`;
}

// --- Lagerportalen: katalog, kilder og import ------------------------------------------------------

export function catalogAdminPage(d: {
  panel: SearchPanel;
  sources: (CatalogSourceRow & { products: number; review: number })[];
  imports: (CatalogImportRow & { source_name: string })[];
  demo: boolean;
  loadTest: { n: number } | null;
  csrf: string;
  flashCode?: string;
  message?: string;
}): H {
  const review = d.sources.reduce((a, s) => a + s.review, 0);
  return html`<div class="stack-lg">
  ${pageHead('Lagerportal', 'Produktkatalog', html`${review ? html`<a class="btn btn-secondary" href="/lager/katalog/gennemgang">Til gennemgang (${review})</a>` : ''}<a class="btn btn-primary" href="/lager/katalog/import">Importér produktfil</a>`, 'Produkter fra producenter og forhandlere, som alle kan søge i, når de tilføjer materialer. Kataloget er ikke lageret: det viser, hvad der findes, ikke hvad I har.')}
  ${flash(d.flashCode)}${d.message ? alert('ok', d.message) : ''}
  ${searchPanel(d.panel)}
  <section class="stack">
    <h2>Datakilder</h2>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Kilde</th><th>Type</th><th class="num">Varer</th><th class="num">Til gennemgang</th><th>Seneste import</th></tr></thead>
      <tbody>${d.sources.length
        ? d.sources.map(
            (s) => html`<tr><td class="cell-main"><strong>${s.name}</strong>${demoTag(0, s.kind)}${s.note ? html`<small>${s.note}</small>` : ''}</td><td data-label="Type">${SOURCE_KIND_LABEL[s.kind]}</td>
              <td class="num" data-label="Varer">${s.products.toLocaleString('da-DK')}</td><td class="num" data-label="Til gennemgang">${s.review || '–'}</td>
              <td data-label="Seneste import">${s.last_import_at ? html`<a href="/lager/katalog/import/${s.last_import_id}">${formatDateTime(s.last_import_at)}</a>` : html`<span class="muted">Ingen fil importeret endnu</span>`}</td></tr>`,
          )
        : html`<tr><td colspan="5" class="empty">Ingen datakilder endnu. Importér en produktfil for at komme i gang.</td></tr>`}</tbody>
    </table></div></div>
  </section>
  ${d.imports.length
    ? html`<section class="stack"><h2>Seneste importer</h2><div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Fil</th><th>Status</th><th class="num">Nye</th><th class="num">Opdateret</th><th class="num">Uændret</th><th class="num">Fejl</th><th class="num">Mangler i filen</th></tr></thead>
      <tbody>${d.imports.map(
        (i) => html`<tr class="row-link" data-href="/lager/katalog/import/${i.id}"><td class="cell-main"><a class="title" href="/lager/katalog/import/${i.id}">${i.filename || 'Fil'}</a><small>${i.source_name} · ${formatDateTime(i.created_at)}</small></td>
          <td data-label="Status">${importTag(i.status)}</td><td class="num" data-label="Nye">${i.rows_new}</td><td class="num" data-label="Opdateret">${i.rows_updated}</td><td class="num" data-label="Uændret">${i.rows_same}</td><td class="num" data-label="Fejl">${i.rows_error}</td><td class="num" data-label="Mangler i filen">${i.rows_missing}</td></tr>`,
      )}</tbody></table></div></div></section>`
    : ''}
  ${d.demo
    ? html`<section class="card stack"><h2>Demo</h2>
      <p class="small" style="margin:0">Demofilerne indeholder fiktive varer fra de opdigtede producenter Nordlys Demo og Demo VVS. Varenumre begynder med DEMO-, og EAN-numrene har præfiks 20 (internt brug), så de ikke er rigtige varer. Ingen KEMPER-data er brugt.</p>
      <div class="row" style="flex-wrap:wrap"><a class="btn btn-secondary btn-small" href="/lager/katalog/demofil/demokatalog-v1.xlsx">Demofil v1 (Excel)</a><a class="btn btn-secondary btn-small" href="/lager/katalog/demofil/demokatalog-v1.csv">Demofil v1 (CSV)</a><a class="btn btn-secondary btn-small" href="/lager/katalog/demofil/demokatalog-v2.xlsx">Demofil v2 med ændringer (Excel)</a></div>
      <p class="small" style="margin:0">Belastningstest: ${d.loadTest ? html`<strong>${d.loadTest.n.toLocaleString('da-DK')}</strong> syntetiske testvarer er indlæst (kilde "DEMO-belastningstest", varenumre DEMO-LT-…).` : 'ikke indlæst.'}</p>
      <div class="row">${d.loadTest
        ? html`<form method="post" action="/lager/katalog/demo/belastning/fjern">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Fjern testvarerne</button></form>`
        : html`<form method="post" action="/lager/katalog/demo/belastning">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Indlæs 10.000 syntetiske testvarer</button></form>`}</div>
    </section>`
    : ''}
  <script src="/static/katalog.js" defer></script>
</div>`;
}

export function importTag(status: CatalogImportRow['status']): H {
  return status === 'godkendt'
    ? html`<span class="tag tag-ok">Godkendt</span>`
    : status === 'klar'
      ? html`<span class="tag tag-ready">Venter på godkendelse</span>`
      : status === 'annulleret'
        ? html`<span class="tag tag-off">Annulleret</span>`
        : html`<span class="tag tag-low">Ikke færdig</span>`;
}

export function importPage(d: { sources: CatalogSourceRow[]; csrf: string; selected: number | null; demo: boolean }): H {
  const fields = CATALOG_FIELDS.map(([k, l]) => ({ key: k, label: l }));
  const sources = d.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, manufacturer: s.manufacturer, mapping: s.mapping }));
  return html`<div class="stack-lg" style="max-width:1100px">
  ${pageHead(html`<a href="/lager/katalog">Produktkatalog</a>`, 'Importér produktfil', html`<a class="btn btn-ghost" href="/lager/katalog">← Katalog</a>`, 'CSV- eller Excel-fil (.xlsx). Filen læses i browseren; intet ændres i kataloget, før du har set forhåndsvisningen og godkendt importen.')}
  <noscript>${alert('warn', 'Importen kræver JavaScript i browseren.')}</noscript>
  <form id="katalog-import" class="stack-lg" data-csrf="${d.csrf}" data-fields="${JSON.stringify(fields)}" data-sources="${JSON.stringify(sources)}">
    <section class="card stack">
      <h2>1. Datakilde</h2>
      <div class="fields fields-2">
        <div class="field"><label for="imp_source">Kilde</label><select id="imp_source" name="source_id">
          ${d.sources.map((s) => html`<option value="${s.id}"${s.id === d.selected ? html` selected` : ''}>${s.name} (${SOURCE_KIND_LABEL[s.kind]})</option>`)}
          <option value="ny"${d.selected === null && !d.sources.length ? html` selected` : ''}>Ny datakilde …</option></select></div>
      </div>
      <div class="fields fields-3" data-new-source hidden>
        <div class="field"><label for="imp_name">Navn på ny kilde</label><input id="imp_name" name="new_name" maxlength="80" placeholder="Fx KEMPER produktdata"></div>
        <div class="field"><label for="imp_kind">Type</label><select id="imp_kind" name="new_kind"><option value="producent">Producent</option><option value="forhandler">Forhandler</option>${d.demo ? html`<option value="demo">Demodata</option>` : ''}</select></div>
        <div class="field"><label for="imp_maker">Producent (hvis filen ikke har kolonnen)</label><input id="imp_maker" name="new_manufacturer" maxlength="100"></div>
      </div>
    </section>
    <section class="card stack">
      <h2>2. Fil</h2>
      <div class="field"><label for="imp_file">CSV- eller Excel-fil</label><input id="imp_file" type="file" accept=".csv,.txt,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></div>
      <div class="fields fields-2" data-after-file hidden>
        <div class="field" data-sheet-field hidden><label for="imp_sheet">Faneblad</label><select id="imp_sheet"></select></div>
        <div class="field"><label for="imp_header">Overskrifter i række</label><input id="imp_header" class="in-num" type="number" min="1" max="999" value="1"></div>
      </div>
      <p class="hint" data-file-info></p>
    </section>
    <section class="card stack" data-after-file hidden>
      <h2>3. Kolonner</h2>
      <p class="hint">Kobl filens kolonner til Veyros felter. Opsætningen gemmes til næste import fra samme kilde. Felter uden kolonne står som ukendte; en manglende pris bliver aldrig til 0 kr.</p>
      <div class="table-wrap"><table class="mini"><thead><tr><th>Felt i Veyro</th><th>Kolonne i filen</th><th>Eksempel</th></tr></thead><tbody data-mapping></tbody></table></div>
      <div class="fields fields-3">
        <div class="field"><label for="imp_currency">Valuta (hvis filen ikke har kolonnen)</label><select id="imp_currency"><option value="DKK">DKK</option><option value="EUR">EUR</option><option value="">Ukendt</option></select></div>
        <div class="field"><label for="imp_vat">Priserne er</label><select id="imp_vat"><option value="ekskl">ekskl. moms</option><option value="inkl">inkl. moms</option><option value="ukendt">Ukendt</option></select></div>
        <div class="field"><label for="imp_ptype">Pristype</label><select id="imp_ptype">${(Object.keys(PRICE_TYPE_LABEL) as (keyof typeof PRICE_TYPE_LABEL)[]).map((k) => html`<option value="${k}">${PRICE_TYPE_LABEL[k]}</option>`)}</select></div>
      </div>
      <p class="hint">Pristypen står ved hver pris. En producents listepris vises aldrig som en forhandlers pris eller som jeres indkøbspris.</p>
    </section>
    <section class="card stack" data-after-file hidden>
      <h2>4. Forhåndsvisning af de første rækker</h2>
      <div class="table-wrap" data-sample></div>
      <div class="row"><button class="btn btn-primary" type="submit" data-start>Indlæs og vis forhåndsvisning</button><span class="muted small" data-progress aria-live="polite"></span></div>
      <p class="err" data-error hidden role="alert"></p>
    </section>
  </form>
  <script src="/static/katalog.js" defer></script>
</div>`;
}

const ACTION_LABEL: Record<string, string> = { ny: 'Ny', opdater: 'Opdateres', uaendret: 'Uændret', fejl: 'Fejl' };

export function previewPage(d: {
  imp: CatalogImportRow;
  source: CatalogSourceRow;
  tab: string;
  rows: PreviewRow[];
  missing: CatalogProductRow[];
  warnings: number;
  csrf: string;
  page: number;
  perPage: number;
  flashCode?: string;
  error?: string;
}): H {
  const i = d.imp;
  const tabs: [string, string, number][] = [
    ['', 'Alle', i.rows_total],
    ['ny', 'Nye', i.rows_new],
    ['opdater', 'Opdateres', i.rows_updated],
    ['uaendret', 'Uændrede', i.rows_same],
    ['fejl', 'Fejl', i.rows_error],
    ['advarsel', 'Advarsler', d.warnings],
    ['mangler', 'Mangler i filen', i.rows_missing],
  ];
  const ready = i.status === 'klar';
  return html`<div class="stack-lg">
  ${pageHead(html`<a href="/lager/katalog">Produktkatalog</a> · ${d.source.name}`, html`${i.filename || 'Import'} ${importTag(i.status)}`, html`<a class="btn btn-ghost" href="/lager/katalog">← Katalog</a>`, `Indlæst ${formatDateTime(i.created_at)}${i.sheet ? ` · faneblad ${i.sheet}` : ''}${i.approved_at ? ` · godkendt ${formatDateTime(i.approved_at)} af ${i.approved_by}` : ''}`)}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}
  <div class="stats">
    <div class="stat"><span class="l">Rækker i filen</span><span class="n">${i.rows_total.toLocaleString('da-DK')}</span></div>
    <div class="stat"><span class="l">Nye varer</span><span class="n">${i.rows_new.toLocaleString('da-DK')}</span></div>
    <div class="stat"><span class="l">Opdateringer</span><span class="n">${i.rows_updated.toLocaleString('da-DK')}</span><span class="l">${i.rows_same.toLocaleString('da-DK')} uændrede</span></div>
    <div class="stat"><span class="l">Fejl</span><span class="n">${i.rows_error.toLocaleString('da-DK')}</span><span class="l">Rækker med fejl springes over</span></div>
    <div class="stat"><span class="l">Mangler i filen</span><span class="n">${i.rows_missing.toLocaleString('da-DK')}</span><span class="l">Markeres til gennemgang, slettes ikke</span></div>
  </div>
  ${ready
    ? html`<div class="card stack-sm">
      <p style="margin:0">Godkendelsen opretter ${i.rows_new} nye varer og opdaterer ${i.rows_updated}. ${i.rows_missing ? `${i.rows_missing} varer, der ikke er i filen, markeres til gennemgang. ` : ''}Lagerbeholdninger, indkøb, job, prisoverslag og fakturaer ændres ikke.</p>
      <div class="row"><form method="post" action="/lager/katalog/import/${i.id}/godkend">${csrfField(d.csrf)}<button class="btn btn-primary" type="submit">Godkend importen</button></form>
      <form method="post" action="/lager/katalog/import/${i.id}/annuller" data-confirm="Annullér importen? Intet er ændret i kataloget.">${csrfField(d.csrf)}<button class="btn btn-secondary" type="submit">Annullér</button></form></div>
    </div>`
    : ''}
  <nav class="tabs" aria-label="Rækker">${tabs.map(([k, l, n]) => html`<a href="/lager/katalog/import/${i.id}${k ? `?vis=${k}` : ''}"${d.tab === k ? html` aria-current="page"` : ''}>${l} (${n.toLocaleString('da-DK')})</a>`)}</nav>
  ${d.tab === 'mangler'
    ? html`<div class="card card-flush"><div class="table-wrap"><table class="list stackable dense"><thead><tr><th>Vare</th><th>Varenummer</th><th>Status</th></tr></thead><tbody>${d.missing.length
        ? d.missing.map((c) => html`<tr><td class="cell-main"><a href="/katalog/${c.id}">${c.name}</a><small>${[c.variant, c.dimensions].filter(Boolean).join(' · ')}</small></td><td class="xs" data-label="Varenummer">${codeLine(c)}</td><td data-label="Status">${ready ? 'Markeres til gennemgang' : html`<span class="tag tag-low">Til gennemgang</span>`}</td></tr>`)
        : html`<tr><td colspan="3" class="empty">${ready ? 'Alle varer fra kilden er med i filen.' : 'Ingen varer manglede i filen.'}</td></tr>`}</tbody></table></div></div>`
    : html`<div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th class="num">Række</th><th>Vare</th><th>Varenummer</th><th>Enhed</th><th>Pris</th><th>Resultat</th></tr></thead>
      <tbody>${d.rows.length
        ? d.rows.map(
            (r) => html`<tr${r.action === 'fejl' ? html` class="is-low"` : ''}><td class="num" data-label="Række">${r.row_no}</td>
              <td class="cell-main">${r.name || html`<span class="miss">Navn mangler</span>`}${r.variant ? html`<small>${r.variant}</small>` : ''}<small>${r.manufacturer || 'Producent ukendt'}</small></td>
              <td class="xs" data-label="Varenummer">${[r.mpn && `Varenr. ${r.mpn}`, r.ean && `EAN ${r.ean}`].filter(Boolean).join(' · ') || '–'}</td>
              <td data-label="Enhed">${r.unit || html`<span class="muted">Ukendt</span>`}${r.pack_size ? html`<small>${r.pack_size}</small>` : ''}</td>
              <td data-label="Pris">${r.price !== null ? html`${amountText(r.price, r.currency)}<small>${CATALOG_VAT_LABEL[r.vat as keyof typeof CATALOG_VAT_LABEL] ?? r.vat}</small>` : html`<span class="tag tag-low">Pris mangler</span>`}</td>
              <td data-label="Resultat"><span class="tag ${r.action === 'fejl' ? 'tag-out' : r.action === 'ny' ? 'tag-ny' : r.action === 'opdater' ? 'tag-ready' : 'tag-off'}">${ACTION_LABEL[r.action] ?? r.action}</span>${r.match_id ? html`<small><a href="/katalog/${r.match_id}">${veyroId(r.match_id)}</a></small>` : ''}${r.changes ? html`<small>Ændret: ${r.changes}</small>` : ''}${r.errors ? html`<small class="miss">${r.errors}</small>` : ''}${r.warnings ? html`<small>${r.warnings}</small>` : ''}</td></tr>`,
          )
        : html`<tr><td colspan="6" class="empty">Ingen rækker.</td></tr>`}</tbody>
    </table></div></div>
    <div class="pager">${d.page > 1 ? html`<a class="btn btn-secondary btn-small" href="?${d.tab ? `vis=${d.tab}&` : ''}side=${d.page - 1}">Forrige</a>` : ''}${d.rows.length === d.perPage ? html`<a class="btn btn-secondary btn-small" href="?${d.tab ? `vis=${d.tab}&` : ''}side=${d.page + 1}">Næste</a>` : ''}</div>`}
</div>`;
}

export function reviewPage(d: { rows: (CatalogProductRow & { source_name: string; own_id: number | null })[]; csrf: string; flashCode?: string }): H {
  return html`<div class="stack-lg">
  ${pageHead(html`<a href="/lager/katalog">Produktkatalog</a>`, 'Til gennemgang', html`<a class="btn btn-ghost" href="/lager/katalog">← Katalog</a>`, 'Varer, der manglede i den seneste fil fra deres kilde. De er ikke slettet, og job, historik og varekartotek er uændrede. Behold varen, eller skjul den fra søgningen.')}
  ${flash(d.flashCode)}
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
    <thead><tr><th>Vare</th><th>Varenummer</th><th>Kilde</th><th></th></tr></thead>
    <tbody>${d.rows.length
      ? d.rows.map(
          (c) => html`<tr><td class="cell-main"><a class="title" href="/katalog/${c.id}">${c.name}</a><small>${[c.variant, c.dimensions].filter(Boolean).join(' · ')}</small><small>${c.review_note}</small>${c.own_id ? html`<small>I varekartoteket – bevares</small>` : ''}</td>
          <td class="xs" data-label="Varenummer">${codeLine(c)}</td><td data-label="Kilde">${c.source_name}</td>
          <td><div class="row"><form method="post" action="/lager/katalog/${c.id}/status">${csrfField(d.csrf)}<input type="hidden" name="status" value="aktiv"><button class="btn btn-secondary btn-small" type="submit">Behold</button></form>
          <form method="post" action="/lager/katalog/${c.id}/status">${csrfField(d.csrf)}<input type="hidden" name="status" value="skjult"><button class="btn btn-secondary btn-small" type="submit">Skjul fra søgning</button></form></div></td></tr>`,
        )
      : html`<tr><td colspan="4" class="empty">Ingen varer til gennemgang.</td></tr>`}</tbody>
  </table></div></div>
</div>`;
}

export function portalSearchPage(d: { panel: SearchPanel }): H {
  return html`<div class="stack-lg">
  ${pageHead('Job- og forbrugsportal', 'Produktkatalog', '', 'Søg i hele produktkataloget. For at bruge en vare på et job: åbn jobbet og vælg Materialer → Tilføj materiale.')}
  ${searchPanel(d.panel)}
  <script src="/static/katalog.js" defer></script>
</div>`;
}

export { FIELD_LABEL };
