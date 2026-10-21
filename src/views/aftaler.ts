import { html } from 'hono/html';
import { STATUS_LABEL, label, type PoaRow } from '../lib/poa';
import type { H } from './layout';
import { statusBadge } from './poa';

export function agreementsPage(args: { poas: PoaRow[]; canIssuePoa: boolean }): H {
  const live = args.poas.filter((p) => p.status === 'active' || p.status === 'pending');
  return html`<div class="stack-lg">
  <div><h1>Aftaler og dokumenter</h1>
    <p class="lead">Her finder du de aftaler og dokumenter, din virksomhed har med Veyro.</p></div>
  <div class="grid grid-2" style="align-items:start">
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
</div>`;
}
