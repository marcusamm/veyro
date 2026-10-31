// Gengiver hjemmesidens tema (Shopify-Liquid) i Workeren med liquidjs.
// Temaet ligger i site/theme og pakkes ind i theme.generated.ts (npm run build:site).
import { Hash, Liquid, type Context, type Emitter, type Template, type TagToken, type TopLevelToken } from 'liquidjs';
import { contentText, type SiteLanguage } from './localization';
import { displayPrice, DISPLAY_EXCHANGE_RATE } from './currency';
import { THEME_ASSETS, THEME_FILES, THEME_VERSION } from './theme.generated';

const stripComment = (t: string) => t.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
export const readThemeJson = <T = any>(file: string): T => JSON.parse(stripComment(THEME_FILES[file] ?? 'null'));

export interface SettingDef {
  type: string;
  id?: string;
  label?: string;
  info?: string;
  content?: string;
  default?: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}
export interface BlockDef {
  type: string;
  name: string;
  limit?: number;
  settings?: SettingDef[];
}
export interface SectionSchema {
  name?: string;
  tag?: string;
  class?: string;
  settings?: SettingDef[];
  blocks?: BlockDef[];
  max_blocks?: number;
  presets?: { name: string; blocks?: { type: string; settings?: Record<string, unknown> }[]; settings?: Record<string, unknown> }[];
}

const schemaCache = new Map<string, SectionSchema>();
export function sectionSchema(type: string): SectionSchema {
  let s = schemaCache.get(type);
  if (!s) {
    const src = THEME_FILES[`sections/${type}.liquid`] ?? '';
    const m = src.match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/);
    s = m ? (JSON.parse(m[1]!) as SectionSchema) : {};
    schemaCache.set(type, s);
  }
  return s;
}

export function sectionTypes(): string[] {
  return Object.keys(THEME_FILES)
    .filter((f) => f.startsWith('sections/') && f.endsWith('.liquid'))
    .map((f) => f.slice(9, -7));
}

export function themeSettingsSchema(): { name: string; settings?: SettingDef[] }[] {
  return readThemeJson('config/settings_schema.json');
}

export const LOCALE: Record<string, any> = readThemeJson('locales/da.default.json');
const locales = { da: LOCALE, en: readThemeJson('locales/en.json'), sv: readThemeJson('locales/sv.json') };

export function translate(key: string, args: Record<string, unknown> = {}, language: SiteLanguage = 'da'): string {
  const locale = locales[language] ?? LOCALE;
  const v = key.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), locale);
  if (v == null) return key;
  return String(v).replace(/{{\s*(\w+)\s*}}/g, (_, k) => String(args[k] ?? ''));
}

// ---------- Værdier som Liquid-objekter ----------

export class Color {
  hex: string;
  red: number;
  green: number;
  blue: number;
  constructor(h: string) {
    this.hex = h;
    const n = parseInt(h.replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
    this.red = n >> 16;
    this.green = (n >> 8) & 255;
    this.blue = n & 255;
  }
  toString() {
    return this.hex;
  }
  valueOf() {
    return this.hex;
  }
}

/** Kroner med dansk tusindtalsseparator: 109900 → "1.099 kr" */
export function moneyText(oere: number, trailingZeros: boolean): string {
  const kr = (Number(oere) || 0) / 100;
  const whole = Math.floor(Math.abs(kr));
  const dec = Math.round((Math.abs(kr) - whole) * 100);
  const sign = kr < 0 ? '-' : '';
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (!trailingZeros && dec === 0) return `${sign}${grouped} kr`;
  return `${sign}${grouped},${String(dec).padStart(2, '0')} kr`;
}

export function handleize(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const escAttr = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ---------- Motoren ----------

export interface FormState {
  'posted_successfully?': boolean;
  errors: (string[] & { messages: Record<string, string>; translated_fields: Record<string, string> }) | null;
  name?: string;
  email?: string;
  body?: string;
  service?: string;
  webshop_tier?: string;
}

/** Data, som de særlige tags ({% sections %}, {% form %}) skal bruge under gengivelsen */
export interface RenderHooks {
  renderGroup(name: string, scope: Record<string, unknown>): string;
  forms: Record<string, FormState>;
  path: string;
  host: string;
  language?: SiteLanguage;
}

const snippets: Record<string, string> = {};
for (const [f, src] of Object.entries(THEME_FILES)) if (f.startsWith('snippets/')) snippets[f.slice(9)] = src;

function blockTag(name: string, render: (this: any, ctx: Context, emitter: Emitter, inner: Template[]) => Generator<unknown, void, unknown>) {
  return {
    parse(this: any, token: TagToken, remain: TopLevelToken[]) {
      this.args = token.args;
      this.tpls = [] as Template[];
      const stream = this.liquid.parser.parseStream(remain);
      stream
        .on(`tag:end${name}`, () => stream.stop())
        .on('template', (tpl: Template) => this.tpls.push(tpl))
        .on('end', () => {
          throw new Error(`{% ${name} %} mangler {% end${name} %}`);
        });
      stream.start();
    },
    *render(this: any, ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      yield* render.call(this, ctx, emitter, this.tpls);
    },
  };
}

function createEngine(): Liquid {
  const engine = new Liquid({ templates: snippets, extname: '.liquid', cache: true, strictFilters: false, jsTruthy: false, ownPropertyOnly: true });

  engine.registerFilter('t', function (this: any, key: string, ...args: unknown[]) {
    const o: Record<string, unknown> = {};
    for (const a of args) if (Array.isArray(a)) o[a[0]] = a[1];
    return translate(key, o, (this.context.globals.__hooks as RenderHooks).language);
  });
  engine.registerFilter('content_t', function (this: any, value: string) { return contentText(value, (this.context.globals.__hooks as RenderHooks).language ?? 'da'); });
  // Som hos Shopify: protokol-relative adresser (temaet sætter selv "https:" foran i delingsbilleder)
  engine.registerFilter('asset_url', function (this: any, f: string) {
    return `//${(this.context.globals.__hooks as RenderHooks).host}/assets/${f}?v=${THEME_VERSION}`;
  });
  engine.registerFilter('stylesheet_tag', (u: string) => `<link rel="stylesheet" href="${escAttr(u)}">`);
  engine.registerFilter('preload_tag', (u: string) => `<link rel="preload" href="${escAttr(u)}" as="font" type="font/woff2" crossorigin>`);
  engine.registerFilter('image_url', function (this: any, img: any) {
    const src = img && typeof img === 'object' ? img.src : img ? String(img) : '';
    return src.startsWith('/') && !src.startsWith('//') ? `//${(this.context.globals.__hooks as RenderHooks).host}${src}` : src;
  });
  engine.registerFilter('image_tag', function (url: string, ...args: unknown[]) {
    const o: Record<string, unknown> = {};
    for (const a of args) if (Array.isArray(a)) o[a[0]] = a[1];
    const attrs = [`src="${escAttr(url)}"`, `alt="${escAttr(o.alt ?? '')}"`];
    for (const k of ['class', 'loading', 'fetchpriority', 'width', 'height', 'sizes']) if (o[k] != null && o[k] !== '') attrs.push(`${k}="${escAttr(o[k])}"`);
    return `<img ${attrs.join(' ')}>`;
  });
  engine.registerFilter('handle', handleize);
  engine.registerFilter('handleize', handleize);
  const money = function (this: any, v: number, zeros: boolean) {
    const language = (this.context.globals.__hooks as RenderHooks)?.language ?? 'da';
    return language === 'da' ? moneyText(v, zeros) : displayPrice(v / 100, language);
  };
  engine.registerFilter('money', function (this: any, v: number) { return money.call(this, v, true); });
  engine.registerFilter('money_without_trailing_zeros', function (this: any, v: number) { return money.call(this, v, false); });
  engine.registerFilter('money_with_currency', function (this: any, v: number) { return money.call(this, v, true).replace(/ kr$/, ' DKK'); });
  // Numeric section settings are whole DKK; product/cart money filters above receive øre.
  engine.registerFilter('display_money', function (this: any, v: number) { return displayPrice(v, (this.context.globals.__hooks as RenderHooks)?.language ?? 'da'); });
  engine.registerFilter('exchange_rate_source', () => DISPLAY_EXCHANGE_RATE.source);
  engine.registerFilter('font_face', () => '');
  engine.registerFilter('payment_button', () => '');
  engine.registerFilter('cart_clear', () => '');
  engine.registerFilter('json', (v: unknown) => JSON.stringify(v ?? null).replace(/</g, '\\u003c'));
  engine.registerFilter('newline_to_br', (s: unknown) => String(s ?? '').replace(/\r?\n/g, '<br />\n'));

  engine.registerTag('schema', blockTag('schema', function* () {}));
  engine.registerTag('javascript', blockTag('javascript', function* () {}));
  engine.registerTag(
    'stylesheet',
    blockTag('stylesheet', function* (this: any, ctx, emitter, tpls) {
      emitter.write('<style>');
      yield this.liquid.renderer.renderTemplates(tpls, ctx, emitter);
      emitter.write('</style>');
    }),
  );
  engine.registerTag(
    'paginate',
    blockTag('paginate', function* (this: any, ctx, emitter, tpls) {
      ctx.push({ paginate: { pages: 1, parts: [] } });
      yield this.liquid.renderer.renderTemplates(tpls, ctx, emitter);
      ctx.pop();
    }),
  );
  engine.registerTag(
    'form',
    blockTag('form', function* (this: any, ctx, emitter, tpls) {
      const kind = (String(this.args).match(/^\s*'([^']*)'/) || [])[1] ?? 'contact';
      const rest = String(this.args).replace(/^\s*'[^']*'\s*,?\s*(\w+\s*,)?/, '');
      const h: Record<string, unknown> = (yield new Hash(rest).render(ctx)) as Record<string, unknown>;
      const hooks = ctx.globals.__hooks as RenderHooks;
      const id = String(h.id ?? '');
      const state: FormState = hooks.forms[id] ?? (kind === 'contact' ? hooks.forms.__contact : undefined) ?? { 'posted_successfully?': false, errors: null };
      ctx.push({ form: state });
      const action = kind === 'product' ? '/cart/add' : `/contact#${escAttr(id)}`;
      emitter.write(
        `<form method="post" action="${action}" accept-charset="UTF-8"${id ? ` id="${escAttr(id)}"` : ''}${h.class ? ` class="${escAttr(h.class)}"` : ''}${h.novalidate ? ' novalidate' : ''}>` +
          `<input type="hidden" name="form_type" value="${escAttr(kind)}"><input type="hidden" name="site_language" value="${hooks.language ?? 'da'}">`,
      );
      if (kind === 'contact') {
        emitter.write(
          `<input type="hidden" name="form_id" value="${escAttr(id)}"><input type="hidden" name="return_to" value="${escAttr(hooks.path)}">` +
            // Honningkrukke mod spam-robotter: skjult felt, som mennesker ikke udfylder
            `<div class="visually-hidden" aria-hidden="true"><label>Lad dette felt være tomt<input type="text" name="website_url" tabindex="-1" autocomplete="off"></label></div>`,
        );
      }
      yield this.liquid.renderer.renderTemplates(tpls, ctx, emitter);
      emitter.write('</form>');
      ctx.pop();
    }),
  );
  engine.registerTag('sections', {
    parse(this: any, token: TagToken) {
      this.name = token.args.replace(/['"]/g, '').trim();
    },
    *render(this: any, ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      const hooks = ctx.globals.__hooks as RenderHooks;
      const html = (yield hooks.renderGroup(this.name, ctx.getAll() as Record<string, unknown>)) as string;
      emitter.write(html);
    },
  });
  return engine;
}

let engineSingleton: Liquid | null = null;
export function engine(): Liquid {
  return (engineSingleton ??= createEngine());
}

const parsed = new Map<string, Template[]>();
/** Parser en temafil én gang pr. isolate */
export function parsedFile(file: string): Template[] {
  let t = parsed.get(file);
  if (!t) {
    const src = THEME_FILES[file];
    if (src == null) throw new Error('Mangler temafil: ' + file);
    t = engine().parse(src, file);
    parsed.set(file, t);
  }
  return t;
}

export function asset(name: string): { type: string; body: string | Uint8Array } | null {
  const a = THEME_ASSETS[name];
  if (!a) return null;
  if (!a.b64) return { type: a.type, body: a.data };
  const bin = atob(a.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type: a.type, body: bytes };
}

export { THEME_VERSION };

/** Parser alle temafiler med det samme (ved opstart af isolatet, ikke i den enkelte forespørgsel) */
export function warmUp(): void {
  try {
    for (const f of Object.keys(THEME_FILES)) if (f.endsWith('.liquid') && !f.startsWith('snippets/')) parsedFile(f);
    for (const f of Object.keys(snippets)) engine().parseFileSync(f.replace(/\.liquid$/, ''));
  } catch (err) {
    console.error('Tema kunne ikke indlæses:', (err as Error).message);
  }
}
