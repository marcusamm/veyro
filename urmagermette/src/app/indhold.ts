// Tekster, der bruges flere steder. Ingen priser, garantier eller faste reparationstider,
// før ejeren har godkendt dem.
import type { BilledNavn } from './billeder';

export interface YdelseTekst {
  id: string;
  navn: string;
  kort: string;
  lang: string;
  billede: BilledNavn;
  punkter: string[];
}

export const YDELSER: YdelseTekst[] = [
  {
    id: 'armbaandsur',
    navn: 'Armbåndsure',
    kort: 'Fejlfinding, reparation og almindelig service.',
    lang: 'Går dit ur for hurtigt eller for langsomt, er det stoppet, eller trænger det bare til et eftersyn? Uret bliver undersøgt, så du ved, hvad der er galt, og hvad der kan gøres.',
    billede: 'armbaandsur',
    punkter: ['Mekaniske og automatiske ure', 'Fejlfinding og justering', 'Almindelig service og eftersyn'],
  },
  {
    id: 'vintageur',
    navn: 'Vintageure',
    kort: 'Undersøgelse og nænsom reparation af ældre ure.',
    lang: 'Ældre ure kræver tålmodighed og respekt for det oprindelige. Uret bliver undersøgt grundigt, før der tages stilling til, hvordan det bedst kan bringes til at gå igen.',
    billede: 'vintageur',
    punkter: ['Grundig undersøgelse', 'Nænsom behandling af originale dele', 'Råd om den videre pleje'],
  },
  {
    id: 'lommeur',
    navn: 'Lommeure',
    kort: 'Service og reparation af klassiske lommeure.',
    lang: 'Et lommeur er ofte et arvestykke med historie. Uanset om det er stoppet, skal trækkes op for tit eller har en skade, kan du få det set efter.',
    billede: 'lommeur',
    punkter: ['Service og rensning', 'Fejlfinding på værket', 'Vurdering af arvestykker'],
  },
  {
    id: 'bornholmerur',
    navn: 'Bornholmerure',
    kort: 'Reparation og vedligeholdelse af traditionelle bornholmerure.',
    lang: 'Bornholmerure er en del af den danske urtradition. Står uret stille, slår det forkert eller går det skævt, er det værd at få det efterset, så det kan holde i mange år endnu.',
    billede: 'bornholmerur',
    punkter: ['Reparation og vedligeholdelse', 'Slagværk og pendul', 'Råd om opstilling og pasning'],
  },
  {
    id: 'taffelur',
    navn: 'Taffelure',
    kort: 'Service og fejlfinding på klassiske bordure.',
    lang: 'Taffelure og bordure er små mesterværker til hjemmet. Uret bliver gennemgået, så du kan få at vide, hvad der skal til for at få det i gang igen.',
    billede: 'taffelur',
    punkter: ['Fejlfinding og service', 'Slagværk og optræk', 'Vurdering af ældre ure'],
  },
  {
    id: 'stueur',
    navn: 'Stueure og større ure',
    kort: 'Vurdering, vedligeholdelse og reparation af større ure.',
    lang: 'Standure, vægure og andre større ure fortjener den samme omhu som de små. Fortæl om uret, når du bestiller tid, så aftaler vi det praktiske omkring det.',
    billede: 'stueur',
    punkter: ['Vurdering af større ure', 'Vedligeholdelse og reparation', 'Aftale om det praktiske'],
  },
];

export const PROCES = [
  { titel: 'Bestil tid', tekst: 'Du vælger service og et tidspunkt, der passer dig.' },
  { titel: 'Indlever dit ur', tekst: 'Du kommer forbi værkstedet og fortæller om problemet.' },
  { titel: 'Undersøgelse og vurdering', tekst: 'Uret bliver undersøgt, og du får information om den videre proces.' },
  { titel: 'Reparation og afhentning', tekst: 'Når arbejdet er aftalt og gennemført, kan uret afhentes efter nærmere aftale.' },
];

export const FAQ: { spoergsmaal: string; svar: string; emne: 'booking' | 'indlevering' | 'vurdering' }[] = [
  {
    emne: 'booking',
    spoergsmaal: 'Er den tid, jeg bestiller, også tidspunktet for selve reparationen?',
    svar: 'Nej, ikke nødvendigvis. Tiden er som udgangspunkt til indlevering, konsultation eller vurdering af dit ur. Selve reparationen foregår bagefter, når den er aftalt med dig.',
  },
  {
    emne: 'booking',
    spoergsmaal: 'Skal jeg oprette en bruger for at bestille tid?',
    svar: 'Nej. Du vælger blot service og tidspunkt og udfylder dine kontaktoplysninger. Det tager kun et par minutter.',
  },
  {
    emne: 'booking',
    spoergsmaal: 'Hvornår er min tid endeligt bekræftet?',
    svar: 'Når du har sendt din bestilling, er den en anmodning, som afventer godkendelse. Tidspunktet er holdt til dig imens. Du får besked, når tiden er bekræftet, og du kan altid se status via linket i din kvittering.',
  },
  {
    emne: 'booking',
    spoergsmaal: 'Kan jeg flytte eller afbestille min tid?',
    svar: 'Ja. Du kan afbestille via linket i din kvittering eller ringe til værkstedet. Vil du flytte tiden, er du velkommen til at ringe eller skrive.',
  },
  {
    emne: 'indlevering',
    spoergsmaal: 'Hvad skal jeg have med, når jeg indleverer mit ur?',
    svar: 'Tag uret med, og gerne nøgle, lodder eller pendul, hvis det er et større ur. Fortæl, hvad du har lagt mærke til – fx om uret går for hurtigt, er stoppet eller slår forkert. Har du tidligere servicepapirer, må du gerne tage dem med.',
  },
  {
    emne: 'indlevering',
    spoergsmaal: 'Mit ur er stort og svært at transportere. Hvad gør jeg?',
    svar: 'Skriv det i beskrivelsen, når du bestiller tid, eller ring til værkstedet. Så finder vi sammen ud af, hvordan det praktiske bedst kan klares.',
  },
  {
    emne: 'indlevering',
    spoergsmaal: 'Kan jeg sende et billede af uret på forhånd?',
    svar: 'Ja. Når du bestiller tid, kan du vedhæfte et billede af uret. Det er frivilligt, men kan gøre det lettere at forberede besøget.',
  },
  {
    emne: 'vurdering',
    spoergsmaal: 'Hvad koster en reparation?',
    svar: 'Prisen afhænger af urets type, tilstand og hvad der skal laves. Derfor gives prisen efter en vurdering af uret. Du får information om den videre proces, før arbejdet sættes i gang.',
  },
  {
    emne: 'vurdering',
    spoergsmaal: 'Hvor lang tid tager en reparation?',
    svar: 'Det afhænger af opgaven, og om der skal skaffes reservedele. Efter vurderingen får du at vide, hvad du kan forvente.',
  },
  {
    emne: 'vurdering',
    spoergsmaal: 'Kan alle ure repareres?',
    svar: 'Mange ure kan bringes til at gå igen, men det afhænger af urets tilstand og om der findes dele. Ved vurderingen får du et ærligt svar på, hvad der kan lade sig gøre.',
  },
];
