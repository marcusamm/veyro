import { html } from 'hono/html';
import type { AdminRequestRow, CustomerListRow } from '../lib/db';
import { MAX_LINES, VAT_PERCENT, type AdminInvoice, type DraftForm } from '../lib/invoices';
import type { AdminSubscription } from '../lib/admin-subscriptions';
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
  <div class="row"><a class="btn btn-accent" href="/admin/tilbud">Nyt tilbud med betalingslink</a><a class="btn btn-secondary" href="/admin/abonnementer">Abonnement via faktura</a><a class="btn btn-secondary" href="/admin/fakturaer">Engangsfaktura</a></div>
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
          <td data-label="Kunde"><a href="/admin/kunder/${c.id}"><strong>${c.company ?? c.name ?? '–'}</strong></a><br><span class="small">${c.email}</span></td>
          <td data-label="Plan">${getPlan(c.plan)?.name ?? (c.status ? 'Individuel pris' : '–')}</td>
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

function lineRow(i: number, f: DraftForm | null, errField: string | null, priceLabel = 'Pris pr. stk. (kr. ekskl. moms)', placeholder = 'Fx Opsætning af internt ordresystem'): H {
  const l = f?.lines[i] ?? { description: '', quantity: '', price: '' };
  const inv = (k: string) => (errField === `line${i}_${k}` ? html` aria-invalid="true"` : '');
  return html`<div class="inv-line">
    <div class="field"><label for="line${i}_desc">${i === 0 ? 'Beskrivelse' : html`<span class="visually-hidden">Beskrivelse, linje ${i + 1}</span>`}</label>
      <input id="line${i}_desc" name="line${i}_desc" type="text" maxlength="200" value="${l.description}"${i === 0 ? html` required placeholder="${placeholder}"` : ''}${inv('desc')}></div>
    <div class="field"><label for="line${i}_qty">${i === 0 ? 'Antal' : html`<span class="visually-hidden">Antal, linje ${i + 1}</span>`}</label>
      <input id="line${i}_qty" name="line${i}_qty" type="number" min="1" max="1000" step="1" inputmode="numeric" value="${l.quantity || (i === 0 ? '1' : '')}"${inv('qty')}></div>
    <div class="field"><label for="line${i}_price">${i === 0 ? priceLabel : html`<span class="visually-hidden">Pris, linje ${i + 1}</span>`}</label>
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
  <div><p class="eyebrow">Admin</p><h1>Fakturaer</h1><p class="lead">Engangsfakturaer, fx for ekstra arbejde. Faste månedlige aftaler oprettes under <a href="/admin/abonnementer">Abonnementer</a>. Alle fakturaer, også abonnementernes, vises nederst.</p></div>
  ${flash ? alert('ok', flash) : ''}
  <section class="card stack" aria-labelledby="ny-h">
    <h2 id="ny-h">Ny engangsfaktura</h2>
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

// ---------------- Admin-login ----------------

export function adminLoginPage(args: { csrf: string; email?: string; error?: string; sent?: boolean; devLink?: string | null }): H {
  if (args.sent) {
    return html`<div class="narrow stack-lg">
  <div><p class="eyebrow">Veyro admin</p><h1>Tjek din indbakke</h1>
    <p class="lead">Hvis e-mailen hører til en admin, har vi sendt et login-link. Det virker i 15 minutter og kan kun bruges én gang.</p></div>
  ${args.devLink ? alert('info', html`Udviklingstilstand: <a href="${args.devLink}">åbn linket</a>`) : ''}
  <p class="muted small">Du forbliver logget ind i denne browser i et år, indtil du selv logger ud.</p>
  <p><a href="/admin/login">Prøv igen</a></p>
</div>`;
  }
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow">Veyro admin</p><h1>Log ind</h1><p class="lead">Kun for Veyros medarbejdere. Skriv din e-mail, så sender vi et login-link.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/login" class="card stack" novalidate>
    ${csrfField(args.csrf)}
    <div class="field"><label for="email">E-mail</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" value="${args.email ?? ''}"></div>
    <button class="btn btn-primary btn-block" type="submit" data-loading="Sender …">Send login-link</button>
  </form>
</div>`;
}

// ---------------- Abonnementer ----------------

const SUB_STATUS: Record<string, { label: string; cls: string }> = {
  trialing: { label: 'Gratis måned', cls: 'b-ok' },
  active: { label: 'Aktiv', cls: 'b-ok' },
  past_due: { label: 'Betaling mangler', cls: 'b-err' },
  unpaid: { label: 'Ubetalt', cls: 'b-err' },
  incomplete: { label: 'Afventer første betaling', cls: 'b-warn' },
  canceled: { label: 'Stoppet', cls: 'b-neutral' },
  paused: { label: 'Sat på pause', cls: 'b-neutral' },
};

const SUB_FLASH: Record<string, string> = {
  oprettet: 'Abonnementet er oprettet. Kunden får en velkomstmail med link til at tilføje kort, og fakturaen kommer i en separat mail.',
  'oprettet-gratis': 'Abonnementet er oprettet med første måned gratis. Kunden får en velkomstmail med link til at tilføje kort før første betaling.',
  kortlink: 'Velkomstmailen med kortlink er sendt igen.',
  pris: 'Prisen er ændret. Den nye pris gælder fra næste faktura.',
  tilbud: 'Tilbuddet er lagt på abonnementet og trækkes fra den næste betalte faktura.',
  'tilbud-fjernet': 'Tilbuddet er fjernet.',
  opsagt: 'Abonnementet stopper ved udgangen af den nuværende periode.',
  genoptaget: 'Abonnementet fortsætter.',
};

function productName(p: AdminSubscription['items']['data'][number]['price']['product']): string {
  return typeof p === 'string' ? 'Abonnement' : (p.name ?? 'Abonnement');
}

function offerText(s: AdminSubscription): string | null {
  const d = s.discounts?.find((x) => typeof x !== 'string');
  const c = d && typeof d !== 'string' ? d.coupon : undefined;
  if (!c) return null;
  if (typeof c === 'string') return 'Rabat';
  if (c.percent_off) return `${c.percent_off} % rabat`;
  if (c.amount_off) return `${formatKr(c.amount_off)} rabat`;
  return c.name ?? 'Rabat';
}

function offerFields(prefix: string): H {
  return html`<div class="row" style="gap:8px;align-items:flex-end">
    <div class="field" style="flex:1 1 140px"><label for="${prefix}offer">Rabat</label>
      <input id="${prefix}offer" name="offer" type="text" inputmode="decimal" maxlength="12" placeholder="Fx 500 eller 50"></div>
    <div class="field" style="flex:0 0 120px;margin-top:0"><label for="${prefix}kind" class="visually-hidden">Enhed</label>
      <select id="${prefix}kind" name="offer_kind"><option value="kr">kr.</option><option value="pct">%</option></select></div>
  </div>`;
}

function subRow(s: AdminSubscription, csrf: string): H {
  const st = SUB_STATUS[s.status] ?? { label: s.status, cls: 'b-neutral' };
  const cust = typeof s.customer === 'string' ? { email: null, name: null } : s.customer;
  const monthly = s.items.data.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  const next = s.status === 'trialing' ? s.trial_end : (s.current_period_end ?? s.items.data[0]?.current_period_end ?? null);
  const offer = offerText(s);
  const live = !['canceled', 'incomplete_expired'].includes(s.status);
  const post = (action: string) => `/admin/abonnementer/${s.id}/${action}`;
  return html`<tr id="${s.id}">
    <td data-label="Kunde"><strong>${cust.name ?? '–'}</strong><br><span class="small muted">${cust.email ?? ''}</span></td>
    <td data-label="Indhold">${s.items.data.map((i) => html`<div class="small">${i.quantity && i.quantity > 1 ? `${i.quantity} × ` : ''}${productName(i.price.product)}</div>`)}</td>
    <td data-label="Status"><span class="badge ${st.cls}">${st.label}</span>${s.cancel_at_period_end ? html`<br><span class="small muted">Stopper ${formatDateShort(s.cancel_at ?? next)}</span>` : ''}${offer ? html`<br><span class="small">Tilbud: ${offer}</span>` : ''}<br><span class="small muted">${s.collection_method === 'charge_automatically' ? 'Kort tilknyttet' : 'Betaler via faktura'}</span></td>
    <td data-label="Næste faktura">${live ? formatDateShort(next) : '–'}</td>
    <td data-label="Pr. måned" class="num">${formatKr(monthly, { decimals: true })}<br><span class="small muted">ekskl. moms</span></td>
    <td data-label="">${live
      ? html`<details class="sub-edit"><summary>Ændr</summary>
        <div class="stack" style="margin-top:12px">
          ${s.items.data.map((i, n) => html`<form method="post" action="${post('pris')}" class="row" style="gap:8px;align-items:flex-end">${csrfField(csrf)}
            <input type="hidden" name="item" value="${i.id}">
            <div class="field" style="flex:1 1 160px"><label for="p-${i.id}">Ny månedspris${s.items.data.length > 1 ? `, linje ${n + 1}` : ''} (kr. ekskl. moms)</label>
              <input id="p-${i.id}" name="price" type="text" inputmode="decimal" maxlength="15" required placeholder="${((i.price.unit_amount ?? 0) / 100).toLocaleString('da-DK')}"></div>
            <button class="btn btn-small btn-secondary" type="submit" data-confirm-btn="Ændre prisen fra næste faktura?">Gem pris</button></form>`)}
          <form method="post" action="${post('tilbud')}" class="stack" style="gap:8px">${csrfField(csrf)}
            <p class="small muted" style="margin:0">Tilbud: rabat på næste betalte måned. Derefter gælder den normale pris igen.</p>
            ${offerFields(`o-${s.id}-`)}
            <div class="row" style="gap:8px"><button class="btn btn-small btn-secondary" type="submit">Giv tilbud</button></div></form>
          ${s.collection_method !== 'charge_automatically' ? html`<form method="post" action="${post('kortlink')}" class="inline">${csrfField(csrf)}<button class="btn btn-small btn-secondary" type="submit">Send kortlink igen</button></form>` : ''}
          ${offer ? html`<form method="post" action="${post('fjern-tilbud')}" class="inline">${csrfField(csrf)}<button class="btn btn-small btn-danger" type="submit">Fjern tilbud</button></form>` : ''}
          ${s.cancel_at_period_end
            ? html`<form method="post" action="${post('genoptag')}" class="inline">${csrfField(csrf)}<button class="btn btn-small btn-secondary" type="submit">Fortsæt abonnementet</button></form>`
            : html`<form method="post" action="${post('opsig')}" class="inline" data-confirm="Stoppe abonnementet ved udgangen af den nuværende periode?">${csrfField(csrf)}<button class="btn btn-small btn-danger" type="submit">Opsig</button></form>`}
          <a class="small" href="https://dashboard.stripe.com/subscriptions/${s.id}" rel="noopener" target="_blank">Åbn i Stripe</a>
        </div></details>`
      : html`<a class="small" href="https://dashboard.stripe.com/subscriptions/${s.id}" rel="noopener" target="_blank">Stripe</a>`}</td>
  </tr>`;
}

export function adminSubscriptionsPage(args: {
  csrf: string;
  formKey: string;
  subs: AdminSubscription[] | null;
  customers: CustomerListRow[];
  form: DraftForm | null;
  body: Record<string, unknown> | null;
  error: string | null;
  errorField: string | null;
  flash: string | null;
}): H {
  const f = args.form;
  const err = (k: string) => (args.errorField === k ? html` aria-invalid="true"` : '');
  const flash = args.flash ? SUB_FLASH[args.flash] : null;
  const offerVal = typeof args.body?.['offer'] === 'string' ? (args.body['offer'] as string) : '';
  const pct = args.body?.['offer_kind'] === 'pct';
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Admin</p><h1>Abonnementer</h1><p class="lead">Opret et månedligt abonnement til en kunde. Stripe sender en faktura hver måned, som kunden betaler via linket i e-mailen.</p></div>
  ${flash ? alert('ok', flash) : ''}
  <section class="card stack" aria-labelledby="ny-h">
    <h2 id="ny-h">Nyt abonnement</h2>
    ${args.error ? alert('err', args.error) : ''}
    <form method="post" action="/admin/abonnementer" class="stack" novalidate>
      ${csrfField(args.csrf)}
      <input type="hidden" name="key" value="${args.formKey}">
      <div class="grid grid-2">
        <div class="field"><label for="email">Kundens e-mail</label>
          <input id="email" name="email" type="email" required maxlength="254" autocomplete="off" list="kunder" value="${f?.email ?? ''}"${err('email')}>
          <datalist id="kunder">${args.customers.map((c) => html`<option value="${c.email}">${c.name ?? ''}</option>`)}</datalist></div>
        <div class="field"><label for="name">Navn eller firma</label>
          <input id="name" name="name" type="text" required maxlength="100" value="${f?.name ?? ''}"${err('name')}></div>
      </div>
      <fieldset class="stack" style="border:0;padding:0;margin:0">
        <legend class="small muted" style="margin-bottom:8px">Det kunden betaler for hver måned (op til ${MAX_LINES} linjer). Tomme linjer springes over.</legend>
        ${Array.from({ length: MAX_LINES }, (_, i) => lineRow(i, f, args.errorField, 'Månedspris (kr. ekskl. moms)', 'Fx Internt system til ordrer og varekontrol'))}
      </fieldset>
      <div class="grid grid-2">
        <div class="field"><label for="days">Betalingsfrist pr. faktura (dage)</label>
          <input id="days" name="days" type="number" min="0" max="90" step="1" inputmode="numeric" value="${f?.days || '8'}"${err('days')}></div>
        <div class="field"><span class="label-like">Moms</span>
          <label class="check"><input type="checkbox" name="vat" value="1"${!f || f.vat ? html` checked` : ''}> Læg ${VAT_PERCENT} % moms oveni priserne</label></div>
      </div>
      <div class="grid grid-2">
        <div><div class="row" style="gap:8px;align-items:flex-end">
          <div class="field" style="flex:1 1 140px"><label for="offer">Tilbud på første betalte måned (valgfri)</label>
            <input id="offer" name="offer" type="text" inputmode="decimal" maxlength="12" placeholder="Fx 500 eller 50" value="${offerVal}"${err('offer')}></div>
          <div class="field" style="flex:0 0 120px;margin-top:0"><label for="offer_kind" class="visually-hidden">Enhed</label>
            <select id="offer_kind" name="offer_kind"><option value="kr">kr.</option><option value="pct"${pct ? html` selected` : ''}>%</option></select></div>
        </div><p class="hint">Rabatten gælder én måned. Derefter betaler kunden den normale pris.</p></div>
        <div class="field"><label for="memo">Note på fakturaerne (valgfri)</label>
          <input id="memo" name="memo" type="text" maxlength="500" value="${f?.memo ?? ''}" placeholder="Fx Aftale af 18. oktober"></div>
      </div>
      <div class="row">
        <button class="btn btn-accent" type="submit" name="action" value="free" data-loading="Opretter …" data-confirm-btn="Opret abonnementet med første måned gratis?">Opret med første måned gratis</button>
        <button class="btn btn-secondary" type="submit" name="action" value="paid" data-loading="Opretter …" data-confirm-btn="Opret abonnementet og send første faktura nu?">Opret og fakturér fra i dag</button>
      </div>
      <p class="hint">Kunden får straks en velkomstmail med link til at tilføje sit kort, så betalingen trækkes automatisk. Med første måned gratis sker første betaling om en måned. Ellers sendes første faktura med det samme. Uden kort kommer fakturaerne på mail.</p>
    </form>
  </section>
  <section class="card" aria-labelledby="liste-h">
    <h2 id="liste-h">Abonnementer</h2>
    ${args.subs === null
      ? alert('err', 'Abonnementerne kunne ikke hentes fra Stripe lige nu.')
      : args.subs.length === 0
        ? html`<p class="empty">Ingen abonnementer endnu.</p>`
        : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Kunde</th><th scope="col">Indhold</th><th scope="col">Status</th><th scope="col">Næste faktura</th><th scope="col" class="num">Pr. måned</th><th scope="col"><span class="visually-hidden">Handlinger</span></th></tr></thead>
      <tbody>${args.subs.map((s) => subRow(s, args.csrf))}</tbody></table></div>`}
  </section>
</div>`;
}
