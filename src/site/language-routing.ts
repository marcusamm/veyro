import { canonicalLanguageUrl, isSwedishHost, languagePath, localizedPath, SITE_LANGUAGES, type SiteLanguage } from './localization';

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
  // Search Console's URL Inspection uses Google-InspectionTool, which does not contain "bot".
  if (bot?.verifiedBot || /bot|crawl|spider|slurp|preview|facebookexternalhit|lighthouse|google-inspectiontool/i.test(request.headers.get('User-Agent') ?? '')) return null;

  const country = typeof request.cf?.country === 'string' ? request.cf.country.toUpperCase() : '';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const language = isLanguage(preference) ? preference : country === 'SE' ? 'sv' : country === 'DK' || (!country && local) ? 'da' : 'en';
  if (language === 'da') return null;
  return { location: localizedPath(current.path, language) + url.search };
}

/** Production Swedish URLs live at veyro.se; development/preview language paths remain local. */
export function domainLanguageRedirect(request: Request, preference?: string, primaryOrigin = 'https://veyro.dk'): { location: string; selectedLanguage?: SiteLanguage; status?: 301 | 302 } | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  const swedish = isSwedishHost(url.hostname);
  const primary = url.hostname === 'veyro.dk';
  if (!swedish && !primary) return languageRedirect(request, preference);
  const current = languagePath(url.pathname);
  const selected = url.searchParams.get('lang');

  if (publicPage(current.path) && isLanguage(selected)) {
    if (swedish && selected !== 'sv') {
      // The destination must consume ?lang itself and set its own host-bound cookie.
      // Removing it here would let country detection redirect a Danish choice back to Sweden.
      return { location: canonicalLanguageUrl(current.path, selected, primaryOrigin) + url.search };
    }
    url.searchParams.delete('lang');
    return {
      location: selected === 'sv'
        ? (swedish ? current.path : canonicalLanguageUrl(current.path, selected, primaryOrigin)) + url.search
        : localizedPath(current.path, selected) + url.search,
      selectedLanguage: selected,
    };
  }

  if (current.language === 'sv') {
    return { location: canonicalLanguageUrl(current.path, 'sv', primaryOrigin) + url.search, status: 301 };
  }
  if (swedish) {
    if (current.language === 'en') return { location: canonicalLanguageUrl(current.path, 'en', primaryOrigin) + url.search, status: 301 };
    return null; // An explicit Swedish domain wins over geolocation and any old preference cookie.
  }
  const decision = languageRedirect(request, preference);
  if (!decision) return null;
  const target = new URL(decision.location, url.origin);
  const language = languagePath(target.pathname);
  return language.language === 'sv'
    ? { ...decision, location: canonicalLanguageUrl(language.path, 'sv', primaryOrigin) + target.search }
    : decision;
}
