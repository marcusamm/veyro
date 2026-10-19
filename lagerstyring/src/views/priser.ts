import { html } from 'hono/html';
import type { RetailerView } from '../lib/estimates';
import { formatDateTime, formatKr, formatQty, qtyUnit } from '../lib/format';
import type { LineView } from '../lib/purchasing';
import {
  ACCESS_LABEL,
  BASIS_LABEL,
  DISCLAIMER,
  FEED_COLUMNS,
  FREIGHT_NOTE,
  SOURCE_LABEL,
  STALE_LABEL,
  VAT_LABEL,
  type EstimateOpts,
  type EstimateView,
  type LineEstimate,
  type ListEstimate,
  type OfferLine,
} from '../lib/prices';
import type { Settings } from '../lib/settings';
import { flash, pageHead } from './common';
import { alert, csrfField, type H } from './layout';

export function sourceTag(source: EstimateView['source']): H {
  return html`<span class="tag ${source === 'demodata' ? 'tag-demo' : source === 'manuel' ? 'tag-klar' : 'tag-src'}">${SOURCE_LABEL[source]}</span>`;
}

function matchTag(e: EstimateView): H {
  if (e.match === 'praecis') return html`<span class="tag tag-ok">Præcist match</span><small>${BASIS_LABEL[e.basis]}</small>`;
  return e.approved_at
    ? html`<span class="tag tag-ready">Alternativ – godkendt</span><small>${e.approved_by ?? ''}</small>`
    : html`<span class="tag tag-low">Alternativ – kræver godkendelse</span><small>${BASIS_LABEL[e.basis]}</small>`;
}

function packText(e: EstimateView): string {
  const pack = e.pack_qty === 1000 && e.sales_unit === e.content_unit ? `Sælges pr. ${e.sales_unit}` : `${e.sales_unit} á ${formatQty(e.pack_qty)} ${e.content_unit}`;
  return e.min_qty > 1000 ? `${pack}, mindst ${formatQty(e.min_qty)} ${e.sales_unit}` : pack;
}

function priceCell(x: OfferLine): H {
  const e = x.est;
  const p = x.plan;
  const offer = !p.ok
    ? ''
    : p.offer === 'gaelder'
      ? html`<small class="ok-text">Tilbud${e.offer_text ? `: ${e.offer_text}` : ''}${e.offer_until ? ` (til ${e.offer_until})` : ''} · normalpris ${formatKr(e.price)}</small>`
      : p.offer === 'opfyldes_ikke'
        ? html`<small>Tilbud ${formatKr(e.offer_price)} kræver mindst ${formatQty(e.offer_min_qty)} ${e.sales_unit} (ikke opfyldt)</small>`
        : p.offer === 'udloebet'
          ? html`<small>Tilbuddet er udløbet</small>`
          : '';
  return html`<strong>${formatKr(p.ok ? p.unitPrice : e.price)}</strong> / ${e.sales_unit}<small>${VAT_LABEL[e.vat]}</small>${offer}`;
}

export function estimateSection(d: {
  listId: number;
  items: { line: LineView; est: LineEstimate }[];
  summary: ListEstimate;
  opts: EstimateOpts;
  retailers: RetailerView[];
  csrf: string;
  archived: boolean;
  refreshed?: { checked: number; failed: number; feeds: { name: string; ok: boolean; message: string }[] };
}): H {
  const s = d.summary;
  const basis = VAT_LABEL[s.basis];
  const active = d.retailers.filter((r) => r.active);
  const withData = active.filter((r) => r.catalog_count > 0);
  const lines = d.items.filter((x) => x.est.need > 0);
  const canEdit = !d.archived;
  return html`<section class="card card-flush est" id="prisestimat">
  <div class="row-between" style="padding:16px 16px 4px">
    <div class="stack-sm"><h2>Prisestimat</h2><p class="muted small" style="margin:0">Offentlige priser fra ${withData.length} af ${active.length} forhandlere (prisfil eller demodata); hos resten indtastes prisen manuelt med link. Den billigste sammenlignelige pris bruges altid. Alle beløb er ${basis}. Estimatet er adskilt fra forventet og faktisk indkøbspris og bestiller ikke noget.</p></div>
    <div class="row">
      ${canEdit ? html`<form method="post" action="/lager/indkob/${d.listId}/priser">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Opdatér priser</button></form>` : ''}
      <a class="btn btn-ghost btn-small" href="/lager/priser">Forhandlere og prisfiler</a>
    </div>
  </div>
  ${d.refreshed
    ? html`<div style="padding:8px 16px 0">${alert(
        d.refreshed.failed ? 'warn' : 'ok',
        html`Priserne er opdateret for ${d.refreshed.checked} ${d.refreshed.checked === 1 ? 'linje' : 'linjer'}.${d.refreshed.failed ? ` ${d.refreshed.failed} kunne ikke opdateres; listen og lageret er ikke påvirket.` : ''}${d.refreshed.feeds.map(
          (f) => html`<br>${f.name}: ${f.ok ? f.message : html`<strong>fejlede</strong> (${f.message})`}`,
        )}`,
      )}</div>`
    : ''}
  ${!lines.length
    ? html`<p class="muted" style="padding:8px 16px 16px">Der er ingen varer, der mangler at blive købt på listen.</p>`
    : html`${lines.map((x) => estimateLine(x, d, canEdit))}`}
  <div class="est-total stack-sm">
    <div class="row-between"><span>Estimat i alt (${basis}), ${s.priced} af ${s.lines} ${s.lines === 1 ? 'vare' : 'varer'} med pris</span><strong class="big">${formatKr(s.total)}</strong></div>
    ${s.missing.length
      ? html`<p class="small" style="margin:0"><span class="tag tag-out">Pris mangler</span> ${s.missing.length} ${s.missing.length === 1 ? 'vare' : 'varer'} uden pris: ${s.missing.map((m) => m.name).join(', ')}. Beløbet ovenfor er kun summen af de kendte priser.</p>`
      : ''}
    ${s.stale ? html`<p class="small" style="margin:0"><span class="tag tag-low">${STALE_LABEL}</span> ${s.stale} ${s.stale === 1 ? 'pris er' : 'priser er'} ældre end ${d.opts.maxAgeDays} dage.</p>` : ''}
    ${s.oldest ? html`<p class="small muted" style="margin:0">Prisdata fra ${formatDateTime(s.oldest)}${s.newest && s.newest !== s.oldest ? ` til ${formatDateTime(s.newest)}` : ''}.</p>` : ''}
    <p class="small" style="margin:0"><strong>${FREIGHT_NOTE}.</strong></p>
    <p class="small muted" style="margin:0">${DISCLAIMER}</p>
  </div>
</section>`;
}

function estimateLine(x: { line: LineView; est: LineEstimate }, d: { csrf: string; retailers: RetailerView[]; opts: EstimateOpts }, canEdit: boolean): H {
  const l = x.line;
  const e = x.est;
  const c = e.chosen;
  const basis = VAT_LABEL[d.opts.basis];
  return html`<div class="est-line" id="pris-${l.id}">
  <div class="row-between">
    <div class="stack-sm"><div><strong>${l.name}</strong></div><div class="small muted">${l.sku ? html`${l.sku} · ` : ''}Mangler at blive købt: ${qtyUnit(e.need, l.unit)}</div></div>
    <div class="est-pick">${c
      ? html`<strong>${formatKr(c.amount)}</strong> <span class="small muted">${basis} hos ${c.est.retailer_name}</span>`
      : html`<span class="tag tag-out">Pris mangler</span> <span class="small muted">${e.missingReason}</span>`}</div>
  </div>
  ${e.offers.length
    ? html`<div class="table-wrap"><table class="list stackable dense">
    <thead><tr><th>Forhandler</th><th>Fundet vare</th><th>Match</th><th>Pakning og køb</th><th class="num">Offentlig pris</th><th class="num">Linjeestimat (${basis})</th><th>Pristjek</th><th></th></tr></thead>
    <tbody>${e.offers.map((o) => offerRow(o, l, d.csrf, canEdit))}</tbody></table></div>`
    : ''}
  ${e.proposals.map(
    (p) => html`<div class="alert alert-info small">Ny pris fundet hos ${p.retailer_name}: <strong>${formatKr(p.price)}</strong> / ${p.sales_unit} ${VAT_LABEL[p.vat]} (${SOURCE_LABEL[p.source]}, ${formatDateTime(p.checked_at)}). Den manuelt indtastede pris ændres ikke uden din accept.
      ${canEdit ? html`<form method="post" action="/lager/indkob/estimat/${p.id}/accepter" class="inline">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Acceptér ny pris</button></form>
      <form method="post" action="/lager/indkob/estimat/${p.id}/fjern" class="inline">${csrfField(d.csrf)}<button class="btn btn-ghost btn-small" type="submit">Behold min pris</button></form>` : ''}</div>`,
  )}
  ${canEdit ? html`<div class="row">${manualForm(l, d)}</div>` : ''}
</div>`;
}

function offerRow(o: OfferLine, l: LineView, csrf: string, canEdit: boolean): H {
  const e = o.est;
  const p = o.plan;
  return html`<tr class="${o.chosen ? 'est-chosen' : ''}">
  <td class="cell-main"><strong>${e.retailer_name}</strong>${sourceTag(e.source)}${o.chosen ? html` <span class="tag tag-ordered">Billigst – bruges i estimatet</span>` : ''}</td>
  <td data-label="Fundet vare">${e.url ? html`<a href="${e.url}" target="_blank" rel="noopener noreferrer nofollow">${e.name}</a>` : e.name}${e.stock_text ? html`<small>Lagerstatus ifølge kilden: ${e.stock_text}</small>` : ''}${e.note ? html`<small>${e.note}</small>` : ''}</td>
  <td data-label="Match">${matchTag(e)}</td>
  <td data-label="Pakning og køb">${packText(e)}${p.ok
    ? html`<small>Foreslået køb: <strong>${formatQty(p.buy)} ${e.sales_unit}</strong>${e.sales_unit !== e.content_unit || e.pack_qty !== 1000 ? ` = ${formatQty(p.covered)} ${e.content_unit}` : ''}</small>`
    : html`<small class="err-text">${p.reason}</small>`}</td>
  <td class="num" data-label="Offentlig pris">${priceCell(o)}</td>
  <td class="num" data-label="Linjeestimat">${o.amount === null ? '–' : html`<strong>${formatKr(o.amount)}</strong>`}${o.lowest ? html`<small><span class="tag tag-ok">Laveste fundne materialepris</span></small>` : ''}</td>
  <td data-label="Pristjek">${formatDateTime(e.checked_at)}${o.stale ? html`<small><span class="tag tag-low">${STALE_LABEL}</span></small>` : ''}</td>
  <td>${canEdit
    ? html`<div class="stack-sm">${e.match === 'alternativ' && !e.approved_at
        ? html`<form method="post" action="/lager/indkob/estimat/${e.id}/godkend" data-confirm="Godkend alternativet som erstatning i estimatet? Varen på listen ændres ikke.">${csrfField(csrf)}<button class="btn btn-secondary btn-small" type="submit">Godkend alternativ</button></form>`
        : ''}${e.source === 'manuel'
        ? html`<form method="post" action="/lager/indkob/estimat/${e.id}/fjern">${csrfField(csrf)}<button class="btn btn-ghost btn-small" type="submit">Fjern</button></form>`
        : ''}</div>`
    : ''}</td>
</tr>`;
}

function manualForm(l: LineView, d: { csrf: string; retailers: RetailerView[] }): H {
  const rs = d.retailers.filter((r) => r.active && r.access !== 'demo');
  if (!rs.length) return html``;
  return html`<details class="act"><summary>Indtast pris manuelt</summary><div class="act-body">
  <form method="post" action="/lager/indkob/linje/${l.id}/pris" class="stack" style="display:grid">
    ${csrfField(d.csrf)}
    <p class="hint" style="margin:0">Brug kun en offentlig pris, som alle kan se uden login, medlemskab eller kundeaftale. Prisen markeres "Manuelt indtastet" og overskrives ikke automatisk.</p>
    <div class="fields fields-2">
      <div class="field"><label>Forhandler</label><select name="retailer_id">${rs.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></div>
      <div class="field"><label>Er det samme vare?</label><select name="match"><option value="praecis">Ja, samme vare (præcist match)</option><option value="alternativ">Nej, et alternativ (kræver godkendelse)</option></select></div>
    </div>
    <div class="field"><label>Produktnavn hos forhandleren</label><input name="name" maxlength="200" required value="${l.name}"></div>
    <div class="field"><label>Link til produktsiden</label><input name="url" type="url" maxlength="500" required placeholder="https://"></div>
    <div class="fields fields-3">
      <div class="field"><label>Sælges pr.</label><input name="sales_unit" maxlength="20" required value="${l.unit}"><p class="hint">Fx pk., stk., m</p></div>
      <div class="field"><label>Indhold pr. salgsenhed</label><input class="in-num" name="pack_qty" inputmode="decimal" value="1" required></div>
      <div class="field"><label>Indholdets enhed</label><input name="content_unit" maxlength="20" required value="${l.unit}"></div>
    </div>
    <div class="fields fields-3">
      <div class="field"><label>Pris pr. salgsenhed (kr.)</label><input class="in-num" name="price" inputmode="decimal" required></div>
      <div class="field"><label>Moms</label><select name="vat"><option value="inkl">Inkl. moms</option><option value="ekskl">Ekskl. moms</option></select></div>
      <div class="field"><label>Mindste køb</label><input class="in-num" name="min_qty" inputmode="decimal" value="1"></div>
    </div>
    <label class="check"><input type="checkbox" name="divisible" value="1"> Kan købes i brøkdele (fx metervare)</label>
    <div class="fields fields-2">
      <div class="field"><label>Tilbudspris (kr., valgfri)</label><input class="in-num" name="offer_price" inputmode="decimal"></div>
      <div class="field"><label>Tilbuddets betingelser</label><input name="offer_text" maxlength="200" placeholder="Fx gælder til 31.10, ingen medlemskab"></div>
    </div>
    <div class="field"><label>Bemærkning</label><input name="note" maxlength="200"></div>
    <button class="btn btn-dark btn-small" type="submit">Gem pris</button>
  </form></div></details>`;
}

export function pricingPage(d: { retailers: RetailerView[]; settings: Settings; csrf: string; flashCode?: string; result?: { kind: 'ok' | 'warn' | 'err'; text: string; errors: string[] } }): H {
  return html`<div class="stack-lg">
  ${pageHead(
    html`Lagerportal · <a href="/lager/indstillinger">Indstillinger</a>`,
    'Forhandlere og prisfiler',
    '',
    'Prisestimater på indkøbslister bygger kun på offentlige priser uden login, medlemskab eller kundeaftale. Priserne kommer fra en officiel prisfil eller et feed, fra butikkens offentlige produktsider (kun hvor vilkårene er tjekket og robots.txt tillader det) eller indtastes manuelt med et link.',
  )}
  ${flash(d.flashCode)}
  ${d.result ? alert(d.result.kind, html`${d.result.text}${d.result.errors.length ? html`<ul>${d.result.errors.slice(0, 15).map((e) => html`<li>${e}</li>`)}${d.result.errors.length > 15 ? html`<li>… og ${d.result.errors.length - 15} mere</li>` : ''}</ul>` : ''}`) : ''}
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Forhandler</th><th>Prisadgang</th><th>Vilkår og adgang</th><th class="num">Priser i cache</th><th>Senest hentet</th><th></th></tr></thead>
    <tbody>${d.retailers.map(
      (r) => html`<tr${r.active ? '' : html` style="opacity:.6"`}>
      <td class="cell-main"><strong>${r.name}</strong>${r.website ? html`<small><a href="${r.website}" target="_blank" rel="noopener noreferrer">${r.website.replace(/^https:\/\//, '')}</a></small>` : ''}${r.active ? '' : html`<small>Slået fra</small>`}</td>
      <td data-label="Prisadgang"><span class="tag ${r.access === 'demo' ? 'tag-demo' : r.access === 'prisfil' ? 'tag-ok' : 'tag-off'}">${ACCESS_LABEL[r.access]}</span>${r.feed_url ? html`<small>Feed: ${r.feed_url}</small>` : ''}</td>
      <td data-label="Vilkår" class="small">${r.terms_note}${r.access === 'side' && r.terms_confirmed_at
        ? html`<small class="ok-text">Vilkår bekræftet af ${r.terms_confirmed_by} ${formatDateTime(r.terms_confirmed_at)}</small>${r.robots_fetched_at ? html`<small>robots.txt hentet ${formatDateTime(r.robots_fetched_at)}</small>` : html`<small>robots.txt hentes ved første læsning</small>`}`
        : ''}${r.last_error ? html`<small class="err-text">Seneste fejl: ${r.last_error}</small>` : ''}</td>
      <td class="num" data-label="Priser">${r.catalog_count}</td>
      <td data-label="Senest hentet">${formatDateTime(r.catalog_checked_at ?? r.last_import_at)}</td>
      <td>${r.access === 'demo'
        ? ''
        : html`<details class="act"><summary>Ret</summary><div class="act-body">
        <form method="post" action="/lager/priser/${r.id}" class="stack" style="display:grid">
          ${csrfField(d.csrf)}
          <label class="check"><input type="checkbox" name="active" value="1"${r.active ? html` checked` : ''}> Brug forhandleren i prisestimater</label>
          <div class="field"><label>Prisadgang</label><select name="access">${(['manuel', 'prisfil', 'side'] as const).map((a) => html`<option value="${a}"${r.access === a ? html` selected` : ''}>${ACCESS_LABEL[a]}</option>`)}</select>
            <p class="hint">Offentlige produktsider læses kun for de varer, der har et link til butikken, og kun hvor robots.txt tillader det. Login og robotkontrol omgås aldrig.</p></div>
          ${r.access === 'side' ? '' : html`<label class="check"><input type="checkbox" name="terms_ok" value="1"> Jeg har læst ${r.name}s vilkår, og de tillader automatisk læsning af offentlige produktsider (kræves for at læse sider)</label>`}
          <div class="field"><label>Officielt feed (https, valgfrit)</label><input name="feed_url" type="url" maxlength="500" value="${r.feed_url}" placeholder="https://"><p class="hint">Kun et feed, forhandleren selv stiller til rådighed til formålet. Hentes på serveren højst hver 6. time.</p></div>
          <button class="btn btn-dark btn-small" type="submit">Gem</button>
        </form>
        <form method="post" action="/lager/priser/${r.id}/prisfil" enctype="multipart/form-data" class="stack" style="display:grid">
          ${csrfField(d.csrf)}
          <div class="field"><label>Indlæs prisfil (CSV)</label><input type="file" name="file" accept=".csv,text/csv,text/plain" required></div>
          <label class="check"><input type="checkbox" name="public" value="1" required> Priserne er offentlige og kræver ikke login, medlemskab eller en kundeaftale</label>
          <button class="btn btn-secondary btn-small" type="submit">Indlæs</button>
        </form>
      </div></details>`}</td>
    </tr>`,
    )}</tbody>
  </table></div></div>
  <div class="grid grid-2">
    <form method="post" action="/lager/priser/indstillinger" class="card stack">
      ${csrfField(d.csrf)}
      <h2>Visning af estimater</h2>
      <div class="field"><label for="ev">Momsgrundlag på indkøbslister</label><select id="ev" name="estimate_vat"><option value="ekskl"${d.settings.estimate_vat !== 'inkl' ? html` selected` : ''}>Ekskl. moms</option><option value="inkl"${d.settings.estimate_vat === 'inkl' ? html` selected` : ''}>Inkl. moms</option></select><p class="hint">Alle priser omregnes til samme grundlag (25 % moms), så summen kan sammenlignes.</p></div>
      <div class="field"><label for="age">Priser er aktuelle i (dage)</label><input id="age" class="in-num" name="price_max_age_days" inputmode="numeric" value="${d.settings.price_max_age_days}"><p class="hint">Ældre priser vises som "${STALE_LABEL}".</p></div>
      <button class="btn btn-secondary" type="submit">Gem</button>
    </form>
    <div class="card stack">
      <h2>Prisfilens kolonner</h2>
      <p class="muted small" style="margin:0">Første række er overskrifter. Semikolon, komma eller tabulator. Priser i kroner (fx 100,00).</p>
      <dl class="kv small">${FEED_COLUMNS.map(([k, t]) => html`<dt><code>${k}</code></dt><dd>${t}</dd>`)}</dl>
    </div>
  </div>
</div>`;
}

type PageView = Awaited<ReturnType<typeof import('../lib/estimates').productPages>>[number];

/** Produktsider hos byggemarkederne for én vare (på varens side). */
export function productPagesCard(d: { productId: number; unit: string; pages: PageView[]; retailers: RetailerView[]; csrf: string; error?: string }): H {
  const rs = d.retailers.filter((r) => r.access !== 'demo');
  return html`<div class="card stack" id="produktsider">
  <h2>Produktsider hos byggemarkeder</h2>
  <p class="muted small" style="margin:0">Link til varen hos hver butik. Hos butikker, hvor læsning af offentlige sider er slået til, hentes prisen automatisk (robots.txt overholdes, og login eller robotkontrol omgås aldrig). Ellers bruges linket til manuel pris.</p>
  ${d.error ? alert('err', d.error) : ''}
  ${d.pages.length
    ? html`<div class="table-wrap"><table class="mini"><thead><tr><th>Butik</th><th>Side</th><th>Pakning</th><th>Seneste læsning</th><th></th></tr></thead><tbody>${d.pages.map(
        (p) => html`<tr>
        <td>${p.retailer_name}${p.retailer_access === 'side' && p.terms_confirmed_at ? '' : html`<small>Læses ikke automatisk</small>`}</td>
        <td><a href="${p.url}" target="_blank" rel="noopener noreferrer nofollow">${p.url.replace(/^https?:\/\//, '').slice(0, 60)}</a><small>${p.match === 'praecis' ? 'Samme vare' : 'Alternativ'}</small></td>
        <td>${p.pack_qty === 1000 ? `pr. ${p.sales_unit}` : `${p.sales_unit} á ${formatQty(p.pack_qty)} ${d.unit}`}</td>
        <td>${p.last_fetched_at ? html`<span class="${p.last_ok ? 'ok-text' : 'err-text'}">${p.last_status}</span><small>${formatDateTime(p.last_fetched_at)}</small>` : html`<span class="muted">Ikke læst endnu</span>`}</td>
        <td><form method="post" action="/lager/varer/${d.productId}/produktside/${p.id}/slet">${csrfField(d.csrf)}<button class="btn btn-ghost btn-small" type="submit">Fjern</button></form></td>
      </tr>`,
      )}</tbody></table></div>`
    : ''}
  ${rs.length
    ? html`<details class="act"><summary>Tilføj produktside</summary><div class="act-body">
    <form method="post" action="/lager/varer/${d.productId}/produktside" class="stack" style="display:grid">
      ${csrfField(d.csrf)}
      <div class="fields fields-2">
        <div class="field"><label>Butik</label><select name="retailer_id">${rs.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></div>
        <div class="field"><label>Er det samme vare?</label><select name="match"><option value="praecis">Ja, samme vare</option><option value="alternativ">Nej, et alternativ (kræver godkendelse)</option></select></div>
      </div>
      <div class="field"><label>Link til produktsiden</label><input name="url" type="url" maxlength="500" required placeholder="https://"></div>
      <div class="fields fields-2">
        <div class="field"><label>Sælges pr.</label><input name="sales_unit" maxlength="20" required value="${d.unit}"><p class="hint">Fx pk. hvis butikken sælger i pakker</p></div>
        <div class="field"><label>Indhold pr. salgsenhed (${d.unit})</label><input class="in-num" name="pack_qty" inputmode="decimal" value="1" required></div>
      </div>
      <button class="btn btn-dark btn-small" type="submit">Gem produktside</button>
    </form></div></details>`
    : ''}
</div>`;
}
