import { html } from 'hono/html';
import type { RequestRow, SubscriptionRow } from '../env';
import { systemLoginUrl, type KundeSystem } from '../lib/katalog';
import { formatDate, formatDateShort, formatKr } from '../lib/format';
import { PLANS, getPlan, type Plan } from '../lib/plans';
import type { StripeInvoice } from '../lib/stripe';
import { alert, csrfField, type H } from './layout';
import { REQUEST_STATUSES, REQUEST_TYPES, badgeClass, subscriptionState } from './status';

// Faste beskeder efter handlinger (?besked=...). Kun kendte nøgler vises – ingen vilkårlig tekst fra URL'en.
export const FLASH: Record<string, { kind: 'ok' | 'info' | 'warn' | 'err'; text: string }> = {
  'plan-skiftet': { kind: 'ok', text: 'Din plan er skiftet. Ændringen gælder fra nu.' },
  opsagt: { kind: 'ok', text: 'Dit abonnement er opsagt. Det kører til og med den nuværende betalingsperiode.' },
  genoptaget: { kind: 'ok', text: 'Din opsigelse er annulleret. Abonnementet fortsætter som normalt.' },
  'henvendelse-oprettet': { kind: 'ok', text: 'Tak! Vi har modtaget din henvendelse og svarer inden for 24-48 timer.' },
  'kort-opdateret': { kind: 'ok', text: 'Tak. Ændringer af betalingskort kan tage et øjeblik om at blive vist.' },
  'har-abonnement': { kind: 'info', text: 'Du har allerede et abonnement. Her kan du skifte plan.' },
  'stripe-fejl': { kind: 'err', text: 'Der opstod en fejl hos vores betalingsudbyder. Prøv igen om lidt, eller kontakt os.' },
  logget_ud: { kind: 'info', text: 'Du er logget ud.' },
  'konto-oprettet': { kind: 'ok', text: 'Din konto er oprettet. Kontakt os om den plan, I er interesserede i, så sender vi et tilbud.' },
  'vilkaar-accepteret': { kind: 'ok', text: 'Tak. Din accept af handelsbetingelserne og databehandleraftalen er gemt.' },
  'vilkaar-mangler': { kind: 'err', text: 'Sæt kryds for at acceptere handelsbetingelserne og databehandleraftalen.' },
};

export function flash(key: string | undefined): H | '' {
  if (!key) return '';
  const f = FLASH[key];
  return f ? alert(f.kind, f.text) : '';
}

// ---------------- Login ----------------

export function loginPage(args: { csrf: string; error?: string; email?: string; info?: H | '' }): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Log ind</h1>
    <p class="lead">Skriv din e-mail. Bruger din virksomhed et system fra Veyro, sender vi dig videre dertil. Ellers får du et link til kundepanelet, så du kan logge ind uden adgangskode.</p>
  </div>
  ${args.info ?? ''}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/login" class="card stack" novalidate>
    ${csrfField(args.csrf)}
    <div class="field">
      <label for="email">E-mail</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254"
        value="${args.email ?? ''}" ${args.error ? html`aria-invalid="true" aria-describedby="email-hint"` : ''}>
      <p class="hint" id="email-hint">Linket virker i 15 minutter og kan kun bruges én gang.</p>
    </div>
    <button class="btn btn-primary btn-block" type="submit" data-loading="Sender …">Send login-link</button>
  </form>
  <p class="muted small">Er du ikke kunde endnu? <a href="/opret">Opret en konto</a> eller <a href="/bestil">se vores abonnementer</a>.</p>
</div>`;
}

/** Kundelogin: e-mailen har adgang til flere systemer (eller også til kundepanelet). */
export function chooseSystemPage(args: { csrf: string; email: string; systemer: KundeSystem[]; kundepanel: boolean }): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Vælg, hvor du vil logge ind</h1>
    <p class="lead">${args.email} har adgang til flere steder hos Veyro.</p>
  </div>
  <div class="card stack">
    ${args.systemer.map(
      (s) => html`<a class="btn btn-primary btn-block" href="${systemLoginUrl(s, args.email)}">${s.navn}</a>`,
    )}
    ${args.kundepanel
      ? html`<form method="post" action="/login" class="stack">
          ${csrfField(args.csrf)}
          <input type="hidden" name="email" value="${args.email}">
          <input type="hidden" name="kundepanel" value="1">
          <button class="btn btn-secondary btn-block" type="submit" data-loading="Sender …">Abonnement og fakturaer hos Veyro</button>
        </form>`
      : ''}
  </div>
  <a class="small" href="/login">Brug en anden e-mail</a>
</div>`;
}

export function signupPage(args: {
  csrf: string;
  plan?: Plan;
  name?: string;
  email?: string;
  error?: string;
  errorField?: 'name' | 'email';
}): H {
  const action = args.plan ? `/opret?plan=${args.plan.key}` : '/opret';
  return html`<div class="narrow stack-lg">
  <div>
    <p class="eyebrow">Trin 1 af 2</p>
    <h1>Opret din konto</h1>
    <p class="lead">Først opretter du en konto, så dit abonnement altid er samlet ét sted. Derefter går du videre til betaling.</p>
  </div>
  ${args.plan
    ? html`<div class="card item-head"><div><p class="muted small">Valgt plan</p><strong>${args.plan.name}</strong> · ${formatKr(args.plan.amount)} /md.</div><a class="small" href="/bestil">Skift</a></div>`
    : ''}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="${action}" class="card stack" novalidate>
    ${csrfField(args.csrf)}
    <div class="field">
      <label for="name">Navn</label>
      <input id="name" name="name" type="text" autocomplete="name" required maxlength="100" value="${args.name ?? ''}"
        ${args.errorField === 'name' ? html`aria-invalid="true"` : ''}>
    </div>
    <div class="field">
      <label for="email">E-mail</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254"
        value="${args.email ?? ''}" ${args.errorField === 'email' ? html`aria-invalid="true"` : ''} aria-describedby="email-hint">
      <p class="hint" id="email-hint">Vi sender et link, så du kan bekræfte din e-mail. Du logger ind uden adgangskode.</p>
    </div>
    <button class="btn btn-accent btn-block" type="submit" data-loading="Sender …">Opret konto</button>
  </form>
  <p class="muted small">Har du allerede en konto? <a href="/login">Log ind</a>.</p>
</div>`;
}

export function signupSentPage(): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Tjek din indbakke</h1>
    <p class="lead">Vi har sendt dig en e-mail. Klik på linket i den for at bekræfte din e-mail, så kommer du videre til betaling. Linket virker i 15 minutter.</p>
  </div>
  <div class="card stack">
    <p>Kan du ikke finde e-mailen? Kig i spam-mappen, eller prøv igen om et par minutter.</p>
    <p class="muted small">Har du brug for hjælp, så skriv til <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>.</p>
  </div>
</div>`;
}

export function loginSentPage(args: { devLink?: string | null }): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Tjek din indbakke</h1>
    <p class="lead">Hvis e-mailen er tilknyttet en konto hos Veyro, har vi sendt et login-link. Linket virker i 15 minutter.</p>
  </div>
  <div class="card stack">
    <p>Kan du ikke finde e-mailen? Kig i spam-mappen, eller prøv igen om et par minutter.</p>
    <p class="muted small">Har du brug for hjælp, så skriv til <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>.</p>
    <a class="btn btn-secondary" href="/login">Tilbage</a>
  </div>
  ${args.devLink
    ? alert(
        'warn',
        html`<strong>Udviklingstilstand:</strong> e-mail sendes ikke. Brug linket her:<br><a class="devlink" href="${args.devLink}">${args.devLink}</a>`,
      )
    : ''}
</div>`;
}

export function verifyPage(args: { csrf: string; token: string }): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Bekræft din e-mail</h1>
    <p class="lead">Klik på knappen for at fortsætte til Veyros kundepanel.</p>
  </div>
  <form method="post" action="/login/bekraeft" class="card stack">
    ${csrfField(args.csrf)}
    <input type="hidden" name="token" value="${args.token}">
    <button class="btn btn-primary btn-block" type="submit" data-loading="Et øjeblik …">Fortsæt</button>
  </form>
</div>`;
}

export function linkInvalidPage(): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Linket virker ikke længere</h1>
    <p class="lead">Login-linket er udløbet eller allerede brugt. Bed om et nyt – det tager kun et øjeblik.</p>
  </div>
  <a class="btn btn-primary" href="/login">Send et nyt link</a>
</div>`;
}

// ---------------- Planer / bestilling ----------------

function planCard(p: Plan, footer: H, selected = false): H {
  return html`<article class="plan${p.badge ? ' featured' : ''}${selected ? ' selected' : ''}" id="${p.key}" aria-labelledby="plan-${p.key}">
  ${p.badge ? html`<span class="badge b-accent">${p.badge}</span>` : ''}
  <h2 id="plan-${p.key}">${p.name}</h2>
  <div class="price">${formatKr(p.amount)} <small>/md.</small></div>
  <div class="vat">inkl. moms</div>
  <ul>${p.features.map((f) => html`<li>${f}</li>`)}</ul>
  ${footer}
</article>`;
}

// Planerne købes ikke direkte her: knappen sender kunden til kontaktformularen på veyro.dk med
// planen forvalgt (?ydelse=abonnement-<plan>). Veyro svarer med et tilbud og et personligt betalingslink.
export const contactUrlFor = (p: Plan) => `https://veyro.dk/pages/kontakt?ydelse=abonnement-${p.key}#formular`;

export function plansPage(args: {
  minMonths: number;
  loggedIn: boolean;
  error?: string;
  selected?: string;
  info?: H | '';
}): H {
  return html`<div class="stack-lg">
  <div>
    <p class="eyebrow">Abonnementer</p>
    <h1>Vælg den plan, der passer til jer</h1>
    <p class="lead">Fast månedlig pris. Kontakt os om den plan, I er interesserede i, så svarer vi inden for 24-48 timer med et tilbud og et personligt link til betaling.</p>
  </div>
  ${args.info ?? ''}
  ${args.error ? alert('err', args.error) : ''}
  <div class="plans">
    ${PLANS.map((p) =>
      planCard(
        p,
        html`<a class="btn ${p.badge || args.selected === p.key ? 'btn-accent' : 'btn-primary'} btn-block" href="${contactUrlFor(p)}">Kontakt os om ${p.name}</a>`,
        args.selected === p.key,
      ),
    )}
  </div>
  <p class="muted small medium">Abonnementerne sælges kun til virksomheder, og der er ingen fortrydelsesret. Alle priser er i danske kroner inkl. 25 % moms og betales månedligt forud.
    ${args.minMonths > 0
      ? `Abonnementet har en bindingsperiode på ${args.minMonths} måneder fra start; derefter kan det opsiges til udgangen af en betalingsperiode.`
      : 'Abonnementet kan opsiges til udgangen af den betalte periode.'}
    ${args.loggedIn ? '' : html`Har du allerede en konto? <a href="/login">Log ind</a>.`}</p>
</div>`;
}

export function thanksPage(): H {
  return html`<div class="narrow stack-lg">
  <div>
    <h1>Tak for din bestilling</h1>
    <p class="lead">Din betaling er registreret, og du modtager en kvittering på e-mail fra Stripe.</p>
  </div>
  <div class="card stack">
    <p>Du kan nu logge ind i kundepanelet med den e-mail, du brugte ved betalingen. Her kan du følge dit abonnement, se fakturaer og sende ændringsønsker.</p>
    <p class="muted small">Det kan tage et øjeblik, før dit abonnement er klar i kundepanelet.</p>
    <a class="btn btn-primary" href="/login">Log ind</a>
  </div>
</div>`;
}

// ---------------- Dashboard ----------------

export function dashboardPage(args: {
  csrf: string;
  name: string | null;
  sub: SubscriptionRow | null;
  cancellableFrom: number | null;
  openRequests: number;
  flashKey?: string;
  /** Kortet med handelsbetingelser og databehandleraftale */
  agreements?: H;
}): H {
  const state = subscriptionState(args.sub);
  const plan = getPlan(args.sub?.plan);
  const greeting = args.name ? `Hej ${args.name.split(' ')[0]}` : 'Overblik';
  const sub = args.sub;

  if (!sub || !state || state.ended) {
    return html`<div class="stack-lg">
      <div><h1>${greeting}</h1><p class="lead">Velkommen til Veyros kundepanel.</p></div>
      ${flash(args.flashKey)}
      <section class="card stack">
        <h2>Intet aktivt abonnement</h2>
        <p class="muted">${sub && state?.ended
          ? `Dit abonnement blev afsluttet ${formatDate(sub.canceled_at ?? sub.current_period_end)}.`
          : 'Vi kan ikke finde et aktivt abonnement på din konto.'}
          Vælg en plan for at komme i gang.</p>
        <div class="row"><a class="btn btn-primary" href="/bestil">Se abonnementer</a>
        <a class="btn btn-secondary" href="/konto/fakturaer">Se tidligere fakturaer</a></div>
      </section>
      ${args.agreements ?? ''}
    </div>`;
  }

  const nextPayment = state.cancelPending ? null : sub.current_period_end;
  return html`<div class="stack-lg">
  <div><h1>${greeting}</h1><p class="lead">Her er et overblik over dit abonnement hos Veyro.</p></div>
  ${flash(args.flashKey)}
  ${state.tone === 'err'
    ? alert(
        'err',
        html`<strong>Betalingen mislykkedes.</strong> Opdater dit betalingskort, så din hjemmeside fortsat er online. <a href="/konto/fakturaer#kort">Skift betalingskort</a>`,
      )
    : ''}
  <div class="grid grid-2">
    <section class="card" aria-labelledby="plan-h">
      <p class="eyebrow">Din plan</p>
      <div class="plan-title">
        <h2 id="plan-h" class="price-big" style="margin:0">${plan?.name ?? 'Abonnement'}</h2>
        <span class="badge ${badgeClass(state.tone)}">${state.label}</span>
      </div>
      <dl class="facts">
        <div><dt>Pris</dt><dd>${formatKr(sub.amount)} ${sub.interval === 'year' ? '/år' : '/md.'}${plan ? '' : ' ekskl. moms'}</dd></div>
        <div><dt>Startdato</dt><dd>${formatDate(sub.started_at)}</dd></div>
        ${state.cancelPending
          ? html`<div><dt>Abonnementet slutter</dt><dd>${formatDate(state.cancelDate)}</dd></div>
              <div><dt>Næste betaling</dt><dd>Ingen flere betalinger</dd></div>`
          : html`<div><dt>Næste betaling</dt><dd>${formatDate(nextPayment)}</dd></div>
              <div><dt>Beløb</dt><dd>${formatKr(sub.amount)}</dd></div>`}
      </dl>
      ${plan ? html`<ul class="small muted" style="margin:16px 0 0;padding-left:18px">${plan.features.map((f) => html`<li>${f}</li>`)}</ul>` : ''}
    </section>
    <section class="card stack" aria-labelledby="actions-h">
      <h2 id="actions-h">Administrer</h2>
      <div class="stack">
        ${plan && state.manageable && !state.cancelPending
          ? html`<a class="btn btn-primary btn-block" href="/konto/plan">Skift plan</a>`
          : ''}
        <a class="btn btn-secondary btn-block" href="/konto/henvendelser">Send ændringsønske${args.openRequests ? ` (${args.openRequests} åbne)` : ''}</a>
        <a class="btn btn-secondary btn-block" href="/konto/fakturaer">Fakturaer og betalingskort</a>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:20px 0 4px">
      ${state.cancelPending
        ? html`<p class="small">Dit abonnement stopper ${formatDate(state.cancelDate)}. Fortryder du, kan du fortsætte uden afbrydelse.</p>
            <form method="post" action="/konto/genoptag">${csrfField(args.csrf)}
              <button class="btn btn-primary btn-block" type="submit" data-loading="Genoptager …">Fortsæt abonnementet</button>
            </form>`
        : state.manageable
          ? args.cancellableFrom && args.cancellableFrom > Math.floor(Date.now() / 1000)
            ? html`<p class="small muted">Abonnementet har binding og kan opsiges fra ${formatDate(args.cancellableFrom)}.</p>`
            : html`<p class="small muted">Vil du stoppe? <a href="/konto/opsig">Opsig abonnement</a></p>`
          : ''}
    </section>
  </div>
  ${args.agreements ?? ''}
</div>`;
}

// ---------------- Skift plan ----------------

export function choosePlanPage(args: { sub: SubscriptionRow; blockedReason?: string; flashKey?: string }): H {
  return html`<div class="stack-lg">
  <div><h1>Skift plan</h1>
    <p class="lead">Opgrader eller nedgrader når som helst. Prisforskellen for resten af den nuværende periode afregnes forholdsmæssigt.</p></div>
  ${flash(args.flashKey)}
  ${args.blockedReason ? alert('warn', args.blockedReason) : ''}
  <div class="plans">
    ${PLANS.map((p) => {
      const current = p.key === args.sub.plan;
      return planCard(
        p,
        current
          ? html`<span class="btn btn-secondary btn-block" aria-disabled="true">Din nuværende plan</span>`
          : args.blockedReason
            ? html`<span class="btn btn-secondary btn-block" aria-disabled="true">Ikke muligt lige nu</span>`
            : html`<a class="btn ${p.badge ? 'btn-accent' : 'btn-primary'} btn-block" href="/konto/plan/bekraeft?plan=${p.key}">${
                (getPlan(args.sub.plan)?.rank ?? 0) < p.rank ? 'Opgrader' : 'Nedgrader'
              } til ${p.name}</a>`,
      );
    })}
  </div>
</div>`;
}

export function confirmPlanPage(args: {
  csrf: string;
  current: Plan | undefined;
  target: Plan;
  periodEnd: number | null;
  preview: { amountDue: number; date: number | null } | null;
}): H {
  const up = (args.current?.rank ?? 0) < args.target.rank;
  return html`<div class="medium stack-lg">
  <div><p class="eyebrow"><a href="/konto/plan">← Skift plan</a></p>
    <h1>${up ? 'Bekræft opgradering' : 'Bekræft nedgradering'}</h1></div>
  <section class="card stack">
    <div class="compare" aria-label="Planskift">
      <div class="box"><div class="small muted">Nuværende</div><strong>${args.current?.name ?? 'Ukendt'}</strong><div class="small">${args.current ? formatKr(args.current.amount) + ' /md.' : ''}</div></div>
      <div class="arrow" aria-hidden="true">→</div>
      <div class="box"><div class="small muted">Ny plan</div><strong>${args.target.name}</strong><div class="small">${formatKr(args.target.amount)} /md.</div></div>
    </div>
    <p>Ændringen træder i kraft med det samme. ${up
      ? 'Du betaler forholdsmæssigt for den højere pris i resten af den nuværende periode.'
      : 'Du får forholdsmæssigt tilgodehavende for resten af den nuværende periode.'}
      Det afregnes på din næste faktura${args.periodEnd ? html` den <strong>${formatDate(args.periodEnd)}</strong>` : ''}.</p>
    ${args.preview
      ? html`<p class="alert alert-info">Forventet beløb på næste faktura: <strong>${formatKr(args.preview.amountDue, { decimals: true })}</strong> inkl. moms.</p>`
      : ''}
    <form method="post" action="/konto/plan" class="row">
      ${csrfField(args.csrf)}
      <input type="hidden" name="plan" value="${args.target.key}">
      <button class="btn btn-primary" type="submit" data-loading="Skifter plan …">Skift til ${args.target.name}</button>
      <a class="btn btn-secondary" href="/konto/plan">Fortryd</a>
    </form>
  </section>
</div>`;
}

// ---------------- Opsigelse ----------------

export function cancelPage(args: { csrf: string; sub: SubscriptionRow; cancellableFrom: number | null; blocked: boolean; error?: string }): H {
  const plan = getPlan(args.sub.plan);
  return html`<div class="medium stack-lg">
  <div><p class="eyebrow"><a href="/konto">← Overblik</a></p><h1>Opsig abonnement</h1></div>
  ${args.error ? alert('err', args.error) : ''}
  <section class="card stack">
    ${args.blocked
      ? html`<p>Dit abonnement${plan ? ` (${plan.name})` : ''} har en bindingsperiode og kan tidligst opsiges fra <strong>${formatDate(args.cancellableFrom)}</strong>.</p>
          <p class="muted small">Har du spørgsmål, så skriv til os under <a href="/konto/henvendelser">Ændringsønsker og support</a>.</p>
          <a class="btn btn-secondary" href="/konto">Tilbage til overblik</a>`
      : html`<p>Hvis du opsiger, kører dit abonnement${plan ? ` (${plan.name})` : ''} videre til og med <strong>${formatDate(args.sub.current_period_end)}</strong>. Derefter trækkes der ikke flere betalinger.</p>
          <p class="muted small">Du kan fortryde opsigelsen frem til denne dato.</p>
          <form method="post" action="/konto/opsig" class="row">
            ${csrfField(args.csrf)}
            <button class="btn btn-danger" type="submit" data-loading="Opsiger …">Ja, opsig abonnementet</button>
            <a class="btn btn-secondary" href="/konto">Behold abonnementet</a>
          </form>`}
  </section>
</div>`;
}

// ---------------- Fakturaer ----------------

const INVOICE_STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: 'Betalt', cls: 'b-ok' },
  open: { label: 'Ubetalt', cls: 'b-err' },
  draft: { label: 'Kladde', cls: 'b-neutral' },
  void: { label: 'Annulleret', cls: 'b-neutral' },
  uncollectible: { label: 'Ikke betalt', cls: 'b-err' },
};

export function invoicesPage(args: { csrf: string; invoices: StripeInvoice[] | null; hasStripeCustomer: boolean; flashKey?: string }): H {
  return html`<div class="stack-lg">
  <div><h1>Fakturaer og betaling</h1><p class="lead">Se og download dine fakturaer, og opdater det betalingskort, der trækkes fra.</p></div>
  ${flash(args.flashKey)}
  <section class="card" aria-labelledby="inv-h">
    <h2 id="inv-h">Fakturaer</h2>
    ${args.invoices === null
      ? alert('err', 'Fakturaerne kunne ikke hentes lige nu. Prøv igen om lidt.')
      : args.invoices.length === 0
        ? html`<p class="empty">Du har ingen fakturaer endnu.</p>`
        : html`<div class="table-wrap"><table class="responsive">
          <thead><tr><th scope="col">Dato</th><th scope="col">Nummer</th><th scope="col">Status</th><th scope="col" class="num">Beløb</th><th scope="col"><span class="visually-hidden">Handlinger</span></th></tr></thead>
          <tbody>${args.invoices.map((inv) => {
            const st = INVOICE_STATUS[inv.status ?? ''] ?? { label: inv.status ?? '–', cls: 'b-neutral' };
            return html`<tr>
              <td data-label="Dato">${formatDateShort(inv.created)}</td>
              <td data-label="Nummer">${inv.number ?? '–'}</td>
              <td data-label="Status"><span class="badge ${st.cls}">${st.label}</span></td>
              <td data-label="Beløb" class="num">${formatKr(inv.total, { decimals: true })}</td>
              <td data-label="" class="num">
                ${inv.invoice_pdf ? html`<a href="${inv.invoice_pdf}" rel="noopener">Hent PDF</a>` : ''}
                ${inv.status === 'open' && inv.hosted_invoice_url ? html` · <a href="${inv.hosted_invoice_url}" rel="noopener">Betal nu</a>` : ''}
                ${inv.status !== 'open' && inv.hosted_invoice_url ? html`<span class="visually-hidden"> · </span>` : ''}
              </td>
            </tr>`;
          })}</tbody></table></div>`}
  </section>
  <section class="card stack" id="kort" aria-labelledby="card-h">
    <h2 id="card-h">Betalingskort</h2>
    <p class="muted">Kortoplysninger håndteres sikkert af Stripe og gemmes aldrig hos Veyro. Du sendes til Stripe for at opdatere kortet og kommer tilbage hertil bagefter.</p>
    ${args.hasStripeCustomer
      ? html`<form method="post" action="/konto/betalingskort">
          ${csrfField(args.csrf)}
          <button class="btn btn-primary" type="submit" data-loading="Åbner Stripe …">Skift betalingskort</button>
        </form>
        <form method="post" action="/konto/portal" style="margin-top:12px">
          ${csrfField(args.csrf)}
          <button class="btn btn-secondary" type="submit" data-loading="Åbner Stripe …">Åbn Stripes kundeportal</button>
          <p class="small muted">I Stripes kundeportal kan du også hente alle fakturaer og kvitteringer.</p>
        </form>`
      : html`<p class="small muted">Der er endnu ikke tilknyttet et betalingskort til din konto.</p>`}
  </section>
</div>`;
}

// ---------------- Henvendelser ----------------

export interface RequestFormValues {
  type?: string;
  title?: string;
  description?: string;
}

export function requestsPage(args: {
  csrf: string;
  requests: RequestRow[];
  errors?: Record<string, string>;
  values?: RequestFormValues;
  flashKey?: string;
}): H {
  const e = args.errors ?? {};
  const v = args.values ?? {};
  const type = v.type ?? 'content';
  return html`<div class="stack-lg">
  <div><h1>Ændringsønsker og support</h1>
    <p class="lead">Send os ændringer til din hjemmeside, meld en fejl eller stil et spørgsmål. Du kan følge status her.</p></div>
  ${flash(args.flashKey)}
  <div class="grid grid-2" style="align-items:start">
    <section class="card" aria-labelledby="new-h">
      <h2 id="new-h">Ny henvendelse</h2>
      ${Object.keys(e).length ? alert('err', 'Ret venligst de markerede felter.') : ''}
      <form method="post" action="/konto/henvendelser" class="stack" novalidate style="margin-top:16px">
        ${csrfField(args.csrf)}
        <fieldset>
          <legend>Type</legend>
          <div class="choices">
            ${Object.entries(REQUEST_TYPES).map(
              ([k, label]) => html`<label class="choice"><input type="radio" name="type" value="${k}" ${type === k ? 'checked' : ''}><span>${label}</span></label>`,
            )}
          </div>
          ${e.type ? html`<p class="hint" style="color:var(--err)">${e.type}</p>` : ''}
        </fieldset>
        <div class="field">
          <label for="title">Overskrift</label>
          <input id="title" name="title" type="text" required minlength="3" maxlength="120" value="${v.title ?? ''}"
            placeholder="Fx: Nye åbningstider på forsiden"
            ${e.title ? html`aria-invalid="true" aria-describedby="title-err"` : ''}>
          ${e.title ? html`<p class="hint" id="title-err" style="color:var(--err)">${e.title}</p>` : ''}
        </div>
        <div class="field">
          <label for="description">Beskrivelse</label>
          <textarea id="description" name="description" required minlength="10" maxlength="5000" data-counter="desc-count"
            aria-describedby="desc-hint${e.description ? ' desc-err' : ''}" ${e.description ? html`aria-invalid="true"` : ''}>${v.description ?? ''}</textarea>
          <p class="hint" id="desc-hint">Beskriv så præcist som muligt – gerne med side og den ønskede tekst. <span id="desc-count"></span></p>
          ${e.description ? html`<p class="hint" id="desc-err" style="color:var(--err)">${e.description}</p>` : ''}
        </div>
        <button class="btn btn-primary" type="submit" data-loading="Sender …">Send henvendelse</button>
      </form>
    </section>
    <section class="card" aria-labelledby="list-h">
      <h2 id="list-h">Dine henvendelser</h2>
      ${args.requests.length === 0
        ? html`<p class="empty">Du har ikke sendt nogen henvendelser endnu.</p>`
        : html`<ul class="list" style="margin-top:16px">${args.requests.map((r) => {
            const st = REQUEST_STATUSES[r.status] ?? { label: r.status, tone: 'neutral' as const };
            return html`<li>
              <div class="item-head"><h3>${r.title}</h3><span class="badge ${badgeClass(st.tone)}">${st.label}</span></div>
              <div class="meta">${REQUEST_TYPES[r.type] ?? r.type} · ${formatDate(r.created_at)}</div>
              <details><summary>Vis beskrivelse</summary><p class="prewrap small">${r.description}</p></details>
            </li>`;
          })}</ul>`}
    </section>
  </div>
</div>`;
}

// ---------------- Fejl ----------------

export function errorPage(title: string, text: string, link: { href: string; label: string } = { href: '/', label: 'Til forsiden' }): H {
  return html`<div class="narrow stack-lg">
  <div><h1>${title}</h1><p class="lead">${text}</p></div>
  <a class="btn btn-primary" href="${link.href}">${link.label}</a>
</div>`;
}
