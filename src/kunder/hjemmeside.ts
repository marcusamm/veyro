// Kundehjemmesider: indstillinger (JSON), startpunkter og gengivelse.
// En hjemmeside er en kladde (projects.draft), der låses som en version, godkendes og publiceres.
// Startpunkterne er kun udgangspunkter: layout, farver, skrift, sider og sektioner kan ændres frit.
import { escapeHtml as esc } from '../lib/email';
import { sha256Hex } from '../lib/crypto';

export type LayoutKey = 'klassisk' | 'kompakt' | 'markant';
export type FontKey = 'moderne' | 'klassisk' | 'system';
export type SectionType = 'hero' | 'tekst' | 'ydelser' | 'billede' | 'aabningstider' | 'kontakt' | 'cta' | 'bestilling';

export interface SectionItem {
  title: string;
  text: string;
}
export interface Section {
  type: SectionType;
  heading: string;
  text: string;
  image: number | null;
  image_alt: string;
  button_label: string;
  button_href: string;
  items: SectionItem[];
}
export interface Page {
  /** '' = forsiden, ellers fx 'kontakt' → /kontakt */
  handle: string;
  title: string;
  in_nav: boolean;
  seo_title: string;
  seo_description: string;
  sections: Section[];
}
export interface WebsiteConfig {
  layout: LayoutKey;
  brand: { primary: string; background: string; text: string; font: FontKey; logo: number | null; logo_alt: string };
  /** Oplysninger, der er godkendt til at blive vist offentligt (adskilt fra de interne firmaoplysninger) */
  info: { name: string; tagline: string; phone: string; email: string; address: string; cvr: string; opening_hours: string };
  pages: Page[];
}

export const LAYOUTS: Record<LayoutKey, { label: string; description: string }> = {
  klassisk: { label: 'Klassisk', description: 'Logo og menu i toppen, farvet forsidefelt og indhold i fuld bredde.' },
  kompakt: { label: 'Kompakt', description: 'Én smal spalte med rolig typografi. Godt til få sider og meget tekst.' },
  markant: { label: 'Markant', description: 'Mørkt forsidefelt, store overskrifter og kort i gitter. Fast knap i toppen.' },
};
export const FONTS: Record<FontKey, { label: string; stack: string }> = {
  moderne: { label: 'Moderne (Inter Tight)', stack: "'Inter Tight', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  klassisk: { label: 'Klassisk (serif)', stack: "Georgia, 'Times New Roman', serif" },
  system: { label: 'Systemets skrift', stack: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
};
export const SECTION_TYPES: Record<SectionType, { label: string; fields: (keyof Section)[]; hint?: string }> = {
  hero: { label: 'Forsidefelt', fields: ['heading', 'text', 'image', 'image_alt', 'button_label', 'button_href'] },
  tekst: { label: 'Tekst', fields: ['heading', 'text'], hint: 'Tom linje giver nyt afsnit.' },
  ydelser: { label: 'Ydelser / punkter', fields: ['heading', 'text', 'items'] },
  billede: { label: 'Billede', fields: ['image', 'image_alt', 'text'] },
  aabningstider: { label: 'Åbningstider', fields: ['heading'], hint: 'Viser åbningstiderne fra "Oplysninger på hjemmesiden".' },
  kontakt: { label: 'Kontaktformular', fields: ['heading', 'text'], hint: 'Kræver tjenesten "Kontakt- og tilbudsformular".' },
  cta: { label: 'Opfordring med knap', fields: ['heading', 'text', 'button_label', 'button_href'] },
  bestilling: { label: 'Bestil online', fields: ['heading', 'text', 'button_label'], hint: 'Knappen går til kundens bestillingssystem. Kræver tjenesten "Kundebestilling med lager".' },
};

/** Tekst i [[dobbelte klammer]] er pladsholdere, der skal skrives om, før siden kan publiceres. */
export const PLACEHOLDER = /\[\[[^\]]*\]\]/;

const HEX = /^#[0-9a-fA-F]{6}$/;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const s = (v: unknown, max = 400): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const id = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function emptySection(type: SectionType): Section {
  return { type, heading: '', text: '', image: null, image_alt: '', button_label: '', button_href: '', items: [] };
}

function normSection(raw: any): Section | null {
  if (!raw || !(raw.type in SECTION_TYPES)) return null;
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 12).map((i: any) => ({ title: s(i?.title, 120), text: s(i?.text, 600) })).filter((i: SectionItem) => i.title || i.text) : [];
  return {
    type: raw.type,
    heading: s(raw.heading, 160),
    text: s(raw.text, 4000),
    image: id(raw.image),
    image_alt: s(raw.image_alt, 200),
    button_label: s(raw.button_label, 60),
    button_href: s(raw.button_href, 300),
    items,
  };
}

/** Gør en indlæst eller indsendt konfiguration gyldig (ukendte felter fjernes, alt har en fast rækkefølge). */
export function normalizeConfig(raw: any): WebsiteConfig {
  const b = raw?.brand ?? {};
  const i = raw?.info ?? {};
  const pages: Page[] = [];
  for (const p of Array.isArray(raw?.pages) ? raw.pages.slice(0, 20) : []) {
    const handle = p?.handle === '' ? '' : s(p?.handle, 60);
    if (handle !== '' && !HANDLE.test(handle)) continue;
    if (pages.some((x) => x.handle === handle)) continue;
    pages.push({
      handle,
      title: s(p?.title, 80) || (handle === '' ? 'Forside' : handle),
      in_nav: p?.in_nav !== false,
      seo_title: s(p?.seo_title, 120),
      seo_description: s(p?.seo_description, 300),
      sections: (Array.isArray(p?.sections) ? p.sections.slice(0, 30) : []).map(normSection).filter(Boolean) as Section[],
    });
  }
  if (!pages.some((p) => p.handle === '')) pages.unshift({ handle: '', title: 'Forside', in_nav: true, seo_title: '', seo_description: '', sections: [] });
  pages.sort((a, z) => (a.handle === '' ? -1 : z.handle === '' ? 1 : 0));
  return {
    layout: raw?.layout in LAYOUTS ? raw.layout : 'klassisk',
    brand: {
      primary: HEX.test(b.primary) ? String(b.primary).toUpperCase() : '#1F4E79',
      background: HEX.test(b.background) ? String(b.background).toUpperCase() : '#FFFFFF',
      text: HEX.test(b.text) ? String(b.text).toUpperCase() : '#1A1A1A',
      font: b.font in FONTS ? b.font : 'moderne',
      logo: id(b.logo),
      logo_alt: s(b.logo_alt, 120),
    },
    info: {
      name: s(i.name, 120),
      tagline: s(i.tagline, 200),
      phone: s(i.phone, 40),
      email: s(i.email, 200),
      address: s(i.address, 300),
      cvr: s(i.cvr, 8),
      opening_hours: s(i.opening_hours, 600),
    },
    pages,
  };
}

/** Stabil hash af indholdet. Godkendelse gælder præcis den hash. */
export async function configHash(cfg: WebsiteConfig): Promise<string> {
  return (await sha256Hex(JSON.stringify(normalizeConfig(cfg)))).slice(0, 32);
}

// ---------- Startpunkter ----------

export interface StartInfo {
  name: string;
  description?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export const STARTPUNKTER: Record<string, { label: string; description: string; layout: LayoutKey; build: (c: StartInfo) => Page[] }> = {
  service: {
    label: 'Håndværk og service',
    description: 'Forside med ydelser, om os, åbningstider og kontaktformular. Klassisk layout.',
    layout: 'klassisk',
    build: (c) => [
      page('', 'Forside', [
        { type: 'hero', heading: c.name, text: c.description || '[[Kort beskrivelse af virksomheden]]', button_label: 'Kontakt os', button_href: '/kontakt' },
        { type: 'ydelser', heading: 'Det hjælper vi med', items: [{ title: '[[Ydelse]]', text: '[[Kort beskrivelse]]' }, { title: '[[Ydelse]]', text: '[[Kort beskrivelse]]' }] },
        { type: 'tekst', heading: 'Om os', text: '[[Fortæl kort om virksomheden med kundens egne ord]]' },
        { type: 'aabningstider', heading: 'Åbningstider' },
      ]),
      page('kontakt', 'Kontakt', [{ type: 'kontakt', heading: 'Kontakt os', text: 'Skriv til os, så vender vi tilbage hurtigst muligt.' }]),
    ],
  },
  bestilling: {
    label: 'Butik med bestilling',
    description: 'Forside med knap til online bestilling, åbningstider og kontakt. Markant layout.',
    layout: 'markant',
    build: (c) => [
      page('', 'Forside', [
        { type: 'hero', heading: c.name, text: c.description || '[[Kort beskrivelse af butikken]]', button_label: 'Bestil online', button_href: '#bestil' },
        { type: 'bestilling', heading: 'Bestil online', text: 'Se vores varer og bestil til afhentning eller levering.', button_label: 'Gå til bestilling' },
        { type: 'aabningstider', heading: 'Åbningstider' },
        { type: 'kontakt', heading: 'Spørgsmål?', text: 'Skriv til os, så svarer vi hurtigst muligt.' },
      ]),
    ],
  },
  raadgivning: {
    label: 'Rådgivning og kontor',
    description: 'Få sider med fokus på tekst og en opfordring til at tage kontakt. Kompakt layout.',
    layout: 'kompakt',
    build: (c) => [
      page('', 'Forside', [
        { type: 'hero', heading: c.name, text: c.description || '[[Kort beskrivelse af virksomheden]]', button_label: 'Book en samtale', button_href: '/kontakt' },
        { type: 'tekst', heading: '[[Overskrift]]', text: '[[Hvad tilbyder I, og hvem hjælper I?]]' },
        { type: 'cta', heading: 'Lad os tage en snak', text: '[[Kort opfordring]]', button_label: 'Kontakt', button_href: '/kontakt' },
      ]),
      page('kontakt', 'Kontakt', [{ type: 'kontakt', heading: 'Kontakt', text: 'Skriv til os, så vender vi tilbage.' }]),
    ],
  },
};

function page(handle: string, title: string, sections: Partial<Section>[]): Page {
  return { handle, title, in_nav: true, seo_title: '', seo_description: '', sections: sections.map((x) => ({ ...emptySection(x.type!), ...x }) as Section) };
}

export function startConfig(template: string, c: StartInfo, primary?: string): WebsiteConfig {
  const t = STARTPUNKTER[template] ?? STARTPUNKTER.service!;
  return normalizeConfig({
    layout: t.layout,
    brand: { primary: primary ?? '#1F4E79', background: '#FFFFFF', text: '#1A1A1A', font: 'moderne' },
    // Kun de oplysninger, kunden selv har givet; de kan rettes eller fjernes, før de vises
    info: { name: c.name, phone: c.phone ?? '', email: c.email ?? '', address: c.address ?? '' },
    pages: t.build(c),
  });
}

/**
 * "Brug som startpunkt": kun design og opbygning kopieres (layout, farver, skrift, sider og sektionstyper).
 * Tekster, billeder, logo og kontaktoplysninger erstattes af pladsholdere, så intet fra den anden kunde følger med.
 */
export function structureOnly(cfg: WebsiteConfig, name: string): WebsiteConfig {
  return normalizeConfig({
    layout: cfg.layout,
    brand: { ...cfg.brand, logo: null, logo_alt: '' },
    info: { name },
    pages: cfg.pages.map((p) => ({
      handle: p.handle,
      title: p.title,
      in_nav: p.in_nav,
      sections: p.sections.map((x) => ({
        type: x.type,
        heading: x.heading ? '[[Overskrift]]' : '',
        text: x.text ? '[[Tekst]]' : '',
        button_label: x.button_label ? '[[Knaptekst]]' : '',
        button_href: x.button_href.startsWith('/') || x.button_href.startsWith('#') ? x.button_href : '',
        items: x.items.map(() => ({ title: '[[Punkt]]', text: '[[Tekst]]' })),
      })),
    })),
  });
}

// ---------- Gengivelse ----------

export interface PublicServices {
  /** Kontaktformularen er slået til og har en modtager */
  contact: boolean;
  /** Adressen på kundens bestillingssystem, hvis det er udrullet */
  orderUrl: string | null;
}

export interface RenderCtx {
  /** Sti-præfiks foran alle interne links, fx '' på kundens domæne, '/s/nordlys' eller '/vis/<token>' */
  base: string;
  mode: 'live' | 'preview';
  services: PublicServices;
  /** Kanonisk adresse (live), bruges til canonical og delingslinks */
  canonical: string | null;
  sent?: boolean;
  formError?: string | null;
  /** Billeder, der findes for projektet (id'er) */
  files: Set<number>;
  nonce?: string;
  /** Søgemaskiner må ikke indeksere (forhåndsvisning og /s/-adressen) */
  noindex: boolean;
}

export class RenderError extends Error {}

export function findPage(cfg: WebsiteConfig, path: string): Page | null {
  const handle = path.replace(/^\/+|\/+$/g, '');
  return cfg.pages.find((p) => p.handle === handle) ?? null;
}

function href(ctx: RenderCtx, h: string): string {
  if (!h) return '#';
  if (h.startsWith('#')) return h;
  if (h.startsWith('/') && !h.startsWith('//')) return `${ctx.base}${h}`;
  if (/^(https:\/\/|mailto:|tel:)/i.test(h)) return h;
  return '#';
}

function paragraphs(t: string): string {
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function img(ctx: RenderCtx, fileId: number | null, alt: string, cls: string): string {
  if (!fileId) return '';
  if (!ctx.files.has(fileId)) throw new RenderError(`Billede #${fileId} findes ikke længere`);
  return `<img class="${cls}" src="${ctx.base}/_filer/${fileId}" alt="${esc(alt)}" loading="lazy">`;
}

function button(ctx: RenderCtx, label: string, h: string, cls = 'k-btn'): string {
  return label ? `<a class="${cls}" href="${esc(href(ctx, h))}">${esc(label)}</a>` : '';
}

function contactForm(cfg: WebsiteConfig, ctx: RenderCtx, page: Page): string {
  if (!ctx.services.contact) {
    return ctx.mode === 'preview' ? `<p class="k-note">Kontaktformularen vises, når tjenesten "Kontakt- og tilbudsformular" er slået til og har en modtager.</p>` : '';
  }
  if (ctx.sent) return `<div class="k-ok" role="status">Tak for din henvendelse. Vi vender tilbage hurtigst muligt.</div>`;
  return `<form class="k-form" method="post" action="${ctx.base}/_kontakt">
${ctx.mode === 'preview' ? '<p class="k-note">Forhåndsvisning: henvendelser gemmes som test og sendes ikke videre.</p>' : ''}
${ctx.formError ? `<div class="k-err" role="alert">${esc(ctx.formError)}</div>` : ''}
<input type="hidden" name="side" value="${esc(page.handle)}">
<div class="k-hp" aria-hidden="true"><label>Lad feltet være tomt<input name="website_url" tabindex="-1" autocomplete="off"></label></div>
<label>Navn<input name="name" autocomplete="name" maxlength="120" required></label>
<label>E-mail<input name="email" type="email" autocomplete="email" maxlength="200" required></label>
<label>Telefon (valgfri)<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
<label>Besked<textarea name="message" rows="5" maxlength="5000" required></textarea></label>
<label class="k-check"><input type="checkbox" name="samtykke" value="1" required> Jeg giver samtykke til, at ${esc(cfg.info.name || 'virksomheden')} må bruge oplysningerne til at besvare min henvendelse.</label>
<button class="k-btn" type="submit">Send</button>
</form>`;
}

function section(cfg: WebsiteConfig, ctx: RenderCtx, page: Page, x: Section): string {
  const h2 = x.heading ? `<h2>${esc(x.heading)}</h2>` : '';
  switch (x.type) {
    case 'hero':
      return `<section class="k-hero"><div class="k-wrap k-hero__in"><div>${x.heading ? `<h1>${esc(x.heading)}</h1>` : ''}${x.text ? paragraphs(x.text) : ''}${button(ctx, x.button_label, x.button_href)}</div>${img(ctx, x.image, x.image_alt, 'k-hero__img')}</div></section>`;
    case 'tekst':
      return `<section class="k-sec"><div class="k-wrap k-prose">${h2}${paragraphs(x.text)}</div></section>`;
    case 'ydelser':
      return `<section class="k-sec"><div class="k-wrap">${h2}${x.text ? paragraphs(x.text) : ''}<div class="k-cards">${x.items.map((i) => `<div class="k-card"><h3>${esc(i.title)}</h3>${paragraphs(i.text)}</div>`).join('')}</div></div></section>`;
    case 'billede':
      return `<section class="k-sec"><div class="k-wrap"><figure>${img(ctx, x.image, x.image_alt, 'k-img')}${x.text ? `<figcaption>${esc(x.text)}</figcaption>` : ''}</figure></div></section>`;
    case 'aabningstider':
      if (!cfg.info.opening_hours) return ctx.mode === 'preview' ? `<section class="k-sec"><div class="k-wrap"><p class="k-note">Åbningstider er ikke udfyldt.</p></div></section>` : '';
      return `<section class="k-sec"><div class="k-wrap">${h2}<ul class="k-hours">${cfg.info.opening_hours.split('\n').filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div></section>`;
    case 'kontakt':
      return `<section class="k-sec" id="kontakt"><div class="k-wrap k-contact"><div>${h2}${x.text ? paragraphs(x.text) : ''}${contactInfo(cfg)}</div>${contactForm(cfg, ctx, page)}</div></section>`;
    case 'cta':
      return `<section class="k-sec k-cta"><div class="k-wrap">${h2}${x.text ? paragraphs(x.text) : ''}${button(ctx, x.button_label, x.button_href)}</div></section>`;
    case 'bestilling': {
      const btn = ctx.services.orderUrl
        ? ctx.mode === 'preview'
          ? `<span class="k-btn k-btn--off" aria-disabled="true">${esc(x.button_label || 'Bestil')}</span><p class="k-note">Forhåndsvisning: knappen går til ${esc(ctx.services.orderUrl)} på den publicerede side. Der oprettes ingen ordrer herfra.</p>`
          : `<a class="k-btn" href="${esc(ctx.services.orderUrl)}">${esc(x.button_label || 'Bestil')}</a>`
        : ctx.mode === 'preview'
          ? `<p class="k-note">Knappen vises, når kundens bestillingssystem er udrullet.</p>`
          : '';
      if (!btn) return '';
      return `<section class="k-sec k-order" id="bestil"><div class="k-wrap">${h2}${x.text ? paragraphs(x.text) : ''}${btn}</div></section>`;
    }
  }
}

function contactInfo(cfg: WebsiteConfig): string {
  const i = cfg.info;
  const lines = [
    i.address ? `<li>${esc(i.address).replace(/\n/g, '<br>')}</li>` : '',
    i.phone ? `<li><a href="tel:${esc(i.phone.replace(/\s+/g, ''))}">${esc(i.phone)}</a></li>` : '',
    i.email ? `<li><a href="mailto:${esc(i.email)}">${esc(i.email)}</a></li>` : '',
  ].join('');
  return lines ? `<ul class="k-info">${lines}</ul>` : '';
}

function css(cfg: WebsiteConfig): string {
  const { primary, background, text, font } = cfg.brand;
  const dark = cfg.layout === 'markant';
  return `@font-face{font-family:'Inter Tight';src:url('/_veyro/inter-tight.woff2') format('woff2');font-weight:100 900;font-display:swap}
:root{--p:${primary};--bg:${background};--fg:${text};--max:${cfg.layout === 'kompakt' ? '720px' : '1080px'}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font-family:${FONTS[font].stack};font-size:17px;line-height:1.6}
img{max-width:100%;height:auto;display:block}a{color:var(--p)}
.k-wrap{max-width:var(--max);margin:0 auto;padding:0 20px}
.k-skip{position:absolute;left:-9999px}.k-skip:focus{left:12px;top:12px;background:#fff;padding:8px;z-index:10}
.k-head{border-bottom:1px solid color-mix(in srgb,var(--fg) 12%,transparent);background:var(--bg)${dark ? ';position:sticky;top:0;z-index:5' : ''}}
.k-head__in{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px;flex-wrap:wrap;${cfg.layout === 'kompakt' ? 'flex-direction:column;justify-content:center;padding:16px 0' : ''}}
.k-brand{font-weight:700;font-size:20px;text-decoration:none;color:var(--fg);display:flex;align-items:center;gap:10px}.k-brand img{max-height:44px;width:auto}
.k-nav ul{list-style:none;margin:0;padding:0;display:flex;gap:18px;flex-wrap:wrap}.k-nav a{text-decoration:none;color:var(--fg)}.k-nav a[aria-current]{color:var(--p);font-weight:600}
.k-hero{background:${dark ? 'var(--fg)' : 'color-mix(in srgb,var(--p) 10%,var(--bg))'};color:${dark ? 'var(--bg)' : 'inherit'};padding:${dark ? '88px 0' : '56px 0'}}
.k-hero__in{display:grid;gap:32px;align-items:center}@media(min-width:800px){.k-hero__in:has(img){grid-template-columns:1.2fr 1fr}}
.k-hero h1{font-size:${dark ? 'clamp(36px,6vw,64px)' : 'clamp(30px,5vw,46px)'};line-height:1.1;margin:0 0 16px;letter-spacing:-0.02em}
.k-hero__img{border-radius:14px}
.k-sec{padding:48px 0}.k-sec h2{font-size:clamp(24px,3.5vw,32px);line-height:1.2;margin:0 0 16px}
.k-cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:16px}
.k-card{border:1px solid color-mix(in srgb,var(--fg) 14%,transparent);border-radius:14px;padding:20px;${dark ? 'background:color-mix(in srgb,var(--p) 6%,var(--bg))' : ''}}.k-card h3{margin:0 0 8px;font-size:19px}.k-card p{margin:0}
.k-cta,.k-order{background:color-mix(in srgb,var(--p) 8%,var(--bg));text-align:center}
.k-btn{display:inline-block;background:var(--p);color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;border:0;font:inherit;font-weight:600;cursor:pointer;margin-top:8px}
.k-btn--off{opacity:.55;cursor:not-allowed}
.k-hours,.k-info{list-style:none;padding:0;margin:8px 0}
.k-contact{display:grid;gap:32px}@media(min-width:800px){.k-contact{grid-template-columns:1fr 1.2fr}}
.k-form{display:grid;gap:12px}.k-form label{display:grid;gap:4px;font-weight:600;font-size:15px}.k-form input,.k-form textarea{font:inherit;padding:10px 12px;border:1px solid color-mix(in srgb,var(--fg) 25%,transparent);border-radius:10px;background:#fff;color:#1a1a1a}
.k-form .k-check{display:flex;gap:8px;font-weight:400;align-items:flex-start}.k-check input{margin-top:5px}
.k-hp{position:absolute;left:-9999px}
.k-ok,.k-err,.k-note{padding:12px 14px;border-radius:10px}.k-ok{background:#e6f4ea}.k-err{background:#fde8e8}.k-note{background:#fff6d6;color:#4a3b00;font-size:15px}
.k-foot{border-top:1px solid color-mix(in srgb,var(--fg) 12%,transparent);padding:32px 0;font-size:15px}.k-foot__in{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between}
.k-preview{background:#1a1a1a;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:8px 16px;text-align:center}`;
}

export function renderPage(cfg: WebsiteConfig, page: Page, ctx: RenderCtx): string {
  const title = page.seo_title || (page.handle === '' ? cfg.info.name : `${page.title} · ${cfg.info.name}`);
  const nav = cfg.pages.filter((p) => p.in_nav);
  const logo = cfg.brand.logo ? img(ctx, cfg.brand.logo, cfg.brand.logo_alt || cfg.info.name, 'k-logo') : '';
  const body = page.sections.map((x) => section(cfg, ctx, page, x)).join('\n');
  const canonical = ctx.canonical ? `${ctx.canonical}/${page.handle}`.replace(/\/$/, '') || ctx.canonical : null;
  const foot = [
    `<strong>${esc(cfg.info.name)}</strong>${cfg.info.tagline ? `<br>${esc(cfg.info.tagline)}` : ''}`,
    contactInfo(cfg),
    cfg.info.cvr ? `CVR ${esc(cfg.info.cvr)}` : '',
  ].filter(Boolean);
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${page.seo_description ? `<meta name="description" content="${esc(page.seo_description)}">` : ''}
${ctx.noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
${canonical && !ctx.noindex ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
${cfg.brand.font === 'moderne' ? `<link rel="preload" href="/_veyro/inter-tight.woff2" as="font" type="font/woff2" crossorigin>` : ''}
<style>${css(cfg)}</style>
</head>
<body class="k-${cfg.layout}">
${ctx.mode === 'preview' ? '<div class="k-preview">Forhåndsvisning – ikke publiceret. Formularer gemmes som test.</div>' : ''}
<a class="k-skip" href="#indhold">Spring til indhold</a>
<header class="k-head"><div class="k-wrap k-head__in">
<a class="k-brand" href="${ctx.base || '/'}">${logo || ''}<span>${logo ? '' : esc(cfg.info.name)}</span></a>
${nav.length > 1 ? `<nav class="k-nav" aria-label="Menu"><ul>${nav.map((p) => `<li><a href="${ctx.base}/${p.handle}"${p.handle === page.handle ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul></nav>` : ''}
</div></header>
<main id="indhold">
${body}
</main>
<footer class="k-foot"><div class="k-wrap k-foot__in">${foot.map((f) => `<div>${f}</div>`).join('')}</div></footer>
</body>
</html>`;
}
