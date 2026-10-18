const dateFmt = new Intl.DateTimeFormat('da-DK', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Copenhagen',
});
const shortFmt = new Intl.DateTimeFormat('da-DK', {
  day: '2-digit',
  month: '2-digit',
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

export function formatDateShort(unixSec: number | null | undefined): string {
  if (!unixSec) return '–';
  return shortFmt.format(new Date(unixSec * 1000));
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
