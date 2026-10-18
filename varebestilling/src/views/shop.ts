import { html } from 'hono/html';
import type { OrderEventRow, OrderLineRow, OrderRow } from '../env';
import { formatDateTime, formatKr } from '../lib/format';
import { STATUS_LABEL, type PricedCart, type PricedLine } from '../lib/orders';
import { available, type ProductWithReserved } from '../lib/products';
import { deliveryFee, lowStockLimit, safeUrl, type Settings } from '../lib/settings';
import { alert, csrfField, type H } from './layout';

function stockTag(p: ProductWithReserved, s: Settings): H {
  const a = available(p);
  if (a === null) return html``;
  if (a <= 0) return html`<span class="tag tag-out">Udsolgt</span>`;
  if (s.show_stock_count) return html`<span class="tag tag-ok">${a} på lager</span>`;
  if (a <= lowStockLimit(p, s)) return html`<span class="tag tag-low">Få på lager</span>`;
  return html`<span class="tag tag-ok">På lager</span>`;
}

/** Én række i bestillingsarket: varen og et felt til antal. */
function sheetRow(p: ProductWithReserved, s: Settings, qtyIn: number, staff: boolean): H {
  const a = available(p);
  const out = a === 0;
  const qty = out ? 0 : staff ? qtyIn : Math.min(qtyIn, a ?? qtyIn);
  const search = `${p.sku} ${p.name} ${p.category ?? ''}`.toLowerCase();
  const tag = staff ? staffStock(p, s) : stockTag(p, s);
  return html`<tr class="sheet-row${qty ? ' has-qty' : ''}${out ? ' is-out' : ''}" data-price="${p.price}" data-search="${search}">
    <td class="c-sku num">${p.sku}</td>
    <td class="c-name">
      <label for="q-${p.id}">${p.name}</label>
      ${p.description && !staff ? html`<span class="sheet-desc">${p.description}</span>` : ''}
      <span class="sheet-sub">${p.sku} · ${formatKr(p.price)} / ${p.unit} ${tag}</span>
    </td>
    <td class="c-unit">${p.unit}</td>
    <td class="c-price right num">${formatKr(p.price)}</td>
    <td class="c-stock">${tag}</td>
    <td class="c-qty">${out
      ? html`<input class="sheet-qty" id="q-${p.id}" type="number" value="" placeholder="–" disabled aria-label="${p.name} er udsolgt">`
      : html`<input class="sheet-qty" id="q-${p.id}" type="number" name="q_${p.id}" value="${qty || ''}" placeholder="0" min="0" max="${a ?? 9999}" inputmode="numeric" autocomplete="off">`}</td>
    <td class="c-sum right num" data-sum>${qty ? formatKr(qty * p.price) : ''}</td>
  </tr>`;
}

/** Lagerstatus til medarbejdere: altid det præcise antal, der kan sælges. */
function staffStock(p: ProductWithReserved, s: Settings): H {
  const a = available(p);
  if (a === null) return html`<span class="tag tag-off">Ubegrænset</span>`;
  const cls = a <= 0 ? 'tag-out' : a <= lowStockLimit(p, s) ? 'tag-low' : 'tag-ok';
  return html`<span class="tag ${cls}">${a} disponible</span>`;
}

/**
 * Bestillingsarket: alle varer i en tabel med et antalsfelt pr. række, beløb og en bundlinje med
 * i alt og knap. Bruges både af kunderne i webshoppen og af medarbejdere, der opretter ordrer.
 * Skal ligge inde i en <form class="sheet-form">.
 */
export function orderSheet(args: {
  settings: Settings;
  products: ProductWithReserved[];
  quantities: Map<number, number>;
  submitLabel: string;
  staff?: boolean;
}): H {
  const s = args.settings;
  const staff = !!args.staff;
  const groups = new Map<string, ProductWithReserved[]>();
  for (const p of args.products) {
    const k = p.category || 'Øvrige';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const showGroups = groups.size > 1;
  const slug = (name: string) => 'kat-' + [...groups.keys()].indexOf(name);
  let count = 0;
  let total = 0;
  for (const p of args.products) {
    const a = available(p);
    const q = staff ? (args.quantities.get(p.id) ?? 0) : Math.min(args.quantities.get(p.id) ?? 0, a ?? Infinity);
    if (q > 0 && a !== 0) {
      count++;
      total += q * p.price;
    }
  }
  return html`${showGroups
      ? html`<nav class="cat-nav" aria-label="Kategorier">
          ${[...groups.keys()].map((c) => html`<a href="#${slug(c)}">${c}</a>`)}
        </nav>`
      : ''}
    <div class="card card-flush sheet-wrap">
      <table class="sheet">
        <thead>
          <tr>
            <th class="c-sku" scope="col">Varenr.</th>
            <th class="c-name" scope="col">Vare</th>
            <th class="c-unit" scope="col">Enhed</th>
            <th class="c-price right" scope="col">Pris</th>
            <th class="c-stock" scope="col">Lager</th>
            <th class="c-qty" scope="col">Antal</th>
            <th class="c-sum right" scope="col">Beløb</th>
          </tr>
        </thead>
        ${[...groups].map(
          ([name, items]) => html`<tbody>
            ${showGroups ? html`<tr class="sheet-group" id="${slug(name)}"><th colspan="7" scope="colgroup">${name}</th></tr>` : ''}
            ${items.map((p) => sheetRow(p, s, args.quantities.get(p.id) ?? 0, staff))}
          </tbody>`,
        )}
        <tbody class="sheet-none hidden"><tr><td colspan="7" class="muted">Ingen varer matcher din søgning.</td></tr></tbody>
      </table>
    </div>
    <div class="sheet-bar">
      <div class="sheet-bar-inner">
        <div class="sheet-total" aria-live="polite">
          <span class="muted small"><span data-count>${count}</span> ${count === 1 ? 'vare' : 'varer'} valgt</span>
          <strong data-total>${formatKr(total)}</strong>
        </div>
        <button class="btn btn-primary" type="submit">${args.submitLabel}</button>
      </div>
    </div>`;
}

export function catalogPage(args: {
  settings: Settings;
  products: ProductWithReserved[];
  categories: string[];
  q: string;
  csrf: string;
  cart: Map<number, number>;
  error: string | null;
}): H {
  const s = args.settings;
  return html`<div class="hero">
      <p class="eyebrow">Bestilling</p>
      <h1>${s.tagline || s.shop_name}</h1>
      ${s.intro ? html`<p class="lead">${s.intro}</p>` : ''}
    </div>
    <form class="toolbar" method="get" action="/" role="search" style="margin-bottom:12px" data-sheet-search>
      <label class="sr-only" for="q">Søg</label>
      <input id="q" type="search" name="q" value="${args.q}" placeholder="Søg efter vare eller varenummer" autocomplete="off">
      <button class="btn btn-secondary" type="submit">Søg</button>
    </form>
    ${args.q ? html`<p class="muted" style="margin-bottom:16px">${args.products.length} resultater for "${args.q}". <a href="/">Vis alle</a></p>` : ''}
    ${args.error ? html`<div style="margin-bottom:16px">${alert('warn', args.error)}</div>` : ''}
    ${!args.products.length
      ? html`<div class="card empty">${args.q ? 'Ingen varer matcher din søgning.' : 'Der er ingen varer at vise endnu.'}</div>`
      : html`<form method="post" action="/bestil" class="sheet-form">
          ${csrfField(args.csrf)}
          <input type="hidden" name="back" value="${args.q ? `/?q=${encodeURIComponent(args.q)}` : '/'}">
          <p class="small muted sheet-help">Skriv antal ud for de varer, du vil bestille, og tryk på <strong>Gå til bestilling</strong>.</p>
          ${orderSheet({ settings: s, products: args.products, quantities: args.cart, submitLabel: 'Gå til bestilling' })}
        </form>`}`;
}

function summary(priced: PricedCart, s: Settings, delivery: 'afhentning' | 'levering' | null): H {
  const fee = delivery === 'levering' ? deliveryFee(s, priced.subtotal) : 0;
  return html`<table class="totals">
    <tr><td>Varer</td><td>${formatKr(priced.subtotal)}</td></tr>
    ${delivery === 'levering' ? html`<tr><td>Levering</td><td>${fee ? formatKr(fee) : 'Gratis'}</td></tr>` : ''}
    ${delivery === null && s.delivery_enabled
      ? html`<tr><td>Levering</td><td class="muted">${s.pickup_enabled ? 'Afhentning er gratis' : 'Beregnes ved kassen'}</td></tr>`
      : ''}
    <tr class="total"><td>I alt</td><td>${formatKr(priced.subtotal + fee)}</td></tr>
  </table>
  <p class="xs muted">Alle priser er inkl. moms.</p>`;
}

function shortNotice(short: PricedLine[]): H {
  return alert(
    'warn',
    html`Der er ikke nok på lager af:
      <ul>${short.map((l) => html`<li>${l.name}: ${l.available ? `kun ${l.available} tilbage` : 'udsolgt'}</li>`)}</ul>
      Ret antallet for at fortsætte.`,
  );
}

export function cartPage(args: { settings: Settings; priced: PricedCart; csrf: string; notice?: string | null; warning?: string | null }): H {
  const { priced, settings: s } = args;
  if (!priced.lines.length) {
    return html`<div class="stack-lg narrow">
      <h1>Kurv</h1>
      ${priced.removed ? alert('info', 'Nogle varer er fjernet fra kurven, fordi de ikke længere kan bestilles.') : ''}
      <div class="card empty">Kurven er tom. <a href="/">Se varerne</a></div>
    </div>`;
  }
  const minShort = s.min_order > 0 && priced.subtotal < s.min_order;
  return html`<div class="stack-lg">
    <h1>Kurv</h1>
    ${args.notice ? alert('ok', args.notice) : ''}
    ${args.warning ? alert('warn', args.warning) : ''}
    ${priced.removed ? alert('info', 'Nogle varer er fjernet fra kurven, fordi de ikke længere kan bestilles.') : ''}
    ${priced.short.length ? shortNotice(priced.short) : ''}
    <div class="layout-side">
      <form class="card" method="post" action="/kurv/opdater">
        ${csrfField(args.csrf)}
        ${priced.lines.map(
          (l) => html`<div class="cart-line">
            <div>
              <div style="font-weight:600">${l.name}</div>
              <div class="xs muted">${l.sku} · ${formatKr(l.unit_price)} / ${l.unit}${l.available !== null && l.quantity > l.available
                ? html` · <strong style="color:var(--err)">${l.available ? `kun ${l.available} på lager` : 'udsolgt'}</strong>`
                : ''}</div>
            </div>
            <div class="ctrl">
              <label class="sr-only" for="q-${l.productId}">Antal af ${l.name}</label>
              <input class="qty" id="q-${l.productId}" type="number" name="q_${l.productId}" value="${l.quantity}" min="0" max="9999" inputmode="numeric">
              <button class="btn btn-ghost btn-small" type="submit" name="fjern" value="${l.productId}">Fjern</button>
            </div>
            <div class="price right">${formatKr(l.line_total)}</div>
          </div>`,
        )}
        <div class="row-between" style="margin-top:16px">
          <a href="/">← Tilbage til varelisten</a>
          <button class="btn btn-secondary" type="submit">Opdater antal</button>
        </div>
      </form>
      <aside class="side card stack">
        <h2>Oversigt</h2>
        ${summary(priced, s, null)}
        ${minShort ? alert('info', `Mindste ordre er ${formatKr(s.min_order)}.`) : ''}
        ${priced.short.length || minShort
          ? html`<button class="btn btn-primary btn-block" type="button" disabled>Gå til kassen</button>`
          : html`<a class="btn btn-primary btn-block" href="/kassen">Gå til kassen</a>`}
      </aside>
    </div>
  </div>`;
}

export interface CheckoutValues {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  company: string;
  delivery: 'afhentning' | 'levering';
  address: string;
  postcode: string;
  city: string;
  note: string;
  accept: boolean;
}

export function checkoutPage(args: {
  settings: Settings;
  priced: PricedCart;
  csrf: string;
  values: CheckoutValues;
  errors?: Partial<Record<keyof CheckoutValues | 'form', string>>;
}): H {
  const { settings: s, values: v, priced } = args;
  const e = args.errors ?? {};
  const err = (k: keyof CheckoutValues) => (e[k] ? html`<p class="hint" style="color:var(--err)" id="err-${k}">${e[k]}</p>` : '');
  const inv = (k: keyof CheckoutValues) => (e[k] ? html` aria-invalid="true" aria-describedby="err-${k}"` : '');
  const terms = safeUrl(s.terms_url);
  const both = s.pickup_enabled && s.delivery_enabled;
  const fee = deliveryFee(s, priced.subtotal);
  return html`<div class="stack-lg">
    <div class="stack-sm">
      <p class="steps"><a href="/kurv">Kurv</a> › <b>Kassen</b> › Bekræftelse</p>
      <h1>Kassen</h1>
    </div>
    ${e.form ? alert('err', e.form) : ''}
    ${priced.short.length ? shortNotice(priced.short) : ''}
    <div class="layout-side">
      <form class="card stack-lg" method="post" action="/kassen" novalidate>
        ${csrfField(args.csrf)}
        <fieldset>
          <legend>Dine oplysninger</legend>
          <div class="fields fields-2">
            <div class="field"><label for="customer_name">Navn</label>
              <input id="customer_name" name="customer_name" value="${v.customer_name}" autocomplete="name" required maxlength="100"${inv('customer_name')}>${err('customer_name')}</div>
            <div class="field"><label for="company">Firma <span class="muted">(valgfrit)</span></label>
              <input id="company" name="company" value="${v.company}" autocomplete="organization" maxlength="100"></div>
            <div class="field"><label for="customer_email">E-mail</label>
              <input id="customer_email" type="email" name="customer_email" value="${v.customer_email}" autocomplete="email" required maxlength="254"${inv('customer_email')}>${err('customer_email')}</div>
            <div class="field"><label for="customer_phone">Telefon</label>
              <input id="customer_phone" type="tel" name="customer_phone" value="${v.customer_phone}" autocomplete="tel" required maxlength="30"${inv('customer_phone')}>${err('customer_phone')}</div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Levering</legend>
          ${both
            ? html`<div class="radio-cards">
                <label class="radio-card"><input type="radio" name="delivery" value="afhentning"${v.delivery === 'afhentning' ? ' checked' : ''}>
                  <span><strong>Afhentning</strong><span class="small muted">Gratis${s.address ? ` · ${s.address}` : ''}</span></span></label>
                <label class="radio-card"><input type="radio" name="delivery" value="levering"${v.delivery === 'levering' ? ' checked' : ''}>
                  <span><strong>Levering</strong><span class="small muted">${fee ? formatKr(fee) : 'Gratis'}${s.free_delivery_from && fee
                    ? ` · gratis over ${formatKr(s.free_delivery_from)}`
                    : ''}</span></span></label>
              </div>`
            : html`<input type="hidden" name="delivery" value="${s.delivery_enabled ? 'levering' : 'afhentning'}">
                <p>${s.delivery_enabled ? html`Vi leverer til din adresse (${fee ? formatKr(fee) : 'gratis'}).` : html`Bestillingen afhentes${s.address ? ` på ${s.address}` : ''}.`}</p>`}
          ${s.pickup_enabled && s.pickup_info ? html`<p class="hint">${s.pickup_info}</p>` : ''}
          ${s.delivery_enabled && s.delivery_info ? html`<p class="hint">${s.delivery_info}</p>` : ''}
          ${s.delivery_enabled
            ? html`<div id="adresse" class="fields fields-3" style="margin-top:16px">
                <div class="field" style="grid-column:1/-1"><label for="address">Adresse</label>
                  <input id="address" name="address" value="${v.address}" autocomplete="street-address" maxlength="150"${inv('address')}>${err('address')}</div>
                <div class="field"><label for="postcode">Postnummer</label>
                  <input id="postcode" name="postcode" value="${v.postcode}" autocomplete="postal-code" inputmode="numeric" maxlength="10"${inv('postcode')}>${err('postcode')}</div>
                <div class="field" style="grid-column:span 2"><label for="city">By</label>
                  <input id="city" name="city" value="${v.city}" autocomplete="address-level2" maxlength="80"${inv('city')}>${err('city')}</div>
              </div>`
            : ''}
        </fieldset>
        <div class="field">
          <label for="note">Besked til os <span class="muted">(valgfrit)</span></label>
          <textarea id="note" name="note" maxlength="1000" placeholder="Fx ønsket afhentningstidspunkt eller andet, vi skal vide">${v.note}</textarea>
        </div>
        ${terms
          ? html`<div><label class="check"><input type="checkbox" name="accept" value="1"${v.accept ? ' checked' : ''}${inv('accept')}>
              <span>Jeg accepterer <a href="${terms}" target="_blank" rel="noopener">handelsbetingelserne</a></span></label>${err('accept')}</div>`
          : ''}
        <button class="btn btn-primary btn-block" type="submit"${priced.short.length ? ' disabled' : ''}>Send bestilling</button>
        <p class="xs muted">Bestillingen er bindende, når vi har bekræftet den. Du får en kvittering på e-mail.</p>
      </form>
      <aside class="side card stack">
        <h2>Din bestilling</h2>
        <table class="totals">
          ${priced.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td>${formatKr(l.line_total)}</td></tr>`)}
        </table>
        ${summary(priced, s, v.delivery)}
        <a class="small" href="/kurv">Ret i kurven</a>
      </aside>
    </div>
  </div>`;
}

export function orderPage(args: { settings: Settings; order: OrderRow; lines: OrderLineRow[]; events: OrderEventRow[]; justPlaced: boolean; csrf: string }): H {
  const { order: o, settings: s } = args;
  const statusEvents = args.events.filter((e) => e.status);
  return html`<div class="stack-lg narrow" style="max-width:720px">
    <div class="stack-sm">
      ${args.justPlaced ? html`<p class="steps">Kurv › Kassen › <b>Bekræftelse</b></p>` : ''}
      <h1>${args.justPlaced ? 'Tak for din bestilling' : `Bestilling #${o.number}`}</h1>
      <p class="muted">${args.justPlaced
        ? html`Ordrenummer <strong>#${o.number}</strong>. Vi har sendt en kvittering til ${o.customer_email}.`
        : html`Bestilt ${formatDateTime(o.created_at)}`}</p>
    </div>
    <div class="card stack">
      <div class="row-between"><h2>Status</h2><span class="tag tag-${o.status}">${STATUS_LABEL[o.status]}</span></div>
      <ol class="timeline">
        ${statusEvents.map((e) => html`<li><strong>${STATUS_LABEL[e.status as OrderRow['status']] ?? e.status}</strong> <span class="muted">· ${formatDateTime(e.created_at)}</span></li>`)}
      </ol>
      ${o.status === 'ny' ? html`<p class="small muted">Vi gennemgår din bestilling og giver besked på e-mail, når den er bekræftet.</p>` : ''}
    </div>
    <div class="card stack">
      <h2>Varer</h2>
      <table class="totals">
        ${args.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name} <span class="xs muted">${l.sku}</span></td><td>${formatKr(l.line_total)}</td></tr>`)}
        <tr><td>Varer i alt</td><td>${formatKr(o.subtotal)}</td></tr>
        ${o.delivery === 'levering' ? html`<tr><td>Levering</td><td>${o.delivery_fee ? formatKr(o.delivery_fee) : 'Gratis'}</td></tr>` : ''}
        <tr class="total"><td>I alt inkl. moms</td><td>${formatKr(o.total)}</td></tr>
      </table>
    </div>
    <div class="card">
      <dl class="kv">
        <dt>Navn</dt><dd>${o.customer_name}${o.company ? html`, ${o.company}` : ''}</dd>
        <dt>Kontakt</dt><dd>${o.customer_email} · ${o.customer_phone}</dd>
        <dt>${o.delivery === 'levering' ? 'Levering' : 'Afhentning'}</dt>
        <dd>${o.delivery === 'levering' ? html`${o.address}, ${o.postcode} ${o.city}` : s.address || 'Hos os'}</dd>
        ${o.note ? html`<dt>Besked</dt><dd style="white-space:pre-wrap">${o.note}</dd>` : ''}
      </dl>
    </div>
    ${s.contact_email || s.contact_phone
      ? html`<p class="small muted">Spørgsmål til bestillingen? ${s.contact_email
          ? html`Skriv til <a href="mailto:${s.contact_email}">${s.contact_email}</a>${s.contact_phone ? html` eller ring på ${s.contact_phone}` : ''}`
          : html`Ring på ${s.contact_phone}`}.</p>`
      : ''}
    <div class="row">
      <form method="post" action="/ordre/${o.token}/igen">${csrfField(args.csrf)}<button class="btn btn-primary" type="submit">Bestil det samme igen</button></form>
      <a class="btn btn-secondary" href="/">Tilbage til butikken</a>
    </div>
  </div>`;
}

export function messagePage(title: string, text: string): H {
  return html`<div class="stack-lg narrow"><h1>${title}</h1><p class="muted">${text}</p><a class="btn btn-primary" href="/">Til butikken</a></div>`;
}

/** Vejledning i at lægge bestillingen (eller administrationspanelet) på telefonens hjemmeskærm. */
export function appPage(args: { settings: Settings; admin?: boolean }): H {
  const s = args.settings;
  const what = args.admin ? 'administrationspanelet' : 'bestillingen';
  return html`<div class="stack-lg narrow" style="max-width:720px">
    <div class="stack-sm">
      <p class="eyebrow">App</p>
      <h1>${args.admin ? 'Ordrer og lager som app' : `Bestil hos ${s.shop_name} fra telefonen`}</h1>
      <p class="lead">Læg ${what} på hjemmeskærmen, så åbner den som en app med ét tryk. Der skal ikke hentes noget i App Store eller Google Play.</p>
    </div>
    <div class="card stack" data-install hidden>
      <h2>Installér med ét tryk</h2>
      <p class="muted">Din browser kan installere appen direkte.</p>
      <button class="btn btn-primary" type="button" data-install-button>Installér appen</button>
    </div>
    <div class="grid grid-2">
      <section class="card stack">
        <h2>iPhone og iPad</h2>
        <ol class="steps-list">
          <li>Åbn siden i <strong>Safari</strong>.</li>
          <li>Tryk på <strong>Del</strong> (firkanten med pilen op).</li>
          <li>Vælg <strong>Føj til hjemmeskærm</strong>, og tryk <strong>Tilføj</strong>.</li>
        </ol>
      </section>
      <section class="card stack">
        <h2>Android</h2>
        <ol class="steps-list">
          <li>Åbn siden i <strong>Chrome</strong>.</li>
          <li>Tryk på menuen <strong>⋮</strong> øverst til højre.</li>
          <li>Vælg <strong>Installér app</strong> eller <strong>Føj til startskærm</strong>.</li>
        </ol>
      </section>
    </div>
    <p class="small muted">${args.admin
      ? 'Du forbliver logget ind i appen. Lagertal og ordrer hentes altid direkte, så de er opdaterede.'
      : 'Appen viser altid de aktuelle priser og lagerstatus. Din kurv huskes, til du bestiller.'}</p>
    <a class="btn btn-secondary" href="${args.admin ? '/admin' : '/'}">${args.admin ? 'Til oversigten' : 'Til varerne'}</a>
  </div>`;
}

export function offlinePage(): H {
  return html`<div class="stack-lg narrow">
    <h1>Ingen forbindelse</h1>
    <p class="muted">Du er ikke på nettet lige nu. Bestillinger og lagertal kræver forbindelse, så de altid er opdaterede. Prøv igen, når du har net.</p>
    <a class="btn btn-primary" href="">Prøv igen</a>
  </div>`;
}
