import { SITE_TRANSLATIONS } from './theme.generated';
import { convertPriceText } from './currency';

export const SITE_LANGUAGES = ['da', 'en', 'sv'] as const;
export type SiteLanguage = (typeof SITE_LANGUAGES)[number];

export function languagePath(path: string): { language: SiteLanguage; path: string } {
  const match = path.match(/^\/(en|sv)(?=\/|$)/);
  return match ? { language: match[1] as SiteLanguage, path: path.slice(match[0].length) || '/' } : { language: 'da', path };
}

/** Only the public site's pages are localized. Assets, demos, PDFs and the customer portal keep their own URLs. */
export function localizedPath(path: string, language: SiteLanguage): string {
  if (!/^\/(?:$|[?#]|pages(?:\/|$)|products(?:\/|$)|cart(?:[/?#]|$))/.test(path)) return path;
  return language === 'da' ? path : `/${language}${path}`;
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
export function localizeLinks(html: string, language: SiteLanguage): string {
  if (language === 'da') return html;
  return html.replace(/<a\b[^>]*>/g, (tag) => tag.includes('data-language-link') ? tag : tag.replace(/\bhref="([^"]*)"/, (_, href: string) => `href="${localizedPath(href, language)}"`))
    .replace(/\bdata-plan-link="([^"]*)"/g, (_, href: string) => `data-plan-link="${localizedPath(href, language)}"`);
}
