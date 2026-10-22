// Kundepanel › Hjemmeside: kundens egne brugere ser deres virksomheds hjemmesider, systemer og henvendelser.
// Adgangen afgøres alene af company_members på serveren; et projekt-id i adressen giver ingen adgang i sig selv.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { render } from '../render';
import { companiesForMember, getServices, listDomains, listLeads, listProjects, projectForMember } from '../kunder/model';
import { publicationState } from '../kunder/publicering';
import { SERVICE_ORDER, SERVICES } from '../kunder/tjenester';
import { memberSitesPage } from '../views/admin-kunder';
import { errorPage } from '../views/pages';

const site = new Hono<AppEnv>();

const STATUS: Record<string, string> = { mangler: 'Under opsætning', klar: 'Under opsætning', afventer: 'Under opsætning', forbundet: 'Aktiv', blokeret: 'Under opsætning' };

async function items(c: Context<AppEnv>, onlyProject?: string) {
  const email = c.get('session')!.email;
  const out = [];
  for (const company of await companiesForMember(c.env.DB, email)) {
    for (const project of await listProjects(c.env.DB, company.id)) {
      if (onlyProject && project.id !== onlyProject) continue;
      const [domains, services] = await Promise.all([listDomains(c.env.DB, project.id), getServices(c.env.DB, project.id)]);
      const active = domains.find((d) => d.kind === 'eget' && d.status === 'aktiv') ?? domains.find((d) => d.status === 'aktiv');
      const live = project.offline || !project.live_version_id ? null : project.kind === 'tilsluttet' ? project.external_url : active ? `https://${active.hostname}` : `${c.env.APP_URL.replace(/\/+$/, '')}/s/${project.slug}/`;
      out.push({
        company,
        project,
        live,
        state: publicationState(project, domains),
        // Kun rigtige henvendelser; test fra forhåndsvisningen vises ikke for kunden
        leads: await listLeads(c.env.DB, project.id, { includeTest: false }, 25),
        services: SERVICE_ORDER.filter((k) => k !== 'hjemmeside' && services.get(k)?.enabled).map((k) => ({
          label: SERVICES[k].label,
          status: STATUS[services.get(k)!.status] ?? 'Under opsætning',
          url: services.get(k)!.status === 'forbundet' ? services.get(k)!.provisioned_url : null,
        })),
      });
    }
  }
  return out;
}

site.get('/', async (c) => render(c, 'Hjemmeside', memberSitesPage({ items: await items(c) }), { nav: 'hjemmeside' as any }));

site.get('/:pid', async (c) => {
  const p = await projectForMember(c.env.DB, c.get('session')!.email, c.req.param('pid'));
  if (!p) return render(c, 'Findes ikke', errorPage('Findes ikke', 'Siden findes ikke, eller du har ikke adgang til den.', { href: '/konto/hjemmeside', label: 'Til jeres hjemmeside' }), { status: 404 });
  return render(c, p.name, memberSitesPage({ items: await items(c, p.id) }), { nav: 'hjemmeside' as any });
});

export default site;
