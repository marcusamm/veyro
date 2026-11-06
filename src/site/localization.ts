import { SITE_TRANSLATIONS } from './theme.generated';
import { convertPriceText } from './currency';

export const SITE_LANGUAGES = ['da', 'en', 'sv'] as const;
export type SiteLanguage = (typeof SITE_LANGUAGES)[number];
export const SWEDISH_ORIGIN = 'https://veyro.se';

/** Host routing is explicit; lookalike domains must never select a public identity. */
export function isSwedishHost(host: string): boolean {
  return ['veyro.se', 'www.veyro.se'].includes(host.toLowerCase());
}

export function languagePath(path: string): { language: SiteLanguage; path: string } {
  const match = path.match(/^\/(en|sv)(?=\/|$)/);
  return match ? { language: match[1] as SiteLanguage, path: path.slice(match[0].length) || '/' } : { language: 'da', path };
}

export function requestLanguage(path: string, host: string): SiteLanguage {
  return isSwedishHost(host) ? 'sv' : languagePath(path).language;
}

/** Only the public site's pages are localized. Assets, demos, PDFs and the customer portal keep their own URLs. */
export function localizedPath(path: string, language: SiteLanguage, host = ''): string {
  if (!/^\/(?:$|[?#]|pages(?:\/|$)|products(?:\/|$)|cart(?:[/?#]|$))/.test(path)) return path;
  return language === 'da' || (language === 'sv' && isSwedishHost(host)) ? path : `/${language}${path}`;
}

/** Canonical language destinations are independent of the host used for a preview. */
export function canonicalLanguageUrl(path: string, language: SiteLanguage, primaryOrigin = 'https://veyro.dk'): string {
  const primary = primaryOrigin.replace(/\/+$/, '');
  const production = primary === 'https://veyro.dk' || primary === SWEDISH_ORIGIN;
  const origin = production ? (language === 'sv' ? SWEDISH_ORIGIN : 'https://veyro.dk') : primary;
  // Canonical page URLs also cover unknown routes rendered as localized 404s.
  // Navigation rewriting deliberately keeps a narrower allowlist below.
  const publicPath = language === 'da' || (language === 'sv' && isSwedishHost(new URL(origin).hostname)) ? path : `/${language}${path}`;
  return origin + publicPath;
}

export function contentText(text: string, language: SiteLanguage): string {
  if (language === 'da') return text;
  const catalog = SITE_TRANSLATIONS[language] as Record<string, string>;
  return convertPriceText(Object.hasOwn(catalog, text) ? catalog[text]! : text, language);
}

// Display values may be translated; structural keys and identifiers never are.
const structural = new Set(['handle', 'type', 'template', 'anchor', 'id', 'id_suffix', 'status', 'block_order', 'order', 'version', 'overridden', 'shop', 'menu', 'footer_menu', 'legal_menu', 'services', 'options', 'subscription_type']);
export function localizedContent<T>(value: T, language: SiteLanguage, key = ''): T {
  if (language === 'da' || structural.has(key)) return value;
  if (typeof value === 'string') return contentText(value, language) as T;
  if (Array.isArray(value)) return value.map((v) => localizedContent(v, language)) as T;
  if (value && typeof value === 'object' && !(value instanceof Set)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizedContent(v, language, k)])) as T;
  }
  return value;
}

/** Rewrite only navigation attributes, never text, script contents, form values or asset URLs. */
export function localizeLinks(html: string, language: SiteLanguage, host = ''): string {
  if (language === 'da') return html;
  return html.replace(/<a\b[^>]*>/g, (tag) => tag.includes('data-language-link') ? tag : tag.replace(/\bhref="([^"]*)"/, (_, href: string) => `href="${localizedPath(href, language, host)}"`))
    .replace(/\bdata-plan-link="([^"]*)"/g, (_, href: string) => `data-plan-link="${localizedPath(href, language, host)}"`);
}
