// Digitale fortrolighedsaftaler (NDA) mellem Veyro og kunden. Se docs/FORTROLIGHEDSAFTALER.md.
// Al adgangskontrol sker på serveren: kunden slår kun op med sit eget kunde-id, og Veyros godkendelse kræver rollen i NDA_SIGNERS.
import type { Env } from '../env';
import { nowSec, sha256Hex } from './crypto';
import { normalizeEmail } from './db';
import { DEFAULT_TEMPLATE_BODY, DEFAULT_TEMPLATE_FOOTNOTE, NDA_SUBTITLE, NDA_TITLE, parseTemplate } from './nda-template';
import { formatDay, getSettings, isDate, isTestEnv, todayDk, type PoaSettings } from './poa';
import { isAdmin } from './session';

export { formatDay, isDate, todayDk };

// ---------- Tekster ----------

export const SUMMARY =
  'Aftalen beskytter både din virksomheds og Veyros fortrolige oplysninger i det beskrevne samarbejde. Det omfatter blandt andet kundedata, priser, kode, systemoplysninger og adgangsoplysninger.';

/** Vilkår, kunden særligt gøres opmærksom på før godkendelse (fra aftalens punkt 2 og 4). */
export const NOTICES: { title: string; text: string }[] = [
  {
    title: 'Underleverandører',
    text: 'Nødvendige rådgivere samt hosting- og andre underleverandører må kun få relevante oplysninger under tilsvarende fortrolighed. Modtager er ansvarlig for, at de overholder aftalen (punkt 2).',
  },
  {
    title: 'AI-tjenester',
    text: 'Fortrolige oplysninger må ikke bruges til træning af generelle AI-modeller uden særskilt skriftlig tilladelse, og brug af eksterne AI-tjenester til behandling af oplysningerne kræver Afgivers forudgående skriftlige godkendelse (punkt 2).',
  },
  {
    title: 'Tilbagelevering og sletning',
    text: 'Efter skriftlig anmodning eller ved samarbejdets ophør skal oplysninger og kopier returneres eller slettes efter Afgivers valg. Visse oplysninger må beholdes, når det er nødvendigt, og kopier i sikkerhedskopier slettes ved den dokumenterede backupcyklus (punkt 4).',
  },
  {
    title: 'Varighed',
    text: 'Fortroligheden gælder under samarbejdet og i fem år efter det seneste af samarbejdets eller aftalens ophør. Forretningshemmeligheder er beskyttet, så længe de har den karakter (punkt 4).',
  },
];

export const CONFIRMATIONS = [
  'Jeg har læst og accepterer fortrolighedsaftalen.',
  'Jeg bekræfter, at jeg er bemyndiget til at indgå aftalen på virksomhedens vegne.',
] as const;

export const TERMINATE_TEXT =
  'Du afslutter aftalen for fremtidig udveksling af oplysninger. Fortrolighedsforpligtelserne for allerede modtagne oplysninger fortsætter efter aftalens vilkår. Handlingen opsiger ikke i sig selv dit abonnement, projekt eller øvrige aftaler med Veyro.';

export const CONTINUING_TEXT =
  'Fortrolighedsforpligtelserne for oplysninger, der allerede er udvekslet, fortsætter efter aftalens punkt 4. Forretningshemmeligheder er beskyttet, så længe oplysningerne har denne karakter, og oplysninger i kopier, der beholdes, er fortrolige, så længe kopierne findes. Ophør eller sletning i portalen gør ikke oplysninger frie til brug.';

export const DELETE_DOC_TEXT =
  'Sletning af aftaledokumentet i portalen ophæver ikke aftalens forpligtelser. Fortroligheden for oplysninger, der allerede er udvekslet, fortsætter efter aftalens vilkår.';

/** Beskrivelse af godkendelsesmetoden. Det er bevidst ikke en MitID-underskrift og ikke bevis for tegningsret. */
export function approvalMethodText(email: string): string {
  return `Digital godkendelse i Veyros kundeportal: indlogget med engangslink sendt til ${email} og bekræftet med en engangskode sendt til samme e-mail. Ikke en MitID-underskrift og ikke dokumentation for tegningsret.`;
}

// ---------- Status ----------

export type NdaStatus = 'draft' | 'awaiting_customer' | 'awaiting_veyro' | 'active' | 'terminated';
export const STATUS_LABEL: Record<NdaStatus, string> = {
  draft: 'Kladde',
  awaiting_customer: 'Afventer kunden',
  awaiting_veyro: 'Afventer Veyro',
  active: 'Aktiv',
  terminated: 'Ophørt for fremtidig udveksling',
};
export const STATUS_TONE: Record<NdaStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  draft: 'neutral',
  awaiting_customer: 'warn',
  awaiting_veyro: 'warn',
  active: 'ok',
  terminated: 'err',
};

export const COOPERATION_LABEL: Record<string, string> = {
  unknown: 'Ikke registreret',
  ongoing: 'Samarbejdet er i gang',
  ended: 'Samarbejdet er ophørt',
  never_started: 'Samarbejdet blev ikke indledt',
};

export type Party = 'kunde' | 'veyro';

// ---------- Rækker ----------

export interface NdaRow {
  id: number;
  number: string;
  customer_id: number;
  status: NdaStatus;
  deletion_status: 'none' | 'requested' | 'retained';
  current_version: number;
  company_name: string | null;
  project: string | null;
  effective_at: number | null;
  terminated_at: number | null;
  terminated_by: string | null;
  terminated_party: Party | null;
  termination_notice: string | null;
  cooperation: 'unknown' | 'ongoing' | 'ended' | 'never_started';
  cooperation_ended_on: string | null;
  cooperation_updated_at: number | null;
  cooperation_updated_by: string | null;
  retain_until: number | null;
  idem_key: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: number;
  nda_id: number;
  version: number;
  state: 'draft' | 'sent' | 'approved' | 'superseded';
  form_json: string;
  template_version: number;
  snapshot_json: string | null;
  content_hash: string | null;
  sent_at: number | null;
  sent_by: string | null;
  customer_name: string | null;
  customer_title: string | null;
  customer_company: string | null;
  customer_email: string | null;
  customer_method: string | null;
  customer_approved_at: number | null;
  veyro_name: string | null;
  veyro_title: string | null;
  veyro_company: string | null;
  veyro_email: string | null;
  veyro_method: string | null;
  veyro_approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export function label(n: Pick<NdaRow, 'number'>, v?: Pick<VersionRow, 'version'> | number): string {
  const ver = typeof v === 'number' ? v : v?.version;
  return ver ? `${n.number} version ${ver}` : n.number;
}

export async function getNda(db: D1Database, id: number): Promise<NdaRow | null> {
  return db.prepare('SELECT * FROM ndas WHERE id = ?').bind(id).first<NdaRow>();
}
export async function getNdaForCustomer(db: D1Database, id: number, customerId: number): Promise<NdaRow | null> {
  return db.prepare('SELECT * FROM ndas WHERE id = ? AND customer_id = ?').bind(id, customerId).first<NdaRow>();
}

export interface NdaListRow extends NdaRow {
  customer_approved_at: number | null;
  veyro_approved_at: number | null;
  email?: string;
}

const LIST_SQL = `SELECT n.*, v.customer_approved_at, v.veyro_approved_at, c.email FROM ndas n
  JOIN customers c ON c.id = n.customer_id
  LEFT JOIN nda_versions v ON v.nda_id = n.id AND v.version = n.current_version`;

export async function listForCustomer(db: D1Database, customerId: number): Promise<NdaListRow[]> {
  const { results } = await db.prepare(`${LIST_SQL} WHERE n.customer_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 200`).bind(customerId).all<NdaListRow>();
  return results;
}

export async function listAll(db: D1Database, status: NdaStatus | null): Promise<NdaListRow[]> {
  const stmt = db.prepare(`${LIST_SQL} ${status ? 'WHERE n.status = ?' : ''} ORDER BY n.updated_at DESC, n.id DESC LIMIT 500`);
  const { results } = await (status ? stmt.bind(status) : stmt).all<NdaListRow>();
  return results;
}

export async function listVersions(db: D1Database, ndaId: number): Promise<VersionRow[]> {
  const { results } = await db.prepare('SELECT * FROM nda_versions WHERE nda_id = ? ORDER BY version DESC').bind(ndaId).all<VersionRow>();
  return results;
}

export async function currentVersion(db: D1Database, nda: NdaRow): Promise<VersionRow> {
  const v = await db.prepare('SELECT * FROM nda_versions WHERE nda_id = ? AND version = ?').bind(nda.id, nda.current_version).first<VersionRow>();
  if (!v) throw new Error(`Version mangler for ${nda.number}`);
  return v;
}

/** Den version, der er godkendt af begge parter (den gældende aftale), hvis den findes. */
export async function approvedVersion(db: D1Database, ndaId: number): Promise<VersionRow | null> {
  return db.prepare("SELECT * FROM nda_versions WHERE nda_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1").bind(ndaId).first<VersionRow>();
}

export function hasAnyApproval(v: Pick<VersionRow, 'customer_approved_at' | 'veyro_approved_at'>): boolean {
  return !!(v.customer_approved_at || v.veyro_approved_at);
}

/** Har aftalen nogensinde haft en godkendelse (i en hvilken som helst version)? */
export async function everApproved(db: D1Database, ndaId: number): Promise<boolean> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM nda_versions WHERE nda_id = ? AND (customer_approved_at IS NOT NULL OR veyro_approved_at IS NOT NULL)')
    .bind(ndaId)
    .first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

// ---------- Hændelser ----------

export function eventStmt(db: D1Database, ndaId: number, actor: string, type: string, detail: string | null = null) {
  return db.prepare('INSERT INTO nda_events (nda_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').bind(ndaId, nowSec(), actor, type, detail);
}

export interface EventRow {
  id: number;
  at: number;
  actor: string;
  type: string;
  detail: string | null;
}
export async function listEvents(db: D1Database, ndaId: number): Promise<EventRow[]> {
  const { results } = await db.prepare('SELECT id, at, actor, type, detail FROM nda_events WHERE nda_id = ? ORDER BY at, id').bind(ndaId).all<EventRow>();
  return results;
}

export const EVENT_LABEL: Record<string, string> = {
  created: 'Kladde oprettet',
  draft_saved: 'Oplysninger gemt',
  sent: 'Sendt til godkendelse',
  reopened: 'Åbnet for rettelser',
  new_version: 'Ny version oprettet',
  otp_sent: 'Engangskode sendt',
  otp_failed: 'Forkert engangskode',
  approved_customer: 'Godkendt af kunden',
  approved_veyro: 'Godkendt af Veyro',
  activated: 'Aktiv (begge parter har godkendt)',
  terminated: 'Afsluttet for fremtidig udveksling',
  cooperation: 'Samarbejdets status registreret',
  mail_resend: 'Mail sendt igen',
  mail_failed: 'Mail kunne ikke leveres',
  task_done: 'Opgave løst',
  deletion_requested: 'Sletning af dokumentet anmodet',
  deletion_retained: 'Dokumentation opbevares',
  return_requested: 'Tilbagelevering/sletning af oplysninger anmodet',
};

// ---------- Skabeloner ----------

export interface TemplateRow {
  version: number;
  body: string;
  footnote: string;
  note: string | null;
  created_at: number;
  created_by: string;
}

/** Den nyeste skabelon. Findes ingen, oprettes version 1 fra det oprindelige dokument. */
export async function latestTemplate(db: D1Database): Promise<TemplateRow> {
  const row = await db.prepare('SELECT * FROM nda_templates ORDER BY version DESC LIMIT 1').first<TemplateRow>();
  if (row) return row;
  await db
    .prepare('INSERT OR IGNORE INTO nda_templates (version, body, footnote, note, created_at, created_by) VALUES (1, ?, ?, ?, ?, ?)')
    .bind(DEFAULT_TEMPLATE_BODY, DEFAULT_TEMPLATE_FOOTNOTE, 'Fra Veyro_fortrolighedsaftale.docx', nowSec(), 'system')
    .run();
  return (await db.prepare('SELECT * FROM nda_templates WHERE version = 1').first<TemplateRow>())!;
}

export async function getTemplate(db: D1Database, version: number): Promise<TemplateRow | null> {
  if (version === 1) await latestTemplate(db);
  return db.prepare('SELECT * FROM nda_templates WHERE version = ?').bind(version).first<TemplateRow>();
}

export async function listTemplates(db: D1Database): Promise<(TemplateRow & { uses: number })[]> {
  await latestTemplate(db);
  const { results } = await db
    .prepare('SELECT t.*, (SELECT COUNT(DISTINCT nda_id) FROM nda_versions v WHERE v.template_version = t.version) AS uses FROM nda_templates t ORDER BY version DESC')
    .all<TemplateRow & { uses: number }>();
  return results;
}

export function validateTemplate(body: string): string | null {
  const blocks = parseTemplate(body);
  if (body.trim().length < 200) return 'Teksten er for kort.';
  if (!blocks.some((b) => b.kind === 'project')) return 'Teksten skal indeholde en linje med [PROJEKT], hvor projektbeskrivelsen indsættes.';
  if (blocks.filter((b) => b.kind === 'heading').length < 3) return 'Teksten skal have afsnitsoverskrifter (linjer, der starter med "# ").';
  return null;
}

/** Ny version af standardskabelonen. Den bruges kun til aftaler, der oprettes herefter. */
export async function createTemplate(db: D1Database, args: { body: string; footnote: string; note: string; by: string }): Promise<number> {
  const latest = await latestTemplate(db);
  const r = await db
    .prepare('INSERT INTO nda_templates (version, body, footnote, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING version')
    .bind(latest.version + 1, args.body.replace(/\r\n?/g, '\n').trim(), args.footnote.trim(), args.note.trim() || null, nowSec(), args.by)
    .first<{ version: number }>();
  return r!.version;
}

// ---------- Formular ----------

export interface NdaForm {
  company_name: string;
  cvr: string;
  address: string;
  postal_code: string;
  city: string;
  contact_name: string;
  contact_email: string;
  approver_name: string;
  approver_title: string;
  project: string;
}

export const FORM_FIELDS: (keyof NdaForm)[] = [
  'company_name',
  'cvr',
  'address',
  'postal_code',
  'city',
  'contact_name',
  'contact_email',
  'approver_name',
  'approver_title',
  'project',
];

const MAX: Record<keyof NdaForm, number> = {
  company_name: 200,
  cvr: 20,
  address: 200,
  postal_code: 10,
  city: 100,
  contact_name: 120,
  contact_email: 254,
  approver_name: 120,
  approver_title: 120,
  project: 2000,
};

export function clean(v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (!multiline) s = s.replace(/\n/g, ' ');
  return s.trim().slice(0, max);
}

export function emptyForm(): NdaForm {
  return Object.fromEntries(FORM_FIELDS.map((k) => [k, ''])) as unknown as NdaForm;
}

export function readForm(body: Record<string, unknown>): NdaForm {
  const f = emptyForm();
  for (const k of FORM_FIELDS) f[k] = clean(body[k], MAX[k], k === 'project');
  f.cvr = f.cvr.replace(/\s/g, '');
  f.contact_email = f.contact_email.toLowerCase();
  return f;
}

export function parseForm(json: string | null): NdaForm {
  const f = emptyForm();
  if (!json) return f;
  try {
    const o = JSON.parse(json) as Partial<NdaForm>;
    for (const k of FORM_FIELDS) if (typeof o[k] === 'string') f[k] = o[k]!;
  } catch {
    /* tom formular */
  }
  return f;
}

export const FIELD_LABEL: Record<keyof NdaForm, string> = {
  company_name: 'Juridisk virksomhedsnavn',
  cvr: 'CVR-nummer',
  address: 'Adresse',
  postal_code: 'Postnummer',
  city: 'By',
  contact_name: 'Kontaktperson',
  contact_email: 'Kontaktpersonens e-mail',
  approver_name: 'Navn på den, der godkender',
  approver_title: 'Titel på den, der godkender',
  project: 'Projekt, hjemmeside eller system',
};

/** `complete` kræver alle felter (før godkendelse); ellers kontrolleres kun formatet af det udfyldte. */
export function validateForm(f: NdaForm, opts: { complete: boolean }): Partial<Record<keyof NdaForm, string>> {
  const e: Partial<Record<keyof NdaForm, string>> = {};
  if (opts.complete) {
    for (const k of FORM_FIELDS) if (!f[k]) e[k] = `Udfyld ${FIELD_LABEL[k].toLowerCase()}.`;
  }
  if (f.cvr && !/^\d{8}$/.test(f.cvr)) e.cvr = 'CVR-nummeret skal være 8 cifre.';
  if (f.postal_code && !/^\d{4}$/.test(f.postal_code)) e.postal_code = 'Postnummeret skal være 4 cifre.';
  if (f.contact_email && !normalizeEmail(f.contact_email)) e.contact_email = 'Skriv en gyldig e-mailadresse.';
  if (f.project && f.project.length < 10 && !e.project) e.project = 'Beskriv projektet med mindst 10 tegn.';
  return e;
}

// ---------- Veyros oplysninger og godkendere ----------

export interface VeyroInfo {
  legal_name: string;
  cvr: string;
  address: string;
  contact_name: string;
  contact_email: string;
}

export function veyroInfo(s: PoaSettings): VeyroInfo {
  return {
    legal_name: s.veyro_legal_name.trim(),
    cvr: s.veyro_cvr.trim(),
    address: s.veyro_address.trim(),
    contact_name: s.veyro_contact_name.trim(),
    contact_email: s.veyro_contact_email.trim() || 'kontakt@veyro.dk',
  };
}

/** Oplysninger, der skal være udfyldt i de centrale indstillinger, før en aftale kan sendes til godkendelse. */
export function missingVeyro(v: VeyroInfo): string[] {
  const out: string[] = [];
  if (!v.legal_name) out.push('juridisk navn');
  if (!v.cvr) out.push('CVR-nummer');
  if (!v.address) out.push('adresse');
  return out;
}

export function signerEmails(env: Env): Set<string> {
  return new Set(
    (env.NDA_SIGNERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Må e-mailen godkende fortrolighedsaftaler på Veyros vegne? Kræver både admin og rollen i NDA_SIGNERS. */
export function canSignForVeyro(env: Env, email: string | null | undefined): boolean {
  return !!email && isAdmin(env, email) && signerEmails(env).has(email.toLowerCase());
}

// ---------- Snapshot (den præcise version, der godkendes) ----------

export interface Snapshot {
  number: string;
  version: number;
  template_version: number;
  title: string;
  subtitle: string;
  body: string;
  footnote: string;
  test: string | null;
  customer: Omit<NdaForm, 'approver_name' | 'approver_title' | 'project'>;
  customer_approver: { name: string; title: string };
  veyro: VeyroInfo;
  project: string;
  summary: string;
  notices: { title: string; text: string }[];
  confirmations: string[];
}

export function parseSnapshot(v: Pick<VersionRow, 'snapshot_json'>): Snapshot | null {
  if (!v.snapshot_json) return null;
  try {
    return JSON.parse(v.snapshot_json) as Snapshot;
  } catch {
    return null;
  }
}

export function buildSnapshot(nda: Pick<NdaRow, 'number'>, ver: Pick<VersionRow, 'version'>, f: NdaForm, t: TemplateRow, veyro: VeyroInfo, env: Env): Snapshot {
  return {
    number: nda.number,
    version: ver.version,
    template_version: t.version,
    title: NDA_TITLE,
    subtitle: NDA_SUBTITLE,
    body: t.body,
    footnote: t.footnote,
    test: isTestEnv(env) ? env.TEST_LABEL || 'Testmiljø' : null,
    customer: {
      company_name: f.company_name,
      cvr: f.cvr,
      address: f.address,
      postal_code: f.postal_code,
      city: f.city,
      contact_name: f.contact_name,
      contact_email: normalizeEmail(f.contact_email) ?? f.contact_email,
    },
    customer_approver: { name: f.approver_name, title: f.approver_title },
    veyro,
    project: f.project,
    summary: SUMMARY,
    notices: NOTICES,
    confirmations: [...CONFIRMATIONS],
  };
}

export async function snapshotHash(json: string): Promise<string> {
  return sha256Hex(json);
}

/** Snapshot for visning: den låste version, hvis den findes, ellers et udkast ud fra den aktuelle formular. */
export async function viewSnapshot(env: Env, nda: NdaRow, ver: VersionRow): Promise<Snapshot> {
  const locked = parseSnapshot(ver);
  if (locked) return locked;
  const [t, s] = await Promise.all([getTemplate(env.DB, ver.template_version), getSettings(env.DB)]);
  return buildSnapshot(nda, ver, parseForm(ver.form_json), t ?? (await latestTemplate(env.DB)), veyroInfo(s), env);
}

// ---------- Oprettelse og kladder ----------

async function nextNumber(db: D1Database): Promise<string> {
  const year = todayDk().slice(0, 4);
  const row = await db
    .prepare('SELECT MAX(CAST(substr(number, 10) AS INTEGER)) AS n FROM ndas WHERE number LIKE ?')
    .bind(`NDA-${year}-%`)
    .first<{ n: number | null }>();
  return `NDA-${year}-${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * Veyro opretter en kladde til en kunde og et projekt. Kundens kendte oplysninger udfyldes på forhånd,
 * så kunden kun skal kontrollere og supplere dem. `idem` forhindrer dubletter ved dobbeltklik.
 */
export async function createNda(
  db: D1Database,
  args: { customerId: number; form: NdaForm; idem: string; by: string },
): Promise<number> {
  const existing = await db.prepare('SELECT id FROM ndas WHERE idem_key = ?').bind(args.idem).first<{ id: number }>();
  if (existing) return existing.id;
  const t = await latestTemplate(db);
  const now = nowSec();
  for (let attempt = 0; attempt < 5; attempt++) {
    const number = await nextNumber(db);
    try {
      const row = await db
        .prepare(
          `INSERT INTO ndas (number, customer_id, status, current_version, company_name, project, idem_key, created_by, created_at, updated_at)
           VALUES (?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(number, args.customerId, args.form.company_name || null, args.form.project || null, args.idem, args.by, now, now)
        .first<{ id: number }>();
      const id = row!.id;
      await db.batch([
        db
          .prepare(
            "INSERT INTO nda_versions (nda_id, version, state, form_json, template_version, created_at, updated_at) VALUES (?, 1, 'draft', ?, ?, ?, ?)",
          )
          .bind(id, JSON.stringify(args.form), t.version, now, now),
        eventStmt(db, id, args.by, 'created', `Skabelon version ${t.version}`),
      ]);
      return id;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('idem_key')) {
        const again = await db.prepare('SELECT id FROM ndas WHERE idem_key = ?').bind(args.idem).first<{ id: number }>();
        if (again) return again.id;
      }
      if (!msg.includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Kunne ikke tildele aftalenummer');
}

/** Gemmer formularen. Kun muligt, mens versionen er kladde. */
export async function saveForm(db: D1Database, nda: NdaRow, ver: VersionRow, form: NdaForm, actor: string): Promise<boolean> {
  const now = nowSec();
  const r = await db
    .prepare("UPDATE nda_versions SET form_json = ?, updated_at = ? WHERE id = ? AND state = 'draft'")
    .bind(JSON.stringify(form), now, ver.id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await db.batch([
    db.prepare('UPDATE ndas SET company_name = ?, project = ?, updated_at = ? WHERE id = ?').bind(form.company_name || null, form.project || null, now, nda.id),
    eventStmt(db, nda.id, actor, 'draft_saved'),
  ]);
  return true;
}

export interface SendCheck {
  blockers: string[];
  errors: Partial<Record<keyof NdaForm, string>>;
}

export async function sendCheck(env: Env, ver: VersionRow): Promise<SendCheck> {
  const form = parseForm(ver.form_json);
  const errors = validateForm(form, { complete: true });
  const blockers: string[] = [];
  if (Object.keys(errors).length) blockers.push('Kundens oplysninger er ikke udfyldt korrekt endnu.');
  const missing = missingVeyro(veyroInfo(await getSettings(env.DB)));
  if (missing.length) blockers.push(`Veyros ${missing.join(', ')} er ikke udfyldt i de centrale indstillinger. Veyro skal udfylde dem, før aftalen kan sendes til godkendelse.`);
  return { blockers, errors };
}

/** Låser versionen: den præcise tekst og alle oplysninger gemmes, og aftalen afventer godkendelse. */
export async function sendForApproval(env: Env, nda: NdaRow, ver: VersionRow, actor: string): Promise<SendCheck & { ok: boolean }> {
  const check = await sendCheck(env, ver);
  if (check.blockers.length) return { ...check, ok: false };
  const t = (await getTemplate(env.DB, ver.template_version)) ?? (await latestTemplate(env.DB));
  const snap = buildSnapshot(nda, ver, parseForm(ver.form_json), t, veyroInfo(await getSettings(env.DB)), env);
  const json = JSON.stringify(snap);
  const hash = await snapshotHash(json);
  const now = nowSec();
  const r = await env.DB.prepare(
    "UPDATE nda_versions SET state = 'sent', snapshot_json = ?, content_hash = ?, sent_at = ?, sent_by = ?, updated_at = ? WHERE id = ? AND state = 'draft'",
  )
    .bind(json, hash, now, actor, now, ver.id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return { ...check, ok: true }; // allerede sendt (dobbeltklik)
  await env.DB.batch([
    env.DB.prepare("UPDATE ndas SET status = 'awaiting_customer', company_name = ?, project = ?, updated_at = ? WHERE id = ? AND status = 'draft'").bind(
      snap.customer.company_name,
      snap.project,
      now,
      nda.id,
    ),
    eventStmt(env.DB, nda.id, actor, 'sent', `Version ${ver.version}. Hash: ${hash.slice(0, 16)}…`),
  ]);
  return { ...check, ok: true };
}

/**
 * Ændring efter afsendelse. Har ingen godkendt endnu, åbnes versionen igen.
 * Har én part godkendt, oprettes en ny version, som begge parter skal godkende. En aktiv aftale kan ikke ændres.
 */
export async function reopen(db: D1Database, nda: NdaRow, ver: VersionRow, actor: string): Promise<'reopened' | 'new_version' | null> {
  if (nda.status === 'active' || nda.status === 'terminated' || ver.state !== 'sent') return null;
  const now = nowSec();
  if (!hasAnyApproval(ver)) {
    const r = await db
      .prepare(
        "UPDATE nda_versions SET state = 'draft', snapshot_json = NULL, content_hash = NULL, sent_at = NULL, sent_by = NULL, updated_at = ? WHERE id = ? AND state = 'sent' AND customer_approved_at IS NULL AND veyro_approved_at IS NULL",
      )
      .bind(now, ver.id)
      .run();
    if ((r.meta.changes ?? 0) === 0) return null;
    await db.batch([
      db.prepare("UPDATE ndas SET status = 'draft', updated_at = ? WHERE id = ?").bind(now, nda.id),
      db.prepare('DELETE FROM nda_otps WHERE version_id = ?').bind(ver.id),
      eventStmt(db, nda.id, actor, 'reopened', `Version ${ver.version}`),
    ]);
    return 'reopened';
  }
  const snap = parseSnapshot(ver);
  const form: NdaForm = snap
    ? {
        ...snap.customer,
        approver_name: snap.customer_approver.name,
        approver_title: snap.customer_approver.title,
        project: snap.project,
      }
    : parseForm(ver.form_json);
  const r = await db
    .prepare("UPDATE nda_versions SET state = 'superseded', updated_at = ? WHERE id = ? AND state = 'sent'")
    .bind(now, ver.id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return null;
  await db.batch([
    db
      .prepare("INSERT INTO nda_versions (nda_id, version, state, form_json, template_version, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)")
      .bind(nda.id, ver.version + 1, JSON.stringify(form), ver.template_version, now, now),
    db.prepare("UPDATE ndas SET status = 'draft', current_version = ?, updated_at = ? WHERE id = ?").bind(ver.version + 1, now, nda.id),
    db.prepare('DELETE FROM nda_otps WHERE version_id = ?').bind(ver.id),
    eventStmt(db, nda.id, actor, 'new_version', `Version ${ver.version + 1} erstatter version ${ver.version}. Begge parter skal godkende den nye version.`),
  ]);
  return 'new_version';
}

// ---------- Engangskode ----------

export const OTP_TTL = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;

async function otpHash(versionId: number, party: Party, email: string, code: string): Promise<string> {
  return sha256Hex(`nda-otp:${versionId}:${party}:${email}:${code}`);
}

export async function createOtp(db: D1Database, versionId: number, party: Party, email: string): Promise<string> {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const code = String(arr[0]! % 1_000_000).padStart(6, '0');
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO nda_otps (version_id, party, email, code_hash, attempts, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
       ON CONFLICT(version_id, party) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, attempts = 0,
         expires_at = excluded.expires_at, created_at = excluded.created_at`,
    )
    .bind(versionId, party, email, await otpHash(versionId, party, email, code), now + OTP_TTL, now)
    .run();
  return code;
}

export async function otpPending(db: D1Database, versionId: number, party: Party, email: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT expires_at, attempts FROM nda_otps WHERE version_id = ? AND party = ? AND email = ?')
    .bind(versionId, party, email)
    .first<{ expires_at: number; attempts: number }>();
  return !!row && row.expires_at > nowSec() && row.attempts < OTP_MAX_ATTEMPTS;
}

/** Koden er bundet til versionen, parten og den indloggede konto. Efter 5 forkerte forsøg skal der sendes en ny. */
export async function checkOtp(db: D1Database, versionId: number, party: Party, email: string, code: string): Promise<'ok' | 'wrong' | 'expired' | 'missing'> {
  const row = await db
    .prepare('UPDATE nda_otps SET attempts = attempts + 1 WHERE version_id = ? AND party = ? AND email = ? RETURNING code_hash, attempts, expires_at')
    .bind(versionId, party, email)
    .first<{ code_hash: string; attempts: number; expires_at: number }>();
  if (!row) return 'missing';
  if (row.expires_at < nowSec() || row.attempts > OTP_MAX_ATTEMPTS) return 'expired';
  if (!/^\d{6}$/.test(code) || (await otpHash(versionId, party, email, code)) !== row.code_hash) return 'wrong';
  return 'ok';
}

// ---------- Godkendelse ----------

export interface Approver {
  name: string;
  title: string;
  company: string;
  email: string;
}

export interface ApproveResult {
  /** Denne godkendelse blev registreret nu (false ved dobbeltklik eller hvis versionen er ændret) */
  recorded: boolean;
  /** Aftalen blev aktiv ved denne godkendelse */
  activated: boolean;
  status: NdaStatus;
}

/**
 * Registrerer én parts godkendelse af den præcise version (kontrolleret med hash).
 * Aftalen bliver aktiv, når begge parter har godkendt; ikrafttræden er tidspunktet for den sidste godkendelse.
 */
export async function approve(db: D1Database, nda: NdaRow, ver: VersionRow, party: Party, who: Approver, hash: string): Promise<ApproveResult> {
  const now = nowSec();
  const p = party === 'kunde' ? 'customer' : 'veyro';
  const r = await db
    .prepare(
      `UPDATE nda_versions SET ${p}_name = ?, ${p}_title = ?, ${p}_company = ?, ${p}_email = ?, ${p}_method = ?, ${p}_approved_at = ?, updated_at = ?
       WHERE id = ? AND nda_id = ? AND state = 'sent' AND content_hash = ? AND ${p}_approved_at IS NULL`,
    )
    .bind(who.name, who.title, who.company, who.email, approvalMethodText(who.email), now, now, ver.id, nda.id, hash)
    .run();
  const recorded = (r.meta.changes ?? 0) > 0;
  if (recorded) {
    await db.batch([
      db.prepare('DELETE FROM nda_otps WHERE version_id = ? AND party = ?').bind(ver.id, party),
      eventStmt(db, nda.id, party === 'kunde' ? 'kunde' : who.email, party === 'kunde' ? 'approved_customer' : 'approved_veyro', `Version ${ver.version}. Metode: login + engangskode på e-mail. Hash: ${hash.slice(0, 16)}…`),
    ]);
  }
  const v = (await db.prepare('SELECT * FROM nda_versions WHERE id = ?').bind(ver.id).first<VersionRow>())!;
  let activated = false;
  if (v.customer_approved_at && v.veyro_approved_at) {
    const effective = Math.max(v.customer_approved_at, v.veyro_approved_at);
    const a = await db
      .prepare("UPDATE ndas SET status = 'active', effective_at = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_customer', 'awaiting_veyro')")
      .bind(effective, now, nda.id)
      .run();
    activated = (a.meta.changes ?? 0) > 0;
    if (activated) {
      await db.batch([
        db.prepare("UPDATE nda_versions SET state = 'approved', updated_at = ? WHERE id = ? AND state = 'sent'").bind(now, v.id),
        eventStmt(db, nda.id, 'system', 'activated', `Version ${v.version}. Ikrafttræden ved sidste godkendelse.`),
      ]);
    }
  } else if (recorded) {
    const status: NdaStatus = v.customer_approved_at ? 'awaiting_veyro' : 'awaiting_customer';
    await db.prepare("UPDATE ndas SET status = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_customer', 'awaiting_veyro')").bind(status, now, nda.id).run();
  }
  const after = (await getNda(db, nda.id))!;
  return { recorded, activated, status: after.status };
}

// ---------- Ophør for fremtidig udveksling ----------

export function terminationNoticeText(nda: NdaRow, party: Party, partyName: string, at: number): string {
  const who = party === 'kunde' ? `${partyName} (kunden)` : `${partyName} (Veyro)`;
  const when = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' }).format(
    new Date(at * 1000),
  );
  return `${who} afslutter hermed fortrolighedsaftale ${nda.number} for fremtidig udveksling af oplysninger med virkning fra ${when} (dansk tid), jf. aftalens punkt 4. Fortrolighedsforpligtelserne for allerede modtagne oplysninger fortsætter efter aftalens vilkår. Meddelelsen opsiger ikke i sig selv abonnementer, projekter eller øvrige aftaler mellem parterne.`;
}

/** Afslutter en aktiv aftale for fremtidig udveksling. Returnerer false, hvis den ikke (længere) er aktiv. */
export async function terminate(db: D1Database, nda: NdaRow, party: Party, email: string, partyName: string): Promise<boolean> {
  const now = nowSec();
  const notice = terminationNoticeText(nda, party, partyName, now);
  const r = await db
    .prepare(
      "UPDATE ndas SET status = 'terminated', terminated_at = ?, terminated_by = ?, terminated_party = ?, termination_notice = ?, updated_at = ? WHERE id = ? AND status = 'active'",
    )
    .bind(now, email, party, notice, now, nda.id)
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await eventStmt(db, nda.id, party === 'kunde' ? 'kunde' : email, 'terminated', `Af ${party === 'kunde' ? 'kunden' : 'Veyro'}`).run();
  return true;
}

export async function setCooperation(db: D1Database, nda: NdaRow, coop: NdaRow['cooperation'], endedOn: string | null, by: string): Promise<string | null> {
  if (!(coop in COOPERATION_LABEL)) return 'Vælg samarbejdets status.';
  if (coop === 'ended' && (!endedOn || !isDate(endedOn))) return 'Angiv datoen for samarbejdets ophør.';
  if (coop === 'ended' && endedOn! > todayDk()) return 'Datoen for samarbejdets ophør kan ikke ligge i fremtiden.';
  const now = nowSec();
  await db.batch([
    db
      .prepare('UPDATE ndas SET cooperation = ?, cooperation_ended_on = ?, cooperation_updated_at = ?, cooperation_updated_by = ?, updated_at = ? WHERE id = ?')
      .bind(coop, coop === 'ended' ? endedOn : null, now, by, now, nda.id),
    eventStmt(db, nda.id, by, 'cooperation', `${COOPERATION_LABEL[coop]}${coop === 'ended' ? ` (${endedOn})` : ''}`),
  ]);
  return null;
}

/** Datoen (YYYY-MM-DD, dansk tid) for et tidspunkt. */
export function dayOf(sec: number): string {
  return todayDk(sec * 1000);
}

/** Lægger år til en dato. 29. februar bliver 28. februar i et ikke-skudår (samme dag i måneden ellers). */
export function addYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export interface ConfidentialityEnd {
  /** Vejledende slutdato for den almindelige femårige fortrolighed, eller null hvis den ikke kan beregnes endnu */
  date: string | null;
  basis: string;
}

/**
 * Aftalens punkt 4: fem år efter det seneste af samarbejdets ophør eller aftalens ophør.
 * Indledes et samarbejde ikke, regnes de fem år fra aftalens ophør. Kun vejledende; forretningshemmeligheder og
 * beholdte kopier kan være beskyttet længere.
 */
export function confidentialityEnd(nda: Pick<NdaRow, 'terminated_at' | 'cooperation' | 'cooperation_ended_on'>): ConfidentialityEnd {
  if (!nda.terminated_at) return { date: null, basis: 'Kan først beregnes, når aftalen er afsluttet for fremtidig udveksling, og samarbejdets ophør er registreret.' };
  const agreementEnd = dayOf(nda.terminated_at);
  if (nda.cooperation === 'never_started') {
    return { date: addYears(agreementEnd, 5), basis: `Samarbejdet blev ikke indledt, så de fem år regnes fra aftalens ophør (${formatDay(agreementEnd)}).` };
  }
  if (nda.cooperation === 'ended' && nda.cooperation_ended_on && isDate(nda.cooperation_ended_on)) {
    const latest = nda.cooperation_ended_on > agreementEnd ? nda.cooperation_ended_on : agreementEnd;
    return {
      date: addYears(latest, 5),
      basis: `Fem år efter det seneste af samarbejdets ophør (${formatDay(nda.cooperation_ended_on)}) og aftalens ophør (${formatDay(agreementEnd)}).`,
    };
  }
  return { date: null, basis: 'Kan først beregnes, når samarbejdets ophør er registreret. Fortroligheden gælder under hele samarbejdet.' };
}

// ---------- Opgaver ----------

export interface TaskRow {
  id: number;
  nda_id: number | null;
  mail_id: number | null;
  kind: string;
  note: string;
  status: 'open' | 'done';
  created_at: number;
  done_at: number | null;
  done_by: string | null;
  number?: string | null;
}

export async function listOpenTasks(db: D1Database): Promise<TaskRow[]> {
  const { results } = await db
    .prepare("SELECT t.*, n.number FROM nda_tasks t LEFT JOIN ndas n ON n.id = t.nda_id WHERE t.status = 'open' ORDER BY t.created_at")
    .all<TaskRow>();
  return results;
}
export async function listTasks(db: D1Database, ndaId: number): Promise<TaskRow[]> {
  const { results } = await db.prepare('SELECT * FROM nda_tasks WHERE nda_id = ? ORDER BY created_at').bind(ndaId).all<TaskRow>();
  return results;
}
export async function completeTask(db: D1Database, ndaId: number, taskId: number, by: string): Promise<void> {
  const r = await db
    .prepare("UPDATE nda_tasks SET status = 'done', done_at = ?, done_by = ? WHERE id = ? AND nda_id = ? AND status = 'open'")
    .bind(nowSec(), by, taskId, ndaId)
    .run();
  if ((r.meta.changes ?? 0) > 0) await eventStmt(db, ndaId, by, 'task_done').run();
}

// ---------- Sletning af kladder og dokumenter ----------

/** Sletter aftalen og alt tilknyttet (versioner, dokumenter, hændelser, mails, opgaver). Anmodninger beholdes uden kobling. */
export async function hardDelete(db: D1Database, ndaId: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE nda_requests SET nda_id = NULL WHERE nda_id = ?').bind(ndaId),
    db.prepare('DELETE FROM nda_tasks WHERE nda_id = ?').bind(ndaId),
    db.prepare('DELETE FROM nda_mails WHERE nda_id = ?').bind(ndaId),
    db.prepare('DELETE FROM nda_documents WHERE nda_id = ?').bind(ndaId),
    db.prepare('DELETE FROM nda_events WHERE nda_id = ?').bind(ndaId),
    db.prepare('DELETE FROM nda_otps WHERE version_id IN (SELECT id FROM nda_versions WHERE nda_id = ?)').bind(ndaId),
    db.prepare('DELETE FROM nda_versions WHERE nda_id = ?').bind(ndaId),
    db.prepare('DELETE FROM ndas WHERE id = ?').bind(ndaId),
  ]);
}

/** Kladder uden nogen godkendelse kan slettes direkte. */
export async function canDeleteDirectly(db: D1Database, nda: NdaRow): Promise<boolean> {
  return (nda.status === 'draft' || nda.status === 'awaiting_customer') && !(await everApproved(db, nda.id));
}

export async function deleteDraft(db: D1Database, nda: NdaRow): Promise<boolean> {
  if (!(await canDeleteDirectly(db, nda))) return false;
  await hardDelete(db, nda.id);
  return true;
}

// ---------- Anmodninger ----------

export type RequestKind = 'delete_document' | 'return_info';
export type RequestStatus = 'received' | 'in_progress' | 'completed' | 'retained' | 'rejected';

export const REQUEST_KIND_LABEL: Record<RequestKind, string> = {
  delete_document: 'Sletning af aftaledokumentet',
  return_info: 'Tilbagelevering eller sletning af delte oplysninger',
};
export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  received: 'Modtaget',
  in_progress: 'Under behandling',
  completed: 'Gennemført',
  retained: 'Gennemført – noget beholdes',
  rejected: 'Afvist',
};
export const REQUEST_STATUS_TONE: Record<RequestStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  received: 'warn',
  in_progress: 'warn',
  completed: 'ok',
  retained: 'ok',
  rejected: 'err',
};
export const CHOICE_LABEL: Record<string, string> = { return: 'Tilbagelevering', delete: 'Sletning' };

export interface RequestRow {
  id: number;
  customer_id: number;
  nda_id: number | null;
  nda_label: string;
  kind: RequestKind;
  choice: 'return' | 'delete' | null;
  description: string | null;
  status: RequestStatus;
  result_text: string | null;
  retained_info: string | null;
  retention_reason: string | null;
  retain_until: number | null;
  idem_key: string | null;
  requested_by: string;
  created_at: number;
  updated_at: number;
  handled_at: number | null;
  handled_by: string | null;
  email?: string;
}

export function requestEventStmt(db: D1Database, requestId: number, actor: string, type: string, detail: string | null = null) {
  return db.prepare('INSERT INTO nda_request_events (request_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').bind(requestId, nowSec(), actor, type, detail);
}

export const REQUEST_EVENT_LABEL: Record<string, string> = {
  created: 'Anmodning modtaget',
  in_progress: 'Under behandling',
  note: 'Bemærkning',
  completed: 'Gennemført',
  retained: 'Gennemført – noget beholdes',
  rejected: 'Afvist',
  deleted: 'Aftalen er slettet i systemet',
  auto_deleted: 'Opbevaringsperioden er udløbet; slettet',
};

export async function listRequests(db: D1Database, customerId: number | null): Promise<RequestRow[]> {
  const sql = `SELECT r.*, c.email FROM nda_requests r JOIN customers c ON c.id = r.customer_id ${customerId ? 'WHERE r.customer_id = ?' : ''}
    ORDER BY (r.status IN ('completed', 'retained', 'rejected')) ASC, r.created_at DESC, r.id DESC LIMIT 500`;
  const stmt = db.prepare(sql);
  const { results } = await (customerId ? stmt.bind(customerId) : stmt).all<RequestRow>();
  return results;
}

export async function getRequest(db: D1Database, id: number, customerId: number | null): Promise<RequestRow | null> {
  return customerId
    ? db.prepare('SELECT * FROM nda_requests WHERE id = ? AND customer_id = ?').bind(id, customerId).first<RequestRow>()
    : db.prepare('SELECT r.*, c.email FROM nda_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?').bind(id).first<RequestRow>();
}

export async function listRequestEvents(db: D1Database, requestId: number): Promise<EventRow[]> {
  const { results } = await db
    .prepare('SELECT id, at, actor, type, detail FROM nda_request_events WHERE request_id = ? ORDER BY at, id')
    .bind(requestId)
    .all<EventRow>();
  return results;
}

/** Opretter en anmodning. Samme engangsnøgle giver samme anmodning (dobbeltklik). */
export async function createRequest(
  db: D1Database,
  args: { nda: NdaRow; kind: RequestKind; choice: 'return' | 'delete' | null; description: string | null; by: string; idem: string },
): Promise<{ id: number; created: boolean }> {
  const existing = await db.prepare('SELECT id FROM nda_requests WHERE idem_key = ? AND customer_id = ?').bind(args.idem, args.nda.customer_id).first<{ id: number }>();
  if (existing) return { id: existing.id, created: false };
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO nda_requests (customer_id, nda_id, nda_label, kind, choice, description, status, idem_key, requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?) RETURNING id`,
    )
    .bind(args.nda.customer_id, args.nda.id, args.nda.number, args.kind, args.choice, args.description, args.idem, args.by, now, now)
    .first<{ id: number }>();
  const id = row!.id;
  const stmts = [
    requestEventStmt(db, id, 'kunde', 'created', args.kind === 'return_info' ? CHOICE_LABEL[args.choice ?? ''] ?? null : null),
    eventStmt(db, args.nda.id, 'kunde', args.kind === 'delete_document' ? 'deletion_requested' : 'return_requested'),
  ];
  if (args.kind === 'delete_document') {
    stmts.push(db.prepare("UPDATE ndas SET deletion_status = 'requested', updated_at = ? WHERE id = ? AND deletion_status = 'none'").bind(now, args.nda.id));
  }
  await db.batch(stmts);
  return { id, created: true };
}

/** Åben anmodning om sletning af aftaledokumentet, hvis der er en. */
export async function openDeletionRequest(db: D1Database, ndaId: number): Promise<RequestRow | null> {
  return db
    .prepare("SELECT * FROM nda_requests WHERE nda_id = ? AND kind = 'delete_document' AND status IN ('received', 'in_progress') ORDER BY id DESC LIMIT 1")
    .bind(ndaId)
    .first<RequestRow>();
}

export async function markInProgress(db: D1Database, req: RequestRow, by: string, note: string | null): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare("UPDATE nda_requests SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'received'").bind(now, req.id),
    requestEventStmt(db, req.id, by, note ? 'note' : 'in_progress', note),
  ]);
}

export interface Resolution {
  outcome: 'completed' | 'retained' | 'rejected';
  resultText: string;
  retainedInfo: string;
  retentionReason: string;
  retainUntil: string; // YYYY-MM-DD
}

/** Validerer Veyros afgørelse. Beholdes noget, skal det beskrives konkret med begrundelse og slettefrist. */
export function validateResolution(res: Resolution): string | null {
  if (!['completed', 'retained', 'rejected'].includes(res.outcome)) return 'Vælg et resultat.';
  if (res.resultText.length < 10) return 'Beskriv resultatet for kunden (mindst 10 tegn).';
  if (res.outcome === 'retained') {
    if (res.retainedInfo.length < 5) return 'Beskriv konkret, hvilke oplysninger der beholdes.';
    if (res.retentionReason.length < 10) return 'Begrund, hvorfor oplysningerne beholdes.';
    if (!isDate(res.retainUntil) || res.retainUntil <= todayDk()) return 'Angiv en slettefrist (en dato efter i dag).';
  }
  return null;
}

/** Slutdatoen (dansk tid) som unix-sekunder ved dagens slutning. */
function endOfDay(day: string): number {
  return Math.floor(new Date(`${day}T23:59:59+01:00`).getTime() / 1000);
}

/**
 * Afslutter en anmodning. For sletning af aftaledokumentet:
 *  - "completed": aftalen og alt tilknyttet slettes nu
 *  - "retained": de beskrevne oplysninger beholdes til slettefristen og slettes derefter automatisk; resten slettes nu
 * For tilbagelevering/sletning af delte oplysninger registreres Veyros bekræftelse af håndteringen.
 */
export async function resolveRequest(db: D1Database, req: RequestRow, by: string, res: Resolution): Promise<boolean> {
  const now = nowSec();
  const until = res.outcome === 'retained' ? endOfDay(res.retainUntil) : null;
  const r = await db
    .prepare(
      `UPDATE nda_requests SET status = ?, result_text = ?, retained_info = ?, retention_reason = ?, retain_until = ?, handled_at = ?, handled_by = ?, updated_at = ?
       WHERE id = ? AND status IN ('received', 'in_progress')`,
    )
    .bind(
      res.outcome,
      res.resultText,
      res.outcome === 'retained' ? res.retainedInfo : null,
      res.outcome === 'retained' ? res.retentionReason : null,
      until,
      now,
      by,
      now,
      req.id,
    )
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await requestEventStmt(db, req.id, by, res.outcome, res.outcome === 'retained' ? `Beholdes til ${res.retainUntil}` : null).run();
  if (req.kind === 'delete_document' && req.nda_id) {
    if (res.outcome === 'completed') {
      await hardDelete(db, req.nda_id);
      await requestEventStmt(db, req.id, 'system', 'deleted').run();
    } else if (res.outcome === 'retained') {
      // Hjælpedata slettes nu; dokumentation (versioner, godkendelser, PDF) beholdes til fristen
      await db.batch([
        db.prepare('DELETE FROM nda_mails WHERE nda_id = ? AND request_id IS NULL').bind(req.nda_id),
        db.prepare('DELETE FROM nda_otps WHERE version_id IN (SELECT id FROM nda_versions WHERE nda_id = ?)').bind(req.nda_id),
        db.prepare("DELETE FROM nda_tasks WHERE nda_id = ? AND status = 'done'").bind(req.nda_id),
        db.prepare("UPDATE ndas SET deletion_status = 'retained', retain_until = ?, updated_at = ? WHERE id = ?").bind(until, now, req.nda_id),
        eventStmt(db, req.nda_id, by, 'deletion_retained', `Til ${res.retainUntil}`),
      ]);
    } else {
      await db.prepare("UPDATE ndas SET deletion_status = 'none', updated_at = ? WHERE id = ? AND deletion_status = 'requested'").bind(now, req.nda_id).run();
    }
  }
  return true;
}

/** Kladder, der ikke er rørt i et år, slettes automatisk (se docs). */
export const DRAFT_RETENTION_DAYS = 365;

/** Daglig oprydning: opbevaringsfrister, der er udløbet, og gamle kladder. Returnerer afsluttede anmodninger. */
export async function applyRetention(db: D1Database): Promise<number[]> {
  const now = nowSec();
  const finished: number[] = [];
  const { results } = await db
    .prepare("SELECT id FROM ndas WHERE deletion_status = 'retained' AND retain_until IS NOT NULL AND retain_until < ?")
    .bind(now)
    .all<{ id: number }>();
  for (const r of results) {
    const { results: reqs } = await db
      .prepare("SELECT id FROM nda_requests WHERE nda_id = ? AND kind = 'delete_document' AND status = 'retained'")
      .bind(r.id)
      .all<{ id: number }>();
    await hardDelete(db, r.id);
    for (const q of reqs) {
      await requestEventStmt(db, q.id, 'system', 'auto_deleted').run();
      finished.push(q.id);
    }
  }
  const { results: drafts } = await db
    .prepare(
      `SELECT n.id FROM ndas n WHERE n.status IN ('draft', 'awaiting_customer') AND n.updated_at < ?
       AND NOT EXISTS (SELECT 1 FROM nda_versions v WHERE v.nda_id = n.id AND (v.customer_approved_at IS NOT NULL OR v.veyro_approved_at IS NOT NULL))`,
    )
    .bind(now - DRAFT_RETENTION_DAYS * 86400)
    .all<{ id: number }>();
  for (const d of drafts) await hardDelete(db, d.id);
  return finished;
}

/** Har kunden fortrolighedsaftaler eller anmodninger? (Til menupunktet "Aftaler og dokumenter".) */
export async function customerHasNdas(db: D1Database, customerId: number): Promise<boolean> {
  const r = await db
    .prepare('SELECT (SELECT COUNT(*) FROM ndas WHERE customer_id = ?1) + (SELECT COUNT(*) FROM nda_requests WHERE customer_id = ?1) AS n')
    .bind(customerId)
    .first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

// Til brug i views
export { parseTemplate };
