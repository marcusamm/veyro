// Kundeemner i admin (/admin/kundeemner). Kun ADMIN_EMAILS; beskyttet på serveren.
import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { costHistory, getDefaultRate, periodRange, summarize } from '../lib/costs';
import { toCsv } from '../lib/csv';
import { getCustomerByEmail, getCustomerById, normalizeEmail, upsertCustomer } from '../lib/db';
import { formatDateTime } from '../lib/format';
import {
  BLOCK_SCOPES,
  CHANNELS,
  ConflictError,
  PRIORITY_LABEL,
  PROSPECT_STATUSES,
  STATUS_LABEL,
  activeBlocksFor,
  addBlock,
  addNote,
  addWorkdays,
  archive,
  blockValue,
  blocksForProspect,
  buildDraft,
  candidateOf,
  deleteProspect,
  emptyForm,
  filterOptions,
  findDuplicates,
  formFromProspect,
  getProspect,
  isDay,
  isSalesActive,
  linkCustomer,
  linkLead,
  listBlocks,
  listContacts,
  listEvents,
  listProspects,
  liftBlock,
  matchingLeads,
  mergeProspects,
  readFilter,
  readProspectForm,
  registerContact,
  restore,
  safeFileName,
  safeUrl,
  setFollowUp,
  setOwner,
  setStatus,
  sniffType,
  staffList,
  today,
  unlinkCustomer,
  unreadNotifications,
  updateProspect,
  validateProspect,
  viewCounts,
  FILE_TYPES,
  MAX_FILE,
  type BlockRow,
  type BlockScope,
  type Channel,
  type ProspectForm,
  type ProspectRow,
  type ProspectStatus,
  type ProspectDraft,
  addEvent,
  createProspect,
  staffName,
  normWebsite,
} from '../lib/prospects';
import { getJob } from '../lib/prospect-jobs';
import type { Assessment, Suggestion } from '../lib/site-scan';
import { midnight } from '../lib/stats';
import { render } from '../render';
import { getLead } from '../site/leads';
import { costSection } from '../views/costs';
import { errorPage } from '../views/pages';
import { blocksPage, draftPage, newProspectPage, prospectDetailPage, prospectsListPage } from '../views/prospects';
import { assessmentSection } from '../views/prospect-tools';
import { mailSection, senderOptions } from './admin-mail';
import { adminGuard } from './admin-guard';

const r = new Hono<AppEnv>();

r.use('/kundeemner', adminGuard);
r.use('/kundeemner/*', adminGuard);

const who = (c: Context<AppEnv>) => c.get('session')!.email.toLowerCase();
const nav = { nav: 'admin-kundeemner' as const, admin: true };

const idOf = (raw: string) => {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw ? n : null;
};

async function load(c: Context<AppEnv>): Promise<ProspectRow | null> {
  const id = idOf(c.req.param('id') ?? '');
  return id ? getProspect(c.env.DB, id) : null;
}

const notFound = (c: Context<AppEnv>) =>
  render(c, 'Findes ikke', errorPage('Kundeemnet findes ikke', 'Det kan være slettet.', { href: '/admin/kundeemner', label: 'Til kundeemner' }), { status: 404, ...nav });

const back = (c: Context<AppEnv>, p: { id: number }, flash: string, hash = '') => c.redirect(`/admin/kundeemner/${p.id}?besked=${flash}${hash}`, 303);

// ---------- Oversigt ----------

r.get('/kundeemner', async (c) => {
  const f = readFilter((k) => c.req.query(k));
  const me = who(c);
  const [list, counts, opts, notes] = await Promise.all([
    listProspects(c.env.DB, f, me),
    viewCounts(c.env.DB, me),
    filterOptions(c.env.DB),
    unreadNotifications(c.env.DB, me),
  ]);
  const query = new URL(c.req.url).searchParams;
  query.delete('besked');
  return render(
    c,
    'Kundeemner',
    prospectsListPage({
      rows: list.rows,
      total: list.total,
      filter: f,
      counts,
      staff: staffList(c.env),
      industries: opts.industries,
      areas: opts.areas,
      today: today(),
      notifications: notes,
      csrf: c.get('csrf'),
      flash: c.req.query('besked') ?? null,
      query: query.toString(),
    }),
    nav,
  );
});

r.post('/kundeemner/notifikationer/laest', async (c) => {
  await c.env.DB.prepare('UPDATE admin_notifications SET read_at = ? WHERE (recipient = ? OR recipient IS NULL) AND read_at IS NULL').bind(Math.floor(Date.now() / 1000), who(c)).run();
  return c.redirect('/admin/kundeemner?besked=notifikationer', 303);
});

r.get('/kundeemner/eksport.csv', async (c) => {
  const f = readFilter((k) => c.req.query(k));
  const { rows } = await listProspects(c.env.DB, f, who(c), { limit: 5000, offset: 0 });
  const ids = rows.map((p) => p.id);
  const contacts = new Map<number, { emails: string[]; phones: string[] }>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await c.env.DB.prepare(`SELECT prospect_id, kind, value FROM prospect_contacts WHERE prospect_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ prospect_id: number; kind: string; value: string }>();
    for (const x of res.results ?? []) {
      const e = contacts.get(x.prospect_id) ?? { emails: [], phones: [] };
      (x.kind === 'email' ? e.emails : e.phones).push(x.value);
      contacts.set(x.prospect_id, e);
    }
  }
  const csv = toCsv([
    ['ID', 'Virksomhed', 'CVR', 'Branche', 'By', 'Område', 'Hjemmeside', 'Kontaktperson', 'Mail', 'Telefon', 'Kilde', 'Funddato', 'Prioritet', 'Status', 'Ansvarlig',
      'Seneste kontakt', 'Næste handling', 'Opfølgning', 'Arkiveret', 'Blacklistet', 'Kunde-ID', 'Oprettet', 'Ændret'],
    ...rows.map((p) => [
      p.id, p.company, p.cvr, p.industry, p.city, p.area, p.website, p.contact_name, contacts.get(p.id)?.emails.join(', '), contacts.get(p.id)?.phones.join(', '),
      p.source, p.found_on, PRIORITY_LABEL[p.priority], STATUS_LABEL[p.status], p.owner, p.last_contact_at ? formatDateTime(p.last_contact_at) : '', p.next_action,
      p.follow_up_on, p.archived_at ? 'Ja' : '', p.blacklisted ? 'Ja' : '', p.customer_id, formatDateTime(p.created_at), formatDateTime(p.updated_at),
    ]),
  ]);
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="veyro-kundeemner-${today()}.csv"`, 'Cache-Control': 'no-store' });
});

// ---------- Oprettelse ----------

function newView(c: Context<AppEnv>, extra: Partial<Parameters<typeof newProspectPage>[0]> & { status?: 400 | 409 }) {
  return render(
    c,
    'Nyt kundeemne',
    newProspectPage({
      csrf: c.get('csrf'),
      form: extra.form ?? emptyForm(),
      staff: staffList(c.env),
      error: extra.error ?? null,
      errorField: extra.errorField ?? null,
      duplicates: extra.duplicates ?? [],
      blocks: extra.blocks ?? [],
      extraHidden: extra.extraHidden,
      title: extra.title,
      intro: extra.intro,
      unverified: extra.unverified,
    }),
    { ...nav, status: extra.status },
  );
}

r.get('/kundeemner/ny', (c) => {
  const f = emptyForm();
  // Forudfyldning fra en forespørgsel eller et søgeresultat (kun synlige felter; brugeren bekræfter ved at oprette)
  for (const k of ['company', 'website', 'source', 'source_url', 'industry', 'area'] as const) {
    const v = c.req.query(k);
    if (v) f[k] = v.slice(0, 300);
  }
  return newView(c, { form: f });
});

r.post('/kundeemner', async (c) => {
  const body = await c.req.parseBody();
  const form = readProspectForm(body);
  const job = await linkJobFor(c, body['job']);
  const jv = job ? { extraHidden: html`<input type="hidden" name="job" value="${job.id}">`, title: 'Tilføj via link', unverified: job.fields } : {};
  const v = validateProspect(c.env, form);
  if ('error' in v) return newView(c, { ...jv, form, error: v.error, errorField: v.field, status: 400 });
  const cand = { company: v.draft.company, cvr: v.draft.cvr, domain: v.draft.domain, emails: v.draft.emails };
  const blocks = await activeBlocksFor(c.env.DB, cand);
  if (blocks.length) return newView(c, { ...jv, form, blocks, error: 'Virksomheden er blacklistet og kan ikke oprettes som aktivt kundeemne.', status: 409 });
  const dups = await findDuplicates(c.env.DB, cand);
  if (dups.length && body['confirm_duplicates'] !== '1') return newView(c, { ...jv, form, duplicates: dups, status: 409 });
  const leadId = Number(body['lead']);
  const id = await createFrom(c, v.draft, { lead_id: Number.isSafeInteger(leadId) && leadId > 0 ? leadId : null, ...(job ? job.extra(v.draft) : {}) });
  return c.redirect(`/admin/kundeemner/${id}?besked=oprettet`, 303);
});

/** Oprettelse fra "Tilføj via link": felter, der stadig har den hentede værdi, forbliver ubekræftede */
async function linkJobFor(c: Context<AppEnv>, raw: unknown) {
  const jid = Number(raw);
  if (!Number.isSafeInteger(jid) || jid <= 0) return null;
  const job = await getJob(c.env.DB, jid);
  if (!job || job.kind !== 'link' || job.status !== 'faerdig' || !job.result) return null;
  const res = JSON.parse(job.result) as { suggestion: Suggestion; assessment: Assessment | null };
  const s = res.suggestion;
  const fields = new Set(['company', 'cvr', 'address', 'city', 'website', 'emails', 'phones'].filter((k) => {
    const v = s[k as keyof Suggestion];
    return Array.isArray(v) ? v.length > 0 : !!v;
  }));
  return {
    id: job.id,
    fields,
    extra(d: ProspectDraft) {
      const same: Record<string, boolean> = {
        company: d.company === s.company,
        cvr: !!d.cvr && d.cvr === s.cvr,
        address: !!d.address && d.address === s.address,
        city: !!d.city && d.city === s.city,
        website: !!d.website && !!s.website && d.website === normWebsite(s.website),
      };
      const unverifiedEmails = d.emails.filter((e) => s.emails.includes(e));
      const unverifiedPhones = d.phones.filter((p) => s.phones.includes(p));
      const unverified = Object.keys(same).filter((k) => same[k]);
      if (unverifiedEmails.length) unverified.push('emails');
      if (unverifiedPhones.length) unverified.push('phones');
      return {
        unverified,
        unverifiedEmails,
        unverifiedPhones,
        fetched_from: s.website,
        fetched_at: s.fetchedAt,
        assessment: res.assessment ? JSON.stringify(res.assessment) : null,
        body: `Oprettet via "Tilføj via link" fra ${s.website ?? ''}. Hentede oplysninger er markeret som ubekræftede, og vurderingen er ikke godkendt.`,
      };
    },
  };
}

function createFrom(c: Context<AppEnv>, draft: ProspectDraft, extra: Parameters<typeof createProspect>[3] = {}) {
  return createProspect(c.env.DB, draft, who(c), extra);
}

r.get('/kundeemner/blokeringer', async (c) => {
  const all = c.req.query('alle') === '1';
  return render(c, 'Blokeringer', blocksPage({ rows: await listBlocks(c.env.DB, all), all }), nav);
});

// ---------- Detaljeside ----------

async function detail(c: Context<AppEnv>, p: ProspectRow, extra: { error?: string; status?: 400 | 409 | 502; editForm?: ProspectForm; editError?: string } = {}) {
  const db = c.env.DB;
  const me = who(c);
  const [contacts, events, links, files, offers, customers, rate] = await Promise.all([
    listContacts(db, p.id),
    listEvents(db, p.id),
    db.prepare('SELECT id, url, label, created_at, created_by FROM prospect_links WHERE prospect_id = ? ORDER BY id').bind(p.id).all<any>(),
    db.prepare('SELECT id, name, type, size, created_at FROM prospect_files WHERE prospect_id = ? ORDER BY id').bind(p.id).all<any>(),
    db.prepare('SELECT id, service, status, created_at FROM offers WHERE prospect_id = ? ORDER BY created_at DESC').bind(p.id).all<any>(),
    db.prepare('SELECT id, COALESCE(company, name, email) AS label, email FROM customers ORDER BY label COLLATE NOCASE LIMIT 1000').all<{ id: number; label: string; email: string }>(),
    getDefaultRate(db),
  ]);
  const [blocks, dups, leadSugg] = await Promise.all([
    blocksForProspect(db, p, contacts),
    findDuplicates(db, candidateOf(p, contacts), p.id),
    matchingLeads(db, p, contacts),
  ]);
  const customer = p.customer_id ? await getCustomerById(db, p.customer_id) : null;
  const lead = p.lead_id ? await getLead(db, p.lead_id) : null;
  const period = periodRange(c.req.query('periode'), c.req.query('fra'), c.req.query('til'));
  const subject = { kind: 'prospect' as const, id: p.id };
  const [summary, history, expFiles] = await Promise.all([
    summarize(db, { from: period.from, to: period.to, staff: null, purpose: null, subject }),
    costHistory(db, subject),
    db.prepare('SELECT f.id, f.expense_id, f.name FROM expense_files f JOIN expenses e ON e.id = f.expense_id WHERE e.prospect_id = ? AND e.deleted_at IS NULL').bind(p.id).all<{ id: number; expense_id: number; name: string }>(),
  ]);
  const staff = staffList(c.env);
  const t = today();
  return render(
    c,
    p.company,
    prospectDetailPage({
      csrf: c.get('csrf'),
      p,
      contacts,
      events,
      links: links.results ?? [],
      files: files.results ?? [],
      blocks,
      offers: offers.results ?? [],
      customer: customer ? { id: customer.id, label: customer.company ?? customer.name ?? customer.email } : null,
      lead: lead ? { id: lead.id, label: `#${lead.id} ${lead.company ?? lead.name ?? lead.email}` } : null,
      leadSuggestions: leadSugg,
      duplicates: dups,
      customers: (customers.results ?? []).map((x) => ({ id: x.id, label: x.label === x.email ? x.email : `${x.label} (${x.email})` })),
      staff,
      me,
      today: t,
      suggestedFollowUp: addWorkdays(t, 5),
      flash: extra.error ? null : (c.req.query('besked') ?? null),
      error: extra.error ?? null,
      editForm: extra.editForm ?? formFromProspect(p, contacts),
      editError: extra.editError ?? null,
      costs: costSection({
        csrf: c.get('csrf'),
        subject,
        title: 'Tid og omkostninger',
        summary,
        history,
        staff,
        me: staff.includes(me) ? me : staff[0] ?? me,
        today: t,
        rate,
        back: `/admin/kundeemner/${p.id}`,
        period,
        files: expFiles.results ?? [],
      }),
      mail: await mailSection(c, p),
      assessment: assessmentSection({ csrf: c.get('csrf'), p }),
    }),
    { ...nav, status: extra.status },
  );
}

r.get('/kundeemner/:id', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  return detail(c, p);
});

const version = (body: Record<string, unknown>) => Number(body['version']);

async function guarded(c: Context<AppEnv>, p: ProspectRow, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConflictError) return detail(c, (await getProspect(c.env.DB, p.id)) ?? p, { error: err.message, status: 409 });
    if (err instanceof Error && !(err instanceof TypeError)) return detail(c, (await getProspect(c.env.DB, p.id)) ?? p, { error: err.message, status: 400 });
    throw err;
  }
}

r.post('/kundeemner/:id/rediger', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const form = readProspectForm(body);
  form.owner = p.owner ?? '';
  form.status = p.status;
  const v = validateProspect(c.env, form, { quick: true });
  if ('error' in v) return detail(c, p, { editForm: form, editError: v.error, status: 400 });
  // Ændres navn, CVR eller domæne til noget blokeret, må emnet ikke forblive aktivt
  const blocks = await activeBlocksFor(c.env.DB, { company: v.draft.company, cvr: v.draft.cvr, domain: v.draft.domain, emails: v.draft.emails });
  return guarded(c, p, async () => {
    await updateProspect(c.env.DB, p, await listContacts(c.env.DB, p.id), v.draft, version(body), who(c));
    if (blocks.length && !p.blacklisted) {
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE prospects SET blacklisted = 1, follow_up_on = NULL WHERE id = ?').bind(p.id),
        addEvent(c.env.DB, p.id, { kind: 'blacklist', actor: 'system', body: `Rammer en eksisterende blokering: ${blocks.map((b) => b.reason).join('; ')}` }),
      ]);
    }
    return back(c, p, 'gemt');
  });
});

r.post('/kundeemner/:id/status', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const s = String(body['status'] ?? '');
  if (!(PROSPECT_STATUSES as readonly string[]).includes(s)) return c.text('Ugyldig status.', 400);
  return guarded(c, p, async () => {
    await setStatus(c.env.DB, p, s as ProspectStatus, version(body), who(c));
    return back(c, p, 'status');
  });
});

r.post('/kundeemner/:id/afvis-forslag', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE prospects SET suggested_status = NULL, status_set_at = ?, status_set_by = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), who(c), p.id),
    addEvent(c.env.DB, p.id, { kind: 'status', actor: who(c), body: `Forslag om "${STATUS_LABEL[p.suggested_status as ProspectStatus] ?? p.suggested_status}" afvist; status forbliver ${STATUS_LABEL[p.status]}`, new_value: p.status, old_value: p.status }),
  ]);
  return back(c, p, 'status');
});

r.post('/kundeemner/:id/ansvarlig', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const owner = String(body['owner'] ?? '').toLowerCase() || null;
  if (owner && !staffList(c.env).includes(owner)) return c.text('Ugyldig ansvarlig.', 400);
  return guarded(c, p, async () => {
    await setOwner(c.env.DB, p, owner, version(body), who(c));
    return back(c, p, 'ansvarlig');
  });
});

/** "YYYY-MM-DDTHH:MM" i dansk tid -> unix-sekunder */
function parseLocal(raw: unknown): number | null {
  const m = typeof raw === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(raw) : null;
  if (!m || !isDay(m[1]) || +m[2]! > 23 || +m[3]! > 59) return null;
  return midnight(m[1]!) + Number(m[2]) * 3600 + Number(m[3]) * 60;
}

r.post('/kundeemner/:id/kontakt', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const channel = s('channel') as Channel;
  if (!(CHANNELS as readonly string[]).includes(channel)) return detail(c, p, { error: 'Vælg kontaktform.', status: 400 });
  const at = parseLocal(s('at'));
  if (!at || at > Math.floor(Date.now() / 1000) + 3600) return detail(c, p, { error: 'Vælg dato og tidspunkt for kontakten (ikke i fremtiden).', status: 400 });
  const staff = s('staff').toLowerCase();
  if (!staffList(c.env).includes(staff)) return detail(c, p, { error: 'Vælg en Veyro-medarbejder.', status: 400 });
  const status = s('status') ? (s('status') as ProspectStatus) : null;
  if (status && !(PROSPECT_STATUSES as readonly string[]).includes(status)) return detail(c, p, { error: 'Ugyldig status.', status: 400 });
  const follow = s('follow_up_on');
  if (follow && !isDay(follow)) return detail(c, p, { error: 'Vælg en gyldig opfølgningsdato.', status: 400 });
  return guarded(c, p, async () => {
    await registerContact(
      c.env.DB,
      p,
      {
        channel,
        at,
        staff,
        contact_person: s('contact_person').slice(0, 150) || null,
        body: s('body').slice(0, 4000) || null,
        status,
        next_action: follow ? s('next_action').slice(0, 300) || 'Følg op' : s('next_action').slice(0, 300) || null,
        follow_up_on: follow,
        keep_follow_up: s('keep_follow_up') === '1',
      },
      who(c),
    );
    return back(c, p, 'kontakt', '#registrer-kontakt');
  });
});

r.post('/kundeemner/:id/note', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const text = String(body['body'] ?? '').trim().slice(0, 4000);
  if (!text) return detail(c, p, { error: 'Skriv en note.', status: 400 });
  await addNote(c.env.DB, p, text, who(c));
  return back(c, p, 'note');
});

r.post('/kundeemner/:id/opfoelgning', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const drop = body['op'] === 'fravaelg';
  const day = drop ? null : String(body['follow_up_on'] ?? '');
  if (day !== null && !isDay(day)) return detail(c, p, { error: 'Vælg en gyldig dato.', status: 400 });
  return guarded(c, p, async () => {
    await setFollowUp(c.env.DB, p, day, drop ? p.next_action : String(body['next_action'] ?? '').trim().slice(0, 300) || null, who(c));
    return back(c, p, 'opfoelgning');
  });
});

r.post('/kundeemner/:id/arkiver', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  await archive(c.env.DB, p, who(c));
  return back(c, p, 'arkiveret');
});

r.post('/kundeemner/:id/gendan', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  await restore(c.env.DB, p, who(c));
  return back(c, p, 'gendannet');
});

r.post('/kundeemner/:id/blokering', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const scope = String(body['scope'] ?? '') as BlockScope;
  if (!(BLOCK_SCOPES as readonly string[]).includes(scope)) return detail(c, p, { error: 'Vælg omfang.', status: 400 });
  const reason = String(body['reason'] ?? '').trim().slice(0, 500);
  if (!reason) return detail(c, p, { error: 'Skriv en årsag til blokeringen.', status: 400 });
  const v = blockValue(scope, p, String(body['value'] ?? '').trim());
  if ('error' in v) return detail(c, p, { error: v.error, status: 400 });
  await addBlock(c.env.DB, p, scope, v.value, reason, who(c));
  return back(c, p, 'blokeret');
});

r.post('/kundeemner/:id/blokering/:bid/ophaev', async (c) => {
  const p = await load(c);
  const bid = idOf(c.req.param('bid'));
  if (!p || !bid) return notFound(c);
  const b = await c.env.DB.prepare('SELECT * FROM prospect_blocks WHERE id = ?').bind(bid).first<BlockRow>();
  if (!b || b.lifted_at) return detail(c, p, { error: 'Blokeringen findes ikke eller er allerede ophævet.', status: 400 });
  const reason = String((await c.req.parseBody())['reason'] ?? '').trim().slice(0, 500);
  if (!reason) return detail(c, p, { error: 'Skriv hvorfor blokeringen ophæves.', status: 400 });
  // Blokeringen kan være registreret på et andet emne, men ramme dette; knyt ophævelsen til begge
  await liftBlock(c.env.DB, b, reason, who(c));
  if (b.prospect_id !== p.id) {
    const still = await activeBlocksFor(c.env.DB, candidateOf(p, await listContacts(c.env.DB, p.id)));
    await c.env.DB.prepare('UPDATE prospects SET blacklisted = ? WHERE id = ?').bind(still.length ? 1 : 0, p.id).run();
    await addEvent(c.env.DB, p.id, { kind: 'unblacklist', actor: who(c), body: reason }).run();
  }
  return back(c, p, 'ophaevet');
});

r.post('/kundeemner/:id/kunde', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const cid = Number((await c.req.parseBody())['customer']);
  const customer = Number.isSafeInteger(cid) && cid > 0 ? await getCustomerById(c.env.DB, cid) : null;
  if (!customer) return detail(c, p, { error: 'Vælg en eksisterende kunde.', status: 400 });
  if (p.customer_id && p.customer_id !== customer.id) return detail(c, p, { error: 'Kundeemnet er allerede knyttet til en anden kunde. Fjern den tilknytning først.', status: 409 });
  await linkCustomer(c.env.DB, p, customer.id, who(c), `Knyttet til kunden ${customer.company ?? customer.name ?? customer.email}`);
  return back(c, p, 'kunde');
});

r.post('/kundeemner/:id/kunde/ny', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.customer_id) return detail(c, p, { error: 'Kundeemnet er allerede knyttet til en kunde.', status: 409 });
  const body = await c.req.parseBody();
  const email = normalizeEmail(body['email']);
  if (!email) return detail(c, p, { error: 'Skriv kundens mailadresse.', status: 400 });
  // Undgå dubletter: findes kunden allerede, knyttes til den
  const existing = await getCustomerByEmail(c.env.DB, email);
  const customer = existing ?? (await upsertCustomer(c.env.DB, { email, name: String(body['name'] ?? '').trim() || p.contact_name }));
  if (!existing) {
    await c.env.DB.prepare('UPDATE customers SET company = COALESCE(company, ?), cvr = COALESCE(cvr, ?), city = COALESCE(city, ?), updated_at = ? WHERE id = ?')
      .bind(p.company, p.cvr, p.city, Math.floor(Date.now() / 1000), customer.id)
      .run();
  }
  await linkCustomer(c.env.DB, p, customer.id, who(c), existing ? `Kunden med ${email} fandtes allerede og er knyttet til` : `Nyt kundekort oprettet (${email}). Ingen invitation eller betaling er startet.`);
  return back(c, p, 'kunde');
});

r.post('/kundeemner/:id/kunde/fjern', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.customer_id) await unlinkCustomer(c.env.DB, p, who(c));
  return back(c, p, 'kunde-fjernet');
});

r.post('/kundeemner/:id/forespoergsel', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const lid = Number((await c.req.parseBody())['lead']);
  const lead = Number.isSafeInteger(lid) && lid > 0 ? await getLead(c.env.DB, lid) : null;
  if (!lead) return detail(c, p, { error: 'Forespørgslen findes ikke.', status: 400 });
  await linkLead(c.env.DB, p, lead.id, who(c));
  return back(c, p, 'forespoergsel');
});

r.post('/kundeemner/:id/flet', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const oid = Number((await c.req.parseBody())['other']);
  const other = Number.isSafeInteger(oid) && oid > 0 ? await getProspect(c.env.DB, oid) : null;
  if (!other || other.merged_into) return detail(c, p, { error: 'Det andet kundeemne findes ikke.', status: 400 });
  return guarded(c, p, async () => {
    await mergeProspects(c.env.DB, p, other, who(c));
    return back(c, p, 'flettet');
  });
});

r.post('/kundeemner/:id/slet', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const name = String((await c.req.parseBody())['confirm_name'] ?? '').trim();
  if (name.toLowerCase() !== p.company.trim().toLowerCase()) return detail(c, p, { error: 'Skriv virksomhedens navn præcist for at bekræfte sletningen.', status: 400 });
  await deleteProspect(c.env.DB, p);
  return c.redirect('/admin/kundeemner?besked=slettet', 303);
});

// ---------- Links og filer ----------

r.post('/kundeemner/:id/links', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const body = await c.req.parseBody();
  const url = safeUrl(body['url']);
  if (!url) return detail(c, p, { error: 'Linket skal starte med https:// eller http://.', status: 400 });
  await c.env.DB.prepare('INSERT INTO prospect_links (prospect_id, url, label, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind(p.id, url, String(body['label'] ?? '').trim().slice(0, 150) || null, Math.floor(Date.now() / 1000), who(c))
    .run();
  return back(c, p, 'link');
});

r.post('/kundeemner/:id/links/:lid/slet', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  await c.env.DB.prepare('DELETE FROM prospect_links WHERE id = ? AND prospect_id = ?').bind(Number(c.req.param('lid')), p.id).run();
  return back(c, p, 'link-slettet');
});

r.post('/kundeemner/:id/filer', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const file = (await c.req.parseBody())['file'];
  if (!(file instanceof File) || file.size === 0) return detail(c, p, { error: 'Vælg en fil.', status: 400 });
  if (file.size > MAX_FILE) return detail(c, p, { error: 'Filen er større end 2 MB.', status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffType(bytes);
  if (!type || !FILE_TYPES[type]) return detail(c, p, { error: 'Kun PNG, JPG, WebP, GIF og PDF.', status: 400 });
  await c.env.DB.prepare('INSERT INTO prospect_files (prospect_id, name, type, size, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(p.id, safeFileName(file.name, type), type, bytes.length, bytes, Math.floor(Date.now() / 1000), who(c))
    .run();
  return back(c, p, 'fil');
});

r.get('/kundeemner/:id/filer/:fid', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  const row = await c.env.DB.prepare('SELECT name, type, data FROM prospect_files WHERE id = ? AND prospect_id = ?').bind(Number(c.req.param('fid')), p.id).first<{ name: string; type: string; data: ArrayBuffer }>();
  if (!row) return c.text('Ikke fundet', 404);
  return c.body(new Uint8Array(row.data) as any, 200, {
    'Content-Type': row.type,
    'Content-Disposition': `${row.type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${row.name.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
  });
});

r.post('/kundeemner/:id/filer/:fid/slet', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  await c.env.DB.prepare('DELETE FROM prospect_files WHERE id = ? AND prospect_id = ?').bind(Number(c.req.param('fid')), p.id).run();
  return back(c, p, 'fil-slettet');
});

// ---------- Mailudkast ----------

const DRAFT_ERRORS: Record<string, string> = {
  'ikke-forbundet': 'Afsenderens Gmail er ikke forbundet med tilladelse til kladder.',
  gmail: 'Gmail svarede med en fejl. Kladden er ikke oprettet. Prøv igen, eller kopiér teksten.',
  modtager: 'Skriv en gyldig modtageradresse.',
  blokeret: 'Modtageren er blacklistet. Der oprettes ikke salgskladder.',
};

r.get('/kundeemner/:id/udkast', async (c) => {
  const p = await load(c);
  if (!p) return notFound(c);
  if (p.blacklisted) return detail(c, p, { error: 'Kundeemnet er blacklistet. Der laves ikke salgsudkast.', status: 409 });
  if (!isSalesActive(p) && p.status !== 'dialog') {
    // Afslag og arkiverede emner får ikke salgsudkast
    if (p.status === 'afslag' || p.archived_at) return detail(c, p, { error: 'Der laves ikke salgsudkast til afslag eller arkiverede kundeemner.', status: 409 });
  }
  const [contacts, events] = await Promise.all([listContacts(c.env.DB, p.id), listEvents(c.env.DB, p.id, 50)]);
  const senders = await senderOptions(c);
  const me = who(c);
  const reqSender = (c.req.query('afsender') ?? '').toLowerCase();
  const sender = senders.find((s) => s.email === reqSender)?.email ?? senders.find((s) => s.email === me)?.email ?? senders[0]?.email ?? me;
  const kind = c.req.query('type') === 'opfoelgning' || events.some((e) => e.kind === 'contact' || e.kind === 'mail') ? (c.req.query('type') === 'foerste' ? 'foerste' : 'opfoelgning') : 'foerste';
  let observations: string[] = [];
  if (p.assessment && p.assessment_approved_at) {
    try {
      observations = (JSON.parse(p.assessment).observations ?? []).map((o: { text: string }) => o.text).filter(Boolean);
    } catch {
      observations = [];
    }
  }
  const draft = buildDraft({ p, contacts, events, sender, kind, observations });
  return render(c, 'Mailudkast', draftPage({ p, draft, senders, sender, kind, csrf: c.get('csrf'), flash: c.req.query('besked') ?? null, error: DRAFT_ERRORS[c.req.query('fejl') ?? ''] ?? null }), nav);
});

export default r;
export { detail as prospectDetail, staffName };
