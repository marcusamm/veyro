// Visninger for fortrolighedsaftaler (NDA): kundens sider under "Aftaler og dokumenter" og Veyros administration.
import { html } from 'hono/html';
import type { CustomerRow } from '../env';
import { formatDateTime } from '../lib/format';
import {
  CHOICE_LABEL,
  CONFIRMATIONS,
  CONTINUING_TEXT,
  COOPERATION_LABEL,
  DELETE_DOC_TEXT,
  EVENT_LABEL,
  FIELD_LABEL,
  REQUEST_EVENT_LABEL,
  REQUEST_KIND_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  TERMINATE_TEXT,
  formatDay,
  label,
  parseTemplate,
  type ConfidentialityEnd,
  type EventRow,
  type NdaForm,
  type NdaListRow,
  type NdaRow,
  type NdaStatus,
  type RequestRow,
  type Snapshot,
  type TaskRow,
  type TemplateRow,
  type VeyroInfo,
  type VersionRow,
} from '../lib/nda';
import { MAIL_LABEL, MAIL_STATUS, type MailRow } from '../lib/nda-docs';
import { alert, csrfField, type H } from './layout';
import { badgeClass } from './status';

const BASE = '/konto/nda';
const ADMIN = '/admin/nda';

export const NDA_FLASH: Record<string, { kind: 'ok' | 'info' | 'warn' | 'err'; text: string }> = {
  gemt: { kind: 'ok', text: 'Oplysningerne er gemt som kladde. Du kan fortsætte senere.' },
  sendt: { kind: 'ok', text: 'Aftalen er låst og klar til godkendelse. Læs den igennem, og godkend den nederst på siden.' },
  aabnet: { kind: 'info', text: 'Aftalen er åbnet for rettelser. Når du sender den igen, skal den godkendes på ny.' },
  'ny-version': { kind: 'info', text: 'Der er oprettet en ny version. Begge parter skal godkende den nye version, før aftalen træder i kraft.' },
  godkendt: { kind: 'ok', text: 'Tak. Din godkendelse er registreret, og du får en kvittering på mail.' },
  aktiv: { kind: 'ok', text: 'Aftalen er godkendt af begge parter og er trådt i kraft. Den endelige PDF er sendt til begge parter.' },
  ophoert: { kind: 'ok', text: 'Aftalen er afsluttet for fremtidig udveksling. Fortroligheden for allerede delte oplysninger fortsætter.' },
  'kladde-slettet': { kind: 'ok', text: 'Kladden er slettet.' },
  'anmodning-oprettet': { kind: 'ok', text: 'Din anmodning er modtaget. Du kan følge status her.' },
  'ikke-muligt': { kind: 'info', text: 'Handlingen er ikke mulig i aftalens nuværende status.' },
  'mail-sendt': { kind: 'ok', text: 'Mailen er sendt igen.' },
  'mail-fejl': { kind: 'err', text: 'Mailen kunne stadig ikke sendes. Se fejlen nedenfor.' },
  oprettet: { kind: 'ok', text: 'Kladden er oprettet. Kunden kan nu udfylde og kontrollere oplysningerne.' },
  opdateret: { kind: 'ok', text: 'Gemt.' },
  skabelon: { kind: 'ok', text: 'Den nye skabelonversion er gemt. Den bruges kun til aftaler, der oprettes fra nu af.' },
};

function flash(key: string | undefined): H | '' {
  const f = key ? NDA_FLASH[key] : undefined;
  return f ? alert(f.kind, f.text) : '';
}

export function ndaStatusBadge(status: NdaStatus): H {
  return html`<span class="badge ${badgeClass(STATUS_TONE[status])}">${STATUS_LABEL[status]}</span>`;
}

function requestBadge(r: Pick<RequestRow, 'status'>): H {
  return html`<span class="badge ${badgeClass(REQUEST_STATUS_TONE[r.status])}">${REQUEST_STATUS_LABEL[r.status]}</span>`;
}

function deletionBadge(n: Pick<NdaRow, 'deletion_status' | 'retain_until'>): H | '' {
  if (n.deletion_status === 'requested') return html`<span class="badge b-warn">Sletning anmodet</span>`;
  if (n.deletion_status === 'retained') return html`<span class="badge b-neutral">Opbevares til ${dayFromSec(n.retain_until)}</span>`;
  return '';
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, '')} …` : s;
}

function dayFromSec(sec: number | null): string {
  return sec ? new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Copenhagen' }).format(new Date(sec * 1000)) : '–';
}

function mailBadge(m: Pick<MailRow, 'status'>): H {
  const s = MAIL_STATUS[m.status] ?? { label: m.status, tone: 'neutral' as const };
  return html`<span class="badge ${badgeClass(s.tone)}">${s.label}</span>`;
}

export function testBanner(testLabel: string | null | undefined): H | '' {
  return testLabel ? alert('warn', html`<strong>${testLabel}:</strong> Dette er et testmiljø med testdata. Fortrolighedsaftaler godkendt her er ikke gyldige.`) : '';
}

function factList(rows: [string, H | string][]): H {
  return html`<dl class="facts poa-facts">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

function missingText(v: string): H | string {
  return v || html`<span class="muted" style="font-weight:500">Mangler – udfyldes af Veyro</span>`;
}

function approvalTime(sec: number | null | undefined): H | string {
  return sec ? formatDateTime(sec) : html`<span class="muted">Ikke godkendt</span>`;
}

// ---------------- Fælles: aftaleteksten ----------------

/** Opsummering og vilkår, kunden særligt skal være opmærksom på. Erstatter ikke den fulde aftale. */
export function ndaSummary(s: Snapshot): H {
  return html`<section class="card stack" aria-labelledby="sum-h">
    <h2 id="sum-h">Kort fortalt</h2>
    <p>${s.summary}</p>
    <ul class="poa-terms">${s.notices.map((n) => html`<li><strong>${n.title}:</strong> ${n.text}</li>`)}</ul>
    <p class="small muted" style="margin:0">Opsummeringen erstatter ikke den fulde aftale nedenfor. Det er den fulde aftale, du godkender.</p>
  </section>`;
}

/** Hele aftalen med parternes oplysninger – samme indhold som PDF'en. */
export function ndaDocument(s: Snapshot, v: VersionRow | null): H {
  const blocks = parseTemplate(s.body);
  const headings = blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text);
  return html`<article class="card stack nda-doc" aria-labelledby="doc-h">
    ${s.test ? alert('warn', html`<strong>${s.test}:</strong> Testdokument – ikke gyldigt.`) : ''}
    <header>
      <p class="eyebrow">${s.number} · version ${s.version} · skabelon ${s.template_version}</p>
      <h2 id="doc-h" style="margin-bottom:4px">${s.title}</h2>
      <p class="muted" style="margin:0">${s.subtitle}</p>
    </header>
    <nav aria-label="Aftalens afsnit" class="small"><ol class="nda-toc">${headings.map((h) => html`<li>${h}</li>`)}</ol></nav>
    <h3>Aftalens parter</h3>
    <div class="grid grid-2" style="align-items:start">
      <div><p class="label-like">Veyro</p>${factList([
        ['Juridisk navn', missingText(s.veyro.legal_name)],
        ['CVR-nr.', missingText(s.veyro.cvr)],
        ['Adresse', missingText(s.veyro.address)],
        ['Kontaktperson', s.veyro.contact_name || html`<span class="muted">–</span>`],
        ['E-mail', s.veyro.contact_email],
      ])}</div>
      <div><p class="label-like">Kunden eller samarbejdspartneren</p>${factList([
        ['Juridisk navn', s.customer.company_name],
        ['CVR-nr.', s.customer.cvr],
        ['Adresse', `${s.customer.address}, ${s.customer.postal_code} ${s.customer.city}`],
        ['Kontaktperson', s.customer.contact_name],
        ['E-mail', s.customer.contact_email],
      ])}</div>
    </div>
    ${blocks.map((b) =>
      b.kind === 'heading'
        ? html`<h3>${b.text}</h3>`
        : b.kind === 'para'
          ? html`<p>${b.text}</p>`
          : b.kind === 'bullets'
            ? html`<ul class="poa-terms">${b.items.map((i) => html`<li>${i}</li>`)}</ul>`
            : html`<div class="nda-project"><p class="label-like">Konkret projekt, hjemmeside eller system</p><p class="prewrap" style="margin:0">${s.project}</p></div>`,
    )}
    <div class="grid grid-2" style="align-items:start">
      <div><p class="label-like">For Veyro</p>${factList([
        ['Navn og titel', v?.veyro_approved_at ? `${v.veyro_name}, ${v.veyro_title}` : html`<span class="muted">Ikke godkendt endnu</span>`],
        ['Godkendt', approvalTime(v?.veyro_approved_at)],
      ])}</div>
      <div><p class="label-like">For kunden eller samarbejdspartneren</p>${factList([
        ['Navn og titel', v?.customer_approved_at ? `${v.customer_name}, ${v.customer_title}` : `${s.customer_approver.name}, ${s.customer_approver.title} (ikke godkendt endnu)`],
        ['Godkendt', approvalTime(v?.customer_approved_at)],
      ])}</div>
    </div>
    ${s.footnote ? html`<p class="small muted" style="margin:0">${s.footnote}</p>` : ''}
  </article>`;
}

// ---------------- Kunde: liste (også brugt på "Aftaler og dokumenter") ----------------

function approvalsCell(n: NdaListRow): H {
  return html`<span class="small">Kunden: ${n.customer_approved_at ? formatDateTime(n.customer_approved_at) : html`<span class="muted">mangler</span>`}<br>
    Veyro: ${n.veyro_approved_at ? formatDateTime(n.veyro_approved_at) : html`<span class="muted">mangler</span>`}</span>`;
}

export function ndaTable(rows: NdaListRow[], base = BASE): H {
  return html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th>Aftale</th><th>Virksomhed og projekt</th><th>Oprettet</th><th>Status</th><th>Godkendelser</th><th><span class="visually-hidden">Handlinger</span></th></tr></thead>
    <tbody>${rows.map(
      (n) => html`<tr>
        <td data-label="Aftale"><a href="${base}/${n.id}"><strong>${n.number}</strong></a><br><span class="muted small">Version ${n.current_version}</span></td>
        <td data-label="Virksomhed og projekt">${n.company_name || html`<span class="muted">Ikke udfyldt</span>`}<br><span class="muted small">${shorten(n.project ?? '', 60)}</span></td>
        <td data-label="Oprettet">${dayFromSec(n.created_at)}</td>
        <td data-label="Status"><div class="stack-xs">${ndaStatusBadge(n.status)}${deletionBadge(n)}</div></td>
        <td data-label="Godkendelser">${approvalsCell(n)}</td>
        <td data-label="Handlinger"><div class="row poa-actions">
          <a class="btn btn-secondary btn-small" href="${base}/${n.id}">Åbn</a>
          ${n.status === 'active' || n.status === 'terminated'
            ? html`<a class="btn btn-secondary btn-small" href="${base}/${n.id}/aftale.pdf">Download</a>`
            : html`<a class="btn btn-secondary btn-small" href="${base}/${n.id}/udkast.pdf">Download udkast</a>`}
        </div></td>
      </tr>`,
    )}</tbody></table></div>`;
}

export function requestList(rows: RequestRow[], base: string): H {
  return html`<ul class="list" style="margin-top:12px">${rows.map(
    (r) => html`<li>
      <div class="item-head"><h3><a href="${base}/anmodninger/${r.id}">${REQUEST_KIND_LABEL[r.kind]}</a></h3>${requestBadge(r)}</div>
      <div class="meta">Aftale ${r.nda_label}${r.choice ? ` · ${CHOICE_LABEL[r.choice]}` : ''} · Anmodet ${formatDateTime(r.created_at)}${r.handled_at ? html` · Behandlet ${formatDateTime(r.handled_at)}` : ''}${r.email ? ` · ${r.email}` : ''}</div>
    </li>`,
  )}</ul>`;
}

export function ndaListPage(args: { rows: NdaListRow[]; requests: RequestRow[]; flashKey?: string; testLabel?: string | null }): H {
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/konto/aftaler">Aftaler og dokumenter</a></p><h1>Fortrolighedsaftaler</h1>
    <p class="lead">Gensidige fortrolighedsaftaler (NDA) mellem din virksomhed og Veyro. Veyro opretter aftalen; du udfylder, kontrollerer og godkender den.</p></div>
  ${testBanner(args.testLabel)}
  ${flash(args.flashKey)}
  <section class="card" aria-labelledby="nda-h">
    <h2 id="nda-h" class="visually-hidden">Dine fortrolighedsaftaler</h2>
    ${args.rows.length ? ndaTable(args.rows) : html`<p class="empty">Du har ingen fortrolighedsaftaler endnu. Kontakt <a href="mailto:kontakt@veyro.dk">kontakt@veyro.dk</a>, hvis I ønsker en.</p>`}
  </section>
  <section class="card" aria-labelledby="req-h">
    <h2 id="req-h">Anmodninger om sletning og tilbagelevering</h2>
    <p class="small muted">Vises særskilt fra aftalernes status. En anmodning ændrer ikke aftalens forpligtelser.</p>
    ${args.requests.length ? requestList(args.requests, BASE) : html`<p class="empty">Ingen anmodninger.</p>`}
  </section>
</div>`;
}

// ---------------- Kunde og admin: formular ----------------

function err(e: Record<string, string>, k: string): H | '' {
  return e[k] ? html`<p class="hint" id="${k}-err" style="color:var(--err)">${e[k]}</p>` : '';
}
function inv(e: Record<string, string>, k: string): H | '' {
  return e[k] ? html` aria-invalid="true" aria-describedby="${k}-err"` : '';
}
function input(e: Record<string, string>, f: NdaForm, k: keyof NdaForm, opts: { type?: string; hint?: string; auto?: string; mode?: string } = {}): H {
  return html`<div class="field">
    <label for="f-${k}">${FIELD_LABEL[k]}</label>
    <input id="f-${k}" name="${k}" type="${opts.type ?? 'text'}" value="${f[k]}"${opts.auto ? html` autocomplete="${opts.auto}"` : ''}${opts.mode ? html` inputmode="${opts.mode}"` : ''}${inv(e, k)}>
    ${opts.hint ? html`<p class="hint">${opts.hint}</p>` : ''}${err(e, k)}
  </div>`;
}

export function ndaFormFields(f: NdaForm, e: Record<string, string>, veyro: VeyroInfo): H {
  return html`<section class="card stack" aria-labelledby="s1">
      <h2 id="s1">Kundens oplysninger</h2>
      <div class="grid grid-2 form-grid">
        ${input(e, f, 'company_name', { auto: 'organization', hint: 'Det fulde, registrerede navn, fx "Firma ApS".' })}
        ${input(e, f, 'cvr', { hint: '8 cifre', mode: 'numeric' })}
        ${input(e, f, 'address', { auto: 'street-address' })}
        <div class="grid grid-2 form-grid">
          ${input(e, f, 'postal_code', { auto: 'postal-code', mode: 'numeric' })}
          ${input(e, f, 'city', { auto: 'address-level2' })}
        </div>
        ${input(e, f, 'contact_name', { auto: 'name' })}
        ${input(e, f, 'contact_email', { type: 'email', auto: 'email', hint: 'Kvitteringer og meddelelser sendes hertil.' })}
        ${input(e, f, 'approver_name', { hint: 'Personen, der godkender aftalen på virksomhedens vegne.' })}
        ${input(e, f, 'approver_title', { hint: 'Fx direktør eller indehaver.' })}
      </div>
    </section>
    <section class="card stack" aria-labelledby="s2">
      <h2 id="s2">Projektet</h2>
      <div class="field">
        <label for="f-project">${FIELD_LABEL.project}</label>
        <textarea id="f-project" name="project" maxlength="2000" style="min-height:120px"${inv(e, 'project')}>${f.project}</textarea>
        <p class="hint">Beskriv det konkrete projekt, den hjemmeside eller det system, aftalen omfatter.</p>${err(e, 'project')}
      </div>
    </section>
    <section class="card stack" aria-labelledby="s3">
      <h2 id="s3">Veyros oplysninger</h2>
      <p class="hint" style="margin-top:0">Indsættes automatisk fra Veyros centrale indstillinger.</p>
      ${factList([
        ['Juridisk navn', missingText(veyro.legal_name)],
        ['CVR-nr.', missingText(veyro.cvr)],
        ['Adresse', missingText(veyro.address)],
        ['Kontaktperson', veyro.contact_name || html`<span class="muted">–</span>`],
        ['E-mail', veyro.contact_email],
      ])}
    </section>`;
}

// ---------------- Kunde: aftalens side ----------------

export interface DetailModel {
  csrf: string;
  nda: NdaRow;
  ver: VersionRow;
  versions: VersionRow[];
  snap: Snapshot;
  form: NdaForm;
  errors: Record<string, string>;
  blockers: string[];
  veyro: VeyroInfo;
  mails: MailRow[];
  requests: RequestRow[];
  events: EventRow[];
  conf: ConfidentialityEnd;
  canDelete: boolean;
  otpSentTo: string | null;
  devCode?: string | null;
  error?: string | null;
  flashKey?: string;
  testLabel?: string | null;
}

function versionHistory(versions: VersionRow[]): H | '' {
  if (versions.length < 2) return '';
  return html`<section class="card" aria-labelledby="ver-h">
    <h2 id="ver-h">Versioner</h2>
    <ul class="list" style="margin-top:12px">${versions.map(
      (v) => html`<li><div class="item-head"><h3>Version ${v.version}</h3><span class="badge ${v.state === 'approved' ? 'b-ok' : v.state === 'superseded' ? 'b-neutral' : 'b-warn'}">${
        { draft: 'Kladde', sent: 'Til godkendelse', approved: 'Godkendt af begge parter', superseded: 'Erstattet af en nyere version' }[v.state]
      }</span></div>
      <div class="meta">Kunden: ${v.customer_approved_at ? formatDateTime(v.customer_approved_at) : 'ikke godkendt'} · Veyro: ${v.veyro_approved_at ? formatDateTime(v.veyro_approved_at) : 'ikke godkendt'}</div></li>`,
    )}</ul>
    <p class="small muted">En godkendelse gælder kun den version, der blev godkendt. Ændringer kræver en ny version, som begge parter skal godkende.</p>
  </section>`;
}

function terminationSection(m: Pick<DetailModel, 'nda' | 'mails' | 'conf'>, base: string, viewer: 'kunde' | 'veyro'): H {
  const { nda } = m;
  const notices = m.mails.filter((x) => x.kind === 'termination_notice');
  const delivered = notices.length > 0 && notices.every((x) => x.status === 'sent');
  const failed = notices.some((x) => x.status === 'failed' || x.status === 'not_configured');
  const other = nda.terminated_party === 'kunde' ? 'Veyro' : 'kunden';
  return html`<section class="card stack" aria-labelledby="end-h">
    <h2 id="end-h">Ophør for fremtidig udveksling</h2>
    ${factList([
      ['Afsluttet af', nda.terminated_party === 'kunde' ? 'Kunden' : 'Veyro'],
      ['Registreret', formatDateTime(nda.terminated_at)],
      ['Registreret af', nda.terminated_by ?? ''],
      [
        `Meddelelse til ${other}`,
        notices.length
          ? html`${notices.map((x) => html`<span class="stack-xs">${mailBadge(x)}<span class="small muted">${x.recipient}${x.sent_at ? ` · ${formatDateTime(x.sent_at)}` : ''}</span></span>`)}`
          : html`<span class="muted">Ikke registreret</span>`,
      ],
    ])}
    ${failed
      ? alert('err', html`Meddelelsen til ${other} er <strong>ikke leveret</strong>. Ophøret er registreret, men ${other} er ikke underrettet via portalen endnu. ${viewer === 'kunde' ? 'Veyro har fået en opgave om at følge op.' : 'Se opgaven nedenfor.'}`)
      : delivered
        ? html`<p class="small muted" style="margin:0">"Afleveret til mailudbyderen" betyder, at meddelelsen er sendt. Det er ikke en bekræftelse af, at modtageren har læst den.</p>`
        : ''}
    <details><summary>Se meddelelsen</summary><p class="prewrap small">${nda.termination_notice ?? ''}</p></details>
    <div class="row"><a class="btn btn-secondary" href="${base}/${nda.id}/ophoer.pdf">Download kvittering for ophør</a></div>
    <h3 style="margin-top:8px">Fortsat fortrolighed</h3>
    <p>${CONTINUING_TEXT}</p>
    ${factList([
      ['Samarbejdet', COOPERATION_LABEL[nda.cooperation] + (nda.cooperation === 'ended' && nda.cooperation_ended_on ? ` (${formatDay(nda.cooperation_ended_on)})` : '')],
      ['Vejledende slutdato for den almindelige femårige fortrolighed', m.conf.date ? formatDay(m.conf.date) : html`<span class="muted">Kan ikke beregnes endnu</span>`],
    ])}
    <p class="small muted" style="margin:0">${m.conf.basis} Datoen er kun vejledende. Forretningshemmeligheder er beskyttet, så længe de har den karakter, og oplysninger i kopier, der beholdes, er fortrolige, så længe kopierne findes. Ingen oplysninger bliver automatisk frie til brug.</p>
  </section>`;
}

function approveSection(m: DetailModel): H {
  const { nda, ver } = m;
  if (ver.customer_approved_at) {
    return html`<section class="card stack" id="godkend">
      <h2>Godkendelse</h2>
      ${alert('ok', html`Du godkendte version ${ver.version} ${formatDateTime(ver.customer_approved_at)}.`)}
      ${!ver.veyro_approved_at ? html`<p><strong>Aftalen afventer Veyro.</strong> Den træder først i kraft, når Veyro har godkendt den samme version.</p>` : ''}
    </section>`;
  }
  return html`<section class="card stack" aria-labelledby="ok-h" id="godkend">
    <h2 id="ok-h">Godkend aftalen</h2>
    ${m.error ? alert('err', m.error) : ''}
    ${m.otpSentTo
      ? html`<p>Vi har sendt en engangskode til <strong>${m.otpSentTo}</strong>. Koden virker i 10 minutter.</p>
        ${m.devCode ? alert('info', html`Udviklingstilstand: koden er <strong class="devlink">${m.devCode}</strong>`) : ''}
        <form method="post" action="${BASE}/${nda.id}/godkend" class="stack" novalidate>
          ${csrfField(m.csrf)}
          <input type="hidden" name="hash" value="${ver.content_hash ?? ''}">
          ${CONFIRMATIONS.map((c, i) => html`<label class="check confirm-check"><input type="checkbox" name="confirm${i + 1}" value="1" required><span>${c}</span></label>`)}
          <div class="field">
            <label for="code">Engangskode</label>
            <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" style="max-width:200px;letter-spacing:.2em" required>
          </div>
          <p class="hint">Godkendelsen registreres med dit login, navn og titel, virksomheden, tidspunktet, metoden og den præcise version af teksten. Metoden bekræfter adgang til din e-mail. Den er ikke en MitID-underskrift og ikke dokumentation for tegningsret.</p>
          <div class="row"><button class="btn btn-accent" type="submit" data-loading="Godkender …">Godkend fortrolighedsaftalen</button></div>
        </form>
        <form method="post" action="${BASE}/${nda.id}/kode" class="inline">${csrfField(m.csrf)}<input type="hidden" name="hash" value="${ver.content_hash ?? ''}"><button class="linkbtn small" type="submit">Send en ny kode</button></form>`
      : html`<p>Du godkender på vegne af <strong>${m.snap.customer.company_name}</strong> som <strong>${m.snap.customer_approver.name}, ${m.snap.customer_approver.title}</strong>. For at godkende sender vi en engangskode til den e-mail, du er logget ind med.</p>
        <form method="post" action="${BASE}/${nda.id}/kode" class="row">
          ${csrfField(m.csrf)}
          <input type="hidden" name="hash" value="${ver.content_hash ?? ''}">
          <button class="btn btn-primary" type="submit" data-loading="Sender …">Send engangskode</button>
        </form>`}
    <form method="post" action="${BASE}/${nda.id}/ret" class="inline">${csrfField(m.csrf)}<button class="linkbtn small" type="submit">Der er fejl i oplysningerne – ret dem</button></form>
  </section>`;
}

export function ndaDetailPage(m: DetailModel): H {
  const { nda, ver, snap } = m;
  const isDraft = ver.state === 'draft';
  const awaitingMe = ver.state === 'sent' && !ver.customer_approved_at;
  const finalReady = nda.status === 'active' || nda.status === 'terminated';
  const receipts = m.mails.filter((x) => ['customer_receipt', 'final', 'termination_receipt'].includes(x.kind));
  return html`<div class="stack-lg medium-wide">
  <div><p class="eyebrow"><a href="/konto/aftaler">Aftaler og dokumenter</a> · <a href="${BASE}">Fortrolighedsaftaler</a></p>
    <div class="item-head"><h1 style="margin:0">Fortrolighedsaftale ${nda.number}</h1><div class="row" style="gap:6px">${ndaStatusBadge(nda.status)}${deletionBadge(nda)}</div></div>
    <p class="lead" style="margin-top:8px">Gensidig aftale om fortrolighed mellem ${snap.customer.company_name || 'din virksomhed'} og Veyro.</p></div>
  ${testBanner(m.testLabel)}
  ${flash(m.flashKey)}
  <section class="card">
    ${factList([
      ['Aftalenummer og version', `${nda.number} · version ${ver.version}`],
      ['Status', ndaStatusBadge(nda.status)],
      ['Virksomhed', snap.customer.company_name || html`<span class="muted">Ikke udfyldt</span>`],
      ['Projekt', html`<span class="prewrap">${snap.project || '–'}</span>`],
      ['Oprettet', formatDateTime(nda.created_at)],
      ['Ikrafttræden', nda.effective_at ? formatDateTime(nda.effective_at) : html`<span class="muted">Når begge parter har godkendt</span>`],
      ['Kundens godkendelse', approvalTime(ver.customer_approved_at)],
      ['Veyros godkendelse', approvalTime(ver.veyro_approved_at)],
    ])}
    <div class="row" style="margin-top:16px">
      ${finalReady ? html`<a class="btn btn-primary" href="${BASE}/${nda.id}/aftale.pdf">Download aftalen (PDF)</a><a class="btn btn-secondary" href="${BASE}/${nda.id}/aftale.pdf?vis=1">Åbn PDF</a>` : ''}
      ${!finalReady ? html`<a class="btn btn-secondary" href="${BASE}/${nda.id}/udkast.pdf">Download udkast (PDF)</a>` : ''}
    </div>
  </section>

  ${isDraft
    ? html`<div class="stack-lg">
      ${ver.version > 1 ? alert('info', `Dette er version ${ver.version}. Begge parter skal godkende den nye version.`) : ''}
      ${m.blockers.length && Object.keys(m.errors).length === 0 ? alert('warn', html`${m.blockers.map((b) => html`<p style="margin:0">${b}</p>`)}`) : ''}
      ${Object.keys(m.errors).length ? alert('err', 'Ret venligst de markerede felter.') : ''}
      <p>Udfyld og kontrollér oplysningerne. Du kan gemme som kladde og fortsætte senere. Når alt er korrekt, låses aftalen, og du kan læse den færdige tekst og godkende den.</p>
      <form method="post" action="${BASE}/${nda.id}" class="stack-lg" novalidate>
        ${csrfField(m.csrf)}
        ${ndaFormFields(m.form, m.errors, m.veyro)}
        <div class="row sticky-save">
          <button class="btn btn-primary" type="submit" name="next" value="send" data-loading="Gemmer …">Gem og gå til godkendelse</button>
          <button class="btn btn-secondary" type="submit" name="next" value="draft" data-loading="Gemmer …">Gem kladde</button>
        </div>
      </form>
      ${ndaSummary(snap)}
      <details class="card"><summary>Læs hele aftaleteksten (udkast)</summary><div style="margin-top:16px">${ndaDocument(snap, null)}</div></details>
    </div>`
    : ''}

  ${ver.state === 'sent'
    ? html`${ndaSummary(snap)}
      ${ndaDocument(snap, ver)}
      ${awaitingMe || ver.customer_approved_at ? approveSection(m) : ''}`
    : ''}

  ${finalReady ? html`${ndaSummary(snap)}<details class="card"><summary>Læs hele den godkendte aftale</summary><div style="margin-top:16px">${ndaDocument(snap, ver)}</div></details>` : ''}

  ${nda.status === 'terminated' ? terminationSection(m, BASE, 'kunde') : ''}

  ${nda.status === 'active'
    ? html`<section class="card stack" aria-labelledby="stop-h">
      <h2 id="stop-h">Afslut aftalen for fremtidig udveksling</h2>
      <p>${TERMINATE_TEXT}</p>
      <div class="row"><a class="btn btn-danger" href="${BASE}/${nda.id}/ophoer">Afslut aftalen for fremtidig udveksling</a></div>
    </section>`
    : ''}

  <section class="card stack" aria-labelledby="req-h">
    <h2 id="req-h">Sletning og tilbagelevering</h2>
    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <h3 style="margin:0">Aftaledokumentet</h3>
        <p class="small">${m.canDelete ? 'Aftalen er ikke godkendt af nogen endnu og kan slettes med det samme.' : 'Godkendte aftaler slettes efter en vurdering af, hvad der fortsat skal opbevares.'} ${DELETE_DOC_TEXT}</p>
        ${m.canDelete
          ? html`<a class="btn btn-secondary" href="${BASE}/${nda.id}/slet">Slet kladden</a>`
          : nda.deletion_status === 'none'
            ? html`<a class="btn btn-secondary" href="${BASE}/${nda.id}/slet">Anmod om sletning af aftaledokumentet</a>`
            : html`<p class="small">${deletionBadge(nda)}</p>`}
      </div>
      ${finalReady
        ? html`<div class="stack">
          <h3 style="margin:0">Delte oplysninger</h3>
          <p class="small">Bed Veyro om at returnere eller slette oplysninger, I har delt under aftalen (punkt 4).</p>
          <a class="btn btn-secondary" href="${BASE}/${nda.id}/oplysninger">Anmod om tilbagelevering eller sletning af delte oplysninger</a>
        </div>`
        : ''}
    </div>
    ${m.requests.length ? requestList(m.requests, BASE) : ''}
  </section>

  ${versionHistory(m.versions)}

  ${receipts.length
    ? html`<section class="card" aria-labelledby="mail-h"><h2 id="mail-h">Kvitteringer på mail</h2>
      <ul class="list" style="margin-top:12px">${receipts.map(
        (x) => html`<li><div class="item-head"><span>${MAIL_LABEL[x.kind]}</span>${mailBadge(x)}</div><div class="meta">${x.recipient} · ${formatDateTime(x.sent_at ?? x.created_at)}</div></li>`,
      )}</ul>
      <p class="small muted">Fejler en mail, kan du altid hente dokumenterne her, og Veyro kan sende dem igen.</p></section>`
    : ''}
</div>`;
}

// ---------------- Kunde: bekræftelser ----------------

export function ndaTerminatePage(args: { csrf: string; nda: NdaRow; base?: string; adminForm?: H }): H {
  const base = args.base ?? BASE;
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow"><a href="${base}/${args.nda.id}">${args.nda.number}</a></p><h1>Afslut aftalen for fremtidig udveksling</h1></div>
  ${alert('warn', TERMINATE_TEXT)}
  <form method="post" action="${base}/${args.nda.id}/ophoer" class="card stack">
    ${csrfField(args.csrf)}
    ${args.adminForm ?? ''}
    <p class="small">Den anden part får en skriftlig meddelelse. Både meddelelsen og dens leveringsstatus gemmes, og begge parter kan hente en kvittering.</p>
    <div class="row">
      <button class="btn btn-danger" type="submit" data-loading="Afslutter …">Bekræft: afslut for fremtidig udveksling</button>
      <a class="btn btn-secondary" href="${base}/${args.nda.id}">Fortryd</a>
    </div>
  </form>
</div>`;
}

export function ndaDeletePage(args: { csrf: string; nda: NdaRow; direct: boolean; idem: string }): H {
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow"><a href="${BASE}/${args.nda.id}">${args.nda.number}</a></p>
    <h1>${args.direct ? 'Slet kladden' : 'Anmod om sletning af aftaledokumentet'}</h1></div>
  ${args.direct
    ? html`<p class="lead">Kladden er ikke godkendt af nogen. Den og alle tilknyttede oplysninger slettes med det samme og kan ikke gendannes.</p>`
    : html`<p class="lead">Aftalen er godkendt. Veyro vurderer, hvilke oplysninger der fortsat er nødvendige at opbevare, og du får besked om resultatet. Beholdes noget, får du en konkret begrundelse og en slettefrist.</p>
      ${alert('info', DELETE_DOC_TEXT)}`}
  <form method="post" action="${BASE}/${args.nda.id}/slet" class="card stack">
    ${csrfField(args.csrf)}
    <input type="hidden" name="_idem" value="${args.idem}">
    <div class="row">
      <button class="btn btn-danger" type="submit" data-loading="Sender …">${args.direct ? 'Slet kladden' : 'Send anmodning om sletning'}</button>
      <a class="btn btn-secondary" href="${BASE}/${args.nda.id}">Fortryd</a>
    </div>
  </form>
</div>`;
}

export function ndaReturnInfoPage(args: { csrf: string; nda: NdaRow; idem: string; error?: string | null; choice?: string; description?: string }): H {
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow"><a href="${BASE}/${args.nda.id}">${args.nda.number}</a></p>
    <h1>Anmod om tilbagelevering eller sletning af delte oplysninger</h1>
    <p class="lead">Efter aftalens punkt 4 kan du bede Veyro om at returnere eller slette oplysninger og kopier, I har delt. Veyro bekræfter håndteringen, herunder hvad der eventuelt beholdes, hvorfor og hvor længe.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="${BASE}/${args.nda.id}/oplysninger" class="card stack" novalidate>
    ${csrfField(args.csrf)}
    <input type="hidden" name="_idem" value="${args.idem}">
    <fieldset><legend>Hvad ønsker du?</legend>
      <div class="choices">
        <label class="choice"><input type="radio" name="choice" value="return" ${args.choice === 'return' ? 'checked' : ''}><span>Tilbagelevering</span></label>
        <label class="choice"><input type="radio" name="choice" value="delete" ${args.choice === 'delete' ? 'checked' : ''}><span>Sletning</span></label>
      </div>
    </fieldset>
    <div class="field">
      <label for="description">Hvilke oplysninger drejer det sig om?</label>
      <textarea id="description" name="description" maxlength="3000" style="min-height:140px">${args.description ?? ''}</textarea>
      <p class="hint">Fx "Lagerdata og leverandørprisliste sendt i marts" eller "Alle oplysninger delt under projektet".</p>
    </div>
    <p class="small muted">Personoplysninger håndteres desuden efter en eventuel databehandleraftale. Anmodningen ophæver ikke fortroligheden.</p>
    <div class="row">
      <button class="btn btn-primary" type="submit" data-loading="Sender …">Send anmodning</button>
      <a class="btn btn-secondary" href="${BASE}/${args.nda.id}">Fortryd</a>
    </div>
  </form>
</div>`;
}

export function requestDetail(r: RequestRow, events: EventRow[]): H {
  return html`<section class="card stack">
    <div class="item-head"><h2 style="margin:0">${REQUEST_KIND_LABEL[r.kind]}</h2>${requestBadge(r)}</div>
    ${factList([
      ['Aftale', r.nda_label],
      ['Anmodet', formatDateTime(r.created_at)],
      ...(r.choice ? ([['Ønske', CHOICE_LABEL[r.choice]!]] as [string, string][]) : []),
      ...(r.handled_at ? ([['Behandlet', formatDateTime(r.handled_at)]] as [string, string][]) : []),
    ])}
    ${r.description ? html`<div><p class="label-like">Oplysninger, anmodningen vedrører</p><p class="prewrap">${r.description}</p></div>` : ''}
    ${r.result_text ? html`<div><p class="label-like">Resultat</p><p class="prewrap">${r.result_text}</p></div>` : ''}
    ${r.status === 'retained'
      ? html`<div class="alert alert-info" role="status"><p style="margin:0 0 6px"><strong>Oplysninger, der beholdes:</strong> ${r.retained_info}</p>
          <p style="margin:0 0 6px"><strong>Begrundelse:</strong> ${r.retention_reason}</p>
          <p style="margin:0"><strong>Slettefrist:</strong> ${dayFromSec(r.retain_until)}</p></div>`
      : ''}
    ${r.kind === 'delete_document' ? html`<p class="small muted" style="margin:0">${DELETE_DOC_TEXT}</p>` : ''}
    <h3>Historik</h3>
    <ul class="list poa-events">${events.map(
      (e) => html`<li><div class="item-head"><span>${REQUEST_EVENT_LABEL[e.type] ?? e.type}</span><span class="meta">${formatDateTime(e.at)}</span></div>${e.detail ? html`<div class="meta">${e.detail}</div>` : ''}</li>`,
    )}</ul>
  </section>`;
}

export function ndaRequestPage(args: { req: RequestRow; events: EventRow[]; flashKey?: string }): H {
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow"><a href="${BASE}">Fortrolighedsaftaler</a>${args.req.nda_id ? html` · <a href="${BASE}/${args.req.nda_id}">${args.req.nda_label}</a>` : ''}</p><h1>Din anmodning</h1></div>
  ${flash(args.flashKey)}
  ${requestDetail(args.req, args.events)}
</div>`;
}

// ---------------- Admin ----------------

export function adminNdaListPage(args: {
  rows: NdaListRow[];
  status: string;
  tasks: TaskRow[];
  requests: RequestRow[];
  failed: (MailRow & { number: string | null })[];
  missing: string[];
  canSign: boolean;
  signersConfigured: boolean;
  flashKey?: string;
}): H {
  const open = args.requests.filter((r) => r.status === 'received' || r.status === 'in_progress');
  const filters: [string, string][] = [['', 'Alle'], ...Object.entries(STATUS_LABEL)];
  return html`<div class="stack-lg">
  <div class="row between" style="align-items:flex-end">
    <div><h1>Fortrolighedsaftaler</h1><p class="lead" style="margin-bottom:0">Gensidige NDA'er med kunderne. Opret en kladde, lad kunden udfylde og godkende, og godkend på Veyros vegne.</p></div>
    <div class="row"><a class="btn btn-primary" href="${ADMIN}/ny">Ny aftale</a><a class="btn btn-secondary" href="${ADMIN}/skabeloner">Skabeloner</a></div>
  </div>
  ${flash(args.flashKey)}
  ${args.missing.length ? alert('warn', html`Veyros ${args.missing.join(', ')} mangler i <a href="/admin/fuldmagter/indstillinger">de centrale indstillinger</a>. Aftaler kan ikke sendes til godkendelse, før de er udfyldt.`) : ''}
  ${!args.signersConfigured
    ? alert('warn', 'Ingen Veyro-medarbejdere har rollen til at godkende fortrolighedsaftaler (NDA_SIGNERS i wrangler.toml). Aftaler kan ikke blive aktive, før rollen er tildelt.')
    : !args.canSign
      ? alert('info', 'Du har ikke rollen til at godkende fortrolighedsaftaler på Veyros vegne. Du kan oprette, sende og følge aftaler.')
      : ''}
  ${args.tasks.length
    ? html`<section class="card" aria-labelledby="t-h"><h2 id="t-h">Åbne opgaver</h2><ul class="list" style="margin-top:12px">${args.tasks.map(
        (t) => html`<li><div class="item-head"><a href="${ADMIN}/${t.nda_id}">${t.number ?? 'Slettet aftale'}</a><span class="meta">${formatDateTime(t.created_at)}</span></div><p class="small" style="margin:4px 0 0">${t.note}</p></li>`,
      )}</ul></section>`
    : ''}
  ${open.length ? html`<section class="card" aria-labelledby="r-h"><h2 id="r-h">Åbne anmodninger</h2>${requestList(open, ADMIN)}</section>` : ''}
  ${args.failed.length
    ? html`<section class="card" aria-labelledby="f-h"><h2 id="f-h">Mails, der ikke er leveret</h2><ul class="list" style="margin-top:12px">${args.failed.map(
        (m) => html`<li><div class="item-head"><span>${m.number ? html`<a href="${ADMIN}/${m.nda_id}">${m.number}</a> · ` : ''}${MAIL_LABEL[m.kind]}</span>${mailBadge(m)}</div><div class="meta">${m.recipient} · ${m.last_error ?? ''}</div></li>`,
      )}</ul></section>`
    : ''}
  <section class="card stack" aria-labelledby="l-h">
    <h2 id="l-h" class="visually-hidden">Aftaler</h2>
    <nav class="tabs" aria-label="Filtrér efter status">${filters.map(
      ([k, l]) => html`<a href="${ADMIN}${k ? `?status=${k}` : ''}"${args.status === k ? html` aria-current="page"` : ''}>${l}</a>`,
    )}</nav>
    ${args.rows.length ? ndaTable(args.rows, ADMIN) : html`<p class="empty">Ingen aftaler.</p>`}
  </section>
  ${args.requests.length > open.length ? html`<section class="card"><h2>Behandlede anmodninger</h2>${requestList(args.requests.filter((r) => !open.includes(r)), ADMIN)}</section>` : ''}
</div>`;
}

export function adminNdaNewPage(args: { csrf: string; customers: CustomerRow[]; idem: string; error?: string | null; customerId?: number; project?: string }): H {
  return html`<div class="narrow stack-lg">
  <div><p class="eyebrow"><a href="${ADMIN}">Fortrolighedsaftaler</a></p><h1>Ny fortrolighedsaftale</h1>
    <p class="lead">Vælg kunden og beskriv projektet. Kundens kendte oplysninger udfyldes på forhånd; kunden kontrollerer og supplerer dem i kundeportalen.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="${ADMIN}/ny" class="card stack" novalidate>
    ${csrfField(args.csrf)}
    <input type="hidden" name="_idem" value="${args.idem}">
    <div class="field">
      <label for="customer">Kunde</label>
      <select id="customer" name="customer_id" required>
        <option value="">Vælg kunde</option>
        ${args.customers.map((c) => html`<option value="${c.id}" ${args.customerId === c.id ? 'selected' : ''}>${c.company || c.name || c.email} (${c.email})</option>`)}
      </select>
      <p class="hint">Kun kunder med en konto i kundeportalen kan godkende digitalt.</p>
    </div>
    <div class="field">
      <label for="project">Projekt, hjemmeside eller system</label>
      <textarea id="project" name="project" maxlength="2000" style="min-height:120px">${args.project ?? ''}</textarea>
    </div>
    <div class="row"><button class="btn btn-primary" type="submit" data-loading="Opretter …">Opret kladde</button><a class="btn btn-secondary" href="${ADMIN}">Annullér</a></div>
  </form>
</div>`;
}

export interface AdminDetailModel extends Omit<DetailModel, 'otpSentTo' | 'canDelete'> {
  customerEmail: string;
  tasks: TaskRow[];
  canSign: boolean;
  signerEmail: string;
  otpSentTo: string | null;
  veyroName: string;
  veyroTitle: string;
}

export function adminNdaDetailPage(m: AdminDetailModel): H {
  const { nda, ver, snap } = m;
  const finalReady = nda.status === 'active' || nda.status === 'terminated';
  const missingParty = ver.state === 'sent' ? [!ver.customer_approved_at ? 'kunden' : null, !ver.veyro_approved_at ? 'Veyro' : null].filter(Boolean) : [];
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="${ADMIN}">Fortrolighedsaftaler</a></p>
    <div class="item-head"><h1 style="margin:0">${nda.number}</h1><div class="row" style="gap:6px">${ndaStatusBadge(nda.status)}${deletionBadge(nda)}</div></div>
    <p class="lead" style="margin-top:8px">${snap.customer.company_name || 'Kunde'} · ${m.customerEmail}</p></div>
  ${testBanner(m.testLabel)}
  ${flash(m.flashKey)}
  ${m.error ? alert('err', m.error) : ''}
  <section class="card">
    ${factList([
      ['Version', String(ver.version)],
      ['Mangler at godkende', missingParty.length ? missingParty.join(' og ') : ver.state === 'draft' ? 'Ikke sendt til godkendelse' : 'Ingen'],
      ['Kundens godkendelse', ver.customer_approved_at ? `${ver.customer_name}, ${ver.customer_title} (${ver.customer_email}) – ${formatDateTime(ver.customer_approved_at)}` : html`<span class="muted">Mangler</span>`],
      ['Veyros godkendelse', ver.veyro_approved_at ? `${ver.veyro_name}, ${ver.veyro_title} (${ver.veyro_email}) – ${formatDateTime(ver.veyro_approved_at)}` : html`<span class="muted">Mangler</span>`],
      ['Ikrafttræden', nda.effective_at ? formatDateTime(nda.effective_at) : '–'],
      ['Oprettet', `${formatDateTime(nda.created_at)} af ${nda.created_by}`],
    ])}
    <div class="row" style="margin-top:16px">
      ${finalReady ? html`<a class="btn btn-primary" href="${ADMIN}/${nda.id}/aftale.pdf">Download aftalen (PDF)</a>` : html`<a class="btn btn-secondary" href="${ADMIN}/${nda.id}/udkast.pdf">Download udkast</a>`}
      ${nda.status === 'terminated' ? html`<a class="btn btn-secondary" href="${ADMIN}/${nda.id}/ophoer.pdf">Kvittering for ophør</a>` : ''}
    </div>
  </section>

  ${ver.state === 'draft'
    ? html`<section class="stack-lg">
      <h2>Kladde (version ${ver.version})</h2>
      ${m.blockers.length ? alert('warn', html`${m.blockers.map((b) => html`<p style="margin:0">${b}</p>`)}`) : ''}
      <form method="post" action="${ADMIN}/${nda.id}" class="stack-lg" novalidate>
        ${csrfField(m.csrf)}
        ${ndaFormFields(m.form, m.errors, m.veyro)}
        <div class="row sticky-save">
          <button class="btn btn-secondary" type="submit" name="next" value="draft" data-loading="Gemmer …">Gem kladde</button>
          <button class="btn btn-primary" type="submit" name="next" value="send" data-loading="Sender …">Gem og send til godkendelse</button>
        </div>
      </form>
    </section>`
    : ''}

  ${ver.state === 'sent'
    ? html`<section class="card stack" id="godkend">
      <h2>Godkendelse på Veyros vegne</h2>
      ${ver.veyro_approved_at
        ? alert('ok', `Godkendt af ${ver.veyro_name}, ${ver.veyro_title} ${formatDateTime(ver.veyro_approved_at)}.`)
        : !m.canSign
          ? html`<p>Du har ikke rollen til at godkende fortrolighedsaftaler på Veyros vegne.</p>`
          : m.otpSentTo
            ? html`<p>Engangskode sendt til <strong>${m.otpSentTo}</strong>. Koden virker i 10 minutter.</p>
              ${m.devCode ? alert('info', html`Udviklingstilstand: koden er <strong class="devlink">${m.devCode}</strong>`) : ''}
              <form method="post" action="${ADMIN}/${nda.id}/godkend" class="stack" novalidate>
                ${csrfField(m.csrf)}
                <input type="hidden" name="hash" value="${ver.content_hash ?? ''}">
                <div class="grid grid-2 form-grid">
                  <div class="field"><label for="vn">Dit navn</label><input id="vn" name="name" value="${m.veyroName}" required maxlength="120"></div>
                  <div class="field"><label for="vt">Din titel</label><input id="vt" name="title" value="${m.veyroTitle}" required maxlength="120"></div>
                </div>
                ${CONFIRMATIONS.map((c, i) => html`<label class="check confirm-check"><input type="checkbox" name="confirm${i + 1}" value="1" required><span>${c}</span></label>`)}
                <div class="field"><label for="code">Engangskode</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="max-width:200px;letter-spacing:.2em" required></div>
                <div class="row"><button class="btn btn-accent" type="submit" data-loading="Godkender …">Godkend på Veyros vegne</button></div>
              </form>`
            : html`<p>Du godkender version ${ver.version} på vegne af ${snap.veyro.legal_name}. Der sendes en engangskode til ${m.signerEmail}.</p>
              <form method="post" action="${ADMIN}/${nda.id}/kode" class="row">${csrfField(m.csrf)}<input type="hidden" name="hash" value="${ver.content_hash ?? ''}"><button class="btn btn-primary" type="submit" data-loading="Sender …">Send engangskode</button></form>`}
      <form method="post" action="${ADMIN}/${nda.id}/ret" class="inline">${csrfField(m.csrf)}<button class="linkbtn small" type="submit">Ret aftalen (${ver.customer_approved_at || ver.veyro_approved_at ? 'opretter en ny version, som begge skal godkende' : 'åbner kladden igen'})</button></form>
    </section>
    ${ndaDocument(snap, ver)}`
    : ''}

  ${finalReady ? html`<details class="card"><summary>Læs den godkendte aftale</summary><div style="margin-top:16px">${ndaDocument(snap, ver)}</div></details>` : ''}

  ${nda.status === 'active'
    ? html`<section class="card stack"><h2>Afslut for fremtidig udveksling</h2><p>${TERMINATE_TEXT.replace('dit abonnement', 'kundens abonnement')}</p>
      <div class="row"><a class="btn btn-danger" href="${ADMIN}/${nda.id}/ophoer">Afslut aftalen for fremtidig udveksling</a></div></section>`
    : ''}
  ${nda.status === 'terminated' ? terminationSection({ nda, mails: m.mails, conf: m.conf }, ADMIN, 'veyro') : ''}

  ${finalReady
    ? html`<section class="card stack" aria-labelledby="coop-h">
      <h2 id="coop-h">Samarbejdets ophør</h2>
      <p class="small">Registreres særskilt fra aftalens ophør og bruges til den vejledende femårsfrist (punkt 4).</p>
      <form method="post" action="${ADMIN}/${nda.id}/samarbejde" class="stack">
        ${csrfField(m.csrf)}
        <div class="choices">${Object.entries(COOPERATION_LABEL).map(
          ([k, l]) => html`<label class="choice"><input type="radio" name="cooperation" value="${k}" ${nda.cooperation === k ? 'checked' : ''}><span>${l}</span></label>`,
        )}</div>
        <div class="field" style="max-width:240px"><label for="ended">Dato for samarbejdets ophør</label><input id="ended" type="date" name="ended_on" value="${nda.cooperation_ended_on ?? ''}"></div>
        <div class="row"><button class="btn btn-secondary" type="submit">Gem</button></div>
      </form>
      ${nda.cooperation_updated_at ? html`<p class="meta">Senest ændret ${formatDateTime(nda.cooperation_updated_at)} af ${nda.cooperation_updated_by}</p>` : ''}
    </section>`
    : ''}

  ${m.tasks.length
    ? html`<section class="card" aria-labelledby="task-h"><h2 id="task-h">Opgaver</h2><ul class="list" style="margin-top:12px">${m.tasks.map(
        (t) => html`<li><div class="item-head"><span>${t.note}</span>${t.status === 'open'
          ? html`<form method="post" action="${ADMIN}/${nda.id}/opgaver/${t.id}">${csrfField(m.csrf)}<button class="btn btn-secondary btn-small" type="submit">Markér som løst</button></form>`
          : html`<span class="badge b-ok">Løst ${formatDateTime(t.done_at)}</span>`}</div></li>`,
      )}</ul></section>`
    : ''}

  ${m.requests.length ? html`<section class="card"><h2>Anmodninger</h2>${requestList(m.requests, ADMIN)}</section>` : ''}

  <section class="card" aria-labelledby="mails-h"><h2 id="mails-h">Mails og meddelelser</h2>
    ${m.mails.length
      ? html`<ul class="list" style="margin-top:12px">${m.mails.map(
          (x) => html`<li><div class="item-head"><span>${MAIL_LABEL[x.kind]} → ${x.recipient}</span><div class="row" style="gap:6px">${mailBadge(x)}
            <form method="post" action="${ADMIN}/${nda.id}/mails/${x.id}">${csrfField(m.csrf)}<button class="btn btn-secondary btn-small" type="submit">${x.status === 'sent' ? 'Gensend' : 'Prøv igen'}</button></form></div></div>
            <div class="meta">Oprettet ${formatDateTime(x.created_at)}${x.sent_at ? ` · Afleveret ${formatDateTime(x.sent_at)}` : ''} · ${x.attempts} forsøg${x.last_error ? ` · Fejl: ${x.last_error}` : ''}</div></li>`,
        )}</ul>`
      : html`<p class="empty">Ingen mails endnu.</p>`}
  </section>

  ${versionHistory(m.versions)}

  <section class="card" aria-labelledby="ev-h"><h2 id="ev-h">Historik</h2>
    <ul class="list poa-events" style="margin-top:12px">${m.events.map(
      (e) => html`<li><div class="item-head"><span>${EVENT_LABEL[e.type] ?? e.type}</span><span class="meta">${formatDateTime(e.at)}</span></div><div class="meta">${e.actor}${e.detail ? ` · ${e.detail}` : ''}</div></li>`,
    )}</ul>
  </section>
</div>`;
}

export function adminRequestPage(args: { csrf: string; req: RequestRow; events: EventRow[]; error?: string | null; flashKey?: string }): H {
  const r = args.req;
  const open = r.status === 'received' || r.status === 'in_progress';
  const today = new Date().toISOString().slice(0, 10);
  return html`<div class="medium-wide stack-lg">
  <div><p class="eyebrow"><a href="${ADMIN}">Fortrolighedsaftaler</a>${r.nda_id ? html` · <a href="${ADMIN}/${r.nda_id}">${r.nda_label}</a>` : ''}</p><h1>Anmodning fra ${r.email ?? 'kunden'}</h1></div>
  ${flash(args.flashKey)}
  ${args.error ? alert('err', args.error) : ''}
  ${requestDetail(r, args.events)}
  ${open
    ? html`<section class="card stack">
      <h2>Behandl anmodningen</h2>
      <p class="small">${r.kind === 'delete_document'
        ? 'Vurdér, hvilke oplysninger der fortsat er nødvendige at opbevare. "Gennemført" sletter aftalen, versioner, godkendelser, PDF\'er, mails og historik i systemet nu. "Noget beholdes" sletter hjælpedata nu og resten automatisk på slettefristen.'
        : 'Håndtér anmodningen efter aftalens punkt 4 og en eventuel databehandleraftale, og bekræft resultatet. Husk sikkerhedskopier og eventuelle oplysninger, der beholdes.'}</p>
      ${r.status === 'received'
        ? html`<form method="post" action="${ADMIN}/anmodninger/${r.id}/start">${csrfField(args.csrf)}<button class="btn btn-secondary" type="submit">Markér som under behandling</button></form>`
        : ''}
      <form method="post" action="${ADMIN}/anmodninger/${r.id}" class="stack" novalidate>
        ${csrfField(args.csrf)}
        <fieldset><legend>Resultat</legend><div class="choices">
          <label class="choice"><input type="radio" name="outcome" value="completed"><span>Gennemført</span></label>
          <label class="choice"><input type="radio" name="outcome" value="retained"><span>Gennemført – noget beholdes</span></label>
          <label class="choice"><input type="radio" name="outcome" value="rejected"><span>Afvist</span></label>
        </div></fieldset>
        <div class="field"><label for="rt">Resultat til kunden</label><textarea id="rt" name="result_text" maxlength="3000" style="min-height:120px"></textarea>
          <p class="hint">Beskriv konkret, hvad der er returneret eller slettet, og hvordan sikkerhedskopier håndteres.</p></div>
        <div class="field"><label for="ri">Hvis noget beholdes: hvilke oplysninger</label><textarea id="ri" name="retained_info" maxlength="2000"></textarea></div>
        <div class="field"><label for="rr">Begrundelse for at beholde dem</label><textarea id="rr" name="retention_reason" maxlength="2000"></textarea>
          <p class="hint">Fx lovpligtig opbevaring (bogføring), udtrykkeligt aftalte fortsatte opgaver eller fastlæggelse af retskrav.</p></div>
        <div class="field" style="max-width:240px"><label for="ru">Slettefrist</label><input id="ru" type="date" name="retain_until" min="${today}"></div>
        <div class="row"><button class="btn btn-primary" type="submit" data-loading="Gemmer …">Afslut anmodningen og giv kunden besked</button></div>
      </form>
    </section>`
    : ''}
</div>`;
}

export function adminTemplatesPage(args: { csrf: string; templates: (TemplateRow & { uses: number })[]; error?: string | null; body?: string; footnote?: string; note?: string; flashKey?: string }): H {
  const latest = args.templates[0]!;
  return html`<div class="medium-wide stack-lg">
  <div><p class="eyebrow"><a href="${ADMIN}">Fortrolighedsaftaler</a></p><h1>Standardskabelon</h1>
    <p class="lead">En ny version bruges kun til aftaler, der oprettes herefter. Eksisterende aftaler beholder deres egen kopi af teksten.</p></div>
  ${flash(args.flashKey)}
  ${args.error ? alert('err', args.error) : ''}
  <section class="card"><h2>Versioner</h2><ul class="list" style="margin-top:12px">${args.templates.map(
    (t) => html`<li><div class="item-head"><h3>Version ${t.version}${t === latest ? ' (bruges til nye aftaler)' : ''}</h3><span class="meta">${t.uses} ${t.uses === 1 ? 'aftale' : 'aftaler'}</span></div>
      <div class="meta">${formatDateTime(t.created_at)} · ${t.created_by}${t.note ? ` · ${t.note}` : ''}</div>
      <details><summary>Vis tekst</summary><pre class="prewrap small" style="white-space:pre-wrap">${t.body}</pre></details></li>`,
  )}</ul></section>
  <section class="card stack"><h2>Ny version</h2>
    <p class="small">Opmærkning: "# " foran en overskrift, "- " foran et punkt, en linje med [PROJEKT], hvor projektbeskrivelsen indsættes, og en tom linje mellem afsnit. Parternes oplysninger og godkendelser indsættes automatisk.</p>
    <form method="post" action="${ADMIN}/skabeloner" class="stack">
      ${csrfField(args.csrf)}
      <div class="field"><label for="tb">Aftaletekst</label><textarea id="tb" name="body" style="min-height:420px;font-family:ui-monospace,monospace;font-size:13px">${args.body ?? latest.body}</textarea></div>
      <div class="field"><label for="tf">Fodnote</label><textarea id="tf" name="footnote">${args.footnote ?? latest.footnote}</textarea></div>
      <div class="field"><label for="tn">Intern bemærkning (fx hvad der er ændret)</label><input id="tn" name="note" maxlength="200" value="${args.note ?? ''}"></div>
      <div class="row"><button class="btn btn-primary" type="submit">Gem som ny version</button></div>
    </form>
  </section>
</div>`;
}
