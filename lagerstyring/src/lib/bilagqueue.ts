// One queue object belongs to one company's Worker and D1. Originals never
// leave the existing file store except for the private OCR service request.
import type { Env } from '../env';
import { eventStmt, getBilag, readBilag, type ReadBilagResult } from './bilag';
import type { Actor } from './ledger';
import { getSettings, type Settings } from './settings';

const OBJECT_NAME = 'bilag-ocr';
const LEASE_SECONDS = 180;
const RETRY_SECONDS = 30;
const MAX_ATTEMPTS = 2;
const nowSec = () => Math.floor(Date.now() / 1000);

export interface OcrJob {
  bilag_id: number;
  token: string;
  data_revision: number;
  state: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  actor: string;
  actor_name: string;
  queued_at: number;
  available_at: number;
  started_at: number | null;
  lease_until: number | null;
  finished_at: number | null;
  last_error: string;
}

export async function ocrJob(db: D1Database, bilagId: number): Promise<OcrJob | null> {
  const job = await db.prepare('SELECT * FROM bilag_ocr_jobs WHERE bilag_id = ?').bind(bilagId).first<OcrJob>();
  if (job && ['queued', 'processing'].includes(job.state)) {
    const b = await getBilag(db, bilagId);
    if (!b || b.reading_token !== job.token || b.data_revision !== job.data_revision) return { ...job, state: 'cancelled', last_error: 'Aflæsningen er afbrudt, fordi bilaget er ændret.' };
  }
  return job;
}

/** Text PDFs remain immediate; image/scanned OCR is durable and never delays upload. */
export async function requestBilagRead(env: Env, settings: Settings, id: number, actor: Actor, now: number): Promise<ReadBilagResult> {
  const existing = await ocrJob(env.DB, id);
  if (!existing || !['queued', 'processing'].includes(existing.state)) {
    const result = await readBilag(env, settings, id, actor, now, { deferOcr: true });
    if (!result.needsOcr) return result;
  }
  if (!env.BILAG_OCR_QUEUE) {
    const message = 'OCR-køen er ikke tilsluttet. Originalen er gemt; registrér oplysningerne manuelt.';
    await env.DB.prepare('UPDATE bilag SET reading_note = ? WHERE id = ?').bind(message, id).run();
    return { ok: false, message };
  }
  try {
    const response = await env.BILAG_OCR_QUEUE.getByName(OBJECT_NAME).fetch(new Request('https://bilag-ocr.internal/enqueue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, actor }),
    }));
    const data = await response.json() as ReadBilagResult;
    return data && typeof data.message === 'string' && typeof data.ok === 'boolean' ? data : { ok: false, message: 'OCR-køen svarede ikke korrekt. Originalen er gemt; prøv Aflæs igen senere.' };
  } catch {
    return { ok: false, message: 'OCR-køen kunne ikke kontaktes. Originalen er gemt; prøv Aflæs igen senere eller registrér oplysningerne manuelt.' };
  }
}

/** Idempotently recover a committed queue whose alarm setup was interrupted. */
export async function wakeOcrQueue(env: Env): Promise<void> {
  if (!env.RECEIPT_OCR || !env.BILAG_OCR_QUEUE) return;
  try {
    await env.BILAG_OCR_QUEUE.getByName(OBJECT_NAME).fetch(new Request('https://bilag-ocr.internal/wake', { method: 'POST' }));
  } catch { /* The durable D1 jobs remain recoverable on the next view/cron. */ }
}

export async function enqueueOcr(db: D1Database, id: number, actor: Actor, now: number): Promise<ReadBilagResult> {
  const b = await getBilag(db, id);
  if (!b || ['godkendt', 'arkiveret'].includes(b.status)) return { ok: false, message: 'Godkendte eller arkiverede bilag aflæses ikke igen.' };
  if (await db.prepare('SELECT 1 FROM bilag_allocations WHERE bilag_id = ? LIMIT 1').bind(id).first()) return { ok: false, message: 'Bilaget er allerede fordelt. Ret oplysningerne manuelt.' };
  const old = await ocrJob(db, id);
  if (old && ['queued', 'processing'].includes(old.state)) return { ok: true, message: 'Bilaget er allerede i OCR-køen. Originalen er gemt.' };
  const token = crypto.randomUUID();
  const message = 'Originalen er gemt. Bilaget er i kø til OCR og aflæses automatisk i baggrunden. Kontrollér forslagene, når aflæsningen er færdig.';
  try {
    await db.batch([
      db.prepare(`UPDATE bilag SET reading_token = CASE WHEN data_revision = ? AND reading_token = ?
        AND status NOT IN ('godkendt','arkiveret') AND NOT EXISTS (SELECT 1 FROM bilag_allocations WHERE bilag_id = ?)
        THEN ? ELSE NULL END, status = 'under_aflaesning', reading_note = ?, updated_at = ? WHERE id = ?`).bind(b.data_revision, b.reading_token, id, token, message, now, id),
      db.prepare(`INSERT INTO bilag_ocr_jobs (bilag_id,token,data_revision,state,attempts,actor,actor_name,queued_at,available_at)
        VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)
        ON CONFLICT(bilag_id) DO UPDATE SET token=excluded.token,data_revision=excluded.data_revision,state='queued',attempts=0,
          actor=excluded.actor,actor_name=excluded.actor_name,queued_at=excluded.queued_at,available_at=excluded.available_at,
          started_at=NULL,lease_until=NULL,finished_at=NULL,last_error=''`).bind(id, token, b.data_revision, actor.email, actor.name, now, now),
      eventStmt(db, id, b.version, 'ocr_koe', message, actor, now),
    ]);
  } catch (error) {
    if (String((error as Error)?.message).includes('bilag.reading_token')) return { ok: false, cancelled: true, message: 'Bilaget er ændret imens. Genindlæs siden.' };
    throw error;
  }
  return { ok: true, message };
}

/** Process at most one file per alarm. A lease safely recovers an interrupted alarm. */
export async function processNextOcr(env: Env, now = nowSec()): Promise<boolean> {
  const db = env.DB;
  // A terminated request cannot keep a document locked forever. At most two
  // OCR attempts are allowed, including interrupted/expired leases.
  const expired = await db.prepare("SELECT * FROM bilag_ocr_jobs WHERE state='processing' AND lease_until <= ? ORDER BY queued_at LIMIT 1").bind(now).first<OcrJob>();
  if (expired) await finishOcr(db, expired, expired.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', 'OCR-behandlingen blev afbrudt. Prøv igen senere, eller registrér oplysningerne manuelt.', now);
  const job = await db.prepare("SELECT * FROM bilag_ocr_jobs WHERE state='queued' AND available_at <= ? ORDER BY queued_at,bilag_id LIMIT 1").bind(now).first<OcrJob>();
  if (!job) return false;
  const b = await getBilag(db, job.bilag_id);
  if (!b || b.reading_token !== job.token || b.data_revision !== job.data_revision || ['godkendt', 'arkiveret'].includes(b.status)
    || await db.prepare('SELECT 1 FROM bilag_allocations WHERE bilag_id = ? LIMIT 1').bind(job.bilag_id).first()) {
    await finishOcr(db, job, 'cancelled', 'Aflæsningen er afbrudt, fordi bilaget er ændret eller fordelt.', now);
    return true;
  }
  const claimed = await db.prepare(`UPDATE bilag_ocr_jobs SET state='processing',attempts=attempts+1,started_at=?,lease_until=?
    WHERE bilag_id=? AND token=? AND state='queued' AND attempts < ? RETURNING bilag_id`).bind(now, now + LEASE_SECONDS, job.bilag_id, job.token, MAX_ATTEMPTS).first();
  if (!claimed) return false;
  let result: ReadBilagResult;
  try {
    result = await readBilag(env, await getSettings(db), job.bilag_id, { email: job.actor, name: job.actor_name }, now, { backgroundToken: job.token });
  } catch {
    result = { ok: false, message: 'OCR kunne ikke behandle bilaget. Originalen er bevaret; prøv igen senere eller registrér oplysningerne manuelt.', retryable: true };
  }
  const finished = nowSec();
  await finishOcr(db, { ...job, attempts: job.attempts + 1 }, result.ok ? 'done' : result.cancelled ? 'cancelled' : result.retryable && job.attempts + 1 < MAX_ATTEMPTS ? 'retry' : 'failed', result.message, finished);
  return true;
}

async function finishOcr(db: D1Database, job: OcrJob, state: OcrJob['state'] | 'retry', message: string, now: number): Promise<void> {
  const retry = state === 'retry';
  const b = await getBilag(db, job.bilag_id);
  const current = b?.reading_token === job.token && b.data_revision === job.data_revision;
  // A failed provider result may have arrived after a manual edit. Such a job
  // is cancelled, never retried with the user's changed data.
  if (retry && !current) state = 'cancelled';
  const keepToken = state === 'retry';
  const statements = [db.prepare(`UPDATE bilag_ocr_jobs SET state=?,available_at=?,lease_until=NULL,finished_at=?,last_error=?
    WHERE bilag_id=? AND token=?`).bind(keepToken ? 'queued' : state, keepToken ? now + RETRY_SECONDS : now, keepToken ? null : now, state === 'done' ? '' : message.slice(0, 600), job.bilag_id, job.token)];
  if (state !== 'done' && !keepToken && b && current) {
    statements.push(db.prepare(`UPDATE bilag SET reading_token='',status='modtaget',reading_note=?,updated_at=?
      WHERE id=? AND reading_token=? AND data_revision=? AND status='under_aflaesning'`).bind(message.slice(0, 600), now, job.bilag_id, job.token, job.data_revision));
  } else if (state === 'cancelled' && b && !b.reading_token && b.status === 'under_aflaesning') {
    statements.push(db.prepare(`UPDATE bilag SET status='modtaget',reading_note=?,updated_at=? WHERE id=? AND reading_token='' AND status='under_aflaesning'
      AND EXISTS (SELECT 1 FROM bilag_ocr_jobs WHERE bilag_id=? AND token=?)`).bind(message.slice(0, 600), now, job.bilag_id, job.bilag_id, job.token));
  }
  if (b && state !== 'done') statements.push(eventStmt(db, b.id, b.version, keepToken ? 'ocr_proev_igen' : 'ocr_afsluttet', message.slice(0, 600), { email: job.actor, name: job.actor_name }, now));
  await db.batch(statements);
}

export class BilagOcrQueue {
  private running = false;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/enqueue', '/wake'].includes(path)) return new Response('Not found', { status: 404 });
    if (!this.env.RECEIPT_OCR) return Response.json({ ok: false, message: 'OCR er ikke tilsluttet.' }, { status: 503 });
    if (path === '/wake') {
      const pending = await this.env.DB.prepare("SELECT 1 FROM bilag_ocr_jobs WHERE state IN ('queued','processing') LIMIT 1").first();
      if (pending && !this.running) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return Response.json({ ok: true });
    }
    if (Number(request.headers.get('content-length') || 0) > 2048) return new Response('Too large', { status: 413 });
    const body = await request.text();
    if (body.length > 2048) return new Response('Too large', { status: 413 });
    let data: { id?: unknown; actor?: Partial<Actor> };
    try { data = JSON.parse(body); } catch { return new Response('Bad request', { status: 400 }); }
    if (!Number.isSafeInteger(data.id) || Number(data.id) < 1 || typeof data.actor?.email !== 'string' || data.actor.email.length > 254 || typeof data.actor.name !== 'string' || data.actor.name.length > 200) return new Response('Bad request', { status: 400 });
    const result = await this.ctx.blockConcurrencyWhile(() => enqueueOcr(this.env.DB, Number(data.id), data.actor as Actor, nowSec()));
    if (result.ok && !this.running) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await processNextOcr(this.env); }
    finally {
      this.running = false;
      const next = await this.env.DB.prepare(`SELECT MIN(CASE WHEN state='processing' THEN lease_until ELSE available_at END) AS at
        FROM bilag_ocr_jobs WHERE state IN ('queued','processing')`).first<{ at: number | null }>();
      if (next?.at !== null && next?.at !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next.at * 1000));
    }
  }
}
