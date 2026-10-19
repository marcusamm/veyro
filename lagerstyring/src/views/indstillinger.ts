import { html } from 'hono/html';
import type { MailRow, SupplierRow, User } from '../env';
import { formatDateTime } from '../lib/format';
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
}): H {
  const s = d.s;
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
  ${pageHead('Lagerportal', 'Indstillinger', html`<a class="btn btn-secondary" href="/lager/indstillinger/mails">E-mail-log</a>`)}
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
      <div class="field"><label for="default_markup_pct">Standardavance på materialer (%)</label><input id="default_markup_pct" class="in-num" name="default_markup_pct" inputmode="numeric" value="${s.default_markup_pct}"><p class="hint">Bruges på fakturagrundlaget, når en vare ikke har en salgspris.</p></div>
      <div class="field"><label for="purchase_digest_hours">Samlet e-mail med nye indkøbsbehov</label><select id="purchase_digest_hours" name="purchase_digest_hours">${DIGEST_CHOICES.map(
        (h) => html`<option value="${h}"${h === s.purchase_digest_hours ? ' selected' : ''}>${h === 0 ? 'Slået fra (kun manuel afsendelse)' : h === 1 ? 'Hver time' : h === 24 ? 'Én gang i døgnet' : `Hver ${h}. time`}</option>`,
      )}</select><p class="hint">Sendes til modtagere af indkøbslister. Sætter aldrig noget til "Bestilt".</p></div>
    </div>
    ${check('alert_mail_enabled', s.alert_mail_enabled, 'Send lageradvarsler på e-mail med det samme')}
    <p class="hint">Der sendes kun en ny advarsel, når en vare bliver værre (genbestilling → kritisk → ingen disponible), ikke igen for samme behov. Der sendes aldrig noget til leverandører.</p>
    <div><button class="btn btn-primary" type="submit">Gem</button></div>
  </form>

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
    <div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Navn</th><th>E-mail</th><th>Rolle</th><th>E-mails</th><th>Aktiv</th><th></th></tr></thead>
      <tbody>${d.users.map(
        (u) => html`<tr><td colspan="6" style="padding:0"><form method="post" action="/lager/indstillinger/bruger/${u.id}" class="row" style="padding:10px 12px;flex-wrap:wrap">
        ${csrfField(d.csrf)}
        <input name="name" value="${u.name}" maxlength="80" required aria-label="Navn" style="max-width:180px">
        <span class="muted small" style="min-width:200px">${u.email}</span>
        ${roleSelect('role', u.role, `role${u.id}`)}
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
