// CSV til interne udtræk. Semikolon og UTF-8 med BOM, så dansk Excel åbner filen korrekt.
// Felter, der starter med =, +, -, @, tab eller linjeskift, får en apostrof foran, så regnearket
// ikke tolker brugerindtastet tekst som en formel.

export type CsvCell = string | number | null | undefined;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v).replace('.', ',') : v;
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvCell[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** Øre som kroner med komma (tal, ikke tekst) */
export const csvKr = (oere: number) => (oere / 100).toFixed(2).replace('.', ',');
