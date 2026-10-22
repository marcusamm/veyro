// Kunderegister: virksomheder, projekter, tjenester, versioner, forhåndsvisninger, filer, henvendelser og log.
// Alle opslag, der tager et projekt-id fra en adresse, skal også have virksomhedens id (eller medlemskab),
// så et ændret id i adressen aldrig giver adgang til en anden kundes data.
import { nowSec, randomToken, sha256Hex } from '../lib/crypto';
import { configHash, normalizeConfig, type WebsiteConfig } from './hjemmeside';
import { SERVICES, SLUG, type ProjectKind, type ServiceKey, type ServiceRow } from './tjenester';

export interface Company {
  id: string;
  name: string;
  name_key: string;
  cvr: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  website: string | null;
  industry: string | null;
  description: string | null;
  internal_note: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

export interface Project {
  id: string;
  company_id: string;
  name: string;
  slug: string;
  slug_locked: number;
  kind: ProjectKind;
  template: string | null;
  external_url: string | null;
  public_key: string;
  onboarding_step: string;
  draft: string;
  draft_updated_at: number;
  draft_updated_by: string | null;
  live_version_id: number | null;
  previous_version_id: number | null;
  offline: number;
  publish_lock: string | null;
  publish_lock_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Version {
  id: number;
  project_id: string;
  number: number;
  content: string;
  content_hash: string;
  created_at: number;
  created_by: string | null;
  approved_at: number | null;
  approved_by: string | null;
  published_at: number | null;
}

export interface DomainRow {
  id: number;
  project_id: string;
  hostname: string;
  kind: 'veyro' | 'eget';
  method: string | null;
  status: 'afventer' | 'verificerer' | 'aktiv' | 'fejlet' | 'blokeret' | 'fjernet';
  provider_id: string | null;
  records: string;
  detail: string | null;
  last_check_at: number | null;
  verified_at: number | null;
  created_at: number;
}

export const STEPS = ['virksomhed', 'type', 'indhold', 'tjenester', 'opsaetning', 'gennemgang'] as const;
export type Step = (typeof STEPS)[number];
export const STEP_LABEL: Record<Step, string> = {
  virksomhed: 'Virksomhed',
  type: 'Projekttype',
  indhold: 'Udseende og indhold',
  tjenester: 'Tjenester',
  opsaetning: 'Opsætning af tjenester',
  gennemgang: 'Gennemgang',
};

/** Navne, der allerede bruges af Veyro eller eksisterende kundesystemer, og som ikke kan blive en kundes adresse */
const RESERVED_SLUGS = new Set([
  'kunde', 'ny', 'www', 'admin', 'api', 'app', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'autodiscover', 'ns1', 'ns2', 'dns',
  'cdn', 'static', 'assets', 'status', 'preview', 'vis', 's', 'veyro', 'demo', 'test', 'staging',
  'lager', 'bestil', 'bestilling', 'ek', 'einar-kornerup', 'ek-enterprise', 'lagerstyring', 'varebestilling', 'pr3',
]);

export function newId(prefix: 'v' | 'p'): string {
  return `${prefix}_${randomToken(9).replace(/[-_]/g, 'x').toLowerCase()}`;
}

/** Navn til dubletkontrol: små bogstaver, uden selskabsform og tegn */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(aps|a\/s|as|i\/s|ivs|k\/s|p\/s|smba|amba|holding)\b/g, ' ')
    .replace(/[^a-z0-9æøå]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(aps|a s|i s|ivs)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}

export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug) || slug.length < 2 || slug.length > 40) return 'Adressen må kun indeholde små bogstaver, tal og bindestreger (2–40 tegn).';
  if (RESERVED_SLUGS.has(slug) || /-(lager|bestilling)$/.test(slug)) return `"${slug}" er reserveret og kan ikke bruges.`;
  return null;
}

export async function audit(
  db: D1Database,
  e: { actor: string; company_id?: string | null; project_id?: string | null; action: string; detail?: string | null },
): Promise<void> {
  await db
    .prepare('INSERT INTO customer_audit (at, actor, company_id, project_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(nowSec(), e.actor, e.company_id ?? null, e.project_id ?? null, e.action, e.detail ? e.detail.slice(0, 500) : null)
    .run();
}

export function auditStmt(db: D1Database, e: { actor: string; company_id?: string | null; project_id?: string | null; action: string; detail?: string | null }) {
  return db
    .prepare('INSERT INTO customer_audit (at, actor, company_id, project_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(nowSec(), e.actor, e.company_id ?? null, e.project_id ?? null, e.action, e.detail ? e.detail.slice(0, 500) : null);
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  company_id: string | null;
  project_id: string | null;
  action: string;
  detail: string | null;
}

export async function listAudit(db: D1Database, companyId: string, limit = 40): Promise<AuditRow[]> {
  return (await db.prepare('SELECT * FROM customer_audit WHERE company_id = ? ORDER BY id DESC LIMIT ?').bind(companyId, limit).all<AuditRow>()).results ?? [];
}

// ---------- Virksomheder ----------

export type CompanyInput = Omit<Company, 'id' | 'name_key' | 'created_at' | 'updated_at' | 'created_by'>;

/** Mulige dubletter: samme CVR, samme navn (uden selskabsform) eller samme e-mail */
export async function findDuplicates(db: D1Database, c: { name: string; cvr: string | null; email: string | null }, exceptId?: string): Promise<Company[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM companies WHERE (cvr IS NOT NULL AND cvr = ?1) OR name_key = ?2 OR (email IS NOT NULL AND email = ?3) ORDER BY created_at LIMIT 5`,
    )
    .bind(c.cvr, nameKey(c.name), c.email)
    .all<Company>();
  return (results ?? []).filter((r) => r.id !== exceptId);
}

export async function createCompany(db: D1Database, input: CompanyInput, by: string): Promise<string> {
  const id = newId('v');
  const now = nowSec();
  await db.batch([
    db
      .prepare(
        `INSERT INTO companies (id, name, name_key, cvr, contact_name, email, phone, address, postal_code, city, website, industry, description, internal_note, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.name, nameKey(input.name), input.cvr, input.contact_name, input.email, input.phone, input.address, input.postal_code, input.city, input.website, input.industry, input.description, input.internal_note, now, now, by),
    auditStmt(db, { actor: by, company_id: id, action: 'Virksomhed oprettet', detail: input.name }),
  ]);
  return id;
}

export async function updateCompany(db: D1Database, id: string, input: CompanyInput, by: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE companies SET name = ?, name_key = ?, cvr = ?, contact_name = ?, email = ?, phone = ?, address = ?, postal_code = ?, city = ?, website = ?, industry = ?, description = ?, internal_note = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(input.name, nameKey(input.name), input.cvr, input.contact_name, input.email, input.phone, input.address, input.postal_code, input.city, input.website, input.industry, input.description, input.internal_note, nowSec(), id),
    auditStmt(db, { actor: by, company_id: id, action: 'Virksomhedsoplysninger ændret' }),
  ]);
}

export async function getCompany(db: D1Database, id: string): Promise<Company | null> {
  return db.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first<Company>();
}

// ---------- Projekter ----------

export async function getProject(db: D1Database, companyId: string, projectId: string): Promise<Project | null> {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND company_id = ?').bind(projectId, companyId).first<Project>();
}

export async function getProjectBySlug(db: D1Database, slug: string): Promise<Project | null> {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<Project>();
}

export async function getProjectByKey(db: D1Database, key: string): Promise<Project | null> {
  return db.prepare('SELECT * FROM projects WHERE public_key = ?').bind(key).first<Project>();
}

export async function listProjects(db: D1Database, companyId: string): Promise<Project[]> {
  return (await db.prepare('SELECT * FROM projects WHERE company_id = ? ORDER BY created_at').bind(companyId).all<Project>()).results ?? [];
}

export async function slugTaken(db: D1Database, slug: string, exceptProject?: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first<{ id: string }>();
  return !!row && row.id !== exceptProject;
}

export async function createProject(
  db: D1Database,
  p: { company_id: string; name: string; slug: string; kind: ProjectKind; template: string | null; external_url: string | null; draft: WebsiteConfig | null },
  by: string,
): Promise<string> {
  const id = newId('p');
  const now = nowSec();
  await db.batch([
    db
      .prepare(
        `INSERT INTO projects (id, company_id, name, slug, kind, template, external_url, public_key, onboarding_step, draft, draft_updated_at, draft_updated_by, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, p.company_id, p.name, p.slug, p.kind, p.template, p.external_url, `pk_${randomToken(18)}`, p.kind === 'intern' ? 'tjenester' : 'indhold', JSON.stringify(p.draft ?? {}), now, by, now, now, by),
    // Hjemmesiden er altid valgt for hjemmesideprojekter, så tjenestelisten afspejler projekttypen
    ...(p.kind === 'intern' ? [] : [db.prepare(`INSERT INTO project_services (project_id, service, enabled, config, status, updated_at) VALUES (?, 'hjemmeside', 1, '{}', 'mangler', ?)`).bind(id, now)]),
    auditStmt(db, { actor: by, company_id: p.company_id, project_id: id, action: 'Projekt oprettet', detail: `${p.name} (${p.kind === 'skabelon' ? `startpunkt ${p.template}` : p.kind === 'tilsluttet' ? 'tilsluttet hjemmeside' : 'kun interne systemer'})` }),
  ]);
  return id;
}

export async function setStep(db: D1Database, projectId: string, step: string): Promise<void> {
  await db.prepare('UPDATE projects SET onboarding_step = ?, updated_at = ? WHERE id = ?').bind(step, nowSec(), projectId).run();
}

export async function updateProjectBasics(db: D1Database, p: Project, f: { name: string; slug: string; external_url: string | null }, by: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE projects SET name = ?, slug = ?, external_url = ?, updated_at = ? WHERE id = ?').bind(f.name, p.slug_locked ? p.slug : f.slug, f.external_url, nowSec(), p.id),
    auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: 'Projekt ændret', detail: f.name }),
  ]);
}

export function draftOf(p: Project): WebsiteConfig {
  try {
    return normalizeConfig(JSON.parse(p.draft || '{}'));
  } catch {
    return normalizeConfig({});
  }
}

export async function saveDraft(db: D1Database, p: Project, cfg: WebsiteConfig, by: string, what: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE projects SET draft = ?, draft_updated_at = ?, draft_updated_by = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(normalizeConfig(cfg)), nowSec(), by, nowSec(), p.id),
    auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: 'Kladde ændret', detail: what }),
  ]);
}

// ---------- Tjenester ----------

export async function getServices(db: D1Database, projectId: string): Promise<Map<ServiceKey, ServiceRow>> {
  const { results } = await db.prepare('SELECT * FROM project_services WHERE project_id = ?').bind(projectId).all<ServiceRow>();
  return new Map((results ?? []).filter((r) => r.service in SERVICES).map((r) => [r.service, r]));
}

export function serviceConfig(row: ServiceRow | undefined): Record<string, any> {
  try {
    return row ? JSON.parse(row.config) : {};
  } catch {
    return {};
  }
}

export function enabledSet(services: Map<ServiceKey, ServiceRow>): Set<ServiceKey> {
  return new Set([...services.values()].filter((r) => r.enabled).map((r) => r.service));
}

/** Slår tjenester til/fra. Fra = enabled 0; opsætning og data bevares, så den kan slås til igen. */
export async function setEnabledServices(db: D1Database, p: Project, wanted: Set<ServiceKey>, by: string): Promise<void> {
  const current = await getServices(db, p.id);
  const now = nowSec();
  const stmts: D1PreparedStatement[] = [];
  for (const key of Object.keys(SERVICES) as ServiceKey[]) {
    const row = current.get(key);
    const on = wanted.has(key);
    if (row && !!row.enabled === on) continue;
    if (!row && !on) continue;
    if (row) stmts.push(db.prepare('UPDATE project_services SET enabled = ?, updated_at = ? WHERE project_id = ? AND service = ?').bind(on ? 1 : 0, now, p.id, key));
    else stmts.push(db.prepare(`INSERT INTO project_services (project_id, service, enabled, config, status, updated_at) VALUES (?, ?, 1, '{}', 'mangler', ?)`).bind(p.id, key, now));
    stmts.push(auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: on ? 'Tjeneste slået til' : 'Tjeneste slået fra (data bevaret)', detail: SERVICES[key].label }));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function saveServiceConfig(db: D1Database, p: Project, key: ServiceKey, config: Record<string, unknown>, status: string, detail: string | null, by: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE project_services SET config = ?, status = CASE WHEN status IN (\'forbundet\', \'afventer\') AND ?2 = \'klar\' THEN status ELSE ?2 END, status_detail = ?, updated_at = ? WHERE project_id = ? AND service = ?')
      .bind(JSON.stringify(config), status, detail, nowSec(), p.id, key),
    auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: 'Tjenesteopsætning gemt', detail: SERVICES[key].label }),
  ]);
}

export async function setServiceStatus(db: D1Database, projectId: string, key: ServiceKey, status: string, detail: string | null, extra: { provisioned_url?: string | null } = {}): Promise<void> {
  await db
    .prepare(
      `UPDATE project_services SET status = ?, status_detail = ?, provisioned_url = COALESCE(?, provisioned_url),
         provisioned_at = CASE WHEN ? = 'forbundet' THEN ? ELSE provisioned_at END, updated_at = ? WHERE project_id = ? AND service = ?`,
    )
    .bind(status, detail, extra.provisioned_url ?? null, status, nowSec(), nowSec(), projectId, key)
    .run();
}

// ---------- Versioner ----------

/** Låser kladden som en version og godkender den. Samme indhold giver samme version (idempotent). */
export async function approveDraft(db: D1Database, p: Project, by: string): Promise<Version> {
  const cfg = draftOf(p);
  const hash = await configHash(cfg);
  const now = nowSec();
  await db.batch([
    db
      .prepare(
        `INSERT INTO project_versions (project_id, number, content, content_hash, created_at, created_by, approved_at, approved_by)
         VALUES (?1, (SELECT COALESCE(MAX(number), 0) + 1 FROM project_versions WHERE project_id = ?1), ?2, ?3, ?4, ?5, ?4, ?5)
         ON CONFLICT (project_id, content_hash) DO UPDATE SET approved_at = COALESCE(project_versions.approved_at, excluded.approved_at), approved_by = COALESCE(project_versions.approved_by, excluded.approved_by)`,
      )
      .bind(p.id, JSON.stringify(cfg), hash, now, by),
    auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: 'Version godkendt til publicering' }),
  ]);
  return (await db.prepare('SELECT * FROM project_versions WHERE project_id = ? AND content_hash = ?').bind(p.id, hash).first<Version>())!;
}

export async function getVersion(db: D1Database, projectId: string, id: number | null): Promise<Version | null> {
  if (!id) return null;
  return db.prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?').bind(id, projectId).first<Version>();
}

export async function listVersions(db: D1Database, projectId: string): Promise<Version[]> {
  return (await db.prepare('SELECT id, project_id, number, \'\' AS content, content_hash, created_at, created_by, approved_at, approved_by, published_at FROM project_versions WHERE project_id = ? ORDER BY number DESC LIMIT 20').bind(projectId).all<Version>()).results ?? [];
}

export function versionConfig(v: Version): WebsiteConfig {
  return normalizeConfig(JSON.parse(v.content));
}

// ---------- Domæner ----------

export async function listDomains(db: D1Database, projectId: string): Promise<DomainRow[]> {
  return (await db.prepare("SELECT * FROM project_domains WHERE project_id = ? AND status != 'fjernet' ORDER BY id").bind(projectId).all<DomainRow>()).results ?? [];
}

// ---------- Forhåndsvisning ----------

export const ADMIN_PREVIEW_TTL = 12 * 3600;
export const CUSTOMER_PREVIEW_TTL = 14 * 86400;

export async function createPreviewLink(db: D1Database, p: Project, label: string, ttl: number, by: string): Promise<string> {
  const token = randomToken(24);
  await db.batch([
    db.prepare('INSERT INTO preview_links (token_hash, project_id, label, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(await sha256Hex(token), p.id, label, nowSec(), by, nowSec() + ttl),
    ...(label === 'admin' ? [] : [auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: 'Kundelink til forhåndsvisning oprettet', detail: label })]),
  ]);
  return token;
}

export async function resolvePreview(db: D1Database, token: string): Promise<Project | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return db
    .prepare('SELECT p.* FROM preview_links l JOIN projects p ON p.id = l.project_id WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ?')
    .bind(await sha256Hex(token), nowSec())
    .first<Project>();
}

export interface PreviewLinkRow {
  token_hash: string;
  label: string;
  created_at: number;
  created_by: string | null;
  expires_at: number;
  revoked_at: number | null;
}

export async function listPreviewLinks(db: D1Database, projectId: string): Promise<PreviewLinkRow[]> {
  return (await db.prepare("SELECT token_hash, label, created_at, created_by, expires_at, revoked_at FROM preview_links WHERE project_id = ? AND label != 'admin' ORDER BY created_at DESC LIMIT 20").bind(projectId).all<PreviewLinkRow>()).results ?? [];
}

export async function revokePreviewLink(db: D1Database, p: Project, hash: string, by: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE preview_links SET revoked_at = ? WHERE token_hash = ? AND project_id = ? AND revoked_at IS NULL').bind(nowSec(), hash, p.id),
    auditStmt(db, { actor: by, company_id: p.company_id, project_id: p.id, action: 'Kundelink tilbagekaldt' }),
  ]);
}

// ---------- Filer ----------

export interface FileRow {
  id: number;
  name: string;
  type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export async function listFiles(db: D1Database, projectId: string): Promise<FileRow[]> {
  return (await db.prepare('SELECT id, name, type, size, width, height, created_at FROM project_files WHERE project_id = ? ORDER BY id DESC').bind(projectId).all<FileRow>()).results ?? [];
}

export async function fileIds(db: D1Database, projectId: string): Promise<Set<number>> {
  const { results } = await db.prepare('SELECT id FROM project_files WHERE project_id = ?').bind(projectId).all<{ id: number }>();
  return new Set((results ?? []).map((r) => r.id));
}

/** Et billede hentes altid sammen med projektet, så et id fra en anden kunde aldrig findes */
export async function getFile(db: D1Database, projectId: string, id: number): Promise<{ type: string; data: ArrayBuffer } | null> {
  return db.prepare('SELECT type, data FROM project_files WHERE id = ? AND project_id = ?').bind(id, projectId).first<{ type: string; data: ArrayBuffer }>();
}

// ---------- Henvendelser ----------

export interface ProjectLead {
  id: number;
  project_id: string;
  name: string | null;
  email: string;
  phone: string | null;
  message: string | null;
  page: string | null;
  test: number;
  notified_at: number | null;
  created_at: number;
}

export async function listLeads(db: D1Database, projectId: string, opts: { includeTest: boolean }, limit = 50): Promise<ProjectLead[]> {
  return (
    (await db
      .prepare(`SELECT * FROM project_leads WHERE project_id = ? ${opts.includeTest ? '' : 'AND test = 0'} ORDER BY id DESC LIMIT ?`)
      .bind(projectId, limit)
      .all<ProjectLead>()).results ?? []
  );
}

// ---------- Kundens brugere ----------

export async function companiesForMember(db: D1Database, email: string): Promise<Company[]> {
  return (await db.prepare('SELECT c.* FROM companies c JOIN company_members m ON m.company_id = c.id WHERE m.email = ? ORDER BY c.name').bind(email).all<Company>()).results ?? [];
}

/** Projektet, hvis e-mailen er bruger hos den virksomhed, der ejer det. Ellers null. */
export async function projectForMember(db: D1Database, email: string, projectId: string): Promise<Project | null> {
  return db
    .prepare('SELECT p.* FROM projects p JOIN company_members m ON m.company_id = p.company_id WHERE p.id = ? AND m.email = ?')
    .bind(projectId, email)
    .first<Project>();
}

export async function listMembers(db: D1Database, companyId: string): Promise<{ email: string; role: string; invited_at: number; invited_by: string | null }[]> {
  return (await db.prepare('SELECT email, role, invited_at, invited_by FROM company_members WHERE company_id = ? ORDER BY email').bind(companyId).all<any>()).results ?? [];
}
