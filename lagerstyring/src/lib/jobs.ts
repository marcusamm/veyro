// Jobbets status for brugeren, ansvarlige medarbejdere og jobbets egen historik.
//
// jobs.status ('aktiv', 'afsluttet', 'annulleret') styrer lagermotoren. jobs.stage er den status,
// brugeren ser: Kladde, Planlagt, I gang, Afventer materialer, Afsluttet og Annulleret. Systemet
// sætter selv "Afventer materialer", når noget af behovet mangler, og sætter den tilbage, når
// varerne er der; første registrering af forbrug eller timer sætter jobbet "I gang".

import type { JobRow, JobStage } from '../env';
import type { Actor } from './ledger';

export const STAGE_LABEL: Record<JobStage, string> = {
  kladde: 'Kladde',
  planlagt: 'Planlagt',
  i_gang: 'I gang',
  afventer: 'Afventer materialer',
  afsluttet: 'Afsluttet',
  annulleret: 'Annulleret',
};

export const STAGE_TAG: Record<JobStage, string> = {
  kladde: 'tag-off',
  planlagt: 'tag-ready',
  i_gang: 'tag-ordered',
  afventer: 'tag-low',
  afsluttet: 'tag-ok',
  annulleret: 'tag-off',
};

export const STAGES = Object.keys(STAGE_LABEL) as JobStage[];

export function isStage(s: unknown): s is JobStage {
  return typeof s === 'string' && s in STAGE_LABEL;
}

/** Varer, jobbet venter på (behov, der hverken er på lager, på arbejdsstedet eller modtaget). */
async function waitingCount(db: D1Database, jobId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM job_materials m WHERE m.job_id = ?1 AND m.planned > m.issued - m.returned + m.reserved + m.site_received - m.site_returned)
       + (SELECT COUNT(*) FROM job_items i JOIN purchase_lines l ON l.id = i.purchase_line_id
          WHERE i.job_id = ?1 AND i.product_id IS NULL AND l.cancelled = 0 AND l.received < l.qty) AS n`,
    )
    .bind(jobId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function hasActivity(db: D1Database, jobId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM job_materials WHERE job_id = ?1 AND (issued > 0 OR site_used > 0))
         OR EXISTS (SELECT 1 FROM job_items WHERE job_id = ?1 AND used_qty > 0)
         OR EXISTS (SELECT 1 FROM job_entries WHERE job_id = ?1 AND phase = 'faktisk' AND type = 'tid') AS n`,
    )
    .bind(jobId)
    .first<{ n: number }>();
  return !!row?.n;
}

/**
 * Opdaterer den automatiske del af jobbets status ud fra den aktuelle tilstand. Kan køres igen
 * når som helst. En status, brugeren selv har sat, ændres kun, når varer mangler eller forbrug
 * eller timer registreres.
 */
export async function syncStage(db: D1Database, jobId: number, now: number, actor?: Actor): Promise<void> {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<JobRow>();
  if (!job || job.status !== 'aktiv') return;
  const [waiting, active] = await Promise.all([waitingCount(db, jobId), hasActivity(db, jobId)]);
  let stage = job.stage;
  let prev = job.stage_prev;
  let auto = job.stage_auto;
  // Forbrug eller timer betyder, at jobbet er i gang
  if (active && (stage === 'kladde' || stage === 'planlagt')) stage = 'i_gang';
  if (active && stage === 'afventer' && (prev === 'kladde' || prev === 'planlagt')) prev = 'i_gang';
  // Reserveret eller sat på indkøb betyder, at en kladde er planlagt
  if (stage === 'kladde' && (await db.prepare('SELECT 1 FROM job_materials WHERE job_id = ? AND planned > 0 LIMIT 1').bind(jobId).first())) stage = 'planlagt';
  if (waiting > 0 && (stage === 'planlagt' || stage === 'i_gang')) {
    prev = stage;
    stage = 'afventer';
    auto = 1;
  } else if (waiting === 0 && stage === 'afventer' && auto) {
    stage = prev === 'i_gang' || prev === 'planlagt' ? prev : active ? 'i_gang' : 'planlagt';
    auto = 0;
    prev = '';
  }
  if (stage === job.stage && prev === job.stage_prev && auto === job.stage_auto) return;
  const stmts = [db.prepare('UPDATE jobs SET stage = ?, stage_prev = ?, stage_auto = ?, updated_at = ? WHERE id = ?').bind(stage, prev, auto, now, jobId)];
  if (stage !== job.stage) {
    const why = stage === 'afventer' ? 'der mangler materialer' : job.stage === 'afventer' ? 'materialerne er på plads' : 'der er registreret forbrug eller timer';
    stmts.push(logStmt(db, jobId, 'status', `Status ændret fra ${STAGE_LABEL[job.stage]} til ${STAGE_LABEL[stage]}, fordi ${why}.`, actor ?? { email: 'system', name: 'Systemet' }, now));
  }
  await db.batch(stmts);
}

export function logStmt(db: D1Database, jobId: number, kind: string, text: string, actor: Actor, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO job_log (job_id, kind, text, actor, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(jobId, kind, text.slice(0, 500), actor.email, actor.name, now);
}

export async function logJob(db: D1Database, jobId: number, kind: string, text: string, actor: Actor, now: number): Promise<void> {
  await logStmt(db, jobId, kind, text, actor, now).run();
}

export interface JobLogRow {
  id: number;
  job_id: number;
  kind: string;
  text: string;
  actor: string;
  actor_name: string;
  created_at: number;
}

export async function jobLog(db: D1Database, jobId: number, limit = 100): Promise<JobLogRow[]> {
  const { results } = await db.prepare('SELECT * FROM job_log WHERE job_id = ? ORDER BY id DESC LIMIT ?').bind(jobId, limit).all<JobLogRow>();
  return results;
}

/** Ansvarlige medarbejdere på jobbet (e-mail og navn). */
export async function jobStaff(db: D1Database, jobId: number): Promise<{ email: string; name: string }[]> {
  const { results } = await db
    .prepare('SELECT s.email, COALESCE(u.name, s.email) AS name FROM job_staff s LEFT JOIN users u ON u.email = s.email WHERE s.job_id = ? ORDER BY name COLLATE NOCASE')
    .bind(jobId)
    .all<{ email: string; name: string }>();
  return results;
}

export function staffStmts(db: D1Database, jobId: number, emails: string[]): D1PreparedStatement[] {
  return [db.prepare('DELETE FROM job_staff WHERE job_id = ?').bind(jobId), ...emails.map((e) => db.prepare('INSERT OR IGNORE INTO job_staff (job_id, email) VALUES (?, ?)').bind(jobId, e))];
}

/** Er brugeren ansvarlig på jobbet? */
export async function isOnJob(db: D1Database, jobId: number, email: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM job_staff WHERE job_id = ? AND email = ?').bind(jobId, email).first());
}
