import type { Env } from '../env';
import { sha256Hex } from './crypto';

/** Et kundesystem, som en e-mail har adgang til (fra KV-navnerummet veyro-kundekatalog). */
export interface KundeSystem {
  navn: string;
  url: string;
}

/**
 * Slår e-mailen op i kundekataloget, som hver kundes lagerstyring selv holder opdateret
 * (se lagerstyring/src/lib/katalog.ts). Nøglerne er e:<sha256(email)>:<installation>.
 */
export async function findKundeSystemer(env: Env, email: string): Promise<KundeSystem[]> {
  if (!env.KATALOG) return [];
  try {
    const { keys } = await env.KATALOG.list<KundeSystem>({ prefix: `e:${await sha256Hex(email)}:` });
    return keys
      .map((k) => k.metadata)
      .filter((m): m is KundeSystem => !!m && typeof m.navn === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(m.url ?? ''))
      .sort((a, b) => a.navn.localeCompare(b.navn, 'da'));
  } catch (e) {
    // Kataloget må aldrig forhindre login i kundepanelet
    console.error('Kundekatalog fejlede:', (e as Error).message);
    return [];
  }
}

/** Systemets login-side med e-mailen udfyldt. */
export function systemLoginUrl(s: KundeSystem, email: string): string {
  return `${s.url}/login?email=${encodeURIComponent(email)}`;
}

/** Kundesystemer på veyro.dk kan nås med et direkte redirect (se form-action i src/index.ts). */
export function kanRedirecte(s: KundeSystem): boolean {
  return /^https:\/\/[a-z0-9-]+\.veyro\.dk$/.test(s.url);
}
