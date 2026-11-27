# Veyros interne bogføring

Indgang: `/admin/bogfoering` i det eksisterende kundepanel. Kræver en gyldig
Veyro-session og en adresse i `ADMIN_EMAILS`. Siden er Veyros fælles interne
regnskab, ikke et kunderegnskab. Ingen Dinero-integration eller automatisk
bogføring fra Stripe eller bankimport.

## Arkitektur og migration

`0028_accounting.sql` tilføjer kontoplan, originale filer og filstykker,
bilagskladder, importforhåndsvisninger, bankhistorik, banktilknytninger,
bogføringsjournal med linjer samt en append-only hændelseslog. Migrationen
ændrer ingen eksisterende kundeposter, fakturaer eller historiske kontonumre.
Repoet havde ikke en finansiel kontoplan i hoveddatabasen; den nye kontoplan
omfatter bl.a. 7300 Webhosting, 7320 Køb af software og 7410 Bankgebyrer.

Originaler bruger den eksisterende private D1-filmodel fra Bilag/lagerstyring:
SHA-256-identifikation og maksimalt 1 MB pr. filstykke. PDF, JPG og PNG gemmes
uændret; downloads kontrollerer filens SHA-256. Originaler, bogførte linjer og
historik kan ikke overskrives eller slettes gennem appen. Upload og download
kræver adminadgang; originaler ligger ikke i offentlige assets eller localStorage.

PDF-tekst, bilagsfortolkning og OCR-adapter genbruges fra lagerstyring. OCR kalder
kun den eksisterende private `RECEIPT_OCR`-servicebinding (`veyro-receipt-ocr`).
Dokumenter sendes ikke til en ekstern AI-udbyder. Ved utilgængelig OCR bliver
kladden gemt med åbne felter og forklaring. `Aflæs igen` genbruger original og
bilagsnummer. Kladden er tilgængelig, selv hvis den første aflæsning afbrydes.

Alle beløb behandles som heltals-øre. Bankimport skriver udelukkende bankhistorik.
Kun `Godkend og bogfør` opretter journalen, atomisk og med en unik operation pr.
bilag. Hver journal skal balancere, før databasen tillader status `posted`.
Versionskontrol stopper forældede kladder fra en anden browser. Moms og resultat
læser samme bogførte journaler i én databasebatch for den valgte periode.
Rettelser består af en begrundet modpostering og valgfrit en rettelseskladde med
link til samme original. Både den oprindelige og den korrigerede bogføring bevares.

## Import og afgrænsninger

- CSV: UTF-8, komma/semikolon/tabulator, citerede felter og decimalpunkt/komma.
  Dato, beskrivelse, valuta og signed Amount eller Money out/Money in kræves.
  Filens konto/IBAN har forrang; feltet i importformularen er fallback.
- PDF: genkendelige Revolut-transaktionsbekræftelser og tabeller med bevarede
  kolonner. PDF med flere konti, tvetydige kolonner eller utilstrækkelig tekst/OCR
  afvises til bankimport med forklaring; brug da CSV. Ikke alle PDF-layouts er
  understøttet. Et multi-post-udtog kan aldrig godkendes som ét køb.
- Grænser: 15 MB pr. original, 2 MB CSV, 20 PDF-sider (10 ved nødvendig OCR),
  250 bankposter pr. import. Større udtog deles i perioder. Mangellisteeksporten
  har ingen skjult 2.000-linjers grænse.
- Transaktions-ID og saldoidentitet bruges på tværs af CSV/PDF. Uklar identitet
  kræver eksplicit valg af eksisterende linje eller særskilt betaling. Kendte
  forskellige transaktions-ID'er sammenlægges ikke, selv ved identiske beløb.
  Modstridende stærke identiteter blokerer import. En særskilt, ikke-nul Fee-kolonne
  afvises, når det er uklart, om Amount allerede inkluderer gebyret.
- Fjern/gendan er kun status på mangellisten. Historik, importerede bevægelser,
  journal og moms påvirkes ikke. Den viste banksum er sum af importerede
  bevægelser, ikke en opfundet startsaldo eller kontosaldo.
- Moms og fradragsret kræver kontrol. Tomt er ukendt, ikke nul. Der gættes ikke
  moms på et bankgebyr. Udenlandsk valuta kræver eksplicitte dokumenterede
  DKK-beløb; der er ingen automatisk valutakurs eller reverse-charge beregning.

## Prøv lokalt med fiktive data

```sh
cd /Users/marcusammitzboell/Documents/ChatGPT/Veyro/source
npm ci
npm run preview:accounting
```

Scriptet starter en lokal Worker med en ny lokal database, alle migrationer og
mock-mail/betaling. Det udskriver et loginlink til `admin@veyro.dk` og en mappe med
fiktive PDF/CSV-filer. Der sendes ingen mails og skrives ingen produktionsdata.
Åbn loginlinket, tryk **Fortsæt**, og gå til **Bogføring**. Ved genstart oprettes
et nyt tomt testmiljø; Ctrl+C stopper og fjerner den lokale database.

1. Bankafstemning: 5 importerede bevægelser, samlet **−284,95 kr.**, og en
   webhostingkladde knyttet til banklinje 5. Moms og resultat er stadig nul.
2. Fjern Netto **−74,95 kr.**. Åbn **Fjernede linjer** og **Gendan**. Sum og
   moms er uændrede; Netto er udeladt fra mangelliste-CSV, mens den er fjernet.
3. Vælg Apple **−125 kr.** og refunderingen **+125 kr.** med **Fjern begge
   linjer**. Begge findes i fjernede linjer, og banksummen er stadig −284,95 kr.
4. Åbn gebyrkladden B1. Dato **23.11.2026**, total **85,00 DKK**, konto
   **7410**, og begge momsfelter åbne. **Aflæs igen** ændrer ikke bilagsnummeret.
5. Åbn B2. Kontrollér leverandør `Example Webhosting ApS`, dato, total **125**,
   angivet moms **25** og fradragsberettiget moms **25**. Søg **7300** eller
   **webhosting**, og vælg **7300 · Webhosting**, modkonto **5820**.
6. **Godkend og bogfør**. Rapporter for november 2026 viser udgift **100 kr.**,
   købsmoms **25 kr.** og **Til gode 25 kr.** Banklinje + original tæller én gang.
   Gentagen godkendelse opretter ikke en ekstra postering.
7. Importér `revolut-test.csv` igen, eller `revolut-gebyr-85.pdf` som bankimport
   med samme konto `TEST-Revolut-DKK`. Ingen ekstra identificerbar banklinje.
   `revolut-flere-poster.pdf` som bilag må ikke godkendes som et samlet køb.
8. På B2 vælges tilbageførsel med dato og begrundelse. Kontrollér modpostering,
   historik og rettelseskladde. Den første post og originalfilen bevares.

## Verifikation og udgivelse

```sh
npm run typecheck
npx vitest run tests/accounting-core.test.mjs tests/accounting-import.test.mjs tests/accounting-ui.test.mjs tests/accounting-routes.test.mjs
npm test
```

Testene bruger fiktive data, rigtige SQLite-migrationer, den faktiske Hono-router,
session/CSRF og genererede PDF'er. De dækker bl.a. autorisation af originaler,
delte data, kontosøgning, PDF-tekst før OCR, ufuldstændig OCR, aldrig gættet moms,
bankpar, krydsformatdubletter, konflikt/concurrency, balanceret og idempotent
bogføring, fremmed valuta og sporbare rettelser. OCR-adapteren testes med
syntetiske service-responser; selve OCR-motoren har særskilt workflow/testpakke.

Udgiv med det eksisterende `Deploy kundepanel`-workflow efter godkendt test.
Workflowet gemmer et D1 Time Travel-bogmærke før de additive migrationer og
udgiver derefter Workeren. Den private OCR-service skal eksistere i samme konto.
Fiktive testfiler eller prøveposteringer skal aldrig kopieres til produktion.
Ved programfejl kan forrige Worker-version genudgives; de nye additive tabeller
kan blive stående. Databasegendannelse må ikke køres blindt efter nye rigtige
posteringer, da den også kan tilbagerulle andre samtidige ændringer.
