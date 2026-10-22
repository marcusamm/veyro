// Udrulning af varebestilling og lagerstyring for kunder oprettet i admin.
// Selve udrulningen sker som før med "Deploy kunder" (scripts/deploy-kunder.mjs): én Worker og én database pr. kunde.
// Workflowet henter kunderne fra kunde.veyro.dk/api/provisionering (ud over kunder/*.json) og melder status tilbage.
// Admin starter workflowet via GitHubs API, hvis GITHUB_DISPATCH_TOKEN er sat; ellers vises det manuelle trin.
import { Hono } from 'hono';
import type { Env } from '../env';
import { nowSec, timingSafeEqual } from '../lib/crypto';
import { audit, enabledSet, getServices, serviceConfig, setServiceStatus, type Project } from './model';
import { validateService, type ServiceKey } from './tjenester';

export const PROVISIONED: ('varebestilling' | 'lagerstyring')[] = ['varebestilling', 'lagerstyring'];

type KEnv = { Bindings: Env };
export const provisionering = new Hono<KEnv>();

async function authorized(env: Env, header: string | undefined): Promise<boolean> {
  const token = env.PROVISIONERING_TOKEN;
  if (!token || token.length < 32) return false;
  const got = (header ?? '').replace(/^Bearer\s+/i, '');
  return timingSafeEqual(got, token);
}

interface ProvisionRow {
  project_id: string;
  slug: string;
  company_name: string;
  kind: string;
  draft: string;
}

/** Kunderne i samme form som kunder/*.json, kun med tjenester, der er bedt om at blive udrullet og er gyldige */
export async function provisioningList(env: Env): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT p.id AS project_id, p.slug, c.name AS company_name, p.kind, p.draft
       FROM projects p JOIN companies c ON c.id = p.company_id
       JOIN project_services s ON s.project_id = p.id
      WHERE s.enabled = 1 AND s.provision_requested_at IS NOT NULL AND s.service IN ('varebestilling', 'lagerstyring')
      ORDER BY p.slug`,
  ).all<ProvisionRow>();
  const out: unknown[] = [];
  for (const r of results ?? []) {
    const services = await getServices(env.DB, r.project_id);
    const enabled = enabledSet(services);
    const systemer: Record<string, unknown> = {};
    let startkatalog: unknown[] = [];
    let butik: Record<string, unknown> | null = null;
    for (const key of PROVISIONED) {
      const row = services.get(key);
      if (!row?.enabled || !row.provision_requested_at) continue;
      const cfg = serviceConfig(row);
      if (validateService(key, cfg, { kind: r.kind as any, enabled }).length) continue;
      systemer[key] = { admins: cfg.admins, ...(cfg.domaene ? { domaene: cfg.domaene } : {}), ...(cfg.afsender ? { afsender: cfg.afsender } : {}) };
      if (key === 'varebestilling') {
        startkatalog = Array.isArray(cfg.startkatalog) ? cfg.startkatalog : [];
        butik = { pickup_enabled: cfg.pickup !== false, delivery_enabled: cfg.delivery !== false, delivery_fee: Math.round(Number(cfg.delivery_fee_kr ?? 49) * 100), auto_confirm: !!cfg.auto_confirm, notify_email: cfg.notify_email ?? '' };
      }
    }
    if (!Object.keys(systemer).length) continue;
    let farve = '';
    try {
      farve = JSON.parse(r.draft)?.brand?.primary ?? '';
    } catch {
      /* ingen kladde */
    }
    out.push({
      kilde: 'admin',
      projekt: r.project_id,
      slug: r.slug,
      navn: r.company_name,
      adresse: r.slug,
      systemer,
      ...(/^#[0-9A-Fa-f]{6}$/.test(farve) ? { udseende: { farve } } : {}),
      ...(butik ? { butik } : {}),
      ...(startkatalog.length ? { startkatalog } : {}),
    });
  }
  return out;
}

provisionering.get('/api/provisionering', async (c) => {
  if (!(await authorized(c.env, c.req.header('Authorization')))) return c.json({ error: 'Ingen adgang' }, 401);
  return c.json({ kunder: await provisioningList(c.env) });
});

provisionering.post('/api/provisionering/status', async (c) => {
  if (!(await authorized(c.env, c.req.header('Authorization')))) return c.json({ error: 'Ingen adgang' }, 401);
  const body = (await c.req.json().catch(() => null)) as { projekt?: string; system?: string; ok?: boolean; url?: string; fejl?: string } | null;
  if (!body?.projekt || !PROVISIONED.includes(body.system as any)) return c.json({ error: 'Ugyldig besked' }, 400);
  const p = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(body.projekt).first<Project>();
  if (!p) return c.json({ error: 'Ukendt projekt' }, 404);
  const url = body.ok && typeof body.url === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(body.url) ? body.url : null;
  if (body.ok && url) {
    await setServiceStatus(c.env.DB, p.id, body.system as ServiceKey, 'forbundet', null, { provisioned_url: url });
    await c.env.DB.prepare('UPDATE projects SET slug_locked = 1 WHERE id = ?').bind(p.id).run();
  } else {
    await setServiceStatus(c.env.DB, p.id, body.system as ServiceKey, 'blokeret', String(body.fejl ?? 'Udrulningen fejlede').slice(0, 400));
  }
  await audit(c.env.DB, { actor: 'Deploy kunder', company_id: p.company_id, project_id: p.id, action: body.ok ? 'Tjeneste udrullet' : 'Udrulning fejlede', detail: `${body.system}${url ? `: ${url}` : body.fejl ? `: ${String(body.fejl).slice(0, 200)}` : ''}` });
  return c.json({ ok: true });
});

/**
 * Beder om udrulning. Markerer tjenesterne og starter "Deploy kunder" for netop denne kunde, hvis GitHub-nøglen findes.
 * Kan køres igen: workflowet finder eksisterende database og Worker og opdaterer dem i stedet for at oprette nye.
 */
export async function requestProvisioning(env: Env, p: Project, keys: ('varebestilling' | 'lagerstyring')[], actor: string): Promise<{ dispatched: boolean; message: string }> {
  const now = nowSec();
  for (const key of keys) {
    await env.DB.prepare("UPDATE project_services SET provision_requested_at = COALESCE(provision_requested_at, ?), status = CASE WHEN status = 'forbundet' THEN status ELSE 'afventer' END, status_detail = CASE WHEN status = 'forbundet' THEN status_detail ELSE 'Venter på \"Deploy kunder\"' END, updated_at = ? WHERE project_id = ? AND service = ? AND enabled = 1")
      .bind(now, now, p.id, key)
      .run();
  }
  await env.DB.prepare('UPDATE projects SET slug_locked = 1 WHERE id = ?').bind(p.id).run();
  const repo = env.GITHUB_REPO || 'marcusamm/veyro';
  if (!env.GITHUB_DISPATCH_TOKEN || !env.PROVISIONERING_TOKEN) {
    await audit(env.DB, { actor, company_id: p.company_id, project_id: p.id, action: 'Udrulning bestilt (manuelt trin)', detail: keys.join(', ') });
    return {
      dispatched: false,
      message: `Tjenesterne er klar til udrulning. ${!env.PROVISIONERING_TOKEN ? 'PROVISIONERING_TOKEN er ikke sat, så "Deploy kunder" kan ikke hente kunden endnu (engangsopsætning). ' : ''}Start den på GitHub: Actions › Deploy kunder › Run workflow med kunde "${p.slug}".`,
    };
  }
  const base = (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/repos/${repo}/actions/workflows/deploy-kunder.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'veyro-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { kunde: p.slug } }),
    });
    if (res.status !== 204) {
      await audit(env.DB, { actor, company_id: p.company_id, project_id: p.id, action: 'Udrulning kunne ikke startes', detail: `GitHub svarede HTTP ${res.status}` });
      return { dispatched: false, message: `GitHub afviste at starte "Deploy kunder" (HTTP ${res.status}). Tjek GITHUB_DISPATCH_TOKEN, eller start den manuelt med kunde "${p.slug}".` };
    }
  } catch (err) {
    return { dispatched: false, message: `GitHub svarede ikke (${(err as Error).message}). Prøv igen, eller start "Deploy kunder" manuelt med kunde "${p.slug}".` };
  }
  await audit(env.DB, { actor, company_id: p.company_id, project_id: p.id, action: 'Udrulning startet', detail: keys.join(', ') });
  return { dispatched: true, message: `"Deploy kunder" er startet for ${p.slug}. Status opdateres her, når udrulningen melder tilbage (typisk 2–4 minutter).` };
}
