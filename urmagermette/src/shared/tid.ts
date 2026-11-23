// Dansk tid (Europe/Copenhagen) med korrekt sommertid.
// Datoer er "YYYY-MM-DD" i lokal tid; klokkeslæt er minutter efter midnat i lokal tid.

export const TIDSZONE = 'Europe/Copenhagen';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIDSZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface LokalTid {
  dato: string;
  min: number;
}

/** Lokal dansk dato og klokkeslæt for et tidspunkt. */
export function kbhTid(d: Date = new Date()): LokalTid {
  const dele: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) dele[p.type] = p.value;
  return { dato: `${dele.year}-${dele.month}-${dele.day}`, min: Number(dele.hour) * 60 + Number(dele.minute) };
}

/** Forskydning fra UTC (minutter) for dansk tid på et givent tidspunkt. */
function forskydning(utcMs: number): number {
  const l = kbhTid(new Date(utcMs));
  const [y, m, d] = l.dato.split('-').map(Number) as [number, number, number];
  const somUtc = Date.UTC(y, m - 1, d, Math.floor(l.min / 60), l.min % 60);
  return Math.round((somUtc - Math.floor(utcMs / 60000) * 60000) / 60000);
}

/** UTC-tidspunkt for en dansk dato og et klokkeslæt. */
export function kbhTilUtc(dato: string, min: number): Date {
  const [y, m, d] = dato.split('-').map(Number) as [number, number, number];
  const gaet = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  let res = gaet - forskydning(gaet) * 60000;
  // Ved skift til/fra sommertid kan forskydningen være en anden på selve tidspunktet
  res = gaet - forskydning(res) * 60000;
  return new Date(res);
}

export function ugedag(dato: string): number {
  // 0 = søndag … 6 = lørdag
  return new Date(`${dato}T12:00:00Z`).getUTCDay();
}

export function plusDage(dato: string, n: number): string {
  const d = new Date(`${dato}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dageMellem(fra: string, til: string): number {
  return Math.round((Date.parse(`${til}T12:00:00Z`) - Date.parse(`${fra}T12:00:00Z`)) / 86400000);
}

export function erDato(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function klok(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}.${String(min % 60).padStart(2, '0')}`;
}

/** "10:30" eller "10.30" -> 630 */
export function tilMin(s: string): number | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

export function klokKolon(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

const UGEDAGE = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const MAANEDER = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];

export function ugedagNavn(n: number): string {
  return UGEDAGE[n] ?? '';
}

export function maanedNavn(n: number): string {
  return MAANEDER[n] ?? '';
}

/** "tirsdag den 3. november 2026" */
export function datoLang(dato: string): string {
  const [y, m, d] = dato.split('-').map(Number) as [number, number, number];
  return `${ugedagNavn(ugedag(dato))} den ${d}. ${maanedNavn(m - 1)} ${y}`;
}

/** "3. nov." */
export function datoKort(dato: string): string {
  const [, m, d] = dato.split('-').map(Number) as [number, number, number];
  return `${d}. ${maanedNavn(m - 1).slice(0, 3)}.`;
}

/** Mandag i ugen for en dato */
export function ugeStart(dato: string): string {
  const u = ugedag(dato);
  return plusDage(dato, u === 0 ? -6 : 1 - u);
}

/** ISO-ugenummer */
export function ugenummer(dato: string): number {
  const d = new Date(`${dato}T12:00:00Z`);
  const dag = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dag + 3);
  const foersteTorsdag = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - foersteTorsdag.getTime()) / 86400000 - 3 + ((foersteTorsdag.getUTCDay() + 6) % 7)) / 7);
}
