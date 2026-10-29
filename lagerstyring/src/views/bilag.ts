// Bilag: upload, oversigt, digital visning, kontrol, fordeling, godkendelse og eksport.

import { html } from 'hono/html';
import {
  ACTION_LABEL,
  DOC_TYPE_LABEL,
  EXPORT_LABEL,
  FIELD_LABEL,
  PAYMENT_LABEL,
  STATUS_LABEL,
  STATUS_TAG,
  TARGET_LABEL,
  bilagNo,
  exportState,
  lineNet,
  uncertainOf,
  type AllocationView,
  type BilagEventRow,
  type BilagLineRow,
  type BilagListRow,
  type BilagRow,
  type Checks,
  type ExportState,
} from '../lib/bilag';
import { FILE_MAX_BYTES, UPLOAD_MAX_FILES } from '../lib/files';
import type { OcrJob } from '../lib/bilagqueue';
import { formatDateTime, formatDay, formatKr, formatQty, oereToInput, qtyInput } from '../lib/format';
import type { PurchaseLineRow } from '../env';
import { errors, pageHead } from './common';
import { alert, csrfField, opField, type H } from './layout';

const kr = (o: number | null | undefined) => (o === null || o === undefined ? '–' : formatKr(o, { decimals: true }));
const money = (o: number | null | undefined) => (o === null || o === undefined ? '' : oereToInput(o));
const sel = (on: boolean) => (on ? html` selected` : '');

export function bilagTag(b: Pick<BilagRow, 'status'>): H {
  return html`<span class="tag ${STATUS_TAG[b.status]}">${STATUS_LABEL[b.status]}</span>`;
}

const EXPORT_TAG: Record<ExportState, string> = { ikke_klar: 'tag-off', klar: 'tag-ready', eksporteret: 'tag-ok', fejlet: 'tag-fail', aendret: 'tag-low' };
export function exportTag(s: ExportState): H {
  return html`<span class="tag ${EXPORT_TAG[s]}">${EXPORT_LABEL[s]}</span>`;
}

const BILAG_FLASH: Record<string, [kind: 'ok' | 'info' | 'warn', text: string]> = {
  uploadet: ['ok', 'Bilaget er uploadet, og originalen er gemt. Se aflæsningsstatus nedenfor, og kontrollér oplysningerne mod originalen.'],
  gemt: ['ok', 'Ændringerne er gemt og logget i historikken.'],
  godkendt: ['ok', 'Bilaget er godkendt. Det er klar til eksport til bogholderen. Lageret er ikke ændret af godkendelsen.'],
  fordelt: ['ok', 'Fordelingen er gemt. Lageret er ikke ændret.'],
  fjernet: ['ok', 'Fordelingen er fjernet.'],
  registreret: ['ok', 'Registreringen er gennemført på lageret/jobbet. Den kan kun ske én gang.'],
  status: ['ok', 'Status er ændret.'],
  dublet_ok: ['ok', 'Markeret som ikke en dublet.'],
  refunderet: ['ok', 'Udlægget er markeret som refunderet.'],
  match: ['ok', 'Varematchet er godkendt.'],
  eksporteret: ['ok', 'Eksporten er dannet. Den er ikke sendt til noget regnskabsprogram.'],
  fejlet: ['warn', 'Eksporten er markeret som fejlet. Bilagene kan eksporteres igen.'],
  slettet: ['ok', 'Bilaget er slettet.'],
};

function bflash(code: string | undefined, extra?: string): H | '' {
  const f = code ? BILAG_FLASH[code] : undefined;
  if (!f && !extra) return '';
  return html`${f ? alert(f[0], f[1]) : ''}${extra ? alert('info', extra) : ''}`;
}

// --- Upload ---------------------------------------------------------------------------------------

export interface UploadData {
  base: string;
  csrf: string;
  op: string;
  jobs: { id: number; number: string; name: string }[];
  users: { email: string; name: string }[];
  me: string;
  manager: boolean;
  jobId: number | null;
  origin: string;
  errs: string[];
}

export function uploadPage(d: UploadData): H {
  return html`<div class="stack-lg narrow">
  ${pageHead(html`<a href="${d.base}">Bilag</a>`, 'Upload bilag', '', 'Tag et billede eller vælg PDF- og billedfiler. Originalen gemmes uændret. Upload ændrer aldrig lageret.')}
  ${errors(d.errs)}
  <form class="card stack" method="post" action="${d.base}/ny" enctype="multipart/form-data">
    ${csrfField(d.csrf)}${opField(d.op)}
    <input type="hidden" name="origin" value="${d.origin}">
    <div class="field"><label for="cam">Tag billede</label><input id="cam" type="file" name="files" accept="image/*" capture="environment">
      <p class="hint">Åbner kameraet på telefonen.</p></div>
    <div class="field"><label for="files">Eller vælg filer</label><input id="files" type="file" name="files" accept="application/pdf,image/jpeg,image/png,image/heic,.pdf,.jpg,.jpeg,.png,.heic" multiple>
      <p class="hint">PDF, JPG, PNG eller HEIC. Højst ${UPLOAD_MAX_FILES} filer og ${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB pr. fil. En PDF med flere sider er ét bilag.</p></div>
    <p class="hint">Når OCR er tilsluttet, aflæses billeder og scannede PDF'er automatisk i baggrunden. Du kan fortsætte arbejdet, mens bilagene står i kø. PDF'er med læsbar tekst aflæses straks.</p>
    <div class="fields fields-2">
      <div class="field"><label for="doc_type">Type</label><select id="doc_type" name="doc_type">
        ${(['kvittering', 'faktura', 'kreditnota', 'andet'] as const).map((t) => html`<option value="${t}">${DOC_TYPE_LABEL[t]}</option>`)}
      </select></div>
      <div class="field"><label for="job_id">Job (valgfrit)</label><select id="job_id" name="job_id"><option value="">Intet job</option>${d.jobs.map(
        (j) => html`<option value="${j.id}"${sel(d.jobId === j.id)}>${j.number} ${j.name}</option>`,
      )}</select></div>
    </div>
    <fieldset class="field"><legend>Hvem har betalt?</legend>
      ${(['virksomhed', 'medarbejder', 'ikke_betalt', 'uafklaret'] as const).map(
        (p) => html`<label class="check"><input type="radio" name="payment" value="${p}"${p === (d.manager ? 'virksomhed' : 'medarbejder') ? html` checked` : ''}> ${PAYMENT_LABEL[p]}</label>`,
      )}
    </fieldset>
    ${d.manager
      ? html`<div class="field"><label for="paid_by">Udlæg af (ved medarbejderudlæg)</label><select id="paid_by" name="paid_by"><option value="">Vælg</option>${d.users.map(
          (u) => html`<option value="${u.email}"${sel(u.email === d.me)}>${u.name}</option>`,
        )}</select></div>`
      : html`<input type="hidden" name="paid_by" value="${d.me}">`}
    <div class="field"><label for="note">Bemærkning (intern)</label><input id="note" name="note" maxlength="300"></div>
    <button class="btn btn-primary" type="submit">Upload</button>
  </form>
</div>`;
}

// --- Oversigt -------------------------------------------------------------------------------------

export interface ListData {
  base: string;
  rows: BilagListRow[];
  f: { q: string; status: string; payment: string; type: string; job: string; from: string; to: string };
  tab: 'alle' | 'aabne' | 'udlaeg' | 'eksport';
  jobs: { id: number; number: string; name: string }[];
  manager: boolean;
  counts: { open: number; outlay: number; ready: number };
  flashCode?: string;
}

export function bilagTabs(base: string, tab: string, counts: ListData['counts'], manager: boolean): H {
  const t = (key: string, href: string, label: string, n?: number) =>
    html`<a href="${href}"${tab === key ? html` aria-current="page"` : ''}>${label}${n ? html` <span class="c">${n}</span>` : ''}</a>`;
  return html`<nav class="tabs">${t('alle', base, 'Alle bilag')}${t('aabne', `${base}?status=aaben`, 'Til gennemgang', counts.open)}${t('udlaeg', `${base}/udlaeg`, 'Udlæg', counts.outlay)}${manager
    ? t('eksport', `${base}/eksport`, 'Eksport til bogholder', counts.ready)
    : ''}</nav>`;
}

export function listPage(d: ListData): H {
  const f = d.f;
  return html`<div class="stack-lg">
  ${pageHead('Bilag', 'Bilag', html`<a class="btn btn-secondary" href="${d.base}/chat">Chat med et bilag</a><a class="btn btn-primary" href="${d.base}/ny">Upload bilag</a>`, 'Kvitteringer, leverandørfakturaer og kreditnotaer. Upload → kontrollér → fordel → godkend → eksportér.')}
  ${bflash(d.flashCode)}
  ${bilagTabs(d.base, d.tab, d.counts, d.manager)}
  <form class="card toolbar" method="get" action="${d.tab === 'udlaeg' ? `${d.base}/udlaeg` : d.base}">
    <div class="fields fields-3">
      <div class="field"><label for="q">Søg</label><input id="q" name="q" value="${f.q}" placeholder="Leverandør, nummer, bilags-ID"></div>
      <div class="field"><label for="status">Status</label><select id="status" name="status"><option value="">Alle</option><option value="aaben"${sel(f.status === 'aaben')}>Til gennemgang</option>${Object.entries(STATUS_LABEL).map(
        ([k, v]) => html`<option value="${k}"${sel(f.status === k)}>${v}</option>`,
      )}</select></div>
      <div class="field"><label for="type">Type</label><select id="type" name="type"><option value="">Alle</option>${Object.entries(DOC_TYPE_LABEL).map(
        ([k, v]) => html`<option value="${k}"${sel(f.type === k)}>${v}</option>`,
      )}</select></div>
      <div class="field"><label for="payment">Betaling</label><select id="payment" name="payment"><option value="">Alle</option>${Object.entries(PAYMENT_LABEL).map(
        ([k, v]) => html`<option value="${k}"${sel(f.payment === k)}>${v}</option>`,
      )}</select></div>
      <div class="field"><label for="job">Job</label><select id="job" name="job"><option value="">Alle</option><option value="-1"${sel(f.job === '-1')}>Uden job</option>${d.jobs.map(
        (j) => html`<option value="${j.id}"${sel(f.job === String(j.id))}>${j.number} ${j.name}</option>`,
      )}</select></div>
      <div class="field"><label>Periode</label><div class="row"><input type="date" name="fra" value="${f.from}" aria-label="Fra"><input type="date" name="til" value="${f.to}" aria-label="Til"></div></div>
    </div>
    <div class="row"><button class="btn btn-secondary btn-small" type="submit">Filtrér</button><a class="btn btn-ghost btn-small" href="${d.tab === 'udlaeg' ? `${d.base}/udlaeg` : d.base}">Nulstil</a></div>
  </form>
  ${listTable(d.base, d.rows, d.tab === 'udlaeg')}
</div>`;
}

export function listTable(base: string, rows: BilagListRow[], outlay = false): H {
  return html`<div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Bilag</th><th>Leverandør</th><th>Dato</th><th class="num">Total</th><th>Status</th><th>${outlay ? 'Udlæg af' : 'Betaling'}</th><th>Job</th><th>Eksport</th></tr></thead>
    <tbody>${rows.length
      ? rows.map(
          (b) => html`<tr class="row-link" data-href="${base}/${b.id}">
        <td class="cell-main"><a class="title" href="${base}/${b.id}">${bilagNo(b.id)}</a><div class="muted">${DOC_TYPE_LABEL[b.doc_type]}${b.doc_number ? ` ${b.doc_number}` : ''}</div></td>
        <td data-label="Leverandør">${b.supplier_name || html`<span class="miss">Ikke aflæst</span>`}${b.dup_of && !b.dup_cleared_by ? html` <span class="tag tag-crit">Mulig dublet</span>` : ''}</td>
        <td data-label="Dato">${b.doc_date ? formatDay(b.doc_date) : formatDateTime(b.created_at)}</td>
        <td class="num" data-label="Total">${b.doc_type === 'kreditnota' && b.total ? `−${kr(b.total)}` : kr(b.total)}${b.currency && b.currency !== 'DKK' ? ` ${b.currency}` : ''}</td>
        <td data-label="Status">${bilagTag(b)}</td>
        <td data-label="${outlay ? 'Udlæg af' : 'Betaling'}">${outlay ? html`${b.payer ?? b.paid_by}${b.reimbursed_at ? html` <span class="tag tag-ok">Refunderet</span>` : html` <span class="tag tag-ready">Ikke refunderet</span>`}` : PAYMENT_LABEL[b.payment]}</td>
        <td data-label="Job">${b.jobs ?? '–'}</td>
        <td data-label="Eksport">${exportTag(exportState(b))}</td>
      </tr>`,
        )
      : html`<tr><td colspan="8" class="empty">Ingen bilag.</td></tr>`}</tbody>
  </table></div></div>`;
}

// --- Digital visning ------------------------------------------------------------------------------

/** "Digital visning af originalbilag": kun det, der står på bilaget. Interne oplysninger vises for sig. */
export function digitalView(b: BilagRow, lines: BilagLineRow[]): H {
  const unc = new Set(uncertainOf(b));
  const v = (field: string, value: string | H) =>
    html`<span${unc.has(field) ? html` class="uncertain" title="Usikker aflæsning, kontrollér mod originalen"` : ''}>${value || html`<span class="miss">Mangler</span>`}${unc.has(field) ? ' ⚠' : ''}</span>`;
  const sign = b.doc_type === 'kreditnota' ? '−' : '';
  return html`<article class="doc-view" aria-label="Digital visning af originalbilag">
  <div class="doc-view-head"><div class="eyebrow">Digital visning af originalbilag</div><span class="tag tag-src">${bilagNo(b.id)} · version ${b.version}</span></div>
  <div class="doc-view-top">
    <div><strong>${v('supplier_name', b.supplier_name)}</strong><div class="muted">CVR ${v('supplier_cvr', b.supplier_cvr)}</div></div>
    <div class="doc-view-meta">
      <div><span class="muted">${DOC_TYPE_LABEL[b.doc_type]}</span> ${v('doc_number', b.doc_number)}</div>
      <div><span class="muted">Dato</span> ${v('doc_date', b.doc_date ? formatDay(b.doc_date) : '')}</div>
      ${b.due_date || unc.has('due_date') ? html`<div><span class="muted">Betalingsfrist</span> ${v('due_date', b.due_date ? formatDay(b.due_date) : '')}</div>` : ''}
    </div>
  </div>
  <div class="table-wrap"><table class="list">
    <thead><tr><th>Varelinje</th><th class="num">Antal</th><th>Enhed</th><th class="num">Á-pris</th><th class="num">Rabat</th><th class="num">Beløb ${b.line_prices === 'inkl' ? 'inkl.' : 'ekskl.'} moms</th><th class="num">Moms</th></tr></thead>
    <tbody>${lines.length
      ? lines.map(
          (l) => html`<tr${l.uncertain ? html` class="uncertain"` : ''}>
        <td>${l.name}${l.uncertain ? ' ⚠' : ''}</td><td class="num">${l.qty === null ? '–' : formatQty(l.qty)}</td><td>${l.unit}</td>
        <td class="num">${kr(l.unit_price)}</td><td class="num">${l.discount ? kr(l.discount) : '–'}</td><td class="num">${kr(l.amount)}</td>
        <td class="num">${l.vat_rate === null ? '–' : `${l.vat_rate / 100} %`}</td></tr>`,
        )
      : html`<tr><td colspan="7" class="empty">Ingen varelinjer registreret.</td></tr>`}</tbody>
  </table></div>
  <dl class="doc-totals">
    <div><dt>Ekskl. moms</dt><dd>${v('net', b.net === null ? '' : `${sign}${kr(b.net)}`)}</dd></div>
    <div><dt>Moms</dt><dd>${v('vat', b.vat === null ? '' : `${sign}${kr(b.vat)}`)}</dd></div>
    ${b.rounding ? html`<div><dt>Afrunding</dt><dd>${kr(b.rounding)}</dd></div>` : ''}
    <div class="sum"><dt>Total ${b.currency}</dt><dd>${v('total', b.total === null ? '' : `${sign}${kr(b.total)}`)}</dd></div>
  </dl>
  ${b.payment_info ? html`<p class="muted">Betaling: ${v('payment_info', b.payment_info)}</p>` : ''}
  <p class="hint">${b.ocr_provider ? `OCR-forslag fra ${b.ocr_provider}. ⚠ = ikke kontrolleret mod originalen.` : b.reading_source === 'pdf-tekst' ? "Aflæst automatisk fra PDF'ens tekst og kontrolleret/rettet af brugeren. ⚠ = usikker aflæsning." : b.reading_source === 'simuleret' ? 'DEMODATA: aflæsningen er simuleret.' : 'Registreret manuelt ud fra originalen.'} Originalen er uændret og har forrang.</p>
</article>`;
}

// --- Detalje --------------------------------------------------------------------------------------

export interface DetailData {
  base: string;
  csrf: string;
  op: string;
  b: BilagRow & { uploader: string | null; payer: string | null; approver: string | null };
  file: { mime: string; pages: number | null; size: number };
  lines: BilagLineRow[];
  allocs: AllocationView[];
  events: BilagEventRow[];
  ocr?: OcrJob | null;
  /** Begge OCR-bindings er til stede; det er ikke en kontrol af tjenestens drift. */
  ocrConfigured?: boolean;
  chat?: {
    available: boolean;
    /** Source text is already available; a first question can prepare it otherwise. */
    ready?: boolean;
    message?: string;
    question?: string;
    answer?: string;
    imageReviewed?: boolean;
    sources?: { page: number; lineStart: number; lineEnd: number; text: string }[];
  };
  checks: Checks;
  canEdit: boolean;
  canDelete: boolean;
  manager: boolean;
  jobs: { id: number; number: string; name: string }[];
  products: { id: number; sku: string; name: string; unit: string }[];
  users: { email: string; name: string }[];
  suggestions: (PurchaseLineRow & { job_number: string | null; supplier_name: string | null })[];
  dupOf: { id: number; supplier_name: string; total: number | null } | null;
  vatRegistered: boolean;
  flashCode?: string;
  message?: string;
  errs: string[];
}

function original(d: DetailData): H {
  const src = `${d.base}/${d.b.id}/fil`;
  return d.file.mime === 'application/pdf'
    ? html`<iframe class="orig-frame" src="${src}" title="Originalbilag (PDF)"></iframe>`
    : d.file.mime === 'image/heic'
      ? html`<p class="muted">HEIC-billeder kan ikke vises i alle browsere. <a href="${src}?hent=1">Hent originalen</a>.</p>`
      : html`<a href="${src}" target="_blank" rel="noopener"><img class="orig-img" src="${src}" alt="Originalbilag"></a>`;
}

/** Dialogen er læsende: svar og citater er aldrig rettelser eller godkendelser. */
function chatSection(d: DetailData): H {
  const available = d.chat?.available === true;
  const ready = d.chat?.ready !== false;
  const sources = d.chat?.sources ?? [];
  return html`<section class="card stack" aria-labelledby="bilag-chat-title" data-bilag-chat>
    <div class="row-between"><h2 id="bilag-chat-title">Spørg til bilaget</h2><a class="small" href="${d.base}/${d.b.id}/fil" target="_blank" rel="noopener">Åbn originalen</a></div>
    <p class="hint">AI hjælper dig med at gennemgå bilaget. Kildeuddrag kommer fra den aflæste tekst. Sammenhold svarene med originalen. Chatten ændrer ikke bilaget.</p>
    <p class="hint">PNG/JPG op til 6 MB kan gennemgås som billede. PDF, HEIC og større billeder gennemgås ud fra aflæst tekst.</p>
    <div class="stack" data-chat-messages role="log" aria-label="Samtale om bilaget" aria-live="polite" aria-relevant="additions" style="max-height:32rem;overflow-y:auto;overflow-wrap:anywhere">
      ${d.chat?.question ? html`<div class="stack-sm"><strong>Dig</strong><p style="white-space:pre-wrap">${d.chat.question}</p></div>` : ''}
      ${d.chat?.answer ? html`<div class="stack-sm"><strong>Bilagsassistent</strong><p style="white-space:pre-wrap">${d.chat.answer}</p>${sources.map((s) => html`<blockquote class="small" style="margin:8px 0;padding-left:12px;border-left:2px solid var(--line-strong)"><strong>Side ${s.page}, ${s.lineStart === s.lineEnd ? `linje ${s.lineStart}` : `linje ${s.lineStart}–${s.lineEnd}`}</strong><p style="white-space:pre-wrap">${s.text}</p></blockquote>`)}<p class="hint">${d.chat.imageReviewed === true ? 'Grundlag: originalbillede og aflæst tekst' : 'Grundlag: aflæst tekst'}</p></div>` : ''}
    </div>
    ${d.chat?.message || !available ? html`<p class="hint" role="status">${d.chat?.message || 'Bilagschatten er ikke tilsluttet på denne installation.'}</p>` : ''}
    ${available && !ready ? html`<p class="hint">Skriv dit spørgsmål nu. Første spørgsmål kan tage et par minutter, mens originalen aflæses. Dit spørgsmål bliver på siden.</p>` : ''}
    <form class="stack" method="post" action="${d.base}/${d.b.id}/spoerg" data-chat-form data-chat-ready="${ready ? '1' : '0'}" data-multi>
      ${csrfField(d.csrf)}<input type="hidden" name="version" value="${d.b.version}"><input type="hidden" name="file_id" value="${d.b.file_id}"><input type="hidden" name="history" value="[]" data-chat-history>
      <div class="field"><label for="bilag-question">Dit spørgsmål</label><textarea id="bilag-question" name="question" rows="3" maxlength="1000" required aria-describedby="bilag-chat-help" placeholder="Fx: Hvad står der på varelinjerne?"${!available ? html` disabled` : ''}></textarea><p class="hint" id="bilag-chat-help">Du kan stille opfølgende spørgsmål i samme samtale. Kildeuddrag vises under svaret.</p></div>
      <div class="row"><button class="btn btn-primary" type="submit"${!available ? html` disabled` : ''}>Spørg til bilaget</button><span class="hint" role="status" data-chat-status></span></div>
      <div class="row" aria-label="Forslag til spørgsmål">${['Hvad står der på varelinjerne?', 'Hvor står totalbeløbet?', 'Hvilke felter bør jeg kontrollere?'].map((q) => html`<button class="btn btn-ghost btn-small" type="button" data-chat-question="${q}"${!available ? html` disabled` : ''}>${q}</button>`)}</div>
      <p class="err-text small" role="alert" data-chat-error hidden></p>
      <noscript><p class="hint">Svaret vises på en ny side, når du sender dit spørgsmål.</p></noscript>
    </form>
  </section>`;
}

function editForm(d: DetailData): H {
  const b = d.b;
  const rows = [...d.lines, null, null];
  const readonly = !d.canEdit;
  const dis = readonly ? html` disabled` : '';
  return html`<form class="card stack" method="post" action="${d.base}/${b.id}">
  ${csrfField(d.csrf)}<input type="hidden" name="do" value="gem">
  <h2>Kontrollér og ret</h2>
  <p class="hint">Felter markeret med ⚠ er usikre. Ret efter originalen; når du gemmer, regnes oplysningerne som kontrolleret. Ingen værdier opfindes: tomme felter forbliver tomme.</p>
  <div class="fields fields-3">
    <div class="field"><label for="f-type">Type</label><select id="f-type" name="doc_type"${dis}>${Object.entries(DOC_TYPE_LABEL).map(([k, v]) => html`<option value="${k}"${sel(b.doc_type === k)}>${v}</option>`)}</select></div>
    ${field('supplier_name', 'Leverandør', b.supplier_name, b, dis)}
    ${field('supplier_cvr', 'CVR', b.supplier_cvr, b, dis)}
    ${field('doc_number', 'Bilagsnummer', b.doc_number, b, dis)}
    ${field('doc_date', 'Dato', b.doc_date, b, dis, 'date')}
    ${field('due_date', 'Betalingsfrist', b.due_date, b, dis, 'date')}
    ${field('currency', 'Valuta', b.currency, b, dis)}
    ${field('net', 'Ekskl. moms', money(b.net), b, dis, 'num')}
    ${field('vat', 'Moms', money(b.vat), b, dis, 'num')}
    ${field('total', 'Total', money(b.total), b, dis, 'num')}
    ${field('rounding', 'Afrunding', b.rounding ? money(b.rounding) : '', b, dis, 'num')}
    <div class="field"><label for="f-lp">Linjepriser er</label><select id="f-lp" name="line_prices"${dis}><option value="ekskl"${sel(b.line_prices === 'ekskl')}>Ekskl. moms</option><option value="inkl"${sel(b.line_prices === 'inkl')}>Inkl. moms</option></select></div>
  </div>
  ${field('payment_info', 'Betalingsoplysninger', b.payment_info, b, dis)}
  <h3>Varelinjer</h3>
  <div class="table-wrap"><table class="list bilag-lines">
    <thead><tr><th>Beskrivelse</th><th>Antal</th><th>Enhed</th><th>Á-pris</th><th>Rabat</th><th>Beløb</th><th>Moms %</th><th>Egen vare</th><th>Fjern</th></tr></thead>
    <tbody>${rows.map((l, i) => html`<tr>
      <td><input type="hidden" name="l_id" value="${l?.id ?? ''}"><input name="l_name" value="${l?.name ?? ''}" maxlength="200" aria-label="Beskrivelse linje ${i + 1}"${dis}></td>
      <td><input class="in-sm" name="l_qty" inputmode="decimal" value="${l?.qty === null || !l ? '' : qtyInput(l.qty)}" aria-label="Antal"${dis}></td>
      <td><input class="in-sm" name="l_unit" value="${l?.unit ?? ''}" maxlength="20" aria-label="Enhed"${dis}></td>
      <td><input class="in-sm" name="l_price" inputmode="decimal" value="${money(l?.unit_price)}" aria-label="Á-pris"${dis}></td>
      <td><input class="in-sm" name="l_disc" inputmode="decimal" value="${l?.discount ? money(l.discount) : ''}" aria-label="Rabat"${dis}></td>
      <td><input class="in-sm" name="l_amount" inputmode="decimal" value="${money(l?.amount)}" aria-label="Beløb"${dis}></td>
      <td><input class="in-sm" name="l_vat" inputmode="decimal" value="${l?.vat_rate === null || !l ? '' : String(l.vat_rate / 100).replace('.', ',')}" aria-label="Momssats"${dis}></td>
      <td><select name="l_product" aria-label="Egen vare"${dis}><option value="">Ingen</option>${d.products.map((p) => html`<option value="${p.id}"${sel(l?.product_id === p.id)}>${p.sku} ${p.name}</option>`)}</select>${l?.product_state === 'forslag' ? html`<div class="hint">Forslag, gem for at godkende</div>` : ''}</td>
      <td>${l ? html`<input type="checkbox" name="l_del" value="${i}" aria-label="Fjern linjen"${dis}>` : ''}</td>
    </tr>`)}</tbody>
  </table></div>
  ${b.ocr_provider && (uncertainOf(b).length || d.lines.some((line) => line.uncertain)) && !readonly
    ? html`<label class="check"><input type="checkbox" name="confirm_ocr" value="1"> Jeg har kontrolleret alle OCR-forslag og varelinjer mod originalen.</label><p class="hint">OCR aflæser forslag. Godkendelse og lagerregistrering er blokeret, indtil du har kontrolleret og gemt dem.</p>`
    : ''}
  <h3>Interne oplysninger</h3>
  <div class="fields fields-2">
    <div class="field"><label for="f-pay">Betaling</label><select id="f-pay" name="payment">${Object.entries(PAYMENT_LABEL).map(([k, v]) => html`<option value="${k}"${sel(b.payment === k)}>${v}</option>`)}</select></div>
    <div class="field"><label for="f-paid">Udlæg af</label><select id="f-paid" name="paid_by"><option value="">Ingen</option>${d.users.map((u) => html`<option value="${u.email}"${sel(b.paid_by === u.email)}>${u.name}</option>`)}</select></div>
  </div>
  <div class="field"><label for="f-note">Intern bemærkning</label><textarea id="f-note" name="note" maxlength="1000">${b.note}</textarea></div>
  <div class="row"><button class="btn btn-primary" type="submit">Gem</button>${b.status === 'godkendt' ? html`<span class="hint">Retter du bilagets oplysninger, bliver det en ny version, som skal godkendes igen.</span>` : ''}</div>
</form>`;
}

function field(name: string, label: string, value: string, b: BilagRow, dis: H | '', kind: 'text' | 'date' | 'num' = 'text'): H {
  const unc = uncertainOf(b).includes(name);
  return html`<div class="field${unc ? ' uncertain' : ''}"><label for="f-${name}">${label}${unc ? ' ⚠' : ''}</label><input id="f-${name}" name="${name}" value="${value}"${kind === 'date' ? html` type="date"` : kind === 'num' ? html` inputmode="decimal" class="in-num"` : html` maxlength="200"`}${dis}></div>`;
}

function allocSection(d: DetailData): H {
  const b = d.b;
  const c = d.checks;
  const rest = c.base === null ? null : c.base - c.allocated;
  return html`<section class="card stack">
  <h2>Fordeling</h2>
  <p class="muted">Fordel ${d.vatRegistered ? 'beløbet ekskl. moms' : 'beløbet inkl. moms (virksomheden er ikke momsregistreret)'}: ${kr(c.base)}. Fordelt: ${kr(c.allocated)}${rest ? html`, <strong>rest ${kr(rest)}</strong>` : ''}.</p>
  ${d.allocs.length
    ? html`<div class="table-wrap"><table class="list stackable"><thead><tr><th>Til</th><th class="num">Beløb</th><th>Handling</th><th>Lager</th><th></th></tr></thead><tbody>${d.allocs.map(
        (a) => html`<tr>
        <td class="cell-main">${TARGET_LABEL[a.target]}${a.job_number ? html` <a href="/job/${a.job_id}">${a.job_number} ${a.job_name}</a>` : ''}${a.line_name ? html`<div class="muted">Linje: ${a.line_name}</div>` : ''}${a.note ? html`<div class="muted">${a.note}</div>` : ''}</td>
        <td class="num" data-label="Beløb">${kr(a.amount)}</td>
        <td data-label="Handling">${ACTION_LABEL[a.action]}${a.pl_name ? html`<div class="muted">${a.pl_name}${a.pl_received !== null ? `, modtaget ${formatQty(a.pl_received)} ${a.pl_unit ?? ''}` : ''}</div>` : ''}${a.qty ? html`<div class="muted">${formatQty(a.qty)} ${a.product_unit ?? ''} ${a.product_name ?? ''}</div>` : ''}</td>
        <td data-label="Lager">${a.action === 'ny_modtagelse' || a.action === 'direkte_job'
          ? a.done_at
            ? html`<span class="tag tag-ok">Registreret</span>`
            : d.manager
              ? html`<form method="post" action="${d.base}/${b.id}" class="inline">${csrfField(d.csrf)}${opField(d.op)}<input type="hidden" name="do" value="udfor"><input type="hidden" name="alloc" value="${a.id}"><button class="btn btn-secondary btn-small" type="submit">${a.action === 'direkte_job' ? 'Registrér direkte køb' : 'Registrér varemodtagelse'}</button></form>`
              : html`<span class="tag tag-ready">Ikke registreret</span>`
          : html`<span class="muted">Ingen lagerpåvirkning</span>`}</td>
        <td>${d.manager && !a.done_at ? html`<form method="post" action="${d.base}/${b.id}" class="inline">${csrfField(d.csrf)}<input type="hidden" name="do" value="fjern"><input type="hidden" name="alloc" value="${a.id}"><button class="btn btn-ghost btn-small" type="submit">Fjern</button></form>` : ''}</td>
      </tr>`,
      )}</tbody></table></div>`
    : html`<p class="empty">Ikke fordelt endnu.</p>`}
  ${d.manager && b.status !== 'arkiveret'
    ? html`<form method="post" action="${d.base}/${b.id}" class="stack">
      ${csrfField(d.csrf)}<input type="hidden" name="do" value="fordel">
      <div class="fields fields-3">
        <div class="field"><label for="a-t">Til</label><select id="a-t" name="target">${Object.entries(TARGET_LABEL).map(([k, v]) => html`<option value="${k}"${sel(k === (b.job_hint ? 'job' : 'drift'))}>${v}</option>`)}</select></div>
        <div class="field"><label for="a-j">Job</label><select id="a-j" name="job_id"><option value="">Intet job</option>${d.jobs.map((j) => html`<option value="${j.id}"${sel(b.job_hint === j.id)}>${j.number} ${j.name}</option>`)}</select></div>
        <div class="field"><label for="a-a">Beløb</label><input id="a-a" name="amount" class="in-num" inputmode="decimal" value="${rest && rest > 0 ? money(rest) : ''}" required></div>
        <div class="field"><label for="a-act">Handling</label><select id="a-act" name="action">${Object.entries(ACTION_LABEL).map(([k, v]) => html`<option value="${k}"${sel(k === 'udgift')}>${v}</option>`)}</select></div>
        <div class="field"><label for="a-pl">Eksisterende køb</label><select id="a-pl" name="purchase_line_id"><option value="">Vælg (kun ved eksisterende køb)</option>${d.suggestions.map(
          (p) => html`<option value="${p.id}">${p.job_number ? `${p.job_number}: ` : 'Lager: '}${p.name} (${formatQty(p.received || p.ordered)} ${p.unit}${p.supplier_name ? `, ${p.supplier_name}` : ''})</option>`,
        )}</select>${d.suggestions.length ? html`<p class="hint">Forslag ud fra leverandør, vare og mængde. Vælg selv det rigtige.</p>` : html`<p class="hint">Ingen oplagte køb fundet.</p>`}</div>
        <div class="field"><label for="a-l">Varelinje (valgfri)</label><select id="a-l" name="line_id"><option value="">Hele bilaget</option>${d.lines.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select></div>
        <div class="field"><label for="a-p">Vare (ny modtagelse/direkte køb)</label><select id="a-p" name="product_id"><option value="">Uden varenummer</option>${d.products.map((p) => html`<option value="${p.id}">${p.sku} ${p.name}</option>`)}</select></div>
        <div class="field"><label for="a-q">Mængde i egen vares lagerenhed</label><input id="a-q" name="qty" class="in-num" inputmode="decimal"></div>
        <div class="field"><label for="a-n">Note</label><input id="a-n" name="note" maxlength="200"></div>
      </div>
      <p class="hint">Fordelingen ændrer ikke lageret. En ny varemodtagelse eller et direkte køb registreres først, når du trykker på knappen ud for fordelingen. Et køb, der allerede er modtaget, knyttes som "eksisterende" og tælles ikke igen.</p>
      <button class="btn btn-secondary" type="submit">Tilføj fordeling</button>
    </form>`
    : ''}
</section>`;
}

export function detailPage(d: DetailData): H {
  const b = d.b;
  const c = d.checks;
  const es = exportState(b);
  const act = (doName: string, label: string, cls = 'btn-secondary', extra: H | '' = '') =>
    html`<form method="post" action="${d.base}/${b.id}" class="inline">${csrfField(d.csrf)}<input type="hidden" name="do" value="${doName}">${extra}<button class="btn ${cls} btn-small" type="submit">${label}</button></form>`;
  const activeOcr = d.ocr && ['queued', 'processing'].includes(d.ocr.state);
  const oldUnavailableNote = b.reading_note.startsWith('OCR er ikke tilsluttet.');
  const canRestartOcr = d.canEdit && b.status === 'modtaget' && !b.reading_token && !activeOcr && d.allocs.length === 0;
  const readingNotice = b.reading_note && b.status === 'modtaget'
    ? oldUnavailableNote && d.ocrConfigured
      ? alert('info', html`<strong>Bilaget blev uploadet før OCR blev tilsluttet.</strong><p>${canRestartOcr
        ? 'Start en ny aflæsning for at sende originalen til OCR. Resultatet kræver din kontrol.'
        : 'Beskeden i historikken stammer fra den tidligere aflæsning. Ingen ny aflæsning er startet.'}</p>${canRestartOcr ? act('laes', 'Start ny aflæsning', 'btn-primary') : ''}`)
      : alert('info', b.reading_note)
    : '';
  return html`<div class="stack-lg">
  ${pageHead(html`<a href="${d.base}">Bilag</a> · ${bilagNo(b.id)}`, html`${b.supplier_name || DOC_TYPE_LABEL[b.doc_type]} ${bilagTag(b)}`, html`<a class="btn btn-secondary" href="${d.base}/${b.id}/visning.pdf">Digital visning (PDF)</a><a class="btn btn-ghost" href="${d.base}/${b.id}/fil?hent=1">Hent original</a>`,
    html`${DOC_TYPE_LABEL[b.doc_type]} · uploadet ${formatDateTime(b.created_at)} af ${b.uploader ?? b.uploaded_name} · ${b.file_name} · ${exportTag(es)}`)}
  ${bflash(d.flashCode, d.message)}
  ${errors(d.errs)}
  ${d.ocr && ['queued', 'processing'].includes(d.ocr.state)
    ? alert('info', html`<strong>${d.ocr.state === 'processing' ? 'OCR aflæser bilaget' : 'Bilaget er i OCR-kø'}</strong><p>Originalen er gemt. Aflæsningen kører i baggrunden, og resultatet kræver din kontrol. Retter og gemmer du oplysningerne imens, afbrydes aflæsningen.</p><p><a href="${d.base}/${b.id}">Opdatér status</a></p>`)
    : d.ocr?.state === 'failed'
      ? alert('warn', html`<strong>OCR kunne ikke afsluttes</strong><p>${d.ocr.last_error}</p><p>Originalen er bevaret. Brug Aflæs igen, eller registrér oplysningerne manuelt.</p>`)
      : d.ocr?.state === 'cancelled'
        ? alert('info', html`Aflæsningen er afbrudt, fordi bilaget er ændret. Dine ændringer er bevaret.`)
        : ''}
  ${readingNotice}
  ${b.status === 'afklaring' ? alert('warn', html`<strong>Kræver afklaring:</strong> ${b.clarify || 'Ingen begrundelse angivet.'}`) : ''}
  ${d.dupOf && !b.dup_cleared_by
    ? alert('warn', html`<strong>Mulig dublet</strong> af <a href="${d.base}/${d.dupOf.id}">${bilagNo(d.dupOf.id)}</a> (${b.dup_reason}). Intet er slået sammen. ${d.manager ? html`${act('dublet_ok', 'Ikke en dublet')} ${act('arkiver', 'Arkivér som dublet', 'btn-ghost')}` : ''}`)
    : ''}
  <div class="bilag-split">
    <section class="card stack"><h2>Originalbilag</h2>${original(d)}<p class="hint">${d.file.mime}${d.file.pages ? `, ${d.file.pages} ${d.file.pages === 1 ? 'side' : 'sider'}` : ''}, ${Math.ceil(d.file.size / 1024)} KB. Originalen ændres aldrig.</p></section>
    <section class="stack">${chatSection(d)}${digitalView(b, d.lines)}
      <div class="card stack-sm">
        <h3>Intern information</h3>
        <dl class="kv">
          <div><dt>Bilags-ID</dt><dd>${bilagNo(b.id)} (version ${b.version})</dd></div>
          <div><dt>Betaling</dt><dd>${PAYMENT_LABEL[b.payment]}${b.payment === 'medarbejder' ? html` · ${b.payer ?? (b.paid_by || 'ikke angivet')} · ${b.reimbursed_at ? `refunderet ${formatDateTime(b.reimbursed_at)}` : 'ikke refunderet'}` : ''}</dd></div>
          <div><dt>Godkendt</dt><dd>${b.approved_at ? `${formatDateTime(b.approved_at)} af ${b.approver ?? b.approved_by} (version ${b.approved_version})` : 'Nej'}</dd></div>
          <div><dt>Eksport</dt><dd>${EXPORT_LABEL[es]}${b.exported_at ? ` · version ${b.exported_version} eksporteret ${formatDateTime(b.exported_at)}` : ''}</dd></div>
          ${b.note ? html`<div><dt>Bemærkning</dt><dd>${b.note}</dd></div>` : ''}
        </dl>
      </div>
    </section>
  </div>
  <section class="card stack-sm">
    <h2>Kontrol</h2>
    ${c.errors.length ? html`<ul class="check-list err">${c.errors.map((e) => html`<li>${e}</li>`)}</ul>` : html`<p class="ok-text">Alle krav til godkendelse er opfyldt.</p>`}
    ${c.warnings.length ? html`<ul class="check-list warn">${c.warnings.map((e) => html`<li>${e}</li>`)}</ul>` : ''}
    <div class="row">
      ${d.canEdit && b.status !== 'godkendt' && !b.reading_token ? act('laes', "Aflæs igen", 'btn-ghost') : ''}
      ${d.manager && b.status !== 'arkiveret' && !(b.status === 'godkendt' && b.approved_version === b.version) ? act('godkend', 'Godkend bilag', c.errors.length ? 'btn-secondary' : 'btn-primary') : ''}
      ${d.manager && b.status !== 'afklaring' && b.status !== 'arkiveret' ? html`<form method="post" action="${d.base}/${b.id}" class="row">${csrfField(d.csrf)}<input type="hidden" name="do" value="afklaring"><input name="clarify" maxlength="300" placeholder="Hvad skal afklares?" aria-label="Hvad skal afklares"><button class="btn btn-ghost btn-small" type="submit">Kræver afklaring</button></form>` : ''}
      ${d.manager && (b.status === 'afklaring' || b.status === 'arkiveret') ? act('klar', b.status === 'arkiveret' ? 'Genåbn' : 'Afklaret') : ''}
      ${d.manager && b.status === 'godkendt' ? act('arkiver', 'Arkivér', 'btn-ghost') : ''}
      ${d.manager && b.payment === 'medarbejder' && !b.reimbursed_at && b.status === 'godkendt' ? act('refunder', 'Markér udlæg refunderet') : ''}
      ${d.canDelete ? html`<form method="post" action="${d.base}/${b.id}" class="inline" data-confirm="Slet bilaget og filen? Det kan ikke fortrydes.">${csrfField(d.csrf)}<input type="hidden" name="do" value="slet"><button class="btn btn-danger btn-small" type="submit">Slet bilag</button></form>` : ''}
    </div>
    <p class="hint">Godkendelse ændrer ikke lageret, salgspriser, overslag eller udstedte fakturaer. Den sætter kun den faktiske indkøbspris på knyttede køb.</p>
  </section>
  ${allocSection(d)}
  ${editForm(d)}
  <section class="card stack-sm"><h2>Historik</h2><ol class="timeline">${d.events.map(
    (e) => html`<li><strong>${formatDateTime(e.created_at)}</strong> · ${e.actor_name || e.actor} · v${e.version}<div>${e.text}</div></li>`,
  )}</ol></section>
</div><script src="/static/bilag-chat.js?v=2" defer></script>`;
}

// --- Eksport --------------------------------------------------------------------------------------

export interface ExportRow {
  id: number;
  scope: string;
  date_from: string;
  date_to: string;
  job_number: string | null;
  with_views: number;
  bilag_count: number;
  invoice_count: number;
  status: string;
  error: string;
  created_by: string;
  created_at: number;
}

export function exportPage(d: {
  base: string;
  csrf: string;
  op: string;
  tabs: H;
  ready: BilagListRow[];
  changed: BilagListRow[];
  invoicesReady: number;
  history: ExportRow[];
  jobs: { id: number; number: string; name: string }[];
  flashCode?: string;
  errs: string[];
}): H {
  return html`<div class="stack-lg">
  ${pageHead('Bilag', 'Eksport til bogholder', '', 'Dan en ZIP med bilag, fakturaer, kreditnotaer, betalinger og CSV-oversigter. Filen sendes ikke automatisk, og der er ingen integration til et regnskabsprogram.')}
  ${bflash(d.flashCode)}${errors(d.errs)}
  ${d.tabs}
  <div class="stats grid grid-3">
    <div class="card stat"><div class="n">${d.ready.length}</div><div class="l">Bilag klar til eksport</div></div>
    <div class="card stat"><div class="n">${d.changed.length}</div><div class="l">Ændret siden seneste eksport</div></div>
    <div class="card stat"><div class="n">${d.invoicesReady}</div><div class="l">Udstedte fakturaer/kreditnotaer ikke eksporteret</div></div>
  </div>
  <form class="card stack" method="post" action="${d.base}/eksport">
    ${csrfField(d.csrf)}${opField(d.op)}
    <h2>Ny eksport</h2>
    <div class="fields fields-3">
      <div class="field"><label for="e-from">Fra dato</label><input id="e-from" type="date" name="fra"></div>
      <div class="field"><label for="e-to">Til dato</label><input id="e-to" type="date" name="til"></div>
      <div class="field"><label for="e-job">Eller ét job</label><select id="e-job" name="job_id"><option value="">Alle job</option>${d.jobs.map((j) => html`<option value="${j.id}">${j.number} ${j.name}</option>`)}</select></div>
    </div>
    <label class="check"><input type="checkbox" name="views" value="1" checked> Medtag "Digital visning af originalbilag" som PDF</label>
    <label class="check"><input type="checkbox" name="all" value="1"> Medtag også bilag, der allerede er eksporteret</label>
    <p class="hint">Kun godkendte bilag i den godkendte version eksporteres. Bilag, der er ændret siden eksport, kommer med igen. Eksporten markerer intet som bogført.</p>
    <button class="btn btn-primary" type="submit">Dan eksport (ZIP)</button>
  </form>
  ${d.changed.length ? html`<section class="stack"><h2>Ændret siden seneste eksport</h2>${listTable(d.base, d.changed)}</section>` : ''}
  <section class="stack"><h2>Tidligere eksporter</h2>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Eksport</th><th>Omfang</th><th class="num">Bilag</th><th class="num">Fakturaer</th><th>Status</th><th></th></tr></thead>
    <tbody>${d.history.length
      ? d.history.map(
          (e) => html`<tr>
        <td class="cell-main">#${e.id} · ${formatDateTime(e.created_at)}<div class="muted">${e.created_by}</div></td>
        <td data-label="Omfang">${e.scope === 'job' ? `Job ${e.job_number ?? ''}` : `${e.date_from ? formatDay(e.date_from) : 'start'} – ${e.date_to ? formatDay(e.date_to) : 'i dag'}`}${e.with_views ? ', med digital visning' : ''}</td>
        <td class="num" data-label="Bilag">${e.bilag_count}</td><td class="num" data-label="Fakturaer">${e.invoice_count}</td>
        <td data-label="Status">${e.status === 'fejlet' ? html`<span class="tag tag-fail">Overførsel fejlet</span>${e.error ? html`<div class="muted">${e.error}</div>` : ''}` : html`<span class="tag tag-ok">Eksporteret</span>`}</td>
        <td><div class="row"><a class="btn btn-secondary btn-small" href="${d.base}/eksport/${e.id}.zip">Hent ZIP</a>${e.status !== 'fejlet'
          ? html`<form method="post" action="${d.base}/eksport/${e.id}/fejlet" class="row">${csrfField(d.csrf)}<input name="error" maxlength="200" placeholder="Hvad fejlede?" aria-label="Hvad fejlede"><button class="btn btn-ghost btn-small" type="submit">Markér overførsel fejlet</button></form>`
          : ''}</div></td>
      </tr>`,
        )
      : html`<tr><td colspan="6" class="empty">Ingen eksporter endnu.</td></tr>`}</tbody>
  </table></div></div></section>
</div>`;
}

