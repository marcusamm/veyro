// Import af kundeemner fra Excel/CSV: upload, forhåndsvisning med kolonnevalg, importoversigt, slet fil og fortryd import.
import { html, raw } from 'hono/html';
import { formatDateTime } from '../lib/format';
import {
  DELIM_PARAM,
  IMPORT_FIELD_LABEL,
  IMPORT_FIELDS,
  IMPORT_STATUS_LABEL,
  MAX_IMPORT_FILE,
  colLetter,
  type ColumnMap,
  type Evaluation,
  type Hit,
  type ImportRow,
  type ImportedProspect,
  type RowEval,
  type Table,
} from '../lib/prospect-import';
import { DELIMITER_LABEL, DELIMITERS } from '../lib/sheet-read';
import { alert, csrfField, type H } from './layout';

function crumbs(...items: [string, string | null][]): H {
  return html`<p class="eyebrow">${items.map(([label, href], i) => html`${i ? ' / ' : ''}${href ? html`<a href="${href}">${label}</a>` : label}`)}</p>`;
}

const base = ['Admin', '/admin'] as [string, string];
const prospectsCrumb = ['Kundeemner', '/admin/kundeemner'] as [string, string];

const size = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('da-DK', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);

function statusBadge(imp: ImportRow): H {
  const tone = imp.status === 'importeret' ? 'b-ok' : imp.status === 'uploadet' || imp.status === 'importerer' ? 'b-warn' : 'b-neutral';
  return html`<span class="badge ${tone}">${IMPORT_STATUS_LABEL[imp.status]}</span>`;
}

function hitList(hits: Hit[]): H {
  return html`${hits.map((h, i) => html`${i ? html`<br>` : ''}${h.href ? html`<a href="${h.href}">${h.text}</a>` : h.text}`)}`;
}

export const IMPORT_FLASH: Record<string, string> = {
  'fil-slettet': 'Originalfilen er slettet. De importerede kundeemner er bevaret.',
  fortrudt: 'De valgte kundeemner fra importen er slettet.',
};

// ---------- Upload og oversigt ----------

export function importStartPage(args: { csrf: string; imports: (ImportRow & { remaining: number })[]; error: string | null; flash: string | null }): H {
  return html`<div class="stack-lg">
  <div>${crumbs(base, prospectsCrumb, ['Importér', null])}<h1>Importér kundeemner</h1>
    <p class="lead">Upload en Excel-fil (.xlsx) eller CSV med virksomheder. Du ser en forhåndsvisning og vælger kolonner, før noget bliver oprettet. Der sendes ingen mails, og der oprettes ingen kunder.</p></div>
  ${args.flash && IMPORT_FLASH[args.flash] ? alert('ok', IMPORT_FLASH[args.flash]!) : ''}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/kundeemner/import" enctype="multipart/form-data" class="card stack" aria-labelledby="up-h">
    ${csrfField(args.csrf)}
    <h2 id="up-h" class="h-small" style="margin:0">Upload fil</h2>
    <div class="field"><label for="imp-file">Fil (.xlsx eller .csv, højst ${size(MAX_IMPORT_FILE)} og 5.000 rækker)</label>
      <input id="imp-file" name="file" type="file" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required></div>
    <p class="hint">Felter: ${IMPORT_FIELDS.map((f) => IMPORT_FIELD_LABEL[f]).join(', ')}. Kun virksomhedsnavn er påkrævet. CSV kan være adskilt med komma eller semikolon. Telefonnumre læses som tekst, så +45 og foranstillede nuller bevares (i Excel skal kolonnen være formateret som tekst, ellers har Excel selv fjernet nullerne).</p>
    <div><button class="btn btn-primary" type="submit">Upload og vis forhåndsvisning</button></div>
  </form>
  <section class="card stack" aria-labelledby="imps-h">
    <h2 id="imps-h" class="h-small" style="margin:0">Importer</h2>
    ${args.imports.length
      ? html`<div class="table-wrap"><table class="responsive">
        <thead><tr><th scope="col">Fil</th><th scope="col">Uploadet</th><th scope="col">Importeret af</th><th scope="col">Oprettet</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Handlinger</span></th></tr></thead>
        <tbody>${args.imports.map(
          (i) => html`<tr>
            <td data-label="Fil"><div class="cell"><a href="/admin/kundeemner/import/${i.id}"><strong>${i.file_name}</strong></a><br><span class="small muted">${i.file_deleted_at ? `Fil slettet ${formatDateTime(i.file_deleted_at)}` : `${i.file_type.toUpperCase()} · ${size(i.file_size)}`}</span></div></td>
            <td data-label="Uploadet"><div class="cell">${formatDateTime(i.uploaded_at)}</div></td>
            <td data-label="Importeret af"><div class="cell">${i.imported_by ?? i.uploaded_by}</div></td>
            <td data-label="Oprettet"><div class="cell">${i.created_count}${i.undone_count ? html`<br><span class="small muted">${i.undone_count} fortrudt, ${i.remaining} tilbage</span>` : ''}</div></td>
            <td data-label="Status"><div class="cell">${statusBadge(i)}</div></td>
            <td data-label=""><div class="cell row">
              ${i.file_deleted_at ? '' : html`<a class="btn btn-secondary btn-small" href="/admin/kundeemner/import/${i.id}#slet-fil">Slet fil</a>`}
              ${i.remaining ? html`<a class="btn btn-secondary btn-small" href="/admin/kundeemner/import/${i.id}/fortryd">Fortryd import</a>` : ''}
            </div></td></tr>`,
        )}</tbody></table></div>`
      : html`<p class="empty">Ingen importer endnu.</p>`}
  </section>
</div>`;
}

// ---------- Forhåndsvisning ----------

function deleteFileForm(csrf: string, imp: ImportRow): H {
  if (imp.file_deleted_at) return html`<section class="card stack" id="slet-fil"><h2 class="h-small" style="margin:0">Originalfil</h2><p class="small" style="margin:0">Slettet ${formatDateTime(imp.file_deleted_at)}${imp.file_deleted_by ? ` af ${imp.file_deleted_by}` : ''}.</p></section>`;
  const imported = imp.status !== 'uploadet';
  return html`<form method="post" action="/admin/kundeemner/import/${imp.id}/slet-fil" class="card stack" id="slet-fil" aria-labelledby="sf-h">
    ${csrfField(csrf)}
    <h2 id="sf-h" class="h-small" style="margin:0">Slet fil</h2>
    <p class="small" style="margin:0">Fjerner den uploadede originalfil (${imp.file_name}) fra Veyros lagring og fra admin. ${imported
      ? html`<strong>De ${imp.created_count} kundeemner, der blev oprettet ved importen, bevares.</strong> Brug "Fortryd import", hvis kundeemnerne også skal fjernes.`
      : 'Filen er ikke importeret endnu; importen annulleres, og der oprettes ingen kundeemner.'}</p>
    <p class="hint" style="margin:0">Databasens automatiske sikkerhedskopi (til gendannelse ved nedbrud) slettes først efter 30 dage.</p>
    <label class="check confirm-check"><input type="checkbox" name="confirm" value="1" required> Jeg forstår, at originalfilen slettes permanent${imported ? ', og at de importerede kundeemner bevares' : ''}.</label>
    <div class="row"><a class="small" href="/admin/kundeemner/import/${imp.id}/fil">Download originalfilen først</a></div>
    <div><button class="btn btn-danger btn-small" type="submit">Slet fil</button></div>
  </form>`;
}

function hiddenOptions(t: Table, header: boolean, map: ColumnMap, type: 'csv' | 'xlsx'): H {
  return html`<input type="hidden" name="kolonner" value="1"><input type="hidden" name="ark" value="${t.sheet}"><input type="hidden" name="overskrift" value="${header ? '1' : '0'}">
    ${type === 'csv' && t.delimiter ? html`<input type="hidden" name="skilletegn" value="${DELIM_PARAM[t.delimiter]}">` : ''}
    ${IMPORT_FIELDS.map((f) => html`<input type="hidden" name="k_${f}" value="${map[f] ?? ''}">`)}`;
}

function rowCells(r: RowEval): H {
  return html`${IMPORT_FIELDS.map((f) => html`<td data-label="${IMPORT_FIELD_LABEL[f]}"><div class="cell">${f === 'notes' && r.values[f].length > 80 ? r.values[f].slice(0, 77) + '…' : r.values[f] || html`<span class="muted">–</span>`}</div></td>`)}`;
}

const fieldHead = html`${IMPORT_FIELDS.map((f) => html`<th scope="col">${IMPORT_FIELD_LABEL[f]}</th>`)}`;

export function importPreviewPage(args: {
  csrf: string;
  imp: ImportRow;
  table: Table | null;
  readError: string | null;
  header: boolean;
  delimiterChosen: boolean;
  map: ColumnMap;
  ev: Evaluation | null;
  error: string | null;
}): H {
  const { imp, table: t, ev } = args;
  const sample = (i: number) => {
    const v = t?.rows.find((r) => (r[i] ?? '').trim())?.[i]?.trim() ?? '';
    return v ? ` (fx "${v.length > 30 ? v.slice(0, 27) + '…' : v}")` : '';
  };
  const dups = ev?.rows.filter((r) => r.state === 'duplicate') ?? [];
  const blocked = ev?.rows.filter((r) => r.state === 'blocked') ?? [];
  const errors = ev?.rows.filter((r) => r.state === 'error') ?? [];
  const ok = ev?.rows.filter((r) => r.state === 'ok') ?? [];
  return html`<div class="stack-lg">
  <div>${crumbs(base, prospectsCrumb, ['Importér', '/admin/kundeemner/import'], [imp.file_name, null])}<h1>Forhåndsvisning</h1>
    <p class="lead">${imp.file_name} · ${imp.file_type.toUpperCase()} · ${size(imp.file_size)} · uploadet ${formatDateTime(imp.uploaded_at)} af ${imp.uploaded_by}. Intet er oprettet endnu.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  ${args.readError ? alert('err', args.readError) : ''}
  ${t
    ? html`
  <form method="get" action="/admin/kundeemner/import/${imp.id}" class="card stack" aria-labelledby="set-h">
    <h2 id="set-h" class="h-small" style="margin:0">Fil og kolonner</h2>
    <input type="hidden" name="kolonner" value="1">
    <div class="grid grid-3">
      ${t.sheets.length > 1
        ? html`<div class="field"><label for="i-ark">Ark</label><select id="i-ark" name="ark">${t.sheets.map((s, i) => html`<option value="${i}"${i === t.sheet ? raw(' selected') : ''}>${s.name}${s.hidden ? ' (skjult)' : ''}</option>`)}</select></div>`
        : html`<input type="hidden" name="ark" value="${t.sheet}">`}
      <div class="field"><label for="i-hdr">Første række</label><select id="i-hdr" name="overskrift"><option value="1"${args.header ? raw(' selected') : ''}>Er overskrifter</option><option value="0"${args.header ? '' : raw(' selected')}>Er data</option></select></div>
      ${imp.file_type === 'csv'
        ? html`<div class="field"><label for="i-sep">Skilletegn</label><select id="i-sep" name="skilletegn">
            <option value="">Automatisk${!args.delimiterChosen && t.delimiter ? ` (fundet: ${DELIMITER_LABEL[t.delimiter].toLowerCase()})` : ''}</option>
            ${DELIMITERS.map((d) => html`<option value="${DELIM_PARAM[d]}"${args.delimiterChosen && t.delimiter === d ? raw(' selected') : ''}>${DELIMITER_LABEL[d]}</option>`)}</select>
            ${t.encoding ? html`<p class="hint">Tegnsæt: ${t.encoding}</p>` : ''}</div>`
        : ''}
    </div>
    <p class="small" style="margin:0">Vælg, hvilken kolonne i filen der svarer til hvert felt. Almindelige kolonnenavne er genkendt automatisk.</p>
    <div class="grid grid-3">
      ${IMPORT_FIELDS.map(
        (f) => html`<div class="field"><label for="k-${f}">${IMPORT_FIELD_LABEL[f]}${f === 'company' ? ' (påkrævet)' : ''}</label>
          <select id="k-${f}" name="k_${f}"><option value="">Ikke i filen</option>${t.headers.map((h, i) => html`<option value="${i}"${args.map[f] === i ? raw(' selected') : ''}>${colLetter(i)}: ${h}${sample(i)}</option>`)}</select></div>`,
      )}
    </div>
    <div><button class="btn btn-secondary btn-small" type="submit">Opdatér forhåndsvisning</button></div>
  </form>
  ${t.formulas ? alert('info', `${t.formulas} ${t.formulas === 1 ? 'celle indeholder' : 'celler indeholder'} en formel. Formler bliver ikke beregnet; kun den værdi, der er gemt i filen, er læst.`) : ''}
  ${t.truncated ? alert('warn', 'Filen har mere end 5.000 rækker. Kun de første 5.000 er med. Del filen op, og importér resten for sig.') : ''}
  ${args.map.company === undefined ? alert('warn', 'Vælg, hvilken kolonne der indeholder virksomhedsnavnet.') : ''}
  ${ev
    ? html`
  <section class="card stack" aria-labelledby="sum-h">
    <h2 id="sum-h" class="h-small" style="margin:0">Før import</h2>
    <dl class="facts" style="margin-top:0">
      <div><dt>Rækker med data</dt><dd>${ev.rows.length}</dd></div>
      <div><dt>Gyldige og klar til import</dt><dd>${ev.counts.ok}</dd></div>
      <div><dt>Mulige dubletter</dt><dd>${ev.counts.duplicate}</dd></div>
      <div><dt>Blacklistede</dt><dd>${ev.counts.blocked}</dd></div>
      <div><dt>Rækker med fejl</dt><dd>${ev.counts.error}</dd></div>
      <div><dt>Tomme rækker (ignoreres)</dt><dd>${ev.empty}</dd></div>
    </dl>
  </section>
  <form method="post" action="/admin/kundeemner/import/${imp.id}/bekraeft" class="stack-lg">
    ${csrfField(args.csrf)}
    ${hiddenOptions(t, args.header, args.map, imp.file_type)}
    ${errors.length
      ? html`<section class="card stack" aria-labelledby="err-h"><h2 id="err-h" class="h-small" style="margin:0">Rækker med fejl (${errors.length})</h2>
          <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Række</th><th scope="col">Fejl</th><th scope="col">Virksomhed</th></tr></thead>
          <tbody>${errors.map((r) => html`<tr><td data-label="Række"><div class="cell">${r.row}</div></td><td data-label="Fejl"><div class="cell text-err">${r.errors.join(' ')}</div></td><td data-label="Virksomhed"><div class="cell">${r.values.company || html`<span class="muted">–</span>`}</div></td></tr>`)}</tbody></table></div>
          <label class="check confirm-check"><input type="checkbox" name="spring_fejl" value="1"> Spring de ${errors.length} rækker med fejl over</label>
          <p class="hint" style="margin:0">Rækker med fejl kan ikke importeres. Ret dem i filen og upload den igen, eller spring dem over.</p></section>`
      : ''}
    ${dups.length
      ? html`<section class="card stack" aria-labelledby="dup-h"><h2 id="dup-h" class="h-small" style="margin:0">Mulige dubletter (${dups.length})</h2>
          <p class="small" style="margin:0">Genkendt ud fra virksomhedsnavn, e-mail og domæne. Eksisterende kundeemner overskrives aldrig. Som standard springes rækkerne over; markér dem, der alligevel skal oprettes som nye kundeemner.</p>
          <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Opret alligevel</th><th scope="col">Række</th><th scope="col">Virksomhed</th><th scope="col">Ligner</th></tr></thead>
          <tbody>${dups.map((r) => html`<tr><td data-label="Opret alligevel"><div class="cell"><input type="checkbox" name="dublet_ok" value="${r.row}" aria-label="Opret række ${r.row} alligevel"></div></td><td data-label="Række"><div class="cell">${r.row}</div></td>
            <td data-label="Virksomhed"><div class="cell"><strong>${r.values.company}</strong>${r.emails.length ? html`<br><span class="small">${r.emails.join(', ')}</span>` : ''}${r.domain ? html`<br><span class="small">${r.domain}</span>` : ''}</div></td>
            <td data-label="Ligner"><div class="cell small">${hitList(r.duplicates)}</div></td></tr>`)}</tbody></table></div></section>`
      : ''}
    ${blocked.length
      ? html`<section class="card stack" aria-labelledby="bl-h"><h2 id="bl-h" class="h-small" style="margin:0">Blacklistede virksomheder (${blocked.length})</h2>
          <p class="small" style="margin:0">Disse rækker rammer en aktiv blokering og importeres ikke, medmindre du udtrykkeligt vælger det. Importeres de alligevel, bliver de markeret som blacklistede, og blokeringen gælder fortsat.</p>
          <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Række</th><th scope="col">Virksomhed</th><th scope="col">Blokering</th></tr></thead>
          <tbody>${blocked.map((r) => html`<tr><td data-label="Række"><div class="cell">${r.row}</div></td><td data-label="Virksomhed"><div class="cell"><strong>${r.values.company}</strong></div></td><td data-label="Blokering"><div class="cell small">${hitList(r.blocked)}${r.duplicates.length ? html`<br>${hitList(r.duplicates)}<br><label class="check"><input type="checkbox" name="dublet_ok" value="${r.row}"> Opret trods mulig dublet</label>` : ''}</div></td></tr>`)}</tbody></table></div>
          <details><summary class="small">Importér blacklistede virksomheder alligevel</summary>
            <div class="stack" style="margin-top:8px">
              <label class="check confirm-check"><input type="checkbox" name="medtag_blokerede" value="1"> Ja, importér de ${blocked.length} blacklistede virksomheder som blacklistede kundeemner</label>
              <div class="field"><label for="i-why">Hvorfor? (gemmes i kundeemnets historik)</label><input id="i-why" name="blokering_aarsag" type="text" maxlength="300"></div>
            </div></details></section>`
      : ''}
    <section class="card stack" aria-labelledby="ok-h"><h2 id="ok-h" class="h-small" style="margin:0">Klar til import (${ok.length})</h2>
      ${ok.length
        ? html`<div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Række</th>${fieldHead}</tr></thead>
            <tbody>${ok.slice(0, 25).map((r) => html`<tr><td data-label="Række"><div class="cell">${r.row}</div></td>${rowCells(r)}</tr>`)}</tbody></table></div>
            ${ok.length > 25 ? html`<p class="small muted" style="margin:0">Viser de første 25 af ${ok.length}.</p>` : ''}`
        : html`<p class="small muted" style="margin:0">Ingen rækker er klar til import med de valgte kolonner.</p>`}
      <p class="small" style="margin:0">Kundeemnerne oprettes med status "Skal undersøges" og kilden "Import: ${imp.file_name}". Der sendes ingen mails, der oprettes ingen kunder, og eksisterende kundeemner ændres ikke.</p>
      <div class="row"><button class="btn btn-primary" type="submit"${args.map.company === undefined ? ' disabled' : ''}>Bekræft og importér</button><a class="small" href="/admin/kundeemner/import">Annullér</a></div>
    </section>
  </form>`
    : ''}`
    : ''}
  ${deleteFileForm(args.csrf, imp)}
</div>`;
}

// ---------- Efter importen ----------

export function importSummaryPage(args: { csrf: string; imp: ImportRow; remaining: number; flash: string | null; error: string | null; canResume: boolean }): H {
  const i = args.imp;
  return html`<div class="stack-lg">
  <div>${crumbs(base, prospectsCrumb, ['Importér', '/admin/kundeemner/import'], [i.file_name, null])}<h1>${i.file_name}</h1>
    <p class="lead">Uploadet ${formatDateTime(i.uploaded_at)} af ${i.uploaded_by}. ${statusBadge(i)}</p></div>
  ${args.flash && IMPORT_FLASH[args.flash] ? alert('ok', IMPORT_FLASH[args.flash]!) : ''}
  ${args.error ? alert('err', args.error) : ''}
  ${i.status === 'importerer'
    ? alert('warn', html`Importen er i gang eller blev afbrudt. ${args.canResume
        ? html`<form method="post" action="/admin/kundeemner/import/${i.id}/genoptag" class="inline">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit">Genoptag importen</button></form> Rækker, der allerede er oprettet, oprettes ikke igen.`
        : 'Genindlæs siden om lidt.'}`)
    : ''}
  ${i.imported_at
    ? html`<section class="card stack" aria-labelledby="res-h"><h2 id="res-h" class="h-small" style="margin:0">Resultat</h2>
      <dl class="facts" style="margin-top:0">
        <div><dt>Oprettet</dt><dd>${i.created_count}</dd></div>
        <div><dt>Sprunget over: mulige dubletter</dt><dd>${i.skipped_duplicates}</dd></div>
        <div><dt>Sprunget over: fejl</dt><dd>${i.skipped_errors}</dd></div>
        <div><dt>Sprunget over: blacklistede</dt><dd>${i.skipped_blocked}</dd></div>
        <div><dt>Importeret</dt><dd>${formatDateTime(i.imported_at)}${i.imported_by ? ` af ${i.imported_by}` : ''}</dd></div>
        <div><dt>Fortrudt</dt><dd>${i.undone_count ? `${i.undone_count} slettet${i.undone_at ? ` ${formatDateTime(i.undone_at)}` : ''}${i.undone_by ? ` af ${i.undone_by}` : ''}` : 'Nej'}</dd></div>
      </dl>
      <p class="small" style="margin:0">Der er ikke sendt mails og ikke oprettet kunder. ${args.remaining} ${args.remaining === 1 ? 'kundeemne' : 'kundeemner'} fra importen findes stadig.</p>
      <div class="row">
        <a class="btn btn-secondary btn-small" href="/admin/kundeemner?visning=alle&amp;import=${i.id}">Se de importerede kundeemner</a>
        ${args.remaining ? html`<a class="btn btn-secondary btn-small" href="/admin/kundeemner/import/${i.id}/fortryd">Fortryd import</a>` : ''}
      </div></section>`
    : ''}
  ${deleteFileForm(args.csrf, i)}
</div>`;
}

// ---------- Fortryd import ----------

export function undoPage(args: { csrf: string; imp: ImportRow; rows: ImportedProspect[]; error: string | null; result: { deleted: number; kept: number } | null }): H {
  const i = args.imp;
  const free = args.rows.filter((r) => !r.reasons.length);
  const kept = args.rows.filter((r) => r.reasons.length);
  return html`<div class="stack-lg">
  <div>${crumbs(base, prospectsCrumb, ['Importér', '/admin/kundeemner/import'], [i.file_name, `/admin/kundeemner/import/${i.id}`], ['Fortryd', null])}<h1>Fortryd import</h1>
    <p class="lead">Kundeemner oprettet ved importen af ${i.file_name} ${i.imported_at ? formatDateTime(i.imported_at) : ''}. Vælg, hvilke der skal slettes.</p></div>
  ${args.error ? alert('err', args.error) : ''}
  ${args.result ? alert(args.result.deleted ? 'ok' : 'warn', `${args.result.deleted} ${args.result.deleted === 1 ? 'kundeemne er' : 'kundeemner er'} slettet.${args.result.kept ? ` ${args.result.kept} blev ikke slettet, fordi de er ændret i mellemtiden.` : ''}`) : ''}
  ${alert('info', 'Kun kundeemner, der blev oprettet af netop denne import, vises her. Eksisterende kundeemner, der blot blev genkendt som dubletter, er ikke knyttet til importen og slettes aldrig. Blacklistinger bevares, også når kundeemnet slettes.')}
  ${free.length
    ? html`<form method="post" action="/admin/kundeemner/import/${i.id}/fortryd" class="card stack" aria-labelledby="free-h">
        ${csrfField(args.csrf)}
        <h2 id="free-h" class="h-small" style="margin:0">Kan slettes (${free.length})</h2>
        <p class="small" style="margin:0">Uberørte siden importen: ingen kontakt, ændringer, tilbud eller kundekonvertering.</p>
        <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Slet</th><th scope="col">Række</th><th scope="col">Kundeemne</th></tr></thead>
        <tbody>${free.map((r) => html`<tr><td data-label="Slet"><div class="cell"><input type="checkbox" name="id" value="${r.id}" checked aria-label="Slet ${r.company}"></div></td><td data-label="Række"><div class="cell">${r.import_row}</div></td><td data-label="Kundeemne"><div class="cell"><a href="/admin/kundeemner/${r.id}">${r.company}</a></div></td></tr>`)}</tbody></table></div>
        <label class="check confirm-check"><input type="checkbox" name="confirm" value="1" required> Jeg bekræfter, at de markerede kundeemner slettes permanent</label>
        <div><button class="btn btn-danger btn-small" type="submit">Slet de markerede kundeemner</button></div>
      </form>`
    : html`<section class="card"><p class="empty">Ingen kundeemner fra importen kan slettes automatisk.</p></section>`}
  ${kept.length
    ? html`<section class="card stack" aria-labelledby="kept-h"><h2 id="kept-h" class="h-small" style="margin:0">Slettes ikke automatisk (${kept.length})</h2>
        <p class="small" style="margin:0">Disse kundeemner har fået kontaktaktivitet, er redigeret eller er blevet til kunder efter importen. De slettes ikke som en del af fortrydelsen. Åbn dem enkeltvis, hvis de skal slettes.</p>
        <div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Række</th><th scope="col">Kundeemne</th><th scope="col">Hvorfor</th></tr></thead>
        <tbody>${kept.map((r) => html`<tr><td data-label="Række"><div class="cell">${r.import_row}</div></td><td data-label="Kundeemne"><div class="cell"><a href="/admin/kundeemner/${r.id}">${r.company}</a></div></td><td data-label="Hvorfor"><div class="cell small">${r.reasons.join('. ')}.</div></td></tr>`)}</tbody></table></div></section>`
    : ''}
</div>`;
}
