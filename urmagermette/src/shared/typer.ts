export interface Interval {
  fra: number; // minutter efter midnat
  til: number;
}

/** Åbningstider pr. ugedag, 0 = søndag … 6 = lørdag */
export type Aabningstider = Record<string, Interval[]>;

export interface Ydelse {
  id: string;
  navn: string;
  beskrivelse: string;
  varighed: number; // minutter til indlevering/konsultation
  buffer: number; // minutter efter aftalen, før næste kan starte
  aktiv: boolean;
  sortering: number;
}

export interface BookingRegler {
  interval: number; // minutter mellem mulige starttider
  kapacitet: number; // samtidige aftaler
  minVarselTimer: number;
  maxDageFrem: number;
  sletEfterMaaneder: number;
}

export interface Lukkeperiode {
  id: string;
  fra: string;
  til: string;
  note: string;
}

export interface Blokering {
  id: string;
  dato: string;
  fra: number;
  til: number;
  note: string;
}

export type BookingStatus = 'anmodet' | 'bekraeftet' | 'afvist' | 'aflyst' | 'gennemfoert' | 'udeblevet';

export const AKTIVE_STATUSSER: BookingStatus[] = ['anmodet', 'bekraeftet'];

export const STATUS_TEKST: Record<BookingStatus, string> = {
  anmodet: 'Afventer godkendelse',
  bekraeftet: 'Bekræftet',
  afvist: 'Afvist',
  aflyst: 'Aflyst',
  gennemfoert: 'Gennemført',
  udeblevet: 'Udeblevet',
};

export interface Booking {
  id: string;
  ref: string;
  ydelseId: string;
  ydelseNavn: string;
  dato: string;
  start: number;
  slut: number;
  buffer: number;
  status: BookingStatus;
  navn: string;
  telefon: string;
  email: string;
  urtype: string;
  maerke: string;
  beskrivelse: string;
  harBillede: boolean;
  kilde: 'kunde' | 'admin' | 'demo';
  oprettet: string;
  opdateret: string;
  anonymiseret: boolean;
}

export interface Note {
  id: string;
  tekst: string;
  oprettet: string;
}

export interface Historik {
  handling: string;
  tekst: string;
  tid: string;
}
