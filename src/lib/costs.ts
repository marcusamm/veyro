// Intern registrering af tid og udgifter på kundeemner og kunder, og beregninger til kundekort og statistik.
// Kun for Veyro-administratorer. Intet her opretter fakturaer, ændrer abonnementer eller vises for kunden.
//
// Beregninger (alle beløb i øre ekskl. moms):
//   Tidsværdi = minutter / 60 × registreringens egen timesats (afrundes til hele øre på summen)
//   Samlet kalkuleret omkostning = tidsværdi + registrerede eksterne udgifter
// Forventede (endnu ikke registrerede) perioder af tilbagevendende udgifter vises særskilt og tælles ikke med.
import { nowSec } from './crypto';
import { addDays } from './stats';
import { isDay, today } from './prospects';

export const PURPOSES = ['salg', 'oprettelse', 'drift', 'udvikling'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_LABEL: Record<Purpose, string> = {
  salg: 'Undersøgelse og salgsarbejde',
  oprettelse: 'Oprettelse og implementering',
  drift: 'Løbende drift og support',
  udvikling: 'Ekstra udvikling og ændringer',
};
/** Kort navn i oversigter: kundetilgang, oprettelse, drift, udvikling */
export const PURPOSE_SHORT: Record<Purpose, string> = { salg: 'Kundetilgang', oprettelse: 'Oprettelse', drift: 'Løbende drift og support', udvikling: 'Ekstra udvikling' };

export const EXPENSE_TYPES = ['domaene', 'hosting', 'software', 'ekstern', 'materiale', 'andet'] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];
export const EXPENSE_TYPE_LABEL: Record<ExpenseType, string> = {
  domaene: 'Domæne',
  hosting: 'Hosting',
  software: 'Softwarelicens',
  ekstern: 'Ekstern hjælp',
  materiale: 'Købt materiale',
  andet: 'Andet',
};
export const INTERVALS = ['month', 'quarter', 'year'] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_LABEL: Record<Interval, string> = { month: 'Månedlig', quarter: 'Kvartalsvis', year: 'Årlig' };
const INTERVAL_MONTHS: Record<Interval, number> = { month: 1, quarter: 3, year: 12 };

export const DEFAULT_RATE = 29900; // 299 kr./time ekskl. moms

export type Subject = { kind: 'prospect'; id: number } | { kind: 'customer'; id: number };

export function parseSubject(raw: unknown): Subject | null {
  const m = typeof raw === 'string' ? /^(p|c):(\d{1,9})$/.exec(raw) : null;
  return m ? { kind: m[1] === 'p' ? 'prospect' : 'customer', id: Number(m[2]) } : null;
}
export const subjectKey = (s: Subject) => `${s.kind === 'prospect' ? 'p' : 'c'}:${s.id}`;
export const subjectUrl = (s: Subject) => (s.kind === 'prospect' ? `/admin/kundeemner/${s.id}` : `/admin/kunder/${s.id}`);

// ---------- Beløb ----------

/** "299", "299,50", "1.299,5" -> øre. Negative og tomme afvises. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/\s|kr\.?/gi, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d{1,2})?$/.test(s)) s = s.replace(',', '.');
  else if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [kr, ore = ''] = s.split('.');
  const v = Number(kr) * 100 + Number((ore + '00').slice(0, 2));
  return Number.isSafeInteger(v) && v > 0 && v < 1e11 ? v : null;
}

/** Tidsværdi i øre: minutter / 60 × sats, afrundet til nærmeste øre (halve op) */
export function timeValue(minutes: number, rate: number): number {
  return Math.round((minutes * rate) / 60);
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h} t. ${m} min.` : h ? `${h} t.` : `${m} min.`;
}

// ---------- Indstillinger ----------

export async function getDefaultRate(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM cost_settings WHERE key = 'hourly_rate'").first<{ value: string }>();
  const n = row ? Number(row.value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_RATE;
}

export async function setDefaultRate(db: D1Database, rate: number, actor: string): Promise<void> {
  const before = await getDefaultRate(db);
  const now = nowSec();
  await db.batch([
    db.prepare("INSERT INTO cost_settings (key, value, updated_at, updated_by) VALUES ('hourly_rate', ?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2, updated_by = ?3").bind(String(rate), now, actor),
    history(db, 'setting', 0, 'rettet', actor, { hourly_rate: before }, { hourly_rate: rate }),
  ]);
}

function history(db: D1Database, entity: string, id: number, action: 'oprettet' | 'rettet' | 'slettet', actor: string, before: unknown, after: unknown): D1PreparedStatement {
  return db
    .prepare('INSERT INTO cost_history (entity, entity_id, action, at, actor, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(entity, id, action, nowSec(), actor, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
}

// ---------- Rækker ----------

export interface TimeRow {
  id: number;
  prospect_id: number | null;
  customer_id: number | null;
  subject_label: string | null;
  work_date: string;
  staff: string;
  minutes: number;
  category: Purpose;
  description: string;
  rate: number;
  version: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string | null;
  deleted_at: number | null;
}

export interface ExpenseRow {
  id: number;
  prospect_id: number | null;
  customer_id: number | null;
  subject_label: string | null;
  shared: number;
  basis: string | null;
  spent_on: string;
  description: string;
  amount: number;
  type: ExpenseType;
  purpose: Purpose;
  supplier: string | null;
  recurring: number;
  interval: Interval | null;
  end_on: string | null;
  registered_by: string;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface PeriodRow {
  id: number;
  expense_id: number;
  period: string;
  amount: number;
  note: string | null;
  created_at: number;
  created_by: string;
}

export interface AllocationRow {
  id: number;
  expense_id: number;
  prospect_id: number | null;
  customer_id: number | null;
  subject_label: string | null;
  amount: number;
}

export interface HistoryRow {
  id: number;
  entity: string;
  entity_id: number;
  action: string;
  at: number;
  actor: string;
  before: string | null;
  after: string | null;
}

// ---------- Tid ----------

export interface TimeInput {
  work_date: string;
  staff: string;
  minutes: number;
  category: Purpose;
  description: string;
  rate: number;
}

export function readTimeForm(body: Record<string, unknown>, staff: string[], defaultRate: number): { input: TimeInput } | { error: string } {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  if (!isDay(s('work_date'))) return { error: 'Vælg datoen for arbejdet.' };
  const who = s('staff').toLowerCase();
  if (!staff.includes(who)) return { error: 'Vælg en medarbejder fra listen.' };
  const h = s('hours') ? Number(s('hours')) : 0;
  const m = s('minutes') ? Number(s('minutes')) : 0;
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || h > 24 || m > 59 * 60) return { error: 'Skriv timer og minutter som hele tal.' };
  const minutes = h * 60 + m;
  if (minutes <= 0) return { error: 'Registrér mindst ét minut.' };
  if (minutes > 1440) return { error: 'Én registrering kan højst være 24 timer.' };
  const category = s('category') as Purpose;
  if (!(PURPOSES as readonly string[]).includes(category)) return { error: 'Vælg en kategori.' };
  const description = s('description');
  if (!description) return { error: 'Skriv en kort beskrivelse af arbejdet.' };
  let rate = defaultRate;
  if (s('rate')) {
    const r = s('rate') === '0' ? 0 : parseAmount(s('rate'));
    if (r === null) return { error: 'Timesatsen skal være et beløb i kr., fx 299 eller 299,50.' };
    rate = r;
  }
  return { input: { work_date: s('work_date'), staff: who, minutes, category, description: description.slice(0, 1000), rate } };
}

function subjectCols(s: Subject): [number | null, number | null] {
  return s.kind === 'prospect' ? [s.id, null] : [null, s.id];
}

export async function addTime(db: D1Database, subject: Subject, t: TimeInput, actor: string, label: string): Promise<number> {
  const now = nowSec();
  const [pid, cid] = subjectCols(subject);
  const row = await db
    .prepare(
      `INSERT INTO time_entries (prospect_id, customer_id, subject_label, work_date, staff, minutes, category, description, rate, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(pid, cid, label, t.work_date, t.staff, t.minutes, t.category, t.description, t.rate, now, actor, now)
    .first<{ id: number }>();
  await history(db, 'time', row!.id, 'oprettet', actor, null, t).run();
  return row!.id;
}

export async function getTime(db: D1Database, id: number): Promise<TimeRow | null> {
  return db.prepare('SELECT * FROM time_entries WHERE id = ? AND deleted_at IS NULL').bind(id).first<TimeRow>();
}

const timeSnap = (r: TimeRow | TimeInput) => ({ work_date: r.work_date, staff: r.staff, minutes: r.minutes, category: r.category, description: r.description, rate: r.rate });

export async function updateTime(db: D1Database, r: TimeRow, t: TimeInput, version: number, actor: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE time_entries SET work_date = ?, staff = ?, minutes = ?, category = ?, description = ?, rate = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(t.work_date, t.staff, t.minutes, t.category, t.description, t.rate, nowSec(), actor, r.id, version)
    .run();
  if (!res.meta.changes) return false;
  await history(db, 'time', r.id, 'rettet', actor, timeSnap(r), t).run();
  return true;
}

export async function deleteTime(db: D1Database, r: TimeRow, actor: string): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare('UPDATE time_entries SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL').bind(now, actor, r.id),
    history(db, 'time', r.id, 'slettet', actor, timeSnap(r), null),
  ]);
}

// ---------- Udgifter ----------

export interface ExpenseInput {
  spent_on: string;
  description: string;
  amount: number;
  type: ExpenseType;
  purpose: Purpose;
  supplier: string | null;
  recurring: boolean;
  interval: Interval | null;
  end_on: string | null;
  registered_by: string;
}

export function readExpenseForm(body: Record<string, unknown>, staff: string[]): { input: ExpenseInput } | { error: string } {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  if (!isDay(s('spent_on'))) return { error: 'Vælg datoen (startdato for tilbagevendende udgifter).' };
  const description = s('description');
  if (!description) return { error: 'Skriv hvad udgiften dækker.' };
  const amount = parseAmount(s('amount'));
  if (!amount) return { error: 'Skriv beløbet i kr. ekskl. moms, fx 50 eller 129,95.' };
  const type = s('type') as ExpenseType;
  if (!(EXPENSE_TYPES as readonly string[]).includes(type)) return { error: 'Vælg en type.' };
  const purpose = s('purpose') as Purpose;
  if (!(PURPOSES as readonly string[]).includes(purpose)) return { error: 'Vælg formålet med udgiften.' };
  const who = s('registered_by').toLowerCase();
  if (!staff.includes(who)) return { error: 'Vælg hvem der registrerer udgiften.' };
  const recurring = s('recurring') === '1';
  const interval = recurring ? (s('interval') as Interval) : null;
  if (recurring && !(INTERVALS as readonly string[]).includes(interval ?? '')) return { error: 'Vælg interval for den tilbagevendende udgift.' };
  const end = recurring && s('end_on') ? s('end_on') : null;
  if (end && (!isDay(end) || end < s('spent_on'))) return { error: 'Slutdatoen skal ligge efter startdatoen.' };
  return {
    input: { spent_on: s('spent_on'), description: description.slice(0, 500), amount, type, purpose, supplier: s('supplier').slice(0, 150) || null, recurring, interval, end_on: end, registered_by: who },
  };
}

export async function addExpense(db: D1Database, subject: Subject | null, e: ExpenseInput, actor: string, label: string | null, basis: string | null): Promise<number> {
  const now = nowSec();
  const [pid, cid] = subject ? subjectCols(subject) : [null, null];
  const row = await db
    .prepare(
      `INSERT INTO expenses (prospect_id, customer_id, subject_label, shared, basis, spent_on, description, amount, type, purpose, supplier, recurring, interval, end_on, registered_by, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(pid, cid, label, subject ? 0 : 1, basis, e.spent_on, e.description, e.amount, e.type, e.purpose, e.supplier, e.recurring ? 1 : 0, e.interval, e.end_on, e.registered_by, now, now, actor)
    .first<{ id: number }>();
  await history(db, 'expense', row!.id, 'oprettet', actor, null, e).run();
  return row!.id;
}

export async function getExpense(db: D1Database, id: number): Promise<ExpenseRow | null> {
  return db.prepare('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL').bind(id).first<ExpenseRow>();
}

const expSnap = (r: ExpenseRow) => ({ spent_on: r.spent_on, description: r.description, amount: r.amount, type: r.type, purpose: r.purpose, supplier: r.supplier, recurring: !!r.recurring, interval: r.interval, end_on: r.end_on, registered_by: r.registered_by });

export async function updateExpense(db: D1Database, r: ExpenseRow, e: ExpenseInput, version: number, actor: string): Promise<'ok' | 'conflict' | 'allocations'> {
  if (r.shared) {
    const sum = await allocatedSum(db, r.id);
    if (sum > e.amount) return 'allocations';
  }
  const res = await db
    .prepare(
      `UPDATE expenses SET spent_on = ?, description = ?, amount = ?, type = ?, purpose = ?, supplier = ?, recurring = ?, interval = ?, end_on = ?, registered_by = ?,
         version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(e.spent_on, e.description, e.amount, e.type, e.purpose, e.supplier, e.recurring ? 1 : 0, e.interval, e.end_on, e.registered_by, nowSec(), actor, r.id, version)
    .run();
  if (!res.meta.changes) return 'conflict';
  await history(db, 'expense', r.id, 'rettet', actor, expSnap(r), e).run();
  return 'ok';
}

export async function deleteExpense(db: D1Database, r: ExpenseRow, actor: string): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare('UPDATE expenses SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL').bind(now, actor, r.id),
    history(db, 'expense', r.id, 'slettet', actor, expSnap(r), null),
  ]);
}

/** Periodernes startdatoer for en tilbagevendende udgift fra start til og med `until` (højst 240) */
export function periodStarts(e: Pick<ExpenseRow, 'spent_on' | 'interval' | 'end_on'>, until: string): string[] {
  const step = INTERVAL_MONTHS[e.interval ?? 'month'];
  const [y, m, d] = e.spent_on.split('-').map(Number);
  const last = e.end_on && e.end_on < until ? e.end_on : until;
  const out: string[] = [];
  for (let i = 0; out.length < 240; i++) {
    // Samme dag i måneden; findes dagen ikke (fx 31.), bruges månedens sidste dag
    const target = new Date(Date.UTC(y!, m! - 1 + i * step, 1));
    const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const day = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d!, dim))).toISOString().slice(0, 10);
    if (day > last) break;
    out.push(day);
  }
  return out;
}

/** Registrerer en periode som faktisk afholdt. Én registrering pr. periode; en gentagelse ignoreres. */
export async function registerPeriod(db: D1Database, e: ExpenseRow, period: string, amount: number, note: string | null, actor: string): Promise<'ok' | 'exists' | 'invalid'> {
  if (!e.recurring || !periodStarts(e, '2100-01-01').includes(period)) return 'invalid';
  if (e.shared && (await allocatedSum(db, e.id)) > amount) return 'invalid';
  const row = await db
    .prepare('INSERT INTO expense_periods (expense_id, period, amount, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(expense_id, period) DO NOTHING RETURNING id')
    .bind(e.id, period, amount, note, nowSec(), actor)
    .first<{ id: number }>();
  if (!row) return 'exists';
  await history(db, 'period', row.id, 'oprettet', actor, null, { expense_id: e.id, period, amount, note }).run();
  return 'ok';
}

export async function deletePeriod(db: D1Database, id: number, actor: string): Promise<boolean> {
  const row = await db.prepare('SELECT * FROM expense_periods WHERE id = ?').bind(id).first<PeriodRow>();
  if (!row) return false;
  await db.batch([db.prepare('DELETE FROM expense_periods WHERE id = ?').bind(id), history(db, 'period', id, 'slettet', actor, row, null)]);
  return true;
}

export async function allocatedSum(db: D1Database, expenseId: number): Promise<number> {
  const r = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM expense_allocations WHERE expense_id = ?').bind(expenseId).first<{ s: number }>();
  return r?.s ?? 0;
}

/** Fordeler en del af en fælles udgift på et kundeemne eller en kunde. Summen må ikke overstige udgiften. */
export async function addAllocation(db: D1Database, e: ExpenseRow, subject: Subject, amount: number, label: string, actor: string): Promise<'ok' | 'over' | 'invalid'> {
  if (!e.shared) return 'invalid';
  const [pid, cid] = subjectCols(subject);
  // Atomisk kontrol: indsættes kun, hvis den nye sum ikke overstiger udgiftens beløb
  const row = await db
    .prepare(
      `INSERT INTO expense_allocations (expense_id, prospect_id, customer_id, subject_label, amount, created_at, created_by)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE (SELECT COALESCE(SUM(amount), 0) FROM expense_allocations WHERE expense_id = ?1) + ?5 <= (SELECT amount FROM expenses WHERE id = ?1)
       RETURNING id`,
    )
    .bind(e.id, pid, cid, label, amount, nowSec(), actor)
    .first<{ id: number }>();
  if (!row) return 'over';
  await history(db, 'allocation', row.id, 'oprettet', actor, null, { expense_id: e.id, subject: subjectKey(subject), amount }).run();
  return 'ok';
}

export async function deleteAllocation(db: D1Database, id: number, actor: string): Promise<boolean> {
  const row = await db.prepare('SELECT * FROM expense_allocations WHERE id = ?').bind(id).first<AllocationRow>();
  if (!row) return false;
  await db.batch([db.prepare('DELETE FROM expense_allocations WHERE id = ?').bind(id), history(db, 'allocation', id, 'slettet', actor, row, null)]);
  return true;
}

export async function listSharedExpenses(db: D1Database): Promise<(ExpenseRow & { allocated: number })[]> {
  return (
    (await db
      .prepare('SELECT e.*, (SELECT COALESCE(SUM(a.amount), 0) FROM expense_allocations a WHERE a.expense_id = e.id) AS allocated FROM expenses e WHERE e.shared = 1 AND e.deleted_at IS NULL ORDER BY e.spent_on DESC LIMIT 200')
      .all<ExpenseRow & { allocated: number }>()).results ?? []
  );
}

export async function listAllocations(db: D1Database, expenseId: number): Promise<(AllocationRow & { name: string | null })[]> {
  return (
    (await db
      .prepare(
        `SELECT a.*, COALESCE(p.company, c.company, c.name, c.email, a.subject_label) AS name FROM expense_allocations a
         LEFT JOIN prospects p ON p.id = a.prospect_id LEFT JOIN customers c ON c.id = a.customer_id WHERE a.expense_id = ? ORDER BY a.id`,
      )
      .bind(expenseId)
      .all<AllocationRow & { name: string | null }>()).results ?? []
  );
}

// ---------- Beregning ----------

export interface CostFilter {
  from: string | null; // YYYY-MM-DD inkl.
  to: string | null; // YYYY-MM-DD inkl.
  staff: string | null;
  purpose: Purpose | null;
  subject: Subject | null;
}

/** En faktisk registreret udgiftspost (engangs, registreret periode eller andel af fælles udgift) */
export interface CostLine {
  expense_id: number;
  date: string;
  description: string;
  amount: number;
  purpose: Purpose;
  type: ExpenseType;
  supplier: string | null;
  registered_by: string;
  prospect_id: number | null;
  customer_id: number | null;
  label: string | null;
  shared: boolean;
  basis: string | null;
  period_id: number | null;
}

/** En forventet, endnu ikke registreret periode af en tilbagevendende udgift */
export interface ExpectedLine {
  expense_id: number;
  period: string;
  description: string;
  amount: number;
}

export interface Bucket {
  minutes: number;
  timeValue: number;
  expenses: number;
  total: number;
}
const emptyBucket = (): Bucket => ({ minutes: 0, timeValue: 0, expenses: 0, total: 0 });

export interface CostSummary {
  time: (TimeRow & { value: number })[];
  lines: CostLine[];
  expected: ExpectedLine[];
  expenses: ExpenseRow[];
  totals: Bucket;
  byPurpose: Record<Purpose, Bucket>;
  byStaff: Record<string, Bucket>;
}

/** WHERE-led for poster på et emne/en kunde. En kunde omfatter også kundeemner, der er knyttet til den (ingen kopiering). */
function subjectWhere(s: Subject | null, alias: string): { sql: string; args: unknown[] } {
  if (!s) return { sql: '1 = 1', args: [] };
  if (s.kind === 'prospect') return { sql: `${alias}.prospect_id = ?`, args: [s.id] };
  return { sql: `(${alias}.customer_id = ? OR ${alias}.prospect_id IN (SELECT id FROM prospects WHERE customer_id = ?))`, args: [s.id, s.id] };
}

function inRange(day: string, f: CostFilter): boolean {
  return (!f.from || day >= f.from) && (!f.to || day <= f.to);
}

/** Samler tid og udgifter for filtret. Hver post tælles én gang. */
export async function summarize(db: D1Database, f: CostFilter, opts: { now?: number } = {}): Promise<CostSummary> {
  const t = subjectWhere(f.subject, 't');
  const e = subjectWhere(f.subject, 'e');
  const a = subjectWhere(f.subject, 'a');
  const tArgs: unknown[] = [...t.args];
  let tSql = `SELECT t.* FROM time_entries t WHERE t.deleted_at IS NULL AND ${t.sql}`;
  if (f.from) (tSql += ' AND t.work_date >= ?'), tArgs.push(f.from);
  if (f.to) (tSql += ' AND t.work_date <= ?'), tArgs.push(f.to);
  if (f.staff) (tSql += ' AND t.staff = ?'), tArgs.push(f.staff);
  if (f.purpose) (tSql += ' AND t.category = ?'), tArgs.push(f.purpose);
  tSql += ' ORDER BY t.work_date DESC, t.id DESC LIMIT 5000';
  const [timeRes, expRes, perRes, allocRes] = await db.batch([
    db.prepare(tSql).bind(...tArgs),
    db.prepare(`SELECT e.* FROM expenses e WHERE e.deleted_at IS NULL AND e.shared = 0 AND ${e.sql} ORDER BY e.spent_on DESC LIMIT 2000`).bind(...e.args),
    db.prepare(`SELECT p.* FROM expense_periods p JOIN expenses e ON e.id = p.expense_id WHERE e.deleted_at IS NULL LIMIT 20000`),
    db
      .prepare(
        `SELECT a.*, e.amount AS expense_amount FROM expense_allocations a JOIN expenses e ON e.id = a.expense_id
         WHERE e.deleted_at IS NULL AND ${a.sql} LIMIT 5000`,
      )
      .bind(...a.args),
  ]);
  const time = ((timeRes?.results ?? []) as TimeRow[]).map((r) => ({ ...r, value: timeValue(r.minutes, r.rate) }));
  const own = (expRes?.results ?? []) as ExpenseRow[];
  const periods = (perRes?.results ?? []) as PeriodRow[];
  const allocs = (allocRes?.results ?? []) as (AllocationRow & { expense_amount: number })[];
  const sharedIds = [...new Set(allocs.map((x) => x.expense_id))];
  const shared = sharedIds.length
    ? (((await db.prepare(`SELECT * FROM expenses WHERE id IN (${sharedIds.map(() => '?').join(',')})`).bind(...sharedIds).all<ExpenseRow>()).results ?? []) as ExpenseRow[])
    : [];
  const sharedById = new Map(shared.map((x) => [x.id, x]));
  const periodsBy = new Map<number, PeriodRow[]>();
  for (const p of periods) periodsBy.set(p.expense_id, [...(periodsBy.get(p.expense_id) ?? []), p]);
  const todayStr = today(opts.now);
  const lines: CostLine[] = [];
  const expected: ExpectedLine[] = [];

  const occurrences = (x: ExpenseRow): { date: string; amount: number; period_id: number | null }[] =>
    x.recurring ? (periodsBy.get(x.id) ?? []).map((p) => ({ date: p.period, amount: p.amount, period_id: p.id })) : [{ date: x.spent_on, amount: x.amount, period_id: null }];

  const base = (x: ExpenseRow) => ({
    expense_id: x.id, description: x.description, purpose: x.purpose, type: x.type, supplier: x.supplier, registered_by: x.registered_by, basis: x.basis,
  });
  const keep = (x: ExpenseRow) => (!f.purpose || x.purpose === f.purpose) && (!f.staff || x.registered_by === f.staff);

  for (const x of own) {
    if (!keep(x)) continue;
    for (const o of occurrences(x)) {
      if (inRange(o.date, f)) lines.push({ ...base(x), date: o.date, amount: o.amount, prospect_id: x.prospect_id, customer_id: x.customer_id, label: x.subject_label, shared: false, period_id: o.period_id });
    }
    if (x.recurring) {
      const done = new Set((periodsBy.get(x.id) ?? []).map((p) => p.period));
      const until = f.to && f.to < todayStr ? f.to : todayStr;
      for (const d of periodStarts(x, until)) if (!done.has(d) && inRange(d, f)) expected.push({ expense_id: x.id, period: d, description: x.description, amount: x.amount });
    }
  }
  for (const al of allocs) {
    const x = sharedById.get(al.expense_id);
    if (!x || !keep(x)) continue;
    for (const o of occurrences(x)) {
      if (!inRange(o.date, f)) continue;
      // Andel af den faktisk registrerede post; rundes ned, så fordelingen aldrig overstiger udgiften
      const amount = x.amount === o.amount ? al.amount : Math.floor((o.amount * al.amount) / x.amount);
      if (amount > 0) lines.push({ ...base(x), date: o.date, amount, prospect_id: al.prospect_id, customer_id: al.customer_id, label: al.subject_label, shared: true, period_id: o.period_id });
    }
  }
  // Uden emne/kunde i filtret: fælles udgifter tælles med deres fulde beløb (ikke andelene), så intet tælles dobbelt
  if (!f.subject) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.shared) lines.splice(i, 1);
    const all = (await db.prepare('SELECT * FROM expenses WHERE shared = 1 AND deleted_at IS NULL LIMIT 2000').all<ExpenseRow>()).results ?? [];
    for (const x of all) {
      if (!keep(x)) continue;
      for (const o of occurrences(x)) if (inRange(o.date, f)) lines.push({ ...base(x), date: o.date, amount: o.amount, prospect_id: null, customer_id: null, label: 'Fælles udgift', shared: true, period_id: o.period_id });
    }
  }
  lines.sort((p, q) => (p.date < q.date ? 1 : p.date > q.date ? -1 : 0));
  expected.sort((p, q) => (p.period < q.period ? -1 : 1));

  const byPurpose = Object.fromEntries(PURPOSES.map((k) => [k, emptyBucket()])) as Record<Purpose, Bucket>;
  const byStaff: Record<string, Bucket> = {};
  // Tidsværdien summeres som minutter × sats og afrundes først til sidst
  const exact = { all: 0, purpose: {} as Record<string, number>, staff: {} as Record<string, number> };
  const totals = emptyBucket();
  for (const r of time) {
    const v = r.minutes * r.rate;
    exact.all += v;
    exact.purpose[r.category] = (exact.purpose[r.category] ?? 0) + v;
    exact.staff[r.staff] = (exact.staff[r.staff] ?? 0) + v;
    totals.minutes += r.minutes;
    byPurpose[r.category].minutes += r.minutes;
    (byStaff[r.staff] ??= emptyBucket()).minutes += r.minutes;
  }
  totals.timeValue = Math.round(exact.all / 60);
  for (const k of PURPOSES) byPurpose[k].timeValue = Math.round((exact.purpose[k] ?? 0) / 60);
  for (const [k, v] of Object.entries(exact.staff)) byStaff[k]!.timeValue = Math.round(v / 60);
  for (const l of lines) {
    totals.expenses += l.amount;
    byPurpose[l.purpose].expenses += l.amount;
    (byStaff[l.registered_by] ??= emptyBucket()).expenses += l.amount;
  }
  totals.total = totals.timeValue + totals.expenses;
  for (const b of [...Object.values(byPurpose), ...Object.values(byStaff)]) b.total = b.timeValue + b.expenses;
  const expenses = [...own, ...shared.filter((x) => !own.some((o) => o.id === x.id))];
  return { time, lines, expected, expenses, totals, byPurpose, byStaff };
}

export async function costHistory(db: D1Database, subject: Subject, limit = 100): Promise<(HistoryRow & { label: string })[]> {
  const t = subjectWhere(subject, 't');
  const e = subjectWhere(subject, 'e');
  const rows = await db
    .prepare(
      `SELECT h.*, t.description AS label FROM cost_history h JOIN time_entries t ON h.entity = 'time' AND t.id = h.entity_id WHERE ${t.sql}
       UNION ALL
       SELECT h.*, e.description AS label FROM cost_history h JOIN expenses e ON h.entity = 'expense' AND e.id = h.entity_id WHERE ${e.sql}
       UNION ALL
       SELECT h.*, e.description AS label FROM cost_history h JOIN expense_periods p ON h.entity = 'period' AND p.id = h.entity_id JOIN expenses e ON e.id = p.expense_id WHERE ${e.sql}
       ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .bind(...t.args, ...e.args, ...e.args, limit)
    .all<HistoryRow & { label: string }>();
  return rows.results ?? [];
}

/** Standardperioder til filtrene: denne måned, sidste 30/90/365 dage, alt */
export function periodRange(key: string | undefined, from: string | undefined, to: string | undefined, now = nowSec()): { key: string; from: string | null; to: string | null } {
  const t = today(now);
  if (key === 'egen' && (isDay(from) || isDay(to))) return { key, from: isDay(from) ? from : null, to: isDay(to) ? to : null };
  if (key === 'maaned') return { key, from: t.slice(0, 8) + '01', to: t };
  if (key === '30' || key === '90' || key === '365') return { key, from: addDays(t, -(Number(key) - 1)), to: t };
  if (key === 'aar') return { key, from: t.slice(0, 5) + '01-01', to: t };
  return { key: 'alt', from: null, to: null };
}
