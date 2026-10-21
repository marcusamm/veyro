// Digitale fuldmagter: formular, validering, godkendelse, tilbagekaldelse, udløb, handlinger og sletning.
// Alle regler kontrolleres her på serveren; visningerne viser kun resultatet. Se docs/FULDMAGTER.md.
import type { Env } from '../env';
import { parseKr } from './invoices';
import { normalizeEmail } from './db';
import { nowSec, randomToken, sha256Hex } from './crypto';
import { formatKr } from './format';
import { RETENTION } from './poa-policy';

// ---------- Tekst ----------

/** Versionsmærke for fuldmagtsteksten. Ændres teksten nedenfor, skal mærket ændres. */
export const POA_TEXT_VERSION = 'Udkast 1 (21. oktober 2026)';

export const POWER_KEYS = ['admin', 'tech_contact', 'data', 'quotes', 'orders', 'other'] as const;
export type PowerKey = (typeof POWER_KEYS)[number];

export const POWERS: Record<PowerKey, { label: string; description: string }> = {
  admin: {
    label: 'Digital administration',
    description:
      'Veyro må oprette, redigere og vedligeholde kundens hjemmeside, domæne, hosting og de systemer, der er omfattet af fuldmagten.',
  },
  tech_contact: {
    label: 'Teknisk kontakt',
    description: 'Veyro må kontakte de angivne hosting-, software- og systemleverandører om support, fejl, drift og tekniske ændringer.',
  },
  data: {
    label: 'Data og registreringer',
    description: 'Veyro må efter kundens instrukser oprette og rette produkt-, lager-, ordre- og joboplysninger i de angivne systemer.',
  },
  quotes: {
    label: 'Indhente tilbud og oplysninger',
    description:
      'Veyro må indhente priser, leveringstider og produktinformation fra de angivne leverandører. Dette giver ikke tilladelse til at bestille.',
  },
  orders: {
    label: 'Bestille varer eller ydelser',
    description:
      'Veyro må bestille hos udvalgte leverandører inden for særskilt angivne beløbsgrænser og efter kundens konkrete instruktion.',
  },
  other: {
    label: 'Andre beføjelser',
    description: 'Den beføjelse, kunden selv har beskrevet nedenfor.',
  },
};

export const ORDER_EXCLUSIONS =
  'Bestillingsbeføjelsen omfatter ikke abonnementer, tilbagevendende køb, finansiering eller ændring af betalingsvilkår. Kunden betaler leverandøren, medmindre andet er aftalt skriftligt.';

export const TERMS: string[] = [
  'Veyro må kun handle inden for de valgte beføjelser og kundens skriftlige instrukser.',
  'Fuldmagten giver ikke adgang til bankkonti, betalingskort, lån eller kundens penge.',
  'Fuldmagten giver ikke ret til andre aftaleændringer eller underskrifter end dem, der udtrykkeligt er omfattet.',
  'Fuldmagten giver ikke ret til repræsentation over for myndigheder, banker eller domstole.',
  'Veyro må ikke videregive fuldmagten uden kundens forudgående skriftlige accept.',
  'Fuldmagten erstatter ikke en eventuel databehandleraftale.',
  'Kunden bør give Veyro særskilt brugeradgang frem for at dele personlige adgangskoder.',
  'Beføjelser, der ikke er afkrydset, er ikke givet.',
  'Kunden kan til enhver tid tilbagekalde fuldmagten i Veyros kundeportal. Tilbagekaldelsen stopper Veyros mulighed for at udføre nye handlinger under fuldmagten. Allerede gennemførte handlinger annulleres ikke automatisk.',
];

export const CONFIRMATIONS = [
  'Jeg har læst fuldmagten og godkender de valgte beføjelser og begrænsninger.',
  'Jeg bekræfter, at jeg har ret til at udstede fuldmagten på virksomhedens vegne.',
] as const;

export const REVOKE_TEXT =
  'Du er ved at tilbagekalde fuldmagten. Når du bekræfter, stopper Veyros mulighed for at udføre nye handlinger under denne fuldmagt. Allerede gennemførte handlinger annulleres ikke automatisk.';

export const REVOKE_GUIDE =
  'Du kan tilbagekalde fuldmagten når som helst: Log ind på kunde.veyro.dk, vælg Fuldmagter, åbn fuldmagten og tryk "Tilbagekald fuldmagt". Tilbagekaldelsen gælder med det samme.';

export function approvalMethodText(email: string): string {
  return `Godkendt i Veyros kundeportal efter login med engangslink sendt til ${email} og en ny engangskode sendt til samme e-mail ved godkendelsen. Metoden bekræfter adgang til e-mailadressen. Den er ikke en MitID-signatur og dokumenterer ikke tegningsret.`;
}

// ---------- Status ----------

export type PoaStatus = 'draft' | 'pending' | 'active' | 'revoked' | 'expired';
export const STATUS_LABEL: Record<PoaStatus, string> = {
  draft: 'Kladde',
  pending: 'Afventer godkendelse',
  active: 'Aktiv',
  revoked: 'Tilbagekaldt',
  expired: 'Udløbet',
};
export const STATUS_TONE: Record<PoaStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  draft: 'neutral',
  pending: 'warn',
  active: 'ok',
  revoked: 'err',
  expired: 'neutral',
};
export const DELETION_LABEL: Record<string, string> = {
  received: 'Modtaget – afventer behandling',
  retained: 'Delvist slettet – resten opbevares midlertidigt',
  completed: 'Gennemført – slettet',
};

// ---------- Datoer (dansk tid) ----------

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Dagens dato i Danmark som YYYY-MM-DD */
export function todayDk(at = Date.now()): string {
  return dayFmt.format(new Date(at));
}
export function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const longDay = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export function formatDay(s: string | null | undefined): string {
  return s && isDate(s) ? longDay.format(new Date(s + 'T00:00:00Z')) : '–';
}

// ---------- Formular ----------

export interface PoaForm {
  company_name: string;
  cvr: string;
  address: string;
  postal_city: string;
  contact_name: string;
  receipt_email: string;
  approver_name: string;
  approver_title: string;
  project: string;
  purpose: string;
  parties: string;
  expires_on: string;
  powers: PowerKey[];
  other_text: string;
  order_max_per_order: string;
  order_max_per_month: string;
  order_suppliers: string;
  order_types: string;
  order_start: string;
  order_end: string;
}

const LIMITS: Record<string, number> = {
  company_name: 200,
  cvr: 20,
  address: 200,
  postal_city: 100,
  contact_name: 120,
  receipt_email: 254,
  approver_name: 120,
  approver_title: 120,
  project: 200,
  purpose: 3000,
  parties: 2000,
  expires_on: 10,
  other_text: 2000,
  order_max_per_order: 20,
  order_max_per_month: 20,
  order_suppliers: 1000,
  order_types: 1000,
  order_start: 10,
  order_end: 10,
};

function clean(v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (!multiline) s = s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

export function emptyForm(): PoaForm {
  return {
    company_name: '', cvr: '', address: '', postal_city: '', contact_name: '', receipt_email: '', approver_name: '', approver_title: '',
    project: '', purpose: '', parties: '', expires_on: '', powers: [], other_text: '',
    order_max_per_order: '', order_max_per_month: '', order_suppliers: '', order_types: '', order_start: '', order_end: '',
  };
}

const MULTI = new Set(['purpose', 'parties', 'other_text', 'order_suppliers', 'order_types']);

/** Læser formularen. Afkrydsningsfelter, der ikke er sendt, er ikke valgt. */
export function readForm(body: Record<string, unknown>): PoaForm {
  const f = emptyForm();
  for (const k of Object.keys(LIMITS) as (keyof PoaForm)[]) {
    (f as unknown as Record<string, string>)[k] = clean(body[k], LIMITS[k]!, MULTI.has(k));
  }
  const raw = body['powers'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  f.powers = POWER_KEYS.filter((k) => list.includes(k));
  return f;
}

export function parseForm(json: string | null): PoaForm {
  const f = emptyForm();
  if (!json) return f;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return readForm({ ...o, powers: Array.isArray(o.powers) ? o.powers : [] });
  } catch {
    return f;
  }
}

export function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Fejl i formularen. Ved "gem kladde" kontrolleres kun formatet af det udfyldte;
 * ved godkendelse skal alt nødvendigt være udfyldt og gyldigt.
 */
export function validateForm(f: PoaForm, opts: { complete: boolean; today?: string }): Record<string, string> {
  const e: Record<string, string> = {};
  const today = opts.today ?? todayDk();
  const req = (k: keyof PoaForm, msg: string) => {
    if (opts.complete && !String(f[k]).trim()) e[k] = msg;
  };
  req('company_name', 'Skriv virksomhedens navn.');
  req('cvr', 'Skriv CVR-nummeret.');
  req('address', 'Skriv adressen.');
  req('postal_city', 'Skriv postnummer og by.');
  req('contact_name', 'Skriv kontaktpersonens navn.');
  req('receipt_email', 'Skriv den e-mail, kvitteringen skal sendes til.');
  req('approver_name', 'Skriv navnet på den, der godkender.');
  req('approver_title', 'Skriv titlen på den, der godkender.');
  req('project', 'Skriv hvilket projekt, hjemmeside eller system fuldmagten gælder.');
  req('purpose', 'Beskriv formålet og de ønskede opgaver.');

  if (f.cvr && !/^\d{8}$/.test(f.cvr.replace(/\s/g, ''))) e.cvr = 'CVR-nummeret skal være 8 cifre.';
  if (f.postal_city && !/^\d{4}\s+\S/.test(f.postal_city)) e.postal_city = 'Skriv postnummer (4 cifre) og by, fx 4200 Slagelse.';
  if (f.receipt_email && !normalizeEmail(f.receipt_email)) e.receipt_email = 'Skriv en gyldig e-mailadresse.';
  if (opts.complete && f.purpose && f.purpose.length < 10) e.purpose = 'Beskriv formålet lidt mere præcist (mindst 10 tegn).';

  if (f.expires_on) {
    if (!isDate(f.expires_on)) e.expires_on = 'Ugyldig dato.';
    else if (f.expires_on < today) e.expires_on = 'Udløbsdatoen er overskredet. Vælg en dato fra i dag og frem.';
  }

  if (opts.complete && f.powers.length === 0) e.powers = 'Vælg mindst én beføjelse.';
  if (f.powers.includes('other') && (opts.complete || f.other_text) && f.other_text.length < 10) {
    e.other_text = 'Beskriv præcist, hvilken beføjelse Veyro får (mindst 10 tegn).';
  }

  if (f.powers.includes('orders')) {
    const per = f.order_max_per_order ? parseKr(f.order_max_per_order) : null;
    const month = f.order_max_per_month ? parseKr(f.order_max_per_month) : null;
    if (f.order_max_per_order && per === null) e.order_max_per_order = 'Skriv et gyldigt beløb i kroner, fx 5.000.';
    else if (opts.complete && !f.order_max_per_order) e.order_max_per_order = 'Skriv det maksimale beløb pr. bestilling.';
    if (f.order_max_per_month && month === null) e.order_max_per_month = 'Skriv et gyldigt beløb i kroner, fx 20.000.';
    else if (opts.complete && !f.order_max_per_month) e.order_max_per_month = 'Skriv det maksimale beløb pr. kalendermåned.';
    if (per !== null && month !== null && per > month) e.order_max_per_order = 'Beløbet pr. bestilling kan ikke være større end månedsgrænsen.';
    if (opts.complete && lines(f.order_suppliers).length === 0) e.order_suppliers = 'Skriv mindst én godkendt leverandør.';
    if (opts.complete && lines(f.order_types).length === 0) e.order_types = 'Skriv hvilke varer eller ydelser der må bestilles.';
    if (f.order_start && !isDate(f.order_start)) e.order_start = 'Ugyldig dato.';
    else if (opts.complete && !f.order_start) e.order_start = 'Vælg en startdato.';
    if (f.order_end && !isDate(f.order_end)) e.order_end = 'Ugyldig dato.';
    else if (opts.complete && !f.order_end) e.order_end = 'Vælg en slutdato.';
    if (!e.order_start && !e.order_end && f.order_start && f.order_end) {
      if (f.order_end < f.order_start) e.order_end = 'Slutdatoen skal være efter startdatoen.';
      else if (f.order_end < today) e.order_end = 'Slutdatoen er overskredet.';
      else if (f.expires_on && isDate(f.expires_on) && f.order_end > f.expires_on) {
        e.order_end = 'Bestillingsbeføjelsen kan ikke gælde længere end fuldmagten.';
      }
    }
  }
  return e;
}

// ---------- Indstillinger (Veyros oplysninger) ----------

export interface PoaSettings {
  veyro_legal_name: string;
  veyro_cvr: string;
  veyro_address: string;
  veyro_contact_name: string;
  veyro_contact_email: string;
  require_veyro_acceptance: boolean;
  text_approved: boolean;
  launched: boolean;
  pilot_emails: string[];
}

export async function getSettings(db: D1Database): Promise<PoaSettings> {
  const { results } = await db.prepare('SELECT key, value FROM poa_settings').all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const s = (k: string) => m.get(k) ?? '';
  return {
    veyro_legal_name: s('veyro_legal_name'),
    veyro_cvr: s('veyro_cvr'),
    veyro_address: s('veyro_address'),
    veyro_contact_name: s('veyro_contact_name'),
    veyro_contact_email: s('veyro_contact_email'),
    require_veyro_acceptance: s('require_veyro_acceptance') !== '0',
    text_approved: s('text_approved') === '1',
    launched: s('launched') === '1',
    pilot_emails: s('pilot_emails')
      .split(/[\s,;]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  };
}

export const VEYRO_FIELDS: [keyof PoaSettings, string][] = [
  ['veyro_legal_name', 'Juridisk virksomhedsnavn'],
  ['veyro_cvr', 'CVR-nummer'],
  ['veyro_address', 'Adresse'],
  ['veyro_contact_name', 'Kontaktperson'],
  ['veyro_contact_email', 'Kontaktmail'],
];

export function missingVeyroInfo(s: PoaSettings): string[] {
  return VEYRO_FIELDS.filter(([k]) => !String(s[k]).trim()).map(([, label]) => label);
}

export async function saveSettings(db: D1Database, values: Record<string, string>, by: string): Promise<void> {
  const now = nowSec();
  await db.batch(
    Object.entries(values).map(([k, v]) =>
      db
        .prepare(
          `INSERT INTO poa_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(k, v, now, by),
    ),
  );
}

/** Må kunden oprette nye fuldmagter? Eksisterende fuldmagter kan altid ses, hentes, tilbagekaldes og slettes. */
export function canIssue(s: PoaSettings, email: string): boolean {
  return s.launched || s.pilot_emails.includes(email.toLowerCase());
}

export function isTestEnv(env: Env): boolean {
  return !!env.TEST_LABEL || env.DEV_MODE === '1';
}

// ---------- Rækker ----------

export interface PoaRow {
  id: number;
  number: string;
  version: number;
  customer_id: number;
  status: PoaStatus;
  deletion_status: 'none' | 'requested' | 'retained';
  company_name: string | null;
  project: string | null;
  expires_on: string | null;
  draft_json: string | null;
  snapshot_json: string | null;
  content_hash: string | null;
  text_version: string | null;
  approver_name: string | null;
  approver_title: string | null;
  approver_email: string | null;
  approval_method: string | null;
  approved_at: number | null;
  veyro_accepted_at: number | null;
  veyro_accepted_by: string | null;
  activated_at: number | null;
  revoked_at: number | null;
  expired_at: number | null;
  retain_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface Snapshot {
  number: string;
  version: number;
  text_version: string;
  text_draft: boolean;
  test: string | null;
  customer: { company_name: string; cvr: string; address: string; postal_city: string; contact_name: string; receipt_email: string };
  approver: { name: string; title: string; account_email: string };
  veyro: { legal_name: string; cvr: string; address: string; contact_name: string; contact_email: string };
  scope: { project: string; purpose: string; parties: string[]; expires_on: string | null };
  powers: { key: PowerKey; label: string; description: string; granted: boolean }[];
  other_text: string | null;
  orders: null | {
    max_per_order_oere: number;
    max_per_month_oere: number;
    suppliers: string[];
    types: string[];
    start: string;
    end: string;
    exclusions: string;
  };
  terms: string[];
  confirmations: string[];
  requires_veyro_acceptance: boolean;
}

export function parseSnapshot(row: Pick<PoaRow, 'snapshot_json'>): Snapshot | null {
  if (!row.snapshot_json) return null;
  try {
    return JSON.parse(row.snapshot_json) as Snapshot;
  } catch {
    return null;
  }
}

/** Den præcise tekst og de valg, kunden godkender. Samme input giver altid samme snapshot (og hash). */
export function buildSnapshot(row: Pick<PoaRow, 'number' | 'version'>, f: PoaForm, s: PoaSettings, accountEmail: string, env: Env): Snapshot {
  const orders = f.powers.includes('orders')
    ? {
        max_per_order_oere: parseKr(f.order_max_per_order) ?? 0,
        max_per_month_oere: parseKr(f.order_max_per_month) ?? 0,
        suppliers: lines(f.order_suppliers),
        types: lines(f.order_types),
        start: f.order_start,
        end: f.order_end,
        exclusions: ORDER_EXCLUSIONS,
      }
    : null;
  return {
    number: row.number,
    version: row.version,
    text_version: POA_TEXT_VERSION,
    text_draft: !s.text_approved,
    test: isTestEnv(env) ? env.TEST_LABEL || 'Testmiljø' : null,
    customer: {
      company_name: f.company_name,
      cvr: f.cvr.replace(/\s/g, ''),
      address: f.address,
      postal_city: f.postal_city,
      contact_name: f.contact_name,
      receipt_email: normalizeEmail(f.receipt_email) ?? f.receipt_email,
    },
    approver: { name: f.approver_name, title: f.approver_title, account_email: accountEmail },
    veyro: {
      legal_name: s.veyro_legal_name,
      cvr: s.veyro_cvr,
      address: s.veyro_address,
      contact_name: s.veyro_contact_name,
      contact_email: s.veyro_contact_email,
    },
    scope: { project: f.project, purpose: f.purpose, parties: lines(f.parties), expires_on: f.expires_on || null },
    powers: POWER_KEYS.map((k) => ({ key: k, label: POWERS[k].label, description: POWERS[k].description, granted: f.powers.includes(k) })),
    other_text: f.powers.includes('other') ? f.other_text : null,
    orders,
    terms: TERMS,
    confirmations: [...CONFIRMATIONS],
    requires_veyro_acceptance: s.require_veyro_acceptance,
  };
}

export async function snapshotHash(snap: Snapshot): Promise<string> {
  return sha256Hex(JSON.stringify(snap));
}

export function label(row: Pick<PoaRow, 'number' | 'version'>): string {
  return row.version > 1 ? `${row.number} v${row.version}` : row.number;
}

export async function getPoaForCustomer(db: D1Database, id: number, customerId: number): Promise<PoaRow | null> {
  return db.prepare('SELECT * FROM poas WHERE id = ? AND customer_id = ?').bind(id, customerId).first<PoaRow>();
}
export async function getPoa(db: D1Database, id: number): Promise<PoaRow | null> {
  return db.prepare('SELECT * FROM poas WHERE id = ?').bind(id).first<PoaRow>();
}

export async function listForCustomer(db: D1Database, customerId: number): Promise<PoaRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM poas WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
    .bind(customerId)
    .all<PoaRow>();
  return results;
}

export interface DeletionRequestRow {
  id: number;
  customer_id: number;
  poa_id: number | null;
  poa_label: string;
  status: 'received' | 'retained' | 'completed';
  requested_at: number;
  handled_at: number | null;
  handled_by: string | null;
  result_text: string | null;
  retain_until: number | null;
}

export async function listDeletionRequests(db: D1Database, customerId: number | null): Promise<(DeletionRequestRow & { email?: string })[]> {
  const sql = `SELECT d.*, c.email FROM poa_deletion_requests d JOIN customers c ON c.id = d.customer_id
    ${customerId === null ? '' : 'WHERE d.customer_id = ?'} ORDER BY (d.status = 'completed') ASC, d.requested_at DESC LIMIT 300`;
  const st = db.prepare(sql);
  const { results } = await (customerId === null ? st : st.bind(customerId)).all<DeletionRequestRow & { email: string }>();
  return results;
}

// ---------- Hændelser ----------

export function eventStmt(db: D1Database, poaId: number, actor: string, type: string, detail: string | null = null) {
  return db.prepare('INSERT INTO poa_events (poa_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').bind(poaId, nowSec(), actor, type, detail);
}

export interface EventRow {
  id: number;
  at: number;
  actor: string;
  type: string;
  detail: string | null;
}
export async function listEvents(db: D1Database, poaId: number): Promise<EventRow[]> {
  const { results } = await db.prepare('SELECT id, at, actor, type, detail FROM poa_events WHERE poa_id = ? ORDER BY at, id').bind(poaId).all<EventRow>();
  return results;
}

export const EVENT_LABEL: Record<string, string> = {
  created: 'Kladde oprettet',
  draft_saved: 'Kladde gemt',
  otp_sent: 'Engangskode sendt',
  otp_failed: 'Forkert engangskode',
  approved: 'Godkendt af kunden',
  veyro_accepted: 'Accepteret af Veyro',
  activated: 'Aktiv',
  revoked: 'Tilbagekaldt',
  expired: 'Udløbet',
  action_registered: 'Handling registreret',
  action_planned: 'Handling planlagt',
  action_done: 'Planlagt handling udført',
  action_cancelled: 'Planlagt handling stoppet',
  action_blocked: 'Handling afvist af systemet',
  task_done: 'Opfølgning udført',
  deletion_requested: 'Sletning anmodet',
  deletion_retained: 'Delvist slettet',
  mail_resend: 'Mail sendt igen',
  new_version: 'Ny version oprettet',
};

// ---------- Oprettelse og kladder ----------

async function nextNumber(db: D1Database): Promise<string> {
  const year = todayDk().slice(0, 4);
  const row = await db
    .prepare("SELECT MAX(CAST(substr(number, 9) AS INTEGER)) AS n FROM poas WHERE number LIKE ?")
    .bind(`FM-${year}-%`)
    .first<{ n: number | null }>();
  return `FM-${year}-${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * Opretter en kladde. `idem` er formularens engangsnøgle: samme nøgle giver samme kladde (dobbeltklik).
 * `from` er en tidligere version, der skal ændres (samme nummer, ny version).
 */
export async function createDraft(
  db: D1Database,
  args: { customerId: number; form: PoaForm; idem: string; from?: PoaRow },
): Promise<number> {
  const existing = await db.prepare('SELECT id, customer_id FROM poas WHERE idem_key = ?').bind(args.idem).first<{ id: number; customer_id: number }>();
  if (existing) {
    if (existing.customer_id !== args.customerId) throw new Error('idem-nøgle tilhører en anden kunde');
    return existing.id;
  }
  const now = nowSec();
  for (let attempt = 0; attempt < 5; attempt++) {
    let number: string;
    let version = 1;
    if (args.from) {
      number = args.from.number;
      const v = await db.prepare('SELECT MAX(version) AS v FROM poas WHERE number = ?').bind(number).first<{ v: number }>();
      version = (v?.v ?? args.from.version) + 1;
    } else {
      number = await nextNumber(db);
    }
    try {
      const row = await db
        .prepare(
          `INSERT INTO poas (number, version, customer_id, status, company_name, project, expires_on, draft_json, idem_key, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(
          number,
          version,
          args.customerId,
          args.form.company_name || null,
          args.form.project || null,
          args.form.expires_on || null,
          JSON.stringify(args.form),
          args.idem,
          now,
          now,
        )
        .first<{ id: number }>();
      await eventStmt(db, row!.id, 'kunde', args.from ? 'new_version' : 'created', args.from ? `Ændring af ${label(args.from)}` : null).run();
      return row!.id;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('idem_key')) {
        const again = await db.prepare('SELECT id FROM poas WHERE idem_key = ?').bind(args.idem).first<{ id: number }>();
        if (again) return again.id;
      }
      if (!msg.includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Kunne ikke tildele fuldmagtsnummer');
}

export async function saveDraft(db: D1Database, poa: PoaRow, form: PoaForm): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE poas SET draft_json = ?, company_name = ?, project = ?, expires_on = ?, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'draft'`,
    )
    .bind(JSON.stringify(form), form.company_name || null, form.project || null, form.expires_on || null, nowSec(), poa.id, poa.customer_id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Sletter en kladde helt (inkl. hændelser og engangskoder). Godkendte fuldmagter kan ikke slettes her. */
export async function deleteDraft(db: D1Database, id: number, customerId: number): Promise<boolean> {
  const r = await db.prepare("DELETE FROM poas WHERE id = ? AND customer_id = ? AND status = 'draft'").bind(id, customerId).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Formular for en ny version ud fra en godkendt fuldmagt */
export function formFromSnapshot(s: Snapshot): PoaForm {
  const kr = (oere: number) => formatKr(oere).replace(' kr.', '');
  return {
    company_name: s.customer.company_name,
    cvr: s.customer.cvr,
    address: s.customer.address,
    postal_city: s.customer.postal_city,
    contact_name: s.customer.contact_name,
    receipt_email: s.customer.receipt_email,
    approver_name: s.approver.name,
    approver_title: s.approver.title,
    project: s.scope.project,
    purpose: s.scope.purpose,
    parties: s.scope.parties.join('\n'),
    expires_on: s.scope.expires_on ?? '',
    powers: s.powers.filter((p) => p.granted).map((p) => p.key),
    other_text: s.other_text ?? '',
    order_max_per_order: s.orders ? kr(s.orders.max_per_order_oere) : '',
    order_max_per_month: s.orders ? kr(s.orders.max_per_month_oere) : '',
    order_suppliers: s.orders?.suppliers.join('\n') ?? '',
    order_types: s.orders?.types.join('\n') ?? '',
    order_start: s.orders?.start ?? '',
    order_end: s.orders?.end ?? '',
  };
}

// ---------- Engangskode ----------

export const OTP_TTL = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;

async function otpHash(poaId: number, code: string): Promise<string> {
  return sha256Hex(`poa-otp:${poaId}:${code}`);
}

export async function createOtp(db: D1Database, poaId: number): Promise<string> {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const code = String(arr[0]! % 1_000_000).padStart(6, '0');
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO poa_otps (poa_id, code_hash, attempts, expires_at, created_at) VALUES (?1, ?2, 0, ?3, ?4)
       ON CONFLICT(poa_id) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    )
    .bind(poaId, await otpHash(poaId, code), now + OTP_TTL, now)
    .run();
  return code;
}

/** Kontrollerer koden. Tæller forsøg; efter 5 forkerte skal der sendes en ny kode. */
export async function checkOtp(db: D1Database, poaId: number, code: string): Promise<'ok' | 'wrong' | 'expired' | 'missing'> {
  const row = await db
    .prepare('UPDATE poa_otps SET attempts = attempts + 1 WHERE poa_id = ? RETURNING code_hash, attempts, expires_at')
    .bind(poaId)
    .first<{ code_hash: string; attempts: number; expires_at: number }>();
  if (!row) return 'missing';
  if (row.expires_at < nowSec() || row.attempts > OTP_MAX_ATTEMPTS) return 'expired';
  if (!/^\d{6}$/.test(code) || (await otpHash(poaId, code)) !== row.code_hash) return 'wrong';
  return 'ok';
}

// ---------- Godkendelse ----------

/**
 * Låser fuldmagten som godkendt. Kun en kladde kan godkendes, så et dobbeltklik ikke giver to godkendelser.
 * Returnerer den nye status eller null, hvis den allerede var godkendt.
 */
export async function approve(
  db: D1Database,
  poa: PoaRow,
  snap: Snapshot,
  hash: string,
  accountEmail: string,
): Promise<PoaStatus | null> {
  const now = nowSec();
  const status: PoaStatus = snap.requires_veyro_acceptance ? 'pending' : 'active';
  const res = await db.batch([
    db
      .prepare(
        `UPDATE poas SET status = ?, snapshot_json = ?, content_hash = ?, text_version = ?, approver_name = ?, approver_title = ?,
           approver_email = ?, approval_method = ?, approved_at = ?, activated_at = ?, company_name = ?, project = ?, expires_on = ?,
           draft_json = NULL, updated_at = ?
         WHERE id = ? AND customer_id = ? AND status = 'draft'`,
      )
      .bind(
        status,
        JSON.stringify(snap),
        hash,
        snap.text_version,
        snap.approver.name,
        snap.approver.title,
        accountEmail,
        approvalMethodText(accountEmail),
        now,
        status === 'active' ? now : null,
        snap.customer.company_name,
        snap.scope.project,
        snap.scope.expires_on,
        now,
        poa.id,
        poa.customer_id,
      ),
    db.prepare('DELETE FROM poa_otps WHERE poa_id = ?').bind(poa.id),
  ]);
  if ((res[0]!.meta.changes ?? 0) === 0) return null;
  await db.batch([
    eventStmt(db, poa.id, 'kunde', 'approved', `Metode: login + engangskode på e-mail. Tekst: ${snap.text_version}. Hash: ${hash.slice(0, 16)}…`),
    ...(status === 'active' ? [eventStmt(db, poa.id, 'system', 'activated', 'Veyros accept kræves ikke')] : []),
  ]);
  return status;
}

/** Veyros accept: afventer godkendelse → aktiv. Kun hvis fuldmagten stadig er gyldig. */
export async function acceptByVeyro(db: D1Database, poaId: number, by: string): Promise<boolean> {
  const now = nowSec();
  const r = await db
    .prepare(
      `UPDATE poas SET status = 'active', veyro_accepted_at = ?1, veyro_accepted_by = ?2, activated_at = ?1, updated_at = ?1
       WHERE id = ?3 AND status = 'pending' AND deletion_status = 'none' AND (expires_on IS NULL OR expires_on >= ?4)`,
    )
    .bind(now, by, poaId, todayDk())
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await db.batch([eventStmt(db, poaId, by, 'veyro_accepted'), eventStmt(db, poaId, 'system', 'activated')]);
  return true;
}

// ---------- Tilbagekaldelse og udløb ----------

/** Fælles for tilbagekaldelse og udløb: stop planlagte handlinger og opret Veyros opgaver. */
async function stopAndFollowUp(db: D1Database, poa: PoaRow, reason: 'revoked' | 'expired'): Promise<void> {
  const now = nowSec();
  const why = reason === 'revoked' ? 'Fuldmagten er tilbagekaldt' : 'Fuldmagten er udløbet';
  const { results: parties } = await db
    .prepare("SELECT DISTINCT party FROM poa_actions WHERE poa_id = ? AND status = 'done' ORDER BY party")
    .bind(poa.id)
    .all<{ party: string }>();
  const cancelled = await db
    .prepare("UPDATE poa_actions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE poa_id = ? AND status = 'planned'")
    .bind(now, why, poa.id)
    .run();
  const stmts = [
    db
      .prepare("INSERT INTO poa_tasks (poa_id, kind, party, responsible, note, created_at) VALUES (?, 'followup', NULL, 'veyro', ?, ?)")
      .bind(
        poa.id,
        `${why}. Fjern eller luk Veyros adgange hos de omfattede leverandører, systemer og konti, og stop igangværende opgaver under ${label(poa)}.`,
        now,
      ),
    ...parties.map((p) =>
      db
        .prepare("INSERT INTO poa_tasks (poa_id, kind, party, responsible, note, created_at) VALUES (?, 'third_party', ?, 'veyro', ?, ?)")
        .bind(poa.id, p.party, `Veyro har brugt fuldmagten over for ${p.party}. Orientér dem om, at fuldmagten ikke længere gælder.`, now),
    ),
  ];
  if ((cancelled.meta.changes ?? 0) > 0) {
    stmts.push(eventStmt(db, poa.id, 'system', 'action_cancelled', `${cancelled.meta.changes} planlagte handlinger stoppet`));
  }
  await db.batch(stmts);
}

/**
 * Tilbagekalder med det samme. Gælder uden medarbejderes godkendelse og uanset om mails kan sendes.
 * Returnerer false, hvis fuldmagten ikke var aktiv eller afventende.
 */
export async function revoke(db: D1Database, poa: PoaRow): Promise<boolean> {
  const now = nowSec();
  const r = await db
    .prepare(
      "UPDATE poas SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND customer_id = ? AND status IN ('pending', 'active')",
    )
    .bind(now, now, poa.id, poa.customer_id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await eventStmt(db, poa.id, 'kunde', 'revoked').run();
  await stopAndFollowUp(db, poa, 'revoked');
  return true;
}

/** Markerer udløbne fuldmagter. Køres før hver fuldmagtshandling og dagligt. Returnerer de udløbne id'er. */
export async function expireDue(db: D1Database): Promise<number[]> {
  const now = nowSec();
  const { results } = await db
    .prepare(
      `UPDATE poas SET status = 'expired', expired_at = ?1, updated_at = ?1
       WHERE status IN ('pending', 'active') AND expires_on IS NOT NULL AND expires_on < ?2 RETURNING *`,
    )
    .bind(now, todayDk())
    .all<PoaRow>();
  for (const poa of results) {
    await eventStmt(db, poa.id, 'system', 'expired', `Udløbsdato ${poa.expires_on}`).run();
    await stopAndFollowUp(db, poa, 'expired');
  }
  return results.map((r) => r.id);
}

// ---------- Handlinger under fuldmagten ----------

export interface ActionRow {
  id: number;
  poa_id: number;
  power: PowerKey;
  party: string;
  description: string;
  amount_oere: number | null;
  status: 'planned' | 'done' | 'cancelled';
  planned_for: string | null;
  month_key: string;
  created_at: number;
  created_by: string;
  done_at: number | null;
  cancelled_at: number | null;
  cancel_reason: string | null;
}

export async function listActions(db: D1Database, poaId: number): Promise<ActionRow[]> {
  const { results } = await db.prepare('SELECT * FROM poa_actions WHERE poa_id = ? ORDER BY created_at DESC, id DESC').bind(poaId).all<ActionRow>();
  return results;
}

export interface ActionInput {
  power: string;
  party: string;
  description: string;
  amount: string;
  planned_for: string;
}

function sameParty(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}

/**
 * Kontrollerer en handling mod fuldmagten. Returnerer en fejltekst eller null.
 * Selve indsættelsen kontrollerer status og månedsgrænse igen i samme SQL-sætning,
 * så en tilbagekaldelse, der sker imens, altid vinder.
 */
export function checkAction(poa: PoaRow, snap: Snapshot, a: ActionInput, today = todayDk()): { error: string | null; amount: number | null; date: string } {
  const date = a.planned_for || today;
  const fail = (error: string) => ({ error, amount: null, date });
  if (poa.status !== 'active') return fail(`Fuldmagten er ${STATUS_LABEL[poa.status].toLowerCase()}. Der kan ikke udføres handlinger under den.`);
  if (poa.deletion_status !== 'none') return fail('Der er anmodet om sletning af fuldmagten. Der kan ikke udføres handlinger under den.');
  if (poa.expires_on && poa.expires_on < today) return fail('Fuldmagten er udløbet.');
  if (a.planned_for && (!isDate(a.planned_for) || a.planned_for < today)) return fail('Vælg en gyldig dato fra i dag og frem.');
  if (a.planned_for && poa.expires_on && a.planned_for > poa.expires_on) return fail('Datoen ligger efter fuldmagtens udløb.');
  if (!(POWER_KEYS as readonly string[]).includes(a.power)) return fail('Vælg en beføjelse.');
  const power = snap.powers.find((p) => p.key === a.power);
  if (!power?.granted) return fail(`Beføjelsen "${POWERS[a.power as PowerKey].label}" er ikke givet i fuldmagten.`);
  if (a.party.length < 2) return fail('Skriv leverandør, system eller konto.');
  if (a.description.length < 5) return fail('Beskriv handlingen.');
  let amount: number | null = null;
  if (a.power === 'orders') {
    const o = snap.orders;
    if (!o) return fail('Fuldmagten har ingen bestillingsbetingelser.');
    amount = parseKr(a.amount);
    if (amount === null) return fail('Skriv bestillingens beløb inkl. moms.');
    if (date < o.start || date > o.end) return fail(`Bestillingsbeføjelsen gælder kun fra ${formatDay(o.start)} til ${formatDay(o.end)}.`);
    if (!o.suppliers.some((s) => sameParty(s, a.party))) return fail(`${a.party} er ikke en godkendt leverandør. Godkendte: ${o.suppliers.join(', ')}.`);
    if (amount > o.max_per_order_oere) return fail(`Beløbet overstiger grænsen pr. bestilling (${formatKr(o.max_per_order_oere)} inkl. moms).`);
  }
  return { error: null, amount, date };
}

/** Registrerer (eller planlægger) en handling efter kontrol. Returnerer fejltekst eller null. */
export async function registerAction(db: D1Database, poaId: number, a: ActionInput, by: string): Promise<string | null> {
  await expireDue(db);
  const poa = await getPoa(db, poaId);
  const snap = poa ? parseSnapshot(poa) : null;
  if (!poa || !snap) return 'Fuldmagten findes ikke.';
  const today = todayDk();
  const chk = checkAction(poa, snap, a, today);
  if (chk.error) {
    await eventStmt(db, poaId, by, 'action_blocked', chk.error.slice(0, 300)).run();
    return chk.error;
  }
  const planned = !!a.planned_for && a.planned_for > today;
  const month = chk.date.slice(0, 7);
  const limit = snap.orders?.max_per_month_oere ?? 0;
  const now = nowSec();
  // Status, udløb, sletning og månedsgrænse kontrolleres igen i selve indsættelsen.
  const r = await db
    .prepare(
      `INSERT INTO poa_actions (poa_id, power, party, description, amount_oere, status, planned_for, month_key, created_at, created_by, done_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE EXISTS (SELECT 1 FROM poas WHERE id = ?1 AND status = 'active' AND deletion_status = 'none' AND (expires_on IS NULL OR expires_on >= ?12))
         AND (?2 != 'orders' OR (SELECT COALESCE(SUM(amount_oere), 0) FROM poa_actions
               WHERE poa_id = ?1 AND power = 'orders' AND status != 'cancelled' AND month_key = ?8) + ?5 <= ?13)`,
    )
    .bind(poaId, a.power, a.party, a.description, chk.amount, planned ? 'planned' : 'done', planned ? a.planned_for : null, month, now, by, planned ? null : now, today, limit)
    .run();
  if ((r.meta.changes ?? 0) === 0) {
    const fresh = await getPoa(db, poaId);
    const msg =
      fresh && fresh.status !== 'active'
        ? `Fuldmagten er ${STATUS_LABEL[fresh.status].toLowerCase()}. Handlingen er ikke registreret.`
        : `Beløbet overstiger månedsgrænsen (${formatKr(limit)} inkl. moms pr. kalendermåned).`;
    await eventStmt(db, poaId, by, 'action_blocked', msg).run();
    return msg;
  }
  await eventStmt(db, poaId, by, planned ? 'action_planned' : 'action_registered', `${POWERS[a.power as PowerKey].label}: ${a.party}`).run();
  return null;
}

/** Udfører en planlagt handling, men kun hvis fuldmagten stadig gælder. */
export async function completePlannedAction(db: D1Database, poaId: number, actionId: number, by: string): Promise<string | null> {
  await expireDue(db);
  const now = nowSec();
  const r = await db
    .prepare(
      `UPDATE poa_actions SET status = 'done', done_at = ?1
       WHERE id = ?2 AND poa_id = ?3 AND status = 'planned'
         AND EXISTS (SELECT 1 FROM poas WHERE id = ?3 AND status = 'active' AND deletion_status = 'none' AND (expires_on IS NULL OR expires_on >= ?4))`,
    )
    .bind(now, actionId, poaId, todayDk())
    .run();
  if ((r.meta.changes ?? 0) === 0) return 'Handlingen kan ikke udføres: fuldmagten gælder ikke længere, eller handlingen er allerede behandlet.';
  await eventStmt(db, poaId, by, 'action_done').run();
  return null;
}

export async function cancelPlannedAction(db: D1Database, poaId: number, actionId: number, by: string): Promise<void> {
  const r = await db
    .prepare("UPDATE poa_actions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND poa_id = ? AND status = 'planned'")
    .bind(nowSec(), 'Stoppet af Veyro', actionId, poaId)
    .run();
  if ((r.meta.changes ?? 0) > 0) await eventStmt(db, poaId, by, 'action_cancelled').run();
}

// ---------- Opgaver efter tilbagekaldelse ----------

export interface TaskRow {
  id: number;
  poa_id: number;
  kind: 'followup' | 'third_party';
  party: string | null;
  responsible: 'veyro' | 'kunde';
  status: 'open' | 'done';
  note: string | null;
  created_at: number;
  done_at: number | null;
  done_by: string | null;
}

export async function listTasks(db: D1Database, poaId: number): Promise<TaskRow[]> {
  const { results } = await db.prepare('SELECT * FROM poa_tasks WHERE poa_id = ? ORDER BY kind, id').bind(poaId).all<TaskRow>();
  return results;
}

export async function completeTask(db: D1Database, poaId: number, taskId: number, by: string): Promise<void> {
  const r = await db
    .prepare("UPDATE poa_tasks SET status = 'done', done_at = ?, done_by = ? WHERE id = ? AND poa_id = ? AND status = 'open'")
    .bind(nowSec(), by, taskId, poaId)
    .run();
  if ((r.meta.changes ?? 0) > 0) await eventStmt(db, poaId, by, 'task_done').run();
}

// ---------- Sletning ----------

/** Anmodning om sletning af en godkendt fuldmagt. Er den aktiv/afventende, skal den tilbagekaldes først (samme forløb). */
export async function requestDeletion(db: D1Database, poa: PoaRow): Promise<number | null> {
  if (poa.status === 'draft' || poa.status === 'pending' || poa.status === 'active') return null;
  const r = await db
    .prepare("UPDATE poas SET deletion_status = 'requested', updated_at = ? WHERE id = ? AND customer_id = ? AND deletion_status = 'none'")
    .bind(nowSec(), poa.id, poa.customer_id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return null;
  const row = await db
    .prepare('INSERT INTO poa_deletion_requests (customer_id, poa_id, poa_label, requested_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(poa.customer_id, poa.id, label(poa), nowSec())
    .first<{ id: number }>();
  await eventStmt(db, poa.id, 'kunde', 'deletion_requested').run();
  return row!.id;
}

/** Tidspunktet, fuldmagten ophørte (tilbagekaldt eller udløbet) */
export function endedAt(poa: PoaRow): number | null {
  return poa.revoked_at ?? poa.expired_at ?? null;
}

export async function hasDoneActions(db: D1Database, poaId: number): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM poa_actions WHERE poa_id = ? AND status = 'done'").bind(poaId).first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

/** Hvor længe data skal opbevares efter politikken, eller null hvis alt kan slettes nu. */
export async function retentionFor(db: D1Database, poa: PoaRow): Promise<number | null> {
  if (!(await hasDoneActions(db, poa.id))) return null;
  const end = endedAt(poa) ?? nowSec();
  return end + RETENTION.withActionsDays * 86400;
}

/** Sletter fuldmagten og alt tilknyttet (dokumenter, hændelser, mails, handlinger, opgaver). */
export async function hardDelete(db: D1Database, poaId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM poa_documents WHERE poa_id = ?').bind(poaId),
    db.prepare('DELETE FROM poa_mails WHERE poa_id = ?').bind(poaId),
    db.prepare('DELETE FROM poa_events WHERE poa_id = ?').bind(poaId),
    db.prepare('DELETE FROM poa_actions WHERE poa_id = ?').bind(poaId),
    db.prepare('DELETE FROM poa_tasks WHERE poa_id = ?').bind(poaId),
    db.prepare('DELETE FROM poa_otps WHERE poa_id = ?').bind(poaId),
    db.prepare('UPDATE poa_deletion_requests SET poa_id = NULL WHERE poa_id = ?').bind(poaId),
    db.prepare('DELETE FROM poas WHERE id = ?').bind(poaId),
  ]);
}

export interface DeletionResult {
  status: 'retained' | 'completed';
  text: string;
  retainUntil: number | null;
}

/**
 * Behandler en sletteanmodning efter politikken. `mode = 'full'` sletter alt nu
 * (når Veyro har vurderet, at der ikke er grund til at opbevare noget).
 */
export async function processDeletion(db: D1Database, requestId: number, by: string, mode: 'policy' | 'full'): Promise<DeletionResult | null> {
  const req = await db.prepare("SELECT * FROM poa_deletion_requests WHERE id = ? AND status = 'received'").bind(requestId).first<DeletionRequestRow>();
  if (!req) return null;
  const poa = req.poa_id ? await getPoa(db, req.poa_id) : null;
  const now = nowSec();
  let result: DeletionResult;
  const until = poa && mode === 'policy' ? await retentionFor(db, poa) : null;
  if (!poa || until === null) {
    if (poa) await hardDelete(db, poa.id);
    result = {
      status: 'completed',
      text: `Fuldmagt ${req.poa_label} er slettet i Veyros system: dokumenter, formularoplysninger, godkendelsesoplysninger, hændelseslog og mails. Data forsvinder også fra Veyros sikkerhedskopier senest ${RETENTION.backupDays} dage efter sletningen.`,
      retainUntil: null,
    };
  } else {
    // Opbevar kun dokumentet, godkendelsen og handlingsloggen; slet resten nu.
    await db.batch([
      db.prepare('DELETE FROM poa_mails WHERE poa_id = ?').bind(poa.id),
      db.prepare('DELETE FROM poa_otps WHERE poa_id = ?').bind(poa.id),
      db.prepare("DELETE FROM poa_tasks WHERE poa_id = ? AND status = 'done'").bind(poa.id),
      db.prepare("UPDATE poas SET deletion_status = 'retained', retain_until = ?, updated_at = ? WHERE id = ?").bind(until, now, poa.id),
      eventStmt(db, poa.id, by, 'deletion_retained', `Opbevares til ${new Date(until * 1000).toISOString().slice(0, 10)}`),
    ]);
    const date = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Copenhagen' }).format(
      new Date(until * 1000),
    );
    result = {
      status: 'retained',
      text: `Mails og øvrige hjælpedata om fuldmagt ${req.poa_label} er slettet. Veyro har udført handlinger under fuldmagten, så selve fuldmagten (PDF), godkendelsesoplysningerne og listen over de udførte handlinger opbevares til og med ${date}. Det er nødvendigt for at kunne dokumentere, at handlingerne var aftalt, hvis der opstår uenighed (den almindelige forældelsesfrist er 3 år). Oplysningerne bruges ikke til andet, og de slettes automatisk på datoen.`,
      retainUntil: until,
    };
  }
  await db
    .prepare('UPDATE poa_deletion_requests SET status = ?, handled_at = ?, handled_by = ?, result_text = ?, retain_until = ? WHERE id = ?')
    .bind(result.status, now, by, result.text, result.retainUntil, requestId)
    .run();
  return result;
}

/** Daglig oprydning efter opbevaringspolitikken. Returnerer anmodninger, der er afsluttet nu (til kvittering). */
export async function applyRetention(db: D1Database): Promise<number[]> {
  const now = nowSec();
  const finished: number[] = [];
  // 1) Opbevaringsperioden efter en sletteanmodning er udløbet
  const { results: retained } = await db
    .prepare("SELECT id FROM poas WHERE deletion_status = 'retained' AND retain_until IS NOT NULL AND retain_until < ?")
    .bind(now)
    .all<{ id: number }>();
  for (const r of retained) {
    const { results: reqs } = await db
      .prepare("SELECT id, poa_label FROM poa_deletion_requests WHERE poa_id = ? AND status = 'retained'")
      .bind(r.id)
      .all<{ id: number; poa_label: string }>();
    await hardDelete(db, r.id);
    for (const q of reqs) {
      await db
        .prepare("UPDATE poa_deletion_requests SET status = 'completed', handled_at = ?, handled_by = 'system', result_text = ? WHERE id = ?")
        .bind(now, `Opbevaringsperioden er udløbet, og fuldmagt ${q.poa_label} er nu slettet helt i Veyros system. Data forsvinder også fra sikkerhedskopier senest ${RETENTION.backupDays} dage efter.`, q.id)
        .run();
      finished.push(q.id);
    }
  }
  // 2) Kladder, der ikke er rørt i lang tid
  await db.prepare("DELETE FROM poas WHERE status = 'draft' AND updated_at < ?").bind(now - RETENTION.draftDays * 86400).run();
  // 3) Ophørte fuldmagter uden anmodning: uden handlinger efter kort tid, med handlinger efter forældelsesfristen
  const { results: ended } = await db
    .prepare(
      `SELECT p.id, (SELECT COUNT(*) FROM poa_actions a WHERE a.poa_id = p.id AND a.status = 'done') AS n,
              COALESCE(p.revoked_at, p.expired_at) AS ended
       FROM poas p WHERE p.status IN ('revoked', 'expired') AND p.deletion_status = 'none'`,
    )
    .all<{ id: number; n: number; ended: number }>();
  for (const e of ended) {
    const days = e.n > 0 ? RETENTION.withActionsDays : RETENTION.withoutActionsDays;
    if (e.ended && e.ended + days * 86400 < now) await hardDelete(db, e.id);
  }
  return finished;
}

export { randomToken };
