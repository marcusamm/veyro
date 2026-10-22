// Admin › Kunder: kundeoversigt, guidet opsætning og projektets arbejdsplads.
import { html, raw } from 'hono/html';
import { formatDate, formatDateTime } from '../lib/format';
import type { ImportError } from '../../varebestilling/src/lib/csv';
import { FONTS, LAYOUTS, SECTION_TYPES, STARTPUNKTER, type Page, type SectionType, type WebsiteConfig } from '../kunder/hjemmeside';
import type { CatalogPlan } from '../kunder/katalog';
import { STEP_LABEL, STEPS, type AuditRow, type Company, type DomainRow, type FileRow, type PreviewLinkRow, type Project, type ProjectLead, type Step, type Version } from '../kunder/model';
import { DOMAIN_STATUS, type Check, type PublicationRow, type Step as PubStep } from '../kunder/publicering';
import { PLANNED, SERVICE_ORDER, SERVICES, type Problem, type ServiceKey, type ServiceRow } from '../kunder/tjenester';
import { alert, csrfField, type H } from './layout';
import { badgeClass, type Tone } from './status';

export const BASE = '/admin/virksomheder';
export const pbase = (p: Pick<Project, 'company_id' | 'id'>) => `${BASE}/${p.company_id}/projekter/${p.id}`;

const KIND_LABEL: Record<Project['kind'], string> = { skabelon: 'Ny hjemmeside fra startpunkt', tilsluttet: 'Tilsluttet færdig hjemmeside', intern: 'Kun interne systemer' };

const SERVICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  mangler: { label: 'Mangler opsætning', tone: 'warn' },
  klar: { label: 'Klar', tone: 'neutral' },
  afventer: { label: 'Afventer udrulning', tone: 'warn' },
  forbundet: { label: 'Forbundet', tone: 'ok' },
  blokeret: { label: 'Blokeret', tone: 'err' },
};

const badge = (label: string, tone: Tone) => html`<span class="badge ${badgeClass(tone)}">${label}</span>`;
const DOMAIN_TONE: Record<DomainRow['status'], Tone> = { afventer: 'neutral', verificerer: 'warn', aktiv: 'ok', fejlet: 'err', blokeret: 'warn', fjernet: 'neutral' };

function flashBox(flash: string | null | undefined, error?: string | null): H {
  return html`${flash ? alert('ok', flash) : ''}${error ? alert('err', error) : ''}`;
}

// ---------- Oversigt ----------

export interface OverviewRow {
  company: Company;
  project: Project | null;
  services: ServiceKey[];
  state: { label: string; tone: Tone };
  domain: DomainRow | null;
  action: { label: string; href: string } | null;
}

export function overviewPage(args: { rows: OverviewRow[]; q: string }): H {
  return html`<div class="stack-lg">
  <div class="row between"><div><p class="eyebrow">Admin</p><h1>Kunder</h1><p class="lead">Virksomheder, deres hjemmesider og tjenester. Opsætningen gemmes undervejs, så du kan fortsætte, hvor du slap.</p></div>
    <a class="btn btn-accent" href="${BASE}/ny">Opret kunde</a></div>
  <form method="get" action="${BASE}" class="row"><label class="visually-hidden" for="q">Søg</label><input id="q" name="q" value="${args.q}" placeholder="Søg på navn, CVR eller adresse" style="max-width:340px"><button class="btn btn-secondary btn-small">Søg</button></form>
  <section class="card">
  ${args.rows.length === 0
    ? html`<p class="empty">Ingen kunder endnu. Klik "Opret kunde" for at begynde.</p>`
    : html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th scope="col">Virksomhed</th><th scope="col">Hjemmeside / projekt</th><th scope="col">Tjenester</th><th scope="col">Publicering</th><th scope="col">Domæne</th><th scope="col">Næste skridt</th></tr></thead>
    <tbody>${args.rows.map(
      (r) => html`<tr>
        <td data-label="Virksomhed"><a href="${BASE}/${r.company.id}"><strong>${r.company.name}</strong></a>${r.company.cvr ? html`<br><span class="small muted">CVR ${r.company.cvr}</span>` : ''}</td>
        <td data-label="Projekt">${r.project ? html`<a href="${pbase(r.project)}">${r.project.name}</a><br><span class="small muted">${KIND_LABEL[r.project.kind]}</span>` : html`<span class="muted">Intet projekt</span>`}</td>
        <td data-label="Tjenester">${r.services.length ? r.services.map((s) => SERVICES[s].label).join(', ') : '–'}</td>
        <td data-label="Publicering">${badge(r.state.label, r.state.tone)}</td>
        <td data-label="Domæne">${r.domain ? html`${r.domain.hostname}<br>${badge(DOMAIN_STATUS[r.domain.status], DOMAIN_TONE[r.domain.status])}` : html`<span class="muted">–</span>`}</td>
        <td data-label="Næste skridt">${r.action ? html`<a href="${r.action.href}">${r.action.label}</a>` : html`<span class="muted">Intet udestående</span>`}</td>
      </tr>`,
    )}</tbody></table></div>`}
  </section>
</div>`;
}

// ---------- Trin A: virksomhed ----------

export type CompanyValues = Partial<Record<keyof Company, string | null>>;

const field = (id: string, label: string, v: CompanyValues | Record<string, string>, errors: Record<string, string>, opts: { type?: string; hint?: string; required?: boolean; attrs?: string } = {}) =>
  html`<div class="field"><label for="f-${id}">${label}${opts.required ? '' : html` <span class="muted small">(valgfri)</span>`}</label>
  <input id="f-${id}" name="${id}" type="${opts.type ?? 'text'}" value="${(v as any)[id] ?? ''}"${opts.required ? raw(' required') : ''}${raw(opts.attrs ? ' ' + opts.attrs : '')}${errors[id] ? raw(' aria-invalid="true"') : ''}>
  ${errors[id] ? html`<p class="hint" style="color:var(--err,#b42318)">${errors[id]}</p>` : opts.hint ? html`<p class="hint">${opts.hint}</p>` : ''}</div>`;

export function companyFormPage(args: { csrf: string; values: CompanyValues; errors: Record<string, string>; duplicates: Company[]; editing: Company | null; blocked?: boolean }): H {
  const v = args.values;
  const e = args.errors;
  return html`<div class="stack-lg">
  <div><p class="eyebrow">${args.editing ? args.editing.name : 'Opret kunde · trin 1 af 6'}</p><h1>${args.editing ? 'Ret virksomhedsoplysninger' : 'Virksomhed'}</h1>
  <p class="lead">Oplysningerne her er interne. Det, der vises på hjemmesiden, vælger du i trinnet "Udseende og indhold".</p></div>
  ${args.duplicates.length
    ? html`<section class="card stack">${alert('warn', html`<strong>Virksomheden findes måske allerede.</strong> Vælg den eksisterende i stedet for at oprette en dublet.`)}
      <ul class="list">${args.duplicates.map(
        (d) => html`<li class="row between"><div><strong>${d.name}</strong><div class="meta">${d.cvr ? `CVR ${d.cvr} · ` : ''}${d.email ?? ''} · oprettet ${formatDate(d.created_at)}</div></div>
          <a class="btn btn-primary btn-small" href="${BASE}/${d.id}/projekter/ny">Brug denne virksomhed</a></li>`,
      )}</ul>
      ${args.blocked ? html`<p class="small">CVR-nummeret er allerede registreret, så der kan ikke oprettes en ny virksomhed med det.</p>` : ''}</section>`
    : ''}
  <form method="post" class="card stack">
    ${csrfField(args.csrf)}
    <div class="form-grid">
      ${field('name', 'Firmanavn', v, e, { required: true, attrs: 'maxlength="120" autocomplete="organization"' })}
      ${field('cvr', 'CVR-nummer', v, e, { hint: '8 cifre. Bruges til at undgå dubletter og på fakturaer.', attrs: 'inputmode="numeric" maxlength="11"' })}
      ${field('contact_name', 'Kontaktperson', v, e, { attrs: 'maxlength="120"' })}
      ${field('email', 'E-mail', v, e, { type: 'email', attrs: 'maxlength="200"' })}
      ${field('phone', 'Telefon', v, e, { type: 'tel', attrs: 'maxlength="40"' })}
      ${field('website', 'Nuværende hjemmeside eller ønsket domæne', v, e, { hint: 'Fx firma.dk. Intet ændres på den eksisterende side.', attrs: 'maxlength="200"' })}
      ${field('address', 'Adresse', v, e, { attrs: 'maxlength="200"' })}
      ${field('postal_code', 'Postnummer', v, e, { attrs: 'maxlength="10"' })}
      ${field('city', 'By', v, e, { attrs: 'maxlength="80"' })}
      ${field('industry', 'Branche', v, e, { attrs: 'maxlength="80"' })}
    </div>
    <div class="field"><label for="f-description">Kort beskrivelse af virksomheden <span class="muted small">(valgfri)</span></label>
      <textarea id="f-description" name="description" rows="3" maxlength="1000">${v.description ?? ''}</textarea>
      <p class="hint">Med kundens egne ord. Bruges som udgangspunkt for forsideteksten, som du godkender før publicering.</p></div>
    <div class="field"><label for="f-internal_note">Intern note <span class="muted small">(kun for Veyro)</span></label>
      <textarea id="f-internal_note" name="internal_note" rows="2" maxlength="2000">${v.internal_note ?? ''}</textarea></div>
    ${args.duplicates.length && !args.blocked && !args.editing
      ? html`<label class="check"><input type="checkbox" name="confirm_new" value="1"> Det er en anden virksomhed. Opret den som ny.</label>`
      : ''}
    <div class="row"><button class="btn btn-primary" type="submit">${args.editing ? 'Gem' : 'Gem og fortsæt'}</button><a class="btn btn-secondary" href="${args.editing ? `${BASE}/${args.editing.id}` : BASE}">Annullér</a></div>
  </form>
</div>`;
}

// ---------- Virksomhedens side ----------

export function companyPage(args: {
  csrf: string;
  company: Company;
  projects: { project: Project; state: { label: string; tone: Tone }; services: ServiceKey[] }[];
  members: { email: string; role: string; invited_at: number }[];
  audit: AuditRow[];
  account: { id: number; plan: string | null } | null;
  flash: string | null;
  error: string | null;
}): H {
  const c = args.company;
  return html`<div class="stack-lg">
  <div><p class="eyebrow"><a href="${BASE}">Kunder</a></p><h1>${c.name}</h1><p class="small muted">Internt id: <code>${c.id}</code> (ændres aldrig)</p></div>
  ${flashBox(args.flash, args.error)}
  <section class="card">
    <div class="row between"><h2 style="margin:0">Hjemmesider og projekter</h2><a class="btn btn-accent btn-small" href="${BASE}/${c.id}/projekter/ny">Nyt projekt</a></div>
    ${args.projects.length
      ? html`<ul class="list" style="margin-top:16px">${args.projects.map(
          (p) => html`<li><div class="item-head"><h3><a href="${pbase(p.project)}">${p.project.name}</a></h3>${badge(p.state.label, p.state.tone)}</div>
          <div class="meta">${KIND_LABEL[p.project.kind]} · adresse <code>${p.project.slug}</code> · ${p.services.map((s) => SERVICES[s].label).join(', ') || 'ingen tjenester'}</div></li>`,
        )}</ul>`
      : html`<p class="empty">Ingen projekter endnu.</p>`}
  </section>
  <section class="card">
    <div class="row between"><h2 style="margin:0">Virksomhedsoplysninger</h2><a class="btn btn-secondary btn-small" href="${BASE}/${c.id}/rediger">Ret</a></div>
    <dl class="facts">
      <div><dt>CVR</dt><dd>${c.cvr ?? '–'}</dd></div>
      <div><dt>Kontaktperson</dt><dd>${c.contact_name ?? '–'}</dd></div>
      <div><dt>E-mail</dt><dd>${c.email ?? '–'}</dd></div>
      <div><dt>Telefon</dt><dd>${c.phone ?? '–'}</dd></div>
      <div><dt>Adresse</dt><dd>${[c.address, [c.postal_code, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '–'}</dd></div>
      <div><dt>Branche</dt><dd>${c.industry ?? '–'}</dd></div>
    </dl>
    ${c.internal_note ? html`<p class="small" style="margin-top:12px"><strong>Intern note:</strong> ${c.internal_note}</p>` : ''}
  </section>
  <section class="card stack">
    <h2 style="margin:0">Kundens brugere i kundepanelet</h2>
    <p class="small muted">Brugere logger ind på kunde.veyro.dk med et engangslink på e-mail og ser kun denne virksomheds hjemmesider og henvendelser. Der bruges aldrig adgangskoder.</p>
    ${args.members.length
      ? html`<ul class="list">${args.members.map((m) => html`<li class="row between"><span>${m.email} <span class="muted small">· inviteret ${formatDate(m.invited_at)}</span></span>
        <form method="post" action="${BASE}/${c.id}/brugere/fjern" class="inline">${csrfField(args.csrf)}<input type="hidden" name="email" value="${m.email}"><button class="btn btn-secondary btn-small">Fjern adgang</button></form></li>`)}</ul>`
      : html`<p class="empty">Ingen brugere endnu.</p>`}
    <form method="post" action="${BASE}/${c.id}/brugere" class="row">${csrfField(args.csrf)}<label class="visually-hidden" for="inv">E-mail</label><input id="inv" name="email" type="email" placeholder="navn@kunde.dk" required style="max-width:320px"><button class="btn btn-primary btn-small">Send invitation</button></form>
    <p class="small muted">Abonnement og betaling er adskilt: ${args.account ? html`<a href="/admin/kunder/${args.account.id}">kundekontoen</a> har ${args.account.plan ? 'et abonnement' : 'intet abonnement'}.` : 'ingen kundekonto med virksomhedens e-mail.'} Pris og betaling aftales via <a href="/admin/tilbud">Tilbud</a>; at slå tjenester til opkræver aldrig noget.</p>
  </section>
  <section class="card">
    <h2 style="margin:0 0 8px">Seneste aktivitet</h2>
    ${auditList(args.audit)}
  </section>
</div>`;
}

function auditList(rows: AuditRow[]): H {
  if (!rows.length) return html`<p class="empty">Ingen aktivitet endnu.</p>`;
  return html`<ul class="list small">${rows.map((a) => html`<li><strong>${a.action}</strong>${a.detail ? html` · ${a.detail}` : ''}<div class="meta">${formatDateTime(a.at)} · ${a.actor}</div></li>`)}</ul>`;
}

// ---------- Trin B: projekttype ----------

export function projectTypePage(args: { csrf: string; company: Company; values: Record<string, string>; errors: Record<string, string>; project: Project | null; projects: Project[] }): H {
  const v = args.values;
  const e = args.errors;
  const kind = v.kind || 'skabelon';
  const locked = !!args.project?.slug_locked;
  const others = args.projects.filter((p) => p.kind === 'skabelon' && p.live_version_id && p.id !== args.project?.id);
  return html`<div class="stack-lg">
  ${args.project ? stepNav(args.project, 'type') : html`<div><p class="eyebrow"><a href="${BASE}/${args.company.id}">${args.company.name}</a> · trin 2 af 6</p><h1>Projekttype</h1></div>`}
  <form method="post" class="card stack">
    ${csrfField(args.csrf)}
    ${!args.project
      ? html`<fieldset class="stack"><legend class="label-like">Hvad skal vi lave?</legend>
      <label class="check"><input type="radio" name="kind" value="skabelon"${kind === 'skabelon' ? raw(' checked') : ''}> <span><strong>Ny hjemmeside ud fra et startpunkt.</strong> Layout, farver, sider og sektioner tilpasses kunden. Hostes af Veyro.</span></label>
      <label class="check"><input type="radio" name="kind" value="tilsluttet"${kind === 'tilsluttet' ? raw(' checked') : ''}> <span><strong>Tilslut en færdig, specialbygget hjemmeside.</strong> Siden er bygget og udrullet for sig (fx som egen Worker). Den forbindes til kunden, formularen og tjenesterne, men bygges ikke om.</span></label>
      <label class="check"><input type="radio" name="kind" value="intern"${kind === 'intern' ? raw(' checked') : ''}> <span><strong>Kun interne systemer, ingen offentlig hjemmeside.</strong> Fx lagerstyring eller bestillingssystem.</span></label>
      ${e.kind ? html`<p class="hint" style="color:var(--err,#b42318)">${e.kind}</p>` : ''}
      </fieldset>`
      : html`<p><strong>${KIND_LABEL[args.project.kind]}</strong>. Projekttypen kan ikke ændres bagefter; opret et nyt projekt i stedet.</p>`}
    <div class="form-grid">
      ${field('name', 'Navn på projektet', v, e, { required: true, hint: 'Internt navn, fx "Hjemmeside" eller "Webshop".', attrs: 'maxlength="80"' })}
      ${field('slug', 'Teknisk adresse', v, e, { required: true, hint: locked ? 'Låst, fordi siden eller tjenesterne er udrullet. Navne og domæner kan stadig ændres.' : 'Små bogstaver, tal og bindestreger. Bliver fx adresse.veyro.dk og navnet på kundens systemer. Låses ved første udrulning.', attrs: `maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*"${locked ? ' readonly' : ''}` })}
    </div>
    ${!args.project || args.project.kind === 'skabelon'
      ? html`<fieldset class="stack" ${!args.project ? '' : raw('hidden')}><legend class="label-like">Startpunkt (kun ny hjemmeside)</legend>
        ${Object.entries(STARTPUNKTER).map(([k, t]) => html`<label class="check"><input type="radio" name="template" value="${k}"${(v.template || 'service') === k ? raw(' checked') : ''}> <span><strong>${t.label}.</strong> ${t.description}</span></label>`)}
        ${others.length ? html`<p class="small muted">Vil du genbruge opbygningen fra en anden kundes side, kan du bagefter bruge "Brug som startpunkt" på den side.</p>` : ''}
        <p class="small muted">Startpunktet er kun et udgangspunkt. Alt kan ændres bagefter, og tekst i [[klammer]] skal skrives om, før siden kan publiceres.</p></fieldset>`
      : ''}
    ${!args.project || args.project.kind === 'tilsluttet'
      ? html`<div class="field"><label for="f-external_url">Den færdige hjemmesides adresse <span class="muted small">(kun tilsluttet hjemmeside)</span></label>
        <input id="f-external_url" name="external_url" type="url" value="${v.external_url ?? ''}" placeholder="https://kundens-side.workers.dev"${e.external_url ? raw(' aria-invalid="true"') : ''}>
        ${e.external_url ? html`<p class="hint" style="color:var(--err,#b42318)">${e.external_url}</p>` : html`<p class="hint">Siden skal allerede være udrullet (fx fra dette repository eller en anden godkendt udrulning). Vi kan ikke importere en vilkårlig ekstern side automatisk; vi forbinder dens formular og tjenester via en offentlig nøgle.</p>`}</div>`
      : ''}
    <div class="row"><button class="btn btn-primary" type="submit">Gem og fortsæt</button><a class="btn btn-secondary" href="${args.project ? pbase(args.project) : `${BASE}/${args.company.id}`}">Tilbage</a></div>
  </form>
</div>`;
}

// ---------- Trinlinje ----------

export function stepNav(p: Project, current: Step | 'overblik'): H {
  const steps = STEPS.filter((s) => s !== 'virksomhed' && !(p.kind === 'intern' && s === 'indhold'));
  const reached = STEPS.indexOf((p.onboarding_step === 'faerdig' ? 'gennemgang' : p.onboarding_step) as Step);
  return html`<div class="stack-xs"><p class="eyebrow"><a href="${BASE}">Kunder</a> › <a href="${BASE}/${p.company_id}">Virksomhed</a> › <a href="${pbase(p)}">${p.name}</a></p>
  <nav class="tabs" aria-label="Opsætning">
    <a href="${pbase(p)}"${current === 'overblik' ? raw(' aria-current="page"') : ''}>Overblik</a>
    ${steps.map((s) => {
      const i = STEPS.indexOf(s);
      const done = i < reached || p.onboarding_step === 'faerdig';
      return html`<a href="${pbase(p)}/trin/${s}"${current === s ? raw(' aria-current="page"') : ''}>${done ? '✓ ' : ''}${STEP_LABEL[s]}</a>`;
    })}
  </nav></div>`;
}

// ---------- Trin C: udseende og indhold ----------

const colorField = (name: string, label: string, value: string) =>
  html`<div class="field"><label for="c-${name}">${label}</label><div class="row"><input id="c-${name}" type="color" name="${name}" value="${value}" style="width:56px;height:40px;padding:2px"><code>${value}</code></div></div>`;

export function contentPage(args: { csrf: string; project: Project; cfg: WebsiteConfig; files: FileRow[]; flash: string | null; error: string | null }): H {
  const { cfg, project: p } = args;
  const i = cfg.info;
  return html`<div class="stack-lg">
  ${stepNav(p, 'indhold')}
  <h1>Udseende og indhold</h1>
  ${flashBox(args.flash, args.error)}
  <form method="post" class="stack-lg">
    ${csrfField(args.csrf)}
    <section class="card stack">
      <h2 style="margin:0">Layout</h2>
      ${Object.entries(LAYOUTS).map(([k, l]) => html`<label class="check"><input type="radio" name="layout" value="${k}"${cfg.layout === k ? raw(' checked') : ''}> <span><strong>${l.label}.</strong> ${l.description}</span></label>`)}
    </section>
    <section class="card stack">
      <h2 style="margin:0">Farver, skrift og logo</h2>
      <div class="form-grid">
        ${colorField('primary', 'Hovedfarve (knapper og links)', cfg.brand.primary)}
        ${colorField('background', 'Baggrund', cfg.brand.background)}
        ${colorField('text', 'Tekst', cfg.brand.text)}
        <div class="field"><label for="c-font">Skrift</label><select id="c-font" name="font">${Object.entries(FONTS).map(([k, f]) => html`<option value="${k}"${cfg.brand.font === k ? raw(' selected') : ''}>${f.label}</option>`)}</select></div>
        <div class="field"><label for="c-logo">Logo</label><select id="c-logo" name="logo"><option value="">Intet logo (navnet vises)</option>${args.files.map((f) => html`<option value="${f.id}"${cfg.brand.logo === f.id ? raw(' selected') : ''}>${f.name}</option>`)}</select><p class="hint">Upload billeder nederst på siden.</p></div>
        <div class="field"><label for="c-logo_alt">Logoets alternative tekst</label><input id="c-logo_alt" name="logo_alt" value="${cfg.brand.logo_alt}" maxlength="120"></div>
      </div>
    </section>
    <section class="card stack">
      <h2 style="margin:0">Oplysninger på hjemmesiden</h2>
      <p class="small muted">Kun det, der står her, vises offentligt. Lad et felt stå tomt for at skjule det. Udfyld kun oplysninger, kunden har givet.</p>
      <div class="form-grid">
        <div class="field"><label for="i-name">Navn</label><input id="i-name" name="info_name" value="${i.name}" maxlength="120" required></div>
        <div class="field"><label for="i-tagline">Kort undertekst</label><input id="i-tagline" name="info_tagline" value="${i.tagline}" maxlength="200"></div>
        <div class="field"><label for="i-phone">Telefon</label><input id="i-phone" name="info_phone" value="${i.phone}" maxlength="40"></div>
        <div class="field"><label for="i-email">E-mail</label><input id="i-email" name="info_email" value="${i.email}" maxlength="200"></div>
        <div class="field"><label for="i-address">Adresse</label><textarea id="i-address" name="info_address" rows="2" maxlength="300">${i.address}</textarea></div>
        <div class="field"><label for="i-cvr">CVR (vises kun hvis udfyldt)</label><input id="i-cvr" name="info_cvr" value="${i.cvr}" maxlength="8" inputmode="numeric"></div>
      </div>
      <div class="field"><label for="i-hours">Åbningstider</label><textarea id="i-hours" name="info_opening_hours" rows="4" maxlength="600" placeholder="Mandag–fredag: 8–16">${i.opening_hours}</textarea><p class="hint">Én linje pr. linje på siden.</p></div>
    </section>
    <div class="sticky-save row"><button class="btn btn-primary" name="next" value="0">Gem</button><button class="btn btn-secondary" name="next" value="1">Gem og fortsæt til Tjenester</button></div>
  </form>
  <section class="card stack">
    <div class="row between"><h2 style="margin:0">Sider og menu</h2></div>
    <ul class="list">${cfg.pages.map((pg) => html`<li class="row between"><span><strong>${pg.title}</strong> <span class="muted small">/${pg.handle} · ${pg.sections.length} sektioner${pg.in_nav ? ' · i menuen' : ''}${!pg.seo_description ? ' · mangler Google-beskrivelse' : ''}</span></span>
      <a class="btn btn-secondary btn-small" href="${pbase(p)}/side/${pg.handle || 'forside'}">Ret side</a></li>`)}</ul>
    <form method="post" action="${pbase(p)}/sider" class="row">${csrfField(args.csrf)}<label class="visually-hidden" for="np">Ny side</label><input id="np" name="title" placeholder="Titel på ny side, fx Om os" maxlength="80" required style="max-width:300px"><button class="btn btn-secondary btn-small">Tilføj side</button></form>
  </section>
  <section class="card stack">
    <h2 style="margin:0">Billeder</h2>
    <p class="small muted">PNG, JPG, WebP eller GIF, højst 1,5 MB. Billederne tilhører kun denne kunde.</p>
    ${args.files.length ? html`<ul class="list small">${args.files.map((f) => html`<li class="row between"><span><a href="${pbase(p)}/billeder/${f.id}" target="_blank" rel="noopener">${f.name}</a> <span class="muted">· ${f.width}×${f.height} · #${f.id}</span></span>
      <form method="post" action="${pbase(p)}/billeder/${f.id}/slet" class="inline">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small">Slet</button></form></li>`)}</ul>` : ''}
    <form method="post" action="${pbase(p)}/billeder" enctype="multipart/form-data" class="row">${csrfField(args.csrf)}<input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required><button class="btn btn-secondary btn-small">Upload</button></form>
  </section>
</div>`;
}

export function pageEditorPage(args: { csrf: string; project: Project; page: Page; files: FileRow[]; flash: string | null; error: string | null }): H {
  const { page: pg, project: p } = args;
  const fileOpts = (sel: number | null) => html`<option value="">Intet billede</option>${args.files.map((f) => html`<option value="${f.id}"${sel === f.id ? raw(' selected') : ''}>${f.name}</option>`)}`;
  return html`<div class="stack-lg">
  ${stepNav(p, 'indhold')}
  <h1>Side: ${pg.title}</h1>
  ${flashBox(args.flash, args.error)}
  <form method="post" class="stack-lg">
    ${csrfField(args.csrf)}
    <section class="card stack">
      <div class="form-grid">
        <div class="field"><label for="pg-title">Titel (vises i menuen)</label><input id="pg-title" name="title" value="${pg.title}" maxlength="80" required></div>
        <div class="field"><label for="pg-seo">Sidetitel i Google <span class="muted small">(tom = titel og navn)</span></label><input id="pg-seo" name="seo_title" value="${pg.seo_title}" maxlength="120"></div>
      </div>
      <div class="field"><label for="pg-desc">Google-beskrivelse</label><textarea id="pg-desc" name="seo_description" rows="2" maxlength="300">${pg.seo_description}</textarea><p class="hint">1–2 sætninger om siden, med kundens egne ord.</p></div>
      <label class="check"><input type="checkbox" name="in_nav" value="1"${pg.in_nav ? raw(' checked') : ''}> Vis i menuen</label>
    </section>
    ${pg.sections.map((s, n) => {
      const def = SECTION_TYPES[s.type];
      const has = (f: string) => def.fields.includes(f as any);
      return html`<section class="card stack" id="s${n}">
        <div class="row between"><h2 style="margin:0">${n + 1}. ${def.label}</h2>
          <div class="row"><button class="btn btn-secondary btn-small" name="op" value="up:${n}"${n === 0 ? raw(' disabled') : ''} aria-label="Flyt op">↑</button><button class="btn btn-secondary btn-small" name="op" value="down:${n}"${n === pg.sections.length - 1 ? raw(' disabled') : ''} aria-label="Flyt ned">↓</button><button class="btn btn-secondary btn-small" name="op" value="del:${n}">Fjern</button></div></div>
        ${def.hint ? html`<p class="small muted">${def.hint}</p>` : ''}
        <input type="hidden" name="s${n}_type" value="${s.type}">
        ${has('heading') ? html`<div class="field"><label for="s${n}h">Overskrift</label><input id="s${n}h" name="s${n}_heading" value="${s.heading}" maxlength="160"></div>` : ''}
        ${has('text') ? html`<div class="field"><label for="s${n}t">${s.type === 'billede' ? 'Billedtekst' : 'Tekst'}</label><textarea id="s${n}t" name="s${n}_text" rows="${s.type === 'tekst' ? 6 : 3}" maxlength="4000">${s.text}</textarea></div>` : ''}
        ${has('items') ? html`<div class="field"><label for="s${n}i">Punkter</label><textarea id="s${n}i" name="s${n}_items" rows="5">${s.items.map((it) => `${it.title} | ${it.text}`).join('\n')}</textarea><p class="hint">Ét punkt pr. linje: "Titel | tekst".</p></div>` : ''}
        ${has('image') ? html`<div class="form-grid"><div class="field"><label for="s${n}img">Billede</label><select id="s${n}img" name="s${n}_image">${fileOpts(s.image)}</select></div>
          <div class="field"><label for="s${n}alt">Billedets alternative tekst</label><input id="s${n}alt" name="s${n}_image_alt" value="${s.image_alt}" maxlength="200"></div></div>` : ''}
        ${has('button_label') ? html`<div class="form-grid"><div class="field"><label for="s${n}bl">Knaptekst</label><input id="s${n}bl" name="s${n}_button_label" value="${s.button_label}" maxlength="60"></div>
          ${has('button_href') ? html`<div class="field"><label for="s${n}bh">Knappens link</label><input id="s${n}bh" name="s${n}_button_href" value="${s.button_href}" maxlength="300" placeholder="/kontakt, #bestil, https://…, tel:…"></div>` : ''}</div>` : ''}
      </section>`;
    })}
    <section class="card row"><label for="add-type">Tilføj sektion</label><select id="add-type" name="add_type" style="width:auto">${Object.entries(SECTION_TYPES).map(([k, d]) => html`<option value="${k}">${d.label}</option>`)}</select><button class="btn btn-secondary btn-small" name="op" value="add">Tilføj</button></section>
    <div class="sticky-save row"><button class="btn btn-primary" name="op" value="save">Gem side</button><a class="btn btn-secondary" href="${pbase(p)}/trin/indhold">Tilbage til indhold</a>
      ${pg.handle !== '' ? html`<button class="btn btn-danger btn-small" name="op" value="delete-page">Slet siden</button>` : ''}</div>
  </form>
</div>`;
}

// ---------- Trin D: tjenester ----------

export function servicesPage(args: { csrf: string; project: Project; services: Map<ServiceKey, ServiceRow>; errors: string[] }): H {
  const p = args.project;
  return html`<div class="stack-lg">
  ${stepNav(p, 'tjenester')}
  <div><h1>Tjenester</h1><p class="lead">Kun tjenester, der findes og virker i dag, kan vælges. At slå en tjeneste til opretter ikke et abonnement og ændrer ingen pris. Slår du en fra, bevares dens opsætning og data.</p></div>
  ${args.errors.length ? alert('err', html`${args.errors.map((e) => html`<div>${e}</div>`)}`) : ''}
  <form method="post" class="card stack">
    ${csrfField(args.csrf)}
    ${SERVICE_ORDER.map((k) => {
      const d = SERVICES[k];
      const row = args.services.get(k);
      const fits = d.kinds.includes(p.kind);
      return html`<label class="check" style="align-items:flex-start"><input type="checkbox" name="svc" value="${k}"${row?.enabled ? raw(' checked') : ''}${!fits ? raw(' disabled') : ''}>
        <span><strong>${d.label}</strong>${!fits ? html` <span class="muted small">(passer ikke til ${KIND_LABEL[p.kind].toLowerCase()})</span>` : ''}<br>${d.description}
        ${d.requires.length ? html`<br><span class="small muted">Kræver: ${d.requires.map((r) => SERVICES[r].label).join(', ')}</span>` : ''}
        <br><span class="small muted">Kører: ${d.where}</span>
        ${row && !row.enabled ? html`<br><span class="small">Slået fra; opsætning og data er bevaret.</span>` : ''}</span></label>`;
    })}
    <div><h3 style="margin:16px 0 8px">Ikke tilgængelige endnu</h3>
    <ul class="small muted">${PLANNED.map((x) => html`<li><strong>${x.label}</strong> · ${x.description}</li>`)}</ul></div>
    <div class="row"><button class="btn btn-primary" name="next" value="1">Gem og fortsæt</button><button class="btn btn-secondary" name="next" value="0">Gem</button></div>
  </form>
</div>`;
}

// ---------- Trin E: opsætning af tjenester ----------

export function setupPage(args: {
  csrf: string;
  project: Project;
  services: Map<ServiceKey, ServiceRow>;
  configs: Partial<Record<ServiceKey, Record<string, any>>>;
  problems: Partial<Record<ServiceKey, Problem[]>>;
  defaults: { hosts: Partial<Record<ServiceKey, string>>; email: string };
  catalog: { rows: number; plan: CatalogPlan | null; csv: string; error: string | null };
  integration: { formUrl: string; configUrl: string; key: string } | null;
  provisioning: { canDispatch: boolean; flash: string | null };
  flash: string | null;
}): H {
  const p = args.project;
  const enabled = SERVICE_ORDER.filter((k) => args.services.get(k)?.enabled);
  const status = (k: ServiceKey) => {
    const row = args.services.get(k)!;
    const st = SERVICE_STATUS[row.status] ?? SERVICE_STATUS.mangler!;
    return html`${badge(st.label, st.tone)}${row.status_detail ? html` <span class="small muted">${row.status_detail}</span>` : ''}${row.provisioned_url ? html` <a class="small" href="${row.provisioned_url}" target="_blank" rel="noopener">${row.provisioned_url}</a>` : ''}`;
  };
  const probs = (k: ServiceKey) => (args.problems[k]?.length ? alert('warn', html`${args.problems[k]!.map((x) => html`<div>${x.message}</div>`)}`) : '');
  const cfg = (k: ServiceKey) => args.configs[k] ?? {};
  const provisionable = enabled.filter((k) => k === 'varebestilling' || k === 'lagerstyring');
  return html`<div class="stack-lg">
  ${stepNav(p, 'opsaetning')}
  <div><h1>Opsætning af tjenester</h1><p class="lead">Kun felterne for de valgte tjenester. Hemmelige nøgler indtastes aldrig her; de ligger på serveren.</p></div>
  ${flashBox(args.flash ?? args.provisioning.flash, null)}
  ${!enabled.length ? html`<p class="card empty">Ingen tjenester valgt. <a href="${pbase(p)}/trin/tjenester">Vælg tjenester</a>.</p>` : ''}
  <form method="post" class="stack-lg">
    ${csrfField(args.csrf)}
    ${enabled.includes('hjemmeside')
      ? html`<section class="card stack"><div class="row between"><h2 style="margin:0">${SERVICES.hjemmeside.label}</h2><span>${status('hjemmeside')}</span></div>
        <p class="small">${p.kind === 'skabelon' ? html`Indholdet sættes op under <a href="${pbase(p)}/trin/indhold">Udseende og indhold</a>. Domæner sættes op under Overblik.` : html`Den tilsluttede side: <a href="${p.external_url ?? '#'}" target="_blank" rel="noopener">${p.external_url ?? 'ingen adresse'}</a>. Se "Integration" nedenfor.`}</p></section>`
      : ''}
    ${enabled.includes('kontaktformular')
      ? html`<section class="card stack"><div class="row between"><h2 style="margin:0">${SERVICES.kontaktformular.label}</h2><span>${status('kontaktformular')}</span></div>${probs('kontaktformular')}
        <div class="field"><label for="k-rec">Send henvendelser til (e-mail, flere adskilles med komma)</label><input id="k-rec" name="kontaktformular.recipients" value="${(cfg('kontaktformular').recipients ?? [args.defaults.email].filter(Boolean)).join(', ')}"></div>
        <div class="field"><label for="k-sub">Emnelinje <span class="muted small">(valgfri)</span></label><input id="k-sub" name="kontaktformular.subject" value="${cfg('kontaktformular').subject ?? ''}" maxlength="120" placeholder="Ny henvendelse fra hjemmesiden"></div>
        <p class="small muted">Henvendelser gemmes i Veyros database på projektet og kan ses her og i kundens kundepanel. Henvendelser fra forhåndsvisningen markeres som test og sendes ikke.</p></section>`
      : ''}
    ${(['varebestilling', 'lagerstyring'] as const).filter((k) => enabled.includes(k)).map(
      (k) => html`<section class="card stack"><div class="row between"><h2 style="margin:0">${SERVICES[k].label}</h2><span>${status(k)}</span></div>${probs(k)}
        <div class="form-grid">
          <div class="field"><label for="${k}-adm">Ejere, der kan logge ind første gang</label><input id="${k}-adm" name="${k}.admins" value="${(cfg(k).admins ?? [args.defaults.email].filter(Boolean)).join(', ')}"><p class="hint">Flere adskilles med komma. Resten oprettes i systemet bagefter.</p></div>
          <div class="field"><label for="${k}-dom">Eget domæne <span class="muted small">(valgfri)</span></label><input id="${k}-dom" name="${k}.domaene" value="${cfg(k).domaene ?? ''}" placeholder="${args.defaults.hosts[k] ?? ''}"><p class="hint">Tom = ${args.defaults.hosts[k] ?? 'standardadressen'}. Et eget domæne skal ligge i Veyros Cloudflare-konto.</p></div>
          <div class="field"><label for="${k}-afs">Afsender på e-mails <span class="muted small">(valgfri)</span></label><input id="${k}-afs" name="${k}.afsender" value="${cfg(k).afsender ?? ''}" placeholder="Firma <ordre@firma.dk>"><p class="hint">Tom = Veyros standardafsender. Et eget afsenderdomæne skal være verificeret i Resend.</p></div>
        </div>
        ${k === 'varebestilling'
          ? html`<fieldset class="stack"><legend class="label-like">Bestillingsregler (kan ændres i systemets Indstillinger bagefter)</legend>
            <label class="check"><input type="checkbox" name="varebestilling.pickup" value="1"${cfg(k).pickup !== false ? raw(' checked') : ''}> Afhentning</label>
            <label class="check"><input type="checkbox" name="varebestilling.delivery" value="1"${cfg(k).delivery !== false ? raw(' checked') : ''}> Levering</label>
            <div class="field"><label for="vb-fee">Leveringsgebyr (kr. inkl. moms)</label><input id="vb-fee" name="varebestilling.delivery_fee_kr" inputmode="numeric" value="${cfg(k).delivery_fee_kr ?? 49}" style="max-width:120px"></div>
            <label class="check"><input type="checkbox" name="varebestilling.auto_confirm" value="1"${cfg(k).auto_confirm ? raw(' checked') : ''}> Bekræft ordrer automatisk. <span class="small muted">Til: lageret trækkes, når kunden bestiller. Fra (standard): varerne reserveres, og lageret trækkes, når en medarbejder bekræfter ordren.</span></label>
            <div class="field"><label for="vb-not">Besked om nye ordrer og lagervarsler til</label><input id="vb-not" name="varebestilling.notify_email" type="email" value="${cfg(k).notify_email ?? args.defaults.email}"></div>
            </fieldset>`
          : ''}
      </section>`,
    )}
    ${enabled.includes('kundepanel')
      ? html`<section class="card stack"><div class="row between"><h2 style="margin:0">${SERVICES.kundepanel.label}</h2><span>${status('kundepanel')}</span></div>${probs('kundepanel')}
        <div class="field"><label for="kp-m">Kundens brugere (e-mail, adskilt med komma)</label><input id="kp-m" name="kundepanel.members" value="${(cfg('kundepanel').members ?? []).join(', ')}"><p class="hint">De får en invitation med engangslink, når du klikker "Gem". Ingen adgangskoder.</p></div></section>`
      : ''}
    ${enabled.length ? html`<div class="sticky-save row"><button class="btn btn-primary" name="next" value="1">Gem og fortsæt til gennemgang</button><button class="btn btn-secondary" name="next" value="0">Gem</button></div>` : ''}
  </form>
  ${enabled.includes('varebestilling') ? catalogSection(args) : ''}
  ${provisionable.length
    ? html`<section class="card stack"><h2 style="margin:0">Udrul tjenester</h2>
      <p>Opretter eller opdaterer kundens egen Worker og database for ${provisionable.map((k) => SERVICES[k].label.toLowerCase()).join(' og ')} med workflowet "Deploy kunder". Kan køres igen uden at oprette dubletter. Eksisterende data i kundens database bevares, og et startkatalog lægges kun ind første gang.</p>
      ${!args.provisioning.canDispatch ? alert('info', 'GITHUB_DISPATCH_TOKEN eller PROVISIONERING_TOKEN er ikke sat (engangsopsætning), så du får det manuelle trin at se, når du klikker.') : ''}
      <form method="post" action="${pbase(p)}/udrul">${csrfField(args.csrf)}<button class="btn btn-primary">Udrul tjenester</button></form></section>`
    : ''}
  ${args.integration ? integrationSection(args.integration, p) : ''}
</div>`;
}

function catalogSection(args: Parameters<typeof setupPage>[0]): H {
  const p = args.project;
  const c = args.catalog;
  const plan = c.plan;
  const counts = plan ? { opret: plan.planned.filter((r) => r.action === 'opret').length, opdater: plan.planned.filter((r) => r.action === 'opdater').length, uaendret: plan.planned.filter((r) => r.action === 'uændret').length } : null;
  const replacing = plan && c.rows > 0 && (counts!.opdater > 0 || plan.removed.length > 0);
  const deployed = args.services.get('varebestilling')?.status === 'forbundet';
  return html`<section class="card stack" id="katalog">
    <h2 style="margin:0">Startkatalog (varer)</h2>
    <p class="small">Varerne lægges i kundens bestillingssystem første gang, det udrulles. Nuværende startkatalog: <strong>${c.rows} varer</strong>. <a href="${BASE}/eksempel-vareliste.csv">Hent eksempelfil</a> (CSV med semikolon, som Excel gemmer). Kolonnerne er de samme som i bestillingssystemets egen import: Varenummer, Navn, Kategori, Pris, Lager, Enhed, Beskrivelse, Minimum, Aktiv, Lagerstyring.</p>
    ${deployed ? alert('info', html`Bestillingssystemet er udrullet. Ændringer i varer laves nu i systemets egen import (Admin › Varer › Importér), som sammenligner med de rigtige lagertal. Startkataloget her bruges ikke igen.`) : ''}
    ${c.error ? alert('err', c.error) : ''}
    ${plan
      ? html`<div class="stack">
        <p><strong>Forhåndsvisning (intet er gemt endnu):</strong> ${counts!.opret} nye, ${counts!.opdater} ændrede, ${counts!.uaendret} uændrede${plan.removed.length ? `, ${plan.removed.length} fjernes (${plan.removed.slice(0, 8).join(', ')}${plan.removed.length > 8 ? ' …' : ''})` : ''}.</p>
        ${plan.unknownColumns.length ? html`<p class="small muted">Kolonner, der ignoreres: ${plan.unknownColumns.join(', ')}</p>` : ''}
        ${plan.errors.length ? alert('err', html`<strong>${plan.errors.length} linjer kan ikke importeres:</strong><ul>${plan.errors.slice(0, 30).map((e: ImportError) => html`<li>Linje ${e.line}: ${e.message}</li>`)}</ul>Ret filen, og prøv igen. Intet er gemt.`) : ''}
        <div class="table-wrap"><table class="responsive small"><thead><tr><th>Handling</th><th>Varenummer</th><th>Navn</th><th>Pris</th><th>Lager</th><th>Enhed</th></tr></thead>
        <tbody>${plan.planned.slice(0, 50).map((r) => html`<tr><td>${r.action === 'opret' ? 'Opret' : r.action === 'opdater' ? 'Opdatér' : 'Uændret'}</td><td>${r.sku}</td><td>${r.name ?? r.existing?.name ?? ''}</td><td>${r.price !== undefined ? (r.price / 100).toFixed(2).replace('.', ',') : ''}</td><td>${r.stock ?? ''}</td><td>${r.unit ?? ''}</td></tr>`)}</tbody></table></div>
        ${plan.planned.length > 50 ? html`<p class="small muted">… og ${plan.planned.length - 50} mere.</p>` : ''}
        ${!plan.errors.length && plan.planned.length
          ? html`<form method="post" action="${pbase(p)}/katalog" class="stack">${csrfField(args.csrf)}<input type="hidden" name="op" value="apply"><textarea name="csv" hidden>${c.csv}</textarea>
            ${replacing ? html`<label class="check"><input type="checkbox" name="confirm_replace" value="1" required> Jeg vil erstatte det nuværende startkatalog: ændrede varer overskrives${plan.removed.length ? ', og varer, der ikke er i filen, fjernes' : ''}.</label>` : ''}
            <button class="btn btn-primary">Gem startkatalog</button></form>`
          : ''}
      </div>`
      : ''}
    ${!deployed
      ? html`<form method="post" action="${pbase(p)}/katalog" enctype="multipart/form-data" class="row">${csrfField(args.csrf)}<input type="hidden" name="op" value="preview"><input type="file" name="file" accept=".csv,text/csv" required><button class="btn btn-secondary btn-small">Vis forhåndsvisning</button></form>`
      : ''}
  </section>`;
}

function integrationSection(i: { formUrl: string; configUrl: string; key: string }, p: Project): H {
  const snippet = `<form method="post" action="${i.formUrl}">
  <input type="hidden" name="return_to" value="/kontakt">
  <input name="name" required> <input name="email" type="email" required>
  <input name="phone"> <textarea name="message" required></textarea>
  <label><input type="checkbox" name="samtykke" value="1" required> Samtykke</label>
  <input name="website_url" style="display:none" tabindex="-1" autocomplete="off">
  <button>Send</button>
</form>`;
  return html`<section class="card stack"><h2 style="margin:0">Integration for en specialbygget side</h2>
    <p class="small">Den samme forbindelse virker for alle specialbyggede sider: en almindelig HTML-formular, der sender til Veyro. Den offentlige nøgle <code>${i.key}</code> er ikke hemmelig; den giver kun lov til at aflevere en henvendelse til netop dette projekt, og kun fra projektets egne adresser${p.external_url ? html` (${new URL(p.external_url).origin})` : ''}. Efter afsendelse sendes besøgende tilbage med <code>?sendt=1</code>.</p>
    <div class="field"><label for="int-form">Formularens adresse</label><input id="int-form" readonly value="${i.formUrl}"></div>
    <div class="field"><label for="int-cfg">Offentlig konfiguration (navn, kontakt, bestillingslink)</label><input id="int-cfg" readonly value="${i.configUrl}"></div>
    <div class="field"><label for="int-snip">Eksempel</label><textarea id="int-snip" readonly rows="8">${snippet}</textarea></div></section>`;
}

// ---------- Trin F: gennemgang og projektets overblik ----------

export interface HubArgs {
  csrf: string;
  company: Company;
  project: Project;
  cfg: WebsiteConfig;
  services: Map<ServiceKey, ServiceRow>;
  /** Tjek af kladden (det, der godkendes) */
  checks: Check[];
  draftHash: string;
  approved: Version | null;
  /** Antal fejl i en ældre godkendt version, når kladden er ændret siden (null = den godkendte er kladden) */
  approvedErrors: number | null;
  live: Version | null;
  versions: Version[];
  publications: PublicationRow[];
  domains: DomainRow[];
  links: PreviewLinkRow[];
  leads: ProjectLead[];
  state: { label: string; tone: Tone };
  urls: { s: string; veyroHost: string; domainsReady: boolean; saasReady: boolean };
  flash: string | null;
  error: string | null;
  newLink: string | null;
  companies: Company[];
  mode: 'overblik' | 'gennemgang';
}

const CHECK_TONE: Record<Check['status'], Tone> = { ok: 'ok', fejl: 'err', advarsel: 'warn', info: 'neutral' };
const CHECK_LABEL: Record<Check['status'], string> = { ok: 'OK', fejl: 'Skal rettes', advarsel: 'Bemærk', info: 'Info' };

function checksList(p: Project, checks: Check[]): H {
  return html`<ul class="list">${checks.map((c) => html`<li><div class="item-head"><h3 style="font-size:16px">${c.label}</h3>${badge(CHECK_LABEL[c.status], CHECK_TONE[c.status])}</div>
    <p class="small" style="margin:4px 0 0">${c.message}${c.fix && c.status !== 'ok' && c.status !== 'info' ? html` <a href="${pbase(p)}/trin/${c.fix}">Ret</a>` : ''}</p></li>`)}</ul>`;
}

export function hubPage(a: HubArgs): H {
  const p = a.project;
  const errors = a.checks.filter((c) => c.status === 'fejl').length;
  const approvedCurrent = a.approved && a.approved.content_hash === a.draftHash;
  const draftChanged = a.live && a.live.content_hash !== a.draftHash;
  const enabled = SERVICE_ORDER.filter((k) => a.services.get(k)?.enabled);
  const isSite = p.kind !== 'intern';
  return html`<div class="stack-lg">
  ${stepNav(p, a.mode)}
  <div class="row between"><div><h1>${a.mode === 'gennemgang' ? 'Gennemgang' : p.name}</h1><p class="small muted">${a.company.name} · ${KIND_LABEL[p.kind]} · id <code>${p.id}</code></p></div>${badge(a.state.label, a.state.tone)}</div>
  ${flashBox(a.flash, a.error)}
  ${a.newLink ? alert('ok', html`<strong>Kundelink oprettet.</strong> Det vises kun nu, så kopiér det: <input readonly value="${a.newLink}" style="margin-top:8px">`) : ''}

  ${a.mode === 'gennemgang'
    ? html`<section class="card"><h2 style="margin:0 0 8px">Opsummering</h2><dl class="facts">
      <div><dt>Virksomhed</dt><dd>${a.company.name}${a.company.cvr ? ` · CVR ${a.company.cvr}` : ''} <a class="small" href="${BASE}/${a.company.id}/rediger">Ret</a></dd></div>
      <div><dt>Projekt</dt><dd>${p.name} · ${KIND_LABEL[p.kind]} <a class="small" href="${pbase(p)}/trin/type">Ret</a></dd></div>
      ${isSite ? html`<div><dt>Hjemmeside</dt><dd>${p.kind === 'skabelon' ? html`${LAYOUTS[a.cfg.layout].label} layout · ${a.cfg.pages.length} sider <a class="small" href="${pbase(p)}/trin/indhold">Ret</a>` : html`${p.external_url ?? '–'}`}</dd></div>` : ''}
      ${isSite ? html`<div><dt>Domæne</dt><dd>${a.domains.length ? a.domains.map((d) => `${d.hostname} (${DOMAIN_STATUS[d.status]})`).join(', ') : `Intet endnu · ${a.urls.s}`}</dd></div>` : ''}
      <div><dt>Tjenester</dt><dd>${enabled.map((k) => SERVICES[k].label).join(', ') || '–'} <a class="small" href="${pbase(p)}/trin/tjenester">Ret</a></dd></div>
      </dl></section>`
    : ''}

  ${isSite
    ? html`<section class="card stack">
    <h2 style="margin:0">Forhåndsvisning, godkendelse og publicering</h2>
    ${p.kind === 'skabelon'
      ? html`<div class="row">
        <form method="post" action="${pbase(p)}/forhaandsvisning" target="_blank">${csrfField(a.csrf)}<button class="btn btn-secondary">Forhåndsvisning</button></form>
        ${a.live ? html`<a class="btn btn-secondary" href="${a.urls.s}" target="_blank" rel="noopener">Åbn publiceret side</a>` : ''}
        ${a.domains.filter((d) => d.status === 'aktiv').map((d) => html`<a class="btn btn-secondary" href="https://${d.hostname}" target="_blank" rel="noopener">Åbn ${d.hostname}</a>`)}
      </div>`
      : html`<div class="row">${p.external_url ? html`<a class="btn btn-secondary" href="${p.external_url}" target="_blank" rel="noopener">Åbn den tilsluttede side</a>` : ''}</div>`}
    <dl class="facts">
      <div><dt>Kladde</dt><dd>Senest ændret ${formatDateTime(p.draft_updated_at)}${draftChanged ? html` <span class="badge b-warn">Ikke publiceret</span>` : ''}</dd></div>
      <div><dt>Godkendt version</dt><dd>${a.approved ? html`Version ${a.approved.number}, ${formatDateTime(a.approved.approved_at)}${approvedCurrent ? '' : html` <span class="badge b-warn">Kladden er ændret siden</span>`}` : 'Ingen'}</dd></div>
      <div><dt>Publiceret version</dt><dd>${a.live ? html`Version ${a.live.number}, ${formatDateTime(a.live.published_at)}${p.offline ? html` <span class="badge b-warn">Offline</span>` : ''}` : 'Ingen'}</dd></div>
      <div><dt>Fast adresse</dt><dd>${a.live ? html`<a href="${a.urls.s}">${a.urls.s}</a>` : html`<span class="muted">${a.urls.s} (efter publicering)</span>`}</dd></div>
    </dl>
    <h3 style="margin:8px 0 0">Tjek før publicering ${errors ? badge(`${errors} skal rettes`, 'err') : badge('Klar', 'ok')}</h3>
    ${checksList(p, a.checks)}
    <div class="stack">
      <p class="small"><strong>Når du publicerer:</strong> ${p.kind === 'skabelon' ? html`tjekkene køres igen, alle sider bygges, og den godkendte version bliver den aktive i ét skridt. Den publicerede side kontrolleres bagefter; svarer den ikke korrekt, bliver den tidligere version automatisk aktiv igen. Domæner sættes op eller kontrolleres. Henvendelser, ordrer og lager påvirkes ikke.` : html`den tilsluttede side kontrolleres, og formularen og tjenesterne markeres som forbundet. Selve siden udrulles af sin egen kilde og ændres ikke herfra.`}</p>
      <div class="row">
        ${!approvedCurrent ? html`<form method="post" action="${pbase(p)}/godkend">${csrfField(a.csrf)}<button class="btn btn-secondary">Godkend denne version</button></form>` : ''}
        ${a.approved && a.live?.id !== a.approved.id
          ? html`<form method="post" action="${pbase(p)}/publicer">${csrfField(a.csrf)}<input type="hidden" name="version_id" value="${a.approved.id}"><button class="btn btn-accent"${(approvedCurrent ? errors : a.approvedErrors) ? raw(' disabled') : ''}>Publicér version ${a.approved.number}${approvedCurrent ? '' : ' (uden kladdens senere ændringer)'}</button></form>`
          : a.approved
            ? ''
            : html`<p class="small muted">Godkend en version for at kunne publicere.</p>`}
      </div>
    </div>
  </section>`
    : html`<section class="card"><p>Ingen offentlig hjemmeside. Tjenesterne sættes op og udrulles under <a href="${pbase(p)}/trin/opsaetning">Opsætning af tjenester</a>.</p>${checksList(p, a.checks)}</section>`}

  ${p.kind === 'skabelon' && a.mode === 'overblik' ? domainsSection(a) : ''}
  ${p.kind === 'skabelon' && a.mode === 'overblik' ? linksSection(a) : ''}

  ${a.mode === 'overblik'
    ? html`<section class="card stack"><h2 style="margin:0">Tjenester</h2>
    ${enabled.length
      ? html`<ul class="list">${enabled.map((k) => {
          const row = a.services.get(k)!;
          const st = SERVICE_STATUS[row.status] ?? SERVICE_STATUS.mangler!;
          return html`<li class="row between"><span><strong>${SERVICES[k].label}</strong>${row.status_detail ? html`<br><span class="small muted">${row.status_detail}</span>` : ''}${row.provisioned_url ? html`<br><a class="small" href="${row.provisioned_url}" target="_blank" rel="noopener">Åbn ${row.provisioned_url}</a>` : ''}</span>${badge(st.label, st.tone)}</li>`;
        })}</ul>`
      : html`<p class="empty">Ingen tjenester.</p>`}
    <a href="${pbase(p)}/trin/opsaetning">Ret opsætning</a></section>`
    : ''}

  ${a.mode === 'overblik' && a.leads.length
    ? html`<section class="card"><h2 style="margin:0 0 8px">Seneste henvendelser fra hjemmesiden</h2><ul class="list small">${a.leads.map((l) => html`<li><strong>${l.name ?? ''}</strong> · <a href="mailto:${l.email}">${l.email}</a>${l.test ? html` ${badge('Test', 'neutral')}` : ''}<div class="meta">${formatDateTime(l.created_at)}${l.page ? ` · /${l.page}` : ''}${!l.test ? (l.notified_at ? ' · sendt på e-mail' : ' · ikke sendt på e-mail endnu') : ''}</div><p class="prewrap" style="margin:4px 0 0">${l.message ?? ''}</p></li>`)}</ul></section>`
    : ''}

  ${isSite && a.mode === 'overblik'
    ? html`<section class="card stack"><h2 style="margin:0">Versioner og publiceringer</h2>
    ${a.versions.length
      ? html`<div class="table-wrap"><table class="responsive small"><thead><tr><th>Version</th><th>Godkendt</th><th>Publiceret</th><th></th></tr></thead><tbody>${a.versions.map(
          (v) => html`<tr><td>${v.number}${a.live?.id === v.id ? html` ${badge('Aktiv', 'ok')}` : ''}</td><td>${v.approved_at ? `${formatDateTime(v.approved_at)} · ${v.approved_by ?? ''}` : '–'}</td><td>${v.published_at ? formatDateTime(v.published_at) : '–'}</td>
          <td>${v.published_at && a.live?.id !== v.id ? html`<form method="post" action="${pbase(p)}/rul-tilbage" class="inline">${csrfField(a.csrf)}<input type="hidden" name="version_id" value="${v.id}"><button class="btn btn-secondary btn-small">Rul tilbage hertil</button></form>` : ''}</td></tr>`,
        )}</tbody></table></div>
        <p class="small muted">Tilbagerulning skifter kun hjemmesidens indhold. Henvendelser, ordrer og lager i databaserne rulles ikke tilbage.</p>`
      : html`<p class="empty">Ingen versioner endnu.</p>`}
    ${a.publications.length ? html`<h3 style="margin:8px 0 0">Seneste publiceringer</h3><ul class="list small">${a.publications.map((pub) => pubItem(pub, a.versions))}</ul>` : ''}
    ${a.live
      ? html`<div class="row">${p.offline
          ? html`<form method="post" action="${pbase(p)}/online">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small">Sæt online igen</button></form>`
          : html`<form method="post" action="${pbase(p)}/offline">${csrfField(a.csrf)}<label class="check small"><input type="checkbox" name="confirm" value="1" required> Siden viser "midlertidigt utilgængelig"; intet slettes</label><button class="btn btn-secondary btn-small">Tag siden offline</button></form>`}</div>
        <p class="small muted">Opsigelse af abonnement og sletning af data er separate handlinger og sker ikke herfra.</p>`
      : ''}
    </section>`
    : ''}

  ${p.kind === 'skabelon' && a.mode === 'overblik'
    ? html`<section class="card stack"><h2 style="margin:0">Brug som startpunkt</h2>
      <p class="small">Opretter et nyt projekt med samme layout, farver, skrift og opbygning af sider og sektioner. Tekster, billeder, logo, kontaktoplysninger, domæner, henvendelser og brugere kopieres ikke.</p>
      <form method="post" action="${pbase(p)}/startpunkt" class="row">${csrfField(a.csrf)}<label class="visually-hidden" for="sp-c">Til virksomhed</label><select id="sp-c" name="company_id" style="width:auto">${a.companies.map((c) => html`<option value="${c.id}"${c.id === a.company.id ? raw(' selected') : ''}>${c.name}</option>`)}</select><button class="btn btn-secondary btn-small">Opret nyt projekt herfra</button></form></section>`
    : ''}
</div>`;
}

function pubItem(pub: PublicationRow, versions: Version[]): H {
  let steps: PubStep[] = [];
  try {
    steps = JSON.parse(pub.steps);
  } catch {
    /* tom */
  }
  const v = versions.find((x) => x.id === pub.version_id);
  const tone: Tone = pub.status === 'faerdig' ? 'ok' : pub.status === 'fejlet' ? 'err' : 'warn';
  return html`<li><div class="item-head"><strong>${pub.kind === 'publicering' ? 'Publicering' : 'Tilbagerulning'} af version ${v?.number ?? '?'}</strong>${badge(pub.status === 'faerdig' ? 'Gennemført' : pub.status === 'fejlet' ? 'Fejlet' : 'Kører', tone)}</div>
    <div class="meta">${formatDateTime(pub.started_at)} · ${pub.actor ?? ''}</div>
    ${pub.error ? html`<p style="margin:4px 0">${pub.error}</p>` : ''}
    <ul style="margin:4px 0 0;padding-left:18px">${steps.map((s) => html`<li>${s.ok ? '✓' : '✗'} ${s.label}: ${s.detail}</li>`)}</ul></li>`;
}

function domainsSection(a: HubArgs): H {
  const p = a.project;
  const hasVeyro = a.domains.some((d) => d.kind === 'veyro');
  return html`<section class="card stack" id="domaener"><h2 style="margin:0">Domæner</h2>
    ${!a.urls.domainsReady ? alert('info', html`<strong>Kræver engangsopsætning.</strong> CF_API_TOKEN er ikke sat på veyro-Workeren, så domæner kan gemmes, men ikke sættes op endnu. Siden kan altid ses på ${a.urls.s} efter publicering.`) : ''}
    ${a.domains.length
      ? html`<ul class="list">${a.domains.map((d) => {
          let records: { type: string; name: string; value: string; purpose: string }[] = [];
          try {
            records = JSON.parse(d.records);
          } catch {
            /* tom */
          }
          return html`<li class="stack-xs"><div class="item-head"><h3 style="font-size:16px">${d.hostname} <span class="muted small">(${d.kind === 'veyro' ? 'veyro.dk-adresse' : 'eget domæne'})</span></h3>${badge(DOMAIN_STATUS[d.status], DOMAIN_TONE[d.status])}</div>
          ${d.detail ? html`<p class="small" style="margin:0">${d.detail}</p>` : ''}
          ${records.length ? html`<p class="small" style="margin:8px 0 0"><strong>DNS-poster, kunden skal oprette hos sin DNS-udbyder</strong> (oplyst af Cloudflare). Mail- og andre poster skal ikke ændres.</p>
            <div class="table-wrap"><table class="small"><thead><tr><th>Type</th><th>Navn</th><th>Værdi</th><th>Formål</th></tr></thead><tbody>${records.map((r) => html`<tr><td>${r.type}</td><td><code>${r.name}</code></td><td><code>${r.value}</code></td><td>${r.purpose}</td></tr>`)}</tbody></table></div>` : ''}
          <div class="meta">${d.last_check_at ? `Sidst tjekket ${formatDateTime(d.last_check_at)}` : 'Ikke tjekket'}${d.verified_at ? ` · verificeret ${formatDateTime(d.verified_at)}` : ''}</div>
          <div class="row"><form method="post" action="${pbase(p)}/domaener/${d.id}/tjek">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small">${d.method ? 'Tjek igen' : 'Sæt op igen'}</button></form>
          <form method="post" action="${pbase(p)}/domaener/${d.id}/fjern">${csrfField(a.csrf)}<label class="check small"><input type="checkbox" name="confirm" value="1" required> Fjern ${d.hostname} fra siden</label><button class="btn btn-secondary btn-small">Fjern</button></form></div></li>`;
        })}</ul>`
      : html`<p class="empty">Ingen domæner endnu.</p>`}
    ${!hasVeyro ? html`<form method="post" action="${pbase(p)}/domaener" class="row">${csrfField(a.csrf)}<input type="hidden" name="kind" value="veyro"><input type="hidden" name="hostname" value="${a.urls.veyroHost}"><button class="btn btn-secondary btn-small">Tilføj ${a.urls.veyroHost}</button></form>` : ''}
    <form method="post" action="${pbase(p)}/domaener" class="row">${csrfField(a.csrf)}<input type="hidden" name="kind" value="eget"><label class="visually-hidden" for="dom">Eget domæne</label><input id="dom" name="hostname" placeholder="www.kundensdomæne.dk" style="max-width:320px" required><button class="btn btn-secondary btn-small">Tilføj eget domæne</button></form>
    <p class="small muted">Domæner registreres eller købes aldrig herfra, og navneservere og mailposter ændres ikke. ${a.urls.saasReady ? 'Domæner med DNS uden for Veyros Cloudflare-konto sættes op med Cloudflare for SaaS; kunden får de nøjagtige DNS-poster.' : 'Domæner med DNS uden for Veyros Cloudflare-konto kræver, at Cloudflare for SaaS sættes op én gang (se docs/KUNDEOPSAETNING.md).'} Et domæne vises først som live, når Cloudflare, DNS og HTTPS er bekræftet.</p>
  </section>`;
}

function linksSection(a: HubArgs): H {
  const p = a.project;
  const active = a.links.filter((l) => !l.revoked_at && l.expires_at > Math.floor(Date.now() / 1000));
  return html`<section class="card stack"><h2 style="margin:0">Kundelink til forhåndsvisning</h2>
    <p class="small">Et link, kunden kan bruge til at se kladden før publicering. Det udløber efter 14 dage og kan tilbagekaldes. Siden er skjult for søgemaskiner, og formularer gemmes som test.</p>
    ${active.length ? html`<ul class="list small">${active.map((l) => html`<li class="row between"><span>${l.label} · oprettet ${formatDate(l.created_at)} · udløber ${formatDate(l.expires_at)}</span>
      <form method="post" action="${pbase(p)}/kundelink/${l.token_hash}/tilbagekald" class="inline">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small">Tilbagekald</button></form></li>`)}</ul>` : ''}
    <form method="post" action="${pbase(p)}/kundelink" class="row">${csrfField(a.csrf)}<label class="visually-hidden" for="ll">Hvem er linket til?</label><input id="ll" name="label" placeholder="Til fx Jens hos kunden" maxlength="80" required style="max-width:280px"><button class="btn btn-secondary btn-small">Opret kundelink</button></form>
  </section>`;
}

// ---------- Kundepanelet (kundens egne brugere) ----------

export function memberSitesPage(args: { items: { company: Company; project: Project; live: string | null; state: { label: string; tone: Tone }; leads: ProjectLead[]; services: { label: string; status: string; url: string | null }[] }[] }): H {
  return html`<div class="stack-lg">
  <div><p class="eyebrow">Kundepanel</p><h1>Hjemmeside og systemer</h1></div>
  ${args.items.length === 0 ? html`<p class="card empty">Der er ingen hjemmesider eller systemer knyttet til din bruger endnu.</p>` : ''}
  ${args.items.map(
    (i) => html`<section class="card stack">
      <div class="item-head"><h2 style="margin:0">${i.project.name}</h2>${badge(i.state.label, i.state.tone)}</div>
      <p class="small muted">${i.company.name}</p>
      ${i.live ? html`<p><a class="btn btn-secondary btn-small" href="${i.live}" target="_blank" rel="noopener">Åbn hjemmesiden</a></p>` : ''}
      ${i.services.length ? html`<ul class="list small">${i.services.map((s) => html`<li class="row between"><span>${s.label}${s.url ? html` · <a href="${s.url}" target="_blank" rel="noopener">Åbn</a>` : ''}</span><span>${s.status}</span></li>`)}</ul>` : ''}
      <h3 style="margin:8px 0 0">Henvendelser fra hjemmesiden</h3>
      ${i.leads.length
        ? html`<ul class="list small">${i.leads.map((l) => html`<li><strong>${l.name ?? ''}</strong> · <a href="mailto:${l.email}">${l.email}</a>${l.phone ? ` · ${l.phone}` : ''}<div class="meta">${formatDateTime(l.created_at)}</div><p class="prewrap" style="margin:4px 0 0">${l.message ?? ''}</p></li>`)}</ul>`
        : html`<p class="empty">Ingen henvendelser endnu.</p>`}
    </section>`,
  )}
</div>`;
}

export type { SectionType };
