// Standardopsætning (demodata). Ejeren retter det hele i adminpanelet.
import type { Aabningstider, BookingRegler, Ydelse } from './typer';

export const STANDARD_YDELSER: Ydelse[] = [
  { id: 'armbaandsur', navn: 'Armbåndsur', beskrivelse: 'Fejlfinding, reparation og almindelig service.', varighed: 20, buffer: 10, aktiv: true, sortering: 1 },
  { id: 'vintageur', navn: 'Vintageur', beskrivelse: 'Undersøgelse og nænsom reparation af ældre ure.', varighed: 30, buffer: 10, aktiv: true, sortering: 2 },
  { id: 'lommeur', navn: 'Lommeur', beskrivelse: 'Service og reparation af klassiske lommeure.', varighed: 20, buffer: 10, aktiv: true, sortering: 3 },
  { id: 'bornholmerur', navn: 'Bornholmerur', beskrivelse: 'Reparation og vedligeholdelse af traditionelle bornholmerure.', varighed: 30, buffer: 15, aktiv: true, sortering: 4 },
  { id: 'taffelur', navn: 'Taffelur', beskrivelse: 'Service og fejlfinding på klassiske bordure.', varighed: 30, buffer: 10, aktiv: true, sortering: 5 },
  { id: 'stueur', navn: 'Stueur og større ure', beskrivelse: 'Vurdering, vedligeholdelse og reparation af større ure.', varighed: 30, buffer: 15, aktiv: true, sortering: 6 },
  { id: 'andet', navn: 'Anden reparation eller vurdering', beskrivelse: 'Har du et andet ur eller et spørgsmål, så book en tid til en vurdering.', varighed: 20, buffer: 10, aktiv: true, sortering: 7 },
];

// Demo-åbningstider (ikke bekræftet af ejeren)
export const STANDARD_AABNINGSTIDER: Aabningstider = {
  '0': [],
  '1': [],
  '2': [{ fra: 10 * 60, til: 17 * 60 + 30 }],
  '3': [{ fra: 10 * 60, til: 17 * 60 + 30 }],
  '4': [{ fra: 10 * 60, til: 17 * 60 + 30 }],
  '5': [{ fra: 10 * 60, til: 16 * 60 }],
  '6': [{ fra: 10 * 60, til: 13 * 60 }],
};

export const STANDARD_REGLER: BookingRegler = {
  interval: 30,
  kapacitet: 1,
  minVarselTimer: 2,
  maxDageFrem: 60,
  sletEfterMaaneder: 12,
};
