import type { Env } from '../env';
import { sha256Hex } from './crypto';
import { parseAdminEmails } from './session';
import { getSettings } from './settings';

/**
 * Fælles kundekatalog (KV-navnerummet veyro-kundekatalog), som Kundelogin på kunde.veyro.dk slår op i
 * for at sende en bruger videre til sin virksomheds system.
 *
 * Nøgler:
 *   e:<sha256(email)>:<KATALOG_ID>  metadata { navn, url }, én pr. bruger med adgang
 *   kunde:<KATALOG_ID>              JSON med det, der sidst blev skrevet, så kun ændringer skrives
 *
 * E-mails gemmes kun som hash. Uden KATALOG-binding (demo, test, lokal udvikling) gøres intet.
 */
interface Snapshot {
  navn: string;
  url: string;
  hashes: string[];
}

export async function syncKatalog(env: Env): Promise<void> {
  const kv = env.KATALOG;
  const id = env.KATALOG_ID;
  if (!kv || !id) return;
  const url = (env.APP_URL ?? '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(url)) return;

  const { results } = await env.DB.prepare('SELECT email FROM users WHERE active = 1').all<{ email: string }>();
  const emails = new Set([...results.map((r) => r.email.toLowerCase()), ...parseAdminEmails(env)]);
  const hashes = [...new Set(await Promise.all([...emails].map((e) => sha256Hex(e))))].sort();
  const navn = (await getSettings(env.DB)).company_name;

  const indexKey = `kunde:${id}`;
  const before = await kv.get<Snapshot>(indexKey, 'json');
  const same = before && before.navn === navn && before.url === url;
  if (same && before.hashes.join() === hashes.join()) return;

  const old = new Set(before?.hashes ?? []);
  const keep = new Set(hashes);
  const metadata = { navn, url };
  await Promise.all([
    ...hashes.filter((h) => !same || !old.has(h)).map((h) => kv.put(`e:${h}:${id}`, '1', { metadata })),
    ...[...old].filter((h) => !keep.has(h)).map((h) => kv.delete(`e:${h}:${id}`)),
  ]);
  await kv.put(indexKey, JSON.stringify({ navn, url, hashes } satisfies Snapshot));
}

/** Kører én gang pr. isolate, så kataloget er opdateret kort efter hvert deploy. */
let synced = false;
export function syncKatalogOnce(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
  if (synced || !env.KATALOG) return;
  synced = true;
  ctx.waitUntil(syncKatalogLogged(env));
}

export function syncKatalogLogged(env: Env): Promise<void> {
  return syncKatalog(env).catch((e) => console.error('Kundekatalog fejlede:', (e as Error)?.message));
}
