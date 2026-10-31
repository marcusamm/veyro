// Bygger Shopify-lignende Liquid-objekter ud fra indholdet og gengiver en hel side.
import type { SiteData, SitePage, SiteProduct, SectionData, TemplateData } from './content';
import { Color, translate, engine, parsedFile, sectionSchema, themeSettingsSchema, type FormState, type RenderHooks, type SettingDef } from './engine';
import { contentText, localizedContent, localizedPath, localizeLinks, SITE_LANGUAGES, type SiteLanguage } from './localization';
import { THEME_FILES } from './theme.generated';

export type PageType = 'index' | 'page' | 'product' | 'cart' | '404';

export interface CartLine {
  handle: string;
  quantity: number;
}

export interface RenderRequest {
  type: PageType;
  language?: SiteLanguage;
  /** Stien uden forespørgsel, fx /pages/kontakt */
  path: string;
  /** Værten, siden vises på (fx veyro.dk eller ny.veyro.dk) */
  host: string;
  /** Kanonisk adresse for siden, fx https://veyro.dk */
  canonicalOrigin: string;
  page?: SitePage;
  product?: SiteProduct;
  cart: CartLine[];
  forms?: Record<string, FormState>;
}

/** Billeder gemmes som "file:<id>:<bredde>x<højde>" i indstillingerne */
export function imageObject(v: unknown): Record<string, unknown> | null {
  const m = typeof v === 'string' ? v.match(/^file:(\d+):(\d+)x(\d+)$/) : null;
  if (!m) return null;
  const width = Number(m[2]) || 1;
  const height = Number(m[3]) || 1;
  return { src: `/files/${m[1]}`, width, height, aspect_ratio: width / height, alt: '', id: Number(m[1]) };
}

export function productDrop(p: SiteProduct) {
  const available = p.status === 'active';
  const variant = { id: p.handle, title: 'Default Title', price: p.price, available, compare_at_price: null };
  return {
    id: p.handle,
    handle: p.handle,
    title: p.title,
    type: p.type,
    url: `/products/${p.handle}`,
    price: p.price,
    price_min: p.price,
    price_max: p.price,
    price_varies: false,
    available,
    description: p.description,
    content: p.description,
    has_only_default_variant: true,
    variants: [variant],
    selected_or_first_available_variant: variant,
    first_available_variant: variant,
    requires_selling_plan: false,
    selling_plan_groups: [],
    featured_media: null,
    featured_image: null,
    images: [],
    media: [],
    tags: [],
    options: [],
  };
}

export function pageDrop(p: SitePage) {
  return { id: p.handle, handle: p.handle, title: p.title, url: `/pages/${p.handle}`, content: p.body, template_suffix: p.template || null };
}

export function cartDrop(site: SiteData, lines: CartLine[]) {
  const items = [];
  let total = 0;
  let count = 0;
  let i = 0;
  for (const line of lines) {
    const p = site.products.find((x) => x.handle === line.handle && x.status === 'active');
    if (!p) continue;
    i++;
    const product = productDrop(p);
    const linePrice = p.price * line.quantity;
    total += linePrice;
    count += line.quantity;
    items.push({
      key: `${p.handle}:${i}`,
      id: p.handle,
      title: p.title,
      url: product.url,
      quantity: line.quantity,
      price: p.price,
      final_price: p.price,
      line_price: linePrice,
      final_line_price: linePrice,
      product,
      variant: product.variants[0],
      url_to_remove: `/cart/change?line=${i}&quantity=0`,
      selling_plan_allocation: null,
    });
  }
  return { item_count: count, items, total_price: total, original_total_price: total, currency: { iso_code: 'DKK' }, taxes_included: true, note: '', requires_shipping: false };
}

function linklists(site: SiteData, path: string) {
  const out: Record<string, unknown> = {};
  for (const [handle, menu] of Object.entries(site.menus)) {
    out[handle] = {
      handle,
      title: menu.title,
      links: menu.items.map((l) => {
        const url = l.url || '#';
        const current = url.split('#')[0] === path && !url.includes('#');
        return { title: l.title, url, current, active: current, child_active: false, child_current: false, links: [], type: 'http_link' };
      }),
    };
  }
  return out;
}

function resolveSettings(site: SiteData, defs: SettingDef[] | undefined, vals: Record<string, unknown> | undefined, ctx: { pages: Record<string, unknown>; linklists: Record<string, unknown>; language?: SiteLanguage }) {
  const out: Record<string, unknown> = {};
  for (const d of defs ?? []) if (d.id) out[d.id] = d.default ?? (d.type === 'checkbox' ? false : d.type === 'range' ? (d.min ?? 0) : '');
  Object.assign(out, vals ?? {});
  for (const d of defs ?? []) if (d.id && !['services', 'options', 'subscription_type'].includes(d.id) && ['text', 'textarea', 'richtext', 'inline_richtext'].includes(d.type) && typeof out[d.id] === 'string') out[d.id] = contentText(out[d.id] as string, ctx.language ?? 'da');
  for (const d of defs ?? []) {
    if (!d.id) continue;
    const v = out[d.id];
    switch (d.type) {
      case 'link_list':
        out[d.id] = typeof v === 'string' ? (ctx.linklists[v] ?? { links: [] }) : { links: [] };
        break;
      case 'product': {
        const p = typeof v === 'string' ? site.products.find((x) => x.handle === v && x.status === 'active') : null;
        out[d.id] = p ? productDrop(p) : null;
        break;
      }
      case 'page':
        out[d.id] = typeof v === 'string' && v ? (ctx.pages[v] ?? null) : null;
        break;
      case 'image_picker':
        out[d.id] = imageObject(v);
        break;
      case 'color':
        out[d.id] = typeof v === 'string' && v ? new Color(v) : v;
        break;
      case 'collection':
        out[d.id] = null;
        break;
    }
  }
  return out;
}

export function sectionFileExists(type: string): boolean {
  return THEME_FILES[`sections/${type}.liquid`] != null;
}

export function templateFor(req: RenderRequest): string {
  if (req.type === 'page') return req.page?.template ? `page.${req.page.template}` : 'page';
  return req.type;
}

export function renderSitePage(site: SiteData, req: RenderRequest): string {
  const language = req.language ?? 'da';
  const originalPageContent = req.page?.body;
  site = localizedContent(site, language);
  req = { ...req, page: req.page ? site.pages.find(p => p.handle === req.page!.handle) : undefined, product: req.product ? site.products.find(p => p.handle === req.product!.handle) : undefined };
  const publicPath = language === 'da' ? req.path : `/${language}${req.path}`;
  const pages: Record<string, unknown> = {};
  for (const p of site.pages) if (p.published) pages[p.handle] = pageDrop(p);
  const lists = linklists(site, req.path);
  const settingsDefs = themeSettingsSchema().flatMap((g) => g.settings ?? []);
  const settings = resolveSettings(site, settingsDefs, site.settings, { pages, linklists: lists, language });

  const tplName = templateFor(req);
  const tpl: TemplateData | undefined = site.templates[tplName] ?? site.templates[req.type === 'page' ? 'page' : '404'];
  const title =
    req.type === 'index'
      ? site.shop.name
      : req.type === 'page'
        ? (req.page?.title ?? '')
        : req.type === 'product'
          ? (req.product?.title ?? '')
          : req.type === 'cart'
            ? translate('cart.title', {}, language)
            : translate('not_found.title', {}, language);
  const description = req.type === 'page' ? req.page?.description || '' : req.type === 'product' ? (req.product?.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';

  const hooks: RenderHooks = {
    forms: req.forms ?? {},
    path: publicPath,
    language,
    host: req.host,
    renderGroup: (name) => {
      const g = site.groups[name];
      if (!g) return '';
      let out = '';
      for (const id of g.order) if (g.sections[id]) out += renderSection(id, g.sections[id]);
      return out;
    },
  };

  const globals: Record<string, unknown> = {
    __hooks: hooks,
    settings,
    pages,
    linklists: lists,
    cart: cartDrop(site, req.cart),
    shop: { name: site.shop.name, email: site.shop.email, url: req.canonicalOrigin, domain: req.host, currency: 'DKK' },
    routes: { root_url: localizedPath('/', language), cart_url: '/cart', cart_add_url: '/cart/add', cart_change_url: '/cart/change', cart_update_url: '/cart/update', cart_clear_url: '/cart/clear', search_url: '/search', account_url: 'https://kunde.veyro.dk/login' },
    request: { locale: { iso_code: language }, page_type: req.type, design_mode: false, origin: req.canonicalOrigin, host: req.host, path: publicPath },
    template: { name: req.type, suffix: tplName.startsWith('page.') ? tplName.slice(5) : null, directory: null },
    page_title: contentText(title, language),
    page_description: description || null,
    canonical_url: req.canonicalOrigin + publicPath,
    site_languages: SITE_LANGUAGES.map(code => ({ code, label: { da: 'Dansk', en: 'English', sv: 'Svenska' }[code], url: localizedPath(req.type === '404' ? '/' : req.path, code), canonical: req.canonicalOrigin + localizedPath(req.type === '404' ? '/' : req.path, code), current: language === code })),
    language_label: { da: 'Vælg sprog', en: 'Choose language', sv: 'Välj språk' }[language],
    current_page: 1,
    current_tags: null,
    content_for_header: '',
    localization: { language: { iso_code: language }, country: { iso_code: 'DK' } },
    customer: null,
  };
  if (req.page) globals.page = { ...pageDrop(req.page), original_content: originalPageContent };
  if (req.product) globals.product = productDrop(req.product);

  // Synkron gengivelse: markant hurtigere end liquidjs' asynkrone (ingen promise pr. trin)
  function renderSection(id: string, data: SectionData): string {
    if (!data || data.disabled || !sectionFileExists(data.type)) return '';
    const schema = sectionSchema(data.type);
    const order = data.block_order ?? Object.keys(data.blocks ?? {});
    const blocks = order
      .map((bid) => {
        const b = data.blocks?.[bid];
        if (!b || b.disabled) return null;
        const bdef = (schema.blocks ?? []).find((x) => x.type === b.type);
        return { id: bid, type: b.type, settings: resolveSettings(site, bdef?.settings, b.settings, { pages, linklists: lists, language }), shopify_attributes: '' };
      })
      .filter(Boolean);
    const section = { id, type: data.type, settings: resolveSettings(site, schema.settings, data.settings, { pages, linklists: lists, language }), blocks };
    const html = engine().renderSync(parsedFile(`sections/${data.type}.liquid`), { section }, { globals }) as string;
    const tag = schema.tag || 'section';
    return `<${tag} id="shopify-section-${id}" class="shopify-section ${schema.class ?? ''}">${html}</${tag}>`;
  }

  let main = '';
  if (tpl) for (const id of tpl.order) if (tpl.sections[id]) main += renderSection(id, tpl.sections[id]);
  return localizeLinks(engine().renderSync(parsedFile('layout/theme.liquid'), { content_for_layout: main }, { globals }) as string, language);
}
