import { html } from 'hono/html';
import type { InvoiceBasisRow, InvoiceLineRow, JobRow } from '../env';
import { SOURCE_LABEL, parseCustomer, totals, type ConsumptionLine } from '../lib/billing';
import { formatDate, formatDateTime, formatKr, lineAmount, oereToInput, qtyInput, qtyUnit } from '../lib/format';
import { errors, flash, pageHead } from './common';
import { alert, csrfField, type H } from './layout';

export type BillingJobRow = Pick<JobRow, 'id' | 'number' | 'name' | 'customer_name' | 'status'> & {
  draft_id: number | null;
  approved_count: number;
  last_approved_at: number | null;
};

export type BasisListRow = InvoiceBasisRow & { job_number: string; job_name: string };

function basisTag(b: Pick<InvoiceBasisRow, 'status'>): H {
  return b.status === 'godkendt' ? html`<span class="tag tag-ok">Godkendt</span>` : html`<span class="tag tag-ready">Kladde</span>`;
}

export function fakturaListPage(d: { jobs: BillingJobRow[]; bases: BasisListRow[]; flashCode?: string }): H {
  return html`<div class="stack-lg">
  ${pageHead('Lagerportal', 'Fakturagrundlag', '', 'Materialeforbruget pr. job, klar til gennemsyn, godkendelse og eksport. En indkøbsliste bliver aldrig automatisk til en faktura.')}
  ${flash(d.flashCode)}
  <section class="stack">
    <h2>Job</h2>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
      <thead><tr><th>Job</th><th>Kunde</th><th>Status</th><th>Fakturagrundlag</th><th></th></tr></thead>
      <tbody>${d.jobs.length
        ? d.jobs.map(
            (j) => html`<tr class="row-link" data-href="/lager/faktura/job/${j.id}">
          <td class="cell-main"><a class="title" href="/lager/faktura/job/${j.id}">${j.number} ${j.name}</a></td>
          <td data-label="Kunde">${j.customer_name || '–'}</td>
          <td data-label="Status">${j.status === 'aktiv' ? html`<span class="tag tag-ok">Aktiv</span>` : html`<span class="tag tag-off">Afsluttet</span>`}</td>
          <td data-label="Fakturagrundlag">${j.draft_id ? html`<span class="tag tag-ready">Kladde</span> ` : ''}${j.approved_count ? `${j.approved_count} godkendt, senest ${formatDate(j.last_approved_at)}` : j.draft_id ? '' : 'Intet endnu'}</td>
          <td><a class="btn btn-secondary btn-small" href="/lager/faktura/job/${j.id}">Åbn</a></td>
        </tr>`,
          )
        : html`<tr><td colspan="5" class="empty">Ingen job med materialer endnu.</td></tr>`}</tbody>
    </table></div></div>
  </section>
  <section class="stack">
    <h2>Seneste fakturagrundlag</h2>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
      <thead><tr><th>Job</th><th>Status</th><th class="num">Kostpris</th><th class="num">Salgspris</th><th>Godkendt</th></tr></thead>
      <tbody>${d.bases.length
        ? d.bases.map(
            (b) => html`<tr class="row-link" data-href="/lager/faktura/${b.id}">
          <td class="cell-main"><a class="title" href="/lager/faktura/${b.id}">${b.job_number} ${b.job_name}</a></td>
          <td data-label="Status">${basisTag(b)}</td>
          <td class="num" data-label="Kostpris">${b.status === 'godkendt' ? formatKr(b.total_cost) : '–'}</td>
          <td class="num" data-label="Salgspris">${b.status === 'godkendt' ? formatKr(b.total_sale) : '–'}</td>
          <td data-label="Godkendt">${b.approved_at ? `${formatDateTime(b.approved_at)} af ${b.approved_by}` : '–'}</td>
        </tr>`,
          )
        : html`<tr><td colspan="5" class="empty">Ingen fakturagrundlag endnu.</td></tr>`}</tbody>
    </table></div></div>
  </section>
</div>`;
}

function consumptionTable(lines: ConsumptionLine[]): H {
  return html`<div class="table-wrap"><table class="list stackable dense">
    <thead><tr><th>Vare</th><th>Kilde</th><th class="num">Mængde</th><th class="num">Kostpris pr. enhed</th><th class="num">Kostpris i alt</th></tr></thead>
    <tbody>${lines.length
      ? lines.map(
          (l) => html`<tr><td class="cell-main"><strong>${l.name}</strong>${l.sku ? html`<span class="sku">${l.sku}</span>` : ''}</td>
        <td data-label="Kilde">${SOURCE_LABEL[l.source]}</td><td class="num" data-label="Mængde">${qtyUnit(l.qty, l.unit)}</td>
        <td class="num" data-label="Kostpris pr. enhed">${formatKr(l.unit_cost, { decimals: true })}</td><td class="num" data-label="Kostpris i alt">${formatKr(lineAmount(l.unit_cost, l.qty))}</td></tr>`,
        )
      : html`<tr><td colspan="5" class="empty">Intet forbrug.</td></tr>`}</tbody>
  </table></div>`;
}

export function jobBillingPage(d: {
  job: JobRow;
  consumption: ConsumptionLine[];
  open: ConsumptionLine[];
  bases: InvoiceBasisRow[];
  csrf: string;
  flashCode?: string;
  error?: string;
}): H {
  const j = d.job;
  const draft = d.bases.find((b) => b.status === 'kladde');
  return html`<div class="stack-lg">
  ${pageHead(html`<a href="/job/${j.id}">Job ${j.number}</a>`, `Fakturagrundlag: ${j.name}`, html`<a class="btn btn-ghost" href="/lager/faktura">← Alle job</a>`, [j.customer_name, j.site_address].filter(Boolean).join(' · '))}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}
  <section class="card stack">
    <div class="row-between"><h2>Ikke faktureret endnu</h2>
      <form method="post" action="/lager/faktura/job/${j.id}/kladde">${csrfField(d.csrf)}<button class="btn btn-primary" type="submit"${d.open.length || draft ? '' : ' disabled'}>${draft ? 'Opdatér kladden ud fra forbruget' : 'Opret kladde'}</button></form></div>
    <p class="muted small">Bygger på det faktiske forbrug: udleveret fra lager minus returneret, brugt fra arbejdsstedet og varer uden varenummer købt til jobbet. Det, der allerede er på et godkendt grundlag, er trukket fra, så intet tælles to gange.</p>
    ${consumptionTable(d.open)}
  </section>
  ${d.bases.length
    ? html`<section class="stack"><h2>Fakturagrundlag for jobbet</h2><div class="card card-flush"><div class="table-wrap"><table class="list stackable">
      <thead><tr><th>Grundlag</th><th>Status</th><th class="num">Salgspris</th><th>Godkendt</th></tr></thead>
      <tbody>${d.bases.map(
        (b) => html`<tr class="row-link" data-href="/lager/faktura/${b.id}"><td class="cell-main"><a class="title" href="/lager/faktura/${b.id}">Grundlag nr. ${b.id}</a></td><td data-label="Status">${basisTag(b)}</td>
        <td class="num" data-label="Salgspris">${b.status === 'godkendt' ? formatKr(b.total_sale) : '–'}</td><td data-label="Godkendt">${b.approved_at ? `${formatDateTime(b.approved_at)} af ${b.approved_by}` : '–'}</td></tr>`,
      )}</tbody></table></div></div></section>`
    : ''}
  <details class="card"><summary><strong>Hele jobbets materialeforbrug</strong></summary><div style="margin-top:12px">${consumptionTable(d.consumption)}</div></details>
</div>`;
}

export function basisPage(d: { basis: InvoiceBasisRow; lines: InvoiceLineRow[]; company: string; csrf: string; flashCode?: string; errs: string[] }): H {
  const b = d.basis;
  const c = parseCustomer(b.customer);
  const draft = b.status === 'kladde';
  const t = totals(d.lines);
  const id = b.id;
  return html`<div class="stack-lg">
  <div class="print-only"><strong>${d.company}</strong> · Fakturagrundlag nr. ${id}</div>
  ${pageHead(
    html`<a href="/lager/faktura/job/${b.job_id}">Job ${c.number}</a>`,
    html`Fakturagrundlag ${basisTag(b)}`,
    html`<span class="row no-print"><a class="btn btn-secondary" href="/lager/faktura/${id}.csv">Eksportér CSV</a><button class="btn btn-secondary" type="button" data-print>Udskriv / gem som PDF</button></span>`,
  )}
  ${flash(d.flashCode)}${errors(d.errs)}
  ${draft ? alert('info', 'Kladde: ret mængder og priser, og vælg hvad der skal faktureres. Ved godkendelse låses mængder og priser.') : alert('ok', `Godkendt ${formatDateTime(b.approved_at)} af ${b.approved_by}. Mængder og priser er låst.`)}
  <div class="card fields fields-2">
    <div><span class="muted small">Job</span><p><strong>${c.number} ${c.name}</strong><br>${c.site_address}</p></div>
    <div><span class="muted small">Kunde</span><p><strong>${c.customer_name || '–'}</strong><br>${[c.customer_address, c.customer_email, c.customer_phone].filter(Boolean).join(' · ')}</p></div>
  </div>
  <form method="post" action="/lager/faktura/${id}" class="stack">
    ${csrfField(d.csrf)}
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Med</th><th>Vare</th><th>Kilde</th><th class="num">Mængde</th><th class="num">Kostpris</th><th class="num">Salgspris</th><th class="num">Salg i alt</th></tr></thead>
      <tbody>${d.lines.length
        ? d.lines.map(
            (l) => html`<tr${l.include ? '' : html` style="opacity:.55"`}>
          <td data-label="Faktureres">${draft ? html`<input type="checkbox" name="inc_${l.id}" value="1"${l.include ? ' checked' : ''} aria-label="Faktureres: ${l.name}">` : l.include ? 'Ja' : 'Nej'}</td>
          <td class="cell-main"><strong>${l.name}</strong>${l.sku ? html`<span class="sku">${l.sku}</span>` : ''}</td>
          <td data-label="Kilde">${SOURCE_LABEL[l.source]}</td>
          <td class="num" data-label="Mængde">${draft ? html`<input class="in-num in-sm" name="qty_${l.id}" inputmode="decimal" value="${qtyInput(l.qty)}" aria-label="Mængde ${l.name}"> <span class="xs muted">${l.unit}</span>` : qtyUnit(l.qty, l.unit)}</td>
          <td class="num" data-label="Kostpris">${draft ? html`<input class="in-num in-sm" name="cost_${l.id}" inputmode="decimal" value="${oereToInput(l.unit_cost)}" aria-label="Kostpris ${l.name}">` : formatKr(l.unit_cost, { decimals: true })}</td>
          <td class="num" data-label="Salgspris">${draft ? html`<input class="in-num in-sm" name="price_${l.id}" inputmode="decimal" value="${oereToInput(l.unit_price)}" aria-label="Salgspris ${l.name}">` : formatKr(l.unit_price, { decimals: true })}</td>
          <td class="num" data-label="Salg i alt">${formatKr(lineAmount(l.unit_price, l.qty))}</td>
        </tr>`,
          )
        : html`<tr><td colspan="7" class="empty">Ingen linjer.</td></tr>`}</tbody>
      <tfoot><tr><td colspan="4"><strong>I alt (faktureres)</strong></td><td class="num">${formatKr(t.cost)}</td><td></td><td class="num"><strong>${formatKr(t.sale)}</strong></td></tr>
        <tr><td colspan="6" class="muted">Dækningsbidrag</td><td class="num">${formatKr(t.sale - t.cost)}</td></tr></tfoot>
    </table></div></div>
    <div class="field" style="max-width:640px"><label for="note">Bemærkning</label>${draft ? html`<textarea id="note" name="note" maxlength="1000">${b.note}</textarea>` : html`<p>${b.note || '–'}</p>`}</div>
    ${draft
      ? html`<div class="row no-print">
        <button class="btn btn-secondary" type="submit" name="do" value="gem">Gem ændringer</button>
        <button class="btn btn-primary" type="submit" name="do" value="godkend" data-confirm="Godkend fakturagrundlaget? Mængder og priser låses, og forbruget tælles ikke med igen.">Godkend</button>
        <button class="btn btn-danger" type="submit" name="do" value="slet" data-confirm="Slet kladden?" formnovalidate>Slet kladde</button>
      </div>`
      : ''}
  </form>
</div>`;
}
