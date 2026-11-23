// Beregning af ledige tider. Ren logik uden database, så den kan testes og bruges både
// af serveren (som er den, der afgør, om en tid kan bookes) og af adminpanelet.
import { plusDage, ugedag, type LokalTid } from './tid';
import type { Aabningstider, Blokering, BookingRegler, Interval, Lukkeperiode } from './typer';

export interface OptagetTid {
  id?: string;
  dato: string;
  start: number;
  slut: number;
  buffer: number;
}

export interface LedighedInput {
  dato: string;
  varighed: number;
  buffer: number;
  regler: BookingRegler;
  aabningstider: Aabningstider;
  lukkeperioder: Lukkeperiode[];
  blokeringer: Blokering[]; // for datoen (andre ignoreres)
  optaget: OptagetTid[]; // aktive bookinger (andre datoer ignoreres)
  tidligst: LokalTid; // nu + minimumsvarsel
  senesteDato: string; // sidste dato, der kan bookes
  ignorerId?: string; // ved flytning: bookingen selv
}

export function erLukket(dato: string, lukkeperioder: Lukkeperiode[]): Lukkeperiode | undefined {
  return lukkeperioder.find((p) => p.fra <= dato && dato <= p.til);
}

export function aabningFor(dato: string, aabningstider: Aabningstider): Interval[] {
  return aabningstider[String(ugedag(dato))] ?? [];
}

function overlapper(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 < b2 && b1 < a2;
}

/** Ledige starttider (minutter) på en dato. */
export function ledigeTider(inp: LedighedInput): number[] {
  const { dato, varighed, buffer, regler } = inp;
  if (dato < inp.tidligst.dato || dato > inp.senesteDato) return [];
  if (erLukket(dato, inp.lukkeperioder)) return [];
  const interval = Math.max(5, regler.interval);
  const blok = inp.blokeringer.filter((b) => b.dato === dato);
  const opt = inp.optaget.filter((o) => o.dato === dato && !(inp.ignorerId && o.id === inp.ignorerId));
  const res: number[] = [];
  for (const aab of aabningFor(dato, inp.aabningstider)) {
    for (let t = aab.fra; t + varighed <= aab.til; t += interval) {
      if (dato === inp.tidligst.dato && t < inp.tidligst.min) continue;
      if (blok.some((b) => overlapper(t, t + varighed, b.fra, b.til))) continue;
      const samtidige = opt.filter((o) => overlapper(t, t + varighed + buffer, o.start, o.slut + o.buffer)).length;
      if (samtidige >= Math.max(1, regler.kapacitet)) continue;
      res.push(t);
    }
  }
  return res;
}

/** Ledige tider for en række datoer. */
export function ledighedForPeriode(inp: Omit<LedighedInput, 'dato'>, fra: string, antalDage: number): Record<string, number[]> {
  const ud: Record<string, number[]> = {};
  for (let i = 0; i < antalDage; i++) {
    const dato = plusDage(fra, i);
    ud[dato] = ledigeTider({ ...inp, dato });
  }
  return ud;
}
