// Handelsbetingelser og databehandleraftale: hvilken version kunden har accepteret, hvornår og hvordan.
// Selve teksterne er sider på veyro.dk (site/content.json). Ændres en af dem væsentligt, skal LEGAL_VERSION
// ændres, så kunderne bliver bedt om at acceptere den nye version i kundepanelet.
import { sha256Hex } from './crypto';

export const LEGAL_VERSION = '2026-10-21';

export const LEGAL_DOCS = [
  { key: 'handelsbetingelser', title: 'Handels- og abonnementsbetingelser', url: 'https://veyro.dk/pages/handelsbetingelser' },
  { key: 'databehandleraftale', title: 'Databehandleraftale', url: 'https://veyro.dk/pages/databehandleraftale' },
] as const;

export type LegalDocKey = (typeof LEGAL_DOCS)[number]['key'];
export type AcceptContext = 'tilbud' | 'bestil' | 'kundepanel';

export interface Acceptance {
  document: LegalDocKey;
  version: string;
  accepted_at: number;
  context: AcceptContext;
}

/** Gemmer accept af alle dokumenter i den nuværende version. Kaldes kun, efter kunden har sat kryds. */
export async function recordAcceptance(
  db: D1Database,
  args: { email: string; customerId?: number | null; offerId?: number | null; context: AcceptContext; ip?: string | null },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ipHash = args.ip ? await sha256Hex(args.ip) : null;
  await db.batch(
    LEGAL_DOCS.map((d) =>
      db
        .prepare(
          `INSERT INTO agreement_acceptances (email, customer_id, offer_id, document, version, context, ip_hash, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(args.email.toLowerCase(), args.customerId ?? null, args.offerId ?? null, d.key, LEGAL_VERSION, args.context, ipHash, now),
    ),
  );
}

/** Seneste accept pr. dokument for en e-mail. */
export async function acceptancesFor(db: D1Database, email: string): Promise<Partial<Record<LegalDocKey, Acceptance>>> {
  const { results } = await db
    .prepare(
      `SELECT document, version, accepted_at, context FROM agreement_acceptances
       WHERE email = ? ORDER BY accepted_at DESC, id DESC`,
    )
    .bind(email.toLowerCase())
    .all<Acceptance>();
  const out: Partial<Record<LegalDocKey, Acceptance>> = {};
  for (const r of results ?? []) if (!out[r.document]) out[r.document] = r;
  return out;
}

export const isCurrent = (a: Partial<Record<LegalDocKey, Acceptance>>): boolean =>
  LEGAL_DOCS.every((d) => a[d.key]?.version === LEGAL_VERSION);
