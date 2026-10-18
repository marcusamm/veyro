import { html } from 'hono/html';
import type { AdminRequestRow, CustomerListRow } from '../lib/db';
import { MAX_LINES, VAT_PERCENT, type AdminInvoice, type DraftForm } from '../lib/invoices';
import { formatDate, formatDateShort, formatKr } from '../lib/format';
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
  <div class="row"><a class="btn btn-accent" href="/admin/fakturaer">Opret faktura</a></div>
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

// ---------------- Fakturaer ----------------

const ADMIN_INVOICE_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Kladde', cls: 'b-neutral' },
  open: { label: 'Afventer betaling', cls: 'b-warn' },
  paid: { label: 'Betalt', cls: 'b-ok' },
  void: { label: 'Annulleret', cls: 'b-neutral' },
  uncollectible: { label: 'Ikke betalt', cls: 'b-err' },
};

const INVOICE_FLASH: Record<string, string> = {
  kladde: 'Fakturaen er gemt som kladde. Den er ikke sendt til kunden endnu.',
  sendt: 'Fakturaen er sendt til kunden på e-mail.',
  slettet: 'Kladden er slettet.',
  betalt: 'Fakturaen er markeret som betalt.',
  annulleret: 'Fakturaen er annulleret.',
};

function invoiceActions(inv: AdminInvoice, csrf: string): H {
  const form = (action: string, label: string, cls: string, confirm?: string) =>
    html`<form method="post" action="/admin/fakturaer/${inv.id}/${action}" class="inline"${confirm ? html` data-confirm="${confirm}"` : ''}>${csrfField(csrf)}<button class="btn btn-small ${cls}" type="submit">${label}</button></form>`;
  const dash = `https://dashboard.stripe.com/${inv.livemode === false ? 'test/' : ''}invoices/${inv.id}`;
  return html`<div class="row" style="gap:8px;justify-content:flex-end">
    ${inv.status === 'draft' ? form('send', 'Send', 'btn-primary', 'Send fakturaen til kunden nu?') : ''}
    ${inv.status === 'draft' ? form('slet', 'Slet', 'btn-danger', 'Slet kladden?') : ''}
    ${inv.status === 'open' ? form('betalt', 'Marker betalt', 'btn-secondary', 'Marker fakturaen som betalt uden for Stripe (fx bankoverførsel)?') : ''}
    ${inv.status === 'open' ? form('annuller', 'Annullér', 'btn-danger', 'Annullér fakturaen? Det kan ikke fortrydes.') : ''}
    ${inv.hosted_invoice_url ? html`<a class="small" href="${inv.hosted_invoice_url}" rel="noopener" target="_blank">Vis</a>` : ''}
    ${inv.invoice_pdf ? html`<a class="small" href="${inv.invoice_pdf}" rel="noopener">PDF</a>` : ''}
    <a class="small" href="${dash}" rel="noopener" target="_blank">Stripe</a>
  </div>`;
}

function lineRow(i: number, f: DraftForm | null, errField: string | null): H {
  const l = f?.lines[i] ?? { description: '', quantity: '', price: '' };
  const inv = (k: string) => (errField === `line${i}_${k}` ? html` aria-invalid="true"` : '');
  return html`<div class="inv-line">
    <div class="field"><label for="line${i}_desc">${i === 0 ? 'Beskrivelse' : html`<span class="visually-hidden">Beskrivelse, linje ${i + 1}</span>`}</label>
      <input id="line${i}_desc" name="line${i}_desc" type="text" maxlength="200" value="${l.description}"${i === 0 ? html` required placeholder="Fx Opsætning af internt ordresystem"` : ''}${inv('desc')}></div>
    <div class="field"><label for="line${i}_qty">${i === 0 ? 'Antal' : html`<span class="visually-hidden">Antal, linje ${i + 1}</span>`}</label>
      <input id="line${i}_qty" name="line${i}_qty" type="number" min="1" max="1000" step="1" inputmode="numeric" value="${l.quantity || (i === 0 ? '1' : '')}"${inv('qty')}></div>
    <div class="field"><label for="line${i}_price">${i === 0 ? 'Pris pr. stk. (kr. ekskl. moms)' : html`<span class="visually-hidden">Pris, linje ${i + 1}</span>`}</label>
      <input id="line${i}_price" name="line${i}_price" type="text" inputmode="decimal" maxlength="15" value="${l.price}"${i === 0 ? html` required placeholder="Fx 4.500"` : ''}${inv('price')}></div>
  </div>`;
}

export function adminInvoicesPage(args: {
  csrf: string;
  formKey: string;
  invoices: AdminInvoice[] | null;
  customers: CustomerListRow[];
  form: DraftForm | null;
  error: string | null;
  errorField: string | null;
  flash: string | null;
}): H {
  const f = args.form;
  const err = (k: string) => (args.errorField === k ? html` aria-invalid="true"` : '');
  const flash = args.flash ? INVOICE_FLASH[args.flash] : null;
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Admin</p><h1>Fakturaer</h1><p class="lead">Opret en faktura til en kunde, fx efter et tilbud. Fakturaen laves i Stripe, og kunden kan betale med kort via linket i e-mailen.</p></div>
  ${flash ? alert('ok', flash) : ''}
  <section class="card stack" aria-labelledby="ny-h">
    <h2 id="ny-h">Ny faktura</h2>
    ${args.error ? alert('err', args.error) : ''}
    <form method="post" action="/admin/fakturaer" class="stack" novalidate>
      ${csrfField(args.csrf)}
      <input type="hidden" name="key" value="${args.formKey}">
      <div class="grid grid-2">
        <div class="field"><label for="email">Kundens e-mail</label>
          <input id="email" name="email" type="email" required maxlength="254" autocomplete="off" list="kunder" value="${f?.email ?? ''}"${err('email')}>
          <datalist id="kunder">${args.customers.map((c) => html`<option value="${c.email}">${c.name ?? ''}</option>`)}</datalist>
        </div>
        <div class="field"><label for="name">Navn eller firma</label>
          <input id="name" name="name" type="text" required maxlength="100" value="${f?.name ?? ''}"${err('name')}></div>
      </div>
      <fieldset class="stack" style="border:0;padding:0;margin:0">
        <legend class="small muted" style="margin-bottom:8px">Linjer (op til ${MAX_LINES}). Tomme linjer springes over.</legend>
        ${Array.from({ length: MAX_LINES }, (_, i) => lineRow(i, f, args.errorField))}
      </fieldset>
      <div class="grid grid-2">
        <div class="field"><label for="days">Betalingsfrist (dage)</label>
          <input id="days" name="days" type="number" min="0" max="90" step="1" inputmode="numeric" value="${f?.days || '8'}"${err('days')}></div>
        <div class="field"><span class="label-like">Moms</span>
          <label class="check"><input type="checkbox" name="vat" value="1"${!f || f.vat ? html` checked` : ''}> Læg ${VAT_PERCENT} % moms oveni priserne</label></div>
      </div>
      <div class="field"><label for="memo">Besked på fakturaen (valgfri)</label>
        <textarea id="memo" name="memo" rows="3" maxlength="500" placeholder="Fx Tak for ordren. Faktura i henhold til tilbud af 18. oktober.">${f?.memo ?? ''}</textarea></div>
      <div class="row">
        <button class="btn btn-accent" type="submit" name="action" value="send" data-loading="Sender …" data-confirm-btn="Send fakturaen til kunden nu?">Opret og send</button>
        <button class="btn btn-secondary" type="submit" name="action" value="draft" data-loading="Gemmer …">Gem som kladde</button>
      </div>
      <p class="hint">"Gem som kladde" sender intet. Du kan se kladden igennem nedenfor eller i Stripe og sende den bagefter.</p>
    </form>
  </section>
  <section class="card" aria-labelledby="liste-h">
    <h2 id="liste-h">Seneste fakturaer</h2>
    ${args.invoices === null
      ? alert('err', 'Fakturaerne kunne ikke hentes fra Stripe lige nu.')
      : args.invoices.length === 0
        ? html`<p class="empty">Ingen fakturaer endnu.</p>`
        : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Kunde</th><th scope="col">Nummer</th><th scope="col">Status</th><th scope="col">Forfald</th><th scope="col" class="num">Beløb</th><th scope="col"><span class="visually-hidden">Handlinger</span></th></tr></thead>
      <tbody>${args.invoices.map((inv) => {
        const st = ADMIN_INVOICE_STATUS[inv.status ?? ''] ?? { label: inv.status ?? '–', cls: 'b-neutral' };
        return html`<tr id="${inv.id}">
          <td data-label="Kunde"><strong>${inv.customer_name ?? '–'}</strong><br><span class="small muted">${inv.customer_email ?? ''}</span></td>
          <td data-label="Nummer">${inv.number ?? '–'}<br><span class="small muted">${formatDateShort(inv.created)}</span></td>
          <td data-label="Status"><span class="badge ${st.cls}">${st.label}</span></td>
          <td data-label="Forfald">${formatDateShort(inv.due_date)}</td>
          <td data-label="Beløb" class="num">${formatKr(inv.total, { decimals: true })}</td>
          <td data-label="">${invoiceActions(inv, args.csrf)}</td>
        </tr>`;
      })}</tbody></table></div>`}
  </section>
</div>`;
}
