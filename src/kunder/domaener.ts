// Domæner til kundehjemmesider via Cloudflares API.
//
// - <adresse>.veyro.dk og domæner, hvis DNS ligger i Veyros Cloudflare-konto: Workers Custom Domain på veyro-Workeren.
//   Cloudflare opretter selv DNS-posten og certifikatet. Ejerskab er givet, fordi zonen ligger i kontoen.
// - Domæner med DNS andre steder: Cloudflare for SaaS (custom hostname), kun hvis det er sat op én gang
//   (KUNDESIDE_SAAS_CNAME). DNS-posterne, kunden skal oprette, er dem, Cloudflare returnerer. Intet opfindes.
// Et domæne markeres først som aktivt, når Cloudflare bekræfter det, DNS peger rigtigt, og siden svarer over HTTPS
// med netop dette projekts id.
import type { Env } from '../env';
import { nowSec } from '../lib/crypto';
import { auditStmt, type DomainRow, type Project } from './model';

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function kundeDomaene(env: Env): string {
  return (env.KUNDESIDE_DOMAENE || 'veyro.dk').toLowerCase();
}

export function veyroHost(env: Env, slug: string): string {
  return `${slug}.${kundeDomaene(env)}`;
}

/** Værtsnavne, der aldrig må knyttes til en kunde */
function reservedHosts(env: Env): Set<string> {
  const app = env.APP_URL ? safeHost(env.APP_URL) : null;
  const site = (env.SITE_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase());
  return new Set([kundeDomaene(env), `www.${kundeDomaene(env)}`, ...(app ? [app] : []), ...site].filter(Boolean));
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return h;
}

export function hostProblem(env: Env, host: string, kind: 'veyro' | 'eget'): string | null {
  if (!HOST.test(host)) return `"${host}" er ikke et gyldigt domænenavn. Skriv fx www.firma.dk.`;
  if (reservedHosts(env).has(host)) return `${host} bruges af Veyro selv og kan ikke knyttes til en kunde.`;
  const base = kundeDomaene(env);
  if (kind === 'eget' && (host === base || host.endsWith(`.${base}`))) return `Adresser på ${base} oprettes automatisk ud fra projektets adresse.`;
  return null;
}

/**
 * Adressen på en tilsluttet (specialbygget) hjemmeside: altid https. Kun ved lokal udvikling, hvor kundepanelet selv
 * kører på http://127.0.0.1 eller localhost, accepteres en lokal http-adresse.
 */
export function externalSiteUrl(env: Env, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = (h: string) => h === '127.0.0.1' || h === 'localhost';
  const devApp = (() => {
    try {
      const a = new URL(env.APP_URL);
      return a.protocol === 'http:' && local(a.hostname);
    } catch {
      return false;
    }
  })();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local(u.hostname) && devApp)) return null;
  if (u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export function domainsConfigured(env: Env): boolean {
  return !!env.CF_API_TOKEN;
}

// ---------- Cloudflare API ----------

interface CfResult<T> {
  ok: boolean;
  status: number;
  result: T | null;
  error: string | null;
}

async function cf<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<CfResult<T>> {
  const base = (env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, result: null, error: `Cloudflare svarede ikke (${(err as Error).message})` };
  }
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } | null;
  if (!res.ok || !json?.success) {
    // Kun Cloudflares fejlbesked (aldrig nøglen eller forespørgslen)
    const msg = json?.errors?.map((e) => `${e.message ?? 'Ukendt fejl'}${e.code ? ` (${e.code})` : ''}`).join('; ') || `HTTP ${res.status}`;
    const hint = res.status === 401 || res.status === 403 ? ' Nøglen mangler sandsynligvis en tilladelse (se docs/KUNDEOPSAETNING.md).' : '';
    return { ok: false, status: res.status, result: null, error: `Cloudflare: ${msg}.${hint}` };
  }
  return { ok: true, status: res.status, result: json.result ?? null, error: null };
}

interface Zone {
  id: string;
  name: string;
  account: { id: string };
}

/** Den zone i Veyros konto, som værtsnavnet hører til (længste match), eller null */
async function zoneFor(env: Env, host: string): Promise<{ zone: Zone | null; error: string | null }> {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    const r = await cf<Zone[]>(env, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    if (!r.ok) return { zone: null, error: r.error };
    if (r.result?.length) return { zone: r.result[0]!, error: null };
  }
  return { zone: null, error: null };
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: string;
}

type Update = Partial<Pick<DomainRow, 'method' | 'status' | 'provider_id' | 'detail' | 'verified_at'>> & { records?: DnsRecord[] };

async function update(db: D1Database, row: DomainRow, u: Update, audit?: { actor: string; company_id: string; action: string }): Promise<DomainRow> {
  const next = { ...row, ...u, records: u.records ? JSON.stringify(u.records) : row.records, last_check_at: nowSec() };
  await db.batch([
    db
      .prepare('UPDATE project_domains SET method = ?, status = ?, provider_id = ?, records = ?, detail = ?, verified_at = ?, last_check_at = ? WHERE id = ?')
      .bind(next.method, next.status, next.provider_id, next.records, next.detail ? next.detail.slice(0, 500) : null, next.verified_at, next.last_check_at, row.id),
    ...(audit ? [auditStmt(db, { actor: audit.actor, company_id: audit.company_id, project_id: row.project_id, action: audit.action, detail: `${row.hostname}: ${next.status}${next.detail ? ` – ${next.detail.slice(0, 200)}` : ''}` })] : []),
  ]);
  return next as DomainRow;
}

/**
 * Knytter domænet til veyro-Workeren. Kan køres igen uden at oprette dubletter:
 * Workers Custom Domains bruger PUT (samme værtsnavn = samme binding), og et eksisterende custom hostname genbruges.
 */
export async function setupDomain(env: Env, db: D1Database, row: DomainRow, p: Project, actor: string): Promise<DomainRow> {
  const log = { actor, company_id: p.company_id, action: 'Domæneopsætning' };
  if (!domainsConfigured(env)) {
    return update(db, row, { status: 'blokeret', detail: 'Kræver engangsopsætning: Cloudflare-nøglen CF_API_TOKEN er ikke sat på veyro-Workeren. Domænet er gemt og sættes op, når nøglen findes.' }, log);
  }
  const { zone, error } = await zoneFor(env, row.hostname);
  if (error) return update(db, row, { status: 'fejlet', detail: error }, log);
  if (zone) {
    const r = await cf<{ id: string }>(env, 'PUT', `/accounts/${zone.account.id}/workers/domains`, {
      environment: 'production',
      hostname: row.hostname,
      service: env.CF_WORKER_NAME || 'veyro',
      zone_id: zone.id,
    });
    if (!r.ok) return update(db, row, { method: 'workers_domain', status: 'fejlet', detail: r.error }, log);
    return update(db, row, {
      method: 'workers_domain',
      status: 'verificerer',
      provider_id: `${zone.account.id}:${r.result?.id ?? ''}`,
      records: [],
      detail: `Domænet ligger i Veyros Cloudflare-konto (${zone.name}). Cloudflare opretter selv DNS-post og certifikat; det tager normalt få minutter.`,
    }, log);
  }
  if (row.kind === 'veyro') {
    return update(db, row, { status: 'fejlet', detail: `Fandt ikke zonen ${kundeDomaene(env)} i Cloudflare. Nøglen mangler sandsynligvis adgangen Zone:Read.` }, log);
  }
  const target = env.KUNDESIDE_SAAS_CNAME?.trim().toLowerCase();
  if (!target) {
    return update(db, row, {
      method: null,
      status: 'blokeret',
      records: [],
      detail:
        'Domænets DNS ligger ikke i Veyros Cloudflare-konto, og Cloudflare for SaaS er ikke sat op (KUNDESIDE_SAAS_CNAME). Vælg én af to: flyt domænets DNS til Veyros Cloudflare-konto, eller gennemfør engangsopsætningen i docs/KUNDEOPSAETNING.md. Indtil da kan siden bruge sin veyro.dk-adresse.',
    }, log);
  }
  const base = await zoneFor(env, kundeDomaene(env));
  if (!base.zone) return update(db, row, { status: 'fejlet', detail: base.error ?? `Fandt ikke zonen ${kundeDomaene(env)} i Cloudflare.` }, log);
  // Genbrug et eksisterende custom hostname for samme navn (fx efter et afbrudt forsøg)
  const existing = await cf<any[]>(env, 'GET', `/zones/${base.zone.id}/custom_hostnames?hostname=${encodeURIComponent(row.hostname)}`);
  if (!existing.ok) return update(db, row, { method: 'saas', status: 'fejlet', detail: existing.error }, log);
  let ch = existing.result?.[0];
  if (!ch) {
    const created = await cf<any>(env, 'POST', `/zones/${base.zone.id}/custom_hostnames`, { hostname: row.hostname, ssl: { method: 'txt', type: 'dv' } });
    if (!created.ok) return update(db, row, { method: 'saas', status: 'fejlet', detail: created.error }, log);
    ch = created.result;
  }
  return update(db, row, { method: 'saas', provider_id: `${base.zone.id}:${ch.id}`, ...saasState(row.hostname, target, ch) }, log);
}

function saasState(host: string, target: string, ch: any): Update {
  const records: DnsRecord[] = [{ type: 'CNAME', name: host, value: target, purpose: 'Sender trafikken til Veyro' }];
  const ov = ch?.ownership_verification;
  if (ov?.name && ov?.value) records.push({ type: String(ov.type ?? 'txt').toUpperCase(), name: ov.name, value: ov.value, purpose: 'Bekræfter, at kunden ejer domænet' });
  for (const v of ch?.ssl?.validation_records ?? []) {
    if (v?.txt_name && v?.txt_value) records.push({ type: 'TXT', name: v.txt_name, value: v.txt_value, purpose: 'Udstedelse af HTTPS-certifikat' });
  }
  const errs = [...(ch?.verification_errors ?? []), ...(ch?.ssl?.validation_errors ?? []).map((e: any) => e?.message)].filter(Boolean);
  const active = ch?.status === 'active' && ch?.ssl?.status === 'active';
  return {
    status: active ? 'verificerer' : 'verificerer',
    records,
    detail: active
      ? 'Cloudflare har bekræftet domænet og certifikatet. Mangler kun HTTPS-kontrol.'
      : `Afventer, at kunden opretter DNS-posterne nedenfor (Cloudflare: ${ch?.status ?? 'ukendt'}, certifikat: ${ch?.ssl?.status ?? 'ukendt'}).${errs.length ? ` ${errs.join(' ')}` : ''}`,
  };
}

async function dnsResolves(env: Env, host: string): Promise<boolean> {
  const base = env.DOH_URL || 'https://cloudflare-dns.com/dns-query';
  for (const type of ['A', 'AAAA', 'CNAME']) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: 'application/dns-json' } });
      const j = (await r.json()) as { Answer?: unknown[] };
      if (j.Answer?.length) return true;
    } catch {
      /* prøv næste */
    }
  }
  return false;
}

/** Svarer siden på domænet over HTTPS, og er det dette projekt? */
async function httpsServes(env: Env, host: string, projectId: string): Promise<{ ok: boolean; detail: string }> {
  const url = env.DOMAIN_CHECK_ORIGIN ? `${env.DOMAIN_CHECK_ORIGIN.replace(/\/+$/, '')}/_veyro/status?host=${encodeURIComponent(host)}` : `https://${host}/_veyro/status`;
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { 'x-veyro-host': host } });
    if (r.status !== 200) return { ok: false, detail: `https://${host} svarede HTTP ${r.status}.` };
    const j = (await r.json().catch(() => null)) as { project?: string } | null;
    if (j?.project !== projectId) return { ok: false, detail: `https://${host} svarer, men ikke med dette projekt.` };
    return { ok: true, detail: `https://${host} svarer med certifikat og viser dette projekt.` };
  } catch (err) {
    return { ok: false, detail: `https://${host} kunne ikke nås (${(err as Error).message}). Certifikatet er måske ikke udstedt endnu.` };
  }
}

/** Tjekker et domæne igen og opdaterer status. Aktiv kræver: Cloudflare bekræfter, DNS svarer og HTTPS viser projektet. */
export async function checkDomain(env: Env, db: D1Database, row: DomainRow, p: Project, actor: string): Promise<DomainRow> {
  if (!row.method || row.status === 'blokeret' || row.status === 'fejlet' || row.status === 'afventer') return setupDomain(env, db, row, p, actor);
  if (!domainsConfigured(env)) return update(db, row, { status: 'blokeret', detail: 'CF_API_TOKEN er ikke sat på veyro-Workeren.' });
  const [a, b] = (row.provider_id ?? '').split(':');
  const wasActive = row.status === 'aktiv';
  const log = (status: string) => (status !== row.status ? { actor, company_id: p.company_id, action: 'Domænestatus ændret' } : undefined);
  if (row.method === 'workers_domain') {
    const r = await cf<{ hostname: string; service: string }[]>(env, 'GET', `/accounts/${a}/workers/domains?hostname=${encodeURIComponent(row.hostname)}`);
    if (!r.ok) return update(db, row, { detail: r.error }, log(row.status));
    const bound = r.result?.find((d) => d.hostname === row.hostname);
    if (!bound || bound.service !== (env.CF_WORKER_NAME || 'veyro')) {
      return update(db, row, { status: 'fejlet', verified_at: null, detail: bound ? `${row.hostname} er knyttet til en anden Worker (${bound.service}).` : 'Bindingen findes ikke længere i Cloudflare. Klik "Sæt op igen".' }, log('fejlet'));
    }
  } else if (row.method === 'saas') {
    const r = await cf<any>(env, 'GET', `/zones/${a}/custom_hostnames/${b}`);
    if (!r.ok) return update(db, row, { detail: r.error }, log(row.status));
    const st = saasState(row.hostname, env.KUNDESIDE_SAAS_CNAME ?? '', r.result);
    if (!(r.result?.status === 'active' && r.result?.ssl?.status === 'active')) return update(db, row, { ...st, verified_at: null }, log('verificerer'));
  }
  if (!(await dnsResolves(env, row.hostname))) {
    return update(db, row, { status: 'verificerer', verified_at: null, detail: `DNS for ${row.hostname} svarer ikke endnu. Det kan tage op til et par timer efter ændringer.` }, log('verificerer'));
  }
  const https = await httpsServes(env, row.hostname, p.id);
  if (!https.ok) return update(db, row, { status: 'verificerer', verified_at: null, detail: https.detail }, log('verificerer'));
  return update(db, row, { status: 'aktiv', verified_at: wasActive ? row.verified_at : nowSec(), detail: https.detail }, log('aktiv'));
}

/** Fjerner kun Veyros binding af domænet. Kundens øvrige DNS (mail osv.) røres ikke. */
export async function removeDomain(env: Env, db: D1Database, row: DomainRow, p: Project, actor: string): Promise<{ ok: boolean; error: string | null }> {
  const [a, b] = (row.provider_id ?? '').split(':');
  if (domainsConfigured(env) && row.method === 'workers_domain' && b) {
    const r = await cf(env, 'DELETE', `/accounts/${a}/workers/domains/${b}`);
    if (!r.ok && r.status !== 404) return { ok: false, error: r.error };
  } else if (domainsConfigured(env) && row.method === 'saas' && b) {
    const r = await cf(env, 'DELETE', `/zones/${a}/custom_hostnames/${b}`);
    if (!r.ok && r.status !== 404) return { ok: false, error: r.error };
  }
  await update(db, row, { status: 'fjernet', verified_at: null, detail: 'Fjernet' }, { actor, company_id: p.company_id, action: 'Domæne fjernet' });
  return { ok: true, error: null };
}

export async function addDomain(env: Env, db: D1Database, p: Project, host: string, kind: 'veyro' | 'eget', actor: string): Promise<{ row: DomainRow | null; error: string | null }> {
  const problem = hostProblem(env, host, kind);
  if (problem) return { row: null, error: problem };
  const taken = await db.prepare("SELECT project_id FROM project_domains WHERE hostname = ? AND status != 'fjernet'").bind(host).first<{ project_id: string }>();
  if (taken) return { row: null, error: taken.project_id === p.id ? `${host} er allerede knyttet til dette projekt.` : `${host} er allerede knyttet til en anden kunde. Fjern det dér først.` };
  // Et værtsnavn må ikke kollidere med et kundesystem (varebestilling/lagerstyring)
  const sys = await db.prepare("SELECT project_id FROM project_services WHERE provisioned_url = ? OR json_extract(config, '$.domaene') = ?").bind(`https://${host}`, host).first();
  if (sys) return { row: null, error: `${host} bruges allerede af et bestillings- eller lagersystem.` };
  try {
    await db
      .prepare('INSERT INTO project_domains (project_id, hostname, kind, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(p.id, host, kind, 'afventer', nowSec(), actor)
      .run();
  } catch {
    return { row: null, error: `${host} er lige blevet knyttet til et andet projekt.` };
  }
  const row = (await db.prepare("SELECT * FROM project_domains WHERE hostname = ? AND status != 'fjernet'").bind(host).first<DomainRow>())!;
  return { row, error: null };
}

/** Kundesiden for et værtsnavn (kun aktive eller verificerende domæner; cache i 30 sekunder pr. isolate) */
const hostCache = new Map<string, { projectId: string | null; at: number }>();
export async function projectIdForHost(env: Env, db: D1Database, host: string): Promise<string | null> {
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < 30_000) return hit.projectId;
  let projectId: string | null = null;
  const row = await db.prepare("SELECT project_id FROM project_domains WHERE hostname = ? AND status IN ('aktiv', 'verificerer')").bind(host).first<{ project_id: string }>();
  if (row) projectId = row.project_id;
  if (hostCache.size > 500) hostCache.clear();
  hostCache.set(host, { projectId, at: Date.now() });
  return projectId;
}
export function forgetHost(host: string): void {
  hostCache.delete(host);
}
