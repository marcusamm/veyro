// Handelsbetingelser og databehandleraftale: hvilken version kunden har accepteret, hvornår og hvordan.
// Teksterne ligger i site/content.json. Versioner følger hvert dokument særskilt.
// De nye kildekodevilkår gælder nye aftaler, ikke automatisk eksisterende aftaler.
import { sha256Hex } from './crypto';

export const LEGAL_VERSION = '2026-11-03';
export const DPA_VERSION = '2026-10-21';

export const LEGAL_DOCS = [
  { key: 'handelsbetingelser', version: LEGAL_VERSION, title: 'Handels- og abonnementsbetingelser', url: 'https://veyro.dk/pages/handelsbetingelser' },
  { key: 'databehandleraftale', version: DPA_VERSION, title: 'Databehandleraftale', url: 'https://veyro.dk/pages/databehandleraftale' },
] as const;

export type LegalDocKey = (typeof LEGAL_DOCS)[number]['key'];
export type LegalDocument = (typeof LEGAL_DOCS)[number];
export type AcceptContext = 'tilbud' | 'bestil' | 'kundepanel';

export interface Acceptance {
  document: LegalDocKey;
  version: string;
  accepted_at: number;
  context: AcceptContext;
}

/** En tidligere accepteret aftale fortsætter på sine eksisterende vilkår. */
export function acceptedVersionApplies(document: LegalDocument, version?: string): boolean {
  return version === document.version || (document.key === 'handelsbetingelser' && version === '2026-10-21');
}

/** Ukendte versioner får ingen opdigtet arkivadresse. UI markerer linket som den aktuelle tekst. */
export function legalDocumentUrl(document: LegalDocument, version?: string): string {
  return document.key === 'handelsbetingelser' && version === '2026-10-21'
    ? 'https://veyro.dk/pages/handelsbetingelser-2026-10-21'
    : document.url;
}

/** Gemmer accept af alle dokumenter i den nuværende version. Kaldes kun, efter kunden har sat kryds. */
export async function recordAcceptance(
  db: D1Database,
  args: { email: string; customerId?: number | null; offerId?: number | null; context: AcceptContext; ip?: string | null },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ipHash = args.ip ? await sha256Hex(args.ip) : null;
  // Kendte, fortsat gældende versioner bevares ved accept i kundepanelet.
  // Manglende/andre versioner kræver eksplicit accept af de viste dokumenter;
  // fremtidige dokumentopdateringer må ikke blive ignoreret permanent.
  // Nye tilbud/bestillinger accepterer alle viste aktuelle dokumenter.
  const existing = args.context === 'kundepanel' ? await acceptancesFor(db, args.email) : {};
  const documents = LEGAL_DOCS.filter(d => !acceptedVersionApplies(d, existing[d.key]?.version));
  if (!documents.length) return;
  await db.batch(
    documents.map((d) =>
      db
        .prepare(
          `INSERT INTO agreement_acceptances (email, customer_id, offer_id, document, version, context, ip_hash, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(args.email.toLowerCase(), args.customerId ?? null, args.offerId ?? null, d.key, d.version, args.context, ipHash, now),
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

/** Kompatibilitetsnavn: også de kendte, fortsat gældende tidligere vilkår accepteres. */
export const isCurrent = (a: Partial<Record<LegalDocKey, Acceptance>>): boolean =>
  LEGAL_DOCS.every((d) => acceptedVersionApplies(d, a[d.key]?.version));
