// Arbejdstimer og øvrige omkostninger på et job.
//
//   Intern arbejdsomkostning = faktiske timer × intern timeomkostning
//   Arbejdsløn i prisoverslag = forventede timer × fakturerbar timepris
//   Arbejdsløn på faktura     = godkendte fakturerbare timer × aftalt timepris
//
// Den interne timeomkostning er én samlet sats pr. medarbejdertype (løn, pension, feriepenge m.m.);
// det er ikke et lønsystem. Interne omkostninger vises aldrig på prisoverslag eller faktura.

import type { JobEntryRow, JobRow, LabourTypeRow, User } from '../env';
import { lineAmount } from './format';
import type { Settings } from './settings';

export async function labourTypes(db: D1Database, opts: { activeOnly?: boolean } = {}): Promise<LabourTypeRow[]> {
  const { results } = await db.prepare(`SELECT * FROM labour_types ${opts.activeOnly ? 'WHERE active = 1' : ''} ORDER BY name COLLATE NOCASE`).all<LabourTypeRow>();
  return results;
}

export async function jobEntries(db: D1Database, jobId: number): Promise<JobEntryRow[]> {
  const { results } = await db.prepare('SELECT * FROM job_entries WHERE job_id = ? ORDER BY phase DESC, work_date, id').bind(jobId).all<JobEntryRow>();
  return results;
}

/** Timepris til slutkunden: jobbets aftalte, medarbejdertypens, ellers virksomhedens standard. */
export function billRate(job: Pick<JobRow, 'hour_rate'>, type: Pick<LabourTypeRow, 'bill_rate'> | null, s: Settings): number | null {
  return job.hour_rate ?? type?.bill_rate ?? (s.default_hour_rate > 0 ? s.default_hour_rate : null);
}

/** Intern timeomkostning: medarbejdertypens, ellers virksomhedens samlede standard. */
export function internalRate(type: Pick<LabourTypeRow, 'internal_cost'> | null, s: Settings): number | null {
  return type?.internal_cost ?? (s.default_internal_cost > 0 ? s.default_internal_cost : null);
}

export async function userType(db: D1Database, email: string): Promise<{ user: User | null; type: LabourTypeRow | null }> {
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
  const type = user?.labour_type_id ? await db.prepare('SELECT * FROM labour_types WHERE id = ?').bind(user.labour_type_id).first<LabourTypeRow>() : null;
  return { user, type };
}

export interface LabourSummary {
  expectedHours: number;
  expectedLabour: number;
  expectedOther: number;
  actualHours: number;
  approvedHours: number;
  pendingHours: number;
  /** Intern arbejdsomkostning for de faktiske timer (null = mangler opsætning på nogle timer) */
  internalCost: number;
  internalMissing: number;
  billableLabour: number;
  actualOther: number;
  rateMissing: number;
}

export function summarizeEntries(entries: JobEntryRow[]): LabourSummary {
  const s: LabourSummary = {
    expectedHours: 0,
    expectedLabour: 0,
    expectedOther: 0,
    actualHours: 0,
    approvedHours: 0,
    pendingHours: 0,
    internalCost: 0,
    internalMissing: 0,
    billableLabour: 0,
    actualOther: 0,
    rateMissing: 0,
  };
  for (const e of entries) {
    if (e.phase === 'forventet') {
      if (e.type === 'tid') {
        s.expectedHours += e.qty;
        s.expectedLabour += lineAmount(e.unit_price, e.qty);
        if (e.unit_price === null) s.rateMissing++;
      } else if (e.billable) s.expectedOther += lineAmount(e.unit_price, e.qty);
      continue;
    }
    if (e.type === 'tid') {
      s.actualHours += e.qty;
      if (e.internal_cost === null) s.internalMissing++;
      else s.internalCost += lineAmount(e.internal_cost, e.qty);
      if (e.approved_at) s.approvedHours += e.qty;
      else s.pendingHours += e.qty;
      if (e.billable && e.approved_at) s.billableLabour += lineAmount(e.unit_price, e.qty);
    } else {
      if (e.internal_cost === null) s.internalMissing++;
      else s.internalCost += lineAmount(e.internal_cost, e.qty);
      if (e.billable) s.actualOther += lineAmount(e.unit_price, e.qty);
    }
  }
  return s;
}
