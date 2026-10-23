// "Tilføj via link", vurdering af hjemmeside og "Find nye kundeemner" (/admin/kundeemner/...). Kun ADMIN_EMAILS.
// Hentning sker i baggrunden med SSRF-beskyttelse (lib/safe-fetch). Intet oprettes eller importeres uden et klik.
import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { nowSec } from '../lib/crypto';
import { createJob, getJob, runJob, type JobRow } from '../lib/prospect-jobs';
import {
  activeBlocksFor,
  addEvent,
  createProspect,
  emptyForm,
  findDuplicates,
  getProspect,
  staffList,
  validateProspect,
} from '../lib/prospects';
import { checkUrl } from '../lib/safe-fetch';
import type { Assessment, Suggestion } from '../lib/site-scan';
import { render } from '../render';
import { errorPage } from '../views/pages';
import { findPage, jobWaitPage, linkIntro, linkStartPage, parseAssessment, type CandidateRow, type SourceRow } from '../views/prospect-tools';
import { newProspectPage } from '../views/prospects';
import { adminGuard } from './admin-guard';

const r = new Hono<AppEnv>();
r.use('/kundeemner/*', adminGuard);

const who = (c: Context<AppEnv>) => c.get('session')!.email.toLowerCase();
const nav = { nav: 'admin-kundeemner' as const, admin: true };
const idOf = (raw: string | undefined) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw ? n : null;
};
const notFound = (c: Context<AppEnv>, what = 'Siden findes ikke') =>
  render(c, 'Findes ikke', errorPage(what, 'Den kan være slettet.', { href: '/admin/kundeemner', label: 'Til kundeemner' }), { status: 404, ...nav });

/** Kører jobbet efter svaret er sendt; cron genforsøger, hvis det fejler */
function kick(c: Context<AppEnv>, id: number) {
  c.executionCtx.waitUntil(runJob(c.env, id).catch(() => {}));
}

const normInput = (raw: string) => {
  const s = raw.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

// ---------- Tilføj via link ----------

r.get('/kundeemner/link', (c) => render(c, 'Tilføj via link', linkStartPage({ csrf: c.get('csrf'), url: '', error: null }), nav));

r.post('/kundeemner/link', async (c) => {
  const body = await c.req.parseBody();
  const raw = String(body['url'] ?? '').slice(0, 500);
  const chk = raw.trim() ? checkUrl(c.env, normInput(raw)) : { error: 'Skriv en adresse.' };
  if ('error' in chk) return render(c, 'Tilføj via link', linkStartPage({ csrf: c.get('csrf'), url: raw, error: chk.error }), { ...nav, status: 400 });
  const id = await createJob(c.env.DB, 'link', { url: chk.url.toString() }, who(c));
  kick(c, id);
  return c.redirect(`/admin/kundeemner/link/${id}`, 303);
});

r.get('/kundeemner/link/:job', async (c) => {
  const id = idOf(c.req.param('job'));
  const job = id ? await getJob(c.env.DB, id) : null;
  if (!job || job.kind !== 'link') return notFound(c);
  if (job.status !== 'faerdig' || !job.result) {
    const waiting = job.status === 'venter' || job.status === 'koerer';
    return render(c, 'Tilføj via link', jobWaitPage({ csrf: c.get('csrf'), job, title: 'Tilføj via link', back: '/admin/kundeemner/link' }), { ...nav, refresh: waiting ? 2 : undefined });
  }
  const res = JSON.parse(job.result) as { suggestion: Suggestion; assessment: Assessment };
  const s = res.suggestion;
  const form = emptyForm();
  const unverified = new Set<string>();
  const set = (k: 'company' | 'cvr' | 'address' | 'city' | 'website' | 'emails' | 'phones', v: string | null | undefined) => {
    if (v) {
      form[k] = v;
      unverified.add(k);
    }
  };
  set('company', s.company);
  set('cvr', s.cvr);
  set('address', s.address);
  set('city', s.city);
  set('website', s.website);
  set('emails', s.emails.join('\n'));
  set('phones', s.phones.join('\n'));
  form.source = 'Hjemmeside (Tilføj via link)';
  form.source_url = s.website ?? '';
  const v = validateProspect(c.env, form);
  const cand = 'draft' in v ? { company: v.draft.company, cvr: v.draft.cvr, domain: v.draft.domain, emails: v.draft.emails } : null;
  const [blocks, dups] = cand ? await Promise.all([activeBlocksFor(c.env.DB, cand), findDuplicates(c.env.DB, cand)]) : [[], []];
  return render(
    c,
    'Tilføj via link',
    newProspectPage({
      csrf: c.get('csrf'),
      form,
      staff: staffList(c.env),
      error: s.company ? null : 'Virksomhedens navn blev ikke fundet på siden. Skriv det selv.',
      errorField: s.company ? null : 'company',
      duplicates: dups,
      blocks,
      extraHidden: html`<input type="hidden" name="job" value="${job.id}">`,
      title: 'Tilføj via link',
      intro: linkIntro(s, res.assessment),
      unverified,
    }),
    nav,
  );
});

r.post('/kundeemner/job/:job/igen', async (c) => {
  const id = idOf(c.req.param('job'));
  const job = id ? await getJob(c.env.DB, id) : null;
  if (!job || job.status !== 'fejl') return notFound(c);
  await c.env.DB.prepare("UPDATE prospect_jobs SET status = 'venter', attempts = 0, next_attempt_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'fejl'").bind(nowSec(), nowSec(), job.id).run();
  kick(c, job.id);
  if (job.kind === 'link') return c.redirect(`/admin/kundeemner/link/${job.id}`, 303);
  if (job.kind === 'vurdering' && job.prospect_id) return c.redirect(`/admin/kundeemner/${job.prospect_id}?besked=vurdering-hentes#vurdering`, 303);
  return c.redirect('/admin/kundeemner/find?besked=koerer', 303);
});

// ---------- Vurdering på et kundeemne ----------

r.post('/kundeemner/:id/vurdering/hent', async (c) => {
  const id = idOf(c.req.param('id'));
  const p = id ? await getProspect(c.env.DB, id) : null;
  if (!p) return notFound(c, 'Kundeemnet findes ikke');
  if (!p.website) return c.redirect(`/admin/kundeemner/${p.id}#vurdering`, 303);
  const jid = await createJob(c.env.DB, 'vurdering', { url: p.website }, who(c), p.id);
  kick(c, jid);
  return c.redirect(`/admin/kundeemner/${p.id}?besked=vurdering-hentes#vurdering`, 303);
});

r.post('/kundeemner/:id/vurdering', async (c) => {
  const id = idOf(c.req.param('id'));
  const p = id ? await getProspect(c.env.DB, id) : null;
  if (!p) return notFound(c, 'Kundeemnet findes ikke');
  const old = parseAssessment(p.assessment);
  if (!old) return c.redirect(`/admin/kundeemner/${p.id}#vurdering`, 303);
  const body = await c.req.parseBody();
  const lines = (k: string, max: number) =>
    String(body[k] ?? '')
      .split(/\r?\n/)
      .map((x) => x.trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, max);
  // Uændrede observationer beholder deres kildeside; nye eller rettede er medarbejderens egne
  const observations = lines('observations', 30).map((t) => old.observations.find((o) => o.text === t) ?? { kind: 'manuel', text: t, page: '' });
  const next: Assessment = { ...old, observations, suggestions: lines('suggestions', 20), notChecked: lines('not_checked', 20) };
  const approve = body['op'] === 'godkend';
  const me = who(c);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE prospects SET assessment = ?, assessment_approved_at = ?, assessment_approved_by = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(
      JSON.stringify(next),
      approve ? nowSec() : null,
      approve ? me : null,
      nowSec(),
      me,
      p.id,
    ),
    addEvent(c.env.DB, p.id, { kind: 'edit', actor: me, body: approve ? `Vurdering af hjemmesiden gennemgået og godkendt (${observations.length} observationer).` : 'Vurdering af hjemmesiden rettet (ikke godkendt).' }),
  ]);
  return c.redirect(`/admin/kundeemner/${p.id}?besked=${approve ? 'vurdering' : 'vurdering-gemt'}#vurdering`, 303);
});

// ---------- Find nye kundeemner ----------

async function findView(c: Context<AppEnv>, extra: { error?: string; status?: 400; imported?: { n: number; skipped: string[] } } = {}) {
  const db = c.env.DB;
  const f = {
    industry: (c.req.query('branche') ?? '').slice(0, 100),
    area: (c.req.query('omraade') ?? '').slice(0, 100),
    status: ['ny', 'importeret', 'fravalgt', 'alle'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'ny',
    source: idOf(c.req.query('kilde')) ? c.req.query('kilde')! : '',
  };
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status !== 'alle') {
    where.push('x.status = ?');
    binds.push(f.status);
  }
  if (f.industry) {
    where.push('s.industry = ?');
    binds.push(f.industry);
  }
  if (f.area) {
    where.push('s.area = ?');
    binds.push(f.area);
  }
  if (f.source) {
    where.push('x.source_id = ?');
    binds.push(Number(f.source));
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [sources, jobs, cands, total, inds, areas] = await db.batch([
    db.prepare('SELECT * FROM prospect_sources ORDER BY created_at DESC'),
    db.prepare("SELECT *, CAST(json_extract(input, '$.source_id') AS INTEGER) AS source_id FROM prospect_jobs WHERE kind = 'kilde' ORDER BY id DESC LIMIT 50"),
    db.prepare(`SELECT x.*, s.name AS source_name, s.url AS source_url, s.industry, s.area FROM prospect_candidates x JOIN prospect_sources s ON s.id = x.source_id ${w} ORDER BY x.created_at DESC, x.id LIMIT 300`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n FROM prospect_candidates x JOIN prospect_sources s ON s.id = x.source_id ${w}`).bind(...binds),
    db.prepare('SELECT DISTINCT industry AS v FROM prospect_sources WHERE industry IS NOT NULL ORDER BY v'),
    db.prepare('SELECT DISTINCT area AS v FROM prospect_sources WHERE area IS NOT NULL ORDER BY v'),
  ]);
  const q = c.req.query();
  const imported = extra.imported ?? (q['importeret'] !== undefined ? { n: Number(q['importeret']) || 0, skipped: (q['sprunget'] ?? '').split('|').filter(Boolean).slice(0, 50) } : null);
  return render(
    c,
    'Find nye kundeemner',
    findPage({
      csrf: c.get('csrf'),
      sources: (sources?.results ?? []) as SourceRow[],
      jobs: (jobs?.results ?? []) as (JobRow & { source_id: number | null })[],
      candidates: (cands?.results ?? []) as CandidateRow[],
      total: ((total?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
      filter: f,
      industries: ((inds?.results ?? []) as { v: string }[]).map((x) => x.v),
      areas: ((areas?.results ?? []) as { v: string }[]).map((x) => x.v),
      flash: q['besked'] ?? null,
      imported,
      error: extra.error ?? null,
    }),
    { ...nav, status: extra.status },
  );
}

r.get('/kundeemner/find', (c) => findView(c));

r.post('/kundeemner/find/kilder', async (c) => {
  const body = await c.req.parseBody();
  const name = String(body['name'] ?? '').trim().slice(0, 100);
  const raw = String(body['url'] ?? '').trim().slice(0, 500);
  if (!name || !raw) return findView(c, { error: 'Skriv navn og adresse på kilden.', status: 400 });
  const chk = checkUrl(c.env, normInput(raw));
  if ('error' in chk) return findView(c, { error: chk.error, status: 400 });
  const opt = (k: string, max: number) => String(body[k] ?? '').trim().slice(0, max) || null;
  await c.env.DB.prepare('INSERT INTO prospect_sources (name, url, industry, area, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(name, chk.url.toString(), opt('industry', 100), opt('area', 100), opt('note', 300), who(c), nowSec())
    .run();
  return c.redirect('/admin/kundeemner/find?besked=kilde', 303);
});

r.post('/kundeemner/find/kilder/:sid/slet', async (c) => {
  const id = idOf(c.req.param('sid'));
  if (!id) return notFound(c);
  // Fundene slettes med kilden; importerede kundeemner bliver liggende med deres kildeoplysninger
  await c.env.DB.prepare('DELETE FROM prospect_sources WHERE id = ?').bind(id).run();
  return c.redirect('/admin/kundeemner/find?besked=slettet', 303);
});

r.post('/kundeemner/find/kilder/:sid/koer', async (c) => {
  const id = idOf(c.req.param('sid'));
  const src = id ? await c.env.DB.prepare('SELECT id FROM prospect_sources WHERE id = ?').bind(id).first() : null;
  if (!src) return notFound(c);
  const jid = await createJob(c.env.DB, 'kilde', { source_id: id }, who(c));
  kick(c, jid);
  return c.redirect('/admin/kundeemner/find?besked=koerer', 303);
});

r.post('/kundeemner/find/importer', async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody({ all: true });
  const ids = ([] as unknown[]).concat(body['c'] ?? []).map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 100);
  if (!ids.length) return findView(c, { error: 'Vælg mindst ét fund.', status: 400 });
  const me = who(c);
  const rows = ((await db.prepare(`SELECT x.*, s.name AS source_name, s.url AS source_url, s.industry, s.area FROM prospect_candidates x JOIN prospect_sources s ON s.id = x.source_id WHERE x.status = 'ny' AND x.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<CandidateRow>()).results ?? []);
  if (body['op'] === 'fravaelg') {
    await db.prepare(`UPDATE prospect_candidates SET status = 'fravalgt' WHERE status = 'ny' AND id IN (${rows.map(() => '?').join(',') || 'NULL'})`).bind(...rows.map((x) => x.id)).run();
    return c.redirect('/admin/kundeemner/find?besked=fravalgt', 303);
  }
  let n = 0;
  const skipped: string[] = [];
  for (const x of rows) {
    const form = emptyForm();
    form.company = x.company;
    form.website = x.website;
    form.industry = x.industry ?? '';
    form.area = x.area ?? '';
    form.source = x.source_name.slice(0, 100);
    form.source_url = x.source_url;
    form.found_on = x.found_on;
    const v = validateProspect(c.env, form);
    if ('error' in v) {
      skipped.push(`${x.company}: ${v.error}`);
      continue;
    }
    const cand = { company: v.draft.company, cvr: null, domain: v.draft.domain, emails: [] };
    if ((await activeBlocksFor(db, cand)).length) {
      skipped.push(`${x.company}: blacklistet`);
      continue;
    }
    const dup = (await findDuplicates(db, cand)).find((d) => d.signals.some((s) => s.startsWith('Samme domæne')) || d.strong);
    if (dup) {
      skipped.push(`${x.company}: findes allerede som ${dup.kind === 'prospect' ? 'kundeemne' : 'kunde'} "${dup.name}"`);
      continue;
    }
    const id = await createProspect(db, v.draft, me, {
      unverified: ['company', 'website', 'industry', 'area'],
      body: `Importeret fra kilden "${x.source_name}" (${x.source_url}), fundet ${x.found_on}. ${x.reason} Ikke undersøgt: ${x.not_checked}`,
    });
    await db.prepare("UPDATE prospect_candidates SET status = 'importeret', prospect_id = ? WHERE id = ?").bind(id, x.id).run();
    n++;
  }
  const qs = new URLSearchParams({ importeret: String(n) });
  if (skipped.length) qs.set('sprunget', skipped.join('|').slice(0, 1500));
  return c.redirect(`/admin/kundeemner/find?${qs}`, 303);
});

export default r;
