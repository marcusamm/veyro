// Tjek før publicering, publicering, tilbagerulning og status.
// En publicering skifter den aktive version i én databaseoperation. Fejler et trin før skiftet, bliver den
// nuværende version stående. Fejler kontrollen efter skiftet, rulles der automatisk tilbage til den forrige version.
// Tilbagerulning skifter kun hjemmesidens indhold; data i databaser (henvendelser, ordrer, lager) ændres ikke.
import type { Env } from '../env';
import { nowSec, randomToken } from '../lib/crypto';
import { describeError } from '../lib/errlog';
import { checkDomain, domainsConfigured, externalSiteUrl, setupDomain, veyroHost } from './domaener';
import { configHash, findPage, PLACEHOLDER, RenderError, renderPage, type WebsiteConfig } from './hjemmeside';
import {
  auditStmt,
  draftOf,
  enabledSet,
  fileIds,
  getServices,
  getVersion,
  listDomains,
  serviceConfig,
  versionConfig,
  type Company,
  type DomainRow,
  type Project,
  type Version,
} from './model';
import { SERVICES, validateService, type ServiceKey, type ServiceRow } from './tjenester';

export type CheckStatus = 'ok' | 'fejl' | 'advarsel' | 'info';
export interface Check {
  label: string;
  status: CheckStatus;
  message: string;
  /** Trin i opsætningen, hvor det rettes */
  fix?: string;
}

const SECRET_PATTERNS = [
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{6,}/,
  /\bwhsec_[A-Za-z0-9]{6,}/,
  /\bre_[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const DEMO_PATTERNS = [/lorem ipsum/i, /@example\.(com|dk|org)/i, /\bUDFYLD\b/, /\btestkunde\b/i, /\bdemo ?data\b/i];

export function publicServicesFrom(services: Map<ServiceKey, ServiceRow>): { contact: boolean; orderUrl: string | null } {
  const contact = services.get('kontaktformular');
  const order = services.get('varebestilling');
  return {
    contact: !!contact?.enabled && (serviceConfig(contact).recipients?.length ?? 0) > 0,
    orderUrl: order?.enabled && order.status === 'forbundet' && order.provisioned_url ? order.provisioned_url : null,
  };
}

function textOf(cfg: WebsiteConfig): string[] {
  const out: string[] = [cfg.info.name, cfg.info.tagline, cfg.info.address, cfg.info.opening_hours, cfg.brand.logo_alt];
  for (const p of cfg.pages) {
    out.push(p.title, p.seo_title, p.seo_description);
    for (const x of p.sections) out.push(x.heading, x.text, x.image_alt, x.button_label, x.button_href, ...x.items.flatMap((i) => [i.title, i.text]));
  }
  return out.filter(Boolean);
}

function where(cfg: WebsiteConfig, re: RegExp): string[] {
  const hits: string[] = [];
  if (textOf({ ...cfg, pages: [] }).some((t) => re.test(t))) hits.push('Oplysninger på hjemmesiden');
  for (const p of cfg.pages) {
    const fields = [p.title, p.seo_title, p.seo_description, ...p.sections.flatMap((x) => [x.heading, x.text, x.image_alt, x.button_label, x.button_href, ...x.items.flatMap((i) => [i.title, i.text])])];
    if (fields.some((t) => re.test(t))) hits.push(`siden "${p.title}"`);
  }
  return hits;
}

/** Alle tjek for en version. Tjekkene ændrer intet. */
export async function runChecks(env: Env, db: D1Database, company: Company, p: Project, version: Version | null): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (label: string, status: CheckStatus, message: string, fix?: string) => checks.push({ label, status, message, fix });
  const services = await getServices(db, p.id);
  const enabled = enabledSet(services);

  if (!company.name) add('Virksomhed', 'fejl', 'Virksomheden mangler et navn.', 'virksomhed');

  if (!version) {
    add('Godkendt version', 'fejl', 'Ingen version er godkendt. Gennemgå forhåndsvisningen, og klik "Godkend denne version".', 'gennemgang');
    return checks;
  }
  // id 0 = kladden, der endnu ikke er godkendt (number er den senest godkendte version)
  if (!version.approved_at) {
    add('Godkendt version', 'fejl', version.id
      ? `Version ${version.number} er ikke godkendt.`
      : version.number
        ? `Kladden er ændret efter godkendelsen af version ${version.number}. Gennemgå forhåndsvisningen, og klik "Godkend denne version" for at tage ændringerne med.`
        : 'Kladden er ikke godkendt endnu. Gennemgå forhåndsvisningen, og klik "Godkend denne version".', 'gennemgang');
  }
  else {
    const draftHash = await configHash(draftOf(p));
    if (draftHash !== version.content_hash) add('Godkendt version', 'advarsel', `Kladden er ændret efter godkendelsen af version ${version.number}. Ændringerne kommer ikke med; godkend kladden igen for at tage dem med.`, 'gennemgang');
    else add('Godkendt version', 'ok', `Version ${version.number} er godkendt og svarer til kladden.`);
  }
  const cfg = versionConfig(version);

  // Oplysninger
  if (!cfg.info.name) add('Oplysninger', 'fejl', 'Navnet, der vises på hjemmesiden, mangler.', 'indhold');
  else if (!cfg.info.email && !cfg.info.phone && p.kind === 'skabelon') add('Oplysninger', 'fejl', 'Hjemmesiden viser hverken telefon eller e-mail. Udfyld mindst én under "Oplysninger på hjemmesiden".', 'indhold');
  else add('Oplysninger', 'ok', 'Navn og kontaktoplysninger er udfyldt.');

  if (p.kind === 'skabelon') {
    // Sider og indhold
    const front = findPage(cfg, '');
    if (!front || !front.sections.length) add('Sider', 'fejl', 'Forsiden har intet indhold.', 'indhold');
    const noDesc = cfg.pages.filter((x) => !x.seo_description).map((x) => `"${x.title}"`);
    if (noDesc.length) add('Sidetitler og beskrivelser', front && !front.seo_description ? 'fejl' : 'advarsel', `Mangler Google-beskrivelse på ${noDesc.join(', ')}.`, 'indhold');
    else add('Sidetitler og beskrivelser', 'ok', 'Alle sider har titel og beskrivelse.');
    const ph = where(cfg, PLACEHOLDER);
    if (ph.length) add('Pladsholdere', 'fejl', `Der står stadig tekst i [[klammer]] på ${ph.join(', ')}. Skriv kundens egen tekst, eller fjern sektionen.`, 'indhold');
    else add('Pladsholdere', 'ok', 'Ingen pladsholdertekst.');
    const demo = DEMO_PATTERNS.flatMap((re) => where(cfg, re));
    if (demo.length) add('Demodata', 'fejl', `Der er eksempel- eller testtekst på ${[...new Set(demo)].join(', ')}.`, 'indhold');

    // Links mellem siderne
    const handles = new Set(cfg.pages.map((x) => x.handle));
    const broken: string[] = [];
    for (const page of cfg.pages) {
      for (const x of page.sections) {
        const h = x.button_href;
        if (!x.button_label || !h) continue;
        if (h.startsWith('/') && !handles.has(h.replace(/^\/+|\/+$/g, '').split(/[?#]/)[0]!)) broken.push(`"${x.button_label}" på "${page.title}" → ${h}`);
        if (h === '#bestil' && !cfg.pages.some((pp) => pp.sections.some((s) => s.type === 'bestilling'))) broken.push(`"${x.button_label}" på "${page.title}" → #bestil (ingen bestillingssektion)`);
        if (!h.startsWith('/') && !h.startsWith('#') && !/^(https:\/\/|mailto:|tel:)/i.test(h)) broken.push(`"${x.button_label}" på "${page.title}" → ${h} (skal starte med /, https://, mailto: eller tel:)`);
      }
    }
    if (broken.length) add('Links', 'fejl', `Knapper peger på noget, der ikke findes: ${broken.join('; ')}.`, 'indhold');
    else add('Links', 'ok', 'Alle knapper peger på sider, der findes.');

    // Bygning: alle sider gengives med de rigtige billeder og tjenester
    const files = await fileIds(db, p.id);
    const svc = publicServicesFrom(services);
    const failed: string[] = [];
    for (const page of cfg.pages) {
      try {
        renderPage(cfg, page, { base: '', mode: 'live', services: svc, canonical: null, files, noindex: false });
      } catch (err) {
        failed.push(`"${page.title}": ${err instanceof RenderError ? err.message : describeError(err)}`);
      }
    }
    if (failed.length) add('Bygning', 'fejl', `Siderne kunne ikke bygges: ${failed.join('; ')}. Upload billedet igen, eller vælg et andet.`, 'indhold');
    else add('Bygning', 'ok', `${cfg.pages.length} ${cfg.pages.length === 1 ? 'side' : 'sider'} bygget uden fejl.`);

    // Sektioner, der kræver en tjeneste
    const hasContact = cfg.pages.some((x) => x.sections.some((s) => s.type === 'kontakt'));
    if (hasContact && !svc.contact) add('Kontaktformular', 'fejl', 'Siden har en kontaktformular, men tjenesten "Kontakt- og tilbudsformular" er ikke slået til eller har ingen modtager.', 'opsaetning');
    const hasOrder = cfg.pages.some((x) => x.sections.some((s) => s.type === 'bestilling'));
    if (hasOrder && !svc.orderUrl) add('Bestilling', 'fejl', 'Siden har en "Bestil online"-sektion, men kundens bestillingssystem er ikke udrullet og forbundet endnu.', 'opsaetning');
  }

  if (p.kind === 'tilsluttet') {
    const url = p.external_url ? externalSiteUrl(env, p.external_url) : null;
    if (!url) add('Tilsluttet hjemmeside', 'fejl', 'Angiv den færdige hjemmesides adresse (https://…).', 'type');
    else {
      try {
        const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Veyro-kontrol/1.0' } });
        const body = r.ok ? await r.text() : '';
        if (!r.ok) add('Tilsluttet hjemmeside', 'fejl', `${url} svarede HTTP ${r.status}.`, 'type');
        else {
          add('Tilsluttet hjemmeside', 'ok', `${url} svarer.`);
          if (enabled.has('kontaktformular') && !body.includes(p.public_key)) {
            add('Formular på den tilsluttede side', 'advarsel', 'Siden indeholder ikke projektets offentlige nøgle, så dens formular sender sandsynligvis ikke til Veyro endnu. Se "Integration" for koden.', 'opsaetning');
          } else if (enabled.has('kontaktformular')) add('Formular på den tilsluttede side', 'ok', 'Siden bruger projektets formular-adresse.');
        }
      } catch (err) {
        add('Tilsluttet hjemmeside', 'fejl', `${url} kunne ikke nås (${(err as Error).message}).`, 'type');
      }
    }
  }

  // Tjenester
  for (const key of enabled) {
    const problems = validateService(key, serviceConfig(services.get(key)), { kind: p.kind, enabled });
    if (problems.length) add(SERVICES[key].label, 'fejl', problems.map((x) => x.message).join(' '), 'opsaetning');
    else if ((key === 'varebestilling' || key === 'lagerstyring') && services.get(key)!.status !== 'forbundet') {
      add(SERVICES[key].label, 'advarsel', 'Opsat, men ikke udrullet endnu. Klik "Udrul tjenester" under Tjenester. Hjemmesiden kan publiceres uden.', 'opsaetning');
    } else add(SERVICES[key].label, 'ok', key === 'varebestilling' || key === 'lagerstyring' ? `Forbundet: ${services.get(key)!.provisioned_url}` : 'Opsat.');
  }

  // Hemmeligheder og interne oplysninger
  const all = textOf(cfg).join('\n');
  if (SECRET_PATTERNS.some((re) => re.test(all))) add('Hemmeligheder', 'fejl', 'Teksten ligner en API-nøgle eller anden hemmelighed. Fjern den; nøgler må aldrig stå på en hjemmeside.', 'indhold');
  else if (company.internal_note && company.internal_note.length >= 12 && all.includes(company.internal_note.slice(0, 40))) add('Interne oplysninger', 'fejl', 'Den interne note om virksomheden står på hjemmesiden.', 'indhold');
  else add('Hemmeligheder', 'ok', 'Ingen nøgler eller interne noter i det offentlige indhold. Hjemmesiden får kun offentlige oplysninger.');

  // Domæne (blokerer ikke: siden kan altid ses på sin /s/-adresse)
  if (p.kind === 'skabelon') {
    const domains = await listDomains(db, p.id);
    if (!domains.length) add('Domæne', 'info', `Intet domæne endnu. Siden kan ses på kunde.veyro.dk/s/${p.slug} efter publicering. Tilføj ${veyroHost(env, p.slug)} eller kundens eget domæne under Domæner.`);
    else if (!domainsConfigured(env)) add('Domæne', 'advarsel', 'Domænet kan ikke sættes op, før CF_API_TOKEN er sat på veyro-Workeren (engangsopsætning). Siden publiceres på /s/-adressen.');
    else add('Domæne', 'info', domains.map((d) => `${d.hostname}: ${DOMAIN_STATUS[d.status]}`).join('; '));
  }
  return checks;
}

export const DOMAIN_STATUS: Record<DomainRow['status'], string> = {
  afventer: 'Afventer opsætning',
  verificerer: 'Afventer verificering',
  aktiv: 'Verificeret og live',
  fejlet: 'Fejlet',
  blokeret: 'Kræver engangsopsætning',
  fjernet: 'Fjernet',
};

export const blocking = (checks: Check[]) => checks.filter((c) => c.status === 'fejl');

export interface Step {
  label: string;
  ok: boolean;
  detail: string;
}

export interface PublicationRow {
  id: number;
  project_id: string;
  version_id: number;
  kind: 'publicering' | 'tilbagerulning';
  status: 'koerer' | 'faerdig' | 'fejlet';
  steps: string;
  error: string | null;
  actor: string | null;
  started_at: number;
  finished_at: number | null;
}

export async function listPublications(db: D1Database, projectId: string, limit = 10): Promise<PublicationRow[]> {
  return (await db.prepare('SELECT * FROM publications WHERE project_id = ? ORDER BY id DESC LIMIT ?').bind(projectId, limit).all<PublicationRow>()).results ?? [];
}

export type PublishResult =
  | { kind: 'ok'; publication: number }
  | { kind: 'already'; message: string }
  | { kind: 'busy'; message: string }
  | { kind: 'failed'; publication: number; message: string };

const LOCK_TTL = 120;

/**
 * Publicerer (eller ruller tilbage til) en version.
 * - Dobbeltklik og genforsøg: en lås i databasen gør, at kun én publicering kører ad gangen, og en version, der
 *   allerede er live, publiceres ikke igen.
 * - Fejler et tjek eller bygningen, ændres intet ved den nuværende version.
 * - verify kontrollerer den publicerede side efter skiftet; svarer den ikke, rulles der tilbage.
 */
export async function publish(
  env: Env,
  db: D1Database,
  company: Company,
  stale: Project,
  versionId: number,
  actor: string,
  opts: { kind: 'publicering' | 'tilbagerulning'; verify: (p: Project) => Promise<{ ok: boolean; detail: string }> },
): Promise<PublishResult> {
  const version = await getVersion(db, stale.id, versionId);
  if (!version) return { kind: 'already', message: 'Versionen findes ikke for dette projekt.' };
  const already = (x: Project): PublishResult | null =>
    x.live_version_id === version.id && !x.offline ? { kind: 'already', message: `Version ${version.number} er allerede publiceret. Der er ikke sket noget.` } : null;
  if (already(stale)) return already(stale)!;
  if (opts.kind === 'tilbagerulning' && !version.published_at) return { kind: 'already', message: 'Der kan kun rulles tilbage til en version, der har været publiceret.' };

  const now = nowSec();
  const lock = randomToken(12);
  const got = await db
    .prepare('UPDATE projects SET publish_lock = ?, publish_lock_at = ? WHERE id = ? AND (publish_lock IS NULL OR publish_lock_at < ?)')
    .bind(lock, now, stale.id, now - LOCK_TTL)
    .run();
  if (!got.meta.changes) return { kind: 'busy', message: 'En publicering kører allerede for dette projekt. Vent et øjeblik, og genindlæs siden.' };
  // Projektet læses igen efter låsen: et dobbeltklik, der ventede på den første publicering, publicerer ikke igen
  const p = (await db.prepare('SELECT * FROM projects WHERE id = ?').bind(stale.id).first<Project>())!;
  if (already(p)) {
    await db.prepare('UPDATE projects SET publish_lock = NULL, publish_lock_at = NULL WHERE id = ? AND publish_lock = ?').bind(p.id, lock).run();
    return already(p)!;
  }

  const steps: Step[] = [];
  const { meta } = await db
    .prepare("INSERT INTO publications (project_id, version_id, kind, status, steps, actor, started_at) VALUES (?, ?, ?, 'koerer', '[]', ?, ?)")
    .bind(p.id, version.id, opts.kind, actor, now)
    .run();
  const pubId = Number(meta.last_row_id);
  const release = db.prepare('UPDATE projects SET publish_lock = NULL, publish_lock_at = NULL WHERE id = ? AND publish_lock = ?').bind(p.id, lock);
  const fail = async (message: string): Promise<PublishResult> => {
    await db.batch([
      db.prepare("UPDATE publications SET status = 'fejlet', steps = ?, error = ?, finished_at = ? WHERE id = ?").bind(JSON.stringify(steps), message.slice(0, 1000), nowSec(), pubId),
      release,
      auditStmt(db, { actor, company_id: p.company_id, project_id: p.id, action: opts.kind === 'publicering' ? 'Publicering fejlede' : 'Tilbagerulning fejlede', detail: `Version ${version.number}: ${message.slice(0, 300)}` }),
    ]);
    return { kind: 'failed', publication: pubId, message };
  };

  try {
    // 1. Tjek og bygning (ændrer intet)
    const checks = await runChecks(env, db, company, p, version);
    const errors = blocking(checks);
    steps.push({ label: 'Tjek og bygning', ok: !errors.length, detail: errors.length ? errors.map((e) => `${e.label}: ${e.message}`).join(' | ') : `${checks.length} tjek gennemført.` });
    if (errors.length) return await fail(`Publiceringen blev stoppet, før noget blev ændret. ${errors.length} ${errors.length === 1 ? 'fejl' : 'fejl'} skal rettes.`);

    // 2. Skift aktiv version (én databaseoperation)
    const previous = p.live_version_id && p.live_version_id !== version.id ? p.live_version_id : p.previous_version_id;
    await db.batch([
      db.prepare('UPDATE projects SET previous_version_id = ?, live_version_id = ?, offline = 0, slug_locked = 1, updated_at = ? WHERE id = ? AND publish_lock = ?').bind(previous, version.id, nowSec(), p.id, lock),
      db.prepare('UPDATE project_versions SET published_at = COALESCE(published_at, ?) WHERE id = ?').bind(nowSec(), version.id),
      db.prepare('UPDATE project_services SET status = \'forbundet\', status_detail = NULL, updated_at = ? WHERE project_id = ? AND service IN (\'hjemmeside\', \'kontaktformular\') AND enabled = 1').bind(nowSec(), p.id),
    ]);
    steps.push({ label: 'Version aktiveret', ok: true, detail: `Version ${version.number} er nu den aktive version.` });

    // 3. Kontrol af den publicerede side
    const live = (await db.prepare('SELECT * FROM projects WHERE id = ?').bind(p.id).first<Project>())!;
    const check = await opts.verify(live);
    steps.push({ label: 'Kontrol af den publicerede side', ok: check.ok, detail: check.detail });
    if (!check.ok) {
      await db.batch([
        db.prepare('UPDATE projects SET live_version_id = ?, previous_version_id = ?, offline = ?, updated_at = ? WHERE id = ?').bind(p.live_version_id, p.previous_version_id, p.offline, nowSec(), p.id),
      ]);
      steps.push({ label: 'Automatisk tilbagerulning', ok: true, detail: p.live_version_id ? 'Den tidligere version er aktiv igen.' : 'Siden er ikke publiceret.' });
      return await fail(`Den publicerede side svarede ikke korrekt (${check.detail}). Den tidligere version er bevaret.`);
    }

    // 4. Domæner (blokerer ikke publiceringen)
    if (p.kind === 'skabelon') {
      for (const d of await listDomains(db, p.id)) {
        const after = d.status === 'aktiv' || d.status === 'verificerer' ? await checkDomain(env, db, d, live, actor) : await setupDomain(env, db, d, live, actor);
        steps.push({ label: `Domæne ${d.hostname}`, ok: after.status === 'aktiv', detail: `${DOMAIN_STATUS[after.status]}${after.detail ? `: ${after.detail}` : ''}` });
      }
    }

    await db.batch([
      db.prepare("UPDATE publications SET status = 'faerdig', steps = ?, finished_at = ? WHERE id = ?").bind(JSON.stringify(steps), nowSec(), pubId),
      release,
      auditStmt(db, { actor, company_id: p.company_id, project_id: p.id, action: opts.kind === 'publicering' ? 'Version publiceret' : 'Rullet tilbage', detail: `Version ${version.number}` }),
    ]);
    return { kind: 'ok', publication: pubId };
  } catch (err) {
    steps.push({ label: 'Uventet fejl', ok: false, detail: describeError(err).slice(0, 300) });
    // Er versionen nået at blive skiftet, men noget fejlede bagefter, sættes den tidligere version tilbage
    await db.prepare('UPDATE projects SET live_version_id = ?, previous_version_id = ?, offline = ? WHERE id = ? AND publish_lock = ?').bind(p.live_version_id, p.previous_version_id, p.offline, p.id, lock).run().catch(() => {});
    return fail('Der opstod en uventet fejl. Den tidligere version er bevaret. Prøv igen.');
  }
}

/** Den samlede publiceringsstatus, som den vises i oversigten */
export function publicationState(p: Project, domains: DomainRow[]): { label: string; tone: 'ok' | 'warn' | 'err' | 'neutral' } {
  if (p.kind === 'intern') return { label: 'Ingen hjemmeside', tone: 'neutral' };
  if (p.offline) return { label: 'Taget offline', tone: 'warn' };
  if (!p.live_version_id) return { label: p.kind === 'skabelon' ? 'Forhåndsvisning tilgængelig' : 'Ikke kontrolleret', tone: 'neutral' };
  if (p.kind === 'tilsluttet') return { label: 'Tilsluttet og kontrolleret', tone: 'ok' };
  const eget = domains.find((d) => d.kind === 'eget');
  const veyro = domains.find((d) => d.kind === 'veyro');
  if (eget?.status === 'aktiv') return { label: 'Live på verificeret eget domæne', tone: 'ok' };
  if (veyro?.status === 'aktiv') return { label: eget ? 'Live på veyro.dk · eget domæne afventer' : 'Live på veyro.dk-underdomæne', tone: eget ? 'warn' : 'ok' };
  if (eget) return { label: 'Udrullet · eget domæne afventer opsætning', tone: 'warn' };
  return { label: 'Udrullet (kunde.veyro.dk/s/…)', tone: 'ok' };
}
