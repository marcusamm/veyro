import { html } from 'hono/html';
import { STATUS_LABEL, label, type PoaRow } from '../lib/poa';
import type { NdaListRow, RequestRow } from '../lib/nda';
import type { H } from './layout';
import { ndaTable, requestList } from './nda';
import { flash } from './pages';
import { statusBadge } from './poa';

export function agreementsPage(args: { poas: PoaRow[]; canIssuePoa: boolean; ndas: NdaListRow[]; ndaRequests: RequestRow[]; terms: H; flashKey?: string }): H {
  const live = args.poas.filter((p) => p.status === 'active' || p.status === 'pending');
  return html`<div class="stack-lg">
  <div><h1>Aftaler og dokumenter</h1>
    <p class="lead">Her finder du de aftaler og dokumenter, din virksomhed har med Veyro.</p></div>
  ${flash(args.flashKey)}
  <div class="grid grid-2" style="align-items:start">
    ${args.terms}
    <section class="card stack" aria-labelledby="fm-h">
      <h2 id="fm-h">Fuldmagter</h2>
      <p class="small">Giv Veyro fuldmagt til konkrete opgaver, og tilbagekald den når som helst.</p>
      ${args.poas.length
        ? html`<ul class="list">${args.poas.slice(0, 5).map(
            (p) => html`<li><div class="item-head"><a href="/konto/fuldmagter/${p.id}"><strong>${label(p)}</strong></a>${statusBadge(p.status)}</div><div class="meta">${p.company_name ?? ''}${p.project ? ` · ${p.project}` : ''}</div></li>`,
          )}</ul>
          <p class="meta">${live.length} ${live.length === 1 ? 'fuldmagt er' : 'fuldmagter er'} ${STATUS_LABEL.active.toLowerCase()} eller afventer.</p>`
        : html`<p class="muted small">Ingen fuldmagter endnu.</p>`}
      <div class="row">
        <a class="btn btn-secondary" href="/konto/fuldmagter">Alle fuldmagter</a>
        ${args.canIssuePoa ? html`<a class="btn btn-primary" href="/konto/fuldmagter/ny">Ny fuldmagt</a>` : ''}
      </div>
    </section>
  </div>
  <section class="card stack" aria-labelledby="nda-h">
    <div class="item-head"><h2 id="nda-h" style="margin:0">Fortrolighedsaftaler</h2><a class="small" href="/konto/nda">Alle fortrolighedsaftaler</a></div>
    <p class="small" style="margin:0">Gensidige aftaler (NDA), der beskytter både jeres og Veyros fortrolige oplysninger.</p>
    ${args.ndas.length ? ndaTable(args.ndas) : html`<p class="muted small">Ingen fortrolighedsaftaler endnu. Veyro opretter aftalen, når I aftaler det.</p>`}
    ${args.ndaRequests.length
      ? html`<h3 style="margin:8px 0 0">Anmodninger om sletning og tilbagelevering</h3>${requestList(args.ndaRequests, '/konto/nda')}`
      : ''}
  </section>
</div>`;
}
