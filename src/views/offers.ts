import { html, raw } from 'hono/html';
import type { CustomerRow, SubscriptionRow } from '../env';
import { formatDate, formatDateShort, formatKr } from '../lib/format';
import { VAT_PERCENT } from '../lib/invoices';
import {
  DEFAULT_VALID_DAYS,
  INTERVAL_LABEL,
  offerState,
  offerTotals,
  type ExistingBilling,
  type Interval,
  type OfferForm,
  type OfferRow,
  type PaymentRow,
  type PriceChangeRow,
} from '../lib/offers';
import { alert, csrfField, type H } from './layout';
import { badgeClass, subscriptionState } from './status';
import { legalLinks } from './legal';
import { LEGAL_DOCS, LEGAL_VERSION, type Acceptance, type LegalDocKey } from '../lib/legal';

const kr = (n: number) => formatKr(n, { decimals: n % 100 !== 0 });
const iv = (i: string | null | undefined) => INTERVAL_LABEL[(i === 'year' ? 'year' : 'month') as Interval];

/** Tilbuddets nøgletal som korte linjer (mail og admin). */
export function offerSummaryLines(o: OfferRow): string[] {
  const t = offerTotals(o);
  const lines = [
    `${o.service}: ${kr(t.recurringNet)} ekskl. moms ${iv(o.interval).per}${o.vat ? ` (${kr(t.recurringTotal)} inkl. ${VAT_PERCENT} % moms)` : ''}`,
  ];
  if (o.setup_amount) {
    lines.push(
      o.setup_settled
        ? `${o.setup_description ?? 'Engangsbeløb'}: allerede faktureret, opkræves ikke igen`
        : `${o.setup_description ?? 'Engangsbeløb'}: ${kr(t.setupNet)} ekskl. moms, betales én gang${o.vat ? ` (${kr(t.setupTotal)} inkl. moms)` : ''}`,
    );
  }
  if (o.first_charge_at) lines.push(`Første periode er allerede betalt. Første opkrævning: ${formatDate(o.first_charge_at)}`);
  lines.push(`Løbende abonnement uden binding, fornyes ${iv(o.interval).every}, til du opsiger det`);
  return lines;
}

const OFFER_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'Sendt, afventer kunden', cls: 'b-warn' },
  expired: { label: 'Link udløbet', cls: 'b-neutral' },
  processing: { label: 'Afventer bekræftelse fra Stripe', cls: 'b-warn' },
  active: { label: 'Aktiv', cls: 'b-ok' },
  withdrawn: { label: 'Trukket tilbage', cls: 'b-neutral' },
  ended: { label: 'Abonnement stoppet', cls: 'b-neutral' },
};

export function offerBadge(o: OfferRow): H {
  const s = OFFER_STATE[offerState(o)] ?? { label: o.status, cls: 'b-neutral' };
  return html`<span class="badge ${s.cls}">${s.label}</span>`;
}

function termsText(o: OfferRow): string {
  const i = iv(o.interval);
  return `Abonnementet er løbende og uden binding. Det fornyes automatisk ${i.every}, og betalingen trækkes på dit kort, til du opsiger det. Du kan opsige når som helst i kundepanelet på kunde.veyro.dk eller ved at skrive til kontakt@veyro.dk. Opsigelsen gælder fra udgangen af den periode, du har betalt for. Allerede betalte perioder refunderes ikke.`;
}

function priceTable(o: OfferRow): H {
  const t = offerTotals(o);
  const i = iv(o.interval);
  return html`<div class="table-wrap"><table class="offer-table">
    <tbody>
      <tr><th scope="row">${o.service} <span class="small muted">${i.per}</span></th><td class="num">${kr(t.recurringNet)}</td></tr>
      ${o.vat ? html`<tr><th scope="row" class="muted">Moms ${VAT_PERCENT} %</th><td class="num muted">${kr(t.recurringVat)}</td></tr>` : ''}
      <tr class="total"><th scope="row">I alt ${i.per}</th><td class="num"><strong>${kr(t.recurringTotal)}</strong></td></tr>
      ${o.setup_amount && !o.setup_settled
        ? html`<tr><th scope="row">${o.setup_description ?? 'Engangsbeløb'} <span class="small muted">betales én gang</span></th><td class="num">${kr(t.setupNet)}</td></tr>
          ${o.vat ? html`<tr><th scope="row" class="muted">Moms ${VAT_PERCENT} %</th><td class="num muted">${kr(t.setupVat)}</td></tr>` : ''}`
        : ''}
      <tr class="total"><th scope="row">Betales ved tilmelding</th><td class="num"><strong>${kr(t.dueNow)}</strong></td></tr>
    </tbody></table></div>
    ${o.setup_amount && o.setup_settled ? html`<p class="small muted">${o.setup_description ?? 'Engangsbeløbet'} er allerede faktureret og opkræves ikke igen.</p>` : ''}
    ${o.first_charge_at ? html`<p class="small">Første periode er allerede betalt. Første opkrævning af abonnementet sker <strong>${formatDate(o.first_charge_at)}</strong>.</p>` : ''}
    ${o.vat ? '' : html`<p class="small muted">Priserne er uden moms.</p>`}`;
}

// ---------------- Kundens side: /tilbud/<token> ----------------

export function publicOfferPage(args: { csrf: string; offer: OfferRow; error?: string | null; checked?: boolean }): H {
  const o = args.offer;
  const st = offerState(o);
  const head = html`<div><p class="eyebrow">Tilbud fra Veyro</p><h1>${o.service}</h1>
    <p class="lead">Til ${o.company ? html`${o.company}${o.cvr ? html`, CVR ${o.cvr}` : ''}, att. ${o.name}` : o.name}</p></div>`;
  if (st === 'active') {
    return html`<div class="narrow stack-lg">${head}
      ${alert('ok', 'Abonnementet er aktivt. Tak!')}
      <div class="card stack"><p>Du kan se fakturaer, skifte betalingskort og opsige abonnementet i kundepanelet.</p><a class="btn btn-primary" href="/login">Log ind i kundepanelet</a></div></div>`;
  }
  if (st === 'processing') {
    return html`<div class="narrow stack-lg">${head}
      ${alert('info', 'Vi venter på, at Stripe bekræfter din betaling. Du får en mail, så snart abonnementet er aktivt.')}</div>`;
  }
  if (st !== 'open') {
    const msg =
      st === 'expired'
        ? 'Linket til dette tilbud er udløbet. Skriv til kontakt@veyro.dk, så sender vi et nyt.'
        : st === 'withdrawn'
          ? 'Dette tilbud er trukket tilbage. Skriv til kontakt@veyro.dk, hvis du har spørgsmål.'
          : 'Abonnementet fra dette tilbud er stoppet. Skriv til kontakt@veyro.dk, hvis du vil i gang igen.';
    return html`<div class="narrow stack-lg">${head}${alert('warn', msg)}</div>`;
  }
  return html`<div class="narrow stack-lg">
  ${head}
  ${args.error ? alert('err', args.error) : ''}
  ${o.description ? html`<section class="card stack"><h2>Det får du</h2><p style="white-space:pre-line">${o.description}</p></section>` : ''}
  <section class="card stack" aria-labelledby="pris-h">
    <h2 id="pris-h">Pris</h2>
    ${priceTable(o)}
  </section>
  <section class="card stack" aria-labelledby="vilkaar-h">
    <h2 id="vilkaar-h">Vilkår og opsigelse</h2>
    <p>${termsText(o)}</p>
    <p class="small muted">Du får en kvittering og faktura fra Stripe ved hver betaling. Tilbuddet gælder til og med ${formatDate(o.valid_until)}. Abonnementet sælges kun til virksomheder, og der er ingen fortrydelsesret.</p>
    <form method="post" action="/tilbud/${o.token}" class="stack">
      ${csrfField(args.csrf)}
      <label class="check"><input type="checkbox" name="accept" value="1" required${args.checked ? html` checked` : ''}>
        Jeg godkender tilbuddet og tilmelder mig et løbende abonnement på ${kr(offerTotals(o).recurringTotal)} ${iv(o.interval).per}${o.vat ? ' inkl. moms' : ''} på vilkårene ovenfor, og jeg accepterer på virksomhedens vegne ${legalLinks()}.</label>
      <button class="btn btn-accent btn-block" type="submit" data-loading="Åbner Stripe …">Godkend og gå til betaling</button>
      <p class="small muted">Betalingen sker sikkert hos Stripe. Kortoplysninger gemmes aldrig hos Veyro.</p>
    </form>
  </section>
</div>`;
}

export function publicOfferThanksPage(args: { offer: OfferRow }): H {
  const o = args.offer;
  if (o.status === 'active') {
    return html`<div class="narrow stack-lg">
      <div><h1>Tak, dit abonnement er aktivt</h1><p class="lead">${o.service}. Du får en kvittering fra Stripe og en velkomstmail fra os.</p></div>
      <div class="card stack"><p>I kundepanelet kan du se fakturaer, skifte betalingskort og opsige abonnementet.</p><a class="btn btn-primary" href="/login">Log ind i kundepanelet</a></div></div>`;
  }
  // Et besøg på denne side er ikke bevis for betaling: status kommer kun fra Stripes webhook.
  return html`<div class="narrow stack-lg">
    <meta http-equiv="refresh" content="5">
    <div><h1>Tak, vi venter på bekræftelse</h1><p class="lead">Stripe er ved at bekræfte din betaling. Siden opdaterer sig selv, og du får en mail, når abonnementet er aktivt.</p></div>
    <p class="small muted">Er du blevet sendt hertil uden at gennemføre betalingen, kan du <a href="/tilbud/${o.token}">gå tilbage til tilbuddet</a>.</p></div>`;
}

// ---------------- Admin: tilbud ----------------

const OFFER_FLASH: Record<string, string> = {
  oprettet: 'Tilbuddet er oprettet. Kopiér linket, eller send det på mail herfra.',
  sendt: 'Tilbuddet er sendt på mail til kunden.',
  'trukket-tilbage': 'Tilbuddet er trukket tilbage. Linket virker ikke længere.',
  forlaenget: `Linket er forlænget med ${DEFAULT_VALID_DAYS} dage.`,
};

function existingBlock(e: ExistingBilling): H {
  return html`<div class="alert alert-warn stack" role="alert">
    <p><strong>Kunden har allerede noget i gang.</strong> Tjek, at det nye tilbud ikke opkræver det samme to gange. Er noget allerede faktureret, så markér det under «Allerede faktureret» nedenfor.</p>
    <ul class="small" style="margin:0;padding-left:18px">
      ${e.subscriptions.map((s) => html`<li>Abonnement i Stripe (${s.status}): ${kr(s.amount)} ekskl. moms ${iv(s.interval).per} · <a href="https://dashboard.stripe.com/subscriptions/${s.id}" target="_blank" rel="noopener">${s.id}</a></li>`)}
      ${e.invoices.map((i) => html`<li>Faktura ${i.number ?? i.id} (${i.status === 'paid' ? 'betalt' : 'ubetalt'}) ${formatDateShort(i.created)}: ${kr(i.total)}</li>`)}
      ${e.offers.map((o) => html`<li>Tilbud: ${o.service} (${OFFER_STATE[o.status]?.label ?? o.status}) · <a href="/admin/tilbud/${o.id}">åbn</a></li>`)}
    </ul>
    <label class="check"><input type="checkbox" name="confirm_existing" value="1"> Jeg har tjekket det, og det nye tilbud opkræver ikke det samme to gange</label>
  </div>`;
}

export function adminOffersPage(args: {
  csrf: string;
  formKey: string;
  offers: OfferRow[];
  form: OfferForm | null;
  error: string | null;
  errorField: string | null;
  existing: ExistingBilling | null;
  flash: string | null;
  /** Forespørgsel fra hjemmesiden, som tilbuddet laves ud fra */
  lead?: { id: number; label: string } | null;
}): H {
  const f = args.form;
  const v = (k: keyof OfferForm) => (f ? String(f[k] ?? '') : k === 'valid_days' ? String(DEFAULT_VALID_DAYS) : '');
  const err = (k: string) => (args.errorField === k ? html` aria-invalid="true"` : '');
  // attrs er faste strenge i koden (ingen brugerdata), værdien escapes for sig.
  const field = (id: keyof OfferForm, label: string, attrs = '', hint?: string) =>
    html`<div class="field"><label for="o-${id}">${label}</label><input id="o-${id}" name="${id}" value="${v(id)}" ${raw(attrs)}${err(id)}>${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Admin</p><h1>Tilbud med betalingslink</h1>
    <p class="lead">Opret et abonnement med kundens egen pris. Kunden får et personligt link, ser pris, moms, interval og vilkår, og tilmelder sig med kort hos Stripe. Kunden bliver først aktiv, når Stripe har bekræftet betalingen.</p></div>
  ${args.flash && OFFER_FLASH[args.flash] ? alert('ok', OFFER_FLASH[args.flash]!) : ''}
  <section class="card stack" aria-labelledby="nyt-h">
    <h2 id="nyt-h">Nyt tilbud</h2>
    ${args.lead ? alert('info', html`Udfyldt fra <a href="/admin/forespoergsler/${args.lead.id}">${args.lead.label}</a>. Tjek pris og ydelse, før du opretter tilbuddet.`) : ''}
    ${args.error ? alert('err', args.error) : ''}
    <form method="post" action="/admin/tilbud" class="stack" novalidate>
      ${csrfField(args.csrf)}
      <input type="hidden" name="key" value="${args.formKey}">
      ${args.lead ? html`<input type="hidden" name="lead" value="${args.lead.id}">` : ''}
      <h3 class="h-small">Kunde</h3>
      <div class="grid grid-2">
        ${field('name', 'Kontaktperson', 'type="text" required maxlength="100" autocomplete="off"')}
        ${field('email', 'E-mail', 'type="email" required maxlength="254" autocomplete="off"')}
        ${field('company', 'Firma (valgfri)', 'type="text" maxlength="120" autocomplete="off"')}
        ${field('cvr', 'CVR-nummer (valgfri)', 'type="text" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="12345678"')}
        ${field('address', 'Adresse (valgfri)', 'type="text" maxlength="200" autocomplete="off"')}
        <div class="grid grid-2" style="gap:12px">${field('postal_code', 'Postnr.', 'type="text" inputmode="numeric" maxlength="4" autocomplete="off"')}${field('city', 'By', 'type="text" maxlength="100" autocomplete="off"')}</div>
        ${field('phone', 'Telefon (valgfri)', 'type="tel" maxlength="40" autocomplete="off"')}
      </div>
      <h3 class="h-small">Ydelse og pris</h3>
      <div class="grid grid-2">
        ${field('service', 'Ydelse', 'type="text" required maxlength="120" placeholder="Fx Hjemmeside med drift og support"')}
        <div class="field"><label for="o-interval">Betaling</label>
          <select id="o-interval" name="interval"${err('interval')}><option value="month">Månedlig</option><option value="year"${v('interval') === 'year' ? html` selected` : ''}>Årlig</option></select></div>
        ${field('price', 'Pris pr. periode (kr. ekskl. moms)', 'type="text" inputmode="decimal" required maxlength="15" placeholder="Fx 1.499"', 'Kun denne kunde får prisen.')}
        <div class="field"><span class="label-like">Moms</span>
          <label class="check"><input type="checkbox" name="vat" value="1"${!f || f.vat ? html` checked` : ''}> Læg ${VAT_PERCENT} % moms oveni</label></div>
      </div>
      <div class="field"><label for="o-description">Beskrivelse til kunden (valgfri)</label>
        <textarea id="o-description" name="description" rows="3" maxlength="1000"${err('description')}>${v('description')}</textarea></div>
      <div class="grid grid-2">
        ${field('setup_price', 'Engangsbeløb (kr. ekskl. moms, valgfri)', 'type="text" inputmode="decimal" maxlength="15" placeholder="Fx 4.500"', 'Opkræves én gang sammen med første betaling.')}
        ${field('setup_description', 'Engangsbeløbet dækker', 'type="text" maxlength="120" placeholder="Fx Oprettelse og udvikling"')}
      </div>
      <details${f && (f.setup_settled || f.first_charge || f.settled_note) ? html` open` : ''}>
        <summary>Allerede faktureret eller betalt?</summary>
        <div class="stack" style="margin-top:12px">
          <p class="small muted" style="margin:0">Har kunden allerede fået en faktura (i Stripe, Shopify eller andetsteds) for engangsbeløbet eller første periode, så markér det her. Så opkræves det ikke igen via linket.</p>
          <label class="check"><input type="checkbox" name="setup_settled" value="1"${f?.setup_settled ? html` checked` : ''}${err('setup_settled')}> Engangsbeløbet er allerede faktureret og skal ikke med i betalingen</label>
          <div class="grid grid-2">
            ${field('first_charge', 'Første periode er betalt: første opkrævning den', 'type="date"', 'Tomt = første periode betales ved tilmelding.')}
            ${field('settled_note', 'Hvilken faktura dækker det?', 'type="text" maxlength="200" placeholder="Fx faktura 1042"')}
          </div>
        </div>
      </details>
      ${field('valid_days', 'Linket gælder i (dage)', `type="number" min="1" max="90" step="1" inputmode="numeric"`)}
      ${args.existing ? existingBlock(args.existing) : ''}
      <div class="row"><button class="btn btn-accent" type="submit" data-loading="Opretter …">Opret tilbud og betalingslink</button></div>
      <p class="hint">Kunden og prisen oprettes i Stripe nu. Der trækkes ingen penge, før kunden selv godkender og betaler via linket.</p>
    </form>
  </section>
  <section class="card" aria-labelledby="tilbud-h">
    <h2 id="tilbud-h">Tilbud</h2>
    ${args.offers.length === 0
      ? html`<p class="empty">Ingen tilbud endnu.</p>`
      : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Kunde</th><th scope="col">Ydelse</th><th scope="col" class="num">Pris ekskl. moms</th><th scope="col">Status</th><th scope="col">Oprettet</th></tr></thead>
      <tbody>${args.offers.map(
        (o) => html`<tr>
          <td data-label="Kunde"><a href="/admin/tilbud/${o.id}"><strong>${o.company ?? o.name}</strong></a><br><span class="small muted">${o.email}</span></td>
          <td data-label="Ydelse">${o.service}</td>
          <td data-label="Pris" class="num">${kr(o.amount)} ${iv(o.interval).short}${o.setup_amount ? html`<br><span class="small muted">+ ${kr(o.setup_amount)} én gang${o.setup_settled ? ' (faktureret)' : ''}</span>` : ''}</td>
          <td data-label="Status">${offerBadge(o)}</td>
          <td data-label="Oprettet">${formatDateShort(o.created_at)}</td>
        </tr>`,
      )}</tbody></table></div>`}
  </section>
</div>`;
}

export function adminOfferDetailPage(args: { csrf: string; offer: OfferRow; link: string; customerId: number | null; flash: string | null; error: string | null }): H {
  const o = args.offer;
  const st = offerState(o);
  const post = (a: string) => `/admin/tilbud/${o.id}/${a}`;
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin/tilbud">← Tilbud</a></p><h1>${o.service}</h1><p class="lead">${o.company ?? o.name} · ${o.email}</p></div>
  ${args.flash && OFFER_FLASH[args.flash] ? alert('ok', OFFER_FLASH[args.flash]!) : ''}
  ${args.error ? alert('err', args.error) : ''}
  <div class="grid grid-2">
    <section class="card stack">
      <div class="row between"><h2 style="margin:0">Status</h2>${offerBadge(o)}</div>
      <dl class="facts">
        <div><dt>Linket gælder til</dt><dd>${formatDate(o.valid_until)}</dd></div>
        <div><dt>Sendt på mail</dt><dd>${o.emailed_at ? formatDate(o.emailed_at) : 'Nej'}</dd></div>
        <div><dt>Godkendt af kunden</dt><dd>${o.accepted_at ? formatDate(o.accepted_at) : '–'}</dd></div>
        <div><dt>Aktiv fra</dt><dd>${o.activated_at ? formatDate(o.activated_at) : '–'}</dd></div>
      </dl>
      ${st === 'open'
        ? html`<div class="field"><label for="link">Personligt betalingslink</label><input id="link" type="text" readonly value="${args.link}"></div>
          <div class="row">
            <form method="post" action="${post('send')}" class="inline">${csrfField(args.csrf)}<button class="btn btn-primary" type="submit" data-loading="Sender …">${o.emailed_at ? 'Send mail igen' : 'Send tilbud på mail'}</button></form>
            <form method="post" action="${post('tilbagetraek')}" class="inline" data-confirm="Trække tilbuddet tilbage? Linket holder op med at virke.">${csrfField(args.csrf)}<button class="btn btn-danger" type="submit">Træk tilbage</button></form>
          </div>`
        : ''}
      ${st === 'expired'
        ? html`<form method="post" action="${post('forlaeng')}" class="inline">${csrfField(args.csrf)}<button class="btn btn-primary" type="submit">Forlæng linket ${DEFAULT_VALID_DAYS} dage</button></form>`
        : ''}
      ${o.subscription_id && args.customerId ? html`<a class="btn btn-secondary" href="/admin/kunder/${args.customerId}">Se kunden og abonnementet</a>` : ''}
    </section>
    <section class="card stack">
      <h2>Tilbuddet</h2>
      <ul class="small" style="margin:0;padding-left:18px">${offerSummaryLines(o).map((l) => html`<li>${l}</li>`)}</ul>
      ${o.settled_note ? html`<p class="small muted">Allerede faktureret: ${o.settled_note}</p>` : ''}
      <dl class="facts">
        <div><dt>Kunde</dt><dd>${o.name}${o.company ? html`<br>${o.company}` : ''}${o.cvr ? html`<br>CVR ${o.cvr}` : ''}</dd></div>
        <div><dt>Adresse</dt><dd>${o.address ? html`${o.address}<br>${o.postal_code ?? ''} ${o.city ?? ''}` : '–'}</dd></div>
      </dl>
      <p class="small"><a href="https://dashboard.stripe.com/customers/${o.stripe_customer_id}" target="_blank" rel="noopener">Kunden i Stripe</a>${o.subscription_id ? html` · <a href="https://dashboard.stripe.com/subscriptions/${o.subscription_id}" target="_blank" rel="noopener">Abonnementet i Stripe</a>` : ''}</p>
      <p class="small muted">Oprettet ${formatDate(o.created_at)} af ${o.created_by}.</p>
    </section>
  </div>
</div>`;
}

// ---------------- Admin: én kunde ----------------

const CUSTOMER_FLASH: Record<string, string> = {
  pris: 'Prisen er ændret, og kunden har fået besked på mail.',
  'pris-uden-mail': 'Prisen er ændret, men mailen til kunden kunne ikke sendes. Giv kunden besked selv.',
  opsagt: 'Abonnementet stopper ved udgangen af den betalte periode.',
  genoptaget: 'Abonnementet fortsætter.',
};

export interface CustomerSubView {
  sub: SubscriptionRow;
  service: string;
  renewals: number[];
}

function paymentStatus(p: PaymentRow): H {
  if (p.status === 'paid') return html`<span class="badge b-ok">Betalt</span>`;
  if (p.status === 'failed')
    return html`<span class="badge b-err">Mislykkedes</span>${p.attempt_count ? html`<br><span class="small muted">${p.attempt_count} forsøg${p.next_attempt_at ? `, næste ${formatDateShort(p.next_attempt_at)}` : ''}</span>` : ''}`;
  if (p.status === 'void') return html`<span class="badge b-neutral">Annulleret</span>`;
  return html`<span class="badge b-warn">Ubetalt</span>`;
}

export function adminCustomerPage(args: {
  csrf: string;
  customer: CustomerRow;
  subs: CustomerSubView[];
  offers: OfferRow[];
  payments: PaymentRow[];
  priceChanges: PriceChangeRow[];
  flash: string | null;
  error: string | null;
  accepted?: Partial<Record<LegalDocKey, Acceptance>>;
}): H {
  const c = args.customer;
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin/kunder">← Kunder</a></p><h1>${c.company ?? c.name ?? c.email}</h1></div>
  ${args.flash && CUSTOMER_FLASH[args.flash] ? alert('ok', CUSTOMER_FLASH[args.flash]!) : ''}
  ${args.error ? alert('err', args.error) : ''}
  <section class="card">
    <h2>Kunde og fakturering</h2>
    <dl class="facts">
      <div><dt>Navn</dt><dd>${c.name ?? '–'}</dd></div>
      <div><dt>Firma</dt><dd>${c.company ?? '–'}</dd></div>
      <div><dt>E-mail</dt><dd><a href="mailto:${c.email}">${c.email}</a></dd></div>
      <div><dt>CVR</dt><dd>${c.cvr ?? '–'}</dd></div>
      <div><dt>Telefon</dt><dd>${c.phone ?? '–'}</dd></div>
      <div><dt>Faktureringsadresse</dt><dd>${c.address ? html`${c.address}, ${c.postal_code ?? ''} ${c.city ?? ''}` : '–'}</dd></div>
      <div><dt>Stripe</dt><dd>${c.stripe_customer_id ? html`<a href="https://dashboard.stripe.com/customers/${c.stripe_customer_id}" target="_blank" rel="noopener">${c.stripe_customer_id}</a>` : '–'}</dd></div>
      ${LEGAL_DOCS.map((d) => {
        const a = args.accepted?.[d.key];
        return html`<div><dt>${d.title}</dt><dd>${a ? `Version ${a.version}, accepteret ${formatDate(a.accepted_at)}${a.version === LEGAL_VERSION ? '' : ' (ikke nyeste)'}` : 'Ikke accepteret'}</dd></div>`;
      })}
    </dl>
  </section>
  <section class="card stack">
    <h2>Abonnementer</h2>
    ${args.subs.length === 0 ? html`<p class="empty">Intet abonnement.</p>` : ''}
    ${args.subs.map(({ sub, service, renewals }) => {
      const st = subscriptionState(sub)!;
      const i = iv(sub.interval);
      const pending = args.priceChanges.filter((p) => p.subscription_id === sub.id && p.status === 'scheduled' && p.effective_at > Math.floor(Date.now() / 1000));
      const post = (a: string) => `/admin/kunder/${c.id}/abonnement/${sub.id}/${a}`;
      return html`<article class="card stack" id="${sub.id}" style="background:var(--bg)">
        <div class="row between"><h3 style="margin:0">${service}</h3><span class="badge ${badgeClass(st.tone)}">${st.label}</span></div>
        <dl class="facts">
          <div><dt>Pris</dt><dd>${kr(pending[pending.length - 1]?.old_amount ?? sub.amount ?? 0)} ekskl. moms ${i.per}</dd></div>
          <div><dt>Startet</dt><dd>${formatDate(sub.started_at)}</dd></div>
          <div><dt>Næste betaling</dt><dd>${st.ended || st.cancelPending ? 'Ingen' : formatDate(sub.current_period_end)}</dd></div>
          <div><dt>Opsigelsesdato</dt><dd>${st.cancelPending ? formatDate(st.cancelDate) : st.ended ? formatDate(sub.canceled_at) : '–'}</dd></div>
        </dl>
        ${pending.map((p) => html`<p class="alert alert-info small">Ny pris ${kr(p.new_amount)} ekskl. moms ${iv(p.interval).per} fra ${formatDate(p.effective_at)} (før ${kr(p.old_amount ?? 0)}).${p.notified_at ? ' Kunden har fået besked.' : ' Kunden har ikke fået mail.'}</p>`)}
        ${st.manageable && !st.cancelPending
          ? html`<details><summary>Ændr pris for denne kunde</summary>
            <form method="post" action="${post('pris')}" class="stack" style="margin-top:12px">${csrfField(args.csrf)}
              <input type="hidden" name="key" value="${crypto.randomUUID()}">
              <div class="grid grid-2">
                <div class="field"><label for="np-${sub.id}">Ny pris (kr. ekskl. moms ${i.per})</label>
                  <input id="np-${sub.id}" name="price" type="text" inputmode="decimal" required maxlength="15" placeholder="${((sub.amount ?? 0) / 100).toLocaleString('da-DK')}"></div>
                <div class="field"><label for="eff-${sub.id}">Gælder fra betalingen den</label>
                  <select id="eff-${sub.id}" name="effective">${renewals.map((d, n) => html`<option value="${n === 0 ? 'next' : d}">${formatDate(d)}${n === 0 ? ' (næste periode)' : ''}</option>`)}</select></div>
              </div>
              <p class="hint">Ingen forholdsmæssig afregning: den nuværende pris gælder til den valgte dato. Kunden får en mail om ændringen. Andre kunder påvirkes ikke. En prisstigning skal ifølge handelsbetingelserne varsles mindst 1 måned før, så vælg en dato mindst en måned frem.</p>
              <div class="row"><button class="btn btn-small btn-primary" type="submit" data-confirm-btn="Ændre prisen og give kunden besked på mail?">Gem ny pris</button></div>
            </form></details>`
          : ''}
        <div class="row">
          ${st.manageable
            ? st.cancelPending
              ? html`<form method="post" action="${post('genoptag')}" class="inline">${csrfField(args.csrf)}<button class="btn btn-small btn-secondary" type="submit">Fortsæt abonnementet</button></form>`
              : html`<form method="post" action="${post('opsig')}" class="inline" data-confirm="Stoppe abonnementet ved udgangen af den betalte periode?">${csrfField(args.csrf)}<button class="btn btn-small btn-danger" type="submit">Opsig ved periodens udløb</button></form>`
            : ''}
          <a class="small" href="https://dashboard.stripe.com/subscriptions/${sub.id}" target="_blank" rel="noopener">Åbn i Stripe</a>
        </div>
      </article>`;
    })}
  </section>
  <section class="card">
    <h2>Betalinger og fakturaer</h2>
    ${args.payments.length === 0
      ? html`<p class="empty">Ingen betalinger registreret endnu.</p>`
      : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Dato</th><th scope="col">Faktura</th><th scope="col">Periode</th><th scope="col" class="num">Beløb</th><th scope="col">Status</th></tr></thead>
      <tbody>${args.payments.map(
        (p) => html`<tr${p.status === 'failed' ? html` class="row-err"` : ''}>
          <td data-label="Dato">${formatDateShort(p.created)}</td>
          <td data-label="Faktura">${p.number ?? p.invoice_id}${p.invoice_pdf ? html`<br><a class="small" href="${p.invoice_pdf}" target="_blank" rel="noopener">PDF</a>` : ''}${p.hosted_invoice_url ? html` · <a class="small" href="${p.hosted_invoice_url}" target="_blank" rel="noopener">Vis</a>` : ''}</td>
          <td data-label="Periode">${p.period_start ? html`${formatDateShort(p.period_start)} – ${formatDateShort(p.period_end)}` : '–'}</td>
          <td data-label="Beløb" class="num">${kr((p.status === 'paid' ? p.amount_paid : p.amount_due) ?? 0)}</td>
          <td data-label="Status">${paymentStatus(p)}</td>
        </tr>`,
      )}</tbody></table></div>`}
  </section>
  <section class="card">
    <h2>Tilbud</h2>
    ${args.offers.length === 0
      ? html`<p class="empty">Ingen tilbud.</p>`
      : html`<ul style="margin:0;padding-left:18px">${args.offers.map(
          (o) => html`<li><a href="/admin/tilbud/${o.id}">${o.service}</a> · ${kr(o.amount)} ${iv(o.interval).short} · ${offerBadge(o)}</li>`,
        )}</ul>`}
  </section>
</div>`;
}
