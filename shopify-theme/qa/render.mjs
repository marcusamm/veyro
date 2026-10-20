// Lokal gengivelse af Veyro-temaet med liquidjs (efterligner Shopify, er ikke Shopify).
import { Liquid, Tag, Hash } from 'liquidjs';
import fs from 'fs';
import path from 'path';

const THEME = process.argv[2];
const OUT = process.argv[3];
const strip = (t) => t.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
const readJson = (f) => JSON.parse(strip(fs.readFileSync(path.join(THEME, f), 'utf8')));
const locale = readJson('locales/da.default.json');
const schemaOf = (src) => { const m = src.match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/); return m ? JSON.parse(m[1]) : {}; };

// Temaindstillinger: standardværdier + settings_data
const settings = {};
for (const g of readJson('config/settings_schema.json')) for (const s of g.settings || []) if (s.id) settings[s.id] = s.default ?? (s.type === 'checkbox' ? false : (s.type === 'image_picker' || s.type === 'page' ? null : ''));
Object.assign(settings, readJson('config/settings_data.json').current);
class Color { constructor(h) { this.hex = h; const n = parseInt(h.slice(1), 16); this.red = n >> 16; this.green = (n >> 8) & 255; this.blue = n & 255; } toString() { return this.hex; } valueOf() { return this.hex; } }
for (const g of readJson('config/settings_schema.json')) for (const d of g.settings || []) if (d.type === 'color' && settings[d.id]) settings[d.id] = new Color(settings[d.id]);

const page = (handle, title) => ({ handle, title, url: `/pages/${handle}`, content: `<p>Indhold for ${title}.</p>` });
const pages = Object.fromEntries(['ydelser','website-optimering','custom-losninger','om-os','kontakt','cookiepolitik','privatlivspolitik'].map(h => [h, page(h, h)]));
for (const k of ['privacy_page', 'cookie_page']) if (typeof settings[k] === 'string' && settings[k]) settings[k] = pages[settings[k]];
const WITH_PLANS = process.env.WITH_PLANS === '1';
const mkProduct = (handle, title, price) => {
  const variant = { id: 1000 + price, price: price * 100, available: true, title: 'Default Title' };
  const plan = { id: 5000 + price, name: 'Månedligt abonnement' };
  return { handle, title, type: 'Abonnement', url: `/products/${handle}`, price: price * 100, description: '<ul><li>Indhold</li></ul>', has_only_default_variant: true, variants: [variant], selected_or_first_available_variant: variant, requires_selling_plan: WITH_PLANS, selling_plan_groups: WITH_PLANS ? [{ name: 'Abonnement', selling_plans: [plan] }] : [] };
};
const products = { starter: mkProduct('starter', 'Starter abonnement', 299), business: mkProduct('business', 'Business abonnement', 599), premium: mkProduct('premium', 'Premium abonnement', 1099) };
const cart = WITH_PLANS ? { item_count: 1, total_price: 59900, currency: { iso_code: 'DKK' }, taxes_included: true, items: [{ key: 'k1', url: '/products/business', quantity: 1, final_line_price: 59900, product: products.business, variant: products.business.variants[0], url_to_remove: '/cart/change?line=1&quantity=0', selling_plan_allocation: { selling_plan: { name: 'Månedligt abonnement' } } }] } : { item_count: 0, items: [], total_price: 0, currency: { iso_code: 'DKK' }, taxes_included: true };
const menus = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'menus.json'), 'utf8'));
const linklists = Object.fromEntries(Object.entries(menus).map(([h, links]) => [h, { handle: h, links: links.map(l => ({ ...l })) }]));

const G = {};
const engine = new Liquid({ globals: G, root: [path.join(THEME, 'snippets')], extname: '.liquid', strictFilters: false, jsTruthy: false });
const t = (key, args = {}) => { let v = key.split('.').reduce((o, k) => o?.[k], locale); if (v == null) return `MISSING:${key}`; return String(v).replace(/{{\s*(\w+)\s*}}/g, (_, k) => args[k] ?? ''); };
engine.registerFilter('t', function (key, ...args) { const o = {}; for (const a of args) if (Array.isArray(a)) o[a[0]] = a[1]; return t(key, o); });
engine.registerFilter('cart_clear', () => '');
engine.registerFilter('asset_url', (f) => `/assets/${f}`);
engine.registerFilter('stylesheet_tag', (u) => `<link rel="stylesheet" href="${u}">`);
engine.registerFilter('preload_tag', (u) => `<link rel="preload" href="${u}" as="font" type="font/woff2" crossorigin>`);
engine.registerFilter('image_url', (i) => (i && i.src) || '');
engine.registerFilter('image_tag', (u) => `<img src="${u}" alt="">`);
engine.registerFilter('handle', (s) => String(s ?? '').toLowerCase().replace(/æ/g,'ae').replace(/ø/g,'oe').replace(/å/g,'aa').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''));
engine.registerFilter('money', (v) => `${(v/100).toFixed(2).replace('.',',')} kr`);
engine.registerFilter('money_without_trailing_zeros', (v) => `${(v/100).toLocaleString('da-DK')} kr`);
engine.registerFilter('money_with_currency', (v) => `${(v/100).toFixed(2).replace('.',',')} DKK`);
engine.registerFilter('font_face', () => '');
engine.registerFilter('payment_button', () => '');
engine.registerFilter('json', (v) => JSON.stringify(v ?? null));
engine.registerFilter('newline_to_br', (s) => String(s ?? '').replace(/\r?\n/g, '<br />\n'));

engine.registerTag('schema', { parse(tok, rem) { this.tpls = []; const s = this.liquid.parser.parseStream(rem); s.on('tag:endschema', () => s.stop()).on('template', () => {}).on('end', () => { throw new Error('schema'); }); s.start(); }, render() { return ''; } });
engine.registerTag('stylesheet', { parse(tok, rem) { this.tpls = []; const s = this.liquid.parser.parseStream(rem); s.on('tag:endstylesheet', () => s.stop()).on('template', (tp) => this.tpls.push(tp)).on('end', () => { throw new Error('stylesheet'); }); s.start(); }, *render(ctx, emitter) { emitter.write('<style>'); yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter); emitter.write('</style>'); } });
engine.registerTag('form', { parse(tok, rem) { this.args = tok.args; this.tpls = []; const s = this.liquid.parser.parseStream(rem); s.on('tag:endform', () => s.stop()).on('template', (tp) => this.tpls.push(tp)).on('end', () => { throw new Error('form'); }); s.start(); this.hash = new Hash(this.args.replace(/^'[^']*'\s*,?\s*(\w+\s*,)?/, '')); }, *render(ctx, emitter) { const h = yield this.hash.render(ctx); ctx.push({ form: { errors: null, 'posted_successfully?': false } }); const kind = this.args.match(/^'([^']*)'/)[1]; emitter.write(`<form method="post" action="${kind === 'product' ? '/cart/add' : '/contact#' + (h.id||'')}" id="${h.id||''}" class="${h.class||''}" ${h.novalidate?'novalidate':''}><input type="hidden" name="form_type" value="${kind}">`); yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter); emitter.write('</form>'); ctx.pop(); } });
engine.registerTag('paginate', { parse(tok, rem) { this.tpls = []; const s = this.liquid.parser.parseStream(rem); s.on('tag:endpaginate', () => s.stop()).on('template', (tp) => this.tpls.push(tp)).on('end', () => { throw new Error('paginate'); }); s.start(); }, *render(ctx, emitter) { ctx.push({ paginate: { pages: 1, parts: [] } }); yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter); ctx.pop(); } });

engine.registerTag('sections', { parse(tok) { this.name = tok.args.replace(/['"]/g, '').trim(); }, *render(ctx, emitter) { const html = yield renderGroup(this.name, ctx.getAll()); emitter.write(html); } });
const sectionSrc = (type) => fs.readFileSync(path.join(THEME, 'sections', type + '.liquid'), 'utf8');
function resolveSettings(defs, vals) {
  const out = {};
  for (const d of defs || []) if (d.id) out[d.id] = d.default ?? (d.type === 'checkbox' ? false : '');
  Object.assign(out, vals || {});
  for (const d of defs || []) if (d.type === 'link_list' && typeof out[d.id] === 'string') out[d.id] = linklists[out[d.id]] || { links: [] };
  for (const d of defs || []) if (d.type === 'product' && typeof out[d.id] === 'string') out[d.id] = products[out[d.id]] || null;
  for (const d of defs || []) if (d.type === 'page' && typeof out[d.id] === 'string' && out[d.id]) out[d.id] = pages[out[d.id]];
  return out;
}
async function renderSection(id, data, globals) {
  const src = sectionSrc(data.type);
  const schema = schemaOf(src);
  const blocks = (data.block_order || Object.keys(data.blocks || {})).map((bid) => {
    const b = data.blocks[bid]; if (b.disabled) return null;
    const bdef = (schema.blocks || []).find((x) => x.type === b.type) || {};
    return { id: bid, type: b.type, settings: resolveSettings(bdef.settings, b.settings), shopify_attributes: '' };
  }).filter(Boolean);
  const section = { id, settings: resolveSettings(schema.settings, data.settings), blocks };
  const html = await engine.parseAndRender(src, { ...globals, section });
  const tag = schema.tag || 'section';
  return `<${tag} id="shopify-section-${id}" class="shopify-section ${schema.class || ''}">${html}</${tag}>`;
}
async function renderGroup(name, globals) {
  const g = readJson(`sections/${name}.json`);
  let out = '';
  for (const id of g.order) out += await renderSection(id, g.sections[id], globals);
  return out;
}

const routes = [
  ['index', '/', 'index.json', 'Veyro'],
  ['ydelser', '/pages/ydelser', 'page.ydelser.json', 'Ydelser'],
  ['website-optimering', '/pages/website-optimering', 'page.website-optimering.json', 'Website-optimering'],
  ['custom-losninger', '/pages/custom-losninger', 'page.custom-losninger.json', 'Custom løsninger'],
  ['om-os', '/pages/om-os', 'page.om-os.json', 'Om os'],
  ['kontakt', '/pages/kontakt', 'page.kontakt.json', 'Kontakt'],
  ['cookiepolitik', '/pages/cookiepolitik', 'page.json', 'Cookiepolitik'],
  ['404', '/404', '404.json', 'Siden blev ikke fundet'],
  ['product-business', '/products/business', 'product.json', 'Business abonnement'],
  ['cart', '/cart', 'cart.json', 'Din kurv'],
];
const layout = fs.readFileSync(path.join(THEME, 'layout/theme.liquid'), 'utf8');
fs.mkdirSync(OUT, { recursive: true });
for (const [name, url, tpl, title] of routes) {
  for (const l of Object.values(linklists).flatMap((m) => m.links)) l.current = l.url === url;
  const pageType = name === 'index' ? 'index' : name === '404' ? '404' : name === 'cart' ? 'cart' : name.startsWith('product') ? 'product' : 'page';
  const pageObj = pages[url.split('/').pop()] || { title, content: '' };
  if (name === 'cookiepolitik') pageObj.content = '<h2>Cookies</h2><p>Lokal testtekst.</p>';
  const globals = { product: products.business, cart, settings, pages, linklists, shop: { name: 'Veyro', url: 'https://veyro.dk', email: 'salg@veyro.dk' }, routes: { root_url: '/', cart_url: '/cart', cart_clear_url: '/cart/clear', search_url: '/search' }, request: { locale: { iso_code: 'da' }, page_type: pageType }, page: pageObj, page_title: title, canonical_url: 'https://veyro.dk' + url, template: { name: pageType, suffix: tpl.startsWith('page.') && tpl !== 'page.json' ? tpl.slice(5, -5) : null }, current_page: 1, content_for_header: '' };
  for (const k of Object.keys(G)) delete G[k]; Object.assign(G, globals);
  const tj = readJson('templates/' + tpl);
  let main = '';
  for (const id of tj.order) if (!tj.sections[id].disabled) main += await renderSection(id, tj.sections[id], globals);
  const html = await engine.parseAndRender(layout, { ...globals, content_for_layout: main });
  // {% sections %} er ikke i liquidjs: indsæt grupperne bagefter
  const full = html;
  fs.writeFileSync(path.join(OUT, name + '.html'), full);
}
// Assets
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(THEME, 'assets'))) fs.copyFileSync(path.join(THEME, 'assets', f), path.join(OUT, 'assets', f));
console.log('ok');
export { renderGroup };
