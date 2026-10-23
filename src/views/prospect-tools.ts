// "Tilføj via link", vurdering af et kundeemnes hjemmeside og "Find nye kundeemner" i offentlige kilder.
// Alt, der er hentet maskinelt, vises som ubekræftet med kilde og tidspunkt, og intet bruges uden gennemgang.
import { html } from 'hono/html';
import { formatDateTime } from '../lib/format';
import type { JobRow } from '../lib/prospect-jobs';
import { staffName, type ProspectRow } from '../lib/prospects';
import type { Assessment } from '../lib/site-scan';
import { alert, csrfField, type H } from './layout';

const crumbs = (...items: [string, string | null][]) =>
  html`<p class="eyebrow">${items.map(([label, href], i) => html`${i ? ' / ' : ''}${href ? html`<a href="${href}">${label}</a>` : label}`)}</p>`;

export function parseAssessment(raw: string | null): Assessment | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Assessment;
    return Array.isArray(a.observations) ? { ...a, suggestions: a.suggestions ?? [], notChecked: a.notChecked ?? [], pages: a.pages ?? [] } : null;
  } catch {
    return null;
  }
}

function assessmentBody(a: Assessment): H {
  return html`<div class="grid grid-2">
    <div><h3 class="h-small">Observationer</h3>${a.observations.length
      ? html`<ul class="small obs-list">${a.observations.map((o) => html`<li>${o.text}${o.page ? html` <span class="meta">(${o.page.replace(/^https?:\/\//, '')})</span>` : ''}</li>`)}</ul>`
      : html`<p class="small muted">Ingen konkrete fund på de hentede sider.</p>`}</div>
    <div><h3 class="h-small">Forslag</h3>${a.suggestions.length ? html`<ul class="small obs-list">${a.suggestions.map((s) => html`<li>${s}</li>`)}</ul>` : html`<p class="small muted">Ingen.</p>`}</div>
  </div>
  <div><h3 class="h-small">Ikke undersøgt</h3><ul class="small obs-list">${a.notChecked.map((s) => html`<li>${s}</li>`)}</ul></div>`;
}

/** Vurdering på kundeemnets side: vis, ret og godkend */
export function assessmentSection(args: { csrf: string; p: ProspectRow }): H {
  const { p, csrf } = args;
  const a = parseAssessment(p.assessment);
  const base = `/admin/kundeemner/${p.id}`;
  const fetchBtn = p.website
    ? html`<form method="post" action="${base}/vurdering/hent" class="inline">${csrfField(csrf)}<button class="btn btn-secondary btn-small" type="submit">${a ? 'Hent ny vurdering' : 'Hent vurdering af hjemmesiden'}</button></form>`
    : html`<span class="small muted">Tilføj en hjemmeside for at hente en vurdering.</span>`;
  if (!a) {
    return html`<section class="card stack" id="vurdering"><div class="row between"><h2 class="h-small" style="margin:0">Vurdering af hjemmesiden</h2>${fetchBtn}</div>
      <p class="small muted" style="margin:0">Ingen vurdering endnu. En vurdering henter op til tre offentlige sider og noterer kun konkrete fund med den side, de stammer fra.</p></section>`;
  }
  const approved = !!p.assessment_approved_at;
  return html`<section class="card stack" id="vurdering">
    <div class="row between"><h2 class="h-small" style="margin:0">Vurdering af hjemmesiden
      ${approved ? html`<span class="badge b-ok">Godkendt</span>` : html`<span class="badge b-warn">Ikke godkendt</span>`}</h2>${fetchBtn}</div>
    <p class="small" style="margin:0">${approved
      ? html`Godkendt ${formatDateTime(p.assessment_approved_at!)} af ${staffName(p.assessment_approved_by)}. Godkendte observationer kan bruges i mailudkast.`
      : html`Hentet maskinelt ${a.createdAt ? formatDateTime(a.createdAt) : ''}. Gennemgå og ret, før den godkendes. Ikke-godkendte observationer bruges ikke i mailudkast.`}</p>
    ${assessmentBody(a)}
    <details><summary class="small">Ret${approved ? '' : ' og godkend'}</summary>
      <form method="post" action="${base}/vurdering" class="stack" style="margin-top:8px">${csrfField(csrf)}
        <div class="field"><label for="as-obs">Observationer (én pr. linje)</label><textarea id="as-obs" name="observations" rows="6" maxlength="6000">${a.observations.map((o) => o.text).join('\n')}</textarea></div>
        <div class="field"><label for="as-sug">Forslag (én pr. linje)</label><textarea id="as-sug" name="suggestions" rows="4" maxlength="4000">${a.suggestions.join('\n')}</textarea></div>
        <div class="field"><label for="as-nc">Ikke undersøgt (én pr. linje)</label><textarea id="as-nc" name="not_checked" rows="4" maxlength="4000">${a.notChecked.join('\n')}</textarea></div>
        <div class="row"><button class="btn btn-primary btn-small" type="submit" name="op" value="godkend">Gem og godkend</button><button class="btn btn-secondary btn-small" type="submit" name="op" value="gem">Gem uden at godkende</button></div>
      </form></details>
  </section>`;
}

// ---------- Tilføj via link ----------

export function linkStartPage(args: { csrf: string; url: string; error: string | null }): H {
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], ['Tilføj via link', null])}<h1>Tilføj via link</h1>
    <p class="lead">Indsæt adressen på virksomhedens hjemmeside. Veyro henter forsiden og op til to kontakt- eller om-os-sider og foreslår oplysninger og en kort vurdering. Alt er ubekræftet, til du har gennemgået det, og intet gemmes, før du trykker "Opret kundeemne".</p></div>
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/kundeemner/link" class="card stack">${csrfField(args.csrf)}
    <div class="field"><label for="l-url">Hjemmeside</label><input id="l-url" name="url" type="text" inputmode="url" required maxlength="500" placeholder="firma.dk" value="${args.url}"></div>
    <p class="hint">Kun offentlige hjemmesider på standardporte. Interne adresser, IP-adresser og Veyros egne adresser hentes ikke. Hentningen stopper efter 8 sekunder eller 1,5 MB pr. side.</p>
    <div class="row"><button class="btn btn-primary" type="submit">Hent forslag</button><a class="small" href="/admin/kundeemner/ny">Opret manuelt i stedet</a></div>
  </form>
</div>`;
}

export function jobWaitPage(args: { csrf: string; job: JobRow; title: string; back: string }): H {
  const j = args.job;
  const failed = j.status === 'fejl';
  const final = failed && j.attempts >= 3;
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], [args.title, null])}<h1>${args.title}</h1></div>
  ${failed
    ? alert('err', html`<strong>Hentningen fejlede${final ? '' : ', og der prøves igen automatisk'}.</strong> ${j.error ?? ''}`)
    : alert('info', 'Henter … Siden opdateres af sig selv om få sekunder.')}
  <div class="row">
    ${failed ? html`<form method="post" action="/admin/kundeemner/job/${j.id}/igen" class="inline">${csrfField(args.csrf)}<button class="btn btn-primary btn-small" type="submit">Prøv igen nu</button></form>` : ''}
    <a class="btn btn-secondary btn-small" href="${args.back}">Tilbage</a>
  </div>
</div>`;
}

export function linkIntro(s: { website: string | null; pages: { url: string; status: number; title: string | null }[]; description: string | null; fetchedAt: number }, a: Assessment | null): H {
  return html`Forslag hentet ${formatDateTime(s.fetchedAt)} fra ${s.pages.map((p, i) => html`${i ? ', ' : ''}<a href="${p.url}" target="_blank" rel="noopener noreferrer nofollow">${p.url.replace(/^https?:\/\//, '')}</a>`)}.
    Felter markeret <span class="badge b-warn">Ubekræftet</span> er hentet maskinelt; tomme felter blev ikke fundet. Ret eller slet det, der ikke passer.
    ${s.description ? html`<br><span class="small">Sidens egen beskrivelse: "${s.description}"</span>` : ''}
    ${a ? html`<details class="card" style="margin-top:12px"><summary>Vurdering (gemmes som ikke godkendt)</summary><div class="stack" style="margin-top:8px">${assessmentBody(a)}</div></details>` : ''}`;
}

// ---------- Find nye kundeemner ----------

export interface SourceRow {
  id: number;
  name: string;
  url: string;
  industry: string | null;
  area: string | null;
  note: string | null;
  last_run_at: number | null;
  last_error: string | null;
  created_by: string;
  created_at: number;
}

export interface CandidateRow {
  id: number;
  source_id: number;
  source_name: string;
  source_url: string;
  industry: string | null;
  area: string | null;
  company: string;
  website: string;
  domain: string;
  found_on: string;
  reason: string;
  not_checked: string;
  status: 'ny' | 'importeret' | 'fravalgt';
  prospect_id: number | null;
}

export const FIND_FLASH: Record<string, string> = {
  kilde: 'Kilden er tilføjet. Tryk "Søg i kilden" for at hente den.',
  slettet: 'Kilden og dens fund er slettet. Importerede kundeemner er ikke berørt.',
  koerer: 'Kilden hentes i baggrunden. Genindlæs siden om lidt.',
  fravalgt: 'De valgte fund er fravalgt.',
};

export function findPage(args: {
  csrf: string;
  sources: SourceRow[];
  jobs: (JobRow & { source_id: number | null })[];
  candidates: CandidateRow[];
  total: number;
  filter: { industry: string; area: string; status: string; source: string };
  industries: string[];
  areas: string[];
  flash: string | null;
  imported: { n: number; skipped: string[] } | null;
  error: string | null;
}): H {
  const f = args.filter;
  const running = args.jobs.filter((j) => j.status === 'venter' || j.status === 'koerer');
  const opt = (v: string, cur: string, label = v) => html`<option value="${v}"${v === cur ? html` selected` : ''}>${label}</option>`;
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], ['Find nye kundeemner', null])}<h1>Find nye kundeemner</h1>
    <p class="lead">Søg i offentlige lister, I selv vælger, fx udstillerlister fra festivaler og messer eller lokale erhvervsforeninger. Veyro finder virksomhederne ud fra listens links. Der kontaktes ingen, og intet importeres automatisk.</p></div>
  ${alert('info', html`<strong>Opsætning:</strong> Søgningen bruger kun de kilder, der er tilføjet herunder (${args.sources.length}). Der er ingen søgemaskine forbundet: Googles søge-API er lukket for nye kunder, og der er ikke valgt en anden udbyder. Resultaterne er derfor kun så gode som kilderne.`)}
  ${args.flash && FIND_FLASH[args.flash] ? alert('ok', FIND_FLASH[args.flash]!) : ''}
  ${args.imported ? alert(args.imported.n ? 'ok' : 'warn', html`${args.imported.n} ${args.imported.n === 1 ? 'kundeemne er' : 'kundeemner er'} importeret med status "Skal undersøges".${args.imported.skipped.length ? html` Sprunget over: <ul>${args.imported.skipped.map((s) => html`<li>${s}</li>`)}</ul>` : ''}`) : ''}
  ${args.error ? alert('err', args.error) : ''}
  ${running.length ? alert('info', html`${running.length} ${running.length === 1 ? 'kilde hentes' : 'kilder hentes'} nu. <a href="/admin/kundeemner/find">Genindlæs</a> om lidt.`) : ''}

  <section class="card stack" aria-labelledby="src-h">
    <h2 id="src-h" class="h-small" style="margin:0">Kilder</h2>
    ${args.sources.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Kilde</th><th>Branche / område</th><th>Seneste søgning</th><th></th></tr></thead><tbody>${args.sources.map((s) => {
          const lastJob = args.jobs.find((j) => j.source_id === s.id);
          return html`<tr>
            <td><strong>${s.name}</strong><div class="meta"><a href="${s.url}" target="_blank" rel="noopener noreferrer nofollow">${s.url.replace(/^https?:\/\//, '').slice(0, 60)}</a></div>${s.note ? html`<div class="meta">${s.note}</div>` : ''}</td>
            <td class="small">${s.industry ?? '–'} / ${s.area ?? '–'}</td>
            <td class="small">${s.last_run_at ? formatDateTime(s.last_run_at) : 'Aldrig'}${s.last_error ? html`<div class="text-err">${s.last_error}</div>` : ''}
              ${lastJob?.status === 'faerdig' && lastJob.result ? html`<div class="meta">${resultText(lastJob.result)}</div>` : ''}${lastJob?.status === 'fejl' ? html`<div class="text-err">${lastJob.error ?? ''}</div>` : ''}</td>
            <td><div class="row">
              <form method="post" action="/admin/kundeemner/find/kilder/${s.id}/koer" class="inline">${csrfField(args.csrf)}<button class="btn btn-primary btn-small" type="submit">Søg i kilden</button></form>
              <form method="post" action="/admin/kundeemner/find/kilder/${s.id}/slet" class="inline">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit" data-confirm-btn="Slet kilden ${s.name}? Importerede kundeemner bliver liggende.">Slet</button></form>
            </div></td></tr>`;
        })}</tbody></table></div>`
      : html`<p class="small muted" style="margin:0">Ingen kilder endnu.</p>`}
    <details${args.sources.length ? '' : html` open`}><summary class="small">Tilføj kilde</summary>
      <form method="post" action="/admin/kundeemner/find/kilder" class="stack" style="margin-top:8px">${csrfField(args.csrf)}
        <div class="grid grid-2">
          <div class="field"><label for="s-name">Navn</label><input id="s-name" name="name" type="text" required maxlength="100" placeholder="Fx Slagelse Festival – udstillere 2026"></div>
          <div class="field"><label for="s-url">Offentlig adresse</label><input id="s-url" name="url" type="text" inputmode="url" required maxlength="500" placeholder="https://…/udstillere"></div>
          <div class="field"><label for="s-ind">Branche</label><input id="s-ind" name="industry" type="text" maxlength="100" placeholder="Fx Fødevarer"></div>
          <div class="field"><label for="s-area">Område</label><input id="s-area" name="area" type="text" maxlength="100" placeholder="Fx Sjælland eller Slagelse"></div>
        </div>
        <div class="field"><label for="s-note">Note</label><input id="s-note" name="note" type="text" maxlength="300"></div>
        <p class="hint">Branche og område beskriver kilden. De bliver sat på de fund, kilden giver, men er ikke kontrolleret for den enkelte virksomhed.</p>
        <div><button class="btn btn-primary btn-small" type="submit">Tilføj kilde</button></div>
      </form></details>
  </section>

  <section class="card stack" aria-labelledby="cand-h">
    <h2 id="cand-h" class="h-small" style="margin:0">Fund (${args.total})</h2>
    <form method="get" action="/admin/kundeemner/find" class="row">
      <div class="field"><label for="cf-ind">Branche</label><select id="cf-ind" name="branche">${opt('', f.industry, 'Alle')}${args.industries.map((x) => opt(x, f.industry))}</select></div>
      <div class="field"><label for="cf-area">Område</label><select id="cf-area" name="omraade">${opt('', f.area, 'Alle')}${args.areas.map((x) => opt(x, f.area))}</select></div>
      <div class="field"><label for="cf-src">Kilde</label><select id="cf-src" name="kilde">${opt('', f.source, 'Alle')}${args.sources.map((s) => opt(String(s.id), f.source, s.name))}</select></div>
      <div class="field"><label for="cf-st">Status</label><select id="cf-st" name="status">${opt('ny', f.status, 'Nye')}${opt('importeret', f.status, 'Importerede')}${opt('fravalgt', f.status, 'Fravalgte')}${opt('alle', f.status, 'Alle')}</select></div>
      <button class="btn btn-secondary btn-small" type="submit" style="align-self:flex-end">Filtrér</button>
    </form>
    ${args.candidates.length
      ? html`<form method="post" action="/admin/kundeemner/find/importer" class="stack">${csrfField(args.csrf)}
          <div class="table-wrap"><table class="table"><thead><tr><th><span class="sr-only">Vælg</span></th><th>Virksomhed</th><th>Kilde og dato</th><th>Hvorfor</th><th>Ikke undersøgt</th></tr></thead><tbody>
          ${args.candidates.map(
            (x) => html`<tr>
              <td>${x.status === 'ny' ? html`<input type="checkbox" name="c" value="${x.id}" aria-label="Vælg ${x.company}">` : ''}</td>
              <td><strong>${x.company}</strong> <span class="badge b-warn">Ubekræftet</span><div class="meta"><a href="${x.website}" target="_blank" rel="noopener noreferrer nofollow">${x.domain}</a></div>
                ${x.status === 'importeret' && x.prospect_id ? html`<div class="meta"><a href="/admin/kundeemner/${x.prospect_id}">Importeret</a></div>` : x.status === 'fravalgt' ? html`<div class="meta">Fravalgt</div>` : ''}</td>
              <td class="small"><a href="${x.source_url}" target="_blank" rel="noopener noreferrer nofollow">${x.source_name}</a><div class="meta">${x.found_on.split('-').reverse().join('.')}</div></td>
              <td class="small">${x.reason}</td>
              <td class="small muted">${x.not_checked}</td></tr>`,
          )}</tbody></table></div>
          <div class="row"><button class="btn btn-primary btn-small" type="submit" name="op" value="importer">Importér valgte som "Skal undersøges"</button>
            <button class="btn btn-secondary btn-small" type="submit" name="op" value="fravaelg">Fravælg valgte</button></div>
          <p class="hint">Ved import kontrolleres blokeringer og dubletter igen. Blacklistede virksomheder og virksomheder med samme domæne som et eksisterende kundeemne eller en kunde importeres ikke.</p>
        </form>`
      : html`<p class="small muted" style="margin:0">Ingen fund${args.sources.length ? ' med de valgte filtre' : '. Tilføj en kilde og søg i den'}.</p>`}
  </section>
</div>`;
}

function resultText(raw: string): string {
  try {
    const r = JSON.parse(raw) as { found?: number; added?: number; blocked?: number; known?: number };
    return `${r.found ?? 0} fundet, ${r.added ?? 0} nye${r.blocked ? `, ${r.blocked} blokerede sprunget over` : ''}${r.known ? `, ${r.known} kendte` : ''}`;
  } catch {
    return '';
  }
}
