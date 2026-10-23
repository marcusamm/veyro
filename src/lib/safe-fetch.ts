// Hentning af offentlige hjemmesider til "Tilføj via link", vurdering og søgning.
// Beskyttelse: kun http/https på standardporte, ingen interne navne eller private/reserverede IP-adresser
// (også efter DNS-opslag), manuel kontrol af hver omdirigering, timeout og størrelsesgrænse.
import type { Env } from '../env';

export const FETCH_TIMEOUT_MS = 8000;
export const MAX_BYTES = 1_500_000;
export const MAX_REDIRECTS = 4;
const UA = 'Mozilla/5.0 (compatible; VeyroBot/1.0; +https://veyro.dk)';

export class FetchBlocked extends Error {}

// ---------- IP-adresser ----------

function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Private, lokale, reserverede eller særlige IPv4-adresser */
export function isPrivateV4(ip: string): boolean {
  const p = v4(ip);
  if (!p) return false;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  // Indlejret IPv4 sidst (fx ::ffff:10.0.0.1)
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const p = v4(tail[1]!);
    if (!p) return null;
    s = s.slice(0, -tail[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return true; // IPv4-mappet/-kompatibel: altid afvist
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unik lokal
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-lokal
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // dokumentation
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

export function isIpLiteral(host: string): boolean {
  return !!v4(host) || host.startsWith('[') || /^[0-9a-f:]+$/i.test(host) && host.includes(':');
}

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.arpa', '.test', '.example', '.invalid', '.onion'];

/** Afviser adresser, der ikke må hentes. Returnerer en fejltekst eller null. */
export function checkUrl(env: Env, raw: string): { url: URL } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'Adressen er ikke gyldig.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Kun http- og https-adresser kan hentes.' };
  if (u.username || u.password) return { error: 'Adresser med brugernavn eller adgangskode hentes ikke.' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (testAllowed(env, u)) return { url: u };
  if (u.port && u.port !== '80' && u.port !== '443') return { error: 'Kun standardporte (80 og 443) er tilladt.' };
  if (isIpLiteral(host)) return { error: 'IP-adresser hentes ikke. Brug hjemmesidens domænenavn.' };
  if (!host.includes('.') || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { error: 'Interne adresser hentes ikke.' };
  if (host === 'veyro.dk' || host.endsWith('.veyro.dk') || host.endsWith('.workers.dev')) return { error: 'Veyros egne adresser hentes ikke.' };
  return { url: u };
}

/** Kun i testmiljøet (DEV_MODE=1): tillad den lokale testserver */
function testAllowed(env: Env, u: URL): boolean {
  return env.DEV_MODE === '1' && !!env.TEST_FETCH_ALLOW && env.TEST_FETCH_ALLOW.split(',').includes(u.host);
}

/** Slår domænet op via DNS-over-HTTPS og afviser, hvis et svar er en privat/reserveret adresse */
async function checkDns(env: Env, u: URL): Promise<void> {
  if (testAllowed(env, u)) return;
  const host = u.hostname;
  const answers: string[] = [];
  for (const type of ['A', 'AAAA']) {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new FetchBlocked('Domænet kunne ikke slås op.');
    const j = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
    for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) answers.push(a.data);
  }
  if (!answers.length) throw new FetchBlocked('Domænet findes ikke (intet DNS-svar).');
  if (answers.some((ip) => isPrivateV4(ip) || isPrivateV6(ip))) throw new FetchBlocked('Domænet peger på en intern eller privat adresse og hentes ikke.');
}

export interface FetchedPage {
  url: string; // endelig adresse efter omdirigeringer
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  fetchedAt: number;
}

/** Henter en side sikkert. Kaster FetchBlocked ved blokerede adresser og Error ved netværksfejl. */
export async function safeFetch(env: Env, raw: string, opts: { method?: 'GET' | 'HEAD'; html?: boolean; maxBytes?: number } = {}): Promise<FetchedPage> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const chk = checkUrl(env, current);
    if ('error' in chk) throw new FetchBlocked(chk.error);
    await checkDns(env, chk.url);
    const res = await fetch(chk.url.toString(), {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: opts.html === false ? '*/*' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'da,en;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('Location')!, chk.url).toString();
      continue;
    }
    const contentType = res.headers.get('Content-Type') ?? '';
    if (opts.method === 'HEAD' || (opts.html !== false && !/text\/html|application\/xhtml/i.test(contentType))) {
      await res.body?.cancel();
      return { url: chk.url.toString(), status: res.status, contentType, body: '', truncated: false, fetchedAt: Math.floor(Date.now() / 1000) };
    }
    const max = opts.maxBytes ?? MAX_BYTES;
    const len = Number(res.headers.get('Content-Length') ?? 0);
    if (len > max * 4) {
      await res.body?.cancel();
      throw new FetchBlocked('Siden er for stor til at blive hentet.');
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          chunks.push(value.slice(0, value.length - (size - max)));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(Math.min(size, max));
    let off = 0;
    for (const ch of chunks) {
      buf.set(ch, off);
      off += ch.length;
    }
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
    let body: string;
    try {
      body = new TextDecoder(charset).decode(buf);
    } catch {
      body = new TextDecoder('utf-8').decode(buf);
    }
    return { url: chk.url.toString(), status: res.status, contentType, body, truncated, fetchedAt: Math.floor(Date.now() / 1000) };
  }
  throw new FetchBlocked('For mange omdirigeringer.');
}

/** Kontrollerer et link (HEAD, ellers GET uden at læse indholdet). Returnerer HTTP-status eller null ved netværksfejl. */
export async function checkLink(env: Env, url: string): Promise<number | null> {
  try {
    const h = await safeFetch(env, url, { method: 'HEAD', html: false });
    if (h.status === 405 || h.status === 501 || h.status === 403) {
      const g = await safeFetch(env, url, { html: false, maxBytes: 1024 });
      return g.status;
    }
    return h.status;
  } catch (err) {
    if (err instanceof FetchBlocked) return null;
    return null;
  }
}
