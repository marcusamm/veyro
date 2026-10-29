import { html } from 'hono/html';
import type { LabourTypeRow, MailRow, SupplierRow, User } from '../env';
import type { RetailerView } from '../lib/estimates';
import { retailerLive } from '../lib/jobitems';
import { formatDateTime, oereToInput } from '../lib/format';
import { DIGEST_CHOICES, LOGO_MAX_BYTES, type Settings } from '../lib/settings';
import { errors, flash, mailTag, pageHead } from './common';
import { accentOf, alert, brandMark, csrfField, type H } from './layout';

const ROLE_LABEL: Record<User['role'], string> = { ejer: 'Ejer', indkober: 'Indkøber', medarbejder: 'Medarbejder' };

function roleSelect(name: string, v: User['role'], id: string): H {
  return html`<select name="${name}" id="${id}">${(Object.keys(ROLE_LABEL) as User['role'][]).map(
    (r) => html`<option value="${r}"${r === v ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`,
  )}</select>`;
}

function check(name: string, on: boolean, label: string): H {
  return html`<label class="check"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${label}</label>`;
}

export function settingsPage(d: {
  s: Settings;
  users: User[];
  suppliers: SupplierRow[];
  csrf: string;
  mailConfigured: boolean;
  canEditLogo: boolean;
  /** Adresserne i ADMIN_EMAILS, som altid er administratorer */
  fixedAdmins: string[];
  demo: boolean;
  flashCode?: string;
  errs: string[];
  labourTypes: LabourTypeRow[];
  retailers: RetailerView[];
}): H {
  const s = d.s;
  const kr = (v: number | null) => (v === null || v === 0 ? '' : oereToInput(v));
  const typeSelect = (u: User): H => html`<select name="labour_type_id" aria-label="Medarbejdertype"><option value="">Ingen type</option>${d.labourTypes.map(
    (t) => html`<option value="${t.id}"${t.id === u.labour_type_id ? ' selected' : ''}>${t.name}</option>`,
  )}</select>`;
  const fixed = new Set(d.fixedAdmins);
  // Fast administrator (ADMIN_EMAILS) kan ikke ændres her; andre kan kun ændres af en administrator
  const adminCell = (u: User): H | '' =>
    fixed.has(u.email.toLowerCase())
      ? html`<span class="tag" title="Fast administrator">Administrator</span>`
      : d.canEditLogo
        ? check('is_admin', !!u.is_admin, 'Administrator')
        : u.is_admin
          ? html`<span class="tag">Administrator</span>`
          : '';
  return html`<div class="stack-lg" style="max-width:1000px">
  ${pageHead('Lagerportal', 'Indstillinger', html`<a class="btn btn-primary" href="/lager/guide">Opsætningsguide</a><a class="btn btn-secondary" href="/lager/indstillinger/mails">E-mail-log</a>`)}
  ${flash(d.flashCode)}${errors(d.errs)}
  ${d.mailConfigured
    ? alert('ok', 'E-mail er sat op. Advarsler og indkøbslister sendes til de valgte modtagere.')
    : alert('warn', html`<strong>E-mail er ikke sat op.</strong> Advarsler og indkøbslister bliver kun <strong>simuleret</strong>: de gemmes i e-mail-loggen, men sendes ikke.`)}

  <form method="post" action="/lager/indstillinger/firma" class="card stack">
    ${csrfField(d.csrf)}
    <h2>Virksomhed og advarsler</h2>
    <div class="fields fields-2">
      <div class="field"><label for="company_name">Firmanavn</label><input id="company_name" name="company_name" required maxlength="80" value="${s.company_name}"></div>
      <div class="field"><label for="accent_color">Accentfarve</label><input id="accent_color" type="color" name="accent_color" value="${accentOf(s)}"></div>
    </div>
    <div class="fields fields-2">
      <div class="field"><label for="default_markup_pct">Standardpåslag på materialer (%)</label><input id="default_markup_pct" class="in-num" name="default_markup_pct" inputmode="numeric" value="${s.default_markup_pct}"><p class="hint">Lægges på kostprisen, når en vare ikke har en salgspris. Kan ændres pr. job og pr. linje.</p></div>
      <div class="field"><label for="purchase_digest_hours">Samlet e-mail med nye indkøbsbehov</label><select id="purchase_digest_hours" name="purchase_digest_hours">${DIGEST_CHOICES.map(
        (h) => html`<option value="${h}"${h === s.purchase_digest_hours ? ' selected' : ''}>${h === 0 ? 'Slået fra (kun manuel afsendelse)' : h === 1 ? 'Hver time' : h === 24 ? 'Én gang i døgnet' : `Hver ${h}. time`}</option>`,
      )}</select><p class="hint">Sendes til modtagere af indkøbslister. Sætter aldrig noget til "Bestilt".</p></div>
    </div>
    ${check('alert_mail_enabled', s.alert_mail_enabled, 'Send lageradvarsler på e-mail med det samme')}
    <p class="hint">Der sendes kun en ny advarsel, når en vare bliver værre (genbestilling → kritisk → ingen disponible), ikke igen for samme behov. Der sendes aldrig noget til leverandører.</p>
    <div><button class="btn btn-primary" type="submit">Gem</button></div>
  </form>


  <form method="post" action="/lager/indstillinger/faktura" class="card stack">
    ${csrfField(d.csrf)}
    <h2>Oplysninger på prisoverslag og fakturaer</h2>
    ${s.vat_registered === ''
      ? alert('warn', 'Angiv, om virksomheden er momsregistreret, og udfyld CVR og adresse, før der kan udstedes fakturaer.')
      : ''}
    <div class="fields fields-2">
      <div class="field"><label for="company_address">Adresse</label><textarea id="company_address" name="company_address" rows="2" maxlength="200">${s.company_address}</textarea></div>
      <div class="field"><label for="company_cvr">CVR-nummer</label><input id="company_cvr" name="company_cvr" inputmode="numeric" maxlength="8" value="${s.company_cvr}"></div>
      <div class="field"><label for="company_email">E-mail</label><input id="company_email" name="company_email" type="email" maxlength="254" value="${s.company_email}"></div>
      <div class="field"><label for="company_phone">Telefon</label><input id="company_phone" name="company_phone" maxlength="40" value="${s.company_phone}"></div>
      <div class="field"><label for="bank_reg">Bank: reg.nr.</label><input id="bank_reg" name="bank_reg" inputmode="numeric" maxlength="4" value="${s.bank_reg}"></div>
      <div class="field"><label for="bank_account">Bank: kontonr.</label><input id="bank_account" name="bank_account" inputmode="numeric" maxlength="14" value="${s.bank_account}"></div>
      <div class="field"><label for="vat_registered">Momsregistreret</label><select id="vat_registered" name="vat_registered">
        <option value=""${s.vat_registered === '' ? ' selected' : ''}>Ikke oplyst</option>
        <option value="ja"${s.vat_registered === 'ja' ? ' selected' : ''}>Ja, 25 % moms</option>
        <option value="nej"${s.vat_registered === 'nej' ? ' selected' : ''}>Nej, ingen moms</option>
      </select></div>
      <div class="field"><label for="payment_days">Betalingsfrist (dage)</label><input id="payment_days" class="in-num" name="payment_days" inputmode="numeric" value="${s.payment_days}"></div>
      <div class="field"><label for="invoice_start">Første fakturanummer</label><input id="invoice_start" class="in-num" name="invoice_start" inputmode="numeric" value="${s.invoice_start}"><p class="hint">Bruges kun, indtil den første faktura er udstedt. Derefter fortsætter numrene fortløbende.</p></div>
      <div class="field"><label for="quote_valid_days">Prisoverslag gælder (dage)</label><input id="quote_valid_days" class="in-num" name="quote_valid_days" inputmode="numeric" value="${s.quote_valid_days}"></div>
      <div class="field"><label for="quote_note">Tekst på prisoverslag</label><textarea id="quote_note" name="quote_note" rows="2" maxlength="600">${s.quote_note}</textarea></div>
      <div class="field"><label for="invoice_note">Tekst på fakturaer</label><textarea id="invoice_note" name="invoice_note" rows="2" maxlength="600">${s.invoice_note}</textarea></div>
    </div>
    <p class="hint">Kravene til fakturaer og moms (fx ved B2B, B2C og omvendt betalingspligt) skal bekræftes med revisor eller Skattestyrelsen, før systemet bruges til rigtige fakturaer.</p>
    <div><button class="btn btn-primary" type="submit">Gem</button></div>
  </form>

  <section class="card stack">
    <h2>Arbejdstimer og timesatser</h2>
    <p class="muted small">Den interne timeomkostning er en samlet sats (løn, pension, feriepenge m.m.) til at se jobbets dækningsbidrag. Det er ikke et lønsystem, og satsen vises aldrig for slutkunden.</p>
    <form method="post" action="/lager/indstillinger/timer" class="row" style="flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <label class="small">Standard timepris til slutkunden <input class="in-num" name="default_hour_rate" inputmode="decimal" value="${kr(s.default_hour_rate)}" placeholder="kr." aria-label="Standard timepris i kr. ekskl. moms"></label>
      <label class="small">Standard intern timeomkostning <input class="in-num" name="default_internal_cost" inputmode="decimal" value="${kr(s.default_internal_cost)}" placeholder="kr." aria-label="Standard intern timeomkostning i kr."></label>
      <button class="btn btn-secondary btn-small" type="submit">Gem</button>
    </form>
    <div class="table-wrap"><table class="list dense"><tbody>${d.labourTypes.map(
      (t) => html`<tr><td style="padding:0"><form method="post" action="/lager/indstillinger/medarbejdertype/${t.id}" class="row" style="padding:10px 12px;flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <input name="name" value="${t.name}" maxlength="60" required aria-label="Medarbejdertype" style="max-width:200px">
      <label class="small">Intern <input class="in-num in-sm" name="internal_cost" inputmode="decimal" value="${kr(t.internal_cost)}" aria-label="Intern timeomkostning i kr."></label>
      <label class="small">Timepris <input class="in-num in-sm" name="bill_rate" inputmode="decimal" value="${kr(t.bill_rate)}" aria-label="Timepris til slutkunden i kr. ekskl. moms"></label>
      ${check('active', !!t.active, 'Aktiv')}
      <button class="btn btn-secondary btn-small" type="submit">Gem</button>
    </form></td></tr>`,
    )}</tbody></table></div>
    <form method="post" action="/lager/indstillinger/medarbejdertype" class="row" style="flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <input name="name" placeholder="Fx Tømrer eller Lærling" maxlength="60" required aria-label="Medarbejdertype" style="max-width:200px">
      <label class="small">Intern <input class="in-num in-sm" name="internal_cost" inputmode="decimal" aria-label="Intern timeomkostning i kr."></label>
      <label class="small">Timepris <input class="in-num in-sm" name="bill_rate" inputmode="decimal" aria-label="Timepris til slutkunden i kr. ekskl. moms"></label>
      <button class="btn btn-primary btn-small" type="submit">+ Tilføj type</button>
    </form>
    <p class="hint">Alle beløb er pr. time ekskl. moms. Tom timepris betyder, at standard timeprisen bruges. Medarbejderens type vælges under Brugere.</p>
  </section>

  <section class="card stack">
    <h2>Logo</h2>
    <p class="muted small">Vises i toppen af siden ved firmanavnet og som ikon i browserens faneblad. PNG, JPG, WebP eller SVG på højst ${Math.round(LOGO_MAX_BYTES / 1024)} KB. Et bredt logo med gennemsigtig baggrund ser bedst ud.</p>
    <div class="row" style="flex-wrap:wrap;gap:12px">
      <span class="brand">${brandMark(s)}<span class="brand-name">${s.company_name}</span></span>
    </div>
    ${d.canEditLogo ? html`<form method="post" action="/lager/indstillinger/logo" enctype="multipart/form-data" class="row" style="flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <input type="file" name="logo" accept="image/png,image/jpeg,image/webp,image/svg+xml" required aria-label="Logofil">
      <button class="btn btn-primary" type="submit">${s.logo_version ? 'Skift logo' : 'Upload logo'}</button>
    </form>
    ${s.logo_version
      ? html`<form method="post" action="/lager/indstillinger/logo/slet">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Fjern logo</button></form>`
      : ''}` : html`<p class="hint">Kontakt Veyro, hvis logoet skal skiftes.</p>`}
  </section>

  <section class="card stack">
    <h2>Brugere og e-mail-modtagere</h2>
    <p class="muted small">Administratorer kan skifte logo og gøre andre til administratorer. En invitation er en e-mail med et link til login-siden, hvor brugeren logger ind med sin e-mailadresse.</p>
    <p class="muted small">Ejer og indkøber kan se priser og bruge lagerportalen. Medarbejdere bruger forbrugsportalen og ser ingen priser, heller ikke i e-mails.</p>
    <p class="hint">Lageradvarsler sendes kun til aktive ejere og indkøbere, der er valgt som modtagere.</p>
    <div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Navn</th><th>E-mail</th><th>Rolle</th><th>E-mails</th><th>Aktiv</th><th></th></tr></thead>
      <tbody>${d.users.map(
        (u) => html`<tr><td colspan="6" style="padding:0"><form method="post" action="/lager/indstillinger/bruger/${u.id}" class="row" style="padding:10px 12px;flex-wrap:wrap">
        ${csrfField(d.csrf)}
        <input name="name" value="${u.name}" maxlength="80" required aria-label="Navn" style="max-width:180px">
        <span class="muted small" style="min-width:200px">${u.email}</span>
        ${roleSelect('role', u.role, `role${u.id}`)}
        ${typeSelect(u)}
        ${check('alert_mail', !!u.alert_mail, 'Lageradvarsler')}
        ${check('purchase_mail', !!u.purchase_mail, 'Indkøbslister')}
        ${check('active', !!u.active, 'Aktiv')}
        ${adminCell(u)}
        <button class="btn btn-secondary btn-small" type="submit">Gem</button>
      </form></td></tr>`,
      )}</tbody>
    </table></div>
    <form method="post" action="/lager/indstillinger/bruger" class="row" style="flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <input name="name" placeholder="Navn" maxlength="80" required aria-label="Navn" style="max-width:180px">
      <input name="email" type="email" placeholder="E-mail" maxlength="254" required aria-label="E-mail" style="max-width:240px">
      ${roleSelect('role', 'medarbejder', 'role_new')}
      ${check('alert_mail', false, 'Lageradvarsler')}
      ${check('purchase_mail', false, 'Indkøbslister')}
      ${d.canEditLogo ? check('is_admin', false, 'Administrator') : ''}
      ${check('invite', true, 'Send invitation på e-mail')}
      <button class="btn btn-primary btn-small" type="submit">+ Tilføj bruger</button>
    </form>
  </section>

  <section class="card stack">
    <div class="row-between"><h2>Byggemarked og prisopslag</h2><a class="btn btn-secondary btn-small" href="/lager/priser">Forhandlere og prisfiler</a></div>
    <form method="post" action="/lager/indstillinger/byggemarked" class="row" style="flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <label for="preferred_retailer" class="small">Foretrukket byggemarked</label>
      <select id="preferred_retailer" name="preferred_retailer"><option value="">Intet valgt</option>${d.retailers
        .filter((r) => r.access !== 'demo' || d.demo)
        .map((r) => html`<option value="${r.key}"${r.key === s.preferred_retailer ? ' selected' : ''}>${r.name} · ${retailerLive(r) ? 'Aktiv' : 'Kommer senere'}</option>`)}</select>
      <button class="btn btn-secondary btn-small" type="submit">Gem</button>
    </form>
    <p class="muted small" style="margin:0">Bruges som standard på nye job og kan ændres pr. job og pr. materialelinje. Der skiftes aldrig byggemarked i stilhed. "Aktiv" betyder, at prisopslag er bygget og afprøvet; ved "Kommer senere" bruges produktlink og manuel pris.</p>
  </section>

  <section class="card stack">
    <h2>Leverandører</h2>
    <p class="muted small">Leveringstiden bruges i genbestillingspunktet, når varen ikke har sin egen. Alle tider er i kalenderdage.</p>
    <div class="table-wrap"><table class="list dense"><tbody>${d.suppliers.map(
      (x) => html`<tr><td style="padding:0"><form method="post" action="/lager/indstillinger/leverandor/${x.id}" class="row" style="padding:10px 12px;flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <input name="name" value="${x.name}" maxlength="80" required aria-label="Navn" style="max-width:200px">
      <input name="email" type="email" value="${x.email}" maxlength="254" placeholder="E-mail" aria-label="E-mail" style="max-width:220px">
      <input name="phone" value="${x.phone}" maxlength="40" placeholder="Telefon" aria-label="Telefon" style="max-width:140px">
      <input class="in-num in-sm" name="lead_time_days" inputmode="numeric" value="${x.lead_time_days ?? ''}" placeholder="dage" aria-label="Leveringstid i dage"><span class="xs muted">dages levering</span>
      <button class="btn btn-secondary btn-small" type="submit">Gem</button>
    </form></td></tr>`,
    )}</tbody></table></div>
    <form method="post" action="/lager/indstillinger/leverandor" class="row" style="flex-wrap:wrap">
      ${csrfField(d.csrf)}
      <input name="name" placeholder="Leverandør" maxlength="80" required aria-label="Navn" style="max-width:200px">
      <input name="email" type="email" placeholder="E-mail" maxlength="254" aria-label="E-mail" style="max-width:220px">
      <input name="phone" placeholder="Telefon" maxlength="40" aria-label="Telefon" style="max-width:140px">
      <input class="in-num in-sm" name="lead_time_days" inputmode="numeric" placeholder="dage" aria-label="Leveringstid i dage">
      <button class="btn btn-primary btn-small" type="submit">+ Tilføj leverandør</button>
    </form>
  </section>

  ${d.demo
    ? html`<form method="post" action="/lager/demo/nulstil" class="card stack" data-confirm="Nulstil alle data til demoens udgangspunkt?">
      ${csrfField(d.csrf)}<h2>Demo</h2><p class="muted small">Sletter alle registreringer og lægger eksempeldata ind igen.</p>
      <div><button class="btn btn-danger" type="submit">Nulstil demodata</button></div></form>`
    : ''}
</div>`;
}

export function mailsPage(d: { mails: MailRow[]; open: MailRow | null }): H {
  return html`<div class="stack-lg">
  ${pageHead('Indstillinger', 'E-mail-log', html`<a class="btn btn-ghost" href="/lager/indstillinger">← Indstillinger</a>`, 'Alle e-mails fra systemet. "Simuleret" betyder, at e-mailen ikke er sendt.')}
  ${d.open
    ? html`<div class="card stack"><div class="row-between"><strong>${d.open.subject}</strong>${mailTag(d.open.status)}</div>
      <p class="muted small">Til ${d.open.recipient} · ${formatDateTime(d.open.created_at)}${d.open.list_version ? ` · listeversion ${d.open.list_version}` : ''}</p>
      <pre style="white-space:pre-wrap;font:inherit;margin:0">${d.open.body_text}</pre></div>`
    : ''}
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Tidspunkt</th><th>Emne</th><th>Modtager</th><th>Status</th></tr></thead>
    <tbody>${d.mails.length
      ? d.mails.map(
          (m) => html`<tr class="row-link" data-href="/lager/indstillinger/mails?vis=${m.id}"><td data-label="Tidspunkt">${formatDateTime(m.created_at)}</td>
        <td class="cell-main"><a class="title" href="/lager/indstillinger/mails?vis=${m.id}">${m.subject}</a></td><td data-label="Modtager">${m.recipient}</td><td data-label="Status">${mailTag(m.status)}</td></tr>`,
        )
      : html`<tr><td colspan="4" class="empty">Ingen e-mails endnu.</td></tr>`}</tbody>
  </table></div></div>
</div>`;
}
