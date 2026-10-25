// Kundeemner i admin: oversigt med arbejdsfiltre, oprettelse, detaljeside med tidslinje, blokeringer og indstillinger.
import { html, raw } from 'hono/html';
import { formatDate, formatDateTime } from '../lib/format';
import {
  BLOCK_SCOPE_LABEL,
  BLOCK_SCOPES,
  CHANNEL_LABEL,
  CHANNELS,
  PAGE_SIZE,
  PRIORITIES,
  PRIORITY_LABEL,
  PROSPECT_STATUSES,
  STATUS_LABEL,
  STATUS_TONE,
  VIEW_LABEL,
  VIEWS,
  isSalesActive,
  staffName,
  type BlockRow,
  type ContactRow,
  type DuplicateHit,
  type EventRow,
  type ListFilter,
  type ProspectForm,
  type ProspectRow,
  type ProspectStatus,
} from '../lib/prospects';
import { alert, csrfField, type H } from './layout';

const TONE_CLASS: Record<string, string> = { neutral: 'b-neutral', info: 'b-neutral', warn: 'b-warn', ok: 'b-ok', err: 'b-err', accent: 'b-accent' };

export function statusBadge(s: ProspectStatus): H {
  return html`<span class="badge ${TONE_CLASS[STATUS_TONE[s]]}">${STATUS_LABEL[s]}</span>`;
}

const dk = (day: string | null) => {
  if (!day) return '–';
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
};

function crumbs(...items: [string, string | null][]): H {
  return html`<p class="eyebrow">${items.map(([label, href], i) => html`${i ? ' / ' : ''}${href ? html`<a href="${href}">${label}</a>` : label}`)}</p>`;
}

function followCell(p: ProspectRow, today: string): H | string {
  if (!p.follow_up_on || !isSalesActive(p)) return p.next_action ?? '–';
  const late = p.follow_up_on < today;
  const now = p.follow_up_on === today;
  return html`${p.next_action ?? 'Opfølgning'}<br><span class="small ${late ? 'text-err' : ''}">${late ? 'Overskredet: ' : now ? 'I dag: ' : ''}${dk(p.follow_up_on)}</span>${p.follow_up_review ? html` <span class="badge b-warn">Svar modtaget</span>` : ''}`;
}

export const PROSPECT_FLASH: Record<string, string> = {
  oprettet: 'Kundeemnet er oprettet.',
  gemt: 'Ændringerne er gemt.',
  status: 'Status er ændret.',
  ansvarlig: 'Ansvarlig er ændret.',
  kontakt: 'Kontakten er registreret.',
  note: 'Noten er gemt.',
  opfoelgning: 'Opfølgningen er opdateret.',
  arkiveret: 'Kundeemnet er arkiveret. Salgsopfølgning er stoppet.',
  gendannet: 'Kundeemnet er gendannet fra arkivet.',
  blokeret: 'Blokeringen er registreret. Salgsopfølgning og nye salgsudkast er stoppet.',
  ophaevet: 'Blokeringen er ophævet. Historikken er bevaret.',
  kunde: 'Kundeemnet er knyttet til kunden og har status "Blev kunde". Tid, udgifter og historik følger med.',
  'kunde-fjernet': 'Kundetilknytningen er fjernet.',
  flettet: 'Kundeemnerne er lagt sammen. Al historik er bevaret.',
  link: 'Linket er gemt.',
  'link-slettet': 'Linket er fjernet.',
  fil: 'Filen er gemt.',
  'fil-slettet': 'Filen er slettet.',
  forespoergsel: 'Forespørgslen er knyttet til kundeemnet.',
  slettet: 'Kundeemnet er slettet.',
  notifikationer: 'Notifikationerne er markeret som læst.',
  vurdering: 'Vurderingen er godkendt.',
  'vurdering-gemt': 'Vurderingen er gemt, men ikke godkendt.',
  'vurdering-hentes': 'Vurderingen hentes i baggrunden. Genindlæs siden om lidt. Den skal godkendes, før den bruges.',
  'mail-bekraeftet': 'Mailsamtalen er bekræftet og knyttet til kundeemnet.',
  'mail-afvist': 'Mailsamtalen er fjernet fra kundeemnet. Originalen i Gmail er ikke berørt.',
  'mail-tildelt': 'Mailsamtalen er tildelt.',
  'mail-knyttet': 'Mailsamtalen er knyttet til kundeemnet.',
  sats: 'Standardsatsen er gemt. Den gælder for nye registreringer; eksisterende registreringer beholder deres sats.',
};

// ---------- Oversigt ----------

export function prospectsListPage(args: {
  rows: ProspectRow[];
  total: number;
  filter: ListFilter;
  counts: Record<string, number>;
  staff: string[];
  industries: string[];
  areas: string[];
  today: string;
  notifications: { id: number; prospect_id: number | null; text: string; created_at: number }[];
  csrf: string;
  flash: string | null;
  query: string;
}): H {
  const f = args.filter;
  const pages = Math.max(1, Math.ceil(args.total / PAGE_SIZE));
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(args.query);
    for (const [k, v] of Object.entries(patch)) v === null ? p.delete(k) : p.set(k, v);
    const s = p.toString();
    return `/admin/kundeemner${s ? `?${s}` : ''}`;
  };
  const sel = (name: string, label: string, options: [string, string][], value: string | null) =>
    html`<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}"><option value="">Alle</option>${options.map(
      ([v, l]) => html`<option value="${v}"${v === value ? html` selected` : ''}>${l}</option>`,
    )}</select></div>`;
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'])}<h1>Kundeemner</h1>
    <p class="lead">Virksomheder, vi selv finder og undersøger. Indgående henvendelser fra hjemmesiden ligger under <a href="/admin/forespoergsler">Forespørgsler</a>, og eksisterende kunder under <a href="/admin/kunder">Kunder</a>.</p></div>
  ${args.flash && PROSPECT_FLASH[args.flash] ? alert('ok', PROSPECT_FLASH[args.flash]!) : ''}
  ${args.notifications.length
    ? html`<section class="card stack" aria-labelledby="notif-h"><div class="row between"><h2 id="notif-h" class="h-small" style="margin:0">Påmindelser til dig (${args.notifications.length})</h2>
        <form method="post" action="/admin/kundeemner/notifikationer/laest" class="inline">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit">Markér som læst</button></form></div>
        <ul class="list">${args.notifications.map((n) => html`<li class="small">${n.prospect_id ? html`<a href="/admin/kundeemner/${n.prospect_id}">${n.text}</a>` : n.text}<div class="meta">${formatDateTime(n.created_at)}</div></li>`)}</ul></section>`
    : ''}
  <div class="row">
    <a class="btn btn-accent" href="/admin/kundeemner/ny">Nyt kundeemne</a>
    <a class="btn btn-secondary" href="/admin/kundeemner/link">Tilføj via link</a>
    <a class="btn btn-secondary" href="/admin/kundeemner/find">Find nye kundeemner</a>
    <a class="btn btn-secondary" href="/admin/kundeemner/import">Importér fra Excel/CSV</a>
    <a class="btn btn-secondary" href="/admin/kundeemner/mail">Mailkonti</a>
    <a class="btn btn-secondary" href="/admin/kundeemner/blokeringer">Blokeringer</a>
  </div>
  <nav class="row tabs" aria-label="Arbejdsfiltre">${VIEWS.filter((v) => v !== 'alle').map(
    (v) => html`<a class="btn btn-small ${f.view === v ? 'btn-primary' : 'btn-secondary'}" href="${qs({ visning: v === 'aktive' ? null : v, side: null })}"${f.view === v ? html` aria-current="page"` : ''}>${VIEW_LABEL[v]}${args.counts[v] ? ` (${args.counts[v]})` : ''}</a>`,
  )}</nav>
  ${f.importId ? alert('info', html`Viser kundeemner fra <a href="/admin/kundeemner/import/${f.importId}">import #${f.importId}</a>. <a href="${qs({ import: null, side: null })}">Vis alle</a>`) : ''}
  <form method="get" action="/admin/kundeemner" class="card stack" role="search">
    ${f.view !== 'aktive' ? html`<input type="hidden" name="visning" value="${f.view}">` : ''}
    ${f.importId ? html`<input type="hidden" name="import" value="${f.importId}">` : ''}
    <div class="field"><label for="f-q">Søg</label><input id="f-q" name="q" type="search" value="${f.q}" maxlength="100" placeholder="Virksomhed, by, kontaktperson, mail, domæne eller CVR"></div>
    <div class="grid grid-3">
      ${sel('status', 'Status', PROSPECT_STATUSES.map((s) => [s, STATUS_LABEL[s]]), f.status)}
      ${sel('ansvarlig', 'Ansvarlig', [['ingen', 'Ingen ansvarlig'], ...args.staff.map((s): [string, string] => [s, staffName(s)])], f.owner)}
      ${sel('prioritet', 'Prioritet', PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]]), f.priority)}
      ${sel('branche', 'Branche', args.industries.map((x) => [x, x]), f.industry)}
      ${sel('omraade', 'Område eller by', args.areas.map((x) => [x, x]), f.area)}
    </div>
    <div class="row"><button class="btn btn-primary btn-small" type="submit">Søg</button><a class="small" href="/admin/kundeemner${f.view !== 'aktive' ? `?visning=${f.view}` : ''}">Nulstil</a>
      <a class="small" href="/admin/kundeemner/eksport.csv${args.query ? `?${args.query}` : ''}">Download listen (CSV)</a></div>
  </form>
  <section class="card">
    <p class="small muted" style="margin-top:0">${args.total} ${args.total === 1 ? 'kundeemne' : 'kundeemner'}${pages > 1 ? ` · side ${f.page} af ${pages}` : ''}</p>
    ${args.rows.length === 0
      ? html`<p class="empty">Ingen kundeemner her.</p>`
      : html`<div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Virksomhed</th><th scope="col">Prioritet</th><th scope="col">Status</th><th scope="col">Ansvarlig</th><th scope="col">Seneste kontakt</th><th scope="col">Næste handling</th></tr></thead>
      <tbody>${args.rows.map(
        (p) => html`<tr>
          <td data-label="Virksomhed"><div class="cell"><a href="/admin/kundeemner/${p.id}"><strong>${p.company}</strong></a>${p.city ? html`<br><span class="small">${p.city}</span>` : ''}
            ${p.blacklisted ? html` <span class="badge b-err">Blacklistet</span>` : ''}${p.archived_at ? html` <span class="badge b-neutral">Arkiveret</span>` : ''}</div></td>
          <td data-label="Prioritet"><div class="cell">${PRIORITY_LABEL[p.priority]}</div></td>
          <td data-label="Status"><div class="cell">${statusBadge(p.status)}${p.suggested_status ? html`<br><span class="small">Forslag: ${STATUS_LABEL[p.suggested_status as ProspectStatus] ?? p.suggested_status}</span>` : ''}</div></td>
          <td data-label="Ansvarlig"><div class="cell">${p.owner ? staffName(p.owner) : html`<span class="muted">Mangler</span>`}</div></td>
          <td data-label="Seneste kontakt"><div class="cell">${p.last_contact_at ? formatDate(p.last_contact_at) : '–'}</div></td>
          <td data-label="Næste handling"><div class="cell">${followCell(p, args.today)}</div></td>
        </tr>`,
      )}</tbody></table></div>`}
    ${pages > 1
      ? html`<nav class="row between" aria-label="Sider" style="margin-top:16px">
          ${f.page > 1 ? html`<a class="btn btn-secondary btn-small" href="${qs({ side: String(f.page - 1) })}">← Forrige</a>` : html`<span></span>`}
          ${f.page < pages ? html`<a class="btn btn-secondary btn-small" href="${qs({ side: String(f.page + 1) })}">Næste →</a>` : ''}
        </nav>`
      : ''}
  </section>
</div>`;
}

// ---------- Formular ----------

function field(f: ProspectForm, err: string | null, k: keyof ProspectForm, label: string, opts: { type?: string; max?: number; placeholder?: string; hint?: string; required?: boolean; unverified?: boolean } = {}): H {
  const invalid = err === k ? html` aria-invalid="true"` : '';
  return html`<div class="field"><label for="pf-${k}">${label}${opts.unverified ? html` <span class="badge b-warn">Ubekræftet</span>` : ''}</label>
    <input id="pf-${k}" name="${k}" type="${opts.type ?? 'text'}" value="${f[k]}" maxlength="${opts.max ?? 200}"${opts.placeholder ? html` placeholder="${opts.placeholder}"` : ''}${opts.required ? ' required' : ''}${invalid}>
    ${opts.hint ? html`<p class="hint">${opts.hint}</p>` : ''}</div>`;
}

function area(f: ProspectForm, err: string | null, k: keyof ProspectForm, label: string, opts: { max?: number; hint?: string; rows?: number; unverified?: boolean } = {}): H {
  return html`<div class="field"><label for="pf-${k}">${label}${opts.unverified ? html` <span class="badge b-warn">Ubekræftet</span>` : ''}</label>
    <textarea id="pf-${k}" name="${k}" maxlength="${opts.max ?? 4000}" style="min-height:${(opts.rows ?? 4) * 26}px"${err === k ? html` aria-invalid="true"` : ''}>${f[k]}</textarea>
    ${opts.hint ? html`<p class="hint">${opts.hint}</p>` : ''}</div>`;
}

export function prospectFields(f: ProspectForm, err: string | null, staff: string[], opts: { edit?: boolean; unverified?: Set<string> } = {}): H {
  const u = opts.unverified ?? new Set<string>();
  return html`
    ${field(f, err, 'company', 'Virksomhedsnavn', { required: true, unverified: u.has('company') })}
    <div class="grid grid-3">
      ${field(f, err, 'cvr', 'CVR (hvis kendt)', { max: 12, placeholder: '12345678', unverified: u.has('cvr') })}
      ${field(f, err, 'industry', 'Branche', { max: 100, placeholder: 'Fx Fødevarer', unverified: u.has('industry') })}
      ${field(f, err, 'website', 'Hjemmeside', { max: 300, placeholder: 'firma.dk', unverified: u.has('website') })}
      ${field(f, err, 'city', 'By', { max: 100, placeholder: 'Slagelse', unverified: u.has('city') })}
      ${field(f, err, 'address', 'Adresse', { max: 200, unverified: u.has('address') })}
      ${field(f, err, 'area', 'Område', { max: 100, placeholder: 'Fx Sjælland', unverified: u.has('area') })}
    </div>
    <div class="grid grid-3">
      ${field(f, err, 'contact_name', 'Kontaktperson', { max: 150, unverified: u.has('contact_name') })}
      ${area(f, err, 'emails', 'Mailadresser', { max: 2000, rows: 2, hint: 'Én pr. linje.', unverified: u.has('emails') })}
      ${area(f, err, 'phones', 'Telefonnumre', { max: 400, rows: 2, hint: 'Én pr. linje.', unverified: u.has('phones') })}
    </div>
    <div class="grid grid-3">
      ${field(f, err, 'source', 'Kilde', { max: 100, placeholder: 'Fx Festival, Google, Anbefaling' })}
      ${field(f, err, 'source_url', 'Kildelink', { max: 500, placeholder: 'https://...' })}
      ${field(f, err, 'found_on', 'Funddato', { type: 'date' })}
    </div>
    ${area(f, err, 'needs', 'Konkrete forbedringsmuligheder og behov', { hint: 'Skriv kun det, I selv har set eller fået bekræftet.', unverified: u.has('needs') })}
    ${field(f, err, 'services', 'Relevante Veyro-ydelser', { max: 500, placeholder: 'Fx Ny hjemmeside, Booking, Drift' })}
    <div class="grid grid-3">
      <div class="field"><label for="pf-priority">Prioritet</label><select id="pf-priority" name="priority">${PRIORITIES.map((p) => html`<option value="${p}"${f.priority === p ? html` selected` : ''}>${PRIORITY_LABEL[p]}</option>`)}</select></div>
      ${opts.edit
        ? ''
        : html`<div class="field"><label for="pf-owner">Ansvarlig</label><select id="pf-owner" name="owner"><option value="">Ingen endnu</option>${staff.map((s) => html`<option value="${s}"${f.owner === s ? html` selected` : ''}>${staffName(s)}</option>`)}</select></div>
          <div class="field"><label for="pf-status">Status</label><select id="pf-status" name="status">${PROSPECT_STATUSES.filter((s) => s !== 'kunde').map((s) => html`<option value="${s}"${f.status === s ? html` selected` : ''}>${STATUS_LABEL[s]}</option>`)}</select></div>`}
    </div>
    <div class="grid grid-2">
      ${field(f, err, 'next_action', 'Næste handling', { max: 300, placeholder: 'Fx Ring til ejeren' })}
      ${field(f, err, 'follow_up_on', 'Opfølgningsdato', { type: 'date' })}
    </div>
    ${area(f, err, 'notes', 'Noter', { max: 8000 })}`;
}

function dupList(dups: DuplicateHit[]): H {
  return html`<ul class="list">${dups.map(
    (d) => html`<li><a href="${d.kind === 'prospect' ? `/admin/kundeemner/${d.id}` : `/admin/kunder/${d.id}`}"><strong>${d.name}</strong></a> · ${d.kind === 'prospect' ? 'Kundeemne' : 'Kunde'}${d.status ? html` · ${STATUS_LABEL[d.status as ProspectStatus] ?? d.status}` : ''}
      <div class="meta">${d.signals.join(' · ')}</div></li>`,
  )}</ul>`;
}

export function newProspectPage(args: {
  csrf: string;
  form: ProspectForm;
  staff: string[];
  error: string | null;
  errorField: string | null;
  duplicates: DuplicateHit[];
  blocks: BlockRow[];
  extraHidden?: H;
  title?: string;
  intro?: H | string;
  unverified?: Set<string>;
}): H {
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], [args.title ?? 'Nyt', null])}<h1>${args.title ?? 'Nyt kundeemne'}</h1>
    <p class="lead">${args.intro ?? 'Kun virksomhedsnavnet er nødvendigt. Resten kan udfyldes senere.'}</p></div>
  ${args.error ? alert('err', args.error) : ''}
  ${args.blocks.length
    ? alert('err', html`<strong>Blokeret.</strong> Virksomheden rammer en aktiv blokering og kan ikke oprettes som aktivt kundeemne:
        <ul>${args.blocks.map((b) => html`<li>${BLOCK_SCOPE_LABEL[b.scope]}: ${b.value.replace(/^(cvr|navn):/, '')} · ${b.reason} (${formatDate(b.created_at)}, ${staffName(b.created_by)})</li>`)}</ul>
        Se <a href="/admin/kundeemner/blokeringer">Blokeringer</a>.`)
    : ''}
  ${args.duplicates.length
    ? html`<section class="card stack" style="border-color:var(--warn)"><h2 class="h-small" style="margin:0">Mulige dubletter</h2>
        <p class="small" style="margin:0">Tjek listen. Intet lægges sammen automatisk. Er det samme virksomhed, så åbn den eksisterende i stedet, eller opret og læg sammen bagefter.</p>
        ${dupList(args.duplicates)}</section>`
    : ''}
  <form method="post" action="/admin/kundeemner" class="card stack">
    ${csrfField(args.csrf)}
    ${args.extraHidden ?? ''}
    ${prospectFields(args.form, args.errorField, args.staff, { unverified: args.unverified })}
    ${args.duplicates.length ? html`<label class="row confirm-check"><input type="checkbox" name="confirm_duplicates" value="1" required> Jeg har tjekket de mulige dubletter. Opret alligevel.</label>` : ''}
    <div class="row"><button class="btn btn-primary" type="submit"${args.blocks.length ? html` disabled` : ''}>Opret kundeemne</button><a href="/admin/kundeemner" class="small">Annullér</a></div>
  </form>
</div>`;
}

// ---------- Detaljeside ----------

const EVENT_LABEL: Record<string, string> = {
  contact: 'Kontakt',
  note: 'Note',
  status: 'Status',
  owner: 'Ansvarlig',
  blacklist: 'Blacklistet',
  unblacklist: 'Blokering ophævet',
  archive: 'Arkiveret',
  restore: 'Gendannet',
  merge: 'Sammenlægning',
  created: 'Oprettet',
  followup: 'Opfølgning',
  offer: 'Tilbud',
  customer: 'Kunde',
  lead: 'Forespørgsel',
  mail: 'Mail',
  edit: 'Ændret',
  auto: 'Automatik',
};

function eventLine(e: EventRow): H {
  let what: H | string = '';
  if (e.kind === 'status') what = html`${e.old_value ? `${STATUS_LABEL[e.old_value as ProspectStatus] ?? e.old_value} → ` : ''}<strong>${STATUS_LABEL[e.new_value as ProspectStatus] ?? e.new_value}</strong>`;
  else if (e.kind === 'owner') what = html`${e.old_value ? `${staffName(e.old_value)} → ` : ''}<strong>${e.new_value ? staffName(e.new_value) : 'Ingen'}</strong>`;
  else if (e.kind === 'contact') what = html`<strong>${CHANNEL_LABEL[e.channel as keyof typeof CHANNEL_LABEL] ?? e.channel}</strong>${e.contact_person ? ` med ${e.contact_person}` : ''}`;
  else if (e.kind === 'blacklist') what = html`<strong>${e.new_value}</strong>`;
  else if (e.kind === 'unblacklist') what = html`<strong>${e.old_value}</strong>`;
  else if (e.kind === 'created') what = html`Status <strong>${STATUS_LABEL[e.new_value as ProspectStatus] ?? e.new_value}</strong>`;
  return html`<li id="e-${e.id}">
    <div class="item-head"><span><span class="badge ${e.kind === 'blacklist' ? 'b-err' : e.kind === 'contact' || e.kind === 'mail' ? 'b-accent' : 'b-neutral'}">${EVENT_LABEL[e.kind] ?? e.kind}</span> ${what}</span>
      <span class="meta">${formatDateTime(e.at)}${e.actor ? ` · ${e.actor === 'system' ? 'Automatik' : staffName(e.actor)}` : ''}</span></div>
    ${e.body ? html`<p class="prewrap small" style="margin:6px 0 0">${e.body}</p>` : ''}
  </li>`;
}

export interface DetailArgs {
  csrf: string;
  p: ProspectRow;
  contacts: ContactRow[];
  events: EventRow[];
  links: { id: number; url: string; label: string | null; created_at: number; created_by: string | null }[];
  files: { id: number; name: string; type: string; size: number; created_at: number }[];
  blocks: BlockRow[];
  offers: { id: number; service: string; status: string; created_at: number }[];
  customer: { id: number; label: string } | null;
  lead: { id: number; label: string } | null;
  leadSuggestions: { id: number; email: string; name: string | null; company: string | null; created_at: number; why: string }[];
  duplicates: DuplicateHit[];
  customers: { id: number; label: string }[];
  staff: string[];
  me: string;
  today: string;
  suggestedFollowUp: string;
  flash: string | null;
  error: string | null;
  costs: H;
  mail: H | string;
  assessment: H | string;
  editForm: ProspectForm;
  editError: string | null;
}

export function prospectDetailPage(a: DetailArgs): H {
  const p = a.p;
  const active = isSalesActive(p);
  const unv = new Set(JSON.parse(p.unverified || '[]') as string[]);
  const ver = html`<input type="hidden" name="version" value="${p.version}">`;
  const post = (path: string) => `/admin/kundeemner/${p.id}/${path}`;
  const activeBlocks = a.blocks.filter((b) => !b.lifted_at);
  const flag = (k: string) => (unv.has(k) ? html` <span class="badge b-warn" title="Hentet maskinelt; ikke bekræftet">Ubekræftet</span>` : '');
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], [p.company, null])}
    <h1>${p.company}</h1>
    <div class="row">${statusBadge(p.status)} <span class="badge b-neutral">Prioritet: ${PRIORITY_LABEL[p.priority]}</span>
      ${p.blacklisted ? html`<span class="badge b-err">Blacklistet</span>` : ''}${p.archived_at ? html`<span class="badge b-neutral">Arkiveret ${formatDate(p.archived_at)}</span>` : ''}
      ${p.merged_into ? html`<span class="badge b-neutral">Lagt sammen med <a href="/admin/kundeemner/${p.merged_into}">#${p.merged_into}</a></span>` : ''}</div></div>
  ${a.flash && PROSPECT_FLASH[a.flash] ? alert('ok', PROSPECT_FLASH[a.flash]!) : ''}
  ${a.error ? alert('err', a.error) : ''}
  ${activeBlocks.length
    ? alert('err', html`<strong>Blacklistet.</strong> Salgsopfølgning og nye salgsudkast er stoppet. ${activeBlocks.map((b) => html`<br>${BLOCK_SCOPE_LABEL[b.scope]}: ${b.value.replace(/^(cvr|navn):/, '')} · ${b.reason} · ${formatDate(b.created_at)} af ${staffName(b.created_by)}`)}`)
    : ''}
  ${p.suggested_status && p.suggested_status !== p.status && active
    ? html`<div class="alert alert-info row between" role="status"><span>Forslag fra mail: sæt status til <strong>${STATUS_LABEL[p.suggested_status as ProspectStatus] ?? p.suggested_status}</strong>. Der er kommet et svar.</span>
        <span class="row" style="gap:8px"><form method="post" action="${post('status')}" class="inline">${csrfField(a.csrf)}${ver}<input type="hidden" name="status" value="${p.suggested_status}"><button class="btn btn-primary btn-small" type="submit">Brug forslaget</button></form>
        <form method="post" action="${post('afvis-forslag')}" class="inline">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small" type="submit">Afvis</button></form></span></div>`
    : ''}
  ${p.suggested_owner && !p.owner
    ? html`<div class="alert alert-info row between" role="status"><span>Forslag: <strong>${staffName(p.suggested_owner)}</strong> som ansvarlig (personlig afsender på mail til emnet).</span>
        <form method="post" action="${post('ansvarlig')}" class="inline">${csrfField(a.csrf)}${ver}<input type="hidden" name="owner" value="${p.suggested_owner}"><button class="btn btn-primary btn-small" type="submit">Brug forslaget</button></form></div>`
    : ''}

  <div class="row">
    ${p.blacklisted ? '' : html`<a class="btn btn-accent" href="#registrer-kontakt">Registrér kontakt</a>`}
    <a class="btn btn-secondary" href="/admin/tilbud?kundeemne=${p.id}">Opret tilbud</a>
    ${p.blacklisted ? '' : html`<a class="btn btn-secondary" href="${post('udkast')}">Mailudkast</a>`}
    <a class="btn btn-secondary" href="#omkostninger">Tid og omkostninger</a>
  </div>

  <div class="grid grid-2">
    <section class="card stack">
      <h2 class="h-small" style="margin:0">Status og næste handling</h2>
      <form method="post" action="${post('status')}" class="row">${csrfField(a.csrf)}${ver}
        <label class="visually-hidden" for="d-status">Status</label>
        <select id="d-status" name="status" style="width:auto;min-width:180px">${PROSPECT_STATUSES.filter((s) => s !== 'kunde' || p.customer_id).map((s) => html`<option value="${s}"${s === p.status ? html` selected` : ''}>${STATUS_LABEL[s]}</option>`)}</select>
        <button class="btn btn-secondary btn-small" type="submit">Skift status</button></form>
      ${p.customer_id ? '' : html`<p class="hint" style="margin:0">"Blev kunde" kræver en kundetilknytning (se Kunde og tilbud).</p>`}
      <form method="post" action="${post('ansvarlig')}" class="row">${csrfField(a.csrf)}${ver}
        <label class="visually-hidden" for="d-owner">Ansvarlig</label>
        <select id="d-owner" name="owner" style="width:auto;min-width:180px"><option value="">Ingen ansvarlig</option>${a.staff.map((s) => html`<option value="${s}"${s === p.owner ? html` selected` : ''}>${staffName(s)}</option>`)}</select>
        <button class="btn btn-secondary btn-small" type="submit">Skift ansvarlig</button></form>
      <dl class="facts">
        <div><dt>Næste handling</dt><dd>${p.next_action ?? '–'}</dd></div>
        <div><dt>Opfølgning</dt><dd>${active ? dk(p.follow_up_on) : 'Stoppet'}${p.follow_up_review ? html` <span class="badge b-warn">Svar modtaget, gennemgå</span>` : ''}</dd></div>
        <div><dt>Seneste kontakt</dt><dd>${p.last_contact_at ? formatDateTime(p.last_contact_at) : '–'}</dd></div>
        <div><dt>Status sat</dt><dd>${p.status_set_at ? `${formatDateTime(p.status_set_at)}${p.status_set_by ? ` af ${p.status_set_by === 'system' ? 'automatik' : staffName(p.status_set_by)}` : ''}` : '–'}</dd></div>
      </dl>
      ${active
        ? html`<details><summary>Ændr opfølgning</summary>
            <form method="post" action="${post('opfoelgning')}" class="stack" style="margin-top:8px">${csrfField(a.csrf)}
              <div class="grid grid-2">
                <div class="field"><label for="fu-date">Dato</label><input id="fu-date" name="follow_up_on" type="date" value="${p.follow_up_on ?? a.suggestedFollowUp}"></div>
                <div class="field"><label for="fu-next">Næste handling</label><input id="fu-next" name="next_action" type="text" maxlength="300" value="${p.next_action ?? ''}"></div>
              </div>
              <div class="row"><button class="btn btn-primary btn-small" type="submit" name="op" value="gem">Gem opfølgning</button><button class="btn btn-secondary btn-small" type="submit" name="op" value="fravaelg">Ingen opfølgning</button></div>
            </form></details>`
        : ''}
    </section>
    <section class="card stack">
      <h2 class="h-small" style="margin:0">Virksomhed og vurdering</h2>
      ${unv.size ? html`<p class="small" style="margin:0"><span class="badge b-warn">Ubekræftet</span> = hentet maskinelt${p.fetched_from ? html` fra ${p.fetched_from}` : ''}${p.fetched_at ? ` ${formatDateTime(p.fetched_at)}` : ''}. Ret eller gem feltet for at bekræfte det.</p>` : ''}
      <dl class="facts">
        <div><dt>CVR</dt><dd>${p.cvr ?? '–'}${flag('cvr')}</dd></div>
        <div><dt>Branche</dt><dd>${p.industry ?? '–'}${flag('industry')}</dd></div>
        <div><dt>By og adresse</dt><dd>${[p.address, p.city].filter(Boolean).join(', ') || '–'}${flag('city')}${flag('address')}</dd></div>
        <div><dt>Område</dt><dd>${p.area ?? '–'}</dd></div>
        <div><dt>Hjemmeside</dt><dd>${p.website ? html`<a href="${p.website}" target="_blank" rel="noopener noreferrer nofollow">${p.website.replace(/^https?:\/\//, '')}</a>` : '–'}${flag('website')}</dd></div>
        <div><dt>Kontaktperson</dt><dd>${p.contact_name ?? '–'}${flag('contact_name')}</dd></div>
        <div><dt>Mail</dt><dd>${a.contacts.filter((c) => c.kind === 'email').map((c) => html`<a href="mailto:${c.value}">${c.value}</a>${c.unverified ? html` <span class="badge b-warn">Ubekræftet</span>` : ''}${c.bounced_at ? html` <span class="badge b-err">Leveringsfejl</span>` : ''}<br>`) || '–'}</dd></div>
        <div><dt>Telefon</dt><dd>${a.contacts.filter((c) => c.kind === 'phone').map((c) => html`<a href="tel:${c.value.replace(/\s+/g, '')}">${c.value}</a>${c.unverified ? html` <span class="badge b-warn">Ubekræftet</span>` : ''}<br>`) || '–'}</dd></div>
        <div><dt>Kilde</dt><dd>${p.source ?? '–'}${p.source_url ? html` · <a href="${p.source_url}" target="_blank" rel="noopener noreferrer nofollow">link</a>` : ''}</dd></div>
        <div><dt>Fundet</dt><dd>${dk(p.found_on)}</dd></div>
        <div><dt>Ansvarlig</dt><dd>${p.owner ? staffName(p.owner) : 'Mangler'}</dd></div>
        <div><dt>Oprettet / ændret</dt><dd class="small">${formatDateTime(p.created_at)}${p.created_by ? ` af ${staffName(p.created_by)}` : ''}<br>${formatDateTime(p.updated_at)}${p.updated_by ? ` af ${staffName(p.updated_by)}` : ''}</dd></div>
      </dl>
      ${p.needs ? html`<div><h3 class="h-small">Forbedringsmuligheder og behov${flag('needs')}</h3><p class="prewrap">${p.needs}</p></div>` : ''}
      ${p.services ? html`<p><strong>Relevante ydelser:</strong> ${p.services}</p>` : ''}
    </section>
  </div>

  ${a.assessment}

  ${a.duplicates.length && !p.merged_into
    ? html`<section class="card stack" style="border-color:var(--warn)"><h2 class="h-small" style="margin:0">Mulige dubletter</h2>
        <p class="small" style="margin:0">Signalerne er CVR, domæne og mailadresser. Et lignende navn eller fælles domæne er ikke nok til at lægge sammen; kontrollér selv.</p>
        <ul class="list">${a.duplicates.map(
          (d) => html`<li><div class="item-head"><span><a href="${d.kind === 'prospect' ? `/admin/kundeemner/${d.id}` : `/admin/kunder/${d.id}`}"><strong>${d.name}</strong></a> · ${d.kind === 'prospect' ? 'Kundeemne' : 'Kunde'}</span>
            ${d.kind === 'prospect'
              ? html`<form method="post" action="${post('flet')}" class="inline" data-confirm="Læg ${d.name} sammen med dette kundeemne? Historik, kontakter, tid og udgifter flyttes hertil. Det andet emne skjules, men slettes ikke.">${csrfField(a.csrf)}<input type="hidden" name="other" value="${d.id}"><button class="btn btn-secondary btn-small" type="submit">Læg sammen hertil</button></form>`
              : p.customer_id ? '' : html`<form method="post" action="${post('kunde')}" class="inline">${csrfField(a.csrf)}<input type="hidden" name="customer" value="${d.id}"><button class="btn btn-secondary btn-small" type="submit" data-confirm-btn="Knyt kundeemnet til denne kunde og sæt status til Blev kunde?">Knyt til kunden</button></form>`}</div>
            <div class="meta">${d.signals.join(' · ')}</div></li>`,
        )}</ul></section>`
    : ''}

  <section class="card stack" id="registrer-kontakt">
    <h2 style="margin:0">Registrér kontakt</h2>
    ${p.blacklisted ? alert('warn', html`<strong>Advarsel:</strong> Kundeemnet er blacklistet. Registrér kun kontakt, hvis virksomheden selv har henvendt sig. Status kan ikke gøres aktiv igen, før blokeringen er ophævet.`) : ''}
    <form method="post" action="${post('kontakt')}" class="stack">${csrfField(a.csrf)}
      <div class="grid grid-3">
        <div class="field"><label for="k-channel">Kontaktform</label><select id="k-channel" name="channel">${CHANNELS.map((c) => html`<option value="${c}"${c === 'telefon' ? html` selected` : ''}>${CHANNEL_LABEL[c]}</option>`)}</select></div>
        <div class="field"><label for="k-at">Dato og tidspunkt</label><input id="k-at" name="at" type="datetime-local" required value="${a.today}T${new Intl.DateTimeFormat('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' }).format(new Date()).replace('.', ':')}"></div>
        <div class="field"><label for="k-staff">Veyro-medarbejder</label><select id="k-staff" name="staff">${a.staff.map((s) => html`<option value="${s}"${s === a.me ? html` selected` : ''}>${staffName(s)}</option>`)}</select></div>
      </div>
      <div class="field"><label for="k-person">Kontaktperson hos virksomheden (hvis kendt)</label><input id="k-person" name="contact_person" type="text" maxlength="150" value="${p.contact_name && !unv.has('contact_name') ? p.contact_name : ''}"></div>
      <div class="field"><label for="k-body">Notat og aftaler</label><textarea id="k-body" name="body" maxlength="4000" style="min-height:100px"></textarea></div>
      <div class="grid grid-3">
        <div class="field"><label for="k-status">Ny status</label><select id="k-status" name="status"><option value="">Uændret (${STATUS_LABEL[p.status]})</option>${PROSPECT_STATUSES.filter((s) => s !== p.status && (s !== 'kunde' || p.customer_id)).map((s) => html`<option value="${s}"${s === 'afventer' && (p.status === 'undersoeges' || p.status === 'klar') ? html` selected` : ''}>${STATUS_LABEL[s]}</option>`)}</select></div>
        <div class="field"><label for="k-next">Næste handling</label><input id="k-next" name="next_action" type="text" maxlength="300" value="Følg op"></div>
        <div class="field"><label for="k-follow">Opfølgningsdato</label><input id="k-follow" name="follow_up_on" type="date" value="${a.suggestedFollowUp}"><p class="hint">Forslag: om fem arbejdsdage. Tøm feltet for ingen opfølgning.</p></div>
      </div>
      <label class="row" style="gap:8px;font-weight:500"><input type="checkbox" name="keep_follow_up" value="1" style="width:20px;height:20px"> Behold den nuværende opfølgning${p.follow_up_on ? ` (${dk(p.follow_up_on)})` : ''}</label>
      <div class="row"><button class="btn btn-primary" type="submit">Gem kontakt</button></div>
    </form>
  </section>

  ${a.mail}

  <section class="card stack">
    <h2 style="margin:0">Tidslinje</h2>
    <form method="post" action="${post('note')}" class="stack">${csrfField(a.csrf)}
      <div class="field"><label for="n-body">Intern note</label><textarea id="n-body" name="body" maxlength="4000" required style="min-height:80px"></textarea></div>
      <div class="row"><button class="btn btn-secondary btn-small" type="submit">Gem note</button></div>
    </form>
    ${a.events.length ? html`<ul class="list">${a.events.map(eventLine)}</ul>` : html`<p class="empty">Ingen historik endnu.</p>`}
  </section>

  <div class="grid grid-2">
    <section class="card stack">
      <h2 class="h-small" style="margin:0">Kunde og tilbud</h2>
      ${a.customer
        ? html`<p>Knyttet til kunden <a href="/admin/kunder/${a.customer.id}"><strong>${a.customer.label}</strong></a>. Tid, udgifter og historik vises også på kundekortet.</p>
          <form method="post" action="${post('kunde/fjern')}" class="inline" data-confirm="Fjern tilknytningen til kunden? Status sættes til I dialog.">${csrfField(a.csrf)}<button class="linkbtn small" type="submit">Fjern kundetilknytning</button></form>`
        : html`<form method="post" action="${post('kunde')}" class="stack">${csrfField(a.csrf)}
            <div class="field"><label for="c-cust">Knyt til eksisterende kunde</label><select id="c-cust" name="customer" required><option value="">Vælg kunde</option>${a.customers.map((c) => html`<option value="${c.id}">${c.label}</option>`)}</select></div>
            <div class="row"><button class="btn btn-secondary btn-small" type="submit">Knyt til kunden og sæt "Blev kunde"</button></div>
          </form>
          <details><summary>Opret nyt kundekort</summary>
            <form method="post" action="${post('kunde/ny')}" class="stack" style="margin-top:8px">${csrfField(a.csrf)}
              <div class="field"><label for="c-email">Kundens mailadresse (login til kundepanelet)</label><input id="c-email" name="email" type="email" required value="${a.contacts.find((c) => c.kind === 'email' && !c.unverified)?.value ?? ''}"></div>
              <div class="field"><label for="c-name">Kontaktperson</label><input id="c-name" name="name" type="text" maxlength="200" value="${p.contact_name ?? ''}"></div>
              <p class="hint">Opretter kun kundekortet med virksomhedens oplysninger. Der sendes ingen invitation eller mail, og der oprettes intet abonnement eller betaling. Skal kunden betale via link, så brug "Opret tilbud" i stedet; kunden oprettes så, når tilbuddet er betalt.</p>
              <div class="row"><button class="btn btn-secondary btn-small" type="submit">Opret kundekort</button></div>
            </form></details>`}
      <h3 class="h-small">Tilbud</h3>
      ${a.offers.length ? html`<ul style="margin:0;padding-left:18px">${a.offers.map((o) => html`<li><a href="/admin/tilbud/${o.id}">${o.service}</a> · ${formatDate(o.created_at)} · ${o.status}</li>`)}</ul>` : html`<p class="small muted">Ingen tilbud endnu. <a href="/admin/tilbud?kundeemne=${p.id}">Opret tilbud</a> genbruger kundeemnets oplysninger.</p>`}
      <h3 class="h-small">Forespørgsel fra hjemmesiden</h3>
      ${a.lead ? html`<p class="small"><a href="/admin/forespoergsler/${a.lead.id}">${a.lead.label}</a></p>` : html`<p class="small muted">Ingen tilknyttet.</p>`}
      ${a.leadSuggestions.length
        ? html`<div class="alert alert-info small">Mulige forespørgsler fra samme virksomhed:<ul class="list" style="margin-top:8px">${a.leadSuggestions.map(
            (l) => html`<li><a href="/admin/forespoergsler/${l.id}">#${l.id} ${l.company ?? l.name ?? l.email}</a> · ${formatDate(l.created_at)} · ${l.why}
              <form method="post" action="${post('forespoergsel')}" class="inline">${csrfField(a.csrf)}<input type="hidden" name="lead" value="${l.id}"><button class="linkbtn small" type="submit">Knyt til</button></form></li>`,
          )}</ul></div>`
        : ''}
    </section>
    <section class="card stack">
      <h2 class="h-small" style="margin:0">Dokumentation</h2>
      ${a.links.length ? html`<ul class="list">${a.links.map((l) => html`<li class="row between"><a href="${l.url}" target="_blank" rel="noopener noreferrer nofollow">${l.label || l.url}</a>
        <form method="post" action="${post(`links/${l.id}/slet`)}" class="inline">${csrfField(a.csrf)}<button class="linkbtn small" type="submit">Fjern</button></form></li>`)}</ul>` : ''}
      <form method="post" action="${post('links')}" class="row">${csrfField(a.csrf)}
        <label class="visually-hidden" for="l-url">Link</label><input id="l-url" name="url" type="url" required placeholder="https://..." style="flex:2;min-width:200px">
        <label class="visually-hidden" for="l-label">Beskrivelse</label><input id="l-label" name="label" type="text" maxlength="150" placeholder="Beskrivelse" style="flex:1;min-width:140px">
        <button class="btn btn-secondary btn-small" type="submit">Tilføj link</button></form>
      ${a.files.length ? html`<ul class="list">${a.files.map((f) => html`<li class="row between"><a href="${post(`filer/${f.id}`)}" target="_blank" rel="noopener">${f.name}</a> <span class="small muted">${Math.ceil(f.size / 1024)} kB</span>
        <form method="post" action="${post(`filer/${f.id}/slet`)}" class="inline" data-confirm="Slet filen?">${csrfField(a.csrf)}<button class="linkbtn small" type="submit">Slet</button></form></li>`)}</ul>` : ''}
      <form method="post" action="${post('filer')}" class="row" enctype="multipart/form-data">${csrfField(a.csrf)}
        <label class="visually-hidden" for="f-file">Skærmbillede eller PDF</label><input id="f-file" name="file" type="file" required accept="image/png,image/jpeg,image/webp,image/gif,application/pdf">
        <button class="btn btn-secondary btn-small" type="submit">Upload</button></form>
      <p class="hint" style="margin:0">Skærmbilleder (PNG, JPG, WebP, GIF) og PDF, højst 2 MB. Filerne vises kun for Veyro-administratorer.</p>
    </section>
  </div>

  ${a.costs}

  <details class="card" id="rediger"${a.editError ? html` open` : ''}><summary>Redigér oplysninger</summary>
    ${a.editError ? alert('err', a.editError) : ''}
    <form method="post" action="${post('rediger')}" class="stack" style="margin-top:16px">${csrfField(a.csrf)}${ver}
      ${prospectFields(a.editForm, null, a.staff, { edit: true, unverified: unv })}
      <div class="row"><button class="btn btn-primary" type="submit">Gem ændringer</button></div>
    </form>
  </details>

  <section class="card stack">
    <h2 class="h-small" style="margin:0">Blacklisting</h2>
    <p class="small" style="margin:0">Blacklisting er noget andet end afslag: den stopper al salgsopfølgning og nye salgsudkast og forhindrer, at virksomheden oprettes eller importeres som aktivt kundeemne igen. Den gælder kun i Veyros system og kan ikke forhindre, at nogen selv sender mails fra Gmail.</p>
    ${a.blocks.length ? html`<ul class="list">${a.blocks.map(
      (b) => html`<li><div class="item-head"><span><strong>${BLOCK_SCOPE_LABEL[b.scope]}:</strong> ${b.value.replace(/^(cvr|navn):/, '')} ${b.lifted_at ? html`<span class="badge b-neutral">Ophævet</span>` : html`<span class="badge b-err">Aktiv</span>`}</span>
        <span class="meta">${formatDateTime(b.created_at)} af ${staffName(b.created_by)}</span></div>
        <p class="small" style="margin:4px 0 0">Årsag: ${b.reason}</p>
        ${b.lifted_at ? html`<p class="small muted" style="margin:4px 0 0">Ophævet ${formatDateTime(b.lifted_at)} af ${staffName(b.lifted_by)}: ${b.lift_reason}</p>` : html`<details><summary>Ophæv blokering</summary>
          <form method="post" action="${post(`blokering/${b.id}/ophaev`)}" class="stack" style="margin-top:8px">${csrfField(a.csrf)}
            <div class="field"><label for="lift-${b.id}">Hvorfor ophæves den?</label><input id="lift-${b.id}" name="reason" type="text" required maxlength="500"></div>
            <div class="row"><button class="btn btn-secondary btn-small" type="submit">Ophæv</button></div></form></details>`}</li>`,
    )}</ul>` : ''}
    <details><summary>Blacklist</summary>
      <form method="post" action="${post('blokering')}" class="stack" style="margin-top:8px">${csrfField(a.csrf)}
        <div class="grid grid-2">
          <div class="field"><label for="b-scope">Omfang</label><select id="b-scope" name="scope">${BLOCK_SCOPES.map((s) => html`<option value="${s}"${s === 'company' ? html` selected` : ''}>${BLOCK_SCOPE_LABEL[s]}</option>`)}</select></div>
          <div class="field"><label for="b-value">Mailadresse eller domæne</label><input id="b-value" name="value" type="text" maxlength="254" placeholder="${p.domain ?? 'firma.dk'}"><p class="hint">Bruges ikke ved "Virksomhed" (CVR eller navn bruges). Fælles udbydere som gmail.com kan ikke blokeres som domæne.</p></div>
        </div>
        <div class="field"><label for="b-reason">Årsag</label><input id="b-reason" name="reason" type="text" required maxlength="500" placeholder="Fx Har bedt om ikke at blive kontaktet"></div>
        <div class="row"><button class="btn btn-danger btn-small" type="submit" data-confirm-btn="Blackliste virksomheden? Salgsopfølgning stoppes.">Blacklist</button></div>
      </form></details>
  </section>

  <section class="card stack">
    <h2 class="h-small" style="margin:0">Arkivering og sletning</h2>
    ${p.archived_at
      ? html`<form method="post" action="${post('gendan')}" class="inline">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small" type="submit">Gendan fra arkivet</button></form>${p.blacklisted ? html`<p class="hint">Emnet er stadig blacklistet efter gendannelse.</p>` : ''}`
      : html`<form method="post" action="${post('arkiver')}" class="inline" data-confirm="Arkivér kundeemnet? Salgsopfølgning stoppes. Det kan gendannes.">${csrfField(a.csrf)}<button class="btn btn-secondary btn-small" type="submit">Arkivér</button></form>`}
    <details><summary>Slet kundeemnet</summary>
      <form method="post" action="${post('slet')}" class="stack" style="margin-top:8px">${csrfField(a.csrf)}
        <ul class="small" style="margin:0;padding-left:18px">
          <li>Kundeemnet, dets kontakter, noter, links, filer og tidslinje slettes permanent i Veyro.</li>
          <li>Kundekort, aftaler, tilbud og fakturaer slettes <strong>ikke</strong>.${p.customer_id ? ' Tid og udgifter flyttes til den tilknyttede kunde.' : ' Tid og udgifter bevares i statistikken under emnets navn.'}</li>
          <li>Originale mails i Gmail slettes ikke; kun Veyros tilknytning og kopi af samtalerne fjernes.</li>
          ${a.blocks.some((b) => !b.lifted_at) ? html`<li>Emnet er blacklistet. En minimal blokeringsregistrering (omfang, værdi, virksomhedsnavn, årsag, dato og hvem) bevares særskilt, så virksomheden ikke oprettes som aktivt emne igen.</li>` : ''}
        </ul>
        <div class="field"><label for="del-confirm">Skriv virksomhedens navn for at bekræfte</label><input id="del-confirm" name="confirm_name" type="text" required autocomplete="off"></div>
        <div class="row"><button class="btn btn-danger btn-small" type="submit">Slet permanent</button></div>
      </form></details>
  </section>
</div>`;
}

// ---------- Blokeringer ----------

export function blocksPage(args: { rows: (BlockRow & { prospect_company: string | null })[]; all: boolean }): H {
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], ['Blokeringer', null])}<h1>Blokeringer</h1>
    <p class="lead">Mailadresser, domæner og virksomheder, der ikke må kontaktes i salgsøjemed. Kontrolleres ved oprettelse, import og nye søgeresultater. Blokeringen gælder kun Veyros system.</p></div>
  <nav class="row tabs"><a class="btn btn-small ${args.all ? 'btn-secondary' : 'btn-primary'}" href="/admin/kundeemner/blokeringer">Aktive</a><a class="btn btn-small ${args.all ? 'btn-primary' : 'btn-secondary'}" href="/admin/kundeemner/blokeringer?alle=1">Alle, også ophævede</a></nav>
  <section class="card">${args.rows.length === 0 ? html`<p class="empty">Ingen blokeringer.</p>` : html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th scope="col">Omfang</th><th scope="col">Værdi</th><th scope="col">Virksomhed</th><th scope="col">Årsag</th><th scope="col">Registreret</th><th scope="col">Status</th></tr></thead>
    <tbody>${args.rows.map((b) => html`<tr>
      <td data-label="Omfang">${BLOCK_SCOPE_LABEL[b.scope]}</td>
      <td data-label="Værdi">${b.value.replace(/^(cvr|navn):/, b.value.startsWith('cvr:') ? 'CVR ' : '')}</td>
      <td data-label="Virksomhed">${b.prospect_id ? html`<a href="/admin/kundeemner/${b.prospect_id}">${b.prospect_company ?? b.company}</a>` : html`${b.company ?? '–'} <span class="small muted">(emnet er slettet)</span>`}</td>
      <td data-label="Årsag">${b.reason}</td>
      <td data-label="Registreret">${formatDate(b.created_at)}<br><span class="small">${staffName(b.created_by)}</span></td>
      <td data-label="Status">${b.lifted_at ? html`Ophævet ${formatDate(b.lifted_at)}<br><span class="small">${b.lift_reason}</span>` : html`<span class="badge b-err">Aktiv</span>`}</td>
    </tr>`)}</tbody></table></div>`}</section>
</div>`;
}

// ---------- Mailudkast ----------

export function draftPage(args: {
  p: ProspectRow;
  draft: { to: string | null; subject: string; body: string; sources: string[] };
  senders: { email: string; connected: boolean; compose: boolean }[];
  sender: string;
  kind: string;
  csrf: string;
  flash: string | null;
  error: string | null;
}): H {
  const d = args.draft;
  const canGmail = args.senders.find((s) => s.email === args.sender)?.compose;
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Kundeemner', '/admin/kundeemner'], [args.p.company, `/admin/kundeemner/${args.p.id}`], ['Mailudkast', null])}<h1>Mailudkast</h1>
    <p class="lead">Et personligt udkast ud fra de oplysninger, der er registreret og bekræftet på kundeemnet. Ret det, før det bruges. Der sendes aldrig noget automatisk.</p></div>
  ${args.flash === 'kladde' ? alert('ok', 'Kladden er oprettet i Gmail under Kladder. Den er ikke sendt.') : ''}
  ${args.error ? alert('err', args.error) : ''}
  <form method="get" action="/admin/kundeemner/${args.p.id}/udkast" class="card row">
    <div class="field"><label for="u-sender">Afsender</label><select id="u-sender" name="afsender">${args.senders.map((s) => html`<option value="${s.email}"${s.email === args.sender ? html` selected` : ''}>${s.email}${s.connected ? '' : ' (ikke forbundet)'}</option>`)}</select></div>
    <div class="field"><label for="u-kind">Type</label><select id="u-kind" name="type"><option value="foerste">Første henvendelse</option><option value="opfoelgning"${args.kind === 'opfoelgning' ? html` selected` : ''}>Opfølgning</option></select></div>
    <button class="btn btn-secondary btn-small" type="submit" style="align-self:flex-end">Lav nyt udkast</button>
  </form>
  <form method="post" action="/admin/kundeemner/${args.p.id}/udkast/gmail" class="card stack">${csrfField(args.csrf)}
    <input type="hidden" name="sender" value="${args.sender}">
    <div class="field"><label for="u-to">Til</label><input id="u-to" name="to" type="email" value="${d.to ?? ''}" placeholder="Ingen bekræftet mailadresse – skriv den selv"></div>
    <div class="field"><label for="u-subject">Emne</label><input id="u-subject" name="subject" type="text" maxlength="200" value="${d.subject}"></div>
    <div class="field"><label for="u-body">Tekst</label><textarea id="u-body" name="body" maxlength="10000" style="min-height:320px">${d.body}</textarea></div>
    <p class="hint">Bygget af: ${d.sources.length ? d.sources.join(', ') : 'kun standardtekst (ingen bekræftede observationer eller behov registreret)'}. Kontaktpersoner, fejl og resultater, der ikke er registreret, er ikke medtaget. Markér teksten og kopiér den, eller opret en kladde i Gmail.</p>
    <div class="row">
      ${canGmail
        ? html`<button class="btn btn-primary btn-small" type="submit" data-confirm-btn="Opret en kladde i Gmail for ${args.sender}? Den sendes ikke.">Opret kladde i Gmail</button>`
        : html`<span class="small muted">Gmail-kladder kræver, at ${args.sender} er forbundet med tilladelse til kladder (se <a href="/admin/kundeemner/mail">Mailkonti</a>).</span>`}
    </div>
  </form>
</div>`;
}

export { raw };
