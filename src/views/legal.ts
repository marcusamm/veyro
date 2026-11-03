import { html } from 'hono/html';
import { formatDate } from '../lib/format';
import { LEGAL_DOCS, acceptedVersionApplies, legalDocumentUrl, type Acceptance, type LegalDocKey, type LegalDocument } from '../lib/legal';
import { csrfField, type H } from './layout';

const link = (d: (typeof LEGAL_DOCS)[number]) => html`<a href="${d.url}" target="_blank" rel="noopener">${d.title.toLowerCase()}</a>`;

/** "Veyros handels- og abonnementsbetingelser og databehandleraftale" med links (til afkrydsningsfelter). */
export function legalLinks(documents: readonly LegalDocument[] = LEGAL_DOCS): H {
  return html`Veyros ${documents.map((document, index) => html`${index ? ' og ' : ''}${link(document)}`)}`;
}

/** Afkrydsningsfelt til accept af betingelser og databehandleraftale. */
export function acceptField(checked = false, documents: readonly LegalDocument[] = LEGAL_DOCS): H {
  return html`<label class="check consent-check"><input type="checkbox" name="accept" value="1" required${checked ? html` checked` : ''}>
    <span>Jeg accepterer på virksomhedens vegne ${legalLinks(documents)}.</span></label>`;
}

/** Kendte, fortsat gældende versioner bevares; øvrige dokumenter kræver ny accept. */
export function agreementsCard(args: { csrf: string; accepted: Partial<Record<LegalDocKey, Acceptance>>; next?: 'aftaler' }): H {
  const pending = LEGAL_DOCS.filter(d => !acceptedVersionApplies(d, args.accepted[d.key]?.version));
  return html`<section class="card stack" id="aftaler" aria-labelledby="aftaler-h">
  <h2 id="aftaler-h">Betingelser og databehandleraftale</h2>
  <ul class="list">
    ${LEGAL_DOCS.map((d) => {
      const a = args.accepted[d.key];
      const applies = acceptedVersionApplies(d, a?.version);
      const unknown = !!a && !applies;
      return html`<li><div class="item-head"><a href="${legalDocumentUrl(d, a?.version)}" target="_blank" rel="noopener"><strong>${d.title}${unknown ? ' (aktuel tekst)' : ''}</strong></a>
        ${applies
          ? html`<span class="badge b-ok">Accepteret</span>`
          : html`<span class="badge b-warn">${a ? 'Tidligere accept' : 'Afventer accept'}</span>`}</div>
        <div class="meta">${a ? `Version ${a.version} accepteret ${formatDate(a.accepted_at)}` : 'Ikke accepteret endnu'}</div>
        ${unknown ? html`<p class="small muted">Teksten for den accepterede version er ikke tilgængelig her. Linket viser de aktuelle vilkår; det ændrer ikke jeres eksisterende aftale.</p>` : ''}</li>`;
    })}
  </ul>
  ${pending.length
    ? html`<form method="post" action="/konto/vilkaar" class="stack">
        ${csrfField(args.csrf)}
        ${args.next ? html`<input type="hidden" name="next" value="${args.next}">` : ''}
        ${acceptField(false, pending)}
        <button class="btn btn-primary" type="submit" data-loading="Gemmer …">Accepter</button>
      </form>` : ''}
  <p class="small muted">Databehandleraftalen gælder, når vi behandler personoplysninger på jeres vegne, fx ordrer og kundedata i systemer, vi hoster for jer. <a href="https://veyro.dk/pages/sla">Se også vores serviceniveau (SLA)</a>.</p>
</section>`;
}
