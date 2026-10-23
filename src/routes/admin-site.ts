// Admin for salgshjemmesiden: indhold, sider, menuer, priser, billeder, historik og forespørgsler.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { prospectsForLead } from '../lib/prospects';
import type { OfferForm } from '../lib/offers';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { DEFAULT_VALID_DAYS } from '../lib/offers';
import {
  defaultValue,
  getContent,
  listHistory,
  loadSite,
  restoreHistory,
  saveContent,
  type SectionData,
  type SiteData,
  type SiteMenu,
  type SitePage,
  type SiteProduct,
  type TemplateData,
} from '../site/content';
import { handleize, sectionSchema, sectionTypes, themeSettingsSchema, type SettingDef } from '../site/engine';
import { deleteLead, getLead, leadCounts, listLeads, LEAD_STATUSES, updateLead, viewStats, type LeadCartLine, type LeadRow, type LeadStatus } from '../site/leads';
import { siteHosts } from '../site/app';
import {
  filesPage,
  historyPage,
  leadDetailPage,
  leadsPage,
  menusPage,
  pageEditorPage,
  productsPage,
  sectionsEditorPage,
  settingsPage,
  siteOverviewPage,
  type SiteFile,
} from '../views/admin-site';
import { errorPage } from '../views/pages';

const adminSite = new Hono<AppEnv>();

const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await next();
};
adminSite.use('/hjemmeside', guard);
adminSite.use('/hjemmeside/*', guard);
adminSite.use('/forespoergsler', guard);
adminSite.use('/forespoergsler/*', guard);

const who = (c: Context<AppEnv>) => c.get('session')!.email;

/** Adressen, hvor hjemmesiden kan ses nu (før domæneflytningen: prøveadressen) */
function siteBase(c: Context<AppEnv>): { siteUrl: string; previewUrl: string | null } {
  const siteUrl = (c.env.SITE_URL || 'https://veyro.dk').replace(/\/+$/, '');
  const preview = siteHosts(c.env).find((h) => h.startsWith('ny.'));
  return { siteUrl, previewUrl: preview ? `https://${preview}` : null };
}

/** Fjerner scripts og event-attributter fra HTML, der skrives i admin */
export function cleanHtml(s: string): string {
  return s
    .replace(/<\s*(script|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:/gi, '$1=$2#');
}

async function listFiles(db: D1Database): Promise<SiteFile[]> {
  return (await db.prepare('SELECT id, name, type, size, width, height, created_at FROM site_files ORDER BY id DESC').all<SiteFile>()).results ?? [];
}

// ---------- Oversigt ----------

adminSite.get('/hjemmeside', async (c) => {
  const [site, stats, counts, leads, history] = await Promise.all([
    loadSite(c.env.DB),
    viewStats(c.env.DB, 30),
    leadCounts(c.env.DB),
    listLeads(c.env.DB, 'aabne'),
    listHistory(c.env.DB, undefined, 5),
  ]);
  return render(
    c,
    'Hjemmeside',
    siteOverviewPage({ site, ...siteBase(c), stats, leadCounts: counts, recentLeads: leads.slice(0, 5), history, flash: c.req.query('besked') ?? null }),
    { nav: 'admin-hjemmeside', admin: true },
  );
});

// ---------- Sektioner (sider bygget af sektioner, sidehoved, sidefod, kurv …) ----------

function editableKey(site: SiteData, key: string): boolean {
  if (key.startsWith('template:')) return !!site.templates[key.slice(9)];
  if (key.startsWith('group:')) return !!site.groups[key.slice(6)];
  return false;
}

function sectionsTitle(site: SiteData, key: string): { title: string; back: [string, string]; viewPath: string | null } {
  if (key === 'group:header-group') return { title: 'Sidehoved', back: ['Sidehoved', ''], viewPath: '/' };
  if (key === 'group:footer-group') return { title: 'Sidefod', back: ['Sidefod', ''], viewPath: '/' };
  const n = key.slice(9);
  if (n === 'index') return { title: 'Forside', back: ['Forside', ''], viewPath: '/' };
  if (n === 'cart') return { title: 'Kurv', back: ['Kurv', ''], viewPath: '/cart' };
  if (n === 'product') return { title: 'Abonnementssider', back: ['Abonnementssider', ''], viewPath: site.products[0] ? `/products/${site.products[0].handle}` : null };
  if (n === '404') return { title: 'Siden findes ikke', back: ['404', ''], viewPath: '/pages/findes-ikke' };
  if (n === 'page') return { title: 'Tekstsider (fælles layout)', back: ['Tekstsider', ''], viewPath: null };
  const page = site.pages.find((p) => `page.${p.template}` === n);
  return page
    ? { title: `${page.title}: sektioner`, back: [page.title, `/admin/hjemmeside/side/${page.handle}`], viewPath: `/pages/${page.handle}` }
    : { title: n, back: [n, ''], viewPath: null };
}

async function sectionsView(c: Context<AppEnv>, key: string, extra: { error?: string; status?: 400 | 404 } = {}) {
  const site = await loadSite(c.env.DB);
  if (!editableKey(site, key)) return render(c, 'Findes ikke', errorPage('Findes ikke', '', { href: '/admin/hjemmeside', label: 'Til hjemmesiden' }), { status: 404, admin: true });
  const tpl = (key.startsWith('group:') ? site.groups[key.slice(6)] : site.templates[key.slice(9)])!;
  const [files, history] = await Promise.all([listFiles(c.env.DB), listHistory(c.env.DB, key, 10)]);
  const t = sectionsTitle(site, key);
  const { siteUrl, previewUrl } = siteBase(c);
  const types = sectionTypes()
    .filter((ty) => !['header', 'footer'].includes(ty))
    .map((ty) => ({ type: ty, name: sectionSchema(ty).name ?? ty }))
    .sort((a, b) => a.name.localeCompare(b.name, 'da'));
  return render(
    c,
    t.title,
    sectionsEditorPage({
      csrf: c.get('csrf'),
      key,
      title: t.title,
      back: [t.back[0], t.back[1] || `/admin/hjemmeside/sektioner/${key}`],
      tpl,
      site,
      files,
      saved: site.overridden.has(key),
      history,
      sectionTypes: types,
      viewUrl: t.viewPath ? `${previewUrl ?? siteUrl}${t.viewPath}` : null,
      flash: c.req.query('besked') ?? null,
      error: extra.error ?? null,
    }),
    { nav: 'admin-hjemmeside', admin: true, status: extra.status },
  );
}

adminSite.get('/hjemmeside/sektioner/:key', (c) => sectionsView(c, c.req.param('key')));

/** Læser én indstilling fra formularen ud fra dens type. undefined = feltet blev ikke vist. */
function readSetting(body: Record<string, unknown>, name: string, def: SettingDef): unknown {
  const raw = body[name];
  switch (def.type) {
    case 'header':
    case 'paragraph':
    case 'collection':
    case 'font_picker':
      return undefined;
    case 'checkbox':
      return raw === '1';
    case 'range':
    case 'number': {
      if (typeof raw !== 'string' || raw.trim() === '') return def.default;
      let n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) return def.default;
      if (def.min != null) n = Math.max(def.min, n);
      if (def.max != null) n = Math.min(def.max, n);
      return n;
    }
    case 'select':
    case 'radio':
      return typeof raw === 'string' && (def.options ?? []).some((o) => o.value === raw) ? raw : def.default;
    case 'color':
      return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : def.default;
    case 'richtext':
    case 'inline_richtext':
    case 'html':
    case 'textarea':
    case 'liquid':
      return typeof raw === 'string' ? cleanHtml(raw.replace(/\r\n/g, '\n')).slice(0, 20000) : undefined;
    default:
      return typeof raw === 'string' ? raw.trim().slice(0, 2000) : undefined;
  }
}

function newId(existing: string[], prefix: string): string {
  for (;;) {
    const id = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    if (!existing.includes(id)) return id;
  }
}

function sectionDefaults(type: string): SectionData {
  const schema = sectionSchema(type);
  const preset = schema.presets?.[0];
  const sec: SectionData = { type, settings: { ...(preset?.settings ?? {}) } };
  if (schema.blocks?.length) {
    sec.blocks = {};
    sec.block_order = [];
    for (const b of preset?.blocks ?? []) {
      const id = newId(sec.block_order, 'b');
      sec.blocks[id] = { type: b.type, settings: { ...(b.settings ?? {}) } };
      sec.block_order.push(id);
    }
  }
  return sec;
}

adminSite.post('/hjemmeside/sektioner/:key', async (c) => {
  const key = c.req.param('key');
  const site = await loadSite(c.env.DB);
  if (!editableKey(site, key)) return c.text('Findes ikke', 404);
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const action = String(body['action'] ?? 'save');
  if (action === 'reset') {
    await saveContent(c.env.DB, key, null, who(c), 'Sat tilbage til standard');
    return c.redirect(`/admin/hjemmeside/sektioner/${key}?besked=nulstillet`, 303);
  }
  const cur: TemplateData = structuredClone((key.startsWith('group:') ? site.groups[key.slice(6)] : site.templates[key.slice(9)])!);
  const positions: [string, number][] = [];
  const out: TemplateData = { ...cur, sections: {}, order: [] };
  const allIds = [...cur.order, ...Object.keys(cur.sections).filter((id) => !cur.order.includes(id))];
  allIds.forEach((sid, idx) => {
    const sec = cur.sections[sid];
    if (!sec || body[`del|${sid}`] === '1') return;
    const schema = sectionSchema(sec.type);
    const settings: Record<string, unknown> = { ...(sec.settings ?? {}) };
    for (const d of schema.settings ?? []) {
      if (!d.id) continue;
      const v = readSetting(body, `s|${sid}|${d.id}`, d);
      if (v !== undefined) settings[d.id] = v;
    }
    const next: SectionData = { ...sec, settings };
    if (body[`hide|${sid}`] === '1') next.disabled = true;
    else delete next.disabled;
    if (sec.blocks) {
      const border = sec.block_order ?? Object.keys(sec.blocks);
      const bpos: [string, number][] = [];
      const blocks: NonNullable<SectionData['blocks']> = {};
      border.forEach((bid, bi) => {
        const b = sec.blocks![bid];
        if (!b || body[`bdel|${sid}|${bid}`] === '1') return;
        const bdef = (schema.blocks ?? []).find((x) => x.type === b.type);
        const bs: Record<string, unknown> = { ...(b.settings ?? {}) };
        for (const d of bdef?.settings ?? []) {
          if (!d.id) continue;
          const v = readSetting(body, `b|${sid}|${bid}|${d.id}`, d);
          if (v !== undefined) bs[d.id] = v;
        }
        const nb = { ...b, settings: bs };
        if (body[`bhide|${sid}|${bid}`] === '1') nb.disabled = true;
        else delete nb.disabled;
        blocks[bid] = nb;
        const p = Number(body[`bpos|${sid}|${bid}`]);
        bpos.push([bid, Number.isFinite(p) ? p + bi / 1000 : bi + 1]);
      });
      next.blocks = blocks;
      next.block_order = bpos.sort((a, b) => a[1] - b[1]).map(([id]) => id);
    }
    out.sections[sid] = next;
    const p = Number(body[`pos|${sid}`]);
    positions.push([sid, Number.isFinite(p) ? p + idx / 1000 : idx + 1]);
  });
  out.order = positions.sort((a, b) => a[1] - b[1]).map(([id]) => id);

  let anchor = '';
  // + Element: tilføj en blok med standardværdier
  const addBlock = typeof body['add_block'] === 'string' ? body['add_block'] : '';
  if (addBlock) {
    const [sid = '', btype = ''] = addBlock.split('|');
    const sec = out.sections[sid];
    const bdef = sec && (sectionSchema(sec.type).blocks ?? []).find((b) => b.type === btype);
    if (sec && bdef) {
      sec.blocks ??= {};
      sec.block_order ??= [];
      const id = newId(Object.keys(sec.blocks), 'b');
      const settings: Record<string, unknown> = {};
      for (const d of bdef.settings ?? []) if (d.id && d.default !== undefined) settings[d.id] = d.default;
      sec.blocks[id] = { type: btype, settings };
      sec.block_order.push(id);
      anchor = `#s-${sid}`;
    }
  }
  // Tilføj sektion nederst
  if (action === 'add_section') {
    const type = String(body['add_section'] ?? '');
    if (!sectionTypes().includes(type) || ['header', 'footer'].includes(type)) return sectionsView(c, key, { error: 'Vælg en sektion.', status: 400 });
    const id = newId(Object.keys(out.sections), type.replace(/[^a-z0-9]/g, ''));
    out.sections[id] = sectionDefaults(type);
    out.order.push(id);
    anchor = `#s-${id}`;
  }
  await saveContent(c.env.DB, key, out, who(c));
  return c.redirect(`/admin/hjemmeside/sektioner/${key}?besked=gemt${anchor}`, 303);
});

// ---------- Sider ----------

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

async function pageView(c: Context<AppEnv>, handle: string | null, extra: { error?: string; status?: 400 | 404 | 409; form?: Partial<SitePage> & { copy_from?: string } } = {}) {
  const site = await loadSite(c.env.DB);
  const page = handle ? (site.pages.find((p) => p.handle === handle) ?? null) : null;
  if (handle && !page) return render(c, 'Findes ikke', errorPage('Siden findes ikke', '', { href: '/admin/hjemmeside', label: 'Til hjemmesiden' }), { status: 404, admin: true });
  const history = handle ? await listHistory(c.env.DB, `page:${handle}`, 10) : [];
  const { siteUrl, previewUrl } = siteBase(c);
  return render(
    c,
    page?.title ?? 'Ny side',
    pageEditorPage({
      csrf: c.get('csrf'),
      page,
      site,
      isDefault: !!(handle && defaultValue(`page:${handle}`)),
      history,
      flash: c.req.query('besked') ?? null,
      error: extra.error ?? null,
      form: extra.form,
      viewUrl: page ? `${previewUrl ?? siteUrl}/pages/${page.handle}` : null,
    }),
    { nav: 'admin-hjemmeside', admin: true, status: extra.status },
  );
}

adminSite.get('/hjemmeside/sider/ny', (c) => pageView(c, null));
adminSite.get('/hjemmeside/side/:handle', (c) => pageView(c, c.req.param('handle')));

adminSite.post('/hjemmeside/sider/ny', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const title = str('title').slice(0, 120);
  const handle = (str('handle') ? handleize(str('handle')) : handleize(title)).slice(0, 60);
  const copyFrom = str('copy_from');
  const form = { title, handle: str('handle'), description: str('description'), body: str('body'), published: body['published'] === '1', copy_from: copyFrom };
  if (!title) return pageView(c, null, { error: 'Skriv en titel.', status: 400, form });
  if (!HANDLE_RE.test(handle)) return pageView(c, null, { error: 'Adressen må kun indeholde små bogstaver, tal og bindestreg.', status: 400, form });
  const site = await loadSite(c.env.DB);
  if (site.pages.some((p) => p.handle === handle)) return pageView(c, null, { error: `Der findes allerede en side med adressen /pages/${handle}.`, status: 409, form });
  let template = '';
  if (copyFrom) {
    const src = site.templates[`page.${copyFrom}`];
    if (!src) return pageView(c, null, { error: 'Vælg en gyldig sidetype.', status: 400, form });
    template = handle;
    if (site.templates[`page.${template}`]) return pageView(c, null, { error: 'Der findes allerede et layout med den adresse.', status: 409, form });
    await saveContent(c.env.DB, `template:page.${template}`, structuredClone(src), who(c), `Kopi af ${copyFrom}`);
  }
  const page: SitePage = { handle, title, template, body: cleanHtml(form.body), published: form.published, description: form.description.slice(0, 300) };
  await saveContent(c.env.DB, `page:${handle}`, page, who(c), 'Oprettet');
  return c.redirect(template ? `/admin/hjemmeside/sektioner/template:page.${template}?besked=oprettet` : `/admin/hjemmeside/side/${handle}?besked=oprettet`, 303);
});

adminSite.post('/hjemmeside/side/:handle', async (c) => {
  const handle = c.req.param('handle');
  const site = await loadSite(c.env.DB);
  const page = site.pages.find((p) => p.handle === handle);
  if (!page) return c.text('Findes ikke', 404);
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const title = str('title').slice(0, 120);
  if (!title) return pageView(c, handle, { error: 'Skriv en titel.', status: 400 });
  const next: SitePage = {
    ...page,
    title,
    description: str('description').slice(0, 300),
    published: body['published'] === '1',
    body: page.template ? page.body : cleanHtml(typeof body['body'] === 'string' ? (body['body'] as string).replace(/\r\n/g, '\n') : page.body).slice(0, 100000),
  };
  await saveContent(c.env.DB, `page:${handle}`, next, who(c));
  return c.redirect(`/admin/hjemmeside/side/${handle}?besked=gemt`, 303);
});

adminSite.post('/hjemmeside/side/:handle/slet', async (c) => {
  const handle = c.req.param('handle');
  const body = await c.req.parseBody();
  if (body['confirm'] !== '1') return pageView(c, handle, { error: 'Sæt kryds for at bekræfte, at siden skal slettes.', status: 400 });
  const site = await loadSite(c.env.DB);
  if (!site.pages.some((p) => p.handle === handle)) return c.text('Findes ikke', 404);
  // Standardsider markeres som slettet (så de ikke kommer igen fra koden); egne sider fjernes.
  await saveContent(c.env.DB, `page:${handle}`, defaultValue(`page:${handle}`) ? { deleted: true } : null, who(c), 'Slettet');
  return c.redirect('/admin/hjemmeside?besked=slettet', 303);
});

// ---------- Menuer ----------

adminSite.get('/hjemmeside/menuer', async (c) => {
  const [site, history] = await Promise.all([loadSite(c.env.DB), listHistory(c.env.DB, 'menus', 10)]);
  return render(c, 'Menuer', menusPage({ csrf: c.get('csrf'), site, history, flash: c.req.query('besked') ?? null }), { nav: 'admin-hjemmeside', admin: true });
});

adminSite.post('/hjemmeside/menuer', async (c) => {
  const site = await loadSite(c.env.DB);
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const menus: Record<string, SiteMenu> = {};
  for (const [handle, m] of Object.entries(site.menus)) {
    const rows: { title: string; url: string; pos: number }[] = [];
    for (let i = 0; i < m.items.length + 2; i++) {
      const title = String(body[`m|${handle}|${i}|title`] ?? '').trim().slice(0, 80);
      let url = String(body[`m|${handle}|${i}|url`] ?? '').trim().slice(0, 300);
      if (!title) continue;
      if (/^\s*javascript:/i.test(url)) url = '#';
      const pos = Number(body[`m|${handle}|${i}|pos`]);
      rows.push({ title, url: url || '/', pos: (Number.isFinite(pos) ? pos : i + 1) + i / 1000 });
    }
    menus[handle] = { title: m.title, items: rows.sort((a, b) => a.pos - b.pos).map(({ title, url }) => ({ title, url })) };
  }
  await saveContent(c.env.DB, 'menus', menus, who(c));
  return c.redirect('/admin/hjemmeside/menuer?besked=gemt', 303);
});

// ---------- Abonnementer og priser ----------

adminSite.get('/hjemmeside/produkter', async (c) => {
  const site = await loadSite(c.env.DB);
  return render(c, 'Abonnementer og priser', productsPage({ csrf: c.get('csrf'), site, flash: c.req.query('besked') ?? null }), { nav: 'admin-hjemmeside', admin: true });
});

function parsePriceKr(raw: unknown): number | null {
  const s = String(raw ?? '').trim().replace(/\s|kr\.?/gi, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const oere = Math.round(Number(s) * 100);
  return oere >= 0 && oere <= 100_000_000 ? oere : null;
}

adminSite.post('/hjemmeside/produkter', async (c) => {
  const site = await loadSite(c.env.DB);
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const read = (k: string, base: SiteProduct | null): SiteProduct | { error: string } => {
    const title = str(`p|${k}|title`).slice(0, 120);
    const price = parsePriceKr(body[`p|${k}|price`]);
    if (!title) return { error: 'Skriv et navn på abonnementet.' };
    if (price === null) return { error: `Skriv en gyldig pris for ${title}, fx 599 eller 1.099,50.` };
    return {
      handle: base?.handle ?? '',
      title,
      price,
      interval: str(`p|${k}|interval`) === 'year' ? 'year' : 'month',
      status: str(`p|${k}|status`) === 'draft' ? 'draft' : 'active',
      type: str(`p|${k}|type`).slice(0, 60) || 'Abonnement',
      description: cleanHtml(str(`p|${k}|description`)).slice(0, 10000),
    };
  };
  const changes: [string, SiteProduct | { deleted: true } | null][] = [];
  for (const p of site.products) {
    if (body[`p|${p.handle}|delete`] === '1') {
      changes.push([`product:${p.handle}`, defaultValue(`product:${p.handle}`) ? { deleted: true } : null]);
      continue;
    }
    const r = read(p.handle, p);
    if ('error' in r) return render(c, 'Abonnementer og priser', productsPage({ csrf: c.get('csrf'), site, flash: null, error: r.error }), { nav: 'admin-hjemmeside', admin: true, status: 400 });
    if (JSON.stringify(r) !== JSON.stringify(p)) changes.push([`product:${p.handle}`, r]);
  }
  if (str('p|_new|title')) {
    const r = read('_new', null);
    const handle = handleize(str('p|_new|handle') || str('p|_new|title')).slice(0, 60);
    if ('error' in r) return render(c, 'Abonnementer og priser', productsPage({ csrf: c.get('csrf'), site, flash: null, error: r.error }), { nav: 'admin-hjemmeside', admin: true, status: 400 });
    if (!HANDLE_RE.test(handle) || site.products.some((p) => p.handle === handle))
      return render(c, 'Abonnementer og priser', productsPage({ csrf: c.get('csrf'), site, flash: null, error: 'Adressen på det nye abonnement er ugyldig eller findes allerede.' }), { nav: 'admin-hjemmeside', admin: true, status: 400 });
    changes.push([`product:${handle}`, { ...r, handle }]);
  }
  for (const [key, value] of changes) await saveContent(c.env.DB, key, value, who(c));
  return c.redirect('/admin/hjemmeside/produkter?besked=gemt', 303);
});

// ---------- Temaindstillinger ----------

adminSite.get('/hjemmeside/indstillinger', async (c) => {
  const [site, files, history] = await Promise.all([loadSite(c.env.DB), listFiles(c.env.DB), listHistory(c.env.DB, 'settings', 10)]);
  const groups = themeSettingsSchema().filter((g) => g.name !== 'theme_info');
  return render(c, 'Temaindstillinger', settingsPage({ csrf: c.get('csrf'), site, files, groups, history, flash: c.req.query('besked') ?? null }), { nav: 'admin-hjemmeside', admin: true });
});

adminSite.post('/hjemmeside/indstillinger', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const cur = (await getContent<Record<string, unknown>>(c.env.DB, 'settings')).value ?? {};
  const next: Record<string, unknown> = { ...cur };
  for (const g of themeSettingsSchema()) {
    for (const d of g.settings ?? []) {
      if (!d.id) continue;
      const v = readSetting(body, `g|${d.id}`, d);
      if (v !== undefined) next[d.id] = v;
    }
  }
  await saveContent(c.env.DB, 'settings', next, who(c));
  return c.redirect('/admin/hjemmeside/indstillinger?besked=gemt', 303);
});

// ---------- Billeder ----------

/** Læser billedets størrelse fra filens header (PNG, JPEG, GIF, WebP) */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = (i: number) => bytes[i] ?? 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && b(0) === 0x89 && b(1) === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (bytes.length > 10 && b(0) === 0x47 && b(1) === 0x49) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (bytes.length > 30 && b(0) === 0x52 && b(8) === 0x57) {
    const kind = String.fromCharCode(b(12), b(13), b(14), b(15));
    if (kind === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: 1 + (b(24) | (b(25) << 8) | (b(26) << 16)), height: 1 + (b(27) | (b(28) << 8) | (b(29) << 16)) };
  }
  if (b(0) === 0xff && b(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (b(i) !== 0xff) {
        i++;
        continue;
      }
      const marker = b(i + 1);
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

adminSite.get('/hjemmeside/billeder', async (c) => {
  const files = await listFiles(c.env.DB);
  return render(c, 'Billeder', filesPage({ csrf: c.get('csrf'), files, flash: c.req.query('besked') ?? null }), { nav: 'admin-hjemmeside', admin: true });
});

adminSite.get('/hjemmeside/billeder/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT type, data FROM site_files WHERE id = ?').bind(Number(c.req.param('id'))).first<{ type: string; data: ArrayBuffer | number[] }>();
  if (!row) return c.text('Ikke fundet', 404);
  return c.body(new Uint8Array(row.data as ArrayBuffer) as any, 200, { 'Content-Type': row.type, 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox" });
});

adminSite.post('/hjemmeside/billeder', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  const fail = async (error: string) => render(c, 'Billeder', filesPage({ csrf: c.get('csrf'), files: await listFiles(c.env.DB), flash: null, error }), { nav: 'admin-hjemmeside', admin: true, status: 400 });
  if (!(file instanceof File) || file.size === 0) return fail('Vælg et billede.');
  if (file.size > 1_500_000) return fail('Billedet er større end 1,5 MB. Gør det mindre, og prøv igen.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = imageSize(bytes);
  const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : '';
  if (!IMAGE_TYPES[type] || !size) return fail('Filen er ikke et PNG-, JPG-, WebP- eller GIF-billede.');
  const name = (file.name || `billede.${IMAGE_TYPES[type]}`).replace(/[^\wæøåÆØÅ. -]/g, '').slice(0, 100) || `billede.${IMAGE_TYPES[type]}`;
  await c.env.DB.prepare('INSERT INTO site_files (name, type, size, width, height, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(name, type, bytes.length, size.width, size.height, bytes, Math.floor(Date.now() / 1000), who(c))
    .run();
  return c.redirect('/admin/hjemmeside/billeder?besked=uploadet', 303);
});

adminSite.post('/hjemmeside/billeder/:id/slet', async (c) => {
  await c.env.DB.prepare('DELETE FROM site_files WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.redirect('/admin/hjemmeside/billeder?besked=billede-slettet', 303);
});

// ---------- Historik ----------

adminSite.get('/hjemmeside/historik', async (c) => {
  const [site, rows] = await Promise.all([loadSite(c.env.DB), listHistory(c.env.DB, undefined, 200)]);
  return render(c, 'Historik', historyPage({ csrf: c.get('csrf'), site, rows, flash: c.req.query('besked') ?? null }), { nav: 'admin-hjemmeside', admin: true });
});

adminSite.post('/hjemmeside/historik/:id/gendan', async (c) => {
  const body = await c.req.parseBody();
  const key = await restoreHistory(c.env.DB, Number(c.req.param('id')), who(c));
  if (!key) return c.text('Findes ikke', 404);
  const back = typeof body['back'] === 'string' && body['back'].startsWith('/admin/hjemmeside') ? body['back'] : '/admin/hjemmeside/historik';
  return c.redirect(`${back}?besked=gendannet`, 303);
});

// ---------- Forespørgsler ----------

adminSite.get('/forespoergsler', async (c) => {
  const q = c.req.query('status') ?? 'aabne';
  const filter = q === 'alle' || q === 'aabne' || (LEAD_STATUSES as readonly string[]).includes(q) ? q : 'aabne';
  const [rows, counts] = await Promise.all([listLeads(c.env.DB, filter === 'alle' ? null : filter), leadCounts(c.env.DB)]);
  return render(c, 'Forespørgsler', leadsPage({ rows, filter, counts }), { nav: 'admin-forespoergsler', admin: true });
});

adminSite.get('/forespoergsler/:id', async (c) => {
  const lead = await getLead(c.env.DB, Number(c.req.param('id')));
  if (!lead) return render(c, 'Findes ikke', errorPage('Forespørgslen findes ikke', '', { href: '/admin/forespoergsler', label: 'Til forespørgsler' }), { status: 404, admin: true });
  const prospects = await prospectsForLead(c.env.DB, lead);
  return render(c, `Forespørgsel #${lead.id}`, leadDetailPage({ csrf: c.get('csrf'), lead, flash: c.req.query('besked') ?? null, offerUrl: null, prospects }), { nav: 'admin-forespoergsler', admin: true });
});

adminSite.post('/forespoergsler/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const status = String(body['status'] ?? '');
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) return c.text('Ugyldig status', 400);
  await updateLead(c.env.DB, id, { status: status as LeadStatus, note: String(body['note'] ?? '').trim().slice(0, 2000) || null });
  return c.redirect(`/admin/forespoergsler/${id}?besked=gemt`, 303);
});

adminSite.post('/forespoergsler/:id/slet', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (body['confirm'] !== '1') return c.redirect(`/admin/forespoergsler/${id}`, 303);
  await deleteLead(c.env.DB, id);
  return c.redirect('/admin/forespoergsler', 303);
});

/** Udfylder tilbudsformularen ud fra en forespørgsel (priser på hjemmesiden er inkl. moms, tilbud er ekskl.) */
export function offerFormFromLead(l: LeadRow): OfferForm {
  let cart: LeadCartLine[] = [];
  try {
    cart = l.cart ? JSON.parse(l.cart) : [];
  } catch {
    cart = [];
  }
  const totalIncl = cart.reduce((s, x) => s + x.price * x.quantity, 0);
  const interval = cart.length && cart.every((x) => x.interval === 'year') ? 'year' : 'month';
  const net = totalIncl ? Math.round(totalIncl / 1.25) / 100 : 0;
  return {
    email: l.email,
    name: l.name ?? '',
    company: l.company ?? '',
    cvr: '',
    phone: l.phone ?? '',
    address: '',
    postal_code: '',
    city: '',
    service: cart.length ? cart.map((x) => `${x.quantity > 1 ? `${x.quantity} × ` : ''}${x.title}`).join(', ').slice(0, 120) : (l.service ?? ''),
    description: (l.message ?? '').slice(0, 500),
    price: net ? net.toFixed(2).replace('.', ',') : '',
    interval,
    setup_price: '',
    setup_description: '',
    vat: true,
    setup_settled: false,
    first_charge: '',
    settled_note: '',
    valid_days: String(DEFAULT_VALID_DAYS),
    confirm_existing: false,
  };
}

export default adminSite;
