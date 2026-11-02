import { languagePath, localizedPath, SITE_LANGUAGES, type SiteLanguage } from './localization';

export const LANGUAGE_COOKIE = 'veyro_language';

const isLanguage = (value: unknown): value is SiteLanguage => SITE_LANGUAGES.includes(value as SiteLanguage);
const publicPage = (path: string) => /^\/(?:$|(?:pages|products)\/[^/]+\/?$|cart\/?$)/.test(path);

/** Decide before rendering/caching. Only Cloudflare's trusted request metadata supplies the country. */
export function languageRedirect(request: Request, preference?: string): { location: string; selectedLanguage?: SiteLanguage } | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  const current = languagePath(url.pathname);
  if (!publicPage(current.path)) return null;

  // An explicit switch also works without JavaScript, including Danish (which has no URL prefix).
  const selected = url.searchParams.get('lang');
  if (isLanguage(selected)) {
    url.searchParams.delete('lang');
    return { location: localizedPath(current.path, selected) + url.search, selectedLanguage: selected };
  }

  // Shared localized links always retain their language. Crawlers can access every canonical URL.
  if (current.language !== 'da') return null;
  const bot = request.cf?.botManagement as { verifiedBot?: boolean } | undefined;
  if (bot?.verifiedBot || /bot|crawl|spider|slurp|preview|facebookexternalhit|lighthouse/i.test(request.headers.get('User-Agent') ?? '')) return null;

  const country = typeof request.cf?.country === 'string' ? request.cf.country.toUpperCase() : '';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const language = isLanguage(preference) ? preference : country === 'SE' ? 'sv' : country === 'DK' || (!country && local) ? 'da' : 'en';
  if (language === 'da') return null;
  return { location: localizedPath(current.path, language) + url.search };
}
