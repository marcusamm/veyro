// Betalingsopfølgning: registrerede betalinger, status og udkast til påmindelser.

import { html } from 'hono/html';
import type { InvoiceRow } from '../env';
import { formatDateTime, formatDay, formatKr, todayDk } from '../lib/format';
import { DOC_STATE_LABEL, METHOD_LABEL, PAY_STATE_LABEL, PAY_STATE_TAG, type PayState, type PayStatus, type PaymentRow } from '../lib/payments';
import { errors, pageHead } from './common';
import { alert, csrfField, type H } from './layout';

const kr = (o: number) => formatKr(o, { decimals: true });

export function payTag(st: PayStatus): H {
  return html`<span class="tag ${PAY_STATE_TAG[st.pay]}">${PAY_STATE_LABEL[st.pay]}${st.pay === 'forfalden' ? ` ${st.overdueDays} dage` : ''}</span>`;
}

export function paymentsSection(d: { inv: InvoiceRow; st: PayStatus; payments: PaymentRow[]; reminders: { id: number; outstanding: number; created_by: string; created_at: number }[]; csrf: string; flash?: string; errs?: string[] }): H {
  const { inv, st } = d;
  if (inv.status !== 'udstedt' || inv.kind !== 'faktura') return html``;
  return html`<section class="card stack" id="betalinger">
  <h2>Betalinger ${payTag(st)}</h2>
  ${errors(d.errs ?? [])}
  <dl class="kv">
    <div><dt>Dokumentstatus</dt><dd>${DOC_STATE_LABEL[st.doc]}</dd></div>
    <div><dt>Fakturabeløb</dt><dd>${kr(inv.total)}</dd></div>
    ${st.credited ? html`<div><dt>Krediteret</dt><dd>−${kr(st.credited)}</dd></div>` : ''}
    <div><dt>Registreret betalt</dt><dd>${kr(st.paid)}</dd></div>
    <div><dt>${st.outstanding < 0 ? 'Overbetalt' : 'Rest'}</dt><dd><strong>${kr(Math.abs(st.outstanding))}</strong></dd></div>
    <div><dt>Betalingsfrist</dt><dd>${inv.due_date ? formatDay(inv.due_date) : '–'}</dd></div>
  </dl>
  ${st.outstanding < 0 ? alert('warn', `Der er registreret ${kr(-st.outstanding)} mere end fakturaen. Registrér en tilbagebetaling (negativt beløb), hvis pengene er sendt retur.`) : ''}
  ${st.foreign ? alert('info', `${st.foreign} betaling(er) i anden valuta end DKK tæller ikke med i resten. Registrér beløbet i DKK.`) : ''}
  <div class="table-wrap"><table class="list stackable"><thead><tr><th>Dato</th><th class="num">Beløb</th><th>Metode</th><th>Reference</th><th>Registreret</th><th></th></tr></thead><tbody>${d.payments.length
    ? d.payments.map(
        (p) => html`<tr${p.deleted_at ? html` class="is-out"` : ''}>
      <td>${formatDay(p.paid_on)}</td><td class="num">${kr(p.amount)}${p.currency !== 'DKK' ? ` ${p.currency}` : ''}${p.amount < 0 ? ' (tilbagebetaling)' : ''}</td>
      <td>${METHOD_LABEL[p.method]}</td><td>${p.reference}${p.note ? html`<div class="muted">${p.note}</div>` : ''}</td>
      <td>${formatDateTime(p.created_at)} · ${p.created_by}${p.deleted_at ? html`<div class="muted">Annulleret ${formatDateTime(p.deleted_at)} af ${p.deleted_by}</div>` : ''}</td>
      <td>${p.deleted_at ? '' : html`<form method="post" action="/job/faktura/${inv.id}/betaling/${p.id}/annuller" data-confirm="Annullér registreringen? Den bevares i historikken.">${csrfField(d.csrf)}<button class="btn btn-ghost btn-small" type="submit">Annullér</button></form>`}</td>
    </tr>`,
      )
    : html`<tr><td colspan="6" class="empty">Ingen betalinger registreret.</td></tr>`}</tbody></table></div>
  <form method="post" action="/job/faktura/${inv.id}/betaling" class="stack-sm">
    ${csrfField(d.csrf)}
    <div class="fields fields-3">
      <div class="field"><label for="p-d">Dato</label><input id="p-d" type="date" name="paid_on" value="${todayDk()}" required></div>
      <div class="field"><label for="p-a">Beløb (negativt = tilbagebetaling)</label><input id="p-a" name="amount" class="in-num" inputmode="decimal" value="${st.outstanding > 0 ? (st.outstanding / 100).toFixed(2).replace('.', ',') : ''}" required></div>
      <div class="field"><label for="p-c">Valuta</label><input id="p-c" name="currency" value="DKK" maxlength="3"></div>
      <div class="field"><label for="p-m">Metode</label><select id="p-m" name="method">${Object.entries(METHOD_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
      <div class="field"><label for="p-r">Reference</label><input id="p-r" name="reference" maxlength="100"></div>
      <div class="field"><label for="p-n">Bemærkning</label><input id="p-n" name="note" maxlength="200"></div>
    </div>
    <label class="check"><input type="checkbox" name="confirm_dup" value="1"> Registrér selvom en betaling med samme beløb og dato/reference findes</label>
    <button class="btn btn-secondary" type="submit">Registrér betaling</button>
    <p class="hint">Betalinger registreres manuelt ud fra kontoudtoget. Systemet er ikke forbundet med banken og laver ingen bankafstemning.</p>
  </form>
  ${st.outstanding > 0
    ? html`<div class="stack-sm"><h3>Påmindelse</h3>
      <form method="post" action="/job/faktura/${inv.id}/paamindelse">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Dan udkast til påmindelse (PDF)</button></form>
      <p class="hint">Udkastet sendes ikke. Det indeholder ingen gebyrer eller renter. Kontrollér det og send det selv, hvis det er relevant.</p>
      ${d.reminders.length ? html`<ul>${d.reminders.map((r) => html`<li><a href="/job/faktura/${inv.id}/paamindelse/${r.id}.pdf">Udkast ${formatDateTime(r.created_at)}</a> · rest ${kr(r.outstanding)} · ${r.created_by}</li>`)}</ul>` : ''}</div>`
    : ''}
</section>`;
}

export type FollowRow = InvoiceRow & { job_number: string; job_name: string; customer_name: string; st: PayStatus };

export function followPage(d: { rows: FollowRow[]; filter: string; totals: { outstanding: number; overdue: number } }): H {
  const tabs: [string, string][] = [
    ['', 'Alle udstedte'],
    ['aabne', 'Ikke fuldt betalt'],
    ['forfalden', 'Forfaldne'],
    ['delvist_betalt', 'Delvist betalt'],
    ['betalt', 'Betalt'],
    ['overbetalt', 'Overbetaling'],
  ];
  return html`<div class="stack-lg">
  ${pageHead(html`<a href="/job/faktura">Fakturaer</a>`, 'Betalingsopfølgning', '', 'Status ud fra udstedte fakturaer, kreditnotaer og manuelt registrerede betalinger. Ikke en bankafstemning.')}
  <div class="stats grid grid-2"><div class="card stat"><div class="n">${kr(d.totals.outstanding)}</div><div class="l">Udestående i alt</div></div><div class="card stat"><div class="n">${kr(d.totals.overdue)}</div><div class="l">Heraf forfaldent</div></div></div>
  <nav class="tabs">${tabs.map(([k, l]) => html`<a href="/job/faktura/opfolgning${k ? `?vis=${k}` : ''}"${d.filter === k ? html` aria-current="page"` : ''}>${l}</a>`)}</nav>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Faktura</th><th>Kunde</th><th>Forfald</th><th class="num">Total</th><th class="num">Krediteret</th><th class="num">Betalt</th><th class="num">Rest</th><th>Status</th></tr></thead>
    <tbody>${d.rows.length
      ? d.rows.map(
          (i) => html`<tr class="row-link" data-href="/job/faktura/${i.id}#betalinger">
        <td class="cell-main"><a class="title" href="/job/faktura/${i.id}#betalinger">${i.kind === 'kreditnota' ? 'Kreditnota' : 'Faktura'} ${i.number}</a><div class="muted">${i.job_number} ${i.job_name}</div></td>
        <td data-label="Kunde">${i.customer_name || '–'}</td>
        <td data-label="Forfald">${i.due_date ? formatDay(i.due_date) : '–'}</td>
        <td class="num" data-label="Total">${kr(i.total)}</td>
        <td class="num" data-label="Krediteret">${i.st.credited ? kr(i.st.credited) : '–'}</td>
        <td class="num" data-label="Betalt">${kr(i.st.paid)}</td>
        <td class="num" data-label="Rest">${i.kind === 'faktura' ? kr(i.st.outstanding) : '–'}</td>
        <td data-label="Status">${DOC_STATE_LABEL[i.st.doc]} ${i.kind === 'faktura' ? payTag(i.st) : ''}</td>
      </tr>`,
        )
      : html`<tr><td colspan="8" class="empty">Ingen fakturaer.</td></tr>`}</tbody>
  </table></div></div>
</div>`;
}

export const FILTERS: Record<string, (s: PayStatus) => boolean> = {
  aabne: (s) => s.outstanding > 0,
  forfalden: (s) => s.pay === 'forfalden',
  delvist_betalt: (s) => s.paid > 0 && s.outstanding > 0,
  betalt: (s) => s.pay === 'betalt',
  overbetalt: (s) => s.pay === 'overbetalt',
};
export type { PayState };
