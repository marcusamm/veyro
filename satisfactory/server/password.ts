const encoder = new TextEncoder();
const ITERATIONS = 100_000;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) => Uint8Array.from(text.match(/.{2}/g) || [], (part) => Number.parseInt(part, 16));

export async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export function randomToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(24));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Workers limits a PBKDF2 call to 100,000 iterations; each password has its own random salt.
  const result = await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations:ITERATIONS}, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(new Uint8Array(result))}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, count, saltHex, expectedHex] = stored.split('$');
  if (algorithm !== 'pbkdf2-sha256' || count !== String(ITERATIONS) || !/^[0-9a-f]{48}$/.test(saltHex || '') || !/^[0-9a-f]{64}$/.test(expectedHex || '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const result = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:unhex(saltHex), iterations:ITERATIONS}, key, 256));
  const expected = unhex(expectedHex);
  let different = 0;
  for (let i = 0; i < result.length; i++) different |= result[i] ^ expected[i];
  return different === 0;
}
