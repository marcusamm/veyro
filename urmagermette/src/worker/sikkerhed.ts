// Adgangskoder, tokens og små hjælpefunktioner til sikkerhed.

const enc = new TextEncoder();

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fraB64(s: string): Uint8Array {
  const bin = atob(s);
  const ud = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) ud[i] = bin.charCodeAt(i);
  return ud;
}

export function tilfaeldigToken(bytes = 24): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const REF_TEGN = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function nyRef(): string {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return 'UM-' + Array.from(b, (x) => REF_TEGN[x % REF_TEGN.length]).join('');
}

export function nyId(): string {
  return crypto.randomUUID();
}

export async function sha256(s: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

const ITERATIONER = 100_000; // Workers' øvre grænse for PBKDF2

async function pbkdf2(pw: string, salt: Uint8Array, it: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: it }, key, 256));
}

/** "pbkdf2$100000$<salt>$<hash>" */
export async function hashAdgangskode(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONER}$${b64(salt)}$${b64(await pbkdf2(pw, salt, ITERATIONER))}`;
}

export async function tjekAdgangskode(pw: string, gemt: string): Promise<boolean> {
  const [type, it, salt, hash] = gemt.split('$');
  if (type !== 'pbkdf2' || !it || !salt || !hash) return false;
  const beregnet = await pbkdf2(pw, fraB64(salt), Number(it));
  return ensLaengde(beregnet, fraB64(hash));
}

function ensLaengde(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Genkender billedformatet ud fra filens første bytes (ikke filnavn eller angivet type). */
export function billedType(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
