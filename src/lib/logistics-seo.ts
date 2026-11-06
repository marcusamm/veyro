// Only the anonymous calculator library is public to search engines. Account
// routes and saved calculations keep their existing authentication separately.
export const PUBLIC_LOGISTICS_PATHS = [
  '/logistik/',
  '/logistik/vaerktoejer/',
  '/logistik/excel/',
  '/logistik/om/',
  ...['tco', 'eoq', 'genbestilling', 'abc', 'ladmeter', 'luftfragt', 'palletransport', 'containertransport', 'biltransport']
    .map(tool => `/logistik/vaerktoejer/${tool}/`),
] as const;

const RESOURCE_PREFIXES = ['/logistik/assets/', '/logistik/fonts/', '/logistik/downloads/'];
const RESOURCE_PATHS = ['/logistik/logo.svg', '/logistik/sitemap.xml'];
const CLOSED_ROBOTS = 'User-agent: *\nDisallow: /\n';

function canonicalPortal(url: URL, appUrl: string | undefined): boolean {
  if (!appUrl) return false;
  try {
    const canonical = new URL(appUrl);
    return /^https?:$/.test(canonical.protocol) && canonical.origin === url.origin;
  } catch {
    return false;
  }
}

export function isSavedLogisticsView(url: URL): boolean {
  return url.pathname.startsWith('/logistik/') && (url.searchParams.has('saved') || url.searchParams.has('resume'));
}

export function publicLogisticsRequest(url: URL, appUrl: string | undefined): boolean {
  if (!canonicalPortal(url, appUrl) || isSavedLogisticsView(url)) return false;
  return PUBLIC_LOGISTICS_PATHS.includes(url.pathname)
    || RESOURCE_PATHS.includes(url.pathname)
    || RESOURCE_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

export function logisticsRobots(url: URL, appUrl: string | undefined): string {
  // Preview/local hosts without an explicit matching APP_URL stay closed.
  if (!canonicalPortal(url, appUrl)) return CLOSED_ROBOTS;
  const exact = [...PUBLIC_LOGISTICS_PATHS, ...RESOURCE_PATHS].map(path => `Allow: ${path}$`);
  const resources = RESOURCE_PREFIXES.map(path => `Allow: ${path}`);
  return `${CLOSED_ROBOTS}${[...exact, ...resources].join('\n')}\n\nSitemap: ${url.origin}/logistik/sitemap.xml\n`;
}
