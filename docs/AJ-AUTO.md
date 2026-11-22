# AJ Auto · hjemmeside og booking

AJ Auto bruger den eksisterende Veyro Worker, Hono, D1 og Resend. Domænet `aj.veyro.dk` routes særskilt i `src/index.ts`; alle værkstedets data ligger i isolerede `aj_*`-tabeller fra migration `0019_aj_booking.sql`. Veyros øvrige værter og kundeportal beholder deres routing og adgangskontrol.

## Leverance

Forside, ydelser, om os, booking og kontakt bruger AJ Autos originale logo på hvid baggrund. Siderne er udformet uden fotos. Den primære handling følger kalenderens bookingstatus, også når JavaScript er slået fra.

Booking har vedvarende lagring, valg af ydelse/tid/kalender, oplysninger, gennemgang og bekræftelse. Kunden får et 256-bit personligt link til at flytte eller aflyse. Administration på `/admin` har login via engangslink, aftaleoversigt, månedskalender, ydelser, varigheder, ugentlige bookingintervaller, blokeringer, op til tre aktive personer inklusive ejer, kontaktindbakke, mailstatus/genforsøg og redigerbar kampagne.

I Veyros kundepanel viser `/konto/kalender` måned og dagsaftaler for den indloggede bookingkunde. Adgang kræver en aktiv eller prøveaftale og en aktiv bruger i det tilknyttede bookingsystem. Ejeren ser værkstedets kalendere. En medarbejder ser sin egen.

Kalenderkoblingen til eksterne kalenderapps er et revokerbart ICS-abonnement. Den viser aftaler og aflysninger i en kalenderapp; ændringer foretages altid i bookingsystemet. Kalenderappens eget opdateringsinterval gælder. Der er ingen tovejssynkronisering, SMS, påmindelser, betaling, webshop eller chatbot.

## Kundeoplysninger før aktivering

AJ Auto har bekræftet 45 minutter til olieskift og én kalender mandag–fredag kl. 09.00–16.00 i dansk tid. Sidste start er 15.15. Lørdag og søndag er efter aftale på telefon. Migration 0022 åbner den eksisterende ejerkalender på disse betingelser. På en ny installation uden ejer er booking lukket. Værkstedets modtagermail kan tilføjes senere.

I `/admin` skal ejer/Veyro indtaste:

1. Aktiv medarbejder med bekræftet login, højst tre inklusive ejer.
2. Bekræftet varighed på den aktive ydelse.
3. De ugedage og tidsrum, hvor kunder må booke, og eventuelle pauser.
4. Aktivering af onlinebooking.
5. Værkstedets modtagermail kan tilføjes senere. Kundens bekræftelse sendes via Resend, mens værkstedets kopi venter i køen, indtil adressen er sat op.
6. Kun hvis kunden bekræfter det: kampagnens pris, indhold og udløbsdato, plus de separate bekræftelses- og visningsfelter. Den kendte pris på 900 kr. er gemt som kladde og aldrig en dokumenteret fast pris. Kampagnen skjules automatisk efter dansk udløbsdato.

Kontaktformularen gemmer beskeder allerede før mailbox-konfiguration. Den siger udtrykkeligt, når e-mail endnu ikke er tilkoblet, og henviser til telefon. De gemte beskeder findes i admin. Udskudte notifikationer kan sendes efter opsætning; de fremstilles aldrig som afsendte, før mailudbyderen har accepteret dem.

Oplysninger anvendt: AJ Auto, Slagelse, Sorøvej 5kl, telefon 60 64 41 43, Instagram @ajauto4200, “Køb, Salg & Bytte”, olieskift inklusive motorolie/oliefilter. Kundegrundlag: https://www.instagram.com/p/Dfhmg0DoErU/ og brugerens brief. Pakkeomfang: https://veyro.dk/pages/booking og https://veyro.dk/pages/hjemmeside. Ingen andre priser, åbningstider, medarbejdere, anmeldelser eller certificeringer er konstrueret.

## Drift og adgang

- Eksisterende `ADMIN_EMAILS` giver Veyros driftsmedarbejdere opsætningsadgang. AJ-brugere og kalendere styres separat i `aj_staff`; Veyros driftspersonale er ikke kundeansatte.
- `RESEND_API_KEY` og `EMAIL_FROM` genbruges. Afsenderen er den eksisterende verificerede Veyro-afsender; AJ Autos modtagermail sættes i administrationen og bruges som svaradresse til kundemails.
- Anbefalet før første rigtige booking: sæt en separat, stabil `AJ_OUTBOX_KEY` med `wrangler secret put AJ_OUTBOX_KEY`. Brug en tilfældig hemmelighed på mindst 32 bytes. Uden den udledes krypteringsnøglen af den eksisterende Resend-hemmelighed. Skift aldrig den anvendte nøgle, mens krypterede, uafsendte beskeder ligger i køen; tøm køen eller migrér krypteringen først. Nøgler må ikke committes.
- Mailoprettelse og bookingmutation sker i én D1-transaktion. Fejl fra udbyderen bliver synlige i admin og genforsøges af eksisterende cron hvert tiende minut. Køen bruger leveringslås. I sjældne tilfælde, hvor udbyderen accepterer en mail umiddelbart før et Worker-stop, kan en mail blive leveret to gange ved genforsøg.
- Kundens adgangstoken gemmes kun som SHA-256-hash. Mailkøens indhold er AES-GCM-krypteret og ryddes efter afsendelse. Login- og sessionscookies er værtsspecifikke, HttpOnly, Secure på HTTPS og SameSite Strict. Loginlinks udløber efter 15 minutter og er engangslinks; sessioner udløber efter 12 timer. Aktiv rolle valideres på hvert admin-kald.
- Kundens og loginlinkets token står i URL-fragmentet. Kundens læsekald bruger `X-AJ-Token`; skrivninger sender token i JSON. ICS bruger et hemmeligt, roterbart URL-token, fordi kalenderapps kræver et abonnementslink. Del aldrig kalenderlinket.
- D1-triggere validerer overlap, aktivering, varighed, åbningstider og blokeringer ved skrivning. Optimistisk versionskontrol beskytter samtidige flytninger/aflysninger. Tidszonen er `Europe/Copenhagen`; data gemmes i UTC. Ledige tider beregnes med hensyn til sommer-/vintertid.
- Kontakt- og bookingdata opbevares indtil særskilt sletning. Der er ingen automatisk kundedata-retention eller eksport-/sletteknap i denne leverance; aftal en slettefrist med kunden og håndtér indsigt/sletning administrativt. Udløbne loginlinks/sessioner og afsendte maillogs ryddes automatisk.

## Test og lokal forhåndsvisning

`npm run typecheck`

`npx vitest run tests/aj-time.test.mjs tests/aj-booking.test.mjs`

Testene starter separat lokal D1 og mock Resend med `.test`-adresser. De dækker lukket standardopsætning, engangslogin, CSRF, roller, medarbejdergrænse, kampagneudløb, booking/flyt/aflys, samtidige overlap, flere kalendere, blokeringer, databasefejl med rollback, mailfejl/genforsøg, sikre/roterbare kalenderlinks, dansk tidszone/sommertid og komplette browserforløb på mobil/computer. Ingen testmail sendes til rigtige modtagere.

Ved lokal drift sættes `AJ_HOSTS=127.0.0.1,localhost`; fjern custom-domain-routes fra den lokale konfigurationskopi, da Wrangler ellers omskriver værtsnavnet. Brug en separat lokal persist-mappe og kør migrationer lokalt. `DEV_MODE=0` er standard. Der er ingen testbookinger i produktions-seed.

## Udgivelse

Den eksisterende GitHub Actions-workflow `Deploy kundepanel` tager D1-bogmærke, anvender migrationerne og deployer Workeren med det nye Cloudflare custom domain. Kør ikke en gammel checkout over nyere produktion: integrér aktuel `main` først. Efter deploy verificeres de fem sider, `/api/config`, `/api/admin/data` (401), at kampagnen er skjult, og at booking stadig er lukket uden faktiske kundedata.

Rollback: vælg forrige Worker-deployment. De nye `aj_*`-tabeller kan blive liggende; de ændrer ikke andre systemers tabeller. Slet eller gendan ikke produktionsdata uden en konkret aftale.
