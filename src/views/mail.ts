// Mailkonti (Gmail), gennemgang af mulige mails og mailsamtaler på et kundeemne.
// Mailindhold vises kun som ren tekst (escapet). Billeder, links og HTML fra mails indlæses aldrig.
import { html } from 'hono/html';
import { formatDateTime } from '../lib/format';
import type { MailAccountRow, MessageRow, ThreadRow } from '../lib/gmail-sync';
import { staffName } from '../lib/prospects';
import { alert, csrfField, type H } from './layout';

export const ACCOUNT_STATUS: Record<MailAccountRow['status'], [string, string]> = {
  ikke_forbundet: ['Ikke forbundet', 'b-neutral'],
  forbundet: ['Forbundet', 'b-ok'],
  fejl: ['Fejl, prøver igen', 'b-warn'],
  genforbind: ['Skal forbindes igen', 'b-err'],
};

export const MAIL_FLASH: Record<string, string> = {
  forbundet: 'Kontoen er forbundet. Den første synkronisering er kørt; nye mails hentes derefter automatisk hvert 10. minut.',
  afbrudt: 'Forbindelsen er afbrudt, og adgangen er tilbagekaldt hos Google. Allerede tilknyttede samtaler bliver liggende på kundeemnerne.',
  synkroniseret: 'Synkroniseringen er kørt.',
  bekraeftet: 'Samtalen er bekræftet og knyttet til kundeemnet.',
  afvist: 'Samtalen er fjernet og tilknyttes ikke igen automatisk. Originalen i Gmail er ikke berørt.',
  tildelt: 'Samtalen er tildelt.',
  annulleret: 'Forbindelsen blev ikke oprettet (afvist eller annulleret hos Google).',
  knyttet: 'Samtalen er knyttet til kundeemnet.',
};

export const MAIL_ERRORS: Record<string, string> = {
  opsaetning: 'Google-integrationen er ikke sat op endnu. Se, hvad der mangler, øverst på siden.',
  adgang: 'Du kan kun bruge din egen postkasse og fælles postkasser.',
  state: 'Forbindelsen udløb eller blev startet af en anden. Prøv igen.',
  forkert: 'Du loggede ind med en anden Google-konto end den, der skulle forbindes. Prøv igen og vælg den rigtige konto.',
  token: 'Google sendte ikke en varig adgang. Prøv igen; samtykket skal gives på ny.',
  rettighed: 'Læseadgang til Gmail blev ikke givet. Uden den kan mails ikke matches.',
  google: 'Google svarede med en fejl. Prøv igen om lidt.',
  sync: 'Synkroniseringen fejlede. Se fejlen ved kontoen.',
};

export function mailAccountsPage(a: {
  csrf: string;
  me: string;
  setup: { ready: boolean; missing: string[] };
  redirectUri: string;
  accounts: (MailAccountRow & { canUse: boolean; shared: boolean; compose: boolean })[];
  review: (ThreadRow & { prospect_company: string | null; froms: string })[];
  flash: string | null;
  error: string | null;
  isStaff: (e: string) => boolean;
}): H {
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin">Admin</a> / <a href="/admin/kundeemner">Kundeemner</a> / Mailkonti</p><h1>Mailkonti</h1>
    <p class="lead">Gmail forbindes med Googles officielle login (OAuth). Veyro får kun lov at læse mails og, hvis det slås til, oprette kladder. Der sendes aldrig mails herfra. Kun samtaler med kendte kundeemner og kunder gemmes i Veyro.</p></div>
  ${a.flash && MAIL_FLASH[a.flash] ? alert('ok', MAIL_FLASH[a.flash]!) : ''}
  ${a.error ? alert('err', MAIL_ERRORS[a.error] ?? 'Noget gik galt.') : ''}
  ${a.setup.ready
    ? ''
    : alert('warn', html`<strong>Ikke forbundet: Google-integrationen er ikke sat op.</strong> Der hentes ingen mails, før det er gjort. Mangler: ${a.setup.missing.join(', ')}.
        Opsætningen kræver et Google Cloud-projekt i Veyros Google Workspace (se README, afsnittet "Kundeemner og Gmail"). Godkendt omdirigeringsadresse: <code>${a.redirectUri}</code>`)}
  <section class="card stack" aria-labelledby="acc-h">
    <h2 id="acc-h" class="h-small" style="margin:0">Konti</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Konto</th><th>Status</th><th>Rettigheder</th><th>Seneste synkronisering</th><th>Handling</th></tr></thead>
      <tbody>${a.accounts.map((acc) => {
        const [label, cls] = ACCOUNT_STATUS[acc.status];
        const enc = encodeURIComponent(acc.email);
        return html`<tr>
          <td><strong>${acc.email}</strong><div class="meta">${acc.shared ? 'Fælles postkasse' : `Personlig (${staffName(acc.email)})`}${a.isStaff(acc.email) ? '' : ' · har ikke admin-adgang'}</div></td>
          <td><span class="badge ${cls}">${label}</span>${acc.last_error ? html`<div class="meta text-err">${acc.last_error}${acc.last_error_at ? ` (${formatDateTime(acc.last_error_at)})` : ''}</div>` : ''}
            ${acc.connected_at ? html`<div class="meta">Forbundet ${formatDateTime(acc.connected_at)}${acc.connected_by ? ` af ${staffName(acc.connected_by)}` : ''}</div>` : ''}</td>
          <td class="small">${acc.token_enc ? (acc.compose ? 'Læse + oprette kladder' : 'Kun læse') : '–'}</td>
          <td class="small">${acc.last_sync_at ? formatDateTime(acc.last_sync_at) : '–'}</td>
          <td>${acc.canUse
            ? html`<div class="stack">
                ${a.setup.ready
                  ? html`<form method="post" action="/admin/kundeemner/mail/konto/${enc}/forbind" class="stack">${csrfField(a.csrf)}
                      <label class="row small"><input type="checkbox" name="drafts" value="1"${acc.compose ? html` checked` : ''}> Tillad oprettelse af kladder</label>
                      <button class="btn btn-primary btn-small" type="submit">${acc.token_enc ? 'Forbind igen' : 'Forbind'}</button></form>`
                  : html`<span class="small muted">Kan forbindes, når opsætningen er færdig.</span>`}
                ${acc.token_enc
                  ? html`<form method="post" action="/admin/kundeemner/mail/konto/${enc}/synk" class="inline">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small" type="submit">Synkronisér nu</button></form>
                      <form method="post" action="/admin/kundeemner/mail/konto/${enc}/afbryd" class="inline">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small" type="submit" data-confirm-btn="Afbryd forbindelsen til ${acc.email}? Adgangen tilbagekaldes hos Google.">Afbryd</button></form>`
                  : ''}
              </div>`
            : html`<span class="small muted">Kun ${staffName(acc.email)} kan forbinde sin egen postkasse.</span>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
    <details><summary class="small">Hvad giver man adgang til?</summary>
      <ul class="small">
        <li><strong>Læse mails</strong> (gmail.readonly): Veyro kigger efter mails til og fra adresser, der står på kundeemner og kunder. Andre mails gemmes ikke.</li>
        <li><strong>Oprette kladder</strong> (gmail.compose, valgfri): kun når du selv trykker "Opret kladde i Gmail" på et mailudkast. Der sendes aldrig noget.</li>
        <li>Adgangen gemmes krypteret på serveren og kan altid afbrydes her eller under Google-kontoens sikkerhedsindstillinger.</li>
        <li>Mails, der kun deler virksomhedsdomæne med et kundeemne, gemmes kun med afsender og emne, til en medarbejder har bekræftet dem herunder.</li>
      </ul></details>
  </section>
  <section class="card stack" aria-labelledby="rev-h">
    <h2 id="rev-h" class="h-small" style="margin:0">Til gennemgang (${a.review.length})</h2>
    <p class="small" style="margin:0">Mulige mails om kundeemner, som ikke kunne matches sikkert. Indholdet hentes først, når du bekræfter. Du ser kun samtaler fra din egen postkasse og fælles postkasser.</p>
    ${a.review.length
      ? html`<ul class="list">${a.review.map((t) => reviewItem(a.csrf, t))}</ul>`
      : html`<p class="muted small" style="margin:0">Intet til gennemgang.</p>`}
  </section>
</div>`;
}

function reviewItem(csrf: string, t: ThreadRow & { prospect_company: string | null; froms: string }): H {
  return html`<li class="stack">
    <div><strong>${t.subject ?? '(intet emne)'}</strong><div class="meta">${t.froms} · ${t.last_at ? formatDateTime(t.last_at) : ''} · ${t.account_hint ?? ''}</div>
      <div class="small">${t.match_reason ?? ''}${t.prospect_company ? html` · forslag: <a href="/admin/kundeemner/${t.prospect_id}">${t.prospect_company}</a>` : ''}</div></div>
    <div class="row">
      <form method="post" action="/admin/kundeemner/mail/samtale/${t.id}/bekraeft" class="row">${csrfField(csrf)}
        <label class="small" for="rv-${t.id}">Kundeemne-ID</label><input id="rv-${t.id}" name="prospect" type="number" min="1" value="${t.prospect_id ?? ''}" style="width:7em" required>
        <button class="btn btn-primary btn-small" type="submit">Bekræft</button></form>
      <form method="post" action="/admin/kundeemner/mail/samtale/${t.id}/afvis" class="inline">${csrfField(csrf)}<button class="btn btn-secondary btn-small" type="submit">Ikke relevant</button></form>
    </div>
  </li>`;
}

const DIR_LABEL = (m: MessageRow) =>
  m.kind === 'autosvar' ? html`<span class="badge b-neutral">Autosvar</span>` : m.kind === 'leveringsfejl' ? html`<span class="badge b-err">Leveringsfejl</span>` : m.direction === 'ud' ? html`<span class="badge b-accent">Sendt</span>` : html`<span class="badge b-ok">Modtaget</span>`;

export function prospectMailSection(a: {
  csrf: string;
  prospectId: number;
  anyConnected: boolean;
  searchAccounts: string[];
  defaultQuery: string;
  threads: (ThreadRow & { messages: MessageRow[]; canReview: boolean; sharedAccount: boolean })[];
  staff: string[];
}): H {
  const base = `/admin/kundeemner/${a.prospectId}`;
  return html`<section class="card stack" id="mail" aria-labelledby="mail-h">
    <div class="row between"><h2 id="mail-h" class="h-small" style="margin:0">Mailsamtaler</h2><a class="btn btn-secondary btn-small" href="${base}/udkast">Lav mailudkast</a></div>
    ${a.anyConnected
      ? ''
      : html`<p class="small muted" style="margin:0"><span class="badge b-neutral">Gmail ikke forbundet</span> Mails vises her automatisk, når en postkasse er forbundet under <a href="/admin/kundeemner/mail">Mailkonti</a>. Kontakt kan indtil da registreres manuelt.</p>`}
    ${a.threads.length
      ? html`<ul class="list">${a.threads.map(
          (t) => html`<li class="stack">
            <div class="row between"><div><strong>${t.subject ?? '(intet emne)'}</strong>
              ${t.match_state === 'gennemgaa' ? html` <span class="badge b-warn">Kræver gennemgang</span>` : ''}
              <div class="meta">${t.messages.length} ${t.messages.length === 1 ? 'besked' : 'beskeder'} · ${t.match_reason ?? ''}${t.assigned_to ? ` · tildelt ${staffName(t.assigned_to)}` : ''}</div></div>
              ${t.canReview
                ? html`<div class="row">
                    ${t.match_state === 'gennemgaa'
                      ? html`<form method="post" action="/admin/kundeemner/mail/samtale/${t.id}/bekraeft" class="inline">${csrfField(a.csrf)}<input type="hidden" name="prospect" value="${a.prospectId}"><input type="hidden" name="back" value="1"><button class="btn btn-primary btn-small" type="submit">Bekræft</button></form>`
                      : ''}
                    <form method="post" action="/admin/kundeemner/mail/samtale/${t.id}/afvis" class="inline">${csrfField(a.csrf)}<input type="hidden" name="back" value="1"><button class="btn btn-secondary btn-small" type="submit" data-confirm-btn="Fjern samtalen fra kundeemnet? Veyros kopi slettes; originalen i Gmail berøres ikke.">Fjern</button></form>
                  </div>`
                : ''}
            </div>
            ${t.sharedAccount && t.match_state === 'bekraeftet'
              ? html`<form method="post" action="/admin/kundeemner/mail/samtale/${t.id}/tildel" class="row">${csrfField(a.csrf)}<input type="hidden" name="back" value="1">
                  <label class="small" for="as-${t.id}">Tildel samtalen (fælles postkasse)</label>
                  <select id="as-${t.id}" name="assigned_to"><option value="">Ingen</option>${a.staff.map((s) => html`<option value="${s}"${t.assigned_to === s ? html` selected` : ''}>${staffName(s)}</option>`)}</select>
                  <button class="btn btn-secondary btn-small" type="submit">Gem</button></form>`
              : ''}
            ${t.messages.map(
              (m) => html`<details class="mail-msg">
                <summary class="small">${DIR_LABEL(m)} ${formatDateTime(m.sent_at)} · ${m.from_name ? `${m.from_name} <${m.from_addr ?? ''}>` : (m.from_addr ?? '')} → ${m.to_addrs ?? ''} <span class="muted">(${m.account})</span></summary>
                ${m.body_loaded
                  ? html`<pre class="mail-body">${m.body_text || m.snippet || '(tom besked)'}</pre>`
                  : html`<p class="small muted">Indholdet hentes, når samtalen er bekræftet.</p>`}
              </details>`,
            )}
          </li>`,
        )}</ul>`
      : html`<p class="small muted" style="margin:0">Ingen mailsamtaler knyttet til kundeemnet.</p>`}
    ${a.searchAccounts.length
      ? html`<details><summary class="small">Find og knyt en samtale manuelt</summary>
          <form method="get" action="${base}/mail/soeg" class="row" style="margin-top:8px">
            <div class="field"><label for="ms-acc">Postkasse</label><select id="ms-acc" name="konto">${a.searchAccounts.map((x) => html`<option value="${x}">${x}</option>`)}</select></div>
            <div class="field"><label for="ms-q">Søgning (Gmail-søgning)</label><input id="ms-q" name="q" type="search" maxlength="200" value="${a.defaultQuery}"></div>
            <button class="btn btn-secondary btn-small" type="submit" style="align-self:flex-end">Søg</button>
          </form></details>`
      : ''}
  </section>`;
}

export function mailSearchPage(a: {
  csrf: string;
  p: { id: number; company: string };
  account: string;
  q: string;
  results: { threadId: string; id: string; from: string | null; subject: string | null; date: number }[];
  error: string | null;
}): H {
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="/admin">Admin</a> / <a href="/admin/kundeemner">Kundeemner</a> / <a href="/admin/kundeemner/${a.p.id}">${a.p.company}</a> / Find mail</p>
    <h1>Find mail i ${a.account}</h1><p class="lead">Søgningen gemmer intet. Kun samtaler, du vælger at knytte til ${a.p.company}, gemmes i Veyro.</p></div>
  ${a.error ? alert('err', a.error) : ''}
  <form method="get" action="/admin/kundeemner/${a.p.id}/mail/soeg" class="card row"><input type="hidden" name="konto" value="${a.account}">
    <div class="field"><label for="s-q">Søgning</label><input id="s-q" name="q" type="search" maxlength="200" value="${a.q}"></div>
    <button class="btn btn-secondary btn-small" type="submit" style="align-self:flex-end">Søg igen</button></form>
  <section class="card">${a.results.length
    ? html`<ul class="list">${a.results.map(
        (r) => html`<li class="row between"><div><strong>${r.subject ?? '(intet emne)'}</strong><div class="meta">${r.from ?? ''} · ${r.date ? formatDateTime(r.date) : ''}</div></div>
          <form method="post" action="/admin/kundeemner/${a.p.id}/mail/knyt" class="inline">${csrfField(a.csrf)}<input type="hidden" name="konto" value="${a.account}"><input type="hidden" name="thread" value="${r.threadId}">
            <button class="btn btn-primary btn-small" type="submit">Knyt samtalen til ${a.p.company}</button></form></li>`,
      )}</ul>`
    : html`<p class="muted small" style="margin:0">Ingen resultater.</p>`}</section>
</div>`;
}
