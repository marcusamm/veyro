// Baggrundsjob for kundeemner: hent hjemmeside ("Tilføj via link"), vurdering af et emnes hjemmeside
// og søgning i en offentlig kilde. Køres straks i baggrunden og genforsøges af cron (højst 3 forsøg).
import type { Env } from '../env';
import { nowSec } from './crypto';
import { logError } from './errlog';
import { activeBlocksFor, addEvent, findDuplicates, getProspect, today } from './prospects';
import { FetchBlocked, safeFetch } from './safe-fetch';
import { assess, companiesFromSource, scanSite } from './site-scan';

export type JobKind = 'link' | 'vurdering' | 'kilde';

export interface JobRow {
  id: number;
  kind: JobKind;
  status: 'venter' | 'koerer' | 'faerdig' | 'fejl';
  input: string;
  result: string | null;
  error: string | null;
  attempts: number;
  next_attempt_at: number;
  prospect_id: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const MAX_ATTEMPTS = 3;

export async function createJob(db: D1Database, kind: JobKind, input: Record<string, unknown>, actor: string, prospectId: number | null = null): Promise<number> {
  const now = nowSec();
  const row = await db
    .prepare('INSERT INTO prospect_jobs (kind, input, next_attempt_at, prospect_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(kind, JSON.stringify(input), now, prospectId, actor, now, now)
    .first<{ id: number }>();
  return row!.id;
}

export async function getJob(db: D1Database, id: number): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM prospect_jobs WHERE id = ?').bind(id).first<JobRow>();
}

/** Kører ét job. Atomisk "lås": kun ét forsøg ad gangen pr. job. */
export async function runJob(env: Env, id: number): Promise<void> {
  const now = nowSec();
  const job = await env.DB.prepare(
    "UPDATE prospect_jobs SET status = 'koerer', attempts = attempts + 1, updated_at = ?1 WHERE id = ?2 AND status IN ('venter', 'fejl') AND attempts < ?3 AND next_attempt_at <= ?1 RETURNING *",
  )
    .bind(now, id, MAX_ATTEMPTS)
    .first<JobRow>();
  if (!job) return;
  try {
    const input = JSON.parse(job.input) as Record<string, unknown>;
    let result: unknown;
    if (job.kind === 'link') result = await linkJob(env, String(input.url ?? ''));
    else if (job.kind === 'vurdering') result = await assessmentJob(env, job, String(input.url ?? ''));
    else result = await sourceJob(env, Number(input.source_id));
    await env.DB.prepare("UPDATE prospect_jobs SET status = 'faerdig', result = ?, error = NULL, updated_at = ? WHERE id = ?").bind(JSON.stringify(result), nowSec(), id).run();
  } catch (err) {
    // Blokerede adresser og tydelige fejl genforsøges ikke
    const permanent = err instanceof FetchBlocked || (err instanceof Error && /fejl 4\d\d|ikke en HTML|findes ikke/i.test(err.message));
    const msg = err instanceof Error ? err.message.slice(0, 300) : 'Ukendt fejl';
    const attempts = job.attempts;
    await env.DB.prepare("UPDATE prospect_jobs SET status = 'fejl', error = ?, attempts = CASE WHEN ? THEN ? ELSE attempts END, next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .bind(err instanceof Error && err.name === 'TimeoutError' ? 'Hjemmesiden svarede ikke i tide.' : msg, permanent ? 1 : 0, MAX_ATTEMPTS, nowSec() + 60 * 2 ** attempts, nowSec(), id)
      .run();
    if (!permanent) await logError(env.DB, `kundeemner.job.${job.kind}`, err);
  }
}

/** Cron: genforsøg på fejlede job og job, der er gået i stå */
export async function runJobs(env: Env): Promise<void> {
  const now = nowSec();
  await env.DB.prepare("UPDATE prospect_jobs SET status = 'fejl', error = 'Afbrudt; prøver igen' WHERE status = 'koerer' AND updated_at < ?").bind(now - 600).run();
  const { results } = await env.DB.prepare("SELECT id FROM prospect_jobs WHERE status IN ('venter', 'fejl') AND attempts < ? AND next_attempt_at <= ? ORDER BY id LIMIT 10").bind(MAX_ATTEMPTS, now).all<{ id: number }>();
  for (const r of results ?? []) await runJob(env, r.id);
  await env.DB.prepare('DELETE FROM prospect_jobs WHERE created_at < ?').bind(now - 30 * 86400).run();
}

async function linkJob(env: Env, url: string) {
  const { suggestion, pages } = await scanSite(env, url);
  const assessment = await assess(env, pages);
  return { suggestion, assessment };
}

async function assessmentJob(env: Env, job: JobRow, url: string) {
  const { pages } = await scanSite(env, url);
  const assessment = await assess(env, pages);
  if (job.prospect_id && (await getProspect(env.DB, job.prospect_id))) {
    // Ny vurdering er ikke godkendt, før en medarbejder har gennemgået den
    await env.DB.batch([
      env.DB.prepare('UPDATE prospects SET assessment = ?, assessment_approved_at = NULL, assessment_approved_by = NULL, updated_at = ? WHERE id = ?').bind(JSON.stringify(assessment), nowSec(), job.prospect_id),
      addEvent(env.DB, job.prospect_id, { kind: 'auto', actor: 'system', body: `Vurdering af hjemmesiden hentet (${assessment.observations.length} observationer). Afventer godkendelse.` }),
    ]);
  }
  return { assessment };
}

async function sourceJob(env: Env, sourceId: number) {
  const src = await env.DB.prepare('SELECT * FROM prospect_sources WHERE id = ?').bind(sourceId).first<{ id: number; name: string; url: string; industry: string | null; area: string | null }>();
  if (!src) throw new Error('Kilden findes ikke.');
  let page;
  try {
    page = await safeFetch(env, src.url);
  } catch (err) {
    await env.DB.prepare('UPDATE prospect_sources SET last_error = ? WHERE id = ?').bind(err instanceof Error ? err.message.slice(0, 300) : 'Fejl', src.id).run();
    throw err;
  }
  if (!page.body) throw new Error(page.status >= 400 ? `Kilden svarede med fejl ${page.status}.` : 'Kilden er ikke en HTML-side.');
  const found = companiesFromSource(page);
  const day = today();
  let added = 0;
  let blocked = 0;
  let known = 0;
  for (const f of found) {
    if ((await activeBlocksFor(env.DB, { company: f.company, cvr: null, domain: f.domain, emails: [] })).length) {
      blocked++;
      continue;
    }
    const dups = await findDuplicates(env.DB, { company: f.company, cvr: null, domain: f.domain, emails: [] });
    const dupText = dups.length ? ` Mulig dublet: ${dups.slice(0, 2).map((d) => `${d.name} (${d.kind === 'prospect' ? 'kundeemne' : 'kunde'}, ${d.signals.join(', ')})`).join('; ')}.` : '';
    if (dups.some((d) => d.signals.some((s) => s.startsWith('Samme domæne')))) known++;
    const res = await env.DB.prepare(
      `INSERT INTO prospect_candidates (source_id, company, website, domain, found_on, reason, not_checked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, domain) DO NOTHING`,
    )
      .bind(
        src.id,
        f.company.slice(0, 120),
        f.website,
        f.domain,
        day,
        `Linket fra ${src.name}${src.industry ? ` (branche: ${src.industry})` : ''}${src.area ? ` (område: ${src.area})` : ''}.${dupText}`,
        'Hjemmesidens indhold, kontaktoplysninger, behov, branche og om virksomheden faktisk ligger i området er ikke undersøgt.',
        nowSec(),
      )
      .run();
    if (res.meta.changes) added++;
  }
  await env.DB.prepare('UPDATE prospect_sources SET last_run_at = ?, last_error = NULL WHERE id = ?').bind(nowSec(), src.id).run();
  return { found: found.length, added, blocked, known };
}
