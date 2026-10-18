const dateFmt = new Intl.DateTimeFormat('da-DK', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Copenhagen',
});
const dateTimeFmt = new Intl.DateTimeFormat('da-DK', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Copenhagen',
});

export function formatDate(unixSec: number | null | undefined): string {
  if (!unixSec) return '–';
  return dateFmt.format(new Date(unixSec * 1000));
}

export function formatDateTime(unixSec: number | null | undefined): string {
  if (!unixSec) return '–';
  return dateTimeFmt.format(new Date(unixSec * 1000));
}

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Beløb i øre -> "1.099 kr." (uden decimaler når beløbet er helt) eller "1.099,50 kr.". */
export function formatKr(oere: number | null | undefined, opts: { decimals?: boolean } = {}): string {
  if (oere === null || oere === undefined) return '–';
  const neg = oere < 0;
  const abs = Math.abs(Math.round(oere));
  const kr = Math.floor(abs / 100);
  const ore = abs % 100;
  const showDec = opts.decimals || ore !== 0;
  const s = groupThousands(kr) + (showDec ? ',' + String(ore).padStart(2, '0') : '');
  return (neg ? '-' : '') + s + ' kr.';
}

/** Øre -> "1099,50" (til formularfelter og CSV-eksport). */
export function oereToInput(oere: number): string {
  const kr = Math.floor(oere / 100);
  const ore = oere % 100;
  return ore ? `${kr},${String(ore).padStart(2, '0')}` : String(kr);
}

/**
 * Læser et beløb i kroner skrevet på dansk eller engelsk: "1.299,50", "1299,5", "1299.50", "1 299 kr."
 * Returnerer øre, eller null hvis teksten ikke er et gyldigt beløb.
 */
export function parseKr(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).trim().replace(/\s|kr\.?|dkk/gi, '');
  if (!s) return null;
  if (s.includes(',')) {
    // Dansk: punktum er tusindtalsseparator, komma er decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.299" uden decimaler = tusindtalsseparator
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(parseFloat(s) * 100);
  return Number.isSafeInteger(v) && v <= 100_000_000_00 ? v : null;
}

/** Heltal (fx lagerantal). Tillader fortegn, når `signed` er sat. */
export function parseIntStrict(raw: unknown, opts: { signed?: boolean; max?: number } = {}): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim().replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '');
  if (!(opts.signed ? /^[+-]?\d+$/ : /^\+?\d+$/).test(s)) return null;
  const v = parseInt(s, 10);
  const max = opts.max ?? 1_000_000_000;
  return Math.abs(v) <= max ? v : null;
}

/** Trimmer og forkorter fritekst fra formularer. */
export function str(raw: unknown, max: number, opts: { multiline?: boolean } = {}): string {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/\r\n?/g, '\n');
  s = opts.multiline ? s.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]{2,}$/.test(e)) return null;
  return e;
}

// Mængder gemmes i tusindedele af enheden (1 stk. = 1000), se migrations/0001_initial.sql.
export const Q = 1000;

/** 12500 -> "12,5", 1250000 -> "1.250" */
export function formatQty(m: number | null | undefined): string {
  if (m === null || m === undefined) return '–';
  const neg = m < 0;
  const abs = Math.abs(Math.round(m));
  const whole = Math.floor(abs / Q);
  const frac = abs % Q;
  const dec = frac ? ',' + String(frac).padStart(3, '0').replace(/0+$/, '') : '';
  return (neg ? '-' : '') + groupThousands(whole) + dec;
}

/** Mængde med enhed: "12,5 m" */
export function qtyUnit(m: number | null | undefined, unit: string): string {
  return m === null || m === undefined ? '–' : `${formatQty(m)} ${unit}`;
}

/** Til formularfelter: 12500 -> "12,5" (uden tusindtalsseparator) */
export function qtyInput(m: number | null | undefined): string {
  if (m === null || m === undefined) return '';
  return formatQty(m).replace(/\./g, '');
}

/**
 * Læser en mængde skrevet på dansk eller engelsk: "12", "12,5", "1.250", "0.75".
 * Returnerer tusindedele, eller null hvis teksten ikke er et gyldigt, ikke-negativt tal.
 */
export function parseQty(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const v = Math.round(parseFloat(s) * Q);
  return Number.isSafeInteger(v) && v <= 1_000_000_000_000 ? v : null;
}

/** Runder op til hele enheder for varer, der kun håndteres i hele styk. */
export function roundUpUnits(m: number, wholeUnits: boolean): number {
  return wholeUnits ? Math.ceil(m / Q - 1e-9) * Q : Math.ceil(m - 1e-9);
}

/** Beløb for en mængde: pris i øre pr. enhed × mængde i tusindedele */
export function lineAmount(unitPrice: number | null | undefined, m: number): number {
  return unitPrice === null || unitPrice === undefined ? 0 : Math.round((unitPrice * m) / Q);
}

/** YYYY-MM-DD -> "18. okt. 2026" */
export function formatDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '–';
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function parseDay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isNaN(t) ? null : s;
}

/** Dagens dato i Danmark som YYYY-MM-DD */
export function todayDk(now = Date.now()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(new Date(now));
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(day + 'T00:00:00Z') + n * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}
