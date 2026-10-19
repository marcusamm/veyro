import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, Env } from './env';
import type { Settings } from './lib/settings';
import { randomToken } from './lib/crypto';
import { Conflict, Duplicate, RaceConflict, Tx, opToken, type Actor } from './lib/ledger';
import { syncStage } from './lib/jobs';
import { reconcileJob } from './lib/materials';
import { evaluateProducts } from './lib/notices';
import { canManage } from './lib/session';
import { layout, type H, type Nav } from './views/layout';

export function isDemo(c: Context<AppEnv>): boolean {
  return c.env.DEMO_MODE === '1';
}

export async function render(c: Context<AppEnv>, title: string, body: H, nav: Nav, status: ContentfulStatusCode = 200) {
  const session = c.get('session');
  let alertCount = 0;
  if (session && canManage(session.user)) {
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE open = 1").first<{ n: number }>();
    alertCount = row?.n ?? 0;
  }
  return c.html(
    layout({ title, settings: c.get('settings'), user: session?.user ?? null, csrf: c.get('csrf'), nav, alertCount, demo: isDemo(c) }, body),
    status,
  );
}

export function actorOf(c: Context<AppEnv>): Actor {
  const u = c.get('session')!.user;
  return { email: u.email, name: u.name };
}

/** Ny engangsnøgle til en formular. */
export function newOp(): string {
  return randomToken(18);
}

export type RunResult = { ok: true; tx: Tx } | { ok: false; duplicate: boolean; error: string };

/**
 * Gennemfører en registrering: bygger batchen ud fra friske tal, gemmer den, opdaterer
 * indkøbsbehov på berørte job og vurderer lageradvarsler. Er lageret ændret af en anden
 * registrering imens, bygges batchen igen (højst tre gange) med de nye tal.
 */
export async function runTx(
  c: Context<AppEnv>,
  kind: string,
  rawOp: unknown,
  build: (tx: Tx) => Promise<void> | void,
): Promise<RunResult> {
  const op = opToken(rawOp);
  if (!op) return { ok: false, duplicate: false, error: 'Formularen er udløbet. Genindlæs siden og prøv igen.' };
  return execTx(c.env, c.get('settings'), actorOf(c), kind, op, build);
}

/** Som runTx, men uden en forespørgsel (bruges også af demoen). op = null: ingen engangsnøgle. */
export async function execTx(
  env: Env,
  s: Settings,
  actor: Actor,
  kind: string,
  op: string | null,
  build: (tx: Tx) => Promise<void> | void,
  now?: number,
): Promise<RunResult> {
  let last: Tx | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = new Tx(env.DB, actor, op, now);
    try {
      await build(tx);
      await tx.commit(kind);
      last = tx;
      break;
    } catch (err) {
      if (err instanceof Duplicate) return { ok: false, duplicate: true, error: err.message };
      if (err instanceof RaceConflict && attempt < 2) continue;
      if (err instanceof Conflict) return { ok: false, duplicate: false, error: err.message };
      throw err;
    }
  }
  if (!last) return { ok: false, duplicate: false, error: 'Registreringen kunne ikke gennemføres. Prøv igen.' };
  await afterTx(env, s, last);
  return { ok: true, tx: last };
}

export async function afterTx(env: Env, s: Settings, tx: Tx): Promise<void> {
  for (const jobId of tx.jobs) {
    await reconcileJob(env.DB, jobId, tx.now);
    await syncStage(env.DB, jobId, tx.now, tx.actor);
  }
  await evaluateProducts(env, s, tx.products, tx.actor.email);
}

export async function afterChange(c: Context<AppEnv>, tx: Tx): Promise<void> {
  await afterTx(c.env, c.get('settings'), tx);
}

/** Tal fra en query-parameter (positivt heltal) eller null. */
export function idParam(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n > 0 ? n : null;
}
