// Admin › Kunder: opret kunde, guidet opsætning, forhåndsvisning, godkendelse, publicering, domæner og tjenester.
// Alle projektadresser indeholder både virksomhedens og projektets id, og begge tjekkes mod databasen.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { getCustomerByEmail, normalizeEmail, upsertCustomer } from '../lib/db';
import { sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import { createLoginToken, isAdmin } from '../lib/session';
import { render } from '../render';
import { errorPage } from '../views/pages';
import { verifyLive } from '../kunder/app';
import { addDomain, checkDomain, domainsConfigured, externalSiteUrl, forgetHost, kundeDomaene, normalizeHost, removeDomain, setupDomain, veyroHost } from '../kunder/domaener';
import { configHash, emptySection, normalizeConfig, SECTION_TYPES, startConfig, structureOnly, type Section, type SectionType, type WebsiteConfig } from '../kunder/hjemmeside';
import { catalogRows, planCatalog, SAMPLE_CSV } from '../kunder/katalog';
import {
  ADMIN_PREVIEW_TTL,
  approveDraft,
  audit,
  createCompany,
  createPreviewLink,
  createProject,
  CUSTOMER_PREVIEW_TTL,
  draftOf,
  enabledSet,
  findDuplicates,
  getCompany,
  getProject,
  getServices,
  getVersion,
  listAudit,
  listDomains,
  listFiles,
  listLeads,
  listMembers,
  listPreviewLinks,
  listProjects,
  listVersions,
  revokePreviewLink,
  saveDraft,
  saveServiceConfig,
  serviceConfig,
  setEnabledServices,
  setStep,
  slugify,
  slugProblem,
  slugTaken,
  STEPS,
  updateCompany,
  updateProjectBasics,
  type Company,
  type CompanyInput,
  type Project,
  type Step,
} from '../kunder/model';
import { blocking, DOMAIN_STATUS, listPublications, publicationState, publish, runChecks } from '../kunder/publicering';
import { PROVISIONED, requestProvisioning } from '../kunder/provisionering';
import { defaultSystemHost, readServiceConfig, SERVICE_ORDER, SERVICES, validateService, type ServiceKey } from '../kunder/tjenester';
import {
  BASE,
  companyFormPage,
  companyPage,
  contentPage,
  hubPage,
  overviewPage,
  pageEditorPage,
  pbase,
  projectTypePage,
  servicesPage,
  setupPage,
  type CompanyValues,
  type OverviewRow,
} from '../views/admin-kunder';
import { imageSize } from './admin-site';

const r = new Hono<AppEnv & { Variables: { company: Company; project: Project } }>();

const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await next();
};
r.use('/virksomheder', guard);
r.use('/virksomheder/*', guard);

type C = Context<AppEnv & { Variables: { company: Company; project: Project } }>;
const who = (c: C) => c.get('session')!.email;
const page = (c: C, title: string, body: Parameters<typeof render>[2], status?: 200 | 400 | 404 | 409 | 422) => render(c as any, title, body, { nav: 'admin-virksomheder' as any, admin: true, status });
const notFound = (c: C) => render(c as any, 'Findes ikke', errorPage('Findes ikke', 'Kunden eller projektet findes ikke.', { href: BASE, label: 'Til kunder' }), { status: 404, admin: true });
const flashOf = (c: C) => c.req.query('besked') ?? null;
const go = (c: C, target: string, besked?: string) => {
  if (!besked) return c.redirect(target, 303);
  // Beskeden skal stå før et eventuelt #anker
  const [path, hash] = target.split('#') as [string, string | undefined];
  return c.redirect(`${path}${path.includes('?') ? '&' : '?'}besked=${encodeURIComponent(besked)}${hash ? `#${hash}` : ''}`, 303);
};

// Indlæs virksomhed og projekt fra adressen (begge skal passe sammen)
r.use('/virksomheder/:cid/*', async (c, next) => {
  const cid = c.req.param('cid');
  if (cid === 'ny' || cid === 'eksempel-vareliste.csv') return next();
  const company = await getCompany(c.env.DB, cid);
  if (!company) return notFound(c as C);
  c.set('company', company);
  const m = new URL(c.req.url).pathname.match(/^\/admin\/virksomheder\/[^/]+\/projekter\/(p_[a-z0-9x]+)/);
  if (m) {
    const project = await getProject(c.env.DB, company.id, m[1]!);
    if (!project) return notFound(c as C);
    c.set('project', project);
  }
  await next();
});
r.use('/virksomheder/:cid', async (c, next) => {
  if (c.req.param('cid') === 'ny' || c.req.param('cid') === 'eksempel-vareliste.csv') return next();
  const company = await getCompany(c.env.DB, c.req.param('cid'));
  if (!company) return notFound(c as C);
  c.set('company', company);
  await next();
});

// ---------- Oversigt ----------

function nextAction(p: Project, draftHash: string, liveHash: string | null, services: Map<ServiceKey, any>, domain: { status: string } | null): { label: string; href: string } | null {
  const b = pbase(p);
  const blocked = [...services.values()].find((s) => s.enabled && s.status === 'blokeret');
  if (blocked) return { label: `${SERVICES[blocked.service as ServiceKey].label} er blokeret`, href: `${b}/trin/opsaetning` };
  if (p.onboarding_step !== 'faerdig') return { label: `Fortsæt opsætningen: ${STEPS.includes(p.onboarding_step as Step) ? ({ type: 'Projekttype', indhold: 'Udseende og indhold', tjenester: 'Tjenester', opsaetning: 'Opsætning', gennemgang: 'Gennemgang', virksomhed: 'Virksomhed' } as Record<string, string>)[p.onboarding_step] : p.onboarding_step}`, href: `${b}/trin/${p.onboarding_step}` };
  if (p.kind !== 'intern' && !p.live_version_id) return { label: 'Godkend og publicér', href: `${b}/trin/gennemgang` };
  if (p.kind === 'skabelon' && liveHash && liveHash !== draftHash) return { label: 'Upublicerede ændringer', href: b };
  const waiting = [...services.values()].find((s) => s.enabled && (s.service === 'varebestilling' || s.service === 'lagerstyring') && s.status !== 'forbundet');
  if (waiting) return { label: waiting.status === 'afventer' ? 'Afventer udrulning' : 'Udrul tjenester', href: `${b}/trin/opsaetning` };
  if (domain && domain.status !== 'aktiv') return { label: `Domæne: ${DOMAIN_STATUS[domain.status as keyof typeof DOMAIN_STATUS]}`, href: `${b}#domaener` };
  return null;
}

r.get('/virksomheder', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  const like = `%${q.toLowerCase()}%`;
  const { results: companies } = await c.env.DB.prepare(
    q ? 'SELECT * FROM companies WHERE lower(name) LIKE ? OR cvr LIKE ? OR id IN (SELECT company_id FROM projects WHERE slug LIKE ?) ORDER BY updated_at DESC LIMIT 200' : 'SELECT * FROM companies ORDER BY updated_at DESC LIMIT 200',
  )
    .bind(...(q ? [like, like, like] : []))
    .all<Company>();
  const rows: OverviewRow[] = [];
  for (const company of companies ?? []) {
    const projects = await listProjects(c.env.DB, company.id);
    if (!projects.length) rows.push({ company, project: null, services: [], state: { label: 'Intet projekt', tone: 'neutral' }, domain: null, action: { label: 'Opret projekt', href: `${BASE}/${company.id}/projekter/ny` } });
    for (const p of projects) {
      const [services, domains] = await Promise.all([getServices(c.env.DB, p.id), listDomains(c.env.DB, p.id)]);
      const live = p.live_version_id ? await getVersion(c.env.DB, p.id, p.live_version_id) : null;
      const domain = domains.find((d) => d.kind === 'eget') ?? domains[0] ?? null;
      rows.push({
        company,
        project: p,
        services: SERVICE_ORDER.filter((k) => services.get(k)?.enabled),
        state: publicationState(p, domains),
        domain,
        action: nextAction(p, await configHash(draftOf(p)), live?.content_hash ?? null, services, domain),
      });
    }
  }
  return page(c as C, 'Kunder', overviewPage({ rows, q }));
});

r.get('/virksomheder/eksempel-vareliste.csv', (c) =>
  c.body(SAMPLE_CSV, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vareliste-eksempel.csv"' }),
);

// ---------- Trin A: virksomhed ----------

function readCompany(body: Record<string, unknown>): { input: CompanyInput; values: CompanyValues; errors: Record<string, string> } {
  const t = (k: string, max: number) => String(body[k] ?? '').trim().slice(0, max) || null;
  const errors: Record<string, string> = {};
  const name = t('name', 120);
  if (!name) errors.name = 'Skriv virksomhedens navn.';
  const cvrRaw = (t('cvr', 20) ?? '').replace(/\s|^DK/gi, '');
  if (cvrRaw && !/^\d{8}$/.test(cvrRaw)) errors.cvr = 'CVR-nummeret skal være 8 cifre.';
  const emailRaw = t('email', 200);
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  if (emailRaw && !email) errors.email = 'E-mailadressen er ugyldig.';
  const input: CompanyInput = {
    name: name ?? '',
    cvr: cvrRaw || null,
    contact_name: t('contact_name', 120),
    email,
    phone: t('phone', 40),
    address: t('address', 200),
    postal_code: t('postal_code', 10),
    city: t('city', 80),
    website: t('website', 200),
    industry: t('industry', 80),
    description: t('description', 1000),
    internal_note: t('internal_note', 2000),
  };
  return { input, values: { ...input, email: emailRaw }, errors };
}

r.get('/virksomheder/ny', (c) => page(c as C, 'Opret kunde', companyFormPage({ csrf: c.get('csrf'), values: {}, errors: {}, duplicates: [], editing: null })));

r.post('/virksomheder/ny', async (c) => {
  const body = await c.req.parseBody();
  const { input, values, errors } = readCompany(body);
  if (Object.keys(errors).length) return page(c as C, 'Opret kunde', companyFormPage({ csrf: c.get('csrf'), values, errors, duplicates: [], editing: null }), 422);
  const duplicates = await findDuplicates(c.env.DB, input);
  const sameCvr = duplicates.some((d) => input.cvr && d.cvr === input.cvr);
  if (duplicates.length && (sameCvr || body['confirm_new'] !== '1')) {
    return page(c as C, 'Opret kunde', companyFormPage({ csrf: c.get('csrf'), values, errors: {}, duplicates, editing: null, blocked: sameCvr }), 409);
  }
  let id: string;
  try {
    id = await createCompany(c.env.DB, input, who(c as C));
  } catch {
    // To samtidige oprettelser med samme CVR: den unikke nøgle stopper den anden
    return page(c as C, 'Opret kunde', companyFormPage({ csrf: c.get('csrf'), values, errors: { cvr: 'Der findes allerede en virksomhed med dette CVR-nummer.' }, duplicates: await findDuplicates(c.env.DB, input), editing: null, blocked: true }), 409);
  }
  return go(c as C, `${BASE}/${id}/projekter/ny`);
});

r.get('/virksomheder/:cid', async (c) => {
  const company = c.get('company');
  const projects = await listProjects(c.env.DB, company.id);
  const items = [];
  for (const p of projects) {
    const services = await getServices(c.env.DB, p.id);
    items.push({ project: p, state: publicationState(p, await listDomains(c.env.DB, p.id)), services: SERVICE_ORDER.filter((k) => services.get(k)?.enabled) });
  }
  const acc = company.email ? await getCustomerByEmail(c.env.DB, company.email) : null;
  const plan = acc ? await c.env.DB.prepare("SELECT plan FROM subscriptions WHERE customer_id = ? AND status IN ('active','trialing','past_due') LIMIT 1").bind(acc.id).first<{ plan: string | null }>() : null;
  return page(c as C, company.name, companyPage({
    csrf: c.get('csrf'),
    company,
    projects: items,
    members: await listMembers(c.env.DB, company.id),
    audit: await listAudit(c.env.DB, company.id),
    account: acc ? { id: acc.id, plan: plan ? (plan.plan ?? 'individuel') : null } : null,
    flash: flashOf(c as C),
    error: c.req.query('fejl') ?? null,
  }));
});

r.get('/virksomheder/:cid/rediger', (c) => {
  const company = c.get('company');
  return page(c as C, 'Ret virksomhed', companyFormPage({ csrf: c.get('csrf'), values: company as unknown as CompanyValues, errors: {}, duplicates: [], editing: company }));
});

r.post('/virksomheder/:cid/rediger', async (c) => {
  const company = c.get('company');
  const { input, values, errors } = readCompany(await c.req.parseBody());
  if (input.cvr && !errors.cvr) {
    const clash = (await findDuplicates(c.env.DB, input, company.id)).find((d) => d.cvr === input.cvr);
    if (clash) errors.cvr = `CVR-nummeret bruges allerede af ${clash.name}.`;
  }
  if (Object.keys(errors).length) return page(c as C, 'Ret virksomhed', companyFormPage({ csrf: c.get('csrf'), values, errors, duplicates: [], editing: company }), 422);
  await updateCompany(c.env.DB, company.id, input, who(c as C));
  return go(c as C, `${BASE}/${company.id}`, 'Oplysningerne er gemt. Tjenester og domæner er uændrede.');
});

// Kundens brugere (invitation med engangslink via det eksisterende login)
async function invite(c: C, company: Company, email: string): Promise<boolean> {
  await upsertCustomer(c.env.DB, { email, name: null });
  await c.env.DB.prepare('INSERT INTO company_members (company_id, email, role, invited_at, invited_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(company.id, email, 'ejer', Math.floor(Date.now() / 1000), who(c)).run();
  const token = await createLoginToken(c.env, email, { next: '/konto/hjemmeside' });
  const link = `${c.env.APP_URL.replace(/\/+$/, '')}/login/bekraeft?token=${encodeURIComponent(token)}`;
  await audit(c.env.DB, { actor: who(c), company_id: company.id, action: 'Bruger inviteret til kundepanelet', detail: email.replace(/^(.).*(@.*)$/, '$1…$2') });
  const text = `Hej\n\nVeyro har givet dig adgang til ${company.name} i kundepanelet. Her kan du se jeres hjemmeside og henvendelser.\n\nLog ind med dette link (gælder i 15 minutter og kan kun bruges én gang):\n${link}\n\nSenere logger du ind på ${c.env.APP_URL}/login med din e-mail. Der er ingen adgangskode.\n\nVenlig hilsen\nVeyro`;
  return sendEmail(c.env, { to: email, subject: `Adgang til ${company.name} hos Veyro`, text, html: text.split('\n\n').map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('') }).catch(async (err) => {
    await logError(c.env.DB, 'Invitation', err);
    return false;
  });
}

r.post('/virksomheder/:cid/brugere', async (c) => {
  const company = c.get('company');
  const email = normalizeEmail((await c.req.parseBody())['email']);
  if (!email) return go(c as C, `${BASE}/${company.id}?fejl=${encodeURIComponent('E-mailadressen er ugyldig.')}`);
  if (isAdmin(c.env, email)) return go(c as C, `${BASE}/${company.id}?fejl=${encodeURIComponent('Veyro-administratorer kan ikke være kundebrugere.')}`);
  const sent = await invite(c as C, company, email);
  return go(c as C, `${BASE}/${company.id}`, sent ? `Invitation sendt til ${email}.` : `${email} har fået adgang, men e-mailen kunne ikke sendes (RESEND_API_KEY mangler eller fejlede). Personen kan logge ind på kunde.veyro.dk/login.`);
});

r.post('/virksomheder/:cid/brugere/fjern', async (c) => {
  const company = c.get('company');
  const email = normalizeEmail((await c.req.parseBody())['email']);
  if (email) {
    await c.env.DB.prepare('DELETE FROM company_members WHERE company_id = ? AND email = ?').bind(company.id, email).run();
    await audit(c.env.DB, { actor: who(c as C), company_id: company.id, action: 'Brugers adgang fjernet', detail: email.replace(/^(.).*(@.*)$/, '$1…$2') });
  }
  return go(c as C, `${BASE}/${company.id}`, 'Adgangen er fjernet.');
});

// ---------- Trin B: projekttype ----------

async function readProjectBasics(c: C, body: Record<string, unknown>, existing: Project | null) {
  const v = Object.fromEntries(['kind', 'name', 'slug', 'template', 'external_url'].map((k) => [k, String(body[k] ?? '').trim()]));
  const errors: Record<string, string> = {};
  const kind = existing?.kind ?? v.kind;
  if (!['skabelon', 'tilsluttet', 'intern'].includes(kind!)) errors.kind = 'Vælg en projekttype.';
  if (!v.name) errors.name = 'Giv projektet et navn.';
  v.slug = existing?.slug_locked ? existing.slug : slugify(v.slug || c.get('company').name);
  const sp = slugProblem(v.slug);
  if (sp) errors.slug = sp;
  else if (await slugTaken(c.env.DB, v.slug, existing?.id)) errors.slug = `Adressen "${v.slug}" bruges allerede af et andet projekt. Vælg en anden.`;
  let external: string | null = null;
  if (kind === 'tilsluttet') {
    external = externalSiteUrl(c.env, v.external_url!);
    if (!external) errors.external_url = 'Angiv sidens fulde adresse med https://.';
  }
  return { v, errors, kind: kind as Project['kind'], external };
}

r.get('/virksomheder/:cid/projekter/ny', async (c) => {
  const company = c.get('company');
  return page(c as C, 'Nyt projekt', projectTypePage({ csrf: c.get('csrf'), company, values: { kind: 'skabelon', name: 'Hjemmeside', slug: slugify(company.name), template: 'service' }, errors: {}, project: null, projects: await listProjects(c.env.DB, company.id) }));
});

r.post('/virksomheder/:cid/projekter/ny', async (c) => {
  const company = c.get('company');
  const { v, errors, kind, external } = await readProjectBasics(c as C, await c.req.parseBody(), null);
  if (Object.keys(errors).length) return page(c as C, 'Nyt projekt', projectTypePage({ csrf: c.get('csrf'), company, values: v as Record<string, string>, errors, project: null, projects: await listProjects(c.env.DB, company.id) }), 422);
  const draft =
    kind === 'skabelon'
      ? startConfig(v.template || 'service', { name: company.name, description: company.description, phone: company.phone, email: company.email, address: [company.address, [company.postal_code, company.city].filter(Boolean).join(' ')].filter(Boolean).join('\n') })
      : kind === 'tilsluttet'
        ? normalizeConfig({ info: { name: company.name, phone: company.phone, email: company.email } })
        : null;
  let id: string;
  try {
    id = await createProject(c.env.DB, { company_id: company.id, name: v.name!, slug: v.slug!, kind, template: kind === 'skabelon' ? v.template || 'service' : null, external_url: external, draft }, who(c as C));
  } catch {
    return page(c as C, 'Nyt projekt', projectTypePage({ csrf: c.get('csrf'), company, values: v as Record<string, string>, errors: { slug: 'Adressen blev lige taget af et andet projekt. Vælg en anden.' }, project: null, projects: [] }), 409);
  }
  return go(c as C, `${BASE}/${company.id}/projekter/${id}/trin/${kind === 'intern' ? 'tjenester' : kind === 'tilsluttet' ? 'tjenester' : 'indhold'}`);
});

// ---------- Projektets overblik og gennemgang ----------

async function hub(c: C, mode: 'overblik' | 'gennemgang', extra: { flash?: string | null; error?: string | null; newLink?: string | null } = {}, status?: 200 | 409 | 422) {
  const company = c.get('company');
  const p = c.get('project');
  const [services, domains, versions, publications, links, leads] = await Promise.all([
    getServices(c.env.DB, p.id),
    listDomains(c.env.DB, p.id),
    listVersions(c.env.DB, p.id),
    listPublications(c.env.DB, p.id),
    listPreviewLinks(c.env.DB, p.id),
    listLeads(c.env.DB, p.id, { includeTest: true }, 10),
  ]);
  const cfg = draftOf(p);
  const draftHash = await configHash(cfg);
  const approved = versions.find((v) => v.approved_at) ? await getVersion(c.env.DB, p.id, versions.find((v) => v.approved_at)!.id) : null;
  const live = await getVersion(c.env.DB, p.id, p.live_version_id);
  // Tjekkene vises for kladden; er den ikke godkendt, tjekkes den som en kommende version
  const approvedCurrent = !!approved && approved.content_hash === draftHash;
  const draftVersion = approvedCurrent ? approved : p.kind === 'intern' ? null : { id: 0, project_id: p.id, number: approved?.number ?? 0, content: JSON.stringify(cfg), content_hash: draftHash, created_at: 0, created_by: null, approved_at: null, approved_by: null, published_at: null };
  const checks = await runChecks(c.env, c.env.DB, company, p, draftVersion);
  const approvedErrors = approved && !approvedCurrent ? blocking(await runChecks(c.env, c.env.DB, company, p, approved)).length : null;
  const companies = (await c.env.DB.prepare('SELECT * FROM companies ORDER BY name LIMIT 500').all<Company>()).results ?? [];
  const app = c.env.APP_URL.replace(/\/+$/, '');
  return page(c, mode === 'gennemgang' ? 'Gennemgang' : p.name, hubPage({
    csrf: c.get('csrf'),
    company,
    project: p,
    cfg,
    services,
    checks: p.kind === 'intern' ? checks.filter((x) => x.label !== 'Godkendt version') : checks,
    draftHash,
    approved,
    approvedErrors,
    live,
    versions,
    publications,
    domains,
    links,
    leads,
    state: publicationState(p, domains),
    urls: { s: `${app}/s/${p.slug}/`, veyroHost: veyroHost(c.env, p.slug), domainsReady: domainsConfigured(c.env), saasReady: !!c.env.KUNDESIDE_SAAS_CNAME },
    flash: extra.flash ?? flashOf(c),
    error: extra.error ?? c.req.query('fejl') ?? null,
    newLink: extra.newLink ?? null,
    companies,
    mode,
  }), status);
}

r.get('/virksomheder/:cid/projekter/:pid', (c) => hub(c as C, 'overblik'));

// ---------- Trin ----------

r.get('/virksomheder/:cid/projekter/:pid/trin/:step', async (c) => {
  const step = c.req.param('step') as Step;
  const p = c.get('project');
  if (step === 'virksomhed') return c.redirect(`${BASE}/${p.company_id}/rediger`, 303);
  if (step === 'type') return page(c as C, 'Projekttype', projectTypePage({ csrf: c.get('csrf'), company: c.get('company'), values: { name: p.name, slug: p.slug, external_url: p.external_url ?? '' }, errors: {}, project: p, projects: [] }));
  if (step === 'indhold') {
    if (p.kind === 'intern') return c.redirect(`${pbase(p)}/trin/tjenester`, 303);
    if (p.kind === 'tilsluttet') return page(c as C, 'Indhold', contentPage({ csrf: c.get('csrf'), project: p, cfg: draftOf(p), files: [], flash: 'En tilsluttet side bygges og redigeres i sin egen kilde. Her angiver du kun de oplysninger, Veyro deler med siden via den offentlige konfiguration.', error: null }));
    return page(c as C, 'Udseende og indhold', contentPage({ csrf: c.get('csrf'), project: p, cfg: draftOf(p), files: await listFiles(c.env.DB, p.id), flash: flashOf(c as C), error: null }));
  }
  if (step === 'tjenester') return page(c as C, 'Tjenester', servicesPage({ csrf: c.get('csrf'), project: p, services: await getServices(c.env.DB, p.id), errors: [] }));
  if (step === 'opsaetning') return setup(c as C);
  if (step === 'gennemgang') return hub(c as C, 'gennemgang');
  return notFound(c as C);
});

const advance = async (c: C, p: Project, done: Step) => {
  const order: Step[] = ['type', 'indhold', 'tjenester', 'opsaetning', 'gennemgang'];
  const cur = order.indexOf(p.onboarding_step as Step);
  let next = order[order.indexOf(done) + 1] ?? 'gennemgang';
  if (next === 'indhold' && p.kind === 'intern') next = 'tjenester';
  // Uden hjemmeside er der intet at publicere: opsætningen er færdig, når tjenesterne er sat op
  if (p.kind === 'intern' && next === 'gennemgang') {
    if (p.onboarding_step !== 'faerdig') await setStep(c.env.DB, p.id, 'faerdig');
    return next;
  }
  if (p.onboarding_step !== 'faerdig' && order.indexOf(next) > cur) await setStep(c.env.DB, p.id, next);
  return next;
};

r.post('/virksomheder/:cid/projekter/:pid/trin/type', async (c) => {
  const p = c.get('project');
  const { v, errors, external } = await readProjectBasics(c as C, await c.req.parseBody(), p);
  if (Object.keys(errors).length) return page(c as C, 'Projekttype', projectTypePage({ csrf: c.get('csrf'), company: c.get('company'), values: v as Record<string, string>, errors, project: p, projects: [] }), 422);
  await updateProjectBasics(c.env.DB, p, { name: v.name!, slug: v.slug!, external_url: p.kind === 'tilsluttet' ? external : null }, who(c as C));
  const next = await advance(c as C, p, 'type');
  return go(c as C, `${pbase(p)}/trin/${next}`, 'Gemt.');
});

const HEX = /^#[0-9a-fA-F]{6}$/;
r.post('/virksomheder/:cid/projekter/:pid/trin/indhold', async (c) => {
  const p = c.get('project');
  if (p.kind === 'intern') return notFound(c as C);
  const body = await c.req.parseBody();
  const cfg = draftOf(p);
  const t = (k: string) => String(body[k] ?? '');
  const next: WebsiteConfig = normalizeConfig({
    ...cfg,
    layout: t('layout') || cfg.layout,
    brand: {
      primary: HEX.test(t('primary')) ? t('primary') : cfg.brand.primary,
      background: HEX.test(t('background')) ? t('background') : cfg.brand.background,
      text: HEX.test(t('text')) ? t('text') : cfg.brand.text,
      font: t('font') || cfg.brand.font,
      logo: t('logo') ? Number(t('logo')) : null,
      logo_alt: t('logo_alt'),
    },
    info: { name: t('info_name'), tagline: t('info_tagline'), phone: t('info_phone'), email: t('info_email'), address: t('info_address'), cvr: t('info_cvr').replace(/\D/g, ''), opening_hours: t('info_opening_hours') },
  });
  if (next.brand.logo) {
    const own = await c.env.DB.prepare('SELECT 1 FROM project_files WHERE id = ? AND project_id = ?').bind(next.brand.logo, p.id).first();
    if (!own) next.brand.logo = null;
  }
  await saveDraft(c.env.DB, p, next, who(c as C), 'Udseende og oplysninger');
  if (body['next'] === '1') return go(c as C, `${pbase(p)}/trin/${await advance(c as C, p, 'indhold')}`, 'Gemt.');
  return go(c as C, `${pbase(p)}/trin/indhold`, 'Gemt.');
});

// Sider
r.post('/virksomheder/:cid/projekter/:pid/sider', async (c) => {
  const p = c.get('project');
  const title = String((await c.req.parseBody())['title'] ?? '').trim().slice(0, 80);
  const cfg = draftOf(p);
  const handle = slugify(title);
  if (!handle || cfg.pages.some((x) => x.handle === handle)) return go(c as C, `${pbase(p)}/trin/indhold?fejl=${encodeURIComponent('Der findes allerede en side med den adresse.')}`);
  cfg.pages.push({ handle, title, in_nav: true, seo_title: '', seo_description: '', sections: [{ ...emptySection('tekst'), heading: title }] });
  await saveDraft(c.env.DB, p, cfg, who(c as C), `Side tilføjet: ${title}`);
  return go(c as C, `${pbase(p)}/side/${handle}`, 'Siden er oprettet.');
});

const pageHandle = (h: string) => (h === 'forside' ? '' : h);

r.get('/virksomheder/:cid/projekter/:pid/side/:handle', async (c) => {
  const p = c.get('project');
  const pg = draftOf(p).pages.find((x) => x.handle === pageHandle(c.req.param('handle')));
  if (!pg) return notFound(c as C);
  return page(c as C, `Side: ${pg.title}`, pageEditorPage({ csrf: c.get('csrf'), project: p, page: pg, files: await listFiles(c.env.DB, p.id), flash: flashOf(c as C), error: null }));
});

r.post('/virksomheder/:cid/projekter/:pid/side/:handle', async (c) => {
  const p = c.get('project');
  const cfg = draftOf(p);
  const handle = pageHandle(c.req.param('handle'));
  const idx = cfg.pages.findIndex((x) => x.handle === handle);
  if (idx < 0) return notFound(c as C);
  const body = await c.req.parseBody();
  const t = (k: string) => String(body[k] ?? '');
  const pg = cfg.pages[idx]!;
  const op = t('op');
  if (op === 'delete-page' && handle !== '') {
    cfg.pages.splice(idx, 1);
    await saveDraft(c.env.DB, p, cfg, who(c as C), `Side slettet: ${pg.title}`);
    return go(c as C, `${pbase(p)}/trin/indhold`, `Siden "${pg.title}" er slettet fra kladden. Den publicerede side er uændret, til du publicerer igen.`);
  }
  // Gem alle felter først, så intet går tabt ved flyt/tilføj
  const sections: Section[] = pg.sections.map((s, n) => ({
    ...s,
    heading: body[`s${n}_heading`] === undefined ? s.heading : t(`s${n}_heading`),
    text: body[`s${n}_text`] === undefined ? s.text : t(`s${n}_text`),
    image: body[`s${n}_image`] === undefined ? s.image : Number(t(`s${n}_image`)) || null,
    image_alt: body[`s${n}_image_alt`] === undefined ? s.image_alt : t(`s${n}_image_alt`),
    button_label: body[`s${n}_button_label`] === undefined ? s.button_label : t(`s${n}_button_label`),
    button_href: body[`s${n}_button_href`] === undefined ? s.button_href : t(`s${n}_button_href`),
    items:
      body[`s${n}_items`] === undefined
        ? s.items
        : t(`s${n}_items`)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [title, ...rest] = l.split('|');
              return { title: title!.trim(), text: rest.join('|').trim() };
            }),
  }));
  const own = new Set((await listFiles(c.env.DB, p.id)).map((f) => f.id));
  for (const s of sections) if (s.image && !own.has(s.image)) s.image = null;
  const m = op.match(/^(up|down|del):(\d+)$/);
  if (m) {
    const i = Number(m[2]);
    if (m[1] === 'del') sections.splice(i, 1);
    else {
      const j = m[1] === 'up' ? i - 1 : i + 1;
      if (sections[i] && sections[j]) [sections[i], sections[j]] = [sections[j]!, sections[i]!];
    }
  } else if (op === 'add' && t('add_type') in SECTION_TYPES) sections.push(emptySection(t('add_type') as SectionType));
  cfg.pages[idx] = { ...pg, title: t('title') || pg.title, seo_title: t('seo_title'), seo_description: t('seo_description'), in_nav: body['in_nav'] === '1', sections };
  await saveDraft(c.env.DB, p, cfg, who(c as C), `Side ændret: ${cfg.pages[idx]!.title}`);
  return go(c as C, `${pbase(p)}/side/${handle || 'forside'}`, 'Siden er gemt i kladden.');
});

// Billeder
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
r.post('/virksomheder/:cid/projekter/:pid/billeder', async (c) => {
  const p = c.get('project');
  const file = (await c.req.parseBody())['file'];
  const back = `${pbase(p)}/trin/indhold`;
  if (!(file instanceof File) || file.size === 0) return go(c as C, `${back}?fejl=${encodeURIComponent('Vælg et billede.')}`);
  if (file.size > 1_500_000) return go(c as C, `${back}?fejl=${encodeURIComponent('Billedet er større end 1,5 MB.')}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = imageSize(bytes);
  const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : '';
  if (!IMAGE_TYPES[type] || !size) return go(c as C, `${back}?fejl=${encodeURIComponent('Filen er ikke et PNG-, JPG-, WebP- eller GIF-billede.')}`);
  const name = (file.name || `billede.${IMAGE_TYPES[type]}`).replace(/[^\wæøåÆØÅ. -]/g, '').slice(0, 100) || `billede.${IMAGE_TYPES[type]}`;
  await c.env.DB.prepare('INSERT INTO project_files (project_id, name, type, size, width, height, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p.id, name, type, bytes.length, size.width, size.height, bytes, Math.floor(Date.now() / 1000), who(c as C))
    .run();
  await audit(c.env.DB, { actor: who(c as C), company_id: p.company_id, project_id: p.id, action: 'Billede uploadet', detail: name });
  return go(c as C, back, 'Billedet er uploadet.');
});

r.get('/virksomheder/:cid/projekter/:pid/billeder/:id', async (c) => {
  const p = c.get('project');
  const row = await c.env.DB.prepare('SELECT type, data FROM project_files WHERE id = ? AND project_id = ?').bind(Number(c.req.param('id')), p.id).first<{ type: string; data: ArrayBuffer }>();
  if (!row) return c.text('Ikke fundet', 404);
  return c.body(new Uint8Array(row.data) as any, 200, { 'Content-Type': row.type, 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox" });
});

r.post('/virksomheder/:cid/projekter/:pid/billeder/:id/slet', async (c) => {
  const p = c.get('project');
  const id = Number(c.req.param('id'));
  // Bruges billedet i en publiceret version, bliver det liggende, så den publicerede side ikke går i stykker
  const live = p.live_version_id ? await getVersion(c.env.DB, p.id, p.live_version_id) : null;
  if (live && new RegExp(`"(image|logo)":${id}\\b`).test(live.content)) {
    return go(c as C, `${pbase(p)}/trin/indhold?fejl=${encodeURIComponent('Billedet bruges på den publicerede side og kan ikke slettes, før en version uden billedet er publiceret.')}`);
  }
  await c.env.DB.prepare('DELETE FROM project_files WHERE id = ? AND project_id = ?').bind(id, p.id).run();
  await audit(c.env.DB, { actor: who(c as C), company_id: p.company_id, project_id: p.id, action: 'Billede slettet', detail: `#${id}` });
  return go(c as C, `${pbase(p)}/trin/indhold`, 'Billedet er slettet.');
});

// Trin D: tjenester
r.post('/virksomheder/:cid/projekter/:pid/trin/tjenester', async (c) => {
  const p = c.get('project');
  const body = await c.req.parseBody({ all: true });
  const raw = body['svc'];
  const wanted = new Set(((Array.isArray(raw) ? raw : raw ? [raw] : []) as string[]).filter((k): k is ServiceKey => k in SERVICES && SERVICES[k as ServiceKey].kinds.includes(p.kind)));
  const errors: string[] = [];
  for (const k of wanted) for (const req of SERVICES[k].requires) if (!wanted.has(req)) errors.push(`${SERVICES[k].label} kræver "${SERVICES[req].label}".`);
  if (p.kind !== 'intern' && !wanted.has('hjemmeside')) errors.push('Et hjemmesideprojekt skal have tjenesten "Offentlig hjemmeside". Vælg "Kun interne systemer" som nyt projekt, hvis kunden ikke skal have en hjemmeside.');
  if (!wanted.size) errors.push('Vælg mindst én tjeneste.');
  if (errors.length) return page(c as C, 'Tjenester', servicesPage({ csrf: c.get('csrf'), project: p, services: await getServices(c.env.DB, p.id), errors }), 422);
  await setEnabledServices(c.env.DB, p, wanted, who(c as C));
  if (body['next'] === '1') return go(c as C, `${pbase(p)}/trin/${await advance(c as C, p, 'tjenester')}`, 'Tjenesterne er gemt.');
  return go(c as C, `${pbase(p)}/trin/tjenester`, 'Tjenesterne er gemt.');
});

// Trin E: opsætning
async function setup(c: C, extra: { flash?: string | null; catalog?: { plan: ReturnType<typeof planCatalog> | null; csv: string; error: string | null } } = {}, status?: 200 | 422) {
  const p = c.get('project');
  const services = await getServices(c.env.DB, p.id);
  const enabled = enabledSet(services);
  const configs: Partial<Record<ServiceKey, Record<string, any>>> = {};
  const problems: Partial<Record<ServiceKey, ReturnType<typeof validateService>>> = {};
  for (const k of enabled) {
    configs[k] = serviceConfig(services.get(k));
    if (services.get(k)!.status !== 'mangler' || Object.keys(configs[k]!).length) problems[k] = validateService(k, configs[k]!, { kind: p.kind, enabled });
  }
  const app = c.env.APP_URL.replace(/\/+$/, '');
  return page(c, 'Opsætning af tjenester', setupPage({
    csrf: c.get('csrf'),
    project: p,
    services,
    configs,
    problems,
    defaults: { hosts: { varebestilling: defaultSystemHost(p.slug, 'varebestilling', kundeDomaene(c.env)), lagerstyring: defaultSystemHost(p.slug, 'lagerstyring', kundeDomaene(c.env)) }, email: c.get('company').email ?? '' },
    catalog: { rows: (configs.varebestilling?.startkatalog ?? []).length, plan: extra.catalog?.plan ?? null, csv: extra.catalog?.csv ?? '', error: extra.catalog?.error ?? null },
    integration: p.kind === 'tilsluttet' && enabled.has('kontaktformular') ? { key: p.public_key, formUrl: `${app}/api/kundeside/${p.public_key}/formular`, configUrl: `${app}/api/kundeside/${p.public_key}/config.json` } : null,
    provisioning: { canDispatch: !!c.env.GITHUB_DISPATCH_TOKEN && !!c.env.PROVISIONERING_TOKEN, flash: null },
    flash: extra.flash ?? flashOf(c),
  }), status);
}

r.post('/virksomheder/:cid/projekter/:pid/trin/opsaetning', async (c) => {
  const p = c.get('project');
  const company = c.get('company');
  const body = await c.req.parseBody();
  const services = await getServices(c.env.DB, p.id);
  const enabled = enabledSet(services);
  let allOk = true;
  for (const k of enabled) {
    const prefix = `${k}.`;
    const fields = Object.fromEntries(Object.entries(body).filter(([n]) => n.startsWith(prefix)).map(([n, v]) => [n.slice(prefix.length), v]));
    const old = serviceConfig(services.get(k));
    const cfg = k === 'hjemmeside' ? old : { ...old, ...readServiceConfig(k, fields) };
    const problems = validateService(k, cfg, { kind: p.kind, enabled });
    if (problems.length) allOk = false;
    await saveServiceConfig(c.env.DB, p, k, cfg, problems.length ? 'mangler' : 'klar', problems.length ? problems.map((x) => x.message).join(' ') : null, who(c as C));
    if (k === 'kundepanel' && !problems.length) {
      const existing = new Set((await listMembers(c.env.DB, company.id)).map((m) => m.email));
      for (const email of cfg.members as string[]) if (!existing.has(email) && !isAdmin(c.env, email)) await invite(c as C, company, email);
      await c.env.DB.prepare("UPDATE project_services SET status = 'forbundet', status_detail = NULL WHERE project_id = ? AND service = 'kundepanel'").bind(p.id).run();
    }
  }
  if (body['next'] === '1' && allOk) return go(c as C, `${pbase(p)}/trin/${await advance(c as C, p, 'opsaetning')}`, 'Opsætningen er gemt.');
  return go(c as C, `${pbase(p)}/trin/opsaetning`, allOk ? 'Opsætningen er gemt.' : 'Gemt. Nogle tjenester mangler stadig oplysninger (se nedenfor).');
});

// Startkatalog: forhåndsvisning (gemmer intet) og anvendelse (kræver bevidst valg ved overskrivning)
r.post('/virksomheder/:cid/projekter/:pid/katalog', async (c) => {
  const p = c.get('project');
  const services = await getServices(c.env.DB, p.id);
  const row = services.get('varebestilling');
  if (!row?.enabled) return notFound(c as C);
  if (row.status === 'forbundet') return setup(c as C, { catalog: { plan: null, csv: '', error: 'Bestillingssystemet er udrullet. Importér varer i systemets egen import.' } }, 422);
  const body = await c.req.parseBody();
  let csv = typeof body['csv'] === 'string' ? body['csv'] : '';
  const file = body['file'];
  if (file instanceof File) {
    if (file.size > 2_000_000) return setup(c as C, { catalog: { plan: null, csv: '', error: 'Filen er større end 2 MB.' } }, 422);
    csv = await file.text();
  }
  if (!csv.trim()) return setup(c as C, { catalog: { plan: null, csv: '', error: 'Vælg en CSV-fil.' } }, 422);
  const cfg = serviceConfig(row);
  const current = Array.isArray(cfg.startkatalog) ? cfg.startkatalog : [];
  const plan = planCatalog(csv, current);
  if (body['op'] !== 'apply' || plan.errors.length) return setup(c as C, { catalog: { plan, csv, error: null } }, plan.errors.length ? 422 : 200);
  const replacing = current.length > 0 && (plan.planned.some((x) => x.action === 'opdater') || plan.removed.length > 0);
  if (replacing && body['confirm_replace'] !== '1') return setup(c as C, { catalog: { plan, csv, error: 'Sæt kryds for at bekræfte, at det nuværende startkatalog skal erstattes.' } }, 422);
  const rows = catalogRows(plan, current);
  await saveServiceConfig(c.env.DB, p, 'varebestilling', { ...cfg, startkatalog: rows }, row.status === 'mangler' ? 'mangler' : 'klar', row.status_detail, who(c as C));
  await audit(c.env.DB, { actor: who(c as C), company_id: p.company_id, project_id: p.id, action: 'Startkatalog gemt', detail: `${rows.length} varer` });
  return go(c as C, `${pbase(p)}/trin/opsaetning#katalog`, `Startkataloget er gemt med ${rows.length} varer. Det lægges ind ved første udrulning.`);
});

r.post('/virksomheder/:cid/projekter/:pid/udrul', async (c) => {
  const p = c.get('project');
  const services = await getServices(c.env.DB, p.id);
  const enabled = enabledSet(services);
  const keys = PROVISIONED.filter((k) => enabled.has(k));
  const problems = keys.flatMap((k) => validateService(k, serviceConfig(services.get(k)), { kind: p.kind, enabled }).map((x) => `${SERVICES[k].label}: ${x.message}`));
  if (!keys.length) return go(c as C, `${pbase(p)}/trin/opsaetning`, 'Ingen tjenester at udrulle.');
  if (problems.length) return go(c as C, `${pbase(p)}/trin/opsaetning?fejl=1`, `Udfyld først: ${problems.join(' ')}`);
  const res = await requestProvisioning(c.env, p, keys, who(c as C));
  return go(c as C, `${pbase(p)}/trin/opsaetning`, res.message);
});

// ---------- Forhåndsvisning, godkendelse og publicering ----------

r.post('/virksomheder/:cid/projekter/:pid/forhaandsvisning', async (c) => {
  const p = c.get('project');
  if (p.kind !== 'skabelon') return notFound(c as C);
  const token = await createPreviewLink(c.env.DB, p, 'admin', ADMIN_PREVIEW_TTL, who(c as C));
  return c.redirect(`/vis/${token}/`, 303);
});

r.post('/virksomheder/:cid/projekter/:pid/kundelink', async (c) => {
  const p = c.get('project');
  if (p.kind !== 'skabelon') return notFound(c as C);
  const label = String((await c.req.parseBody())['label'] ?? '').trim().slice(0, 80) || 'Til kunden';
  const token = await createPreviewLink(c.env.DB, p, label, CUSTOMER_PREVIEW_TTL, who(c as C));
  return hub(c as C, 'overblik', { newLink: `${c.env.APP_URL.replace(/\/+$/, '')}/vis/${token}/` });
});

r.post('/virksomheder/:cid/projekter/:pid/kundelink/:hash/tilbagekald', async (c) => {
  const p = c.get('project');
  await revokePreviewLink(c.env.DB, p, c.req.param('hash'), who(c as C));
  return go(c as C, pbase(p), 'Linket er tilbagekaldt og virker ikke længere.');
});

r.post('/virksomheder/:cid/projekter/:pid/godkend', async (c) => {
  const p = c.get('project');
  if (p.kind === 'intern') return notFound(c as C);
  const v = await approveDraft(c.env.DB, p, who(c as C));
  if (p.onboarding_step !== 'faerdig') await setStep(c.env.DB, p.id, 'gennemgang');
  return go(c as C, `${pbase(p)}/trin/gennemgang`, `Version ${v.number} er godkendt. Godkendelsen gælder kun præcis dette indhold.`);
});

async function doPublish(c: C, kind: 'publicering' | 'tilbagerulning') {
  const p = c.get('project');
  const versionId = Number((await c.req.parseBody())['version_id']);
  const res = await publish(c.env, c.env.DB, c.get('company'), p, versionId, who(c), { kind, verify: (live) => verifyLive(c.env, live) });
  for (const d of await listDomains(c.env.DB, p.id)) forgetHost(d.hostname);
  if (res.kind === 'ok') {
    await setStep(c.env.DB, p.id, 'faerdig');
    return go(c, pbase(p), kind === 'publicering' ? 'Publiceret. Se trinene og domænestatus nedenfor.' : 'Rullet tilbage. Den valgte version er aktiv igen.');
  }
  if (res.kind === 'failed') return c.redirect(`${pbase(p)}?fejl=${encodeURIComponent(res.message)}`, 303);
  return go(c, pbase(p), res.message);
}
r.post('/virksomheder/:cid/projekter/:pid/publicer', (c) => doPublish(c as C, 'publicering'));
r.post('/virksomheder/:cid/projekter/:pid/rul-tilbage', (c) => doPublish(c as C, 'tilbagerulning'));

r.post('/virksomheder/:cid/projekter/:pid/offline', async (c) => {
  const p = c.get('project');
  if ((await c.req.parseBody())['confirm'] !== '1') return go(c as C, pbase(p), 'Sæt kryds for at bekræfte.');
  await c.env.DB.prepare('UPDATE projects SET offline = 1, updated_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), p.id).run();
  await audit(c.env.DB, { actor: who(c as C), company_id: p.company_id, project_id: p.id, action: 'Hjemmeside taget offline' });
  return go(c as C, pbase(p), 'Siden er taget offline. Intet er slettet.');
});
r.post('/virksomheder/:cid/projekter/:pid/online', async (c) => {
  const p = c.get('project');
  await c.env.DB.prepare('UPDATE projects SET offline = 0, updated_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), p.id).run();
  await audit(c.env.DB, { actor: who(c as C), company_id: p.company_id, project_id: p.id, action: 'Hjemmeside sat online igen' });
  return go(c as C, pbase(p), 'Siden er online igen.');
});

// ---------- Domæner ----------

r.post('/virksomheder/:cid/projekter/:pid/domaener', async (c) => {
  const p = c.get('project');
  if (p.kind !== 'skabelon') return notFound(c as C);
  const body = await c.req.parseBody();
  const kind = body['kind'] === 'veyro' ? 'veyro' : 'eget';
  const host = kind === 'veyro' ? veyroHost(c.env, p.slug) : normalizeHost(String(body['hostname'] ?? ''));
  const { row, error } = await addDomain(c.env, c.env.DB, p, host, kind, who(c as C));
  if (!row) return c.redirect(`${pbase(p)}?fejl=${encodeURIComponent(error!)}#domaener`, 303);
  if (kind === 'veyro') await c.env.DB.prepare('UPDATE projects SET slug_locked = 1 WHERE id = ?').bind(p.id).run();
  const after = await setupDomain(c.env, c.env.DB, row, p, who(c as C));
  forgetHost(host);
  return go(c as C, `${pbase(p)}#domaener`, `${host}: ${DOMAIN_STATUS[after.status]}.`);
});

r.post('/virksomheder/:cid/projekter/:pid/domaener/:id/tjek', async (c) => {
  const p = c.get('project');
  const d = (await listDomains(c.env.DB, p.id)).find((x) => x.id === Number(c.req.param('id')));
  if (!d) return notFound(c as C);
  const after = await checkDomain(c.env, c.env.DB, d, p, who(c as C));
  forgetHost(d.hostname);
  return go(c as C, `${pbase(p)}#domaener`, `${d.hostname}: ${DOMAIN_STATUS[after.status]}.`);
});

r.post('/virksomheder/:cid/projekter/:pid/domaener/:id/fjern', async (c) => {
  const p = c.get('project');
  if ((await c.req.parseBody())['confirm'] !== '1') return go(c as C, `${pbase(p)}#domaener`, 'Sæt kryds for at bekræfte.');
  const d = (await listDomains(c.env.DB, p.id)).find((x) => x.id === Number(c.req.param('id')));
  if (!d) return notFound(c as C);
  const res = await removeDomain(c.env, c.env.DB, d, p, who(c as C));
  forgetHost(d.hostname);
  if (!res.ok) return c.redirect(`${pbase(p)}?fejl=${encodeURIComponent(res.error!)}#domaener`, 303);
  return go(c as C, `${pbase(p)}#domaener`, `${d.hostname} er fjernet fra siden.`);
});

// ---------- Brug som startpunkt ----------

r.post('/virksomheder/:cid/projekter/:pid/startpunkt', async (c) => {
  const p = c.get('project');
  if (p.kind !== 'skabelon') return notFound(c as C);
  const target = await getCompany(c.env.DB, String((await c.req.parseBody())['company_id'] ?? ''));
  if (!target) return notFound(c as C);
  const source = p.live_version_id ? (await getVersion(c.env.DB, p.id, p.live_version_id))! : null;
  const cfg = structureOnly(source ? normalizeConfig(JSON.parse(source.content)) : draftOf(p), target.name);
  let slug = slugify(target.name) || 'kunde';
  for (let i = 2; (await slugTaken(c.env.DB, slug)) || slugProblem(slug); i++) slug = `${slugify(target.name).slice(0, 36) || 'kunde'}-${i}`;
  const id = await createProject(c.env.DB, { company_id: target.id, name: 'Hjemmeside', slug, kind: 'skabelon', template: `kopi af ${p.slug}`, external_url: null, draft: cfg }, who(c as C));
  await audit(c.env.DB, { actor: who(c as C), company_id: target.id, project_id: id, action: 'Oprettet med en anden sides opbygning som startpunkt', detail: 'Kun layout, farver og sidestruktur' });
  return go(c as C, `${BASE}/${target.id}/projekter/${id}/trin/indhold`, 'Projektet er oprettet med samme opbygning. Skriv kundens egne tekster i stedet for [[pladsholderne]].');
});

export default r;
