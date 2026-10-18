import { html } from 'hono/html';
import type { AdminRequestRow, CustomerListRow } from '../lib/db';
import { formatDate, formatDateShort } from '../lib/format';
import { getPlan } from '../lib/plans';
import { alert, csrfField, type H } from './layout';
import { REQUEST_STATUSES, REQUEST_TYPES, badgeClass, subscriptionState } from './status';

function custStatus(c: CustomerListRow): H {
  if (!c.status) return html`<span class="badge b-neutral">Intet abonnement</span>`;
  const st = subscriptionState({
    status: c.status,
    cancel_at_period_end: c.cancel_at_period_end ?? 0,
    payment_failed: c.payment_failed ?? 0,
    cancel_at: null,
    current_period_end: null,
  } as any)!;
  const label = st.cancelPending ? 'Opsagt' : st.label;
  return html`<span class="badge ${badgeClass(st.tone)}">${label}</span>`;
}

export function adminOverviewPage(args: { customers: CustomerListRow[]; requests: AdminRequestRow[] }): H {
  const active = args.customers.filter((c) => c.status && ['active', 'trialing', 'past_due'].includes(c.status)).length;
  const failed = args.customers.filter((c) => c.payment_failed || c.status === 'past_due' || c.status === 'unpaid').length;
  const open = args.requests.filter((r) => r.status !== 'resolved').length;
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Admin</p><h1>Oversigt</h1></div>
  <div class="grid grid-3">
    <a class="card" href="/admin/kunder" style="text-decoration:none"><div class="muted small">Aktive abonnementer</div><div class="price-big">${active}</div></a>
    <a class="card" href="/admin/kunder" style="text-decoration:none"><div class="muted small">Betaling fejlet</div><div class="price-big">${failed}</div></a>
    <a class="card" href="/admin/henvendelser" style="text-decoration:none"><div class="muted small">Åbne henvendelser</div><div class="price-big">${open}</div></a>
  </div>
  <section class="card">
    <div class="row between"><h2 style="margin:0">Seneste åbne henvendelser</h2><a href="/admin/henvendelser" class="small">Se alle</a></div>
    ${requestsList(args.requests.filter((r) => r.status !== 'resolved').slice(0, 5), null)}
  </section>
</div>`;
}

export function adminCustomersPage(args: { customers: CustomerListRow[] }): H {
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Admin</p><h1>Kunder</h1><p class="lead">${args.customers.length} kunder i alt.</p></div>
  <section class="card">
    ${args.customers.length === 0
      ? html`<p class="empty">Ingen kunder endnu.</p>`
      : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Kunde</th><th scope="col">Plan</th><th scope="col">Status</th><th scope="col">Åbne henv.</th><th scope="col">Oprettet</th></tr></thead>
      <tbody>${args.customers.map(
        (c) => html`<tr>
          <td data-label="Kunde"><strong>${c.name ?? '–'}</strong><br><a href="mailto:${c.email}" class="small">${c.email}</a></td>
          <td data-label="Plan">${getPlan(c.plan)?.name ?? '–'}</td>
          <td data-label="Status">${custStatus(c)}</td>
          <td data-label="Åbne henv.">${c.open_requests}</td>
          <td data-label="Oprettet">${formatDateShort(c.created_at)}</td>
        </tr>`,
      )}</tbody></table></div>`}
  </section>
</div>`;
}

function requestsList(rows: AdminRequestRow[], csrf: string | null): H {
  if (rows.length === 0) return html`<p class="empty">Ingen henvendelser.</p>`;
  return html`<ul class="list" style="margin-top:16px">${rows.map((r) => {
    const st = REQUEST_STATUSES[r.status] ?? { label: r.status, tone: 'neutral' as const };
    return html`<li id="h-${r.id}">
      <div class="item-head"><h3>#${r.id} · ${r.title}</h3><span class="badge ${badgeClass(st.tone)}">${st.label}</span></div>
      <div class="meta">${REQUEST_TYPES[r.type] ?? r.type} · ${r.name ? html`${r.name} · ` : ''}<a href="mailto:${r.email}">${r.email}</a> · ${formatDate(r.created_at)}</div>
      <p class="prewrap small" style="margin-top:8px">${r.description}</p>
      ${csrf
        ? html`<form method="post" action="/admin/henvendelser/${r.id}/status" class="row" style="margin-top:8px">
            ${csrfField(csrf)}
            <label class="visually-hidden" for="status-${r.id}">Status for henvendelse ${r.id}</label>
            <select id="status-${r.id}" name="status" style="width:auto;min-width:160px">
              ${Object.entries(REQUEST_STATUSES).map(
                ([k, v]) => html`<option value="${k}" ${k === r.status ? 'selected' : ''}>${v.label}</option>`,
              )}
            </select>
            <button class="btn btn-secondary btn-small" type="submit">Opdater status</button>
          </form>`
        : ''}
    </li>`;
  })}</ul>`;
}

export function adminRequestsPage(args: { csrf: string; requests: AdminRequestRow[]; filter: string | null; updated?: boolean }): H {
  const filters: Array<[string | null, string]> = [
    [null, 'Alle'],
    ['received', 'Modtaget'],
    ['in_progress', 'I gang'],
    ['resolved', 'Løst'],
  ];
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Admin</p><h1>Henvendelser</h1></div>
  ${args.updated ? alert('ok', 'Status er opdateret.') : ''}
  <nav aria-label="Filtrér efter status" class="row">
    ${filters.map(
      ([k, label]) => html`<a class="btn btn-small ${args.filter === k ? 'btn-primary' : 'btn-secondary'}" href="/admin/henvendelser${k ? `?status=${k}` : ''}"${args.filter === k ? html` aria-current="page"` : ''}>${label}</a>`,
    )}
  </nav>
  <section class="card">${requestsList(args.requests, args.csrf)}</section>
</div>`;
}
