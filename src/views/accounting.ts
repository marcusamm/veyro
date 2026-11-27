import { html } from 'hono/html';
import { alert, csrfField, type H } from './layout';
import { formatDateTime } from '../lib/format';

const BASE = '/admin/bogfoering';
export type AccountingTab = 'bilag' | 'bank' | 'moms' | 'rapporter';

/** View contracts deliberately contain no file data, secrets or customer records. */
export interface AccountingAccountView { code: string; name: string; kind?: string; active?: number | boolean }
export interface AccountingReceiptView {
  id: number; version: number; status: string; file_name: string;
  kind: 'purchase' | 'sale' | 'purchase_credit' | 'sale_credit';
  supplier: string | null; date: string | null; currency: string | null;
  gross_minor: number | null; vat_minor: number | null; deductible_vat_minor: number | null;
  account_code: string | null; settlement_account_code?: string | null;
  base_gross_minor?: number | null; base_vat_minor?: number | null; base_deductible_vat_minor?: number | null;
  reading_source?: string | null; reading_note?: string | null; source_kind?: string; uncertain?: string | string[] | null;
  note?: string | null; bank_line_id?: number | null; journal_id?: number | null;
  created_at?: number; posted_at?: number | null; reversed?: boolean;
}
export interface AccountingBankLineView {
  id: number; date: string; description: string; merchant?: string | null;
  amount_minor: number; currency: string; account_key: string; hidden?: number | boolean;
  hidden_reason?: string | null; receipt_id?: number | null; journal_id?: number | null;
  balance_minor?: number | null;
}
export interface AccountingPreviewRowView {
  date: string; description: string; merchant?: string | null; amount_minor: number;
  currency: string; account_key: string; external_id?: string | null;
  status?: string; duplicate_status?: string; warning?: string | null;
  source_row?: number; candidate_ids?: number[];
}
export interface AccountingImportPreviewView {
  id: string | number; file_name: string; rows: AccountingPreviewRowView[];
  warnings?: string[]; errors?: string[]; can_confirm?: boolean; status?: string;
}
export interface AccountingEventView {
  action: string; actor: string; created_at: number; detail?: string | null; reason?: string | null;
}
export interface AccountingEntryView {
  id: number; date: string; description?: string; supplier?: string | null;
  receipt_id?: number | null; bank_line_id?: number | null; reversal_of?: number | null;
  reversed_by?: number | null; amount_minor?: number; debit_minor?: number; credit_minor?: number;
  actor?: string; created_at?: number;
}
export interface AccountingReportView {
  sales_vat_minor: number; purchase_vat_minor: number; net_vat_minor: number;
  income_minor: number; expenses_minor: number; result_minor: number;
  accounts: { code: string; name: string; kind?: string; amount_minor: number; debit_minor?: number; credit_minor?: number }[];
  entries: AccountingEntryView[];
}
export interface AccountingPageData {
  csrf: string;
  tab: AccountingTab;
  view?: 'overview' | 'upload' | 'receipt' | 'import';
  error?: string | null; notice?: string | null;
  receipts?: AccountingReceiptView[];
  receipt?: AccountingReceiptView;
  accounts?: AccountingAccountView[];
  bank_lines?: AccountingBankLineView[];
  bank_mode?: 'missing' | 'all' | 'removed';
  bank_totals?: { account_key: string; currency: string; amount_minor: number; line_count?: number }[];
  refund_pairs?: { purchase: AccountingBankLineView; refund: AccountingBankLineView; ambiguous?: boolean }[];
  linked_bank_line?: AccountingBankLineView | null;
  upload_bank_line_id?: number | null;
  events?: AccountingEventView[];
  import_preview?: AccountingImportPreviewView;
  period?: { from: string; to: string };
  report?: AccountingReportView;
  receipt_filter?: string;
  max_file_mb?: number;
}

const amountInput = (n: number | null | undefined) => n == null ? '' : (n / 100).toFixed(2).replace('.', ',');
const money = (n: number | null | undefined, currency = 'DKK', signed = false) => {
  if (n == null) return 'Ikke udfyldt';
  const value = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n) / 100);
  return `${n < 0 ? '−' : signed && n > 0 ? '+' : ''}${value} ${currency === 'DKK' ? 'kr.' : currency}`;
};
const day = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('.') : value || 'Ikke udfyldt';
const selected = (value: boolean) => value ? html` selected` : '';
const KIND_LABEL: Record<AccountingReceiptView['kind'], string> = { purchase: 'Køb', sale: 'Salg', purchase_credit: 'Kreditnota fra leverandør', sale_credit: 'Kreditnota til kunde' };
const STATUS_LABEL: Record<string, string> = { draft: 'Kladde', posted: 'Bogført', reversed: 'Tilbageført' };
const ACTION_LABEL: Record<string, string> = {
  created: 'Bilag uploadet', uploaded: 'Bilag uploadet', updated: 'Kladde rettet', reread: 'Aflæst igen', read: 'Bilag aflæst',
  posted: 'Godkendt og bogført', reversed: 'Postering tilbageført', linked: 'Banklinje tilknyttet', unlinked: 'Banklinje frigjort',
  hidden: 'Fjernet fra mangelliste', restored: 'Gendannet på mangelliste', imported: 'Banklinjer importeret',
  draft_saved: 'Kladde gemt', draft_updated: 'Kladde rettet', bank_linked: 'Banklinje tilknyttet', bank_unlinked: 'Banklinje frigjort',
  receipt_uploaded: 'Bilag uploadet', receipt_read: 'Bilag aflæst', receipt_reread: 'Aflæst igen', receipt_posted: 'Godkendt og bogført',
  journal_reversed: 'Postering tilbageført', correction_draft: 'Rettelseskladde oprettet', bank_hidden: 'Fjernet fra mangelliste', bank_restored: 'Gendannet',
  correction_draft_created: 'Rettelseskladde oprettet', correction_of: 'Rettelse af tidligere bilag', correction_linked: 'Banklinje flyttet til rettelseskladde',
  receipt_linked: 'Bilag tilknyttet', receipt_unlinked: 'Bilag frigjort', confirmed: 'Bankimport bekræftet',
};

export function accountingPage(d: AccountingPageData): H {
  const tab = d.tab;
  const tabs: [AccountingTab, string][] = [['bilag', 'Bilag'], ['bank', 'Bankafstemning'], ['moms', 'Moms'], ['rapporter', 'Rapporter']];
  return html`<link rel="stylesheet" href="${BASE}/assets.css">
  <script src="${BASE}/assets.js" defer></script>
  <div class="accounting stack-lg">
    <header class="acct-heading"><div><p class="eyebrow">Veyro · Internt regnskab</p><h1>Bogføring<span class="acct-title-dot" aria-hidden="true">.</span></h1><p class="lead">Fra originalbilag til afstemt regnskab.</p></div><span class="acct-shared">Fælles regnskab</span></header>
    <div class="acct-topbar"><nav class="acct-tabs" aria-label="Bogføring">${tabs.map(([key, name]) => html`<a href="${BASE}?tab=${key}"${key === tab ? html` aria-current="page"` : ''}>${name}</a>`)}</nav><a class="btn btn-primary acct-upload" href="${BASE}/bilag/ny">Upload bilag</a></div>
    ${d.error ? alert('err', d.error) : ''}${d.notice ? alert('ok', d.notice) : ''}
    ${d.view === 'upload' ? uploadPage(d) : d.view === 'receipt' && d.receipt ? receiptPage(d, d.receipt) : d.import_preview ? importPreview(d, d.import_preview) : tab === 'bank' ? bankPage(d) : tab === 'moms' ? vatPage(d) : tab === 'rapporter' ? reportPage(d) : receiptsPage(d)}
  </div>`;
}

function uploadPage(d: AccountingPageData): H {
  return html`<section class="acct-section acct-upload-panel"><div><p class="eyebrow">Originalen først</p><h2>Upload bilag</h2><p>Gem kvitteringen eller fakturaen, og kontrollér derefter den aflæste kladde.</p>
  ${d.linked_bank_line ? html`<div class="acct-bank-summary"><strong>${d.linked_bank_line.description}</strong><span>${day(d.linked_bank_line.date)} · ${money(d.linked_bank_line.amount_minor, d.linked_bank_line.currency, true)}</span><span>${d.linked_bank_line.account_key}</span></div>` : ''}</div>
  <form method="post" action="${BASE}/bilag" enctype="multipart/form-data" class="stack">
    ${csrfField(d.csrf)}${d.upload_bank_line_id ? html`<input type="hidden" name="bank_line_id" value="${d.upload_bank_line_id}">` : ''}
    <div class="field acct-file"><label for="receipt-file">Vælg originalbilag</label><input id="receipt-file" type="file" name="file" required accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"><p class="hint">PDF, JPG eller PNG. Højst ${d.max_file_mb ?? 10} MB. Filen opbevares privat og uændret.</p></div>
    <div class="field"><label for="receipt-kind">Bilagstype</label><select id="receipt-kind" name="kind">${Object.entries(KIND_LABEL).map(([key, value]) => html`<option value="${key}">${value}</option>`)}</select></div>
    <p class="hint">PDF-tekst aflæses først. Scanninger og billeder sendes til den tilknyttede OCR-tjeneste. En kladde er endnu ikke en postering.</p>
    <div class="row"><button class="btn btn-primary" type="submit">Upload og aflæs</button><a class="btn btn-secondary" href="${BASE}?tab=bilag">Tilbage til bilag</a></div>
  </form></section>`;
}

function receiptsPage(d: AccountingPageData): H {
  const rows = d.receipts ?? [];
  return html`<section class="acct-section"><div class="acct-section-head"><div><h2>Bilag</h2><p class="muted">Kontrollér kladden, vælg konto, og godkend den til bogføring.</p></div><form method="get" action="${BASE}" class="acct-filter"><input type="hidden" name="tab" value="bilag"><label class="visually-hidden" for="receipt-status">Bilagsstatus</label><select id="receipt-status" name="status"><option value="">Alle bilag</option><option value="draft"${selected(d.receipt_filter === 'draft')}>Kladder</option><option value="posted"${selected(d.receipt_filter === 'posted')}>Bogførte</option></select><button class="btn btn-secondary btn-small" type="submit">Vis</button></form></div>
    ${rows.length ? html`<div class="table-wrap"><table class="responsive acct-table"><thead><tr><th scope="col">Bilag</th><th scope="col">Leverandør / kunde</th><th scope="col">Dato</th><th scope="col" class="num">Beløb</th><th scope="col">Status</th><th scope="col">Banklinje</th></tr></thead><tbody>${rows.map(r => html`<tr>
      <td data-label="Bilag"><a class="acct-main-link" href="${BASE}/bilag/${r.id}">B${r.id}</a><span class="acct-sub">${KIND_LABEL[r.kind]}</span></td>
      <td data-label="Leverandør / kunde"><a href="${BASE}/bilag/${r.id}">${r.supplier || 'Åbn og udfyld kladden'}</a><span class="acct-sub acct-filename">${r.file_name}</span></td>
      <td data-label="Dato">${day(r.date)}</td><td data-label="Beløb" class="num">${money(r.gross_minor, r.currency || 'DKK')}</td>
      <td data-label="Status"><span class="badge ${r.status === 'posted' ? 'b-ok' : 'b-neutral'}">${r.reversed ? 'Tilbageført' : STATUS_LABEL[r.status] ?? r.status}</span></td>
      <td data-label="Banklinje">${r.bank_line_id ? html`<a href="${BASE}?tab=bank&vis=all#bank-${r.bank_line_id}">#${r.bank_line_id}</a>` : 'Ikke tilknyttet'}</td>
    </tr>`)}</tbody></table></div>` : d.receipt_filter ? html`<div class="acct-empty"><h3>${d.receipt_filter === 'draft' ? 'Ingen kladder' : 'Ingen bogførte bilag'}</h3><p>Der er ingen bilag med denne status.</p><a href="${BASE}?tab=bilag">Vis alle bilag</a></div>` : html`<div class="acct-empty"><h3>Her samler I originalerne</h3><p>Upload det første bilag, eller begynd med et bankudtog for at se, hvilke bilag der mangler.</p><div class="row"><a class="btn btn-primary" href="${BASE}/bilag/ny">Upload bilag</a><a class="btn btn-secondary" href="${BASE}?tab=bank">Importér bankfil</a></div></div>`}
  </section>`;
}

function accountPicker(accounts: AccountingAccountView[], code: string | null, settlement = false): H {
  const id = settlement ? 'settlement-account' : 'account-code';
  return html`<div class="field acct-account-picker" data-account-picker><label for="${id}">${settlement ? 'Betalingskonto / modkonto' : 'Konto'}</label>
    <input id="${id}" name="${settlement ? 'settlement_account_code' : 'account_code'}" type="text" value="${code ?? ''}" list="${id}-options" autocomplete="off" placeholder="${settlement ? 'Søg fx 5820 eller bank' : 'Søg fx 7300 eller webhosting'}" required aria-describedby="${id}-help">
    <datalist id="${id}-options">${accounts.filter(a => a.active !== false && a.active !== 0).map(a => html`<option value="${a.code}">${a.code} · ${a.name}</option>`)}</datalist>
    <div class="acct-account-results" data-account-results hidden></div><p id="${id}-help" class="hint">${settlement ? 'Vælg kontoen, der afregner købet eller salget.' : 'Søg på kontonummer eller navn. Vælg en konto fra Veyros kontoplan.'}</p>
  </div>`;
}

function receiptPage(d: AccountingPageData, r: AccountingReceiptView): H {
  const posted = r.status !== 'draft';
  const readingPending = !posted && r.reading_source === 'pending';
  const uncertainty = Array.isArray(r.uncertain) ? r.uncertain : (() => { try { const values = JSON.parse(r.uncertain || '[]'); return Array.isArray(values) ? values as string[] : []; } catch { return []; } })();
  const account = (d.accounts ?? []).find(a => a.code === r.account_code);
  return html`<div class="acct-section-head"><div><a class="small" href="${BASE}?tab=bilag">Alle bilag</a><h2>Bilag B${r.id}</h2><p class="muted acct-filename">${r.file_name}</p></div><div class="row"><span class="badge ${posted ? 'b-ok' : 'b-neutral'}">${r.reversed ? 'Tilbageført' : posted ? 'Bogført' : 'Kladde'}</span><a class="btn btn-secondary" href="${BASE}/bilag/${r.id}/original" target="_blank" rel="noopener">Åbn originalbilag</a></div></div>
  ${r.reading_note && !posted ? alert('info', r.reading_note) : ''}
  ${readingPending ? alert('warn', 'Den første aflæsning er ikke færdig. Genindlæs siden, eller vælg Aflæs igen, hvis den blev afbrudt. Bilaget kan først bogføres, når aflæsningen er afsluttet.') : ''}
  ${uncertainty.length && !posted ? alert('warn', 'Nogle felter kunne ikke aflæses sikkert. Kontrollér dem mod originalen før bogføring.') : ''}
  <div class="acct-document-grid"><section class="acct-section">
    ${posted ? html`<h3>Bogførte oplysninger</h3><dl class="acct-details"><div><dt>Type</dt><dd>${KIND_LABEL[r.kind]}</dd></div><div><dt>Leverandør / kunde</dt><dd>${r.supplier}</dd></div><div><dt>Bilagsdato</dt><dd>${day(r.date)}</dd></div><div><dt>Beløb inklusive moms</dt><dd>${money(r.gross_minor, r.currency || 'DKK')}</dd></div><div><dt>Angivet moms</dt><dd>${money(r.vat_minor, r.currency || 'DKK')}</dd></div><div><dt>Fradragsberettiget købsmoms</dt><dd>${money(r.deductible_vat_minor, r.currency || 'DKK')}</dd></div><div><dt>Konto</dt><dd>${r.account_code}${account ? ` · ${account.name}` : ''}</dd></div>${r.currency && r.currency !== 'DKK' ? html`<div><dt>Bogført beløb i DKK</dt><dd>${money(r.base_gross_minor)}</dd></div>` : ''}</dl>${r.note ? html`<p class="prewrap">${r.note}</p>` : ''}
      <p class="hint">En bogført post ændres ikke i stilhed. En rettelse sker med en begrundet tilbageførsel og en ny kladde med spor til originalen.</p>
      ${r.reversed ? html`<form method="post" action="${BASE}/bilag/${r.id}/rettelseskladde">${csrfField(d.csrf)}<button class="btn btn-primary" type="submit">Opret rettelseskladde</button></form>` : ''}
      ${r.journal_id && !r.reversed ? html`<details class="acct-correction"><summary>Ret en bogført post</summary><form method="post" action="${BASE}/postering/${r.journal_id}/tilbagefoer" class="stack" data-confirm="Tilbagefør posteringen med en ny, modsat postering? Originalen og historikken bevares.">${csrfField(d.csrf)}<div class="field"><label for="reversal-date">Dato for tilbageførsel</label><input id="reversal-date" name="date" type="date" required value="${d.period?.to ?? r.date ?? ''}"></div><div class="field"><label for="reversal-reason">Begrundelse</label><textarea id="reversal-reason" name="reason" required maxlength="1000" rows="3" placeholder="Beskriv, hvad der skal rettes"></textarea></div><button class="btn btn-secondary" type="submit">Tilbagefør postering</button></form></details>` : ''}
    ` : html`<div class="acct-section-head"><h3>Kontrollér kladden</h3><form method="post" action="${BASE}/bilag/${r.id}/aflaes">${csrfField(d.csrf)}<input type="hidden" name="version" value="${r.version}"><button class="btn btn-secondary btn-small" type="submit">Aflæs igen</button></form></div>
    <form method="post" action="${BASE}/bilag/${r.id}/gem" class="stack acct-receipt-form">
      ${csrfField(d.csrf)}<input type="hidden" name="version" value="${r.version}">
      <div class="acct-fields"><div class="field"><label for="kind">Bilagstype</label><select id="kind" name="kind">${Object.entries(KIND_LABEL).map(([key, value]) => html`<option value="${key}"${selected(r.kind === key)}>${value}</option>`)}</select></div><div class="field"><label for="supplier">Leverandør / kunde</label><input id="supplier" name="supplier" maxlength="200" required value="${r.supplier ?? ''}" autocomplete="organization"></div>
      <div class="field"><label for="document-date">Bilagsdato</label><input id="document-date" name="document_date" type="date" required value="${r.date ?? ''}"></div><div class="field"><label for="currency">Valuta</label><input id="currency" name="currency" maxlength="3" pattern="[A-Za-z]{3}" required value="${r.currency ?? ''}" placeholder="DKK" autocomplete="off" data-receipt-currency></div>
      <div class="field"><label for="amount">Beløb inklusive moms</label><input id="amount" name="amount" inputmode="decimal" maxlength="18" required value="${amountInput(r.gross_minor)}" placeholder="85,00"><p class="hint">Skriv et positivt beløb. Kreditnotaer angives med bilagstypen.</p></div><div class="field"><label for="vat-amount">Angivet moms</label><input id="vat-amount" name="vat_amount" inputmode="decimal" maxlength="18" required value="${amountInput(r.vat_minor)}" placeholder="Udfyld efter kontrol"><p class="hint">Tomt betyder ukendt. Skriv kun 0,00, når du har kontrolleret, at der ikke er moms.</p></div>
      <div class="field"><label for="deductible-vat">Fradragsberettiget købsmoms</label><input id="deductible-vat" name="deductible_vat_amount" inputmode="decimal" maxlength="18" required value="${amountInput(r.deductible_vat_minor)}" placeholder="Udfyld efter kontrol"><p class="hint">Skriv den del af momsen, der kan fradrages. For salg: 0,00.</p></div>${accountPicker(d.accounts ?? [], r.account_code)}${accountPicker(d.accounts ?? [], r.settlement_account_code ?? '5820', true)}</div>
      <fieldset class="acct-foreign stack" data-foreign-fields${!r.currency || r.currency === 'DKK' ? html` hidden` : ''}><legend>Omregning til regnskabets valuta</legend><p class="hint">Bogføringen føres i DKK. Angiv de dokumenterede DKK-beløb; der gættes ikke en valutakurs.</p><div class="acct-fields"><div class="field"><label for="base-amount">Beløb inklusive moms i DKK</label><input id="base-amount" name="base_amount" inputmode="decimal" maxlength="18" value="${amountInput(r.base_gross_minor)}"></div><div class="field"><label for="base-vat">Angivet moms i DKK</label><input id="base-vat" name="base_vat_amount" inputmode="decimal" maxlength="18" value="${amountInput(r.base_vat_minor)}"></div><div class="field"><label for="base-deductible">Fradragsberettiget købsmoms i DKK</label><input id="base-deductible" name="base_deductible_vat_amount" inputmode="decimal" maxlength="18" value="${amountInput(r.base_deductible_vat_minor)}"></div></div></fieldset>
      <div class="field"><label for="receipt-note">Beskrivelse / intern note</label><textarea id="receipt-note" name="description" maxlength="1000" rows="3">${r.note ?? ''}</textarea></div>
      <div class="acct-approval"><p>Kontrollér original, konto og moms. Først ved godkendelse kommer beløbet med i regnskabet.</p><div class="row"><button class="btn btn-secondary" type="submit" formnovalidate>Gem kladde</button><button class="btn btn-primary" type="submit" formaction="${BASE}/bilag/${r.id}/bogfoer"${readingPending ? html` disabled` : ''}>${readingPending ? 'Afventer aflæsning' : 'Godkend og bogfør'}</button></div></div>
    </form>`}
  </section><aside class="acct-aside stack"><section class="acct-section"><h3>Banktilknytning</h3>${d.linked_bank_line ? html`<div class="acct-bank-summary"><a href="${BASE}?tab=bank&vis=all#bank-${d.linked_bank_line.id}">${d.linked_bank_line.description}</a><span>${day(d.linked_bank_line.date)} · ${money(d.linked_bank_line.amount_minor, d.linked_bank_line.currency, true)}</span><span>${d.linked_bank_line.account_key}</span></div><p class="hint">Banklinjen er dokumentation for betalingen. Udgift og moms tælles kun fra den bogførte post.</p>` : html`<p class="muted">Ingen banklinje er tilknyttet.</p><a href="${BASE}?tab=bank">Find betalingen i banken</a>`}</section>
  <section class="acct-section"><h3>Historik</h3>${historyList(d.events ?? [])}</section></aside></div>`;
}

const HISTORY_FIELDS: Record<string, string> = {
  kind: 'Bilagstype', supplier: 'Leverandør / kunde', date: 'Bilagsdato', currency: 'Valuta',
  gross_minor: 'Beløb inkl. moms', vat_minor: 'Angivet moms', deductible_vat_minor: 'Fradragsberettiget købsmoms',
  base_gross_minor: 'Beløb inkl. moms i DKK', base_vat_minor: 'Angivet moms i DKK', base_deductible_vat_minor: 'Fradragsberettiget købsmoms i DKK',
  account_code: 'Konto', settlement_account_code: 'Betalingskonto', note: 'Intern note',
};
function historyDetails(event: AccountingEventView): string[] {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let detail: Record<string, unknown> = {};
  try { detail = object(JSON.parse(event.detail || '{}')); } catch { /* Old unstructured details remain in the database audit. */ }
  const lines: string[] = [];
  const plain = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 600) : typeof value === 'number' && Number.isFinite(value) ? String(value) : 'Ikke udfyldt';
  const currency = (values: Record<string, unknown>) => typeof values.currency === 'string' && /^[A-Z]{3}$/.test(values.currency) ? values.currency : 'valuta ikke angivet';
  const value = (key: string, values: Record<string, unknown>) => {
    const item = values[key];
    if (key.endsWith('_minor')) return typeof item === 'number' && Number.isSafeInteger(item) ? money(item, key.startsWith('base_') ? 'DKK' : currency(values)) : 'Ikke udfyldt';
    if (key === 'kind') return typeof item === 'string' && Object.hasOwn(KIND_LABEL, item) ? KIND_LABEL[item as keyof typeof KIND_LABEL] : 'Ikke udfyldt';
    if (key === 'date') return day(typeof item === 'string' ? item : null);
    return plain(item);
  };
  const before = object(detail.before), after = object(detail.after);
  for (const [key, label] of Object.entries(HISTORY_FIELDS)) {
    if (Object.hasOwn(after, key) && before[key] !== after[key]) lines.push(`${label}: ${value(key, before)} → ${value(key, after)}`);
  }
  const reason = event.reason || (typeof detail.reason === 'string' ? detail.reason : '');
  if (reason) lines.push(`Begrundelse: ${plain(reason)}`);
  const references: [string, string][] = [['bank_line_id','Banklinje'], ['journal_id','Postering'], ['receipt_id','Bilag'], ['original','Oprindeligt bilag'], ['previous_receipt_id','Tidligere bilag']];
  for (const [key,label] of references) if (typeof detail[key] === 'number' && Number.isSafeInteger(detail[key]) && detail[key] > 0) lines.push(`${label} #${detail[key]}`);
  if (typeof detail.date === 'string') lines.push(`Dato: ${day(detail.date)}`);
  if (typeof detail.base_gross_minor === 'number' && Number.isSafeInteger(detail.base_gross_minor)) lines.push(`Bogført beløb: ${money(detail.base_gross_minor)}`);
  if (typeof detail.base_vat_minor === 'number' && Number.isSafeInteger(detail.base_vat_minor)) lines.push(`Angivet moms i DKK: ${money(detail.base_vat_minor)}`);
  if (typeof detail.deductible_vat_minor === 'number' && Number.isSafeInteger(detail.deductible_vat_minor)) lines.push(`Fradragsberettiget købsmoms i DKK: ${money(detail.deductible_vat_minor)}`);
  if (Array.isArray(detail.pair)) {
    const ids = detail.pair.filter(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
    if (ids.length === 2) lines.push(`Samlet med banklinjerne #${ids[0]} og #${ids[1]}`);
  }
  return lines;
}
function historyList(events: AccountingEventView[]): H {
  return events.length ? html`<ol class="acct-history">${events.map(e => html`<li><strong>${Object.hasOwn(ACTION_LABEL, e.action) ? ACTION_LABEL[e.action] : 'Hændelse registreret'}</strong><span>${formatDateTime(e.created_at)}</span><span class="acct-actor">${e.actor}</span>${historyDetails(e).map(line => html`<p>${line}</p>`)}</li>`)}</ol>` : html`<p class="muted">Ingen ændringer registreret endnu.</p>`;
}

function importForm(d: AccountingPageData): H {
  return html`<details class="acct-import"${!(d.bank_lines?.length) ? html` open` : ''}><summary>Importér Revolut-bankfil</summary><form method="post" action="${BASE}/bank/import" enctype="multipart/form-data" class="stack">
    ${csrfField(d.csrf)}<div class="acct-fields"><div class="field acct-field-wide"><label for="bank-file">Bankfil</label><input id="bank-file" name="file" type="file" required accept="text/csv,application/pdf,.csv,.pdf"><p class="hint">Revolut-CSV eller understøttet transaktionsudtog som PDF. Højst ${d.max_file_mb ?? 10} MB. Du ser altid linjerne, før du importerer.</p></div><div class="field"><label for="bank-account">Bankkonto, hvis den mangler i filen</label><input id="bank-account" name="account" required maxlength="120" placeholder="Fx Revolut DKK eller kontoens IBAN"><p class="hint">Filens konto eller IBAN bruges, hvis den er angivet. Ellers bruges denne identifikation. Brug samme identifikation på tværs af CSV og PDF.</p></div><div class="field"><label for="bank-currency">Valuta, hvis den mangler i filen</label><input id="bank-currency" name="currency" pattern="[A-Za-z]{3}" maxlength="3" placeholder="Fx DKK"></div></div>
    <div class="row"><button class="btn btn-primary" type="submit">Vis forhåndsvisning</button><span class="hint">Import af banklinjer bogfører ikke udgifter eller moms.</span></div>
  </form></details>`;
}

function bankPage(d: AccountingPageData): H {
  const mode = d.bank_mode ?? 'missing';
  const rows = d.bank_lines ?? [];
  return html`${importForm(d)}
  ${(d.bank_totals ?? []).length ? html`<div class="acct-bank-totals">${d.bank_totals!.map(t => html`<div><span>${t.account_key} · ${t.currency}</span><strong>${money(t.amount_minor, t.currency, true)}</strong><small>Sum af importerede bevægelser${t.line_count != null ? ` · ${t.line_count} linjer` : ''}</small></div>`)}</div><p class="hint">Summen er ikke en beregnet banksaldo. Fjernede linjer bliver i bankhistorikken og i summen.</p>` : ''}
  <section class="acct-section"><div class="acct-section-head"><div><h2>${mode === 'removed' ? 'Fjernede linjer' : mode === 'all' ? 'Bankhistorik' : 'Betalinger, der mangler bilag'}</h2><p class="muted">${mode === 'removed' ? 'Gendan en linje, hvis den skal tilbage på mangellisten.' : mode === 'all' ? 'Alle importerede bevægelser, også refunderinger og fjernede linjer.' : 'Upload originalen, eller tilknyt et bilag, I allerede har gemt.'}</p></div><a class="btn btn-secondary btn-small" href="${BASE}/bank/mangelliste.csv">Eksportér mangelliste</a></div>
    <nav class="acct-filters" aria-label="Banklinjer">${([['missing', 'Mangler bilag'], ['all', 'Alle banklinjer'], ['removed', 'Fjernede linjer']] as const).map(([key, label]) => html`<a href="${BASE}?tab=bank&vis=${key}"${key === mode ? html` aria-current="page"` : ''}>${label}</a>`)}</nav>
    ${rows.length ? html`<div class="acct-bank-list">${rows.map(line => bankLine(d, line, mode))}</div>` : html`<div class="acct-empty"><h3>${mode === 'removed' ? 'Ingen fjernede linjer' : mode === 'all' ? 'Ingen banklinjer endnu' : 'Ingen manglende bilag på listen'}</h3><p>${mode === 'all' ? 'Importér en bankfil for at komme i gang.' : mode === 'removed' ? 'Linjer, der fjernes fra mangellisten, kan gendannes her.' : 'Efter en import vises udgående betalinger uden et tilknyttet bilag her.'}</p></div>`}
  </section>${mode !== 'removed' ? refundPairs(d) : ''}`;
}

function bankLine(d: AccountingPageData, line: AccountingBankLineView, mode: string): H {
  const eligible = !line.hidden && line.amount_minor < 0 && !line.receipt_id && !line.journal_id;
  const receipts = (d.receipts ?? []).filter(r => {
    if (r.bank_line_id || r.reversed || r.source_kind === 'multi_bank_statement') return false;
    if (r.currency && r.currency !== line.currency) return false;
    const outgoing = r.kind === 'purchase' || r.kind === 'sale_credit';
    if (outgoing !== (line.amount_minor < 0)) return false;
    return r.gross_minor == null || (outgoing ? -r.gross_minor : r.gross_minor) === line.amount_minor;
  });
  return html`<article class="acct-bank-line" id="bank-${line.id}"><div class="acct-bank-main"><div><time datetime="${line.date}" class="acct-date">${day(line.date)}</time><h3>${line.description}</h3><p class="acct-sub">${line.account_key} · ${line.currency} · #${line.id}${line.hidden ? ' · Fjernet fra mangelliste' : ''}</p>${line.hidden_reason ? html`<p class="hint">${line.hidden_reason}</p>` : ''}</div><strong class="acct-bank-amount${line.amount_minor > 0 ? ' acct-positive' : ''}">${money(line.amount_minor, line.currency, true)}</strong></div>
    <div class="acct-bank-actions">${line.receipt_id ? html`<a class="btn btn-secondary btn-small" href="${BASE}/bilag/${line.receipt_id}">Åbn bilag B${line.receipt_id}</a><span class="hint">${line.journal_id ? 'Bogført én gang via bilaget' : 'Bilag tilknyttet · afventer bogføring'}</span>` : ''}
    ${eligible ? html`<a class="btn btn-secondary btn-small" href="${BASE}/bilag/ny?bank=${line.id}">Upload originalbilag</a><details class="acct-attach"><summary>Tilknyt eksisterende bilag</summary><form method="post" action="${BASE}/bank/${line.id}/tilknyt" class="stack">${csrfField(d.csrf)}<div class="field"><label for="attach-${line.id}">Vælg bilag</label><select id="attach-${line.id}" name="receipt_id" required><option value="">Vælg et bilag</option>${receipts.map(r => html`<option value="${r.id}">B${r.id} · ${r.supplier || r.file_name} · ${money(r.gross_minor, r.currency || line.currency)}</option>`)}</select>${receipts.length ? '' : html`<p class="hint">Ingen ledige bilag passer til beløb, valuta og betalingens retning. Upload originalen, eller kontrollér en eksisterende kladde.</p>`}</div><button class="btn btn-primary btn-small" type="submit"${receipts.length ? '' : html` disabled`}>Tilknyt bilag</button></form></details><form method="post" action="${BASE}/bank/${line.id}/fjern">${csrfField(d.csrf)}<input type="hidden" name="reason" value="Privat køb / ikke bilagspligtig"><button class="acct-text-button" type="submit">Fjern fra liste</button></form>` : ''}
    ${line.hidden || mode === 'removed' ? html`<form method="post" action="${BASE}/bank/${line.id}/gendan">${csrfField(d.csrf)}<button class="btn btn-secondary btn-small" type="submit">Gendan</button></form>` : ''}
    ${!line.receipt_id && !eligible && !line.hidden ? html`<span class="hint">${line.amount_minor >= 0 ? 'Indgående bevægelse · vises i bankhistorikken' : 'Allerede bogført'}</span>` : ''}</div>
  </article>`;
}

function refundPairs(d: AccountingPageData): H | '' {
  const pairs = d.refund_pairs ?? [];
  if (!pairs.length) return '';
  return html`<section class="acct-section"><div class="acct-section-head"><div><h2>Mulige køb og refunderinger</h2><p class="muted">Samme forhandler, konto og valuta. Beløbene udligner hinanden. Vælg kun par, der hører sammen.</p></div></div><div class="acct-refund-pairs">${pairs.map(({purchase, refund, ambiguous}) => html`<article class="acct-refund-pair"><div><h3>${purchase.merchant || purchase.description}</h3><p class="acct-sub">${purchase.account_key} · ${purchase.currency}</p>${ambiguous ? html`<p class="acct-uncertain">Flere match er mulige. Kontrollér dato og beskrivelse, og vælg det rigtige par.</p>` : ''}</div><div class="acct-pair-lines"><div><span>${day(purchase.date)} · ${purchase.description} <small>#${purchase.id}</small></span><strong>${money(purchase.amount_minor, purchase.currency, true)}</strong></div><div><span>${day(refund.date)} · ${refund.description} <small>#${refund.id}</small></span><strong>${money(refund.amount_minor, refund.currency, true)}</strong></div></div><form method="post" action="${BASE}/bank/fjern-par">${csrfField(d.csrf)}<input type="hidden" name="line_id" value="${purchase.id}"><input type="hidden" name="refund_id" value="${refund.id}"><input type="hidden" name="reason" value="Køb og fuld refundering"><button class="btn btn-secondary btn-small" type="submit">Fjern begge linjer</button></form></article>`)}</div><p class="hint">Linjerne bevares under Fjernede linjer. Handlingen ændrer hverken banksaldo, bogførte poster eller moms.</p></section>`;
}

function importPreview(d: AccountingPageData, p: AccountingImportPreviewView): H {
  const confirmed = p.status === 'confirmed';
  const blocked = p.can_confirm === false || !p.rows.length || (p.errors?.length ?? 0) > 0 || p.rows.some(r => r.duplicate_status === 'conflict');
  return html`<section class="acct-section"><div class="acct-section-head"><div><p class="eyebrow">${confirmed ? 'Importeret' : 'Før import'}</p><h2>${confirmed ? 'Bankimport gennemført' : 'Kontrollér banklinjerne'}</h2><p class="muted acct-filename">${p.file_name} · ${p.rows.length} aflæste linjer</p></div><a class="btn btn-secondary btn-small" href="${BASE}/bank/import/${p.id}/original" target="_blank" rel="noopener">Åbn originalfil</a></div>
  ${(p.errors ?? []).map(e => alert('err', e))}${(p.warnings ?? []).map(w => alert('warn', w))}
  <div class="table-wrap"><table class="responsive acct-table"><caption class="visually-hidden">Forhåndsvisning af bankimport. Minus er penge ud, plus er penge ind.</caption><thead><tr><th scope="col">Dato</th><th scope="col">Beskrivelse</th><th scope="col" class="num">Beløb</th><th scope="col">Valuta</th><th scope="col">Konto</th><th scope="col">Kontrol</th></tr></thead><tbody>${p.rows.map((r, i) => html`<tr><td data-label="Dato">${day(r.date)}</td><td data-label="Beskrivelse">${r.description}${r.external_id ? html`<span class="acct-sub">${r.external_id}</span>` : ''}</td><td class="num" data-label="Beløb">${money(r.amount_minor, r.currency, true)}</td><td data-label="Valuta">${r.currency}</td><td data-label="Konto">${r.account_key}</td><td data-label="Kontrol">${confirmed ? html`<span class="badge b-ok">Behandlet</span>` : r.duplicate_status === 'duplicate' || r.duplicate_status === 'existing' ? html`<span class="badge b-neutral">Allerede importeret</span>` : r.duplicate_status === 'conflict' ? html`<span class="badge b-err">Konflikt · kan ikke importeres</span>` : r.duplicate_status === 'review' || r.duplicate_status === 'ambiguous' ? html`<div class="field"><label for="resolution-${r.source_row ?? i}">Mulig dublet · vælg</label><select id="resolution-${r.source_row ?? i}" name="resolution_${r.source_row ?? i}" form="bank-confirm" required><option value="">Vælg efter kontrol</option>${(r.candidate_ids ?? []).map(id => html`<option value="${id}">Allerede importeret som banklinje #${id}</option>`)}<option value="new">Ny, selvstændig transaktion</option></select>${(r.candidate_ids ?? []).map(id => html`<a class="acct-sub" href="${BASE}?tab=bank&vis=all#bank-${id}" target="_blank" rel="noopener">Se banklinje #${id}</a>`)}</div>` : r.status && r.status !== 'completed' ? r.status : html`<span class="badge b-ok">Klar</span>`}${r.warning ? html`<span class="acct-sub">${r.warning}</span>` : ''}</td></tr>`)}</tbody></table></div>
  <div class="acct-approval"><p>Der importeres kun bankhistorik. Udgift og moms oprettes først, når et bilag godkendes og bogføres.</p>${confirmed ? html`<a class="btn btn-primary" href="${BASE}?tab=bank">Åbn bankafstemning</a>` : html`<form id="bank-confirm" method="post" action="${BASE}/bank/import/${p.id}/bekraeft" class="row">${csrfField(d.csrf)}<button class="btn btn-primary" type="submit"${blocked ? html` disabled` : ''}>Bekræft import</button><a class="btn btn-secondary" href="${BASE}?tab=bank">Annuller</a></form>`}</div></section>`;
}

function periodForm(d: AccountingPageData): H {
  return html`<form method="get" action="${BASE}" class="acct-period"><input type="hidden" name="tab" value="${d.tab}"><div class="field"><label for="period-from">Fra og med</label><input type="date" id="period-from" name="from" required value="${d.period?.from ?? ''}"></div><div class="field"><label for="period-to">Til og med</label><input type="date" id="period-to" name="to" required value="${d.period?.to ?? ''}"></div><button class="btn btn-secondary" type="submit">Vis periode</button></form>`;
}

const emptyReport = (): AccountingReportView => ({sales_vat_minor:0,purchase_vat_minor:0,net_vat_minor:0,income_minor:0,expenses_minor:0,result_minor:0,accounts:[],entries:[]});

function vatPage(d: AccountingPageData): H {
  const r = d.report ?? emptyReport();
  return html`${periodForm(d)}<section class="acct-section"><div class="acct-section-head"><div><h2>Momsoversigt</h2><p class="muted">${day(d.period?.from)} – ${day(d.period?.to)} · Bogførte poster i DKK</p></div></div><dl class="acct-vat-lines"><div><dt>Salgsmoms</dt><dd>${money(r.sales_vat_minor)}</dd></div><div><dt>Fradragsberettiget købsmoms</dt><dd>${money(r.purchase_vat_minor)}</dd></div><div class="acct-vat-total"><dt>${r.net_vat_minor < 0 ? 'Til gode' : 'Til betaling'}</dt><dd>${money(Math.abs(r.net_vat_minor))}</dd></div></dl><p class="hint">${r.net_vat_minor === 0 ? 'Periodens nettomoms er 0,00 kr.' : 'Nettomoms = salgsmoms minus fradragsberettiget købsmoms.'} Kladder og bankimport indgår ikke. Tilbageførsler indgår på deres bogføringsdato.</p><a href="${BASE}?tab=rapporter&from=${d.period?.from ?? ''}&to=${d.period?.to ?? ''}">Se posteringerne for samme periode</a></section>`;
}

function reportPage(d: AccountingPageData): H {
  const r = d.report ?? emptyReport();
  return html`${periodForm(d)}<section class="acct-section"><div class="acct-section-head"><div><h2>Resultatopgørelse</h2><p class="muted">${day(d.period?.from)} – ${day(d.period?.to)} · Bogførte poster i DKK</p></div></div><dl class="acct-vat-lines"><div><dt>Omsætning eksklusive moms</dt><dd>${money(r.income_minor)}</dd></div><div><dt>Omkostninger efter momsfradrag</dt><dd>${money(r.expenses_minor)}</dd></div><div class="acct-vat-total"><dt>Periodens resultat</dt><dd>${money(r.result_minor)}</dd></div></dl><p class="hint">Resultat og moms bygger på samme bogførte posteringer. Banklinjer og kladder lægges ikke oveni.</p>
  ${r.accounts.length ? html`<div class="table-wrap"><table class="responsive acct-table"><thead><tr><th scope="col">Konto</th><th scope="col">Navn</th><th scope="col" class="num">Periodens bevægelse</th></tr></thead><tbody>${r.accounts.map(a => html`<tr><td data-label="Konto">${a.code}</td><td data-label="Navn">${a.name}</td><td data-label="Periodens bevægelse" class="num">${money(a.amount_minor)}</td></tr>`)}</tbody></table></div>` : html`<p class="acct-empty">Ingen bogførte poster i perioden.</p>`}</section>
  <section class="acct-section"><h2>Posteringsspor</h2><p class="muted">Originalbilag, banktilknytning og tilbageførsler kan følges her.</p>${r.entries.length ? html`<div class="table-wrap"><table class="responsive acct-table"><thead><tr><th scope="col">Postering</th><th scope="col">Dato</th><th scope="col">Beskrivelse</th><th scope="col">Bilag</th><th scope="col">Banklinje</th><th scope="col">Spor</th></tr></thead><tbody>${r.entries.map(e => html`<tr><td data-label="Postering">#${e.id}</td><td data-label="Dato">${day(e.date)}</td><td data-label="Beskrivelse">${e.description || e.supplier || 'Postering'}</td><td data-label="Bilag">${e.receipt_id ? html`<a href="${BASE}/bilag/${e.receipt_id}">B${e.receipt_id}</a>` : '–'}</td><td data-label="Banklinje">${e.bank_line_id ? html`<a href="${BASE}?tab=bank&vis=all#bank-${e.bank_line_id}">#${e.bank_line_id}</a>` : '–'}</td><td data-label="Spor">${e.reversal_of ? `Tilbageførsel af #${e.reversal_of}` : e.reversed_by ? `Tilbageført med #${e.reversed_by}` : 'Bogført'}${e.actor ? html`<span class="acct-sub">${e.actor}</span>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="acct-empty">Der er endnu ingen posteringer at vise.</p>`}</section>`;
}

export const ACCOUNTING_CSS = String.raw`
.accounting{--acct-rule:#dddcd5;--acct-muted:#5d5d56;--acct-paper:#fff;--acct-ink:#24241f;--acct-accent:#f56c37;--acct-soft:#f5f4ef;color:var(--acct-ink);font-size:1rem}
.acct-title-dot{color:var(--acct-accent)}.accounting h1{margin:0;font-size:clamp(2rem,4vw,3rem);letter-spacing:-.04em}.accounting h2{font-size:1.45rem;letter-spacing:-.025em;margin:0 0 .4rem}.accounting h3{font-size:1rem;margin:0 0 .4rem}.accounting .lead{font-size:1.05rem;margin:.5rem 0 0;color:var(--acct-muted)}
.acct-heading{display:flex;justify-content:space-between;align-items:end;gap:1.5rem}.acct-shared{font-size:.875rem;white-space:nowrap;color:var(--acct-muted);padding-bottom:.2rem}.acct-topbar{display:flex;align-items:center;gap:1rem;border-bottom:1px solid var(--acct-rule);padding:0 0 1rem}.acct-tabs{display:flex;align-items:center;gap:.4rem;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin}.acct-tabs a{text-decoration:none;white-space:nowrap;padding:.7rem 1rem;border-radius:0;color:var(--acct-muted);font-weight:600;border-bottom:3px solid transparent}.acct-tabs a[aria-current=page]{border-color:var(--acct-accent);color:var(--acct-ink)}.acct-tabs a:hover:not([aria-current=page]){background:var(--acct-soft)}.acct-upload{white-space:nowrap;flex:none}.acct-section{background:var(--acct-paper);border:1px solid var(--acct-rule);border-radius:14px;padding:1.5rem}.acct-section-head{display:flex;align-items:start;justify-content:space-between;gap:1rem;margin-bottom:1.2rem}.acct-section-head p{margin:.35rem 0 0}.acct-filter{display:flex;gap:.5rem;align-items:center}.acct-filter select{min-width:9rem}.acct-main-link{font-weight:700}.acct-sub{display:block;color:var(--acct-muted);font-size:.875rem;line-height:1.5;margin-top:.15rem}.acct-filename{max-width:28rem;overflow-wrap:anywhere}.acct-empty{padding:2.5rem 1rem;text-align:center;color:var(--acct-muted)}.acct-empty .row{justify-content:center;margin-top:1.2rem}.acct-table{width:100%;font-size:.9375rem}.acct-table th{font-size:.875rem}.acct-table td{vertical-align:top}.acct-table .num{font-variant-numeric:tabular-nums;white-space:nowrap}.accounting .hint,.accounting .small{font-size:.875rem}.accounting label{font-size:.9375rem}.accounting .muted{color:var(--acct-muted)}.acct-upload-panel{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:2.5rem}.acct-file{background:var(--acct-soft);border:1px dashed #93a38e;border-radius:10px;padding:1.25rem}.acct-file input{background:transparent;padding:.6rem 0}.acct-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.acct-field-wide{grid-column:1/-1}.acct-document-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(14rem,.42fr);gap:1.25rem}.acct-aside .acct-section{padding:1.2rem}.acct-bank-summary{display:grid;gap:.5rem;padding:.7rem 0;font-size:.9375rem;overflow-wrap:anywhere}.acct-bank-summary span{color:var(--acct-muted)}.acct-approval{border-top:1px solid var(--acct-rule);padding-top:1.25rem;margin-top:1.25rem}.acct-approval>p{font-size:.9375rem;color:var(--acct-muted);max-width:52rem}.acct-details{margin:1.5rem 0;display:grid;gap:1rem}.acct-details>div{display:flex;justify-content:space-between;gap:1.5rem;border-bottom:1px solid #edf0ea;padding-bottom:.7rem}.acct-details dt{color:var(--acct-muted)}.acct-details dd{margin:0;text-align:right;font-weight:600}.acct-history{padding:0;list-style:none;display:grid;gap:1.1rem}.acct-history li{padding-left:1rem;border-left:2px solid var(--acct-rule);font-size:.875rem}.acct-history li>span{display:block;color:var(--acct-muted);margin-top:.2rem}.acct-history li p{margin:.5rem 0 0}.acct-actor{overflow-wrap:anywhere}.acct-correction{border-top:1px solid var(--acct-rule);padding-top:1rem}.acct-correction form{margin-top:1rem}.acct-foreign{border:1px solid var(--acct-rule);border-radius:10px;padding:1rem}.acct-foreign[hidden]{display:none}.acct-foreign legend{padding:0 .35rem;font-size:.9375rem;font-weight:600}.acct-account-picker{position:relative}.acct-account-results{position:absolute;top:4.8rem;left:0;right:0;z-index:20;background:#fff;border:1px solid #829080;border-radius:8px;max-height:15rem;overflow:auto;box-shadow:0 8px 24px #14211a19}.acct-account-results[hidden]{display:none}.acct-account-option{display:block;text-align:left;padding:.7rem .8rem;cursor:pointer;font-size:.9375rem}.acct-account-option[aria-selected=true],.acct-account-option:hover{background:#fff1e8}.acct-account-none{padding:.8rem;margin:0;color:var(--acct-muted);font-size:.875rem}.accounting :focus-visible{outline:3px solid #356c9a;outline-offset:3px}.acct-import{background:var(--acct-soft);border:1px solid var(--acct-rule);border-radius:12px;padding:1.2rem 1.5rem}.acct-import summary,.acct-correction summary{font-weight:650;cursor:pointer}.acct-import form{margin-top:1.25rem}.acct-bank-totals{display:flex;gap:1.5rem;flex-wrap:wrap;border-bottom:1px solid var(--acct-rule);padding-bottom:1rem}.acct-bank-totals>div{display:grid;gap:.25rem;min-width:12rem}.acct-bank-totals strong{font-size:1.4rem;font-variant-numeric:tabular-nums}.acct-bank-totals span,.acct-bank-totals small{font-size:.875rem;color:var(--acct-muted)}.acct-filters{display:flex;flex-wrap:wrap;gap:1rem;padding-bottom:1rem;margin-bottom:.25rem;border-bottom:1px solid var(--acct-rule)}.acct-filters a{font-size:.9375rem;color:var(--acct-muted);text-decoration:none;padding-bottom:.3rem}.acct-filters a[aria-current=page]{font-weight:700;color:var(--acct-ink);box-shadow:0 2px 0 var(--acct-accent)}.acct-bank-line{padding:1.3rem 0;border-bottom:1px solid var(--acct-rule);scroll-margin-top:1rem}.acct-bank-line:last-child{border-bottom:0;padding-bottom:0}.acct-bank-main{display:flex;align-items:start;justify-content:space-between;gap:1rem}.acct-bank-main h3{font-size:1.05rem;margin:.25rem 0}.acct-date{font-size:.875rem;color:var(--acct-muted)}.acct-bank-amount{white-space:nowrap;font-size:1.05rem;font-variant-numeric:tabular-nums}.acct-positive{color:#245b3b}.acct-bank-actions{display:flex;align-items:start;gap:.65rem;flex-wrap:wrap;margin-top:.8rem}.acct-text-button{border:0;background:transparent;padding:.55rem .45rem;text-decoration:underline;font-size:.875rem;cursor:pointer;color:var(--acct-muted)}.acct-attach{position:relative}.acct-attach summary{font-size:.875rem;font-weight:600;padding:.55rem .8rem;border:1px solid var(--acct-rule);border-radius:7px;cursor:pointer}.acct-attach form{min-width:min(24rem,75vw);padding:1rem;background:#f8faf6;border:1px solid var(--acct-rule);border-radius:7px;margin-top:.5rem}.acct-refund-pairs{display:grid;gap:1rem}.acct-refund-pair{border:1px solid var(--acct-rule);border-radius:10px;padding:1.1rem}.acct-pair-lines{display:grid;gap:.6rem;margin:1rem 0}.acct-pair-lines>div{display:flex;justify-content:space-between;gap:1rem;font-size:.9375rem}.acct-pair-lines strong{white-space:nowrap;font-variant-numeric:tabular-nums}.acct-pair-lines small{color:var(--acct-muted);font-size:.875rem}.acct-uncertain{font-size:.875rem;color:#7a4b14}.acct-period{display:flex;align-items:end;flex-wrap:wrap;gap:1rem}.acct-period .field{min-width:12rem}.acct-period .btn{margin-bottom:0}.acct-vat-lines{margin:1.5rem 0;max-width:54rem}.acct-vat-lines>div{display:flex;justify-content:space-between;align-items:baseline;gap:1.5rem;padding:1rem 0;border-bottom:1px solid var(--acct-rule)}.acct-vat-lines dt{font-size:1rem}.acct-vat-lines dd{margin:0;font-size:1.2rem;white-space:nowrap;font-variant-numeric:tabular-nums}.acct-vat-lines .acct-vat-total{border-bottom:0;padding-top:1.4rem}.acct-vat-total dt,.acct-vat-total dd{font-weight:750;font-size:1.5rem}
@media(max-width:850px){.acct-document-grid{grid-template-columns:1fr}.acct-aside{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.acct-aside>*+*{margin-top:0}.acct-upload-panel{grid-template-columns:1fr;gap:1.5rem}.acct-topbar{gap:.5rem}.acct-tabs a{padding:.6rem .7rem}.acct-topbar .btn{font-size:.875rem;padding:.65rem .8rem}.acct-section-head{flex-wrap:wrap}}
@media(max-width:560px){.acct-heading{align-items:start}.acct-shared{display:none}.acct-topbar{flex-wrap:wrap}.acct-tabs{flex-basis:100%;gap:.1rem;order:0}.acct-tabs a{font-size:.875rem;padding:.65rem .7rem}.acct-upload{order:1}.acct-section{padding:1.1rem}.acct-fields,.acct-aside{grid-template-columns:1fr}.acct-field-wide{grid-column:auto}.acct-bank-main{align-items:start}.acct-bank-main h3{overflow-wrap:anywhere}.acct-bank-amount{font-size:1rem}.acct-bank-actions{gap:.5rem}.acct-pair-lines>div{align-items:start}.acct-pair-lines span{max-width:65%}.acct-vat-lines dt{font-size:.9375rem}.acct-vat-lines dd{font-size:1.05rem}.acct-vat-total dt,.acct-vat-total dd{font-size:1.25rem}.acct-period .field{min-width:0;flex:1 1 calc(50% - .5rem)}.acct-period .btn{flex:0 0 100%}.acct-period input{min-width:0;width:100%}.acct-details>div{gap:.7rem}.acct-details dt,.acct-details dd{font-size:.9375rem}.acct-filter{width:100%}.acct-filter select{flex:1}.acct-approval .row>*{flex:1;white-space:normal}.acct-empty{padding:1.5rem .25rem}.acct-import{padding:1rem}.acct-attach form{min-width:0;width:min(21rem,72vw)}}
@media(prefers-reduced-motion:reduce){.accounting *{scroll-behavior:auto!important;transition:none!important}}
`;
