// Validering af kundens oplysninger. Bruges både i formularen og på serveren.
import { URTYPER } from './virksomhed';

export interface Kundeoplysninger {
  navn: string;
  telefon: string;
  email: string;
  urtype: string;
  maerke: string;
  beskrivelse: string;
}

export const EMAIL_RE = /^[^\s@,;"<>]+@[^\s@,;"<>]+\.[^\s@,;"<>]{2,}$/;

export function rens(s: unknown, max: number): string {
  return typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

export function normalTelefon(s: string): string {
  return s.replace(/[^\d+]/g, '');
}

export function validerKunde(k: Kundeoplysninger): Record<string, string> {
  const f: Record<string, string> = {};
  if (k.navn.length < 2) f.navn = 'Skriv dit fulde navn.';
  const cifre = k.telefon.replace(/\D/g, '');
  if (cifre.length < 8 || cifre.length > 15 || !/^[+\d\s()-]+$/.test(k.telefon)) f.telefon = 'Skriv et gyldigt telefonnummer, fx 12 34 56 78.';
  if (!EMAIL_RE.test(k.email)) f.email = 'Skriv en gyldig e-mailadresse.';
  if (!(URTYPER as readonly string[]).includes(k.urtype)) f.urtype = 'Vælg hvilken type ur, det drejer sig om.';
  if (k.beskrivelse.length < 3) f.beskrivelse = 'Beskriv kort, hvad der er galt med uret.';
  return f;
}
