# Fortrolighedsaftaler (NDA) i kundeportalen

Gensidig fortrolighedsaftale mellem Veyro og kunden, bygget på "Veyro_fortrolighedsaftale.docx" (skabelon version 1).

## Forløb

1. Veyro opretter en kladde i **Admin → NDA → Ny aftale** og knytter den til en kunde og et projekt. Kundens kendte oplysninger udfyldes på forhånd.
2. Kunden udfylder og kontrollerer oplysningerne under **Aftaler og dokumenter** (`/konto/nda`), kan gemme som kladde og downloade et udkast mærket "UDKAST – IKKE GODKENDT".
3. Når oplysningerne er korrekte, låses versionen (den præcise tekst og alle felter gemmes med SHA-256). Det kræver, at Veyros juridiske navn, CVR og adresse er udfyldt i de centrale indstillinger (`/admin/fuldmagter/indstillinger`).
4. Begge parter godkender den samme version med verificeret login, to aktive afkrydsninger og en engangskode på e-mail. Metoden beskrives aldrig som MitID-underskrift eller bevis for tegningsret.
5. Aftalen er aktiv ved den sidste godkendelse. Begge parter får en endelig kvittering med PDF, som gemmes i portalen og aldrig ændres.

Ændres noget efter den første godkendelse, oprettes en ny version, som begge parter skal godkende. En aktiv aftale kan ikke ændres (også spærret med triggere i databasen).

## Roller

- `ADMIN_EMAILS`: kan oprette, sende, følge, gensende mails, behandle ophør og anmodninger og oprette skabelonversioner.
- `NDA_SIGNERS` (wrangler.toml): må desuden godkende på Veyros vegne. Tom i produktion, indtil Veyro beslutter, hvem der må.

## Ophør, sletning og tilbagelevering

- "Afslut aftalen for fremtidig udveksling" registrerer person og tidspunkt, sender en skriftlig meddelelse til den anden part og gemmer leveringsstatus. Fejler leveringen, oprettes en opgave i admin, og portalen viser, at meddelelsen ikke er leveret.
- Samarbejdets ophør registreres særskilt. Den vejledende femårsfrist vises kun, når både aftalens og samarbejdets ophør (eller at samarbejdet ikke blev indledt) er kendt.
- Kladder uden godkendelser kan slettes direkte. Godkendte aftaler kræver Veyros vurdering; beholdes noget, skal det beskrives med begrundelse og slettefrist, og det slettes automatisk på fristen.
- Anmodninger om tilbagelevering/sletning af delte oplysninger får status, historik og et konkret resultat.
- Kladder, der ikke er rørt i et år, slettes automatisk.

## Mails

Mails har ærlig status: "Afleveret til mailudbyderen", "Fejlede" eller "Ikke sendt – mailintegration mangler". Cron forsøger igen; Veyro kan gensende i admin.

## Test

`npx vitest run tests/nda.test.mjs` kører hele forløbet med to testvirksomheder.
