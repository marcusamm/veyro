import { html } from 'hono/html';
import type { OrderEventRow, OrderLineRow, OrderRow, OrderSource, OrderStatus, ProductRow } from '../env';
import type { ImportError, PlannedRow } from '../lib/csv';
import { FIELD_LABEL, type Field } from '../lib/csv';
import { formatDate, formatDateTime, formatKr, oereToInput } from '../lib/format';
import { MIN_HISTORY_DAYS, SERVICE_LEVELS, reorderInfo, type ReorderInfo } from '../lib/forecast';
import { SOURCE_LABEL, STATUSES, STATUS_LABEL, TRANSITIONS, type OrderListRow, type StatusEvent } from '../lib/orders';
import type { MovementWithProduct, ProductWithReserved } from '../lib/products';
import { lowStockLimit, safeUrl, type Settings } from '../lib/settings';
import { alert, csrfField, type H } from './layout';
import { orderSheet } from './shop';

// ---------------- Login ----------------

export function loginPage(args: { csrf: string; email?: string; error?: string; info?: string | null; next?: string | null }): H {
  return html`<div class="narrow stack-lg" style="margin:24px auto 0">
    <div class="stack-sm"><h1>Log ind</h1><p class="muted">For medarbejdere. Du får et login-link på e-mail.</p></div>
    ${args.info ? alert('ok', args.info) : ''}
    ${args.error ? alert('err', args.error) : ''}
    <form class="card stack" method="post" action="/admin/login${args.next ? `?next=${encodeURIComponent(args.next)}` : ''}">
      ${csrfField(args.csrf)}
      <div class="field"><label for="email">E-mail</label>
        <input id="email" type="email" name="email" value="${args.email ?? ''}" autocomplete="email" required autofocus></div>
      <button class="btn btn-primary btn-block" type="submit">Send login-link</button>
    </form>
  </div>`;
}

export function loginSentPage(devLink: string | null): H {
  return html`<div class="narrow stack-lg" style="margin:24px auto 0">
    <h1>Tjek din indbakke</h1>
    <p class="muted">Hvis e-mailen har adgang, har vi sendt et login-link. Linket virker i 15 minutter.</p>
    ${devLink ? alert('info', html`<strong>Udviklingstilstand:</strong> <a class="devlink" href="${devLink}">${devLink}</a>`) : ''}
    <a href="/admin/login">Tilbage</a>
  </div>`;
}

export function verifyPage(csrf: string, token: string, next: string | null): H {
  return html`<div class="narrow stack-lg" style="margin:24px auto 0">
    <h1>Bekræft login</h1>
    <form class="card stack" method="post" action="/admin/login/bekraeft">
      ${csrfField(csrf)}
      <input type="hidden" name="token" value="${token}">
      ${next ? html`<input type="hidden" name="next" value="${next}">` : ''}
      <p>Klik for at logge ind i ordresystemet.</p>
      <button class="btn btn-primary btn-block" type="submit">Log ind</button>
    </form>
  </div>`;
}

export function linkInvalidPage(): H {
  return html`<div class="narrow stack-lg" style="margin:24px auto 0">
    <h1>Linket virker ikke</h1>
    <p class="muted">Linket er udløbet eller allerede brugt. Bed om et nyt.</p>
    <a class="btn btn-primary" href="/admin/login">Få et nyt link</a>
  </div>`;
}

// ---------------- Fælles ----------------

export function statusTag(s: OrderStatus): H {
  return html`<span class="tag tag-${s}">${STATUS_LABEL[s]}</span>`;
}

function stockCell(p: ProductWithReserved | ProductRow, s: Settings): H {
  if (!p.track_stock) return html`<span class="tag tag-off">Ingen lagerstyring</span>`;
  const low = p.stock <= lowStockLimit(p, s);
  const cls = p.stock <= 0 ? 'tag-out' : low ? 'tag-low' : 'tag-ok';
  return html`<span class="tag ${cls} num">${p.stock}</span>`;
}

export function flashMessage(code: string | undefined): H | '' {
  const m: Record<string, [kind: 'ok' | 'info' | 'warn' | 'err', text: string]> = {
    gemt: ['ok', 'Ændringerne er gemt.'],
    oprettet: ['ok', 'Varen er oprettet.'],
    slettet: ['ok', 'Varen er slettet.'],
    lager: ['ok', 'Lageret er opdateret.'],
    status: ['ok', 'Status er ændret.'],
    note: ['ok', 'Noten er gemt.'],
    beregnet: ['ok', 'Tallene er beregnet igen. Varer, der skal bestilles hjem, er varslet på e-mail.'],
    ordre_oprettet: ['ok', 'Ordren er oprettet.'],
    logget_ud: ['ok', 'Du er logget ud.'],
  };
  const v = code ? m[code] : undefined;
  return v ? alert(v[0], v[1]) : '';
}

// ---------------- Oversigt ----------------

export function sourceTag(src: OrderSource): H {
  return html`<span class="tag tag-src">${SOURCE_LABEL[src]}</span>`;
}

const stk = (n: number) => `${n} ${n === 1 ? 'vare' : 'varer'}`;

function activityLine(e: StatusEvent): H {
  const what: Record<OrderStatus, [string, string]> = {
    ny: ['modtaget', `${stk(e.item_count)} reserveret · ${SOURCE_LABEL[e.source].toLowerCase()}`],
    bekraeftet: ['bekræftet', `${stk(e.item_count)} trukket fra lager`],
    klar: ['klar / afsendt', stk(e.item_count)],
    afsluttet: ['afsluttet', stk(e.item_count)],
    annulleret: ['annulleret', `${stk(e.item_count)} frigivet`],
  };
  const [verb, detail] = what[e.status];
  return html`<li><span><a href="/admin/ordrer/${e.order_id}">Ordre #${e.number}</a> ${verb}</span><em>${detail}</em></li>`;
}

export function dashboardPage(args: {
  settings: Settings;
  counts: Record<OrderStatus, number>;
  latest: OrderListRow[];
  stock: ProductWithReserved[];
  events: StatusEvent[];
  manual: MovementWithProduct[];
  today: { orders: number; total: number };
  month: { orders: number; total: number };
  productCount: number;
}): H {
  const s = args.settings;
  const c = args.counts;
  const newest = args.latest.find((o) => o.status === 'ny');
  const limit = (p: ProductWithReserved) => lowStockLimit(p, s);
  const avail = (p: ProductWithReserved) => Math.max(0, p.stock - p.reserved);
  const now = Math.floor(Date.now() / 1000);
  const alerts = args.stock
    .map((p) => ({ p, r: reorderInfo(p, s) }))
    .filter((x) => x.r.urgency !== 'ok')
    .sort((a, b) => (a.r.daysToReorder ?? (a.r.urgency === 'now' ? 0 : 999)) - (b.r.daysToReorder ?? (b.r.urgency === 'now' ? 0 : 999)))
    .slice(0, 6);
  const alertText = ({ p, r }: { p: ProductWithReserved; r: ReorderInfo }) => {
    if (r.available <= 0) return 'Udsolgt. 0 disponible.';
    if (r.urgency === 'now') return `Under genbestillingspunktet: ${r.available} disponible (punkt ${r.limit}). Bestil ca. ${r.suggestQty} hjem nu.`;
    return `Bestil senest ${formatDate(now + (r.daysToReorder ?? 0) * 86400)}: ${r.available} disponible, sælger ca. ${dec(r.avgDaily ?? 0)} pr. dag.`;
  };
  // Ordrehændelser og manuelle lagerændringer flettet efter tid
  const activity = [
    ...args.events.map((e) => ({ at: e.created_at, html: activityLine(e) })),
    ...args.manual.map((m) => ({
      at: m.created_at,
      html: html`<li><span>${m.reason || 'Lagerregulering'}</span><em>${m.name} ${m.change > 0 ? '+' : '−'}${Math.abs(m.change)}</em></li>`,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);
  return html`<div class="stack-lg">
    <div class="page-head">
      <div><p class="eyebrow">Administrationspanel</p><h1>Ordrer og lager</h1></div>
      <a class="btn btn-primary" href="/admin/ordrer/ny">+ Ny ordre</a>
    </div>
    ${args.productCount === 0
      ? alert('info', html`Der er ingen varer endnu. <a href="/admin/import">Importér en vareliste</a> eller <a href="/admin/varer/ny">opret en vare</a>.`)
      : ''}
    <div class="stats">
      <a class="stat" href="/admin/ordrer?status=ny"><span class="n">${c.ny}</span><span class="l">Nye ordrer</span></a>
      <a class="stat" href="/admin/ordrer?status=bekraeftet"><span class="n">${c.bekraeftet}</span><span class="l">Skal pakkes</span></a>
      <div class="stat"><span class="n">${formatKr(args.today.total)}</span><span class="l">I dag · ${args.today.orders} ordrer</span></div>
      <div class="stat"><span class="n">${formatKr(args.month.total)}</span><span class="l">Seneste 30 dage · ${args.month.orders} ordrer</span></div>
    </div>
    <div class="app">
      <div class="app-bar">
        <span class="app-name">${s.shop_name}</span>
        ${newest
          ? html`<a class="app-toast" href="/admin/ordrer/${newest.id}"><span class="app-toast-dot" aria-hidden="true"></span>Ny ordre #${newest.number} fra ${SOURCE_LABEL[newest.source].toLowerCase()}</a>`
          : ''}
      </div>
      <div class="app-grid">
        <section class="app-panel app-panel--orders" aria-labelledby="h-ordrer">
          <div class="app-title"><h2 id="h-ordrer">Ordreoversigt</h2><a class="small" href="/admin/ordrer">Se alle</a></div>
          <nav class="tabs tabs-sm" aria-label="Ordrer efter status">
            <a href="/admin/ordrer?status=ny" aria-current="page">Nye <b>${c.ny}</b></a>
            <a href="/admin/ordrer?status=bekraeftet">Bekræftede <b>${c.bekraeftet}</b></a>
            <a href="/admin/ordrer?status=klar">Klar <b>${c.klar}</b></a>
            <a href="/admin/ordrer?status=afsluttet">Afsluttede <b>${c.afsluttet}</b></a>
            <a href="/admin/ordrer?status=annulleret">Annullerede <b>${c.annulleret}</b></a>
          </nav>
          ${args.latest.length
            ? html`<table class="mini">
                <thead><tr><th scope="col">Ordre</th><th scope="col">Kunde</th><th scope="col" class="hide-xs">Kilde</th><th scope="col" class="num">Varer</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  ${args.latest.map(
                    (o) => html`<tr class="row-link" data-href="/admin/ordrer/${o.id}">
                      <td><a href="/admin/ordrer/${o.id}">#${o.number}</a></td>
                      <td>${o.company || o.customer_name}</td>
                      <td class="hide-xs">${SOURCE_LABEL[o.source]}</td>
                      <td class="num">${o.item_count}</td>
                      <td>${statusTag(o.status)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>`
            : html`<p class="muted small">Ingen ordrer endnu.</p>`}
        </section>
        <section class="app-panel app-panel--stock" aria-labelledby="h-lager">
          <div class="app-title"><h2 id="h-lager">Lagerstatus</h2><a class="small" href="/admin/varer">Alle varer</a></div>
          ${args.stock.length
            ? html`<table class="mini">
                <thead><tr><th scope="col">Vare</th><th scope="col" class="num">På lager</th><th scope="col" class="num">Reserveret</th><th scope="col" class="num">Disponibel</th></tr></thead>
                <tbody>
                  ${args.stock.slice(0, 6).map((p) => {
                    const a = avail(p);
                    const cls = a <= 0 ? 'is-out' : a <= limit(p) ? 'is-low' : '';
                    return html`<tr class="row-link ${cls}" data-href="/admin/varer/${p.id}">
                      <td><a href="/admin/varer/${p.id}">${p.name}</a><small>${p.sku}</small></td>
                      <td class="num">${p.stock}</td>
                      <td class="num">${p.reserved}</td>
                      <td class="num"><b>${a}</b>${a <= 0 ? html`<span class="tag tag-out">Udsolgt</span>` : a <= limit(p) ? html`<span class="tag tag-low">Lav</span>` : ''}</td>
                    </tr>`;
                  })}
                </tbody>
              </table>`
            : html`<p class="muted small">Ingen varer med lagerstyring endnu.</p>`}
        </section>
        <section class="app-panel app-panel--alerts">
          <div>
            <div class="app-title"><h2>Advarsler og genbestilling</h2><a class="small" href="/admin/genbestilling">Se alle</a></div>
            ${alerts.length
              ? html`<ul class="app-alerts">
                  ${alerts.map(
                    (x) => html`<li class="${x.r.urgency === 'now' ? 'is-out' : ''}"><a href="/admin/varer/${x.p.id}"><b>${x.p.name}</b></a><span>${alertText(x)}</span></li>`,
                  )}
                </ul>`
              : html`<p class="muted small">Ingen advarsler. Alle varer har lager nok til de næste ${s.reorder_warn_days} dage.</p>`}
          </div>
          <div>
            <div class="app-title"><h2>Seneste ændringer</h2><a class="small" href="/admin/historik">Historik</a></div>
            ${activity.length ? html`<ul class="app-log">${activity.map((a) => a.html)}</ul>` : html`<p class="muted small">Intet endnu.</p>`}
          </div>
        </section>
      </div>
    </div>
    <p class="xs muted">Reserveret er varer i nye ordrer, der endnu ikke er bekræftet. Når en ordre bekræftes, trækkes varerne fra lageret.
      <a href="/admin/app">Brug panelet som app på telefonen</a>.</p>
  </div>`;
}

// ---------------- Genbestilling ----------------

const dec = (n: number) => n.toLocaleString('da-DK', { maximumFractionDigits: n < 10 ? 1 : 0 });

/** "Bestil nu", "Bestil senest 24. okt." eller "God tid". */
export function reorderWhen(r: ReorderInfo, now: number): H {
  if (r.urgency === 'now') return html`<span class="tag tag-out">Bestil nu</span>`;
  if (r.daysToReorder === null) return html`<span class="muted">–</span>`;
  const date = formatDate(now + r.daysToReorder * 86400);
  return r.urgency === 'soon'
    ? html`<span class="tag tag-low">Senest ${date}</span>`
    : html`<span class="muted nowrap">${date}</span>`;
}

export function reorderPage(args: {
  csrf: string;
  settings: Settings;
  rows: { p: ProductWithReserved; r: ReorderInfo }[];
  now: number;
  flash?: H | '';
}): H {
  const s = args.settings;
  const due = args.rows.filter((x) => x.r.urgency !== 'ok').length;
  return html`<div class="stack-lg">
    <div class="page-head">
      <div><p class="eyebrow">Lager</p><h1>Genbestilling</h1></div>
      <form method="post" action="/admin/genbestilling/beregn">${csrfField(args.csrf)}<button class="btn btn-secondary" type="submit">Beregn igen og send varsel</button></form>
    </div>
    ${args.flash ?? ''}
    <p class="muted" style="max-width:760px">Sikkerhedslager og genbestillingspunkt beregnes automatisk ud fra jeres salg de seneste ${s.forecast_days} dage
      og leveringstiden fra leverandøren. Systemet varsler på e-mail ${s.reorder_warn_days} dage før en vare skal bestilles hjem.
      Varer med et fast minimum bruger det i stedet.</p>
    <div class="stats">
      <div class="stat"><span class="n">${due}</span><span class="l">Skal bestilles inden for ${s.reorder_warn_days} dage</span></div>
      <div class="stat"><span class="n">${s.service_level} %</span><span class="l">Sikkerhed mod udsolgt</span></div>
      <div class="stat"><span class="n">${s.lead_time_days} dage</span><span class="l">Standard leveringstid</span></div>
      <a class="stat" href="/admin/indstillinger#genbestilling"><span class="n">Indstillinger</span><span class="l">Ret beregningen</span></a>
    </div>
    <div class="card card-flush">
      ${args.rows.length
        ? html`<div class="table-wrap"><table class="list stackable">
            <thead><tr><th>Vare</th><th class="right">Disponibel</th><th class="right">Salg pr. dag</th><th class="right">Sikkerhedslager</th><th class="right">Genbestillingspunkt</th><th class="right">Leveringstid</th><th>Bestil hjem</th><th class="right">Foreslået antal</th></tr></thead>
            <tbody>
              ${args.rows.map(
                ({ p, r }) => html`<tr class="row-link${r.urgency === 'now' ? ' is-out' : r.urgency === 'soon' ? ' is-low' : ''}" data-href="/admin/varer/${p.id}">
                  <td class="cell-main"><a class="title" href="/admin/varer/${p.id}">${p.name}</a><div class="xs muted">${p.sku}</div></td>
                  <td data-label="Disponibel" class="right num"><strong>${r.available}</strong></td>
                  <td data-label="Salg pr. dag" class="right num">${r.avgDaily === null ? html`<span class="muted">Intet salg</span>` : dec(r.avgDaily)}</td>
                  <td data-label="Sikkerhedslager" class="right num">${r.safety ?? html`<span class="muted">–</span>`}</td>
                  <td data-label="Genbestillingspunkt" class="right num">${r.limit} <span class="xs muted">${r.automatic ? 'auto' : p.low_stock_threshold !== null ? 'fast' : 'standard'}</span></td>
                  <td data-label="Leveringstid" class="right num">${r.leadDays} d.</td>
                  <td data-label="Bestil hjem">${reorderWhen(r, args.now)}</td>
                  <td data-label="Foreslået antal" class="right num">${r.urgency === 'ok' ? html`<span class="muted">${r.suggestQty}</span>` : html`<strong>${r.suggestQty}</strong>`}</td>
                </tr>`,
              )}
            </tbody></table></div>`
        : html`<p class="empty">Ingen varer med lagerstyring endnu.</p>`}
    </div>
    <p class="xs muted">Beregning: sikkerhedslager = z × standardafvigelsen på dagligt salg × √leveringstid. Genbestillingspunkt = gennemsnitligt salg pr. dag × leveringstid + sikkerhedslager.
      Foreslået antal dækker leveringstiden og 30 dages salg oven i sikkerhedslageret. Varer skal have mindst ${MIN_HISTORY_DAYS} dages historik, før der beregnes automatisk.</p>
  </div>`;
}

// ---------------- Ordrer ----------------

export function ordersPage(args: {
  orders: OrderListRow[];
  counts: Record<OrderStatus, number>;
  status: OrderStatus | null;
  q: string;
  page: number;
  hasMore: boolean;
}): H {
  const total = Object.values(args.counts).reduce((a, b) => a + b, 0);
  const qs = (extra: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    if (args.status) p.set('status', args.status);
    if (args.q) p.set('q', args.q);
    for (const [k, v] of Object.entries(extra)) v === null ? p.delete(k) : p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  return html`<div class="stack-lg">
    <div class="page-head"><h1>Ordrer</h1><a class="btn btn-primary" href="/admin/ordrer/ny">+ Ny ordre</a></div>
    <nav class="tabs" aria-label="Filtrér efter status">
      <a href="/admin/ordrer${args.q ? `?q=${encodeURIComponent(args.q)}` : ''}"${!args.status ? html` aria-current="page"` : ''}>Alle <span class="c">${total}</span></a>
      ${STATUSES.map(
        (s) => html`<a href="/admin/ordrer?status=${s}${args.q ? `&q=${encodeURIComponent(args.q)}` : ''}"${args.status === s ? html` aria-current="page"` : ''}>${STATUS_LABEL[s]} <span class="c">${args.counts[s]}</span></a>`,
      )}
    </nav>
    <form class="toolbar" method="get" action="/admin/ordrer" role="search">
      ${args.status ? html`<input type="hidden" name="status" value="${args.status}">` : ''}
      <label class="sr-only" for="q">Søg</label>
      <input id="q" type="search" name="q" value="${args.q}" placeholder="Ordrenummer, navn, e-mail, firma eller telefon">
      <button class="btn btn-secondary" type="submit">Søg</button>
    </form>
    <div class="card card-flush">
      ${args.orders.length
        ? html`<div class="table-wrap"><table class="list stackable">
            <thead><tr><th>Ordre</th><th>Kunde</th><th>Dato</th><th>Kilde</th><th>Levering</th><th>Status</th><th class="right">Beløb</th></tr></thead>
            <tbody>
              ${args.orders.map(
                (o) => html`<tr class="row-link" data-href="/admin/ordrer/${o.id}">
                  <td class="cell-main"><a class="title" href="/admin/ordrer/${o.id}">#${o.number}</a> <span class="xs muted">${o.item_count} stk.</span></td>
                  <td data-label="Kunde">${o.customer_name}${o.company ? html`<div class="xs muted">${o.company}</div>` : ''}</td>
                  <td data-label="Dato" class="nowrap">${formatDateTime(o.created_at)}</td>
                  <td data-label="Kilde">${SOURCE_LABEL[o.source]}</td>
                  <td data-label="Levering">${o.delivery === 'levering' ? 'Levering' : 'Afhentning'}</td>
                  <td>${statusTag(o.status)}</td>
                  <td data-label="Beløb" class="right num nowrap">${formatKr(o.total)}</td>
                </tr>`,
              )}
            </tbody></table></div>`
        : html`<p class="empty">${args.q ? 'Ingen ordrer matcher søgningen.' : 'Ingen ordrer her endnu.'}</p>`}
    </div>
    ${args.page > 1 || args.hasMore
      ? html`<nav class="pager" aria-label="Sider">
          ${args.page > 1 ? html`<a class="btn btn-secondary btn-small" href="/admin/ordrer${qs({ side: args.page - 1 })}">← Nyere</a>` : ''}
          ${args.hasMore ? html`<a class="btn btn-secondary btn-small" href="/admin/ordrer${qs({ side: args.page + 1 })}">Ældre →</a>` : ''}
        </nav>`
      : ''}
  </div>`;
}

export interface StaffOrderValues {
  source: Exclude<OrderSource, 'hjemmeside'>;
  customer_name: string;
  company: string;
  customer_phone: string;
  customer_email: string;
  delivery: 'afhentning' | 'levering';
  address: string;
  postcode: string;
  city: string;
  note: string;
  confirm: boolean;
  send_receipt: boolean;
}

export function newOrderPage(args: {
  csrf: string;
  settings: Settings;
  products: ProductWithReserved[];
  quantities: Map<number, number>;
  values: StaffOrderValues;
  errors?: Partial<Record<keyof StaffOrderValues | 'form' | 'lines', string>>;
  short?: H | null;
}): H {
  const v = args.values;
  const e = args.errors ?? {};
  const err = (k: keyof StaffOrderValues) => (e[k] ? html`<p class="hint" style="color:var(--err)" id="err-${k}">${e[k]}</p>` : '');
  const inv = (k: keyof StaffOrderValues) => (e[k] ? html` aria-invalid="true" aria-describedby="err-${k}"` : '');
  const src = (val: StaffOrderValues['source'], label: string, hint: string) =>
    html`<label class="radio-card"><input type="radio" name="source" value="${val}"${v.source === val ? ' checked' : ''}><span><strong>${label}</strong><span class="small muted">${hint}</span></span></label>`;
  return html`<form class="stack-lg sheet-form" method="post" action="/admin/ordrer/ny" novalidate>
    ${csrfField(args.csrf)}
    <div class="stack-sm">
      <a class="small" href="/admin/ordrer">← Ordrer</a>
      <h1>Ny ordre</h1>
      <p class="muted">Til ordrer, der kommer ind på telefon, e-mail eller ved direkte salg. De lander i samme ordreoversigt og lager som bestillinger fra hjemmesiden.</p>
    </div>
    ${e.form ? alert('err', e.form) : ''}
    ${args.short ?? ''}
    <section class="card stack-lg">
      <fieldset>
        <legend>Hvor kom ordren fra?</legend>
        <div class="radio-cards radio-cards-3">
          ${src('telefon', 'Telefon', 'Kunden ringede')}
          ${src('email', 'E-mail', 'Kunden skrev')}
          ${src('direkte', 'Direkte salg', 'I butikken eller på stedet')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Kunde</legend>
        <div class="fields fields-2">
          <div class="field"><label for="customer_name">Navn</label>
            <input id="customer_name" name="customer_name" value="${v.customer_name}" required maxlength="100" autocomplete="off"${inv('customer_name')}>${err('customer_name')}</div>
          <div class="field"><label for="company">Firma <span class="muted">(valgfrit)</span></label>
            <input id="company" name="company" value="${v.company}" maxlength="100" autocomplete="off"></div>
          <div class="field"><label for="customer_phone">Telefon <span class="muted">(valgfrit)</span></label>
            <input id="customer_phone" type="tel" name="customer_phone" value="${v.customer_phone}" maxlength="30" autocomplete="off"${inv('customer_phone')}>${err('customer_phone')}</div>
          <div class="field"><label for="customer_email">E-mail <span class="muted">(valgfrit)</span></label>
            <input id="customer_email" type="email" name="customer_email" value="${v.customer_email}" maxlength="254" autocomplete="off"${inv('customer_email')}>${err('customer_email')}</div>
        </div>
      </fieldset>
      <fieldset>
        <legend>Levering</legend>
        <div class="radio-cards">
          <label class="radio-card"><input type="radio" name="delivery" value="afhentning"${v.delivery === 'afhentning' ? ' checked' : ''}><span><strong>Afhentning</strong><span class="small muted">Kunden henter selv</span></span></label>
          <label class="radio-card"><input type="radio" name="delivery" value="levering"${v.delivery === 'levering' ? ' checked' : ''}><span><strong>Levering</strong><span class="small muted">Leveringspris efter butikkens indstillinger</span></span></label>
        </div>
        <div id="adresse" class="fields fields-3" style="margin-top:16px">
          <div class="field" style="grid-column:1/-1"><label for="address">Adresse</label>
            <input id="address" name="address" value="${v.address}" maxlength="150" autocomplete="off"${inv('address')}>${err('address')}</div>
          <div class="field"><label for="postcode">Postnummer</label>
            <input id="postcode" name="postcode" value="${v.postcode}" inputmode="numeric" maxlength="10" autocomplete="off"${inv('postcode')}>${err('postcode')}</div>
          <div class="field" style="grid-column:span 2"><label for="city">By</label>
            <input id="city" name="city" value="${v.city}" maxlength="80" autocomplete="off"${inv('city')}>${err('city')}</div>
        </div>
      </fieldset>
      <div class="field">
        <label for="note">Note på ordren <span class="muted">(valgfrit)</span></label>
        <textarea id="note" name="note" maxlength="1000" placeholder="Fx aftalt afhentningstidspunkt">${v.note}</textarea>
      </div>
      <div class="stack-sm">
        <label class="check"><input type="checkbox" name="confirm" value="1"${v.confirm ? ' checked' : ''}> <span>Bekræft ordren med det samme<span class="hint" style="display:block">Varerne trækkes fra lageret nu. Ellers lander ordren som ny og reserverer varerne, til den bekræftes.</span></span></label>
        <label class="check"><input type="checkbox" name="send_receipt" value="1"${v.send_receipt ? ' checked' : ''}> <span>Send ordrebekræftelse til kunden<span class="hint" style="display:block">Kun hvis der er udfyldt en e-mail.</span></span></label>
      </div>
    </section>
    <section class="stack">
      <div class="row-between">
        <h2>Varer</h2>
        <div class="toolbar grow" data-sheet-search style="max-width:420px">
          <label class="sr-only" for="q">Find vare</label>
          <input id="q" type="search" placeholder="Find vare eller varenummer" autocomplete="off">
        </div>
      </div>
      ${e.lines ? alert('warn', e.lines) : ''}
      ${args.products.length
        ? html`${orderSheet({ settings: args.settings, products: args.products, quantities: args.quantities, submitLabel: 'Opret ordre', staff: true })}`
        : alert('info', html`Der er ingen aktive varer endnu. <a href="/admin/import">Importér en vareliste</a> først.`)}
    </section>
  </form>`;
}

const ACTION_LABEL: Record<OrderStatus, string> = {
  ny: 'Genåbn som ny',
  bekraeftet: 'Bekræft ordre',
  klar: 'Marker som klar / afsendt',
  afsluttet: 'Marker som afsluttet',
  annulleret: 'Annullér ordre',
};

export function orderDetailPage(args: {
  csrf: string;
  order: OrderRow;
  lines: OrderLineRow[];
  events: OrderEventRow[];
  products: Map<number, ProductWithReserved>;
  flash?: H | '';
  error?: H | null;
}): H {
  const o = args.order;
  const next = TRANSITIONS[o.status];
  const primary = next.filter((s) => s !== 'annulleret' && s !== 'ny' && !(o.status === 'klar' && s === 'bekraeftet'));
  return html`<div class="stack-lg">
    <div class="stack-sm">
      <a class="small" href="/admin/ordrer">← Ordrer</a>
      <div class="row-between"><h1>Ordre #${o.number}</h1>${statusTag(o.status)}</div>
      <p class="muted small">${o.source === 'hjemmeside' ? 'Bestilt på hjemmesiden' : `Oprettet fra ${SOURCE_LABEL[o.source].toLowerCase()}`} ${formatDateTime(o.created_at)} · ${o.stock_deducted ? 'Lager er trukket' : 'Lager er ikke trukket endnu'}</p>
    </div>
    ${args.flash ?? ''}
    ${args.error ?? ''}
    <div class="layout-side">
      <div class="stack-lg">
        <section class="card card-flush">
          <div class="table-wrap"><table class="list stackable">
            <thead><tr><th>Vare</th><th class="right">Antal</th><th class="right">Pris</th><th class="right">I alt</th><th>Lager nu</th></tr></thead>
            <tbody>
              ${args.lines.map((l) => {
                const p = l.product_id ? args.products.get(l.product_id) : undefined;
                return html`<tr>
                  <td class="cell-main">${p ? html`<a class="title" href="/admin/varer/${p.id}">${l.name}</a>` : html`<strong>${l.name}</strong>`}<div class="xs muted">${l.sku}</div></td>
                  <td data-label="Antal" class="right num">${l.quantity} ${l.unit}</td>
                  <td data-label="Pris" class="right num nowrap">${formatKr(l.unit_price)}</td>
                  <td data-label="I alt" class="right num nowrap">${formatKr(l.line_total)}</td>
                  <td data-label="Lager nu">${!p ? html`<span class="muted xs">Slettet</span>` : !p.track_stock ? html`<span class="muted xs">–</span>` : html`<span class="num${!o.stock_deducted && p.stock < l.quantity ? ' tag tag-out' : ''}">${p.stock}</span>`}</td>
                </tr>`;
              })}
            </tbody>
          </table></div>
          <div style="padding:16px 20px;border-top:1px solid var(--line)">
            <table class="totals">
              <tr><td>Varer</td><td>${formatKr(o.subtotal)}</td></tr>
              ${o.delivery === 'levering' ? html`<tr><td>Levering</td><td>${o.delivery_fee ? formatKr(o.delivery_fee) : 'Gratis'}</td></tr>` : ''}
              <tr class="total"><td>I alt inkl. moms</td><td>${formatKr(o.total)}</td></tr>
            </table>
          </div>
        </section>
        <section class="card stack">
          <h2>Kunde</h2>
          <dl class="kv">
            <dt>Navn</dt><dd>${o.customer_name}</dd>
            ${o.company ? html`<dt>Firma</dt><dd>${o.company}</dd>` : ''}
            ${o.customer_email ? html`<dt>E-mail</dt><dd><a href="mailto:${o.customer_email}">${o.customer_email}</a></dd>` : ''}
            ${o.customer_phone ? html`<dt>Telefon</dt><dd><a href="tel:${o.customer_phone.replace(/[^\d+]/g, '')}">${o.customer_phone}</a></dd>` : ''}
            <dt>Kilde</dt><dd>${SOURCE_LABEL[o.source]}</dd>
            <dt>${o.delivery === 'levering' ? 'Levering' : 'Afhentning'}</dt>
            <dd>${o.delivery === 'levering' ? html`${o.address}<br>${o.postcode} ${o.city}` : 'Kunden henter selv'}</dd>
            ${o.note ? html`<dt>Besked</dt><dd style="white-space:pre-wrap">${o.note}</dd>` : ''}
          </dl>
        </section>
        <section class="card stack">
          <h2>Historik</h2>
          <ol class="timeline">
            ${args.events.map((e) => html`<li><strong>${e.message}</strong><div class="xs muted">${formatDateTime(e.created_at)} · ${e.actor}</div></li>`)}
          </ol>
        </section>
      </div>
      <aside class="side side-first stack">
        <section class="card stack">
          <h2>Næste skridt</h2>
          ${!next.length ? html`<p class="muted small">Ordren er ${STATUS_LABEL[o.status].toLowerCase()} og kan ikke ændres.</p>` : ''}
          ${primary.map(
            (s, i) => html`<form method="post" action="/admin/ordrer/${o.id}/status">
              ${csrfField(args.csrf)}<input type="hidden" name="status" value="${s}">
              <button class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'} btn-block" type="submit">${ACTION_LABEL[s]}</button>
            </form>`,
          )}
          ${o.status === 'klar' ? html`<form method="post" action="/admin/ordrer/${o.id}/status">${csrfField(args.csrf)}<input type="hidden" name="status" value="bekraeftet"><button class="btn btn-ghost btn-block" type="submit">Tilbage til bekræftet</button></form>` : ''}
          ${next.includes('ny') ? html`<form method="post" action="/admin/ordrer/${o.id}/status">${csrfField(args.csrf)}<input type="hidden" name="status" value="ny"><button class="btn btn-secondary btn-block" type="submit">${ACTION_LABEL.ny}</button></form>` : ''}
          ${next.includes('annulleret')
            ? html`<form method="post" action="/admin/ordrer/${o.id}/status" data-confirm="Annullér ordre #${o.number}?${o.stock_deducted ? ' Varerne lægges tilbage på lager.' : ''}">
                ${csrfField(args.csrf)}<input type="hidden" name="status" value="annulleret">
                <button class="btn btn-danger btn-block" type="submit">${ACTION_LABEL.annulleret}</button>
              </form>`
            : ''}
          ${o.status === 'ny' ? html`<p class="xs muted">Når ordren bekræftes, trækkes varerne fra lageret. Kunden får besked på e-mail.</p>` : ''}
        </section>
        <form class="card stack" method="post" action="/admin/ordrer/${o.id}/note">
          ${csrfField(args.csrf)}
          <label for="internal_note">Intern note</label>
          <textarea id="internal_note" name="internal_note" maxlength="2000" placeholder="Kun synlig for medarbejdere">${o.internal_note}</textarea>
          <button class="btn btn-secondary" type="submit">Gem note</button>
        </form>
      </aside>
    </div>
  </div>`;
}

// ---------------- Varer ----------------

export function productsPage(args: {
  settings: Settings;
  products: ProductWithReserved[];
  categories: string[];
  q: string;
  category: string | null;
  low: boolean;
  flash?: H | '';
}): H {
  return html`<div class="stack-lg">
    <div class="row-between">
      <h1>Varer og lager</h1>
      <div class="row">
        <a class="btn btn-secondary" href="/admin/varer/eksport.csv">Eksportér CSV</a>
        <a class="btn btn-primary" href="/admin/varer/ny">Ny vare</a>
      </div>
    </div>
    ${args.flash ?? ''}
    <form class="toolbar" method="get" action="/admin/varer" role="search">
      <label class="sr-only" for="q">Søg</label>
      <input id="q" type="search" name="q" value="${args.q}" placeholder="Søg på navn, varenummer eller kategori">
      ${args.categories.length
        ? html`<label class="sr-only" for="kategori">Kategori</label>
          <select id="kategori" name="kategori" data-autosubmit>
            <option value="">Alle kategorier</option>
            ${args.categories.map((c) => html`<option${args.category === c ? ' selected' : ''}>${c}</option>`)}
          </select>`
        : ''}
      <label class="check" style="margin:0"><input type="checkbox" name="lav" value="1"${args.low ? ' checked' : ''} data-autosubmit> Kun lavt lager</label>
      <button class="btn btn-secondary" type="submit">Filtrér</button>
    </form>
    <div class="card card-flush">
      ${args.products.length
        ? html`<div class="table-wrap"><table class="list stackable">
            <thead><tr><th>Vare</th><th>Kategori</th><th class="right">Pris</th><th>Lager</th><th class="right">Reserveret</th><th>Synlig</th></tr></thead>
            <tbody>
              ${args.products.map(
                (p) => html`<tr class="row-link" data-href="/admin/varer/${p.id}">
                  <td class="cell-main"><a class="title" href="/admin/varer/${p.id}">${p.name}</a><div class="xs muted">${p.sku}</div></td>
                  <td data-label="Kategori">${p.category || html`<span class="muted">–</span>`}</td>
                  <td data-label="Pris" class="right num nowrap">${formatKr(p.price)} <span class="xs muted">/ ${p.unit}</span></td>
                  <td>${stockCell(p, args.settings)}</td>
                  <td data-label="Reserveret" class="right num">${p.track_stock && p.reserved ? p.reserved : html`<span class="muted">–</span>`}</td>
                  <td>${p.active ? html`<span class="tag tag-ok">Ja</span>` : html`<span class="tag tag-off">Skjult</span>`}</td>
                </tr>`,
              )}
            </tbody></table></div>`
        : html`<p class="empty">${args.q || args.category || args.low ? 'Ingen varer matcher filteret.' : html`Ingen varer endnu. <a href="/admin/import">Importér en vareliste</a>.`}</p>`}
    </div>
    <p class="xs muted">${args.products.length} varer. Reserveret = bestilt i nye ordrer, der endnu ikke er bekræftet (trækkes først fra lageret ved bekræftelse).</p>
  </div>`;
}

export interface ProductFormValues {
  sku: string;
  name: string;
  category: string;
  description: string;
  unit: string;
  price: string;
  image_url: string;
  track_stock: boolean;
  stock: string;
  low_stock_threshold: string;
  lead_time_days: string;
  active: boolean;
  sort_order: string;
}

export function productValues(p?: ProductRow): ProductFormValues {
  return {
    sku: p?.sku ?? '',
    name: p?.name ?? '',
    category: p?.category ?? '',
    description: p?.description ?? '',
    unit: p?.unit ?? 'stk.',
    price: p ? oereToInput(p.price) : '',
    image_url: p?.image_url ?? '',
    track_stock: p ? p.track_stock === 1 : true,
    stock: p ? String(p.stock) : '0',
    low_stock_threshold: p?.low_stock_threshold === null || p?.low_stock_threshold === undefined ? '' : String(p.low_stock_threshold),
    lead_time_days: p?.lead_time_days === null || p?.lead_time_days === undefined ? '' : String(p.lead_time_days),
    active: p ? p.active === 1 : true,
    sort_order: p ? String(p.sort_order) : '0',
  };
}

function productFields(v: ProductFormValues, settings: Settings, categories: string[], isNew: boolean, errors: Partial<Record<keyof ProductFormValues, string>>): H {
  const err = (k: keyof ProductFormValues) => (errors[k] ? html`<p class="hint" style="color:var(--err)" id="err-${k}">${errors[k]}</p>` : '');
  const inv = (k: keyof ProductFormValues) => (errors[k] ? html` aria-invalid="true" aria-describedby="err-${k}"` : '');
  return html`<div class="fields fields-2">
      <div class="field"><label for="name">Navn</label><input id="name" name="name" value="${v.name}" required maxlength="200"${inv('name')}>${err('name')}</div>
      <div class="field"><label for="sku">Varenummer (SKU)</label><input id="sku" name="sku" value="${v.sku}" required maxlength="64"${inv('sku')}>${err('sku')}</div>
      <div class="field"><label for="price">Pris inkl. moms (kr.)</label><input id="price" name="price" value="${v.price}" inputmode="decimal" required placeholder="149,95"${inv('price')}>${err('price')}</div>
      <div class="field"><label for="unit">Enhed</label><input id="unit" name="unit" value="${v.unit}" maxlength="20" placeholder="stk., kg, kasse, time"></div>
      <div class="field"><label for="category">Kategori</label><input id="category" name="category" value="${v.category}" maxlength="80" list="kategorier">
        <datalist id="kategorier">${categories.map((c) => html`<option value="${c}"></option>`)}</datalist></div>
      <div class="field"><label for="sort_order">Sortering</label><input id="sort_order" name="sort_order" value="${v.sort_order}" inputmode="numeric"${inv('sort_order')}>
        <p class="hint">Lavere tal vises først i kategorien.</p>${err('sort_order')}</div>
      <div class="field" style="grid-column:1/-1"><label for="description">Beskrivelse</label><textarea id="description" name="description" maxlength="2000">${v.description}</textarea></div>
      <div class="field" style="grid-column:1/-1"><label for="image_url">Billede (link)</label><input id="image_url" type="url" name="image_url" value="${v.image_url}" maxlength="500" placeholder="https://"${inv('image_url')}>${err('image_url')}</div>
    </div>
    <fieldset class="stack">
      <legend>Lager</legend>
      <label class="check"><input type="checkbox" name="track_stock" value="1"${v.track_stock ? ' checked' : ''}> <span>Følg lager for denne vare<span class="hint" style="display:block">Slå fra for ydelser eller varer, der altid kan bestilles.</span></span></label>
      <div class="fields fields-2">
        ${isNew ? html`<div class="field"><label for="stock">Antal på lager</label><input id="stock" name="stock" value="${v.stock}" inputmode="numeric"${inv('stock')}>${err('stock')}</div>` : ''}
        <div class="field"><label for="low_stock_threshold">Genbestillingspunkt</label><input id="low_stock_threshold" name="low_stock_threshold" value="${v.low_stock_threshold}" inputmode="numeric" placeholder="Automatisk"${inv('low_stock_threshold')}>
          <p class="hint">Lad feltet stå tomt, så beregnes det ud fra salget. Skriv et tal for at bruge et fast minimum.</p>${err('low_stock_threshold')}</div>
        <div class="field"><label for="lead_time_days">Leveringstid fra leverandør (dage)</label><input id="lead_time_days" name="lead_time_days" value="${v.lead_time_days}" inputmode="numeric" placeholder="Standard: ${settings.lead_time_days}"${inv('lead_time_days')}>
          <p class="hint">Bruges til at beregne, hvornår varen skal bestilles hjem.</p>${err('lead_time_days')}</div>
      </div>
    </fieldset>
    <label class="check"><input type="checkbox" name="active" value="1"${v.active ? ' checked' : ''}> <span>Vis varen i webshoppen</span></label>`;
}

export function productNewPage(args: { csrf: string; settings: Settings; categories: string[]; values: ProductFormValues; errors?: Partial<Record<keyof ProductFormValues, string>> }): H {
  return html`<div class="stack-lg" style="max-width:820px">
    <div class="stack-sm"><a class="small" href="/admin/varer">← Varer</a><h1>Ny vare</h1></div>
    ${args.errors && Object.keys(args.errors).length ? alert('err', 'Ret de markerede felter.') : ''}
    <form class="card stack-lg" method="post" action="/admin/varer">
      ${csrfField(args.csrf)}
      ${productFields(args.values, args.settings, args.categories, true, args.errors ?? {})}
      <div class="row"><button class="btn btn-primary" type="submit">Opret vare</button><a href="/admin/varer">Annullér</a></div>
    </form>
  </div>`;
}

function reorderCard(p: ProductWithReserved, s: Settings): H {
  const r = reorderInfo(p, s);
  const now = Math.floor(Date.now() / 1000);
  return html`<section class="card stack">
    <div class="row-between"><h2>Genbestilling</h2>${reorderWhen(r, now)}</div>
    <dl class="kv">
      <dt>Disponibel</dt><dd class="num">${r.available}</dd>
      <dt>Salg pr. dag</dt><dd class="num">${r.avgDaily === null ? 'Intet salg endnu' : dec(r.avgDaily)}</dd>
      <dt>Sikkerhedslager</dt><dd class="num">${r.safety ?? '–'}</dd>
      <dt>Genbestillingspunkt</dt><dd class="num">${r.limit} <span class="xs muted">${r.automatic ? '(beregnet ud fra salget)' : p.low_stock_threshold !== null ? '(fast minimum)' : '(standard, for lidt salgsdata)'}</span></dd>
      <dt>Leveringstid</dt><dd>${r.leadDays} dage</dd>
      ${r.daysToEmpty !== null ? html`<dt>Tomt om</dt><dd>ca. ${r.daysToEmpty} dage</dd>` : ''}
      <dt>Foreslået antal</dt><dd class="num">${r.suggestQty}</dd>
    </dl>
  </section>`;
}

export function productEditPage(args: {
  csrf: string;
  settings: Settings;
  product: ProductWithReserved;
  categories: string[];
  values: ProductFormValues;
  movements: MovementWithProduct[];
  errors?: Partial<Record<keyof ProductFormValues, string>>;
  stockError?: string | null;
  flash?: H | '';
}): H {
  const p = args.product;
  const img = safeUrl(p.image_url);
  return html`<div class="stack-lg">
    <div class="stack-sm"><a class="small" href="/admin/varer">← Varer</a>
      <div class="row-between"><h1>${p.name}</h1>${stockCell(p, args.settings)}</div>
      <p class="muted small">${p.sku}${p.active ? '' : ' · Skjult i webshoppen'}</p></div>
    ${args.flash ?? ''}
    ${args.errors && Object.keys(args.errors).length ? alert('err', 'Ret de markerede felter.') : ''}
    <div class="layout-side">
      <form class="card stack-lg" method="post" action="/admin/varer/${p.id}">
        ${csrfField(args.csrf)}
        ${img ? html`<img src="${img}" alt="" style="max-height:180px;border-radius:8px" referrerpolicy="no-referrer">` : ''}
        ${productFields(args.values, args.settings, args.categories, false, args.errors ?? {})}
        <div class="row-between">
          <button class="btn btn-primary" type="submit">Gem ændringer</button>
        </div>
      </form>
      <aside class="side stack">
        ${p.track_stock
          ? html`<form class="card stack" method="post" action="/admin/varer/${p.id}/lager">
              ${csrfField(args.csrf)}
              <h2>Reguler lager</h2>
              <p class="small muted">På lager: <strong class="num">${p.stock}</strong>${p.reserved ? html` · reserveret i nye ordrer: <strong class="num">${p.reserved}</strong>` : ''}</p>
              ${args.stockError ? alert('err', args.stockError) : ''}
              <div class="radio-cards" style="grid-template-columns:1fr 1fr">
                <label class="radio-card"><input type="radio" name="mode" value="add" checked><span><strong>Læg til / træk fra</strong><span class="xs muted">Fx 10 eller -3</span></span></label>
                <label class="radio-card"><input type="radio" name="mode" value="set"><span><strong>Sæt til</strong><span class="xs muted">Efter optælling</span></span></label>
              </div>
              <div class="field"><label for="value">Antal</label><input id="value" name="value" inputmode="numeric" required placeholder="0"></div>
              <div class="field"><label for="reason">Årsag</label>
                <input id="reason" name="reason" list="aarsager" maxlength="120" placeholder="Fx varemodtagelse">
                <datalist id="aarsager"><option value="Varemodtagelse"></option><option value="Optælling"></option><option value="Svind / beskadiget"></option><option value="Retur fra kunde"></option><option value="Eget forbrug"></option></datalist></div>
              <button class="btn btn-primary btn-block" type="submit">Opdater lager</button>
            </form>`
          : html`<div class="card"><p class="small muted">Lageret følges ikke for denne vare.</p></div>`}
        ${p.track_stock ? reorderCard(p, args.settings) : ''}
        <section class="card card-flush">
          <div style="padding:16px 20px"><h2>Lagerhistorik</h2></div>
          ${movementsTable(args.movements, false)}
        </section>
        <form class="card stack" method="post" action="/admin/varer/${p.id}/slet" data-confirm="Slet ${p.name} permanent? Ordrer med varen bevares.">
          ${csrfField(args.csrf)}
          <p class="small muted">Vil du blot fjerne varen fra webshoppen, så fjern fluebenet ved "Vis varen i webshoppen".</p>
          <button class="btn btn-danger" type="submit">Slet vare</button>
        </form>
      </aside>
    </div>
  </div>`;
}

function movementsTable(rows: MovementWithProduct[], withProduct: boolean): H {
  if (!rows.length) return html`<p class="muted small" style="padding:0 20px 20px">Ingen ændringer endnu.</p>`;
  return html`<div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Tidspunkt</th>${withProduct ? html`<th>Vare</th>` : ''}<th class="right">Ændring</th><th class="right">Lager efter</th>${withProduct ? html`<th>Årsag</th><th>Af</th>` : ''}</tr></thead>
    <tbody>${rows.map(
      (m) => html`<tr>
        <td class="nowrap${withProduct ? '' : ' cell-main'}"><span class="small">${formatDateTime(m.created_at)}</span>${withProduct
          ? ''
          : html`<div class="xs">${m.order_id ? html`<a href="/admin/ordrer/${m.order_id}">${m.reason}</a>` : m.reason}</div><div class="xs muted">${m.actor}</div>`}</td>
        ${withProduct ? html`<td class="cell-main"><a class="title" href="/admin/varer/${m.product_id}">${m.name}</a><div class="xs muted">${m.sku}</div></td>` : ''}
        <td data-label="Ændring" class="right num" style="font-weight:600;color:${m.change < 0 ? 'var(--err)' : 'var(--ok)'}">${m.change > 0 ? '+' : ''}${m.change}</td>
        <td data-label="Lager efter" class="right num">${m.stock_after}</td>
        ${withProduct
          ? html`<td data-label="Årsag">${m.order_id ? html`<a href="/admin/ordrer/${m.order_id}">${m.reason}</a>` : m.reason}</td>
              <td data-label="Af" class="xs muted">${m.actor}</td>`
          : ''}
      </tr>`,
    )}</tbody></table></div>`;
}

export function historyPage(args: { movements: MovementWithProduct[]; page: number; hasMore: boolean }): H {
  return html`<div class="stack-lg">
    <div class="stack-sm"><h1>Lagerhistorik</h1><p class="muted">Alle ændringer af lagertal: ordrer, annulleringer, manuelle reguleringer og import.</p></div>
    <div class="card card-flush">${movementsTable(args.movements, true)}</div>
    ${args.page > 1 || args.hasMore
      ? html`<nav class="pager" aria-label="Sider">
          ${args.page > 1 ? html`<a class="btn btn-secondary btn-small" href="/admin/historik?side=${args.page - 1}">← Nyere</a>` : ''}
          ${args.hasMore ? html`<a class="btn btn-secondary btn-small" href="/admin/historik?side=${args.page + 1}">Ældre →</a>` : ''}
        </nav>`
      : ''}
  </div>`;
}

// ---------------- Import ----------------

export function importPage(args: { csrf: string; error?: string | null; result?: { created: number; updated: number } | null }): H {
  return html`<div class="stack-lg" style="max-width:820px">
    <div class="stack-sm"><h1>Importér vareliste</h1>
      <p class="muted">Upload en CSV-fil fra Excel, Google Sheets eller jeres kasse-/lagersystem. Varer med et varenummer, der findes i forvejen, bliver opdateret. Nye varenumre bliver oprettet. Du ser en forhåndsvisning, før noget gemmes.</p></div>
    ${args.result ? alert('ok', `Importen er gennemført: ${args.result.created} nye og ${args.result.updated} opdaterede varer.`) : ''}
    ${args.error ? alert('err', args.error) : ''}
    <form class="card stack-lg" method="post" action="/admin/import" enctype="multipart/form-data">
      ${csrfField(args.csrf)}
      <div class="field"><label for="file">CSV-fil</label><input id="file" type="file" name="file" accept=".csv,.txt,text/csv">
        <p class="hint">I Excel: Filer › Gem som › "CSV UTF-8 (kommasepareret)".</p></div>
      <details>
        <summary class="small">Eller indsæt tekst direkte</summary>
        <div class="field" style="margin-top:12px"><label for="text">CSV-tekst</label><textarea id="text" name="text" rows="8" placeholder="Varenummer;Navn;Kategori;Pris;Lager"></textarea></div>
      </details>
      <button class="btn btn-primary" type="submit">Vis forhåndsvisning</button>
    </form>
    <section class="card stack">
      <h2>Kolonner</h2>
      <p class="small">Første række skal være kolonnenavne. Kun <strong>Varenummer</strong> er påkrævet; nye varer skal også have <strong>Navn</strong> og <strong>Pris</strong>. Kolonner, der ikke er med i filen, bliver ikke ændret.</p>
      <div class="table-wrap"><table class="list small">
        <thead><tr><th>Kolonne</th><th>Indhold</th><th>Andre navne der virker</th></tr></thead>
        <tbody>
          <tr><td><strong>Varenummer</strong></td><td>Unikt nummer (SKU)</td><td class="muted">SKU, Varenr, Artikelnummer</td></tr>
          <tr><td><strong>Navn</strong></td><td>Varens navn</td><td class="muted">Varenavn, Produkt, Titel</td></tr>
          <tr><td>Kategori</td><td>Gruppering i webshoppen</td><td class="muted">Varegruppe, Gruppe</td></tr>
          <tr><td><strong>Pris</strong></td><td>Inkl. moms, fx 149,95</td><td class="muted">Salgspris, Enhedspris</td></tr>
          <tr><td>Lager</td><td>Antal på lager (sætter lagertallet)</td><td class="muted">Antal, Beholdning</td></tr>
          <tr><td>Enhed</td><td>stk., kg, kasse, time …</td><td></td></tr>
          <tr><td>Beskrivelse</td><td>Tekst til kunden</td><td class="muted">Tekst</td></tr>
          <tr><td>Billede</td><td>Link (https://) til et billede</td><td class="muted">Billede URL</td></tr>
          <tr><td>Minimum</td><td>Advar ved lavt lager</td><td class="muted">Minimumslager, Genbestillingspunkt</td></tr>
          <tr><td>Aktiv</td><td>ja/nej: vis i webshoppen</td><td class="muted">Synlig, Vis</td></tr>
          <tr><td>Lagerstyring</td><td>ja/nej: følg lager</td><td></td></tr>
          <tr><td>Sortering</td><td>Rækkefølge i kategorien</td><td class="muted">Rækkefølge</td></tr>
        </tbody>
      </table></div>
      <div class="row"><a class="btn btn-secondary btn-small" href="/admin/import/skabelon.csv">Hent skabelon (CSV)</a><a class="btn btn-ghost btn-small" href="/admin/varer/eksport.csv">Eksportér nuværende varer</a></div>
    </section>
  </div>`;
}

function changeCell(r: PlannedRow, f: Field): H {
  const ex = r.existing;
  const fmt = (k: Field, v: unknown): string => {
    if (v === undefined) return '';
    if (k === 'price') return formatKr(v as number);
    if (k === 'active' || k === 'track_stock') return v === true || v === 1 ? 'ja' : 'nej';
    if (v === null) return '–';
    return String(v);
  };
  const nv = r[f as keyof PlannedRow];
  if (nv === undefined) return html`<span class="muted">${ex ? fmt(f, ex[f as keyof ProductRow]) : ''}</span>`;
  const old = ex ? fmt(f, ex[f as keyof ProductRow]) : null;
  const neu = fmt(f, nv);
  if (old !== null && old !== neu) return html`<span class="muted" style="text-decoration:line-through">${old}</span> <strong>${neu}</strong>`;
  return html`${neu}`;
}

export function importPreviewPage(args: { csrf: string; text: string; planned: PlannedRow[]; errors: ImportError[]; columns: Field[]; unknownColumns: string[] }): H {
  const n = (a: PlannedRow['action']) => args.planned.filter((r) => r.action === a).length;
  const show = args.planned.filter((r) => r.action !== 'uændret').slice(0, 200);
  const cols = args.columns.filter((c) => c !== 'sku' && c !== 'description');
  const todo = n('opret') + n('opdater');
  return html`<div class="stack-lg">
    <div class="stack-sm"><a class="small" href="/admin/import">← Import</a><h1>Forhåndsvisning</h1></div>
    <div class="grid grid-4">
      <div class="card stat"><div class="n">${n('opret')}</div><div class="l">Nye varer</div></div>
      <div class="card stat"><div class="n">${n('opdater')}</div><div class="l">Opdateres</div></div>
      <div class="card stat"><div class="n">${n('uændret')}</div><div class="l">Uændrede</div></div>
      <div class="card stat"><div class="n" style="${args.errors.length ? 'color:var(--err)' : ''}">${args.errors.length}</div><div class="l">Linjer med fejl</div></div>
    </div>
    <p class="small muted">Genkendte kolonner: ${args.columns.map((c) => FIELD_LABEL[c]).join(', ')}.${args.unknownColumns.length ? ` Ignoreres: ${args.unknownColumns.join(', ')}.` : ''}</p>
    ${args.errors.length
      ? alert('warn', html`<strong>Disse linjer springes over:</strong><ul>${args.errors.slice(0, 50).map((e) => html`<li>Linje ${e.line}: ${e.message}</li>`)}</ul>${args.errors.length > 50 ? html`<p>… og ${args.errors.length - 50} mere.</p>` : ''}`)
      : ''}
    ${show.length
      ? html`<div class="card card-flush"><div class="table-wrap"><table class="list small">
          <thead><tr><th></th><th>Varenummer</th>${cols.map((c) => html`<th>${FIELD_LABEL[c]}</th>`)}</tr></thead>
          <tbody>${show.map(
            (r) => html`<tr>
              <td>${r.action === 'opret' ? html`<span class="tag tag-ny">Ny</span>` : html`<span class="tag tag-klar">Ændres</span>`}</td>
              <td class="nowrap"><strong>${r.sku}</strong></td>
              ${cols.map((c) => html`<td>${changeCell(r, c)}</td>`)}
            </tr>`,
          )}</tbody></table></div></div>
          ${todo > show.length ? html`<p class="small muted">Viser de første ${show.length} af ${todo} ændringer.</p>` : ''}`
      : ''}
    ${todo
      ? html`<form class="row" method="post" action="/admin/import/udfoer">
          ${csrfField(args.csrf)}
          <textarea name="text" class="hidden" aria-hidden="true" tabindex="-1">${args.text}</textarea>
          <button class="btn btn-primary" type="submit">Importér ${todo} varer</button>
          <a href="/admin/import">Annullér</a>
        </form>`
      : alert('info', html`Der er intet at importere. <a href="/admin/import">Prøv en anden fil</a>.`)}
  </div>`;
}

// ---------------- Indstillinger ----------------

export function settingsPage(args: { csrf: string; s: Settings; errors?: Record<string, string>; flash?: H | '' }): H {
  const s = args.s;
  const e = args.errors ?? {};
  const err = (k: string) => (e[k] ? html`<p class="hint" style="color:var(--err)">${e[k]}</p>` : '');
  const kr = (v: number) => (v ? oereToInput(v) : '0');
  return html`<div class="stack-lg" style="max-width:820px">
    <h1>Indstillinger</h1>
    ${args.flash ?? ''}
    ${Object.keys(e).length ? alert('err', 'Ret de markerede felter.') : ''}
    <form class="stack-lg" method="post" action="/admin/indstillinger">
      ${csrfField(args.csrf)}
      <section class="card stack-lg">
        <h2>Butik</h2>
        <div class="fields fields-2">
          <div class="field"><label for="shop_name">Butikkens navn</label><input id="shop_name" name="shop_name" value="${s.shop_name}" required maxlength="80">${err('shop_name')}</div>
          <div class="field"><label for="tagline">Overskrift i webshoppen</label><input id="tagline" name="tagline" value="${s.tagline}" maxlength="120"></div>
          <div class="field" style="grid-column:1/-1"><label for="intro">Tekst under overskriften</label><textarea id="intro" name="intro" maxlength="1000" placeholder="Fx åbningstider, leveringstid eller hvordan man bestiller">${s.intro}</textarea></div>
          <div class="field"><label for="accent_color">Farve</label><div class="row"><input id="accent_color" type="color" name="accent_color" value="${s.accent_color}"><span class="small muted">Knapper og fremhævninger</span></div>${err('accent_color')}</div>
          <div class="field"><label for="website_url">Link til hjemmesiden</label><input id="website_url" type="url" name="website_url" value="${s.website_url}" placeholder="https://">${err('website_url')}</div>
        </div>
      </section>
      <section class="card stack-lg">
        <h2>Kontakt</h2>
        <div class="fields fields-2">
          <div class="field"><label for="contact_email">E-mail</label><input id="contact_email" type="email" name="contact_email" value="${s.contact_email}">${err('contact_email')}<p class="hint">Vises for kunderne og bruges som svar-adresse.</p></div>
          <div class="field"><label for="contact_phone">Telefon</label><input id="contact_phone" type="tel" name="contact_phone" value="${s.contact_phone}" maxlength="30"></div>
          <div class="field"><label for="address">Adresse (afhentning)</label><input id="address" name="address" value="${s.address}" maxlength="150"></div>
          <div class="field"><label for="notify_email">Send nye ordrer til</label><input id="notify_email" type="email" name="notify_email" value="${s.notify_email}" placeholder="Samme som e-mail">${err('notify_email')}</div>
        </div>
      </section>
      <section class="card stack-lg">
        <h2>Levering og afhentning</h2>
        <label class="check"><input type="checkbox" name="pickup_enabled" value="1"${s.pickup_enabled ? ' checked' : ''}> <span>Kunden kan hente bestillingen</span></label>
        <div class="field"><label for="pickup_info">Info om afhentning</label><input id="pickup_info" name="pickup_info" value="${s.pickup_info}" maxlength="300"></div>
        <label class="check"><input type="checkbox" name="delivery_enabled" value="1"${s.delivery_enabled ? ' checked' : ''}> <span>Vi leverer til kundens adresse</span></label>
        ${err('delivery')}
        <div class="fields fields-3">
          <div class="field"><label for="delivery_fee">Leveringsgebyr (kr.)</label><input id="delivery_fee" name="delivery_fee" value="${kr(s.delivery_fee)}" inputmode="decimal">${err('delivery_fee')}</div>
          <div class="field"><label for="free_delivery_from">Gratis levering fra (kr.)</label><input id="free_delivery_from" name="free_delivery_from" value="${kr(s.free_delivery_from)}" inputmode="decimal">${err('free_delivery_from')}<p class="hint">0 = aldrig gratis</p></div>
          <div class="field"><label for="min_order">Mindste ordre (kr.)</label><input id="min_order" name="min_order" value="${kr(s.min_order)}" inputmode="decimal">${err('min_order')}<p class="hint">0 = ingen grænse</p></div>
        </div>
        <div class="field"><label for="delivery_info">Info om levering</label><input id="delivery_info" name="delivery_info" value="${s.delivery_info}" maxlength="300" placeholder="Fx levering inden for 2-3 hverdage"></div>
      </section>
      <section class="card stack-lg">
        <h2>Ordrer og lager</h2>
        <label class="check"><input type="checkbox" name="auto_confirm" value="1"${s.auto_confirm ? ' checked' : ''}> <span>Bekræft ordrer automatisk<span class="hint" style="display:block">Lageret trækkes, så snart kunden bestiller. Ellers bekræfter I selv hver ordre.</span></span></label>
        <label class="check"><input type="checkbox" name="show_stock_count" value="1"${s.show_stock_count ? ' checked' : ''}> <span>Vis antal på lager i webshoppen<span class="hint" style="display:block">Ellers vises blot "På lager", "Få på lager" eller "Udsolgt".</span></span></label>
        <div class="field" style="max-width:280px"><label for="low_stock_default">Standard for lavt lager</label><input id="low_stock_default" name="low_stock_default" value="${s.low_stock_default}" inputmode="numeric">${err('low_stock_default')}<p class="hint">Bruges for varer uden fast minimum og uden salgsdata nok til en beregning.</p></div>
      </section>
      <section class="card stack-lg" id="genbestilling">
        <div class="stack-sm">
          <h2>Genbestilling</h2>
          <p class="small muted">Sikkerhedslager og genbestillingspunkt beregnes automatisk ud fra jeres salg. Systemet varsler på e-mail, før en vare skal bestilles hjem.</p>
        </div>
        <div class="fields fields-2">
          <div class="field"><label for="lead_time_days">Leveringstid fra leverandør (dage)</label><input id="lead_time_days" name="lead_time_days" value="${s.lead_time_days}" inputmode="numeric">${err('lead_time_days')}<p class="hint">Standard for alle varer. Kan ændres pr. vare.</p></div>
          <div class="field"><label for="service_level">Sikkerhed mod udsolgt</label>
            <select id="service_level" name="service_level">${SERVICE_LEVELS.map((l) => html`<option value="${l}"${s.service_level === l ? ' selected' : ''}>${l} %</option>`)}</select>
            <p class="hint">Højere sikkerhed giver et større sikkerhedslager.</p></div>
          <div class="field"><label for="forecast_days">Beregn ud fra salget de seneste (dage)</label><input id="forecast_days" name="forecast_days" value="${s.forecast_days}" inputmode="numeric">${err('forecast_days')}</div>
          <div class="field"><label for="reorder_warn_days">Varsl så mange dage i forvejen</label><input id="reorder_warn_days" name="reorder_warn_days" value="${s.reorder_warn_days}" inputmode="numeric">${err('reorder_warn_days')}<p class="hint">Varslet sendes til e-mailen for nye ordrer.</p></div>
        </div>
      </section>
      <section class="card stack-lg">
        <h2>Juridisk</h2>
        <div class="fields fields-2">
          <div class="field"><label for="terms_url">Link til handelsbetingelser</label><input id="terms_url" type="url" name="terms_url" value="${s.terms_url}" placeholder="https://">${err('terms_url')}<p class="hint">Når feltet er udfyldt, skal kunden acceptere dem ved bestilling.</p></div>
          <div class="field"><label for="privacy_url">Link til privatlivspolitik</label><input id="privacy_url" type="url" name="privacy_url" value="${s.privacy_url}" placeholder="https://">${err('privacy_url')}</div>
        </div>
      </section>
      <button class="btn btn-primary" type="submit">Gem indstillinger</button>
    </form>
  </div>`;
}

export function adminErrorPage(title: string, text: string): H {
  return html`<div class="stack-lg narrow"><h1>${title}</h1><p class="muted">${text}</p><a class="btn btn-primary" href="/admin">Til oversigten</a></div>`;
}
