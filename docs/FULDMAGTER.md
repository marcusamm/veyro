# Digitale fuldmagter

Kunder giver Veyro fuldmagt i kundeportalen under **Aftaler og dokumenter → Fuldmagter** (`/konto/fuldmagter`).
Veyro administrerer dem i admin under **Fuldmagter** (`/admin/fuldmagter`).

> **Status: udkast.** Fuldmagtsteksten (`src/lib/poa.ts`), godkendelsesmetoden og opbevaringspolitikken
> (`src/lib/poa-policy.ts`) skal gennemgås af Veyro, før funktionen tages i officiel brug. Indtil da er
> siden kun åben for pilotkunder, og skærme og PDF'er er mærket "Udkast".

## Før ibrugtagning (admin → Fuldmagter → Veyros oplysninger og indstillinger)

1. Udfyld Veyros **juridiske navn** og **kontaktperson**. CVR, adresse og kontaktmail er udfyldt fra veyro.dk. Kunder kan ikke godkende, før alle fem felter er udfyldt.
2. Vælg om **Veyros accept** indgår (standard: ja). Så er status "Afventer godkendelse", indtil en medarbejder accepterer.
3. Tilføj evt. **pilotkunder** (e-mails), der kan prøve funktionen.
4. Når teksten, metoden og politikken er godkendt: sæt flueben i "gennemgået og godkendt" og derefter "Åbn for alle kunder".
5. Ændres teksten senere, skal `POA_TEXT_VERSION` i `src/lib/poa.ts` ændres. Godkendte fuldmagter beholder deres egen tekst.

## Forløb

| Trin | Hvad sker der |
| --- | --- |
| Kladde | Kunden udfylder formularen. Ingen beføjelser er valgt på forhånd. Kan gemmes og slettes helt. |
| Oversigt | Hele teksten og alle valg vises. Indholdet får en SHA-256, som skal være uændret ved godkendelsen. |
| Godkendelse | Login (engangslink på mail) + en ny 6-cifret engangskode på mail (10 min, 5 forsøg) + to bekræftelser. Ikke MitID og ikke bevis for tegningsret. |
| Låsning | Godkender, tid, metode, tekstversion og hele indholdet gemmes. En databasetrigger forhindrer ændringer. Ændringer = ny version (samme nummer, v2) og ny godkendelse. |
| PDF | Laves én gang fra den gemte version og gemmes i D1. Download har en statusside foran det uændrede dokument; "kun det oprindelige dokument" kan også hentes. |
| Kvittering | Mail til kvitteringsmailen med PDF. Afventer fuldmagten Veyro, står det tydeligt, og der sendes en ny mail ved aktivering. |
| Tilbagekaldelse | Gælder straks (én SQL-opdatering), stopper planlagte handlinger, opretter opgaver til Veyro (adgange + underretning af leverandører, fuldmagten er brugt over for), mail til kunde og Veyro. Kan ikke genaktiveres (trigger). |
| Udløb | Kontrolleres før hver fuldmagtshandling og dagligt (cron). |
| Sletning | Kladder: straks. Godkendte: "Anmod om sletning" (aktive tilbagekaldes først i samme forløb). Veyro behandler efter politikken; kunden får kvittering. Sletning er adskilt fra gyldighedsstatus. |

## Handlinger under fuldmagten

Veyro registrerer det, der gøres under en fuldmagt, i admin. Serveren kontrollerer status, udløb, sletning,
beføjelse og for bestillinger: periode, godkendt leverandør, beløb pr. bestilling og månedsgrænse (inkl. moms).
Status og månedsgrænse kontrolleres igen i selve indsættelsen, så en tilbagekaldelse altid vinder, også hvis
siden var åben i forvejen. Medarbejdere kan ikke ændre eller udvide en godkendt fuldmagt.

## Mails

Mails ligger i `poa_mails` med ærlig status: *Sendt* (Resend har modtaget den), *Fejlede* (prøves igen af cron op
til 6 gange) eller *Ikke sendt – mailintegration mangler*. Admin kan sende igen uden at oprette en ny fuldmagt.
Tilbagekaldelse og dokumenter afhænger aldrig af, at en mail bliver leveret.

## Opbevaring og sletning (udkast)

Se `src/lib/poa-policy.ts` og den offentlige side `/fuldmagter/opbevaring`.

- Kladder: slettes på anmodning straks, ellers efter 12 måneder uden ændringer.
- Ophørt uden handlinger: slettes 180 dage efter ophør (eller straks ved anmodning).
- Ophørt med udførte handlinger: PDF, godkendelse og handlingslog opbevares 3 år efter ophør (forældelsesfristen); resten slettes ved anmodning.
- Backups (D1 Time Travel) overskrives inden for 30 dage. Slettede fuldmagter gendannes ikke.

## Test- og demomiljø

Previews har `TEST_LABEL = "Testmiljø"`: sider får et banner, og PDF'er og mails mærkes "Testdokument – ikke gyldigt".
Previews bruger deres egen testdatabase.

## Tabeller (migration 0006)

`poa_settings`, `poas`, `poa_documents`, `poa_otps`, `poa_events`, `poa_deletion_requests`, `poa_mails`, `poa_actions`, `poa_tasks`.

## Skabelon på veyro.dk

Siden `veyro.dk/pages/fuldmagt` (i sidefoden under Information) beskriver funktionen og linker til
`veyro.dk/fuldmagt-skabelon.pdf`. PDF'en laves fra den samme tekst i koden som de rigtige fuldmagter og bruger
Veyros oplysninger fra indstillingerne, så den altid følger med. Sidens tekst kan redigeres i admin under Hjemmeside;
ændres fuldmagtsteksten, skal siden opdateres tilsvarende.
