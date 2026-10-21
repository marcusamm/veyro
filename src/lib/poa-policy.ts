// Opbevarings- og slettepolitik for fuldmagter. UDKAST: skal gennemgås og godkendes af Veyro, før funktionen tages i brug.
// Tallene bruges både af den daglige oprydning og af teksten, kunden ser, så de altid stemmer overens.

export const RETENTION = {
  /** Kladder, der ikke er ændret, slettes automatisk */
  draftDays: 365,
  /** Ophørt fuldmagt, som Veyro ikke har udført handlinger under */
  withoutActionsDays: 180,
  /** Ophørt fuldmagt med udførte handlinger: den almindelige forældelsesfrist (3 år) */
  withActionsDays: 3 * 365,
  /** D1 Time Travel: sikkerhedskopier overskrives løbende */
  backupDays: 30,
};

export interface PolicySection {
  title: string;
  items: string[];
}

export const POLICY_STATUS = 'Udkast – afventer Veyros endelige gennemgang';

export const POLICY: PolicySection[] = [
  {
    title: 'Hvad vi gemmer',
    items: [
      'Formularens oplysninger: virksomhed, CVR, adresse, kontaktperson, kvitteringsmail, godkenderens navn og titel, omfang, beføjelser og beløbsgrænser.',
      'Den godkendte version: den præcise tekst og dine valg, tidspunktet, godkendelsesmetoden og den e-mail, der var logget ind.',
      'PDF-dokumenterne, der blev lavet ved godkendelsen.',
      'Et hændelsesforløb (fx godkendt, tilbagekaldt, mail sendt) uden andre personoplysninger end Veyro-medarbejderens e-mail ved Veyros egne handlinger.',
      'De handlinger, Veyro har udført eller planlagt under fuldmagten, og modtager og status for mails om fuldmagten.',
    ],
  },
  {
    title: 'Hvor længe',
    items: [
      `Kladder, der aldrig er godkendt, kan du slette med det samme. Ellers slettes de automatisk, når de ikke er ændret i ${RETENTION.draftDays / 365 === 1 ? '12 måneder' : RETENTION.draftDays + ' dage'}.`,
      'Mens en fuldmagt er aktiv eller afventer godkendelse, gemmes den, fordi den er grundlaget for Veyros arbejde.',
      `Er fuldmagten tilbagekaldt eller udløbet, og har Veyro ikke udført handlinger under den, slettes alt automatisk ${RETENTION.withoutActionsDays / 30} måneder efter ophøret, så du kan nå at hente dokumentet. Beder du om sletning før, slettes alt, når anmodningen behandles.`,
      `Har Veyro udført handlinger under fuldmagten, opbevares PDF'en, godkendelsesoplysningerne og listen over handlingerne i 3 år efter ophøret. Det er den almindelige forældelsesfrist, og oplysningerne er nødvendige for at kunne dokumentere, at handlingerne var aftalt, hvis der opstår uenighed. Alt andet slettes, når du beder om det. Efter de 3 år slettes resten automatisk.`,
      `Sikkerhedskopier af databasen (Cloudflare D1 Time Travel) overskrives løbende. Slettede oplysninger forsvinder fra dem senest ${RETENTION.backupDays} dage efter sletningen, og Veyro gendanner ikke slettede fuldmagter fra sikkerhedskopier.`,
    ],
  },
  {
    title: 'Hvad sletning betyder',
    items: [
      'Når vi skriver "slettet", er oplysningerne fjernet fra Veyros database og lager, ikke blot skjult.',
      "Sletning i Veyros system fjerner ikke PDF'er, du allerede har downloadet eller fået på mail. Dem skal du selv slette.",
      'Tilbagekaldelse og sletning er to forskellige ting: Tilbagekaldelse stopper fuldmagten med det samme. Sletning fjerner oplysningerne bagefter.',
      'Du får en kvittering, når sletningen er behandlet, med besked om, hvad der eventuelt opbevares, hvorfor og hvor længe.',
    ],
  },
];
