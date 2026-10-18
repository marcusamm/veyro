import { StripeError } from './stripe';
import { nowSec } from './crypto';

export function describeError(err: unknown): string {
  return err instanceof StripeError ? `${err.status} ${err.code ?? ''} ${err.message}` : (err as Error)?.message ?? String(err);
}

/** Logger til konsollen og gemmer fejlen i error_log (D1), så den kan læses uden adgang til Cloudflare-loggen. */
export async function logError(db: D1Database, place: string, err: unknown): Promise<void> {
  const detail = describeError(err).slice(0, 500);
  console.error(`${place}:`, detail);
  try {
    await db.prepare('INSERT INTO error_log (at, place, detail) VALUES (?, ?, ?)').bind(nowSec(), place, detail).run();
    await db.prepare('DELETE FROM error_log WHERE at < ?').bind(nowSec() - 30 * 86400).run();
  } catch {
    // Fejlloggen må aldrig vælte selve anmodningen.
  }
}
