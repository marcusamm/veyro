// Visninger for fuldmagter: kundens side "Fuldmagter" og Veyros administration.
import { html } from 'hono/html';
import { formatDateTime, formatKr } from '../lib/format';
import {
  CONFIRMATIONS,
  DELETION_LABEL,
  EVENT_LABEL,
  ORDER_EXCLUSIONS,
  POWER_KEYS,
  POWERS,
  REVOKE_TEXT,
  STATUS_LABEL,
  STATUS_TONE,
  TERMS,
  VEYRO_FIELDS,
  formatDay,
  label,
  lines,
  type ActionRow,
  type DeletionRequestRow,
  type EventRow,
  type PoaForm,
  type PoaRow,
  type PoaSettings,
  type Snapshot,
  type TaskRow,
} from '../lib/poa';
import { MAIL_LABEL, MAIL_STATUS, type MailRow } from '../lib/poa-docs';
import { POLICY, POLICY_STATUS, RETENTION } from '../lib/poa-policy';
import { alert, csrfField, type H } from './layout';
import { badgeClass } from './status';

const BASE = '/konto/fuldmagter';

export const POA_FLASH: Record<string, { kind: 'ok' | 'info' | 'warn' | 'err'; text: string }> = {
  'kladde-gemt': { kind: 'ok', text: 'Kladden er gemt. Du kan fortsætte senere.' },
  'kladde-slettet': { kind: 'ok', text: 'Kladden er slettet.' },
  tilbagekaldt: { kind: 'ok', text: 'Fuldmagten er tilbagekaldt. Veyro kan ikke længere udføre nye handlinger under den.' },
  'sletning-anmodet': { kind: 'ok', text: 'Din anmodning om sletning er modtaget. Du kan følge behandlingen nederst på siden.' },
  'ikke-kladde': { kind: 'info', text: 'Fuldmagten er allerede godkendt og kan ikke redigeres. Opret en ny version, hvis noget skal ændres.' },
  'allerede-behandlet': { kind: 'info', text: 'Handlingen er allerede gennemført.' },
  'ikke-aktiv': { kind: 'info', text: 'Fuldmagten er ikke aktiv eller afventende og kan derfor ikke tilbagekaldes.' },
};

function poaFlash(key: string | undefined): H | '' {
  const f = key ? POA_FLASH[key] : undefined;
  return f ? alert(f.kind, f.text) : '';
}

export function statusBadge(status: PoaRow['status']): H {
  return html`<span class="badge ${badgeClass(STATUS_TONE[status])}">${STATUS_LABEL[status]}</span>`;
}

function deletionBadge(poa: Pick<PoaRow, 'deletion_status' | 'retain_until'>): H | '' {
  if (poa.deletion_status === 'requested') return html`<span class="badge b-warn">Sletning anmodet</span>`;
  if (poa.deletion_status === 'retained') return html`<span class="badge b-neutral">Opbevares til ${formatDayFromSec(poa.retain_until)}</span>`;
  return '';
}

function formatDayFromSec(sec: number | null): string {
  return sec ? new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Copenhagen' }).format(new Date(sec * 1000)) : '–';
}

export function envBanners(opts: { testLabel?: string | null; textDraft?: boolean }): H {
  return html`${opts.testLabel
    ? alert('warn', html`<strong>${opts.testLabel}:</strong> Dette er et testmiljø med testdata. Fuldmagter oprettet her er ikke gyldige.`)
    : ''}
  ${opts.textDraft
    ? alert(
        'warn',
        html`<strong>Udkast:</strong> Fuldmagtsteksten, godkendelsesmetoden og opbevaringspolitikken er endnu ikke endeligt gennemgået af Veyro. Dokumenter mærkes "Udkast".`,
      )
    : ''}`;
}

function err(e: Record<string, string>, k: string): H | '' {
  return e[k] ? html`<p class="hint" id="${k}-err" style="color:var(--err)">${e[k]}</p>` : '';
}
function inv(e: Record<string, string>, k: string): H | '' {
  return e[k] ? html` aria-invalid="true" aria-describedby="${k}-err"` : '';
}

function input(e: Record<string, string>, f: PoaForm, k: keyof PoaForm, lbl: string, opts: { type?: string; hint?: string; required?: boolean; auto?: string } = {}): H {
  return html`<div class="field">
    <label for="f-${k}">${lbl}${opts.required === false ? html` <span class="muted small">(valgfri)</span>` : ''}</label>
    <input id="f-${k}" name="${k}" type="${opts.type ?? 'text'}" value="${String(f[k])}"${opts.auto ? html` autocomplete="${opts.auto}"` : ''}${inv(e, k)}>
    ${opts.hint ? html`<p class="hint">${opts.hint}</p>` : ''}${err(e, k)}
  </div>`;
}
function textarea(e: Record<string, string>, f: PoaForm, k: keyof PoaForm, lbl: string, opts: { hint?: string; max: number; required?: boolean; rows?: number }): H {
  return html`<div class="field">
    <label for="f-${k}">${lbl}${opts.required === false ? html` <span class="muted small">(valgfri)</span>` : ''}</label>
    <textarea id="f-${k}" name="${k}" maxlength="${opts.max}" style="min-height:${(opts.rows ?? 4) * 26 + 24}px"${inv(e, k)}>${String(f[k])}</textarea>
    ${opts.hint ? html`<p class="hint">${opts.hint}</p>` : ''}${err(e, k)}
  </div>`;
}

function veyroBox(s: PoaSettings): H {
  return html`<dl class="facts">
    ${VEYRO_FIELDS.map(
      ([k, lbl]) => html`<div><dt>${lbl}</dt><dd>${String(s[k]).trim() ? String(s[k]) : html`<span class="muted" style="font-weight:500">Mangler – udfyldes af Veyro</span>`}</dd></div>`,
    )}
  </dl>`;
}

// ---------------- Kunde: liste ----------------

export function poaListPage(args: {
  rows: PoaRow[];
  requests: DeletionRequestRow[];
  canIssue: boolean;
  flashKey?: string;
  testLabel?: string | null;
  textDraft: boolean;
}): H {
  return html`<div class="stack-lg">
  <div class="row between" style="align-items:flex-end">
    <div><h1>Fuldmagter</h1>
      <p class="lead" style="margin-bottom:0">Her giver du Veyro fuldmagt til konkrete opgaver for din virksomhed. Du kan altid se, hente og tilbagekalde dine fuldmagter.</p></div>
    ${args.canIssue ? html`<a class="btn btn-primary" href="${BASE}/ny">Ny fuldmagt</a>` : ''}
  </div>
  ${envBanners({ testLabel: args.testLabel, textDraft: args.textDraft && args.canIssue })}
  ${poaFlash(args.flashKey)}
  ${!args.canIssue && args.rows.length === 0
    ? html`<section class="card"><p class="empty">Digitale fuldmagter er ikke åbnet for din konto endnu. Kontakt os på <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>, hvis du har brug for at give Veyro fuldmagt.</p></section>`
    : html`<section class="card" aria-labelledby="poa-h">
    <h2 id="poa-h" class="visually-hidden">Dine fuldmagter</h2>
    ${args.rows.length === 0
      ? html`<p class="empty">Du har ingen fuldmagter endnu.</p>`
      : html`<div class="table-wrap"><table class="responsive">
        <thead><tr><th>Nummer</th><th>Virksomhed og projekt</th><th>Oprettet</th><th>Udløber</th><th>Status</th><th><span class="visually-hidden">Handlinger</span></th></tr></thead>
        <tbody>${args.rows.map(
          (p) => html`<tr>
            <td data-label="Nummer"><a href="${BASE}/${p.id}"><strong>${label(p)}</strong></a></td>
            <td data-label="Virksomhed og projekt"><div>${p.company_name || html`<span class="muted">Ikke udfyldt</span>`}<br><span class="muted small">${p.project || ''}</span></div></td>
            <td data-label="Oprettet">${formatDayFromSec(p.created_at)}</td>
            <td data-label="Udløber">${p.expires_on ? formatDay(p.expires_on) : html`<span class="muted">Ingen</span>`}</td>
            <td data-label="Status"><div class="stack-xs">${statusBadge(p.status)}${deletionBadge(p)}</div></td>
            <td data-label="Handlinger"><div class="row poa-actions">
              <a class="btn btn-secondary btn-small" href="${BASE}/${p.id}">Åbn</a>
              ${p.status === 'draft'
                ? html`<a class="btn btn-secondary btn-small" href="${BASE}/${p.id}/rediger">Rediger</a>
                  <a class="btn btn-danger btn-small" href="${BASE}/${p.id}/slet">Slet kladde</a>`
                : html`<a class="btn btn-secondary btn-small" href="${BASE}/${p.id}/pdf">Download</a>
                  ${p.status === 'active' || p.status === 'pending' ? html`<a class="btn btn-danger btn-small" href="${BASE}/${p.id}/tilbagekald">Tilbagekald</a>` : ''}
                  ${p.deletion_status === 'none' ? html`<a class="btn btn-secondary btn-small" href="${BASE}/${p.id}/slet">Anmod om sletning</a>` : ''}`}
            </div></td>
          </tr>`,
        )}</tbody></table></div>`}
  </section>`}
  ${args.requests.length
    ? html`<section class="card" aria-labelledby="del-h">
      <h2 id="del-h">Sletteanmodninger</h2>
      <ul class="list" style="margin-top:16px">${args.requests.map(
        (r) => html`<li>
          <div class="item-head"><h3>Fuldmagt ${r.poa_label}</h3><span class="badge ${r.status === 'completed' ? 'b-ok' : r.status === 'retained' ? 'b-neutral' : 'b-warn'}">${DELETION_LABEL[r.status]}</span></div>
          <div class="meta">Anmodet ${formatDateTime(r.requested_at)}${r.handled_at ? html` · Behandlet ${formatDateTime(r.handled_at)}` : ''}</div>
          ${r.result_text ? html`<p class="small" style="margin-top:8px">${r.result_text}</p>` : ''}
        </li>`,
      )}</ul>
    </section>`
    : ''}
  <p class="small muted"><a href="/fuldmagter/opbevaring">Sådan opbevarer og sletter vi fuldmagter</a></p>
</div>`;
}

// ---------------- Kunde: formular ----------------

export function poaFormPage(args: {
  csrf: string;
  poa: PoaRow | null;
  form: PoaForm;
  errors: Record<string, string>;
  settings: PoaSettings;
  idem: string;
  testLabel?: string | null;
  replaces?: string | null;
}): H {
  const { form: f, errors: e } = args;
  const action = args.poa ? `${BASE}/${args.poa.id}/rediger` : `${BASE}/ny`;
  const checked = (k: string) => (f.powers.includes(k as never) ? 'checked' : '');
  return html`<div class="stack-lg medium-wide">
  <div><p class="eyebrow"><a href="${BASE}">Fuldmagter</a></p>
    <h1>${args.poa ? `Fuldmagt ${label(args.poa)}` : 'Ny fuldmagt'}</h1>
    <p class="lead">Udfyld fuldmagten og vælg de beføjelser, Veyro skal have. Du kan gemme som kladde undervejs. Før du godkender, ser du hele teksten.</p></div>
  ${envBanners({ testLabel: args.testLabel, textDraft: !args.settings.text_approved })}
  ${args.replaces ? alert('info', html`Dette er en ny version af fuldmagt ${args.replaces}. Den tidligere version gælder uændret, indtil du tilbagekalder den.`) : ''}
  ${Object.keys(e).length ? alert('err', 'Ret venligst de markerede felter.') : ''}
  <form method="post" action="${action}" class="stack-lg" novalidate>
    ${csrfField(args.csrf)}
    <input type="hidden" name="_idem" value="${args.idem}">
    <section class="card stack" aria-labelledby="s1">
      <h2 id="s1">Kundens oplysninger</h2>
      <div class="grid grid-2 form-grid">
        ${input(e, f, 'company_name', 'Virksomhedsnavn', { auto: 'organization' })}
        ${input(e, f, 'cvr', 'CVR-nummer', { hint: '8 cifre' })}
        ${input(e, f, 'address', 'Adresse', { auto: 'street-address' })}
        ${input(e, f, 'postal_city', 'Postnummer og by', { hint: 'Fx 4200 Slagelse' })}
        ${input(e, f, 'contact_name', 'Kontaktperson', { auto: 'name' })}
        ${input(e, f, 'receipt_email', 'E-mail til kvittering', { type: 'email', auto: 'email' })}
        ${input(e, f, 'approver_name', 'Navn på den, der godkender')}
        ${input(e, f, 'approver_title', 'Titel på den, der godkender', { hint: 'Fx direktør eller indehaver' })}
      </div>
    </section>

    <section class="card stack" aria-labelledby="s2">
      <h2 id="s2">Veyros oplysninger</h2>
      <p class="hint" style="margin-top:0">Indsættes automatisk og vedligeholdes af Veyro.</p>
      ${veyroBox(args.settings)}
    </section>

    <section class="card stack" aria-labelledby="s3">
      <h2 id="s3">Fuldmagtens omfang</h2>
      ${input(e, f, 'project', 'Projekt, hjemmeside eller system', { hint: 'Fx "Webshop på firma.dk og lagerstyringen"' })}
      ${textarea(e, f, 'purpose', 'Konkret formål og ønskede opgaver', { max: 3000, rows: 4 })}
      ${textarea(e, f, 'parties', 'Navngivne leverandører, systemer og konti', {
        max: 2000,
        rows: 3,
        required: false,
        hint: 'Én pr. linje, fx "Simply.com (hosting, konto 12345)".',
      })}
      ${input(e, f, 'expires_on', 'Udløbsdato', { type: 'date', required: false, hint: 'Fuldmagten gælder til og med dagen. Uden dato gælder den, til du tilbagekalder den.' })}
    </section>

    <section class="card stack" aria-labelledby="s4">
      <h2 id="s4">Beføjelser</h2>
      <p class="hint" style="margin-top:0">Ingen beføjelser er valgt på forhånd. Beføjelser, du ikke krydser af, er ikke givet. Vælg mindst én.</p>
      ${e.powers ? html`<p class="hint" id="powers-err" style="color:var(--err)">${e.powers}</p>` : ''}
      <fieldset class="powers">
        <legend class="visually-hidden">Beføjelser</legend>
        ${POWER_KEYS.map(
          (k) => html`<div class="power" id="power-${k}">
            <label class="check power-label"><input type="checkbox" name="powers" value="${k}" id="p-${k}" ${checked(k)}>
              <span><strong>${POWERS[k].label}</strong>${k === 'other' ? html`<br><span class="small muted">Beskriv beføjelsen præcist i feltet nedenfor.</span>` : html`<br><span class="small">${POWERS[k].description}</span>`}</span></label>
            ${k === 'other'
              ? html`<div class="power-extra">${textarea(e, f, 'other_text', 'Beskriv beføjelsen præcist', { max: 2000, rows: 3 })}</div>`
              : ''}
            ${k === 'orders'
              ? html`<div class="power-extra stack">
                <p class="alert alert-warn small" style="margin:0">${ORDER_EXCLUSIONS}</p>
                <div class="grid grid-2 form-grid">
                  ${input(e, f, 'order_max_per_order', 'Maks. beløb pr. bestilling inkl. moms (kr.)', { hint: 'Fx 5.000' })}
                  ${input(e, f, 'order_max_per_month', 'Maks. samlet beløb pr. kalendermåned inkl. moms (kr.)', { hint: 'Fx 20.000' })}
                  ${textarea(e, f, 'order_suppliers', 'Godkendte leverandører', { max: 1000, rows: 3, hint: 'Én pr. linje.' })}
                  ${textarea(e, f, 'order_types', 'Godkendte vare- eller ydelsestyper', { max: 1000, rows: 3, hint: 'Én pr. linje.' })}
                  ${input(e, f, 'order_start', 'Startdato for bestillinger', { type: 'date' })}
                  ${input(e, f, 'order_end', 'Slutdato for bestillinger', { type: 'date' })}
                </div>
              </div>`
              : ''}
          </div>`,
        )}
      </fieldset>
    </section>

    <div class="row sticky-save">
      <button class="btn btn-primary" type="submit" name="next" value="review" data-loading="Gemmer …">Gem og se oversigt</button>
      <button class="btn btn-secondary" type="submit" name="next" value="draft" data-loading="Gemmer …">Gem kladde</button>
      <a class="btn btn-secondary" href="${BASE}">Annullér</a>
    </div>
  </form>
</div>`;
}

// ---------------- Fælles: fuldmagtens tekst ----------------

function factList(rows: [string, H | string][]): H {
  return html`<dl class="facts poa-facts">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}
function multi(list: string[]): H | string {
  return list.length ? html`${list.map((l, i) => html`${i ? html`<br>` : ''}${l}`)}` : html`<span class="muted">Ingen</span>`;
}

/** Hele fuldmagten med alle valg – samme indhold som PDF'en. */
export function poaDocument(s: Snapshot): H {
  return html`<div class="stack-lg poa-doc">
  ${s.test ? alert('warn', html`<strong>${s.test}:</strong> Testdokument – ikke gyldigt.`) : ''}
  ${s.text_draft ? alert('warn', html`<strong>Udkast:</strong> Fuldmagtsteksten er endnu ikke endeligt gennemgået og godkendt af Veyro.`) : ''}
  <section class="card"><h2>Fuldmagtsgiver (kunden)</h2>
    ${factList([
      ['Virksomhed', s.customer.company_name],
      ['CVR-nummer', s.customer.cvr],
      ['Adresse', `${s.customer.address}, ${s.customer.postal_city}`],
      ['Kontaktperson', s.customer.contact_name],
      ['E-mail til kvittering', s.customer.receipt_email],
      ['Godkender', `${s.approver.name}, ${s.approver.title}`],
    ])}</section>
  <section class="card"><h2>Fuldmægtig (Veyro)</h2>
    ${factList([
      ['Juridisk navn', s.veyro.legal_name || html`<span class="muted">Mangler</span>`],
      ['CVR-nummer', s.veyro.cvr || html`<span class="muted">Mangler</span>`],
      ['Adresse', s.veyro.address || html`<span class="muted">Mangler</span>`],
      ['Kontaktperson', s.veyro.contact_name || html`<span class="muted">Mangler</span>`],
      ['Kontaktmail', s.veyro.contact_email || html`<span class="muted">Mangler</span>`],
    ])}</section>
  <section class="card"><h2>Omfang</h2>
    ${factList([
      ['Projekt, hjemmeside eller system', s.scope.project],
      ['Formål og opgaver', html`<span class="prewrap">${s.scope.purpose}</span>`],
      ['Leverandører, systemer og konti', multi(s.scope.parties)],
      ['Udløbsdato', s.scope.expires_on ? `${formatDay(s.scope.expires_on)} (gyldig til og med dagen)` : 'Ingen – gælder til den tilbagekaldes'],
    ])}</section>
  <section class="card"><h2>Beføjelser</h2>
    <p class="hint" style="margin-top:0">Kun afkrydsede beføjelser er givet.</p>
    <ul class="list poa-powers" style="margin-top:12px">${s.powers.map(
      (p) => html`<li class="${p.granted ? 'granted' : 'not-granted'}">
        <div class="item-head"><h3>${p.granted ? '☑' : '☐'} ${p.label}</h3><span class="badge ${p.granted ? 'b-ok' : 'b-neutral'}">${p.granted ? 'Givet' : 'Ikke givet'}</span></div>
        <p class="small prewrap" style="margin:4px 0 0">${p.key === 'other' && s.other_text ? s.other_text : p.description}</p>
      </li>`,
    )}</ul></section>
  ${s.orders
    ? html`<section class="card"><h2>Betingelser for bestillinger</h2>
      ${factList([
        ['Maks. pr. bestilling', `${formatKr(s.orders.max_per_order_oere)} inkl. moms`],
        ['Maks. pr. kalendermåned', `${formatKr(s.orders.max_per_month_oere)} inkl. moms`],
        ['Godkendte leverandører', multi(s.orders.suppliers)],
        ['Varer eller ydelser', multi(s.orders.types)],
        ['Periode', `${formatDay(s.orders.start)} til og med ${formatDay(s.orders.end)}`],
      ])}
      <p class="alert alert-warn small" style="margin:16px 0 0">${s.orders.exclusions}</p></section>`
    : ''}
  <section class="card"><h2>Begrænsninger og vilkår</h2>
    <ul class="poa-terms">${s.terms.map((t) => html`<li>${t}</li>`)}</ul>
    <p class="small muted" style="margin:12px 0 0">Tekstversion: ${s.text_version}${s.requires_veyro_acceptance ? ' · Fuldmagten bliver først aktiv, når også Veyro har accepteret den.' : ''}</p>
  </section>
</div>`;
}

// ---------------- Kunde: oversigt og godkendelse ----------------

export function poaReviewPage(args: {
  csrf: string;
  poa: PoaRow;
  snap: Snapshot;
  hash: string;
  blockers: string[];
  sentTo?: string | null;
  devCode?: string | null;
  error?: string | null;
  testLabel?: string | null;
}): H {
  const { poa } = args;
  return html`<div class="stack-lg medium-wide">
  <div><p class="eyebrow"><a href="${BASE}">Fuldmagter</a> · ${label(poa)}</p>
    <h1>Gennemse og godkend</h1>
    <p class="lead">Her er hele fuldmagten med dine valg. Læs den igennem, før du godkender. Når den er godkendt, kan den ikke ændres.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  ${poaDocument(args.snap)}
  <section class="card stack" aria-labelledby="ok-h" id="godkend">
    <h2 id="ok-h">Godkendelse</h2>
    ${args.blockers.length
      ? html`${alert('err', html`Fuldmagten kan ikke godkendes endnu:<ul style="margin:8px 0 0;padding-left:20px">${args.blockers.map((b) => html`<li>${b}</li>`)}</ul>`)}
        <div class="row"><a class="btn btn-primary" href="${BASE}/${poa.id}/rediger">Ret fuldmagten</a></div>`
      : args.sentTo
        ? html`<p>Vi har sendt en engangskode til <strong>${args.sentTo}</strong>. Koden virker i 10 minutter.</p>
          ${args.devCode ? alert('info', html`Udviklingstilstand: koden er <strong class="devlink">${args.devCode}</strong>`) : ''}
          <form method="post" action="${BASE}/${poa.id}/godkend" class="stack" novalidate>
            ${csrfField(args.csrf)}
            <input type="hidden" name="hash" value="${args.hash}">
            ${CONFIRMATIONS.map(
              (c, i) => html`<label class="check confirm-check"><input type="checkbox" name="confirm${i + 1}" value="1" required><span>${c}</span></label>`,
            )}
            <div class="field">
              <label for="code">Engangskode</label>
              <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" style="max-width:200px;letter-spacing:.2em" required>
            </div>
            <p class="hint">Godkendelsen registreres med dit login, tidspunktet, metoden og den præcise tekst. Metoden bekræfter adgang til din e-mail. Den er ikke en MitID-signatur og dokumenterer ikke tegningsret.</p>
            <div class="row">
              <button class="btn btn-accent" type="submit" data-loading="Godkender …">Godkend fuldmagt</button>
            </div>
          </form>
          <form method="post" action="${BASE}/${poa.id}/kode" class="inline">${csrfField(args.csrf)}<input type="hidden" name="hash" value="${args.hash}"><button class="linkbtn small" type="submit">Send en ny kode</button></form>`
        : html`<p>For at godkende sender vi en engangskode til den e-mail, du er logget ind med. Du skal også bekræfte, at du har læst fuldmagten og har ret til at udstede den.</p>
          <form method="post" action="${BASE}/${poa.id}/kode" class="row">
            ${csrfField(args.csrf)}
            <input type="hidden" name="hash" value="${args.hash}">
            <button class="btn btn-primary" type="submit" data-loading="Sender …">Send engangskode</button>
            <a class="btn btn-secondary" href="${BASE}/${poa.id}/rediger">Ret fuldmagten</a>
          </form>`}
  </section>
</div>`;
}

// ---------------- Kunde: visning ----------------

export function poaDetailPage(args: {
  csrf: string;
  poa: PoaRow;
  snap: Snapshot | null;
  mails: MailRow[];
  tasks: TaskRow[];
  requests: DeletionRequestRow[];
  events: EventRow[];
  justApproved?: boolean;
  flashKey?: string;
  testLabel?: string | null;
}): H {
  const { poa, snap } = args;
  const receipt = args.mails.filter((m) => m.kind === 'receipt' || m.kind === 'activated' || m.kind === 'revoked');
  const third = args.tasks.filter((t) => t.kind === 'third_party');
  const live = poa.status === 'active' || poa.status === 'pending';
  return html`<div class="stack-lg medium-wide">
  <div><p class="eyebrow"><a href="${BASE}">Fuldmagter</a></p>
    <div class="plan-title"><h1 style="margin:0">Fuldmagt ${label(poa)}</h1>${statusBadge(poa.status)}${deletionBadge(poa)}</div>
    <p class="lead" style="margin-top:8px">${poa.company_name ?? ''}${poa.project ? ` · ${poa.project}` : ''}</p></div>
  ${args.testLabel ? alert('warn', html`<strong>${args.testLabel}:</strong> Testdata – ikke gyldig.`) : ''}
  ${poaFlash(args.flashKey)}
  ${args.justApproved
    ? html`<section class="card stack confirm-card">
      <h2>Tak – fuldmagten er godkendt</h2>
      ${poa.status === 'pending'
        ? alert('warn', html`<strong>Afventer Veyros accept.</strong> Fuldmagten er ikke aktiv endnu. Vi sender en ny besked, når den bliver aktiv.`)
        : alert('ok', 'Fuldmagten er aktiv.')}
      ${factList([
        ['Fuldmagtsnummer', label(poa)],
        ['Virksomhed', poa.company_name ?? ''],
        ['Godkendt', formatDateTime(poa.approved_at)],
        ['Status', STATUS_LABEL[poa.status]],
        ['Udløbsdato', poa.expires_on ? formatDay(poa.expires_on) : 'Ingen'],
        ['Kvittering', receipt[0] ? html`${MAIL_STATUS[receipt[0].status]!.label} til ${receipt[0].recipient}` : 'Ingen'],
      ])}
      <p class="small">Du kan tilbagekalde fuldmagten når som helst her på siden med knappen "Tilbagekald fuldmagt". Tilbagekaldelsen gælder med det samme.</p>
    </section>`
    : ''}
  ${poa.status === 'draft'
    ? html`<section class="card stack"><p>Fuldmagten er en kladde og er ikke givet endnu.</p>
      <div class="row"><a class="btn btn-primary" href="${BASE}/${poa.id}/rediger">Fortsæt</a><a class="btn btn-danger" href="${BASE}/${poa.id}/slet">Slet kladde</a></div></section>`
    : html`<section class="card stack" aria-labelledby="doc-h">
      <h2 id="doc-h">Dokument og status</h2>
      ${factList([
        ['Status', statusBadge(poa.status)],
        ['Godkendt', `${formatDateTime(poa.approved_at)} af ${poa.approver_name}, ${poa.approver_title}`],
        ...(snap?.requires_veyro_acceptance ? ([['Veyros accept', poa.veyro_accepted_at ? formatDateTime(poa.veyro_accepted_at) : 'Afventer']] as [string, string][]) : []),
        ...(poa.activated_at ? ([['Aktiv fra', formatDateTime(poa.activated_at)]] as [string, string][]) : []),
        ['Udløbsdato', poa.expires_on ? formatDay(poa.expires_on) : 'Ingen'],
        ...(poa.revoked_at ? ([['Tilbagekaldt', formatDateTime(poa.revoked_at)]] as [string, string][]) : []),
        ...(poa.expired_at ? ([['Udløbet', formatDateTime(poa.expired_at)]] as [string, string][]) : []),
        ['Godkendelsesmetode', poa.approval_method ?? ''],
      ])}
      <div class="row">
        <a class="btn btn-primary" href="${BASE}/${poa.id}/pdf">Download PDF</a>
        <a class="btn btn-secondary" href="${BASE}/${poa.id}/pdf?original=1">Kun det oprindelige dokument</a>
      </div>
      <p class="hint">Downloadet PDF har en forside med den aktuelle status. Det oprindelige, godkendte dokument følger uændret.</p>
      ${receipt.length
        ? html`<ul class="small poa-mails">${receipt.map((m) => html`<li>${MAIL_LABEL[m.kind]} til ${m.recipient}: <strong>${MAIL_STATUS[m.status]!.label}</strong>${m.sent_at ? ` (${formatDateTime(m.sent_at)})` : ''}</li>`)}</ul>`
        : ''}
    </section>`}
  ${poa.status === 'revoked' || poa.status === 'expired'
    ? html`<section class="card stack" aria-labelledby="ext-h">
      <h2 id="ext-h">Underretning af andre</h2>
      <p>Fuldmagten gælder ikke længere i Veyros system. ${third.length
        ? 'Veyro har brugt fuldmagten over for nedenstående og sørger for at orientere dem:'
        : 'Veyro har ikke registreret, at fuldmagten er brugt over for leverandører eller andre.'}</p>
      ${third.length
        ? html`<ul class="list">${third.map(
            (t) => html`<li><div class="item-head"><h3>${t.party}</h3><span class="badge ${t.status === 'done' ? 'b-ok' : 'b-warn'}">${t.status === 'done' ? `Orienteret ${formatDateTime(t.done_at)}` : 'Veyro orienterer'}</span></div></li>`,
          )}</ul>`
        : ''}
      <p class="small">Har I selv sendt fuldmagten til andre (fx en leverandør), skal I selv orientere dem om, at den ikke længere gælder.</p>
    </section>`
    : ''}
  ${snap ? poaDocument(snap) : ''}
  ${poa.status !== 'draft'
    ? html`<section class="card stack" aria-labelledby="act-h">
      <h2 id="act-h">Tilbagekald, ændr eller slet</h2>
      <div class="poa-choice">
        <h3>Tilbagekald fuldmagt</h3>
        <p class="small">Stopper fuldmagten med det samme. Dokumentet bevares som historik.</p>
        ${live ? html`<a class="btn btn-danger" href="${BASE}/${poa.id}/tilbagekald">Tilbagekald fuldmagt</a>` : html`<p class="small muted">Fuldmagten er ${STATUS_LABEL[poa.status].toLowerCase()} og kan ikke genaktiveres. Opret en ny, hvis Veyro igen skal have fuldmagt.</p>`}
      </div>
      <div class="poa-choice">
        <h3>Ændr fuldmagten</h3>
        <p class="small">En godkendt fuldmagt kan ikke redigeres. Ændringer kræver en ny version og en ny godkendelse.</p>
        <form method="post" action="${BASE}/${poa.id}/ny-version">${csrfField(args.csrf)}<input type="hidden" name="_idem" value="nv-${poa.id}-${poa.updated_at}"><button class="btn btn-secondary" type="submit">Opret ny version</button></form>
      </div>
      <div class="poa-choice">
        <h3>Anmod om sletning</h3>
        <p class="small">Fjerner oplysningerne fra Veyros system efter <a href="/fuldmagter/opbevaring">opbevaringspolitikken</a>.${live ? ' Fuldmagten tilbagekaldes først som en del af forløbet.' : ''}</p>
        ${poa.deletion_status === 'none' ? html`<a class="btn btn-secondary" href="${BASE}/${poa.id}/slet">Anmod om sletning</a>` : html`<p class="small muted">${poa.deletion_status === 'requested' ? 'Sletning er anmodet og afventer behandling.' : `Delvist slettet. Resten opbevares til ${formatDayFromSec(poa.retain_until)} og slettes derefter automatisk.`}</p>`}
      </div>
    </section>`
    : ''}
  ${args.requests.length
    ? html`<section class="card"><h2>Sletteanmodning</h2>${args.requests.map(
        (r) => html`<p><span class="badge ${r.status === 'completed' ? 'b-ok' : r.status === 'retained' ? 'b-neutral' : 'b-warn'}">${DELETION_LABEL[r.status]}</span></p><p class="meta">Anmodet ${formatDateTime(r.requested_at)}${r.handled_at ? ` · Behandlet ${formatDateTime(r.handled_at)}` : ''}</p>${r.result_text ? html`<p class="small">${r.result_text}</p>` : ''}`,
      )}</section>`
    : ''}
  ${args.events.length ? html`<section class="card"><h2>Forløb</h2>${eventList(args.events, false)}</section>` : ''}
</div>`;
}

function eventList(events: EventRow[], admin: boolean): H {
  return html`<ol class="list poa-events">${events.map(
    (ev) => html`<li><div class="item-head"><span><strong>${EVENT_LABEL[ev.type] ?? ev.type}</strong>${ev.detail && (admin || !ev.type.startsWith('action')) ? html` <span class="muted small">· ${ev.detail}</span>` : ''}</span><span class="meta">${formatDateTime(ev.at)}${admin ? ` · ${ev.actor}` : ev.actor === 'kunde' ? ' · dig' : ev.actor === 'system' ? ' · system' : ' · Veyro'}</span></div></li>`,
  )}</ol>`;
}

export function poaRevokePage(args: { csrf: string; poa: PoaRow }): H {
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow"><a href="${BASE}/${args.poa.id}">Fuldmagt ${label(args.poa)}</a></p><h1>Tilbagekald fuldmagt</h1></div>
  ${alert('warn', REVOKE_TEXT)}
  <form method="post" action="${BASE}/${args.poa.id}/tilbagekald" class="row">
    ${csrfField(args.csrf)}
    <button class="btn btn-danger" type="submit" data-loading="Tilbagekalder …">Bekræft tilbagekaldelse</button>
    <a class="btn btn-secondary" href="${BASE}/${args.poa.id}">Fortryd</a>
  </form>
  <p class="small muted">Tilbagekaldelsen gælder med det samme i Veyros system og afhænger ikke af, at en medarbejder godkender den eller at en mail bliver leveret. Du får en kvittering på mail.</p>
</div>`;
}

export function poaDeletePage(args: { csrf: string; poa: PoaRow; error?: string | null; hasActions: boolean }): H {
  const { poa } = args;
  if (poa.status === 'draft') {
    return html`<div class="narrow stack-lg">
    <div><p class="eyebrow"><a href="${BASE}/${poa.id}">Fuldmagt ${label(poa)}</a></p><h1>Slet kladde</h1></div>
    <p>Kladden er aldrig godkendt. Når du sletter den, fjernes den og alle dens oplysninger helt fra Veyros system med det samme.</p>
    <form method="post" action="${BASE}/${poa.id}/slet" class="row">
      ${csrfField(args.csrf)}
      <button class="btn btn-danger" type="submit" data-loading="Sletter …">Slet kladden</button>
      <a class="btn btn-secondary" href="${BASE}/${poa.id}">Fortryd</a>
    </form>
  </div>`;
  }
  const live = poa.status === 'active' || poa.status === 'pending';
  return html`<div class="medium stack-lg">
  <div><p class="eyebrow"><a href="${BASE}/${poa.id}">Fuldmagt ${label(poa)}</a></p><h1>Anmod om sletning</h1>
    <p class="lead">Sletning fjerner oplysningerne om fuldmagten fra Veyros system. Det er ikke det samme som at tilbagekalde den.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <section class="card stack">
    <h2>Det sker, når du anmoder om sletning</h2>
    <ul class="poa-terms">
      ${live ? html`<li><strong>Trin 1: Fuldmagten tilbagekaldes først.</strong> Den er ${STATUS_LABEL[poa.status].toLowerCase()} nu. ${REVOKE_TEXT.replace('Du er ved at tilbagekalde fuldmagten. ', '')}</li>` : ''}
      <li>${live ? html`<strong>Trin 2:</strong> ` : ''}Veyro behandler anmodningen, og du kan følge status på siden Fuldmagter.</li>
      <li>${args.hasActions
        ? html`Veyro har udført handlinger under fuldmagten. Derfor opbevares PDF'en, godkendelsen og listen over handlingerne i 3 år efter ophøret for at kunne dokumentere, at handlingerne var aftalt. Alt andet slettes, når anmodningen behandles.`
        : html`Veyro har ikke registreret handlinger under fuldmagten, så alt slettes, når anmodningen behandles.`}</li>
      <li>Sletning i Veyros system fjerner ikke PDF'er, du allerede har downloadet eller fået på mail.</li>
      <li>Du får en kvittering for resultatet.</li>
    </ul>
    <form method="post" action="${BASE}/${poa.id}/slet" class="stack">
      ${csrfField(args.csrf)}
      ${live
        ? html`<label class="check confirm-check"><input type="checkbox" name="revoke_first" value="1"><span>Tilbagekald fuldmagten nu, så den kan slettes</span></label>`
        : ''}
      <div class="row">
        <button class="btn btn-danger" type="submit" data-loading="Sender …">${live ? 'Tilbagekald og anmod om sletning' : 'Anmod om sletning'}</button>
        <a class="btn btn-secondary" href="${BASE}/${poa.id}">Fortryd</a>
      </div>
    </form>
  </section>
  <p class="small"><a href="/fuldmagter/opbevaring">Læs hele opbevarings- og slettepolitikken</a></p>
</div>`;
}

export function poaPolicyPage(): H {
  return html`<div class="medium stack-lg">
  <div><p class="eyebrow"><a href="${BASE}">Fuldmagter</a></p><h1>Opbevaring og sletning af fuldmagter</h1>
    <p class="lead">${POLICY_STATUS}.</p></div>
  ${POLICY.map((sec) => html`<section class="card"><h2>${sec.title}</h2><ul class="poa-terms">${sec.items.map((i) => html`<li>${i}</li>`)}</ul></section>`)}
</div>`;
}

// ---------------- Admin ----------------

const ADMIN = '/admin/fuldmagter';

export interface AdminPoaRow extends PoaRow {
  email: string;
}

export function adminPoaListPage(args: {
  rows: AdminPoaRow[];
  q: string;
  status: string;
  requests: (DeletionRequestRow & { email?: string })[];
  openTasks: (TaskRow & { number: string; version: number })[];
  settings: PoaSettings;
  missing: string[];
  flashKey?: string;
}): H {
  const openReq = args.requests.filter((r) => r.status === 'received');
  return html`<div class="stack-lg">
  <div class="row between" style="align-items:flex-end">
    <div><h1>Fuldmagter</h1><p class="lead" style="margin-bottom:0">Kundernes fuldmagter til Veyro. Godkendte fuldmagter kan ikke ændres, og beføjelser kan ikke udvides her.</p></div>
    <a class="btn btn-secondary" href="${ADMIN}/indstillinger">Veyros oplysninger og indstillinger</a>
  </div>
  ${args.flashKey === 'gemt' ? alert('ok', 'Indstillingerne er gemt.') : ''}
  ${args.missing.length ? alert('err', html`Kunder kan ikke godkende fuldmagter, før Veyros oplysninger er udfyldt. Mangler: ${args.missing.join(', ')}. <a href="${ADMIN}/indstillinger">Udfyld nu</a>`) : ''}
  ${!args.settings.text_approved ? alert('warn', html`Fuldmagtsteksten, godkendelsesmetoden og opbevaringspolitikken er markeret som <strong>udkast</strong>. Siden er kun åben for pilotkunder, indtil de er godkendt i <a href="${ADMIN}/indstillinger">indstillingerne</a>.`) : ''}
  ${openReq.length || args.openTasks.length
    ? html`<div class="grid grid-2" style="align-items:start">
      <section class="card"><h2>Sletteanmodninger (${openReq.length})</h2>
        ${openReq.length ? html`<ul class="list">${openReq.map((r) => html`<li><div class="item-head"><a href="${r.poa_id ? `${ADMIN}/${r.poa_id}#sletning` : '#'}"><strong>${r.poa_label}</strong></a><span class="meta">${formatDateTime(r.requested_at)}</span></div><div class="meta">${r.email ?? ''}</div></li>`)}</ul>` : html`<p class="empty">Ingen</p>`}
      </section>
      <section class="card"><h2>Opfølgning efter ophør (${args.openTasks.length})</h2>
        ${args.openTasks.length ? html`<ul class="list">${args.openTasks.map((t) => html`<li><a href="${ADMIN}/${t.poa_id}#opfoelgning"><strong>${t.number}${t.version > 1 ? ` v${t.version}` : ''}</strong></a> <span class="meta">· ${t.kind === 'third_party' ? `Orientér ${t.party}` : 'Adgange og igangværende opgaver'}</span></li>`)}</ul>` : html`<p class="empty">Ingen</p>`}
      </section></div>`
    : ''}
  <form method="get" action="${ADMIN}" class="row stats-filter">
    <input type="text" name="q" value="${args.q}" placeholder="Søg nummer, virksomhed, CVR, e-mail eller projekt" aria-label="Søg" style="flex:1;min-width:220px">
    <select name="status" aria-label="Status"><option value="">Alle statusser</option>${(Object.keys(STATUS_LABEL) as PoaRow['status'][]).map(
      (s) => html`<option value="${s}" ${args.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`,
    )}</select>
    <button class="btn btn-secondary" type="submit">Søg</button>
  </form>
  <section class="card">
    ${args.rows.length === 0
      ? html`<p class="empty">Ingen fuldmagter fundet.</p>`
      : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th>Nummer</th><th>Virksomhed / projekt</th><th>Kunde</th><th>Udløber</th><th>Status</th></tr></thead>
      <tbody>${args.rows.map(
        (p) => html`<tr>
          <td data-label="Nummer"><a href="${ADMIN}/${p.id}"><strong>${label(p)}</strong></a></td>
          <td data-label="Virksomhed"><div>${p.company_name ?? '–'}<br><span class="muted small">${p.project ?? ''}</span></div></td>
          <td data-label="Kunde">${p.email}</td>
          <td data-label="Udløber">${p.expires_on ? formatDay(p.expires_on) : 'Ingen'}</td>
          <td data-label="Status"><div class="stack-xs">${statusBadge(p.status)}${deletionBadge(p)}</div></td>
        </tr>`,
      )}</tbody></table></div>`}
  </section>
</div>`;
}

export function adminPoaDetailPage(args: {
  csrf: string;
  poa: AdminPoaRow;
  snap: Snapshot | null;
  events: EventRow[];
  mails: MailRow[];
  actions: ActionRow[];
  tasks: TaskRow[];
  requests: DeletionRequestRow[];
  hasActions: boolean;
  error?: string | null;
  ok?: string | null;
  actionValues?: Record<string, string>;
}): H {
  const { poa, snap } = args;
  const id = poa.id;
  const v = args.actionValues ?? {};
  const granted = snap?.powers.filter((p) => p.granted) ?? [];
  const monthUse = new Map<string, number>();
  for (const a of args.actions) if (a.power === 'orders' && a.status !== 'cancelled') monthUse.set(a.month_key, (monthUse.get(a.month_key) ?? 0) + (a.amount_oere ?? 0));
  const openReq = args.requests.find((r) => r.status === 'received');
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="${ADMIN}">Fuldmagter</a></p>
    <div class="plan-title"><h1 style="margin:0">Fuldmagt ${label(poa)}</h1>${statusBadge(poa.status)}${deletionBadge(poa)}</div>
    <p class="lead" style="margin-top:8px">${poa.company_name ?? ''} · ${poa.email}</p></div>
  ${args.error ? alert('err', args.error) : ''}
  ${args.ok ? alert('ok', args.ok) : ''}
  <div class="grid grid-2" style="align-items:start">
    <section class="card stack"><h2>Status og godkendelser</h2>
      ${factList([
        ['Status', statusBadge(poa.status)],
        ['Oprettet', formatDateTime(poa.created_at)],
        ['Godkendt af kunden', poa.approved_at ? `${formatDateTime(poa.approved_at)} · ${poa.approver_name}, ${poa.approver_title} (${poa.approver_email})` : 'Nej'],
        ['Metode', poa.approval_method ?? '–'],
        ['Tekstversion', poa.text_version ?? '–'],
        ['Indholdets SHA-256', html`<span class="devlink">${poa.content_hash ?? '–'}</span>`],
        ['Veyros accept', snap?.requires_veyro_acceptance ? (poa.veyro_accepted_at ? `${formatDateTime(poa.veyro_accepted_at)} · ${poa.veyro_accepted_by}` : 'Afventer') : 'Kræves ikke'],
        ['Aktiv fra', formatDateTime(poa.activated_at)],
        ['Udløbsdato', poa.expires_on ? formatDay(poa.expires_on) : 'Ingen'],
        ['Tilbagekaldt', formatDateTime(poa.revoked_at)],
        ['Udløbet', formatDateTime(poa.expired_at)],
        ['Sletning', poa.deletion_status === 'none' ? 'Ingen' : poa.deletion_status === 'requested' ? 'Anmodet' : `Opbevares til ${formatDayFromSec(poa.retain_until)}`],
      ])}
      <div class="row">
        ${poa.status !== 'draft' ? html`<a class="btn btn-secondary" href="${ADMIN}/${id}/pdf">Download PDF</a><a class="btn btn-secondary" href="${ADMIN}/${id}/pdf?original=1">Oprindeligt dokument</a>` : ''}
        ${poa.status === 'pending' && poa.deletion_status === 'none'
          ? html`<form method="post" action="${ADMIN}/${id}/accepter" data-confirm="Acceptér fuldmagten på Veyros vegne? Den bliver aktiv med det samme.">${csrfField(args.csrf)}<button class="btn btn-accent" type="submit">Acceptér på Veyros vegne</button></form>`
          : ''}
      </div>
    </section>
    <section class="card stack"><h2>Beføjelser og grænser</h2>
      ${snap
        ? html`<ul class="list">${snap.powers.map((p) => html`<li><div class="item-head"><span>${p.label}</span><span class="badge ${p.granted ? 'b-ok' : 'b-neutral'}">${p.granted ? 'Givet' : 'Ikke givet'}</span></div>${p.key === 'other' && snap.other_text ? html`<p class="small prewrap">${snap.other_text}</p>` : ''}</li>`)}</ul>
          ${snap.orders
            ? factList([
                ['Pr. bestilling', `${formatKr(snap.orders.max_per_order_oere)} inkl. moms`],
                ['Pr. kalendermåned', `${formatKr(snap.orders.max_per_month_oere)} inkl. moms`],
                ['Brugt (registreret + planlagt)', html`${[...monthUse].map(([m, s]) => html`${m}: ${formatKr(s)}<br>`)}${monthUse.size ? '' : '0 kr.'}`],
                ['Leverandører', multi(snap.orders.suppliers)],
                ['Typer', multi(snap.orders.types)],
                ['Periode', `${formatDay(snap.orders.start)} – ${formatDay(snap.orders.end)}`],
              ])
            : ''}`
        : html`<p class="muted">Kladde – ikke godkendt.</p>`}
    </section>
  </div>

  ${poa.status !== 'draft'
    ? html`<section class="card stack" id="handlinger"><h2>Handlinger under fuldmagten</h2>
    <p class="hint" style="margin-top:0">Registrér det, Veyro gør under fuldmagten. Systemet kontrollerer status, udløb, beføjelse, leverandør og beløbsgrænser, før handlingen gemmes. En planlagt handling stoppes automatisk, hvis fuldmagten tilbagekaldes eller udløber.</p>
    ${poa.status === 'active' && poa.deletion_status === 'none'
      ? html`<form method="post" action="${ADMIN}/${id}/handlinger" class="stack" novalidate>
        ${csrfField(args.csrf)}
        <div class="grid grid-2 form-grid">
          <div class="field"><label for="a-power">Beføjelse</label><select id="a-power" name="power"><option value="">Vælg</option>${granted.map((p) => html`<option value="${p.key}" ${v.power === p.key ? 'selected' : ''}>${p.label}</option>`)}</select></div>
          <div class="field"><label for="a-party">Leverandør, system eller konto</label><input id="a-party" name="party" type="text" maxlength="200" value="${v.party ?? ''}"></div>
          <div class="field"><label for="a-amount">Beløb inkl. moms (kun bestillinger)</label><input id="a-amount" name="amount" type="text" maxlength="20" value="${v.amount ?? ''}"></div>
          <div class="field"><label for="a-date">Planlagt til <span class="muted small">(tom = udført nu)</span></label><input id="a-date" name="planned_for" type="date" value="${v.planned_for ?? ''}"></div>
        </div>
        <div class="field"><label for="a-desc">Beskrivelse</label><textarea id="a-desc" name="description" maxlength="1000" style="min-height:80px">${v.description ?? ''}</textarea></div>
        <div class="row"><button class="btn btn-primary" type="submit">Kontrollér og registrér</button></div>
      </form>`
      : alert('info', 'Fuldmagten er ikke aktiv. Nye handlinger er blokeret.')}
    ${args.actions.length
      ? html`<div class="table-wrap"><table class="responsive"><thead><tr><th>Dato</th><th>Beføjelse</th><th>Part</th><th>Beskrivelse</th><th class="num">Beløb</th><th>Status</th></tr></thead><tbody>${args.actions.map(
          (a) => html`<tr>
            <td data-label="Dato">${a.planned_for ? formatDay(a.planned_for) : formatDateTime(a.created_at)}</td>
            <td data-label="Beføjelse">${POWERS[a.power]?.label ?? a.power}</td>
            <td data-label="Part">${a.party}</td>
            <td data-label="Beskrivelse"><span class="prewrap small">${a.description}</span><br><span class="muted small">${a.created_by}</span></td>
            <td data-label="Beløb" class="num">${a.amount_oere ? formatKr(a.amount_oere) : ''}</td>
            <td data-label="Status">${a.status === 'done'
              ? html`<span class="badge b-ok">Udført</span>`
              : a.status === 'cancelled'
                ? html`<span class="badge b-neutral" title="${a.cancel_reason ?? ''}">Stoppet</span>`
                : html`<span class="badge b-warn">Planlagt</span>
                  <div class="row" style="margin-top:6px">
                    <form method="post" action="${ADMIN}/${id}/handlinger/${a.id}/udfoer">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit">Udfør</button></form>
                    <form method="post" action="${ADMIN}/${id}/handlinger/${a.id}/stop">${csrfField(args.csrf)}<button class="btn btn-danger btn-small" type="submit">Stop</button></form>
                  </div>`}</td>
          </tr>`,
        )}</tbody></table></div>`
      : html`<p class="muted small">Ingen handlinger registreret.</p>`}
  </section>`
    : ''}

  ${args.tasks.length
    ? html`<section class="card stack" id="opfoelgning"><h2>Opfølgning efter ophør</h2>
      <ul class="list">${args.tasks.map(
        (t) => html`<li><div class="item-head"><div><strong>${t.kind === 'third_party' ? `Orientér ${t.party}` : 'Adgange og igangværende opgaver'}</strong><p class="small" style="margin:4px 0 0">${t.note}</p><p class="meta">Ansvarlig: ${t.responsible === 'veyro' ? 'Veyro' : 'Kunden'}</p></div>
          ${t.status === 'done'
            ? html`<span class="badge b-ok">Udført ${formatDateTime(t.done_at)} · ${t.done_by}</span>`
            : html`<form method="post" action="${ADMIN}/${id}/opgaver/${t.id}">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit">${t.kind === 'third_party' ? 'Registrér underretning' : 'Markér som udført'}</button></form>`}</div></li>`,
      )}</ul></section>`
    : ''}

  ${args.requests.length
    ? html`<section class="card stack" id="sletning"><h2>Sletteanmodning</h2>
      ${args.requests.map((r) => html`<p><span class="badge ${r.status === 'completed' ? 'b-ok' : r.status === 'retained' ? 'b-neutral' : 'b-warn'}">${DELETION_LABEL[r.status]}</span> <span class="meta">Anmodet ${formatDateTime(r.requested_at)}</span></p>${r.result_text ? html`<p class="small">${r.result_text}</p>` : ''}`)}
      ${openReq
        ? html`<p class="small">${args.hasActions
            ? `Efter politikken opbevares PDF, godkendelse og handlingslog i 3 år efter ophøret, fordi Veyro har udført handlinger under fuldmagten. Resten slettes nu.`
            : 'Der er ingen udførte handlinger, så politikken sletter alt nu.'}</p>
          <div class="row">
            <form method="post" action="${ADMIN}/sletning/${openReq.id}" data-confirm="Behandl sletningen efter politikken?">${csrfField(args.csrf)}<input type="hidden" name="mode" value="policy"><button class="btn btn-primary" type="submit">Behandl efter politikken</button></form>
            ${args.hasActions
              ? html`<form method="post" action="${ADMIN}/sletning/${openReq.id}" data-confirm="Slet ALT nu, også dokumentation for udførte handlinger? Det kan ikke fortrydes.">${csrfField(args.csrf)}<input type="hidden" name="mode" value="full"><button class="btn btn-danger" type="submit">Slet alt nu</button></form>`
              : ''}
          </div>`
        : ''}
    </section>`
    : ''}

  <section class="card stack" id="mails"><h2>Mails</h2>
    ${args.mails.length
      ? html`<ul class="list">${args.mails.map(
          (m) => html`<li><div class="item-head"><div><strong>${MAIL_LABEL[m.kind]}</strong><div class="meta">${m.recipient} · ${m.attempts} forsøg${m.sent_at ? ` · sendt ${formatDateTime(m.sent_at)}` : ''}${m.last_error ? ` · ${m.last_error}` : ''}</div></div>
            <div class="row"><span class="badge ${badgeClass(MAIL_STATUS[m.status]!.tone)}">${MAIL_STATUS[m.status]!.label}</span>
            <form method="post" action="${ADMIN}/${id}/mails/${m.id}">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit">${m.status === 'sent' ? 'Gensend' : 'Send igen'}</button></form></div></div></li>`,
        )}</ul>`
      : html`<p class="muted small">Ingen mails.</p>`}
  </section>

  <section class="card"><h2>Hændelsesforløb</h2>${eventList(args.events, true)}</section>
  ${snap ? html`<details class="card"><summary><strong>Hele fuldmagten</strong></summary>${poaDocument(snap)}</details>` : ''}
</div>`;
}

export function adminPoaSettingsPage(args: { csrf: string; settings: PoaSettings; error?: string | null }): H {
  const s = args.settings;
  return html`<div class="medium stack-lg">
  <div><p class="eyebrow"><a href="${ADMIN}">Fuldmagter</a></p><h1>Veyros oplysninger og indstillinger</h1>
    <p class="lead">Oplysningerne indsættes automatisk i alle nye fuldmagter. Allerede godkendte fuldmagter ændres ikke.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="${ADMIN}/indstillinger" class="stack-lg">
    ${csrfField(args.csrf)}
    <section class="card stack"><h2>Veyros oplysninger</h2>
      ${VEYRO_FIELDS.map(
        ([k, lbl]) => html`<div class="field"><label for="s-${k}">${lbl}</label><input id="s-${k}" name="${k}" type="${k === 'veyro_contact_email' ? 'email' : 'text'}" maxlength="200" value="${String(s[k])}"></div>`,
      )}
      <p class="hint">Felterne skal være udfyldt, før kunder kan godkende. Udfyld kun oplysninger, der er korrekte.</p>
    </section>
    <section class="card stack"><h2>Godkendelse og ibrugtagning</h2>
      <label class="check"><input type="checkbox" name="require_veyro_acceptance" value="1" ${s.require_veyro_acceptance ? 'checked' : ''}><span>Veyros accept indgår: fuldmagten bliver først aktiv, når Veyro har accepteret den</span></label>
      <label class="check"><input type="checkbox" name="text_approved" value="1" ${s.text_approved ? 'checked' : ''}><span>Fuldmagtsteksten, godkendelsesmetoden og opbevaringspolitikken er gennemgået og godkendt til Veyros brug (fjerner "Udkast")</span></label>
      <label class="check"><input type="checkbox" name="launched" value="1" ${s.launched ? 'checked' : ''}><span>Åbn siden Fuldmagter for alle kunder (kræver godkendt tekst)</span></label>
      <div class="field"><label for="s-pilot">Pilotkunder (e-mails)</label><textarea id="s-pilot" name="pilot_emails" maxlength="2000" style="min-height:80px">${s.pilot_emails.join('\n')}</textarea>
        <p class="hint">Kunder, der kan bruge fuldmagter, før siden er åbnet for alle. Én pr. linje.</p></div>
    </section>
    <section class="card stack"><h2>Fuldmagtens tekst</h2>
      <p class="small">Teksten ligger i koden (src/lib/poa.ts) med versionsmærket, så hver godkendelse kan føres tilbage til den præcise tekst. Begrænsninger:</p>
      <ul class="poa-terms small">${TERMS.map((t) => html`<li>${t}</li>`)}</ul>
      <p class="small"><a href="/fuldmagter/opbevaring">Opbevarings- og slettepolitik</a> (${RETENTION.withActionsDays / 365} år med handlinger, ${RETENTION.withoutActionsDays} dage uden)</p>
    </section>
    <div class="row sticky-save"><button class="btn btn-primary" type="submit">Gem</button></div>
  </form>
</div>`;
}

export { lines };
