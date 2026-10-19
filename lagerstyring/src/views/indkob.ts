import { html } from 'hono/html';
import type { JobRow, MailRow, SupplierRow, User } from '../env';
import { formatDateTime, formatDay, formatKr, formatQty, lineAmount, oereToInput, qtyInput, qtyUnit, todayDk } from '../lib/format';
import { lineStatus, listStatus, outstanding, type LineView, type ListOverview } from '../lib/purchasing';
import { errors, flash, lineTag, mailFlash, mailTag, pageHead } from './common';
import { alert, csrfField, opField, type H } from './layout';

type ProductOpt = { id: number; sku: string; name: string; unit: string };

function bySupplier(lines: LineView[]): [string, LineView[]][] {
  const groups = new Map<string, LineView[]>();
  for (const l of lines) {
    const k = l.supplier_name ?? 'Uden leverandør';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  return [...groups];
}

function target(l: LineView): H {
  return l.job_id ? html`<a href="/job/${l.job_id}">${l.job_number}</a>` : html`<span class="tag">Lager</span>`;
}

function sentInfo(l: ListOverview): H {
  if (!l.last_sent_at) return html`<span class="muted">Ikke sendt</span>`;
  const changed = l.last_sent_version !== null && l.last_sent_version < l.version;
  return html`<span class="small">${mailTag(l.last_sent_status ?? 'sendt')} ${formatDateTime(l.last_sent_at)}${changed ? html` <span class="tag tag-low">Ændret siden</span>` : ''}</span>`;
}

export function purchasingPage(d: {
  toOrder: LineView[];
  lists: ListOverview[];
  jobs: Pick<JobRow, 'id' | 'number' | 'name'>[];
  archived: boolean;
  csrf: string;
  ops: string[];
  flashCode?: string;
  mail?: { status: string; to: string };
  error?: string;
}): H {
  const groups = bySupplier(d.toOrder);
  const notOrdered = d.mail && d.mail.status !== 'sendt' && !d.flashCode;
  return html`<div class="stack-lg">
  ${pageHead('Lagerportal', 'Indkøb', html`<a class="btn btn-secondary" href="/lager/modtagelse">Varemodtagelse</a>`, 'Send bestillingen til leverandøren på e-mail, eller registrér en bestilling, du har lavet på anden vis.')}
  ${flash(d.flashCode)}${d.mail ? mailFlash(d.mail.status, d.mail.to) : ''}${notOrdered ? alert('warn', 'Bestillingen er ikke registreret, fordi e-mailen ikke er sendt.') : ''}${d.error ? alert('err', d.error) : ''}
  <section class="stack">
    <h2>Til bestilling</h2>
    ${groups.length
      ? groups.map(
          ([sup, lines], gi) => html`<form method="post" action="/lager/indkob/bestil" class="card card-flush">
        ${csrfField(d.csrf)}${opField(d.ops[gi] ?? '')}
        <div class="row-between" style="padding:16px 16px 8px"><h3>${sup}</h3><span class="muted small">${lines.length} ${lines.length === 1 ? 'linje' : 'linjer'}</span></div>
        <div class="table-wrap"><table class="list stackable dense">
          <thead><tr><th>Vare</th><th>Til</th><th class="num">Ønsket</th><th class="num">Bestilt</th><th>Status</th><th class="num">Forv. pris</th><th class="num">Bestil nu</th><th>Forventet levering</th></tr></thead>
          <tbody>${lines.map(
            (l) => html`<tr>
            <td class="cell-main"><strong>${l.name}</strong>${l.sku ? html`<span class="sku">${l.sku}</span>` : html`<small>Uden varenummer</small>`}${l.note ? html`<small>${l.note}</small>` : ''}</td>
            <td data-label="Til">${target(l)} <a class="xs" href="/lager/indkob/${l.list_id}">${l.list_name}</a>${l.deliver_to === 'arbejdssted' ? html`<small>Levering til arbejdssted</small>` : ''}</td>
            <td class="num" data-label="Ønsket">${qtyUnit(l.qty, l.unit)}</td>
            <td class="num" data-label="Bestilt">${formatQty(l.ordered)}</td>
            <td data-label="Status">${lineTag(lineStatus(l))}</td>
            <td class="num" data-label="Forv. pris">${l.unit_price === null ? '–' : formatKr(l.unit_price)}</td>
            <td class="num" data-label="Bestil nu"><input class="in-num in-sm" name="o_${l.id}" inputmode="decimal" value="${l.ready ? qtyInput(l.qty - l.ordered) : ''}" placeholder="${qtyInput(l.qty - l.ordered)}" aria-label="Bestil nu, ${l.name}"></td>
            <td data-label="Forventet"><input class="in-sm" type="date" name="d_${l.id}" value="${l.expected_date}" aria-label="Forventet levering, ${l.name}"></td>
          </tr>`,
          )}</tbody>
        </table></div>
        <div class="row" style="padding:12px 16px 16px;flex-wrap:wrap">
          <input name="ref" maxlength="60" placeholder="Ordrenummer eller reference" style="max-width:280px" aria-label="Ordrenummer eller reference">
          ${lines[0]!.supplier_email
            ? html`<button class="btn btn-primary" type="submit" formaction="/lager/indkob/bestil-mail" data-confirm="Send bestillingen til ${sup} (${lines[0]!.supplier_email})?">Send bestilling til ${sup}</button>`
            : ''}
          <button class="btn ${lines[0]!.supplier_email ? 'btn-secondary' : 'btn-dark'}" type="submit">Registrér bestilling hos ${sup}</button>
        </div>
        <p class="hint" style="padding:0 16px 16px">${lines[0]!.supplier_email
          ? html`"Send bestilling" sender varer, antal og leveringsadresse (uden priser) til ${lines[0]!.supplier_email} og registrerer dem som bestilt. Svar fra ${sup} går til dig.`
          : lines[0]!.supplier_id
            ? html`Tilføj ${sup}s e-mail under <a href="/lager/indstillinger">Indstillinger</a> for at sende bestillingen direkte herfra.`
            : ''} Linjer markeret "Klar til indkøb" er udfyldt med hele mængden. Tomme felter bestilles ikke.</p>
      </form>`,
        )
      : html`<div class="card"><p class="muted">Der er intet, der mangler at blive bestilt.</p></div>`}
  </section>
  <section class="stack">
    <div class="row-between"><h2>Indkøbslister</h2>
      <nav class="tabs"><a href="/lager/indkob"${d.archived ? '' : html` aria-current="page"`}>Aktive</a><a href="/lager/indkob?arkiv=1"${d.archived ? html` aria-current="page"` : ''}>Arkiverede</a></nav></div>
    <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
      <thead><tr><th>Liste</th><th>Job</th><th>Status</th><th class="num">Linjer</th><th class="num">Forventet beløb</th><th>Ønsket levering</th><th>Sendt</th></tr></thead>
      <tbody>${d.lists.length
        ? d.lists.map(
            (l) => html`<tr class="row-link" data-href="/lager/indkob/${l.id}">
          <td class="cell-main"><a class="title" href="/lager/indkob/${l.id}">${l.name}</a></td>
          <td data-label="Job">${l.job_id ? html`${l.job_number} ${l.job_name}` : html`<span class="tag">Lageropfyldning</span>`}</td>
          <td data-label="Status">${lineTag(l.status)}</td>
          <td class="num" data-label="Linjer">${l.line_count}</td>
          <td class="num" data-label="Beløb">${formatKr(l.total)}</td>
          <td data-label="Ønsket levering">${formatDay(l.wanted_date)}</td>
          <td data-label="Sendt">${sentInfo(l)}</td>
        </tr>`,
          )
        : html`<tr><td colspan="7" class="empty">Ingen lister.</td></tr>`}</tbody>
    </table></div></div>
  </section>
  <form method="post" action="/lager/indkob/ny" class="card stack" style="max-width:720px">
    ${csrfField(d.csrf)}
    <h2>Ny indkøbsliste</h2>
    <div class="fields fields-2">
      <div class="field"><label for="nl-job">Til</label><select id="nl-job" name="job_id"><option value="">Lageropfyldning</option>${d.jobs.map(
        (j) => html`<option value="${j.id}">${j.number} ${j.name}</option>`,
      )}</select></div>
      <div class="field"><label for="nl-name">Navn</label><input id="nl-name" name="name" maxlength="80" required placeholder="Fx Materialer til tag"></div>
    </div>
    <button class="btn btn-secondary" type="submit">Opret liste</button>
  </form>
</div>`;
}

function lineEditor(l: LineView, d: { csrf: string; suppliers: SupplierRow[]; isJob: boolean; op: string; op2: string }): H {
  if (l.cancelled) return html``;
  const st = lineStatus(l);
  return html`<details class="act"><summary>Ret</summary><div class="act-body">
    <form method="post" action="/lager/indkob/linje/${l.id}" class="stack" style="display:grid">
      ${csrfField(d.csrf)}${opField(d.op)}
      <div class="fields fields-2">
        <div class="field"><label>Mængde (${l.unit})</label><input class="in-num" name="qty" inputmode="decimal" value="${qtyInput(Math.max(l.qty, l.ordered))}" required></div>
        <div class="field"><label>Forventet pris pr. enhed</label><input class="in-num" name="price" inputmode="decimal" value="${l.unit_price === null ? '' : oereToInput(l.unit_price)}"></div>
      </div>
      <div class="field"><label>Leverandør</label><select name="supplier_id"><option value="">Ingen</option>${d.suppliers.map(
        (s) => html`<option value="${s.id}"${s.id === l.supplier_id ? html` selected` : ''}>${s.name}</option>`,
      )}</select></div>
      <div class="field"><label>Forventet levering</label><input type="date" name="expected_date" value="${l.expected_date}"></div>
      ${d.isJob && l.product_id
        ? html`<div class="field"><label>Leveres til</label><select name="deliver_to"><option value="lager"${l.deliver_to === 'lager' ? html` selected` : ''}>Hovedlageret (reserveres til jobbet)</option><option value="arbejdssted"${l.deliver_to === 'arbejdssted' ? html` selected` : ''}>Direkte til arbejdsstedet</option></select></div>`
        : html`<input type="hidden" name="deliver_to" value="${l.deliver_to}">`}
      <div class="field"><label>Bemærkning</label><input name="note" maxlength="200" value="${l.note}"></div>
      <button class="btn btn-dark btn-small" type="submit">Gem linje</button>
    </form>
    ${st === 'kladde' || st === 'klar'
      ? html`<form method="post" action="/lager/indkob/linje/${l.id}/klar">${csrfField(d.csrf)}${opField(d.op2)}<input type="hidden" name="ready" value="${l.ready ? '0' : '1'}"><button class="btn btn-secondary btn-small" type="submit">${l.ready ? 'Tilbage til kladde' : 'Markér klar til indkøb'}</button></form>`
      : ''}
    ${outstanding(l) > 0
      ? html`<form method="post" action="/lager/indkob/linje/${l.id}/annuller" data-confirm="${l.job_id && l.product_id ? 'Annullér resten af linjen? Jobbets behov bliver mindre tilsvarende.' : 'Annullér resten af linjen?'}">${csrfField(d.csrf)}${opField(d.op2)}<button class="btn btn-danger btn-small" type="submit">Annullér resten</button></form>`
      : ''}
  </div></details>`;
}

export function listPage(d: {
  list: ListOverview;
  lines: LineView[];
  suppliers: SupplierRow[];
  products: ProductOpt[];
  users: User[];
  mails: MailRow[];
  csrf: string;
  ops: string[];
  flashCode?: string;
  mail?: { status: string; to: string };
  error?: string;
  errs?: string[];
  estimate?: H;
}): H {
  const l = d.list;
  const isJob = !!l.job_id;
  const live = d.lines.filter((x) => !x.cancelled);
  const total = live.reduce((s, x) => s + lineAmount(x.unit_price, Math.max(x.qty, x.ordered)), 0);
  const drafts = live.filter((x) => !x.ready && !x.ordered).length;
  const changed = l.last_sent_version !== null && l.last_sent_version < l.version;
  let op = 0;
  const nextOp = () => d.ops[op++] ?? '';
  return html`<div class="stack-lg">
  ${pageHead(
    isJob ? html`Indkøbsliste · <a href="/job/${l.job_id}">${l.job_number} ${l.job_name}</a>` : 'Indkøbsliste · lageropfyldning',
    html`${l.name} ${lineTag(listStatus(d.lines))}`,
    html`<a class="btn btn-ghost" href="/lager/indkob">← Indkøb</a>`,
  )}
  ${flash(d.flashCode)}${d.mail ? mailFlash(d.mail.status, d.mail.to) : ''}${d.error ? alert('err', d.error) : ''}${errors(d.errs ?? [])}
  ${l.last_sent_at
    ? alert(changed ? 'warn' : 'info', html`Senest sendt ${formatDateTime(l.last_sent_at)} til ${l.last_sent_to} (version ${l.last_sent_version}). ${changed ? html`<strong>Listen er ændret siden</strong> (nu version ${l.version}).` : 'Listen er uændret siden.'}`)
    : ''}
  ${l.archived ? alert('info', 'Listen er arkiveret.') : ''}
  <div class="card card-flush">
    <div class="table-wrap"><table class="list stackable dense">
      <thead><tr><th>Vare</th><th>Til</th><th class="num">Mængde</th><th class="num">Forv. pris</th><th class="num">Beløb</th><th class="num">Bestilt</th><th class="num">Modtaget</th><th class="num">Udestår</th><th>Forventet</th><th>Status</th><th></th></tr></thead>
      <tbody>${d.lines.length
        ? bySupplier(d.lines).map(
            ([sup, lines]) => html`<tr class="sup-head"><td colspan="11">${sup}</td></tr>${lines.map((x) => {
              const q = Math.max(x.qty, x.ordered);
              return html`<tr${x.cancelled ? html` style="opacity:.55"` : ''}>
            <td class="cell-main"><strong>${x.name}</strong>${x.sku ? html`<span class="sku">${x.sku}</span>` : html`<small>Uden varenummer</small>`}${x.auto ? html`<small>Automatisk fra jobbets mangel</small>` : ''}${x.note ? html`<small>${x.note}</small>` : ''}</td>
            <td data-label="Til">${target(x)}${x.deliver_to === 'arbejdssted' ? html`<small>Til arbejdssted</small>` : ''}</td>
            <td class="num" data-label="Mængde">${qtyUnit(q, x.unit)}</td>
            <td class="num" data-label="Forv. pris">${x.unit_price === null ? '–' : formatKr(x.unit_price)}</td>
            <td class="num" data-label="Beløb">${x.unit_price === null ? '–' : formatKr(lineAmount(x.unit_price, q))}</td>
            <td class="num" data-label="Bestilt">${formatQty(x.ordered)}${x.order_ref ? html`<small>${x.order_ref}</small>` : ''}</td>
            <td class="num" data-label="Modtaget">${formatQty(x.received)}</td>
            <td class="num" data-label="Udestår">${formatQty(outstanding(x))}</td>
            <td data-label="Forventet">${formatDay(x.expected_date)}</td>
            <td data-label="Status">${lineTag(lineStatus(x))}</td>
            <td>${l.archived ? '' : lineEditor(x, { csrf: d.csrf, suppliers: d.suppliers, isJob, op: nextOp(), op2: nextOp() })}</td>
          </tr>`;
            })}`,
          )
        : html`<tr><td colspan="11" class="empty">Listen er tom.</td></tr>`}</tbody>
    </table></div>
    <div class="row-between" style="padding:14px 16px;border-top:1px solid var(--line)"><span class="muted">Forventet beløb i alt (egne forventede priser)</span><strong>${formatKr(total)}</strong></div>
  </div>
  ${d.estimate ?? ''}
  ${drafts && !l.archived
    ? html`<form method="post" action="/lager/indkob/${l.id}/klar" class="row">${csrfField(d.csrf)}${opField(nextOp())}<button class="btn btn-secondary" type="submit">Markér ${drafts} ${drafts === 1 ? 'kladde' : 'kladder'} klar til indkøb</button></form>`
    : ''}
  <div class="grid grid-2">
    ${l.archived
      ? ''
      : html`<form method="post" action="/lager/indkob/${l.id}/linje" class="card stack">
      ${csrfField(d.csrf)}${opField(nextOp())}
      <h2>Tilføj vare</h2>
      <div class="field"><label for="al-p">Vare fra lageret</label><select id="al-p" name="product_id"><option value="">Vare uden varenummer (skriv nedenfor)</option>${d.products.map(
        (p) => html`<option value="${p.id}">${p.name} (${p.sku})</option>`,
      )}</select></div>
      <div class="fields fields-3">
        <div class="field"><label for="al-n">Navn</label><input id="al-n" name="name" maxlength="120" placeholder="Kun uden varenummer"></div>
        <div class="field"><label for="al-s">Varenr.</label><input id="al-s" name="sku" maxlength="40"></div>
        <div class="field"><label for="al-u">Enhed</label><input id="al-u" name="unit" maxlength="20" placeholder="stk."></div>
      </div>
      <div class="fields fields-3">
        <div class="field"><label for="al-q">Mængde</label><input id="al-q" class="in-num" name="qty" inputmode="decimal" required></div>
        <div class="field"><label for="al-pr">Forv. pris (kr.)</label><input id="al-pr" class="in-num" name="price" inputmode="decimal"></div>
        <div class="field"><label for="al-sup">Leverandør</label><select id="al-sup" name="supplier_id"><option value="">Varens leverandør</option>${d.suppliers.map(
          (s) => html`<option value="${s.id}">${s.name}</option>`,
        )}</select></div>
      </div>
      ${isJob
        ? html`<div class="field"><label for="al-d">Leveres til</label><select id="al-d" name="deliver_to"><option value="lager">Hovedlageret (reserveres til jobbet ved modtagelse)</option><option value="arbejdssted">Direkte til arbejdsstedet</option></select></div>`
        : html`<input type="hidden" name="deliver_to" value="lager">`}
      <div class="field"><label for="al-note">Bemærkning</label><input id="al-note" name="note" maxlength="200"></div>
      <button class="btn btn-primary" type="submit">Tilføj</button>
    </form>`}
    <div class="stack-lg">
      <form method="post" action="/lager/indkob/${l.id}/send" class="card stack">
        ${csrfField(d.csrf)}
        <h2>Send indkøbsliste</h2>
        <p class="muted small">Sendes som orientering til ejer, indkøber eller medarbejder. Afsendelsen ændrer ikke status til bestilt. Priser og prisestimat medtages kun til modtagere, der må se dem.</p>
        <div class="field"><label for="sl-to">Modtager</label><select id="sl-to" name="user_id">${d.users.map(
          (u) => html`<option value="${u.id}">${u.name} (${u.role === 'medarbejder' ? 'medarbejder, uden priser' : u.role === 'ejer' ? 'ejer' : 'indkøber'})</option>`,
        )}</select></div>
        <label class="check"><input type="checkbox" name="split" value="1"> Opdel prisestimatet efter forhandler</label>
        <button class="btn btn-dark" type="submit">Send indkøbsliste</button>
      </form>
      <form method="post" action="/lager/indkob/${l.id}" class="card stack">
        ${csrfField(d.csrf)}
        <h2>Om listen</h2>
        <div class="field"><label for="ll-n">Navn</label><input id="ll-n" name="name" maxlength="80" required value="${l.name}"></div>
        <div class="fields fields-2">
          <div class="field"><label for="ll-r">Indkøbsansvarlig</label><select id="ll-r" name="responsible"><option value="">Ikke valgt</option>${d.users
            .filter((u) => u.role !== 'medarbejder')
            .map((u) => html`<option value="${u.email}"${u.email === l.responsible ? html` selected` : ''}>${u.name}</option>`)}</select></div>
          <div class="field"><label for="ll-w">Ønsket levering</label><input id="ll-w" type="date" name="wanted_date" value="${l.wanted_date}" min="${todayDk()}"></div>
        </div>
        <div class="field"><label for="ll-note">Bemærkning</label><textarea id="ll-note" name="note" maxlength="500">${l.note}</textarea></div>
        <div class="row"><button class="btn btn-secondary" type="submit">Gem</button>
          <button class="btn btn-ghost" type="submit" name="archive" value="${l.archived ? '0' : '1'}" formaction="/lager/indkob/${l.id}/arkiver">${l.archived ? 'Genåbn listen' : 'Arkivér listen'}</button></div>
      </form>
      <div class="card stack">
        <h2>Afsendelser</h2>
        ${d.mails.length
          ? html`<ul class="app-log">${d.mails.map((m) => html`<li><span>${m.recipient} ${mailTag(m.status)}</span><em>${formatDateTime(m.created_at)} · version ${m.list_version}</em></li>`)}</ul>`
          : html`<p class="muted small">Listen er ikke sendt endnu.</p>`}
      </div>
    </div>
  </div>
</div>`;
}

export function receivingPage(d: { lines: LineView[]; csrf: string; ops: string[]; flashCode?: string; error?: string }): H {
  const groups = bySupplier(d.lines);
  return html`<div class="stack-lg">
  ${pageHead('Lagerportal', 'Varemodtagelse', '', 'Bestilte varer lægges først på lageret, når de er modtaget. Delvise leveringer registreres med den mængde, der er kommet.')}
  ${flash(d.flashCode)}${d.error ? alert('err', d.error) : ''}
  ${groups.length
    ? groups.map(
        ([sup, lines], gi) => html`<form method="post" action="/lager/modtagelse" class="card card-flush">
      ${csrfField(d.csrf)}${opField(d.ops[gi] ?? '')}
      <div style="padding:16px 16px 8px"><h3>${sup}</h3></div>
      <div class="table-wrap"><table class="list stackable dense">
        <thead><tr><th>Vare</th><th>Til</th><th class="num">Bestilt</th><th class="num">Modtaget</th><th class="num">Udestår</th><th>Forventet</th><th class="num">Modtaget nu</th><th class="num">Faktisk pris</th></tr></thead>
        <tbody>${lines.map(
          (l) => html`<tr>
          <td class="cell-main"><strong>${l.name}</strong>${l.sku ? html`<span class="sku">${l.sku}</span>` : ''}${l.order_ref ? html`<small>Ordre ${l.order_ref}</small>` : ''}</td>
          <td data-label="Til">${target(l)}${l.deliver_to === 'arbejdssted' ? html`<small>Leveres til arbejdsstedet (ikke hovedlageret)</small>` : l.job_id ? html`<small>Reserveres til jobbet</small>` : ''}</td>
          <td class="num" data-label="Bestilt">${qtyUnit(l.ordered, l.unit)}</td>
          <td class="num" data-label="Modtaget">${formatQty(l.received)}</td>
          <td class="num" data-label="Udestår"><strong>${formatQty(l.ordered - l.received)}</strong></td>
          <td data-label="Forventet">${formatDay(l.expected_date)}</td>
          <td class="num" data-label="Modtaget nu"><input class="in-num in-sm" name="r_${l.id}" inputmode="decimal" placeholder="${qtyInput(l.ordered - l.received)}" aria-label="Modtaget nu, ${l.name}"></td>
          <td class="num" data-label="Faktisk pris"><input class="in-num in-sm" name="p_${l.id}" inputmode="decimal" placeholder="${l.unit_price === null ? '' : oereToInput(l.unit_price)}" aria-label="Faktisk pris, ${l.name}"></td>
        </tr>`,
        )}</tbody>
      </table></div>
      <div class="row" style="padding:12px 16px 16px"><button class="btn btn-primary" type="submit">Registrér modtagelse fra ${sup}</button></div>
    </form>`,
      )
    : html`<div class="card"><p class="muted">Der er ingen bestilte varer, der venter på at blive modtaget.</p></div>`}
  <p class="muted small">Varer uden indkøbsliste kan modtages direkte på varen under Varer og lager.</p>
</div>`;
}
