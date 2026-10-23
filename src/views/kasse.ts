// Kassens sider i admin: kasseskærm, salgshistorik, et salg, kvittering, ydelser og varer,
// rapporter, indstillinger, personale og PIN-kode. Bruger admin-designets klasser; det, der kun
// findes i kassen, ligger i /static/kasse.css (views/kasse-assets.ts).
import { html, raw } from 'hono/html';
import { formatDate, formatDateTime, formatKr } from '../lib/format';
import type { MovementRow, PosItemRow } from '../lib/pos/items';
import type { Report } from '../lib/pos/reports';
import { METHOD_LABEL, SALE_STATUSES, SALE_STATUS_LABEL, type AuditRow, type SaleDetail, type SaleListRow, type SaleStatus } from '../lib/pos/sales';
import type { MethodOption, PaymentMethod, PosSettings } from '../lib/pos/settings';
import { ROLES, ROLE_LABEL, can, type Role, type StaffInfo, type StaffRow } from '../lib/pos/staff';
import { chart } from './admin-stats';
import { alert, csrfField, type H } from './layout';

// ---------------- Fælles ----------------

type Tab = 'kasse' | 'salg' | 'varer' | 'rapporter' | 'indstillinger' | 'personale' | 'pin';

export function kasseTabs(active: Tab, role: Role): H {
  const tabs: [Tab, string, string, boolean][] = [
    ['kasse', 'Kasse', '/admin/kasse', true],
    ['salg', 'Salgshistorik', '/admin/kasse/salg', true],
    ['varer', 'Ydelser og varer', '/admin/kasse/varer', can(role, 'pos.items')],
    ['rapporter', 'Rapporter', '/admin/kasse/rapporter', can(role, 'pos.reports')],
    ['indstillinger', 'Indstillinger', '/admin/kasse/indstillinger', can(role, 'pos.settings')],
    ['personale', 'Personale', '/admin/kasse/personale', can(role, 'staff.manage')],
    ['pin', 'Min PIN-kode', '/admin/kasse/pin', can(role, 'pos.refund')],
  ];
  return html`<nav class="pos-tabs" aria-label="Kasse">
    ${tabs.filter((t) => t[3]).map(([k, label, href]) => html`<a href="${href}"${k === active ? html` aria-current="page"` : ''}>${label}</a>`)}
  </nav>`;
}

function head(title: string, role: Role, tab: Tab, action?: H): H {
  return html`<div class="stack">
    <div class="row between"><div><p class="eyebrow">Kasse</p><h1>${title}</h1></div>${action ?? ''}</div>
    ${kasseTabs(tab, role)}
  </div>`;
}

export function statusBadge(s: SaleStatus): H {
  const cls: Record<SaleStatus, string> = {
    afventer: 'b-warn',
    betalt: 'b-ok',
    delvist_refunderet: 'b-warn',
    refunderet: 'b-neutral',
    annulleret: 'b-err',
  };
  return html`<span class="badge ${cls[s]}">${SALE_STATUS_LABEL[s]}</span>`;
}

const pct = (bp: number) => (bp / 100).toLocaleString('da-DK');
const staffLabel = (names: Map<string, string>, email: string) => names.get(email.toLowerCase()) || email;
const krInput = (oere: number) => (oere / 100).toLocaleString('da-DK', { minimumFractionDigits: oere % 100 ? 2 : 0, maximumFractionDigits: 2, useGrouping: false });

function err(e: Record<string, string>, k: string): H | '' {
  return e[k] ? html`<p class="hint pos-err">${e[k]}</p>` : '';
}

// ---------------- Kasseskærm ----------------

export interface PosConfig {
  csrf: string;
  methods: MethodOption[];
  presets: number[];
  vatBp: number;
  cashRounding: boolean;
  scanner: boolean;
  scannerAutoAdd: boolean;
  maxDiscountBp: number;
  autoPrint: boolean;
  canEmail: boolean;
  canManage: boolean;
  staff: string;
}

export function posPage(args: { config: PosConfig; role: Role; notices: string[] }): H {
  const c = args.config;
  return html`<div class="pos-page">
    <div class="pos-head">
      <h1 class="visually-hidden">Kasse</h1>${kasseTabs('kasse', args.role)}
      <p class="small muted pos-keys">Genveje: <kbd>/</kbd> søg · <kbd>F4</kbd> kunde · <kbd>F6</kbd> rabat · <kbd>F8</kbd> tøm · <kbd>F9</kbd> betal</p>
    </div>
    ${args.notices.map((n) => alert('warn', n))}
    <div class="pos" data-pos data-config="${JSON.stringify(c)}">
      <section class="pos-products" aria-label="Ydelser og varer">
        <div class="pos-search">
          <label class="visually-hidden" for="pos-q">Søg efter ydelse eller vare</label>
          <input id="pos-q" type="search" autocomplete="off" placeholder="Søg navn, varenummer eller stregkode" enterkeyhint="search">
        </div>
        <div class="pos-cats" role="toolbar" aria-label="Kategorier"></div>
        <div class="pos-grid" aria-live="polite" aria-busy="true"><p class="pos-state">Henter ydelser og varer …</p></div>
      </section>
      <aside class="pos-cart" aria-label="Kurv">
        <div class="pos-cart-head">
          <h2>Kurv <span class="muted small" data-count></span></h2>
          <div class="row" style="gap:6px">
            <button class="btn btn-secondary btn-small" type="button" data-act="customer">Kunde</button>
            <button class="btn btn-secondary btn-small" type="button" data-act="clear">Tøm</button>
          </div>
        </div>
        <div class="pos-customer hidden" data-customer></div>
        <ul class="pos-lines" data-lines></ul>
        <p class="pos-empty" data-empty>Kurven er tom. Vælg ydelser eller varer, eller scan en stregkode.</p>
        <details class="pos-note"><summary>Note til salget</summary>
          <label class="visually-hidden" for="pos-note">Note</label>
          <textarea id="pos-note" maxlength="1000" rows="2" placeholder="Fx aftale, projekt eller levering"></textarea>
        </details>
        <table class="pos-totals">
          <tr><td>Subtotal</td><td data-t="subtotal">0 kr.</td></tr>
          <tr data-row="discount" class="hidden"><td>Rabat <button class="link-btn" type="button" data-act="remove-order-discount" aria-label="Fjern rabat på hele salget">fjern</button></td><td data-t="discount"></td></tr>
          <tr class="total"><td>I alt</td><td data-t="total">0 kr.</td></tr>
          <tr><td class="small muted">Heraf moms</td><td class="small muted" data-t="vat">0 kr.</td></tr>
        </table>
        <div class="pos-actions">
          <button class="btn btn-secondary" type="button" data-act="discount">Rabat</button>
          <button class="btn btn-accent pos-pay" type="button" data-act="pay" disabled>Betal <span data-t="pay"></span></button>
        </div>
      </aside>
      <div class="pos-bar">
        <button class="pos-bar-cart" type="button" data-act="toggle-cart"><span data-bar-count>0 varer</span><strong data-bar-total>0 kr.</strong></button>
        <button class="btn btn-accent" type="button" data-act="pay" disabled>Betal</button>
      </div>
      <div class="pos-toasts" aria-live="polite" role="status"></div>
      <dialog class="pos-dialog" data-dialog="pay" aria-labelledby="pay-title"></dialog>
      <dialog class="pos-dialog" data-dialog="customer" aria-labelledby="cust-title"></dialog>
      <dialog class="pos-dialog" data-dialog="discount" aria-labelledby="disc-title"></dialog>
      <dialog class="pos-dialog pos-dialog-sm" data-dialog="confirm" aria-labelledby="confirm-title"></dialog>
      <dialog class="pos-dialog" data-dialog="done" aria-labelledby="done-title"></dialog>
    </div>
    <noscript>${alert('err', 'Kassen kræver JavaScript.')}</noscript>
  </div>`;
}

// ---------------- Salgshistorik ----------------

export function salesPage(args: {
  role: Role;
  rows: SaleListRow[];
  names: Map<string, string>;
  staffEmails: string[];
  filter: { q: string; fra: string; til: string; medarbejder: string; betaling: string; status: string };
  page: number;
  hasMore: boolean;
  onlyOwn: boolean;
}): H {
  const f = args.filter;
  const qs = (side: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    p.set('side', String(side));
    return `?${p.toString()}`;
  };
  const methods: PaymentMethod[] = ['kontant', 'stripe_terminal', 'kort_terminal', 'andet'];
  return html`<div class="stack-lg">
    ${head('Salgshistorik', args.role, 'salg', html`<a class="btn btn-primary" href="/admin/kasse">Til kassen</a>`)}
    ${args.onlyOwn ? html`<p class="small muted">Du ser dine egne salg.</p>` : ''}
    <form class="card stack" method="get" action="/admin/kasse/salg" role="search">
      <div class="pos-filter">
        <div><label for="q">Salgsnummer eller kunde</label><input id="q" type="text" name="q" value="${f.q}" placeholder="Fx 1042"></div>
        <div><label for="fra">Fra</label><input id="fra" type="date" name="fra" value="${f.fra}"></div>
        <div><label for="til">Til</label><input id="til" type="date" name="til" value="${f.til}"></div>
        ${args.onlyOwn
          ? ''
          : html`<div><label for="medarbejder">Medarbejder</label><select id="medarbejder" name="medarbejder"><option value="">Alle</option>
              ${args.staffEmails.map((e) => html`<option value="${e}"${f.medarbejder === e ? ' selected' : ''}>${staffLabel(args.names, e)}</option>`)}</select></div>`}
        <div><label for="betaling">Betaling</label><select id="betaling" name="betaling"><option value="">Alle</option>
          ${methods.map((m) => html`<option value="${m}"${f.betaling === m ? ' selected' : ''}>${METHOD_LABEL[m]}</option>`)}</select></div>
        <div><label for="status">Status</label><select id="status" name="status"><option value="">Alle</option>
          ${SALE_STATUSES.map((s) => html`<option value="${s}"${f.status === s ? ' selected' : ''}>${SALE_STATUS_LABEL[s]}</option>`)}</select></div>
      </div>
      <div class="row"><button class="btn btn-secondary" type="submit">Filtrér</button><a class="small" href="/admin/kasse/salg">Nulstil</a></div>
    </form>
    <div class="card">
      ${args.rows.length
        ? html`<div class="table-wrap"><table class="responsive">
            <thead><tr><th>Salg</th><th>Tidspunkt</th><th>Kunde</th><th>Ekspedient</th><th>Betaling</th><th>Status</th><th class="num">Beløb</th></tr></thead>
            <tbody>${args.rows.map(
              (r) => html`<tr>
                <td data-label="Salg"><a href="/admin/kasse/salg/${r.id}"><strong>#${r.number}</strong></a> <span class="small muted">${r.item_count} stk.</span></td>
                <td data-label="Tidspunkt">${formatDateTime(r.created_at)}</td>
                <td data-label="Kunde">${r.company || r.customer_name || html`<span class="muted">–</span>`}</td>
                <td data-label="Ekspedient">${staffLabel(args.names, r.staff_email)}</td>
                <td data-label="Betaling">${r.methods || '–'}</td>
                <td data-label="Status">${statusBadge(r.status)}</td>
                <td data-label="Beløb" class="num">${formatKr(r.total + r.rounding)}${r.refunded ? html`<div class="small muted">-${formatKr(r.refunded)} refunderet</div>` : ''}</td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<p class="empty">Ingen kassesalg matcher.</p>`}
    </div>
    ${args.page > 1 || args.hasMore
      ? html`<nav class="row between" aria-label="Sider">
          ${args.page > 1 ? html`<a class="btn btn-secondary btn-small" href="/admin/kasse/salg${qs(args.page - 1)}">← Nyere</a>` : html`<span></span>`}
          ${args.hasMore ? html`<a class="btn btn-secondary btn-small" href="/admin/kasse/salg${qs(args.page + 1)}">Ældre →</a>` : ''}
        </nav>`
      : ''}
  </div>`;
}

// ---------------- Et salg ----------------

export function saleFlash(code: string | undefined): H | '' {
  const m: Record<string, [kind: 'ok' | 'info' | 'warn' | 'err', text: string]> = {
    refunderet: ['ok', 'Refusionen er gennemført.'],
    sendt: ['ok', 'Kvitteringen er sendt.'],
    annulleret: ['ok', 'Salget er annulleret, og varerne er lagt tilbage på lager.'],
    betalt: ['ok', 'Kortbetalingen er gennemført.'],
  };
  const v = code ? m[code] : undefined;
  return v ? alert(v[0], v[1]) : '';
}

const PAY_STATE: Record<string, [string, string]> = {
  afventer: ['Afventer', 'b-warn'],
  fejlet: ['Fejlet', 'b-err'],
  annulleret: ['Annulleret', 'b-neutral'],
};

export function saleDetailPage(args: {
  csrf: string;
  staff: StaffInfo;
  d: SaleDetail;
  names: Map<string, string>;
  canEmail: boolean;
  refundKey: string;
  flash?: H | '';
  error?: H | '';
  values?: { email?: string };
}): H {
  const { d, staff } = args;
  const o = d.sale;
  const refundable = o.status === 'betalt' || o.status === 'delvist_refunderet';
  const openLines = d.lines.filter((l) => l.quantity > l.refunded_qty);
  const orderDisc = d.lines.reduce((a, l) => a + l.order_discount, 0);
  const lineDisc = o.discount - orderDisc;
  const paid = d.payments.filter((p) => p.status === 'gennemfoert');
  const needApproval = !can(staff.role, 'pos.refund');
  return html`<div class="stack-lg">
    <div class="stack">
      <a class="small" href="/admin/kasse/salg">← Salgshistorik</a>
      <div class="row between"><h1 style="margin:0">Kassesalg #${o.number}</h1>${statusBadge(o.status)}</div>
      <p class="muted small" style="margin:0">${formatDateTime(o.created_at)} · ${staffLabel(args.names, o.staff_email)} · Kilde: kassen${o.discount_approved_by ? ` · rabat godkendt af ${staffLabel(args.names, o.discount_approved_by)}` : ''}</p>
    </div>
    ${args.flash ?? ''}${args.error ?? ''}
    <div class="pos-side">
      <div class="stack-lg">
        <section class="card">
          <div class="table-wrap"><table class="responsive">
            <thead><tr><th>Ydelse/vare</th><th class="num">Antal</th><th class="num">Pris</th><th class="num">Rabat</th><th class="num">I alt</th></tr></thead>
            <tbody>${d.lines.map(
              (l) => html`<tr>
                <td data-label="Ydelse/vare"><strong>${l.name}</strong><div class="small muted">${l.sku}</div></td>
                <td data-label="Antal" class="num">${l.quantity} ${l.unit}${l.refunded_qty ? html`<div class="small muted">${l.refunded_qty} refunderet</div>` : ''}</td>
                <td data-label="Pris" class="num">${formatKr(l.unit_price)}</td>
                <td data-label="Rabat" class="num">${l.line_discount + l.order_discount ? '-' + formatKr(l.line_discount + l.order_discount) : '–'}</td>
                <td data-label="I alt" class="num">${formatKr(l.line_total - l.line_discount - l.order_discount)}</td>
              </tr>`,
            )}</tbody>
          </table></div>
          <table class="pos-totals" style="margin-top:16px">
            <tr><td>Subtotal</td><td>${formatKr(o.subtotal - lineDisc)}</td></tr>
            ${orderDisc ? html`<tr><td>Rabat på salget${o.order_discount_type === 'pct' ? ` (${pct(o.order_discount_value ?? 0)} %)` : ''}</td><td>-${formatKr(orderDisc)}</td></tr>` : ''}
            <tr class="total"><td>I alt inkl. moms</td><td>${formatKr(o.total)}</td></tr>
            <tr><td class="small muted">Heraf moms ${pct(o.vat_rate_bp)} %</td><td class="small muted">${formatKr(o.vat_amount)}</td></tr>
            ${o.rounding ? html`<tr><td class="small muted">Øreafrunding (kontant)</td><td class="small muted">${formatKr(o.rounding)}</td></tr>` : ''}
            ${o.refunded ? html`<tr><td>Refunderet</td><td>-${formatKr(o.refunded)}</td></tr>` : ''}
          </table>
        </section>
        <section class="card stack">
          <h2>Betaling</h2>
          ${d.payments.length
            ? html`<ul class="plain-list">${d.payments.map(
                (p) => html`<li><span><strong>${p.label}</strong>${p.method === 'kontant' && p.received ? html` <span class="small muted">modtaget ${formatKr(p.received)}, retur ${formatKr(p.change_given ?? 0)}</span>` : ''}${p.reference ? html` <span class="small muted">ref. ${p.reference}</span>` : ''}${p.provider_ref ? html` <span class="small muted">${p.provider_ref}</span>` : ''}
                  ${PAY_STATE[p.status] ? html` <span class="badge ${PAY_STATE[p.status]![1]}">${PAY_STATE[p.status]![0]}</span>` : ''}
                  ${p.error ? html`<span class="small pos-err" style="display:block">${p.error}</span>` : ''}</span>
                  <span class="num">${formatKr(p.amount)}</span></li>`,
              )}</ul>`
            : html`<p class="muted small">Ingen betaling (0 kr.).</p>`}
          ${d.refunds.length
            ? html`<h3>Refusioner</h3><ul class="plain-list">${d.refunds.map(
                (r) => html`<li><span><strong>${formatDateTime(r.created_at)}</strong> <span class="small muted">${r.reason} · ${staffLabel(args.names, r.actor)}${r.approved_by ? ` (godkendt af ${staffLabel(args.names, r.approved_by)})` : ''}${r.restock ? ' · lagt på lager' : ''}</span>
                  ${r.status === 'fejlet' ? html`<span class="small pos-err" style="display:block">Fejlet: ${r.error}</span>` : html`<span class="small muted" style="display:block">${r.parts.map((p) => `${p.label} ${formatKr(p.amount)}`).join(' + ')}</span>`}</span>
                  <span class="num">${r.status === 'fejlet' ? html`<s>-${formatKr(r.amount)}</s>` : `-${formatKr(r.amount)}`}</span></li>`,
              )}</ul>`
            : ''}
        </section>
        ${o.customer_name || o.company || o.customer_email || o.customer_phone || o.note
          ? html`<section class="card stack"><h2>Kunde og note</h2><dl class="pos-kv">
              ${o.customer_name ? html`<dt>Navn</dt><dd>${o.customer_name}${o.customer_id ? html` <span class="small muted">(kunde hos Veyro)</span>` : ''}</dd>` : ''}
              ${o.company ? html`<dt>Firma</dt><dd>${o.company}</dd>` : ''}
              ${o.customer_email ? html`<dt>E-mail</dt><dd>${o.customer_email}</dd>` : ''}
              ${o.customer_phone ? html`<dt>Telefon</dt><dd>${o.customer_phone}</dd>` : ''}
              ${o.note ? html`<dt>Note</dt><dd class="prewrap">${o.note}</dd>` : ''}
            </dl></section>`
          : ''}
        <section class="card stack">
          <h2>Historik</h2>
          <ol class="pos-timeline">${d.events.map((e) => html`<li><strong>${e.message}</strong><div class="small muted">${formatDateTime(e.created_at)} · ${staffLabel(args.names, e.actor)}</div></li>`)}</ol>
        </section>
      </div>
      <aside class="stack-lg">
        <section class="card stack">
          <h2>Kvittering</h2>
          <a class="btn btn-primary btn-block" href="/admin/kasse/salg/${o.id}/kvittering?print=1&kopi=1" target="_blank" rel="noopener">Udskriv kvittering</a>
          ${args.canEmail
            ? html`<form class="stack" method="post" action="/admin/kasse/salg/${o.id}/send">
                ${csrfField(args.csrf)}
                <div><label for="r-email">Send på e-mail</label>
                <div class="row" style="flex-wrap:nowrap;gap:8px"><input id="r-email" type="email" name="email" value="${args.values?.email ?? o.customer_email}" required placeholder="kunde@example.dk"><button class="btn btn-secondary" type="submit">Send</button></div></div>
              </form>`
            : html`<p class="small muted">E-mail er ikke sat op (RESEND_API_KEY mangler).</p>`}
        </section>
        ${o.status === 'afventer'
          ? html`<section class="card stack">
              <h2>Afventer kortbetaling</h2>
              <p class="small muted">Varerne er trukket fra lageret. Tjek status, eller annullér salget, hvis kunden ikke betaler.</p>
              <form method="post" action="/admin/kasse/salg/${o.id}/tjek">${csrfField(args.csrf)}<button class="btn btn-secondary btn-block" type="submit">Tjek kortbetaling</button></form>
              <form method="post" action="/admin/kasse/salg/${o.id}/annuller" data-confirm="Annullér kassesalg #${o.number}? Varerne lægges tilbage på lager, og andre betalinger på salget skal gives tilbage til kunden.">
                ${csrfField(args.csrf)}<button class="btn btn-danger btn-block" type="submit">Annullér salg</button></form>
            </section>`
          : ''}
        ${refundable && openLines.length
          ? html`<form class="card stack" method="post" action="/admin/kasse/salg/${o.id}/refunder" data-confirm="Gennemfør refusionen? Det kan ikke fortrydes.">
              ${csrfField(args.csrf)}
              <input type="hidden" name="key" value="${args.refundKey}">
              <h2>Refundér</h2>
              <div class="stack">${openLines.map(
                (l) => html`<div class="row between" style="flex-wrap:nowrap"><label for="rq-${l.id}" style="margin:0;font-weight:500">${l.name}<span class="small muted" style="display:block">${l.quantity - l.refunded_qty} kan refunderes</span></label>
                  <input id="rq-${l.id}" class="pos-qty" type="number" name="rq_${l.id}" inputmode="numeric" min="0" max="${l.quantity - l.refunded_qty}" value="0" aria-label="Antal af ${l.name}" data-max="${l.quantity - l.refunded_qty}"></div>`,
              )}</div>
              <button class="link-btn" type="button" data-refund-all>Vælg alt</button>
              ${d.lines.some((l) => l.track_stock) ? html`<label class="check"><input type="checkbox" name="restock" value="1" checked> <span>Læg varer med lager tilbage på lager</span></label>` : ''}
              ${paid.length > 1
                ? html`<div><label for="payment">Refundér til</label><select id="payment" name="payment">${paid.map((p) => html`<option value="${p.id}">${p.label} (${formatKr(p.amount)})</option>`)}</select>
                    <p class="hint">Resten fordeles på salgets andre betalinger.</p></div>`
                : paid.length
                  ? html`<input type="hidden" name="payment" value="${paid[0]!.id}"><p class="small muted">Refunderes til ${paid[0]!.label}${paid[0]!.method === 'stripe_terminal' ? ' (beløbet sendes tilbage til kortet via Stripe)' : paid[0]!.method === 'kort_terminal' ? ' (gennemfør refusionen på terminalen)' : ''}.</p>`
                  : ''}
              <div><label for="reason">Årsag</label><input id="reason" type="text" name="reason" maxlength="200" required placeholder="Fx fortrudt køb, fejl i ydelsen"></div>
              ${needApproval
                ? html`<fieldset class="stack"><legend class="small" style="font-weight:600">Godkendelse af leder</legend>
                    <div><label for="ap-email">E-mail</label><input id="ap-email" type="email" name="approver_email" required autocomplete="off"></div>
                    <div><label for="ap-pin">PIN-kode</label><input id="ap-pin" type="password" name="approver_pin" inputmode="numeric" required autocomplete="off" maxlength="8"></div>
                  </fieldset>`
                : ''}
              <button class="btn btn-danger btn-block" type="submit">Refundér</button>
            </form>`
          : ''}
      </aside>
    </div>
  </div>`;
}

// ---------------- Kvittering (udskrift) ----------------

export function receiptPage(args: { d: SaleDetail; pos: PosSettings; staffName: string; copy: boolean; print: boolean }): H {
  const { d, pos } = args;
  const o = d.sale;
  const orderDisc = d.lines.reduce((a, l) => a + l.order_discount, 0);
  const lineDisc = o.discount - orderDisc;
  const paid = d.payments.filter((p) => p.status === 'gennemfoert');
  const width = pos.receipt_width === 'a4' ? '180mm' : pos.receipt_width === '58mm' ? '54mm' : '76mm';
  const kr = (n: number) => formatKr(n, { decimals: true });
  return html`<!doctype html>
<html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Kvittering #${o.number} · ${pos.store_name}</title>
<style>${raw(`
@page{size:${pos.receipt_width === 'a4' ? 'A4' : `${pos.receipt_width} auto`};margin:${pos.receipt_width === 'a4' ? '15mm' : '2mm'}}
*{box-sizing:border-box}body{margin:0;background:#eee;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#000}
.r{width:${width};max-width:100%;margin:16px auto;background:#fff;padding:12px}
h1{font-size:16px;margin:0 0 2px;text-align:center}.c{text-align:center}.m{color:#333}
table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}td.a{text-align:right;white-space:nowrap;padding-left:8px}
.hr{border-top:1px dashed #000;margin:8px 0}.b td{font-weight:700;font-size:15px}.s{font-size:11px}.k{font-weight:700;text-align:center;font-size:14px;border:1px solid #000;padding:2px;margin:6px 0}
.tools{text-align:center;margin:12px}.tools button{font:inherit;padding:8px 14px;cursor:pointer}
@media print{body{background:#fff}.r{margin:0;padding:0;width:auto}.tools{display:none}}
`)}</style>
<script src="/static/kasse.js?v=1" defer></script>
</head><body${args.print ? html` data-autoprint` : ''}>
<div class="tools"><button type="button" data-print>Udskriv</button></div>
<div class="r">
  <h1>${pos.store_name}</h1>
  ${pos.store_address || pos.store_phone ? html`<div class="c m">${[pos.store_address, pos.store_phone].filter(Boolean).join(' · ')}</div>` : ''}
  ${pos.store_email || pos.store_website ? html`<div class="c m">${[pos.store_email, pos.store_website].filter(Boolean).join(' · ')}</div>` : ''}
  ${pos.cvr ? html`<div class="c m">CVR ${pos.cvr}</div>` : ''}
  ${pos.receipt_header ? html`<div class="c" style="margin-top:6px;white-space:pre-line">${pos.receipt_header}</div>` : ''}
  ${args.copy ? html`<div class="k">KOPI</div>` : ''}
  <div class="hr"></div>
  <table>
    <tr><td>Kvittering</td><td class="a">#${o.number}</td></tr>
    <tr><td>Dato</td><td class="a">${formatDateTime(o.created_at)}</td></tr>
    ${args.staffName ? html`<tr><td>Ekspedient</td><td class="a">${args.staffName}</td></tr>` : ''}
    ${o.company || o.customer_name ? html`<tr><td>Kunde</td><td class="a">${o.company || o.customer_name}</td></tr>` : ''}
  </table>
  <div class="hr"></div>
  <table>${d.lines.map(
    (l) => html`<tr><td colspan="2">${l.name}</td></tr>
      <tr><td class="m">&nbsp;${l.quantity} × ${kr(l.unit_price)}</td><td class="a">${kr(l.line_total)}</td></tr>
      ${l.line_discount ? html`<tr><td class="m">&nbsp;Rabat</td><td class="a">-${kr(l.line_discount)}</td></tr>` : ''}`,
  )}</table>
  <div class="hr"></div>
  <table>
    ${o.discount ? html`<tr><td>Subtotal</td><td class="a">${kr(o.subtotal - lineDisc)}</td></tr>` : ''}
    ${orderDisc ? html`<tr><td>Rabat${o.order_discount_type === 'pct' ? ` ${pct(o.order_discount_value ?? 0)} %` : ''}</td><td class="a">-${kr(orderDisc)}</td></tr>` : ''}
    <tr class="b"><td>I ALT DKK</td><td class="a">${kr(o.total).replace(' kr.', '')}</td></tr>
    ${o.rounding ? html`<tr><td>Øreafrunding</td><td class="a">${kr(o.rounding)}</td></tr>` : ''}
    <tr><td>Heraf moms ${pct(o.vat_rate_bp)} %</td><td class="a">${kr(o.vat_amount)}</td></tr>
    ${o.discount ? html`<tr><td>Du har sparet</td><td class="a">${kr(o.discount)}</td></tr>` : ''}
  </table>
  <div class="hr"></div>
  <table>
    ${paid.map(
      (p) => html`<tr><td>${p.label}${p.reference ? ` (${p.reference})` : ''}</td><td class="a">${kr(p.amount)}</td></tr>
        ${p.method === 'kontant' && p.received ? html`<tr><td class="m">&nbsp;Modtaget</td><td class="a">${kr(p.received)}</td></tr><tr><td class="m">&nbsp;Retur</td><td class="a">${kr(p.change_given ?? 0)}</td></tr>` : ''}`,
    )}
    ${o.status === 'afventer' ? html`<tr><td colspan="2"><strong>AFVENTER BETALING – ikke betalt</strong></td></tr>` : ''}
    ${o.status === 'annulleret' ? html`<tr><td colspan="2"><strong>ANNULLERET</strong></td></tr>` : ''}
  </table>
  ${d.refunds.some((r) => r.status === 'gennemfoert')
    ? html`<div class="hr"></div><table>${d.refunds
        .filter((r) => r.status === 'gennemfoert')
        .map((r) => html`<tr><td>Refunderet ${formatDate(r.created_at)}</td><td class="a">-${kr(r.amount)}</td></tr>`)}</table>`
    : ''}
  ${o.note ? html`<div class="hr"></div><div class="s" style="white-space:pre-wrap">${o.note}</div>` : ''}
  ${pos.receipt_footer ? html`<div class="hr"></div><div class="c" style="white-space:pre-line">${pos.receipt_footer}</div>` : ''}
</div>
</body></html>`;
}

// ---------------- Ydelser og varer ----------------

export function itemsPage(args: { role: Role; items: PosItemRow[]; q: string; flash?: H | '' }): H {
  const q = args.q.toLowerCase();
  const items = q ? args.items.filter((i) => `${i.name} ${i.sku} ${i.barcode ?? ''} ${i.category}`.toLowerCase().includes(q)) : args.items;
  return html`<div class="stack-lg">
    ${head('Ydelser og varer', args.role, 'varer', html`<a class="btn btn-primary" href="/admin/kasse/varer/ny">Ny ydelse eller vare</a>`)}
    ${args.flash ?? ''}
    <form class="row" method="get" action="/admin/kasse/varer" role="search">
      <label class="visually-hidden" for="q">Søg</label>
      <input id="q" type="text" name="q" value="${args.q}" placeholder="Søg navn, varenummer, stregkode eller kategori" style="max-width:420px">
      <button class="btn btn-secondary" type="submit">Søg</button>
    </form>
    <div class="card">
      ${items.length
        ? html`<div class="table-wrap"><table class="responsive">
            <thead><tr><th>Navn</th><th>Kategori</th><th>Varenummer</th><th class="num">Pris inkl. moms</th><th class="num">Lager</th><th>Status</th></tr></thead>
            <tbody>${items.map(
              (i) => html`<tr>
                <td data-label="Navn"><a href="/admin/kasse/varer/${i.id}"><strong>${i.name}</strong></a>${i.barcode ? html`<div class="small muted">${i.barcode}</div>` : ''}</td>
                <td data-label="Kategori">${i.category || html`<span class="muted">–</span>`}</td>
                <td data-label="Varenummer">${i.sku}</td>
                <td data-label="Pris" class="num">${formatKr(i.price)}${i.unit ? html` <span class="small muted">/ ${i.unit}</span>` : ''}</td>
                <td data-label="Lager" class="num">${i.track_stock ? html`${i.stock <= 0 ? html`<span class="badge b-err">Udsolgt</span>` : i.stock <= 3 ? html`<span class="badge b-warn">${i.stock}</span>` : String(i.stock)}` : html`<span class="muted">Ingen lagerstyring</span>`}</td>
                <td data-label="Status">${i.active ? html`<span class="badge b-ok">I kassen</span>` : html`<span class="badge b-neutral">Slået fra</span>`}</td>
              </tr>`,
            )}</tbody></table></div>`
        : args.items.length
          ? html`<p class="empty">Ingen ydelser eller varer matcher "${args.q}".</p>`
          : html`<div class="empty stack"><p>Der er ingen ydelser eller varer endnu.</p><p><a class="btn btn-primary" href="/admin/kasse/varer/ny">Opret den første</a></p></div>`}
    </div>
  </div>`;
}

export interface ItemFormValues {
  sku: string;
  barcode: string;
  name: string;
  category: string;
  description: string;
  price: string;
  unit: string;
  track_stock: boolean;
  stock: string;
  active: boolean;
  sort_order: string;
}

export function itemFormValues(i: PosItemRow | null): ItemFormValues {
  return {
    sku: i?.sku ?? '',
    barcode: i?.barcode ?? '',
    name: i?.name ?? '',
    category: i?.category ?? '',
    description: i?.description ?? '',
    price: i ? krInput(i.price) : '',
    unit: i?.unit ?? 'stk.',
    track_stock: !!i?.track_stock,
    stock: i ? String(i.stock) : '0',
    active: i ? !!i.active : true,
    sort_order: i ? String(i.sort_order) : '0',
  };
}

export function itemFormPage(args: {
  csrf: string;
  role: Role;
  item: PosItemRow | null;
  values: ItemFormValues;
  categories: string[];
  movements: MovementRow[];
  names: Map<string, string>;
  errors?: Record<string, string>;
  flash?: H | '';
}): H {
  const v = args.values;
  const e = args.errors ?? {};
  const i = args.item;
  const action = i ? `/admin/kasse/varer/${i.id}` : '/admin/kasse/varer';
  return html`<div class="stack-lg" style="max-width:860px">
    <div class="stack">
      <a class="small" href="/admin/kasse/varer">← Ydelser og varer</a>
      <h1 style="margin:0">${i ? i.name : 'Ny ydelse eller vare'}</h1>
    </div>
    ${args.flash ?? ''}
    ${Object.keys(e).length ? alert('err', e['form'] ?? 'Ret de markerede felter.') : ''}
    <form class="card stack" method="post" action="${action}" enctype="multipart/form-data">
      ${csrfField(args.csrf)}
      <div class="pos-form-grid">
        <div class="pos-span"><label for="name">Navn</label><input id="name" type="text" name="name" value="${v.name}" maxlength="120" required placeholder="Fx Hjemmeside Business – opsætning">${err(e, 'name')}</div>
        <div><label for="price">Pris inkl. moms (kr.)</label><input id="price" type="text" name="price" value="${v.price}" inputmode="decimal" required placeholder="0,00">${err(e, 'price')}</div>
        <div><label for="unit">Enhed</label><input id="unit" type="text" name="unit" value="${v.unit}" maxlength="20" placeholder="stk., time, md.">${err(e, 'unit')}</div>
        <div><label for="sku">Varenummer</label><input id="sku" type="text" name="sku" value="${v.sku}" maxlength="40" placeholder="Udfyldes automatisk, hvis tomt">${err(e, 'sku')}</div>
        <div><label for="barcode">Stregkode (valgfri)</label><input id="barcode" type="text" name="barcode" value="${v.barcode}" maxlength="40" inputmode="numeric">${err(e, 'barcode')}</div>
        <div><label for="category">Kategori</label><input id="category" type="text" name="category" value="${v.category}" maxlength="40" list="cats" placeholder="Fx Hjemmesider"><datalist id="cats">${args.categories.map((c) => html`<option value="${c}">`)}</datalist></div>
        <div><label for="sort_order">Rækkefølge</label><input id="sort_order" type="number" name="sort_order" value="${v.sort_order}" min="-9999" max="9999">${err(e, 'sort_order')}</div>
        <div class="pos-span"><label for="description">Beskrivelse (intern)</label><textarea id="description" name="description" maxlength="500" rows="2" style="min-height:0">${v.description}</textarea></div>
        <div class="pos-span">
          <label for="image">Billede (valgfrit, PNG/JPEG/WebP, højst 300 KB)</label>
          ${i?.image_type ? html`<div class="row" style="margin-bottom:8px"><img src="/admin/kasse/varer/${i.id}/billede?v=${i.updated_at}" alt="" width="96" height="60" style="object-fit:cover;border-radius:8px;border:1px solid var(--line)"><label class="check" style="margin:0"><input type="checkbox" name="remove_image" value="1"> <span>Fjern billedet</span></label></div>` : ''}
          <input id="image" type="file" name="image" accept="image/png,image/jpeg,image/webp">${err(e, 'image')}
        </div>
      </div>
      <label class="check"><input type="checkbox" name="active" value="1"${v.active ? ' checked' : ''}> <span>Vis i kassen</span></label>
      <label class="check"><input type="checkbox" name="track_stock" value="1"${v.track_stock ? ' checked' : ''}> <span>Lagerstyring <span class="hint" style="display:block;margin:0">Til fysiske varer. Kassen sælger aldrig flere, end der er på lager. Ydelser har normalt ikke lager.</span></span></label>
      ${i ? '' : html`<div style="max-width:200px"><label for="stock">Startlager</label><input id="stock" type="number" name="stock" value="${v.stock}" min="0" max="999999">${err(e, 'stock')}</div>`}
      <div><button class="btn btn-primary" type="submit">${i ? 'Gem ændringer' : 'Opret'}</button></div>
    </form>
    ${i && i.track_stock
      ? html`<section class="card stack">
          <div class="row between"><h2 style="margin:0">Lager</h2><span class="kpi__value">${i.stock} ${i.unit}</span></div>
          <form class="row" method="post" action="/admin/kasse/varer/${i.id}/lager" style="align-items:flex-end">
            ${csrfField(args.csrf)}
            <div><label for="mode">Regulering</label><select id="mode" name="mode" style="width:auto"><option value="add">Læg til / træk fra</option><option value="set">Sæt lager til</option></select></div>
            <div style="width:120px"><label for="value">Antal</label><input id="value" type="number" name="value" required min="-999999" max="999999"></div>
            <div style="flex:1;min-width:180px"><label for="sreason">Årsag</label><input id="sreason" type="text" name="reason" maxlength="100" required placeholder="Fx varemodtagelse, optælling"></div>
            <button class="btn btn-secondary" type="submit">Regulér</button>
          </form>
          ${err(e, 'stock_adjust')}
          ${args.movements.length
            ? html`<div class="table-wrap"><table class="pos-mini"><thead><tr><th>Tidspunkt</th><th>Årsag</th><th class="num">Ændring</th><th class="num">Lager efter</th><th>Af</th></tr></thead>
                <tbody>${args.movements.map((m) => html`<tr><td>${formatDateTime(m.created_at)}</td><td>${m.reason}${m.sale_id ? html` <a href="/admin/kasse/salg/${m.sale_id}">#${m.sale_number}</a>` : ''}</td><td class="num">${m.change > 0 ? '+' : ''}${m.change}</td><td class="num">${m.stock_after}</td><td>${staffLabel(args.names, m.actor)}</td></tr>`)}</tbody></table></div>`
            : html`<p class="small muted">Ingen lagerbevægelser endnu.</p>`}
        </section>`
      : ''}
  </div>`;
}

// ---------------- Rapporter ----------------

export function reportsPage(args: { role: Role; r: Report; names: Map<string, string>; presets: { label: string; fra: string; til: string }[] }): H {
  const r = args.r;
  const same = r.from === r.to;
  const kr = (n: number) => formatKr(n);
  const axisKr = (n: number) => (n >= 100000 ? `${Math.round(n / 100000).toLocaleString('da-DK')}k` : Math.round(n / 100).toLocaleString('da-DK'));
  return html`<div class="stack-lg">
    ${head('Rapporter', args.role, 'rapporter')}
    <form class="row" method="get" action="/admin/kasse/rapporter">
      <label class="visually-hidden" for="fra">Fra</label><input id="fra" type="date" name="fra" value="${r.from}" style="width:auto">
      <span class="muted">til</span>
      <label class="visually-hidden" for="til">Til</label><input id="til" type="date" name="til" value="${r.to}" style="width:auto">
      <button class="btn btn-secondary" type="submit">Vis</button>
    </form>
    <nav class="pos-tabs pos-tabs-sm" aria-label="Hurtigvalg">${args.presets.map(
      (p) => html`<a href="/admin/kasse/rapporter?fra=${p.fra}&til=${p.til}"${p.fra === r.from && p.til === r.to ? html` aria-current="page"` : ''}>${p.label}</a>`,
    )}</nav>
    <div class="grid kpi-grid">
      <div class="card kpi"><div class="muted small">Nettosalg${same ? '' : ' i perioden'}</div><div class="kpi__value">${kr(r.net)}</div><div class="small muted">efter refusioner, inkl. moms</div></div>
      <div class="card kpi"><div class="muted small">Salg</div><div class="kpi__value">${r.sales.count}</div><div class="small muted">gennemførte</div></div>
      <div class="card kpi"><div class="muted small">Gennemsnit pr. salg</div><div class="kpi__value">${kr(r.average)}</div></div>
      <div class="card kpi"><div class="muted small">Refunderet</div><div class="kpi__value">${kr(r.refunds.amount)}</div><div class="small muted">${r.refunds.count} ${r.refunds.count === 1 ? 'refusion' : 'refusioner'}</div></div>
    </div>
    ${r.days.length > 1
      ? html`<section class="card stack">${chart({ id: 'c-pos', title: 'Salg pr. dag', kind: 'bar', days: r.days.map((d) => d.date), current: r.days.map((d) => d.total), previous: [], format: kr, axis: axisKr })}
          <details><summary>Vis som tabel</summary><div class="table-wrap"><table class="pos-mini"><thead><tr><th>Dato</th><th class="num">Salg</th><th class="num">Beløb</th><th class="num">Refunderet</th></tr></thead>
            <tbody>${r.days.map((d) => html`<tr><td>${d.date}</td><td class="num">${d.count}</td><td class="num">${kr(d.total)}</td><td class="num">${d.refunds ? kr(d.refunds) : '–'}</td></tr>`)}</tbody></table></div></details>
        </section>`
      : ''}
    <div class="grid grid-2">
      <section class="card stack">
        <h2>Omsætning</h2>
        <table class="pos-totals">
          <tr><td>Før rabat</td><td>${kr(r.sales.gross)}</td></tr>
          <tr><td>Rabat</td><td>${r.sales.discount ? '-' + kr(r.sales.discount) : '–'}</td></tr>
          ${r.cash.rounding ? html`<tr><td>Øreafrunding</td><td>${kr(r.cash.rounding)}</td></tr>` : ''}
          <tr><td>Salg</td><td>${kr(r.sales.total)}</td></tr>
          <tr><td>Refusioner</td><td>${r.refunds.amount ? '-' + kr(r.refunds.amount) : '–'}</td></tr>
          <tr class="total"><td>Netto inkl. moms</td><td>${kr(r.net)}</td></tr>
          <tr><td class="small muted">Heraf moms</td><td class="small muted">${kr(r.netVat)}</td></tr>
        </table>
      </section>
      <section class="card stack">
        <h2>Kontanter</h2>
        <table class="pos-totals">
          <tr><td>Kontantsalg</td><td>${kr(r.cash.sales)}</td></tr>
          <tr><td class="small muted">Modtaget / givet retur</td><td class="small muted">${kr(r.cash.received)} / ${kr(r.cash.change)}</td></tr>
          <tr><td>Udbetalt ved refusion</td><td>${r.cash.refunds ? '-' + kr(r.cash.refunds) : '–'}</td></tr>
          <tr class="total"><td>Kontanter i kassen (netto)</td><td>${kr(r.cash.net)}</td></tr>
        </table>
        <p class="small muted">Byttepenge ved dagens start er ikke medregnet.</p>
      </section>
      <section class="card stack">
        <h2>Pr. betalingsform</h2>
        ${r.methods.length
          ? html`<div class="table-wrap"><table class="pos-mini"><thead><tr><th>Betaling</th><th class="num">Antal</th><th class="num">Beløb</th><th class="num">Refunderet</th><th class="num">Netto</th></tr></thead>
              <tbody>${r.methods.map((m) => html`<tr><td>${m.label}</td><td class="num">${m.count}</td><td class="num">${kr(m.amount)}</td><td class="num">${m.refunded ? '-' + kr(m.refunded) : '–'}</td><td class="num">${kr(m.amount - m.refunded)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted small">Ingen betalinger i perioden.</p>`}
      </section>
      <section class="card stack">
        <h2>Pr. medarbejder</h2>
        ${r.staff.length
          ? html`<div class="table-wrap"><table class="pos-mini"><thead><tr><th>Ekspedient</th><th class="num">Salg</th><th class="num">Beløb</th><th class="num">Refunderet</th></tr></thead>
              <tbody>${r.staff.map((s) => html`<tr><td>${staffLabel(args.names, s.email)}</td><td class="num">${s.count}</td><td class="num">${kr(s.total)}</td><td class="num">${s.refunded ? '-' + kr(s.refunded) : '–'}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted small">Ingen salg i perioden.</p>`}
      </section>
    </div>
    <section class="card stack">
      <h2>Mest solgte</h2>
      ${r.products.length
        ? html`<div class="table-wrap"><table class="pos-mini"><thead><tr><th>Ydelse/vare</th><th class="num">Solgt</th><th class="num">Refunderet</th><th class="num">Beløb efter rabat</th></tr></thead>
            <tbody>${r.products.map((p) => html`<tr><td>${p.name}<small>${p.sku}</small></td><td class="num">${p.quantity}</td><td class="num">${p.refundedQty || '–'}</td><td class="num">${kr(p.amount)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted small">Ingen salg i perioden.</p>`}
    </section>
    <p class="small muted">Tallene beregnes fra de gennemførte kassesalg og refusioner i databasen. Salg, der afventer betaling eller er annulleret, tæller ikke med. Abonnementer og fakturaer fra Stripe er ikke med her (se Statistik).</p>
  </div>`;
}

// ---------------- Indstillinger ----------------

export function posSettingsPage(args: {
  csrf: string;
  role: Role;
  s: PosSettings;
  stripeKey: boolean;
  emailReady: boolean;
  audit: AuditRow[];
  names: Map<string, string>;
  errors?: Record<string, string>;
  flash?: H | '';
}): H {
  const s = args.s;
  const e = args.errors ?? {};
  const chk = (name: keyof PosSettings, label: string, hint?: string) =>
    html`<label class="check"><input type="checkbox" name="${name}" value="1"${s[name] ? ' checked' : ''}> <span>${label}${hint ? html`<span class="hint" style="display:block;margin:0">${hint}</span>` : ''}</span></label>`;
  const text = (name: keyof PosSettings, label: string, attrs: { max?: number; placeholder?: string; mode?: string; span?: boolean } = {}) =>
    html`<div${attrs.span ? html` class="pos-span"` : ''}><label for="${name}">${label}</label><input id="${name}" type="text" name="${name}" value="${String(s[name])}" maxlength="${attrs.max ?? 100}"${attrs.placeholder ? html` placeholder="${attrs.placeholder}"` : ''}${attrs.mode ? html` inputmode="${attrs.mode}"` : ''}>${err(e, name)}</div>`;
  return html`<div class="stack-lg" style="max-width:860px">
    ${head('Indstillinger', args.role, 'indstillinger')}
    ${args.flash ?? ''}
    ${Object.keys(e).length ? alert('err', 'Ret de markerede felter.') : ''}
    <form class="stack-lg" method="post" action="/admin/kasse/indstillinger">
      ${csrfField(args.csrf)}
      <section class="card stack">
        <h2>Butik og kvittering</h2>
        <div class="pos-form-grid">
          ${text('store_name', 'Navn', { max: 80 })}
          ${text('cvr', 'CVR-nummer', { max: 20, mode: 'numeric' })}
          ${text('store_address', 'Adresse', { max: 120, span: true })}
          ${text('store_phone', 'Telefon', { max: 30 })}
          ${text('store_email', 'E-mail', { max: 120 })}
          ${text('store_website', 'Hjemmeside', { max: 120 })}
          <div><label for="receipt_width">Papirbredde</label><select id="receipt_width" name="receipt_width">
            ${(['80mm', '58mm', 'a4'] as const).map((w) => html`<option value="${w}"${s.receipt_width === w ? ' selected' : ''}>${w === 'a4' ? 'A4 (almindelig printer)' : `Bonprinter ${w}`}</option>`)}</select></div>
          <div class="pos-span"><label for="receipt_header">Tekst øverst</label><textarea id="receipt_header" name="receipt_header" maxlength="300" rows="2" style="min-height:0">${s.receipt_header}</textarea></div>
          <div class="pos-span"><label for="receipt_footer">Tekst nederst</label><textarea id="receipt_footer" name="receipt_footer" maxlength="300" rows="2" style="min-height:0">${s.receipt_footer}</textarea><p class="hint">Fx betalingsbetingelser eller fortrydelsesret.</p></div>
        </div>
        ${chk('receipt_auto_print', 'Åbn udskrift af kvitteringen automatisk efter hvert salg')}
        <p class="small muted">Valuta: danske kroner (DKK). Visning: dansk. ${args.emailReady ? 'Kvitteringer kan sendes på e-mail.' : 'Kvittering på e-mail kræver RESEND_API_KEY.'}</p>
      </section>
      <section class="card stack">
        <h2>Moms og rabat</h2>
        <div class="pos-form-grid">
          <div><label for="vat_rate">Momssats (%)</label><input id="vat_rate" type="text" name="vat_rate" value="${String(s.vat_rate).replace('.', ',')}" inputmode="decimal">${err(e, 'vat_rate')}<p class="hint">Priserne er inkl. moms.</p></div>
          <div><label for="discount_presets">Hurtigknapper til rabat (%)</label><input id="discount_presets" type="text" name="discount_presets" value="${s.discount_presets}" maxlength="60">${err(e, 'discount_presets')}</div>
          <div><label for="cashier_max_discount">Kasseassistent må give op til (%)</label><input id="cashier_max_discount" type="text" name="cashier_max_discount" value="${s.cashier_max_discount}" inputmode="numeric">${err(e, 'cashier_max_discount')}</div>
          <div><label for="manager_max_discount">Leder må give op til (%)</label><input id="manager_max_discount" type="text" name="manager_max_discount" value="${s.manager_max_discount}" inputmode="numeric">${err(e, 'manager_max_discount')}</div>
        </div>
        <p class="hint">Større rabat end grænsen kræver godkendelse med PIN-kode af en, der må give den. Administratorer har ingen grænse.</p>
      </section>
      <section class="card stack">
        <h2>Betalingsformer</h2>
        ${chk('cash_enabled', 'Kontant')}
        ${chk('cash_rounding', 'Afrund kontantbetalinger til nærmeste 50 øre')}
        <div class="stack" style="border-top:1px solid var(--line);padding-top:16px">
          <h3>Kort med Stripe Terminal</h3>
          <p class="small muted">Kassen sender beløbet til en Stripe-kortlæser på Veyros Stripe-konto, og salget er først betalt, når Stripe har godkendt kortet. Kortdata håndteres kun af kortlæseren og Stripe og gemmes aldrig her.</p>
          ${args.stripeKey ? '' : alert('warn', 'STRIPE_SECRET_KEY er ikke sat, så kortlæseren kan ikke bruges.')}
          <div style="max-width:360px"><label for="stripe_reader_id">Kortlæserens ID</label><input id="stripe_reader_id" type="text" name="stripe_reader_id" value="${s.stripe_reader_id}" placeholder="tmr_..." maxlength="60">${err(e, 'stripe_reader_id')}<p class="hint">Findes i Stripe under Terminal → Læsere. Tomt = Stripe-kort er slået fra.</p></div>
        </div>
        <div class="stack" style="border-top:1px solid var(--line);padding-top:16px">
          ${chk('card_terminal_enabled', 'Kort på separat betalingsterminal', 'Til en terminal, der ikke er forbundet med systemet. Kassereren registrerer betalingen og skal bekræfte, at terminalen har godkendt den. Systemet tager ikke selv betalingen.')}
          <div style="max-width:360px"><label for="card_terminal_label">Navn på knappen</label><input id="card_terminal_label" type="text" name="card_terminal_label" value="${s.card_terminal_label}" maxlength="40"></div>
        </div>
        <div><label for="other_methods">Andre betalingsformer</label><textarea id="other_methods" name="other_methods" rows="3" maxlength="500" style="min-height:0" placeholder="Én pr. linje, fx MobilePay eller Bankoverførsel">${s.other_methods}</textarea><p class="hint">Registreres manuelt af kassereren.</p></div>
        ${err(e, 'methods')}
      </section>
      <section class="card stack">
        <h2>Lager og stregkoder</h2>
        ${chk('show_out_of_stock', 'Vis udsolgte varer i kassen', 'De kan ikke lægges i kurven.')}
        ${chk('scanner_enabled', 'Brug stregkodescanner', 'Scannere, der virker som tastatur (USB eller Bluetooth) og afslutter med Enter.')}
        ${chk('scanner_auto_add', 'Læg varen direkte i kurven ved præcist match på stregkode eller varenummer')}
      </section>
      <section class="card stack">
        <h2>Rettigheder</h2>
        ${chk('cashier_sees_all', 'Kasseassistenter kan se alle kassesalg', 'Ellers ser de kun deres egne. Refusioner kræver altid en leder eller administrator (eller deres PIN-kode).')}
        <p class="small muted">Roller og PIN-koder styres under <a href="/admin/kasse/personale">Personale</a>.</p>
      </section>
      <div><button class="btn btn-primary" type="submit">Gem indstillinger</button></div>
    </form>
    <section class="card stack">
      <h2>Revisionslog</h2>
      ${args.audit.length
        ? html`<div class="table-wrap"><table class="pos-mini"><thead><tr><th>Tidspunkt</th><th>Handling</th><th>Detaljer</th><th>Udført af</th></tr></thead>
            <tbody>${args.audit.map(
              (a) => html`<tr><td>${formatDateTime(a.created_at)}</td><td>${a.action}${a.sale_id ? html` <a href="/admin/kasse/salg/${a.sale_id}">#${a.sale_number}</a>` : ''}</td><td>${a.detail}</td>
                <td>${staffLabel(args.names, a.actor)}${a.approved_by ? html`<small>godkendt af ${staffLabel(args.names, a.approved_by)}</small>` : ''}</td></tr>`,
            )}</tbody></table></div>`
        : html`<p class="muted small">Ingen hændelser endnu.</p>`}
    </section>
  </div>`;
}

// ---------------- Personale ----------------

export function staffPage(args: {
  csrf: string;
  role: Role;
  me: string;
  staff: StaffRow[];
  envAdmins: string[];
  values?: { email: string; name: string; role: Role };
  errors?: Record<string, string>;
  flash?: H | '';
}): H {
  const e = args.errors ?? {};
  const v = args.values ?? { email: '', name: '', role: 'cashier' as Role };
  const fixed = new Set(args.envAdmins);
  return html`<div class="stack-lg" style="max-width:960px">
    ${head('Personale', args.role, 'personale')}
    ${args.flash ?? ''}
    ${e['form'] ? alert('err', e['form']) : ''}
    <section class="card stack">
      <h2>Roller</h2>
      <dl class="pos-kv">
        <dt>${ROLE_LABEL.admin}</dt><dd>Alt i kassen: salg, refusioner, rabat uden grænse, rapporter, ydelser og varer, indstillinger og personale.</dd>
        <dt>${ROLE_LABEL.manager}</dt><dd>Kassen, alle salg, refusioner, rabat op til sin grænse, rapporter samt ydelser og varer. Ikke indstillinger eller personale.</dd>
        <dt>${ROLE_LABEL.cashier}</dt><dd>Kun kassen og egne salg. Store rabatter og refusioner kræver en leders PIN-kode.</dd>
      </dl>
      <p class="small muted">Alle logger ind med et engangslink på e-mail (på /admin/login). Rollerne giver kun adgang til kassen; resten af Veyros admin kræver, at e-mailen står i ADMIN_EMAILS.</p>
    </section>
    <section class="card">
      <div class="table-wrap"><table class="responsive">
        <thead><tr><th>Medarbejder</th><th>Rolle</th><th>PIN-kode</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${args.envAdmins
            .filter((a) => !args.staff.some((s) => s.email.toLowerCase() === a))
            .map((a) => html`<tr><td data-label="Medarbejder"><strong>${a}</strong><div class="small muted">Fra ADMIN_EMAILS</div></td><td data-label="Rolle">${ROLE_LABEL.admin}</td><td data-label="PIN-kode">${a === args.me ? html`<a href="/admin/kasse/pin">Sæt din PIN-kode</a>` : 'Ikke sat'}</td><td data-label="Status"><span class="badge b-ok">Aktiv</span></td><td></td></tr>`)}
          ${args.staff.map((s) => {
            const locked = fixed.has(s.email.toLowerCase()) || s.email.toLowerCase() === args.me;
            return html`<tr>
              <td data-label="Medarbejder"><strong>${s.name || s.email}</strong>${s.name ? html`<div class="small muted">${s.email}</div>` : ''}${fixed.has(s.email.toLowerCase()) ? html`<div class="small muted">Fra ADMIN_EMAILS (altid administrator)</div>` : ''}</td>
              <td data-label="Rolle">${locked
                ? fixed.has(s.email.toLowerCase()) ? ROLE_LABEL.admin : ROLE_LABEL[s.role]
                : html`<form class="row" style="gap:6px;flex-wrap:nowrap" method="post" action="/admin/kasse/personale">
                    ${csrfField(args.csrf)}<input type="hidden" name="email" value="${s.email}"><input type="hidden" name="name" value="${s.name}">
                    <input type="hidden" name="active" value="${s.active ? '1' : '0'}">
                    <label class="visually-hidden" for="role-${s.email}">Rolle</label>
                    <select id="role-${s.email}" name="role" style="width:auto">${ROLES.map((r) => html`<option value="${r}"${s.role === r ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`)}</select>
                    <button class="btn btn-secondary btn-small" type="submit">Gem</button>
                  </form>`}</td>
              <td data-label="PIN-kode">
                <form class="row" style="gap:6px;flex-wrap:nowrap" method="post" action="/admin/kasse/personale/pin">
                  ${csrfField(args.csrf)}<input type="hidden" name="email" value="${s.email}">
                  <label class="visually-hidden" for="pin-${s.email}">Ny PIN-kode</label>
                  <input id="pin-${s.email}" class="pos-qty" type="password" name="pin" inputmode="numeric" maxlength="8" placeholder="${s.pin_hash ? '••••' : 'Ny'}" autocomplete="new-password" required>
                  <button class="btn btn-secondary btn-small" type="submit">${s.pin_hash ? 'Skift' : 'Sæt'}</button>
                </form></td>
              <td data-label="Status">${s.active || fixed.has(s.email.toLowerCase()) ? html`<span class="badge b-ok">Aktiv</span>` : html`<span class="badge b-neutral">Deaktiveret</span>`}</td>
              <td class="num">${locked
                ? ''
                : html`<form method="post" action="/admin/kasse/personale">
                    ${csrfField(args.csrf)}<input type="hidden" name="email" value="${s.email}"><input type="hidden" name="name" value="${s.name}"><input type="hidden" name="role" value="${s.role}">
                    <input type="hidden" name="active" value="${s.active ? '0' : '1'}">
                    <button class="btn btn-secondary btn-small" type="submit">${s.active ? 'Deaktivér' : 'Aktivér'}</button></form>`}</td>
            </tr>`;
          })}
        </tbody>
      </table></div>
    </section>
    <form class="card stack" method="post" action="/admin/kasse/personale">
      ${csrfField(args.csrf)}<input type="hidden" name="active" value="1"><input type="hidden" name="new" value="1">
      <h2>Tilføj medarbejder</h2>
      <div class="pos-form-grid">
        <div><label for="n-email">E-mail</label><input id="n-email" type="email" name="email" value="${v.email}" required>${err(e, 'email')}</div>
        <div><label for="n-name">Navn</label><input id="n-name" type="text" name="name" value="${v.name}" maxlength="80" placeholder="Vises på kvitteringen"></div>
        <div><label for="n-role">Rolle</label><select id="n-role" name="role">${ROLES.map((r) => html`<option value="${r}"${v.role === r ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`)}</select></div>
      </div>
      <div><button class="btn btn-primary" type="submit">Tilføj</button></div>
      <p class="small muted">Deaktiveres en medarbejder, mister personen adgangen til kassen med det samme.</p>
    </form>
  </div>`;
}

export function pinPage(args: { csrf: string; role: Role; hasPin: boolean; error?: string; flash?: H | '' }): H {
  return html`<div class="stack-lg" style="max-width:560px">
    ${head('Min PIN-kode', args.role, 'pin')}
    ${args.flash ?? ''}
    <form class="card stack" method="post" action="/admin/kasse/pin">
      ${csrfField(args.csrf)}
      <p class="small muted">Med din PIN-kode kan du godkende refusioner og store rabatter på en kasseassistents kasse. ${args.hasPin ? 'Du har allerede en PIN-kode; en ny erstatter den.' : ''}</p>
      <div><label for="pin">Ny PIN-kode (4-8 cifre)</label><input id="pin" type="password" name="pin" inputmode="numeric" maxlength="8" required autocomplete="new-password">${args.error ? html`<p class="hint pos-err">${args.error}</p>` : ''}</div>
      <div><button class="btn btn-primary" type="submit">Gem PIN-kode</button></div>
    </form>
  </div>`;
}
