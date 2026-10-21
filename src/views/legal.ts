import { html } from 'hono/html';
import { formatDate } from '../lib/format';
import { LEGAL_DOCS, LEGAL_VERSION, isCurrent, type Acceptance, type LegalDocKey } from '../lib/legal';
import { csrfField, type H } from './layout';

const link = (d: (typeof LEGAL_DOCS)[number]) => html`<a href="${d.url}" target="_blank" rel="noopener">${d.title.toLowerCase()}</a>`;

/** "Veyros handels- og abonnementsbetingelser og databehandleraftale" med links (til afkrydsningsfelter). */
export function legalLinks(): H {
  return html`Veyros ${link(LEGAL_DOCS[0])} og ${link(LEGAL_DOCS[1])}`;
}

/** Afkrydsningsfelt til accept af betingelser og databehandleraftale. */
export function acceptField(checked = false): H {
  return html`<label class="check"><input type="checkbox" name="accept" value="1" required${checked ? html` checked` : ''}>
    Jeg accepterer på virksomhedens vegne ${legalLinks()}.</label>`;
}

/** Kort i kundepanelets overblik: hvad kunden har accepteret, eller en knap til at acceptere den nye version. */
export function agreementsCard(args: { csrf: string; accepted: Partial<Record<LegalDocKey, Acceptance>> }): H {
  const current = isCurrent(args.accepted);
  return html`<section class="card stack" id="aftaler" aria-labelledby="aftaler-h">
  <h2 id="aftaler-h">Aftaler</h2>
  <ul class="list">
    ${LEGAL_DOCS.map((d) => {
      const a = args.accepted[d.key];
      return html`<li><div class="item-head"><a href="${d.url}" target="_blank" rel="noopener"><strong>${d.title}</strong></a>
        ${a?.version === LEGAL_VERSION
          ? html`<span class="badge b-ok">Accepteret</span>`
          : html`<span class="badge b-warn">${a ? 'Ny version' : 'Afventer accept'}</span>`}</div>
        <div class="meta">${a ? `Version ${a.version} accepteret ${formatDate(a.accepted_at)}` : 'Ikke accepteret endnu'}</div></li>`;
    })}
  </ul>
  ${current
    ? ''
    : html`<form method="post" action="/konto/vilkaar" class="stack">
        ${csrfField(args.csrf)}
        ${acceptField()}
        <button class="btn btn-primary" type="submit" data-loading="Gemmer …">Accepter</button>
      </form>`}
  <p class="small muted">Databehandleraftalen gælder, når vi behandler personoplysninger på jeres vegne, fx ordrer og kundedata i systemer, vi hoster for jer. <a href="https://veyro.dk/pages/sla">Se også vores serviceniveau (SLA)</a>.</p>
</section>`;
}
