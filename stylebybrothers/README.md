# StyleByBrothers — hjemmesidekoncept (uofficiel demo)

Hjemmeside til **StyleByBrothers**, herrefrisør og barbershop, Sct. Mikkelsgade 26A, 4200 Slagelse (CVR 45956989).

> **Status: præsentationsdemo.** Ingen rigtige bookinger accepteres. Alt, hvad en besøgende gør (bookinger, ændringer i admin, uploadede billeder), gemmes kun i den besøgendes egen browser. Der reserveres ingen tider hos salonen, og der sendes ingen e-mails eller SMS'er.

## Indhold

| Del | Hvor | Hvad |
|---|---|---|
| Forside | `#/` | Kort introduktion med "åbent i dag", prisliste, fire billeder af salonens klipninger, salonen og holdet, find os med åbningstider |
| Booking | `#/booking` | Én side med fire trin: behandling, frisør (bestemt eller første ledige), dato og tid, kundeoplysninger. Derefter bekræftelse med bookingnummer, Google Kalender og kalenderfil (.ics). `#/booking?behandling=herreklip` forudvælger behandlingen, `?frisoer=b1` frisøren |
| Min booking | `#/min-booking` | Kunden finder sin booking med bookingnummer + telefonnummer og kan flytte eller aflyse (inden for den frist, salonen sætter) |
| Admin | `#/admin` | Bookinger pr. dag og barber (flyt/aflys), behandlinger (navn, beskrivelse, pris, varighed, rækkefølge, skjul), frisører (billede, behandlinger, arbejdstider, pauser, ferie), tider og regler (bookingvindue, varsel, interval, buffer, lukkedage, link til eksternt bookingsystem), billeder (forside, salonen, facaden og klipninger) og udsendelser (de e-mails og SMS'er, der ville blive sendt) |

## Bookingmotoren

`site/assets/booking-engine.js` er rene funktioner uden DOM, så den samme kode kan køre på en server i drift. Den

- viser kun reelt ledige tider og tjekker ledigheden igen ved oprettelse (ingen dobbeltbookinger),
- respekterer hver barbers arbejdstid, pause, fravær/ferie og behandlinger samt salonens lukkedage,
- tager hensyn til behandlingens varighed og en valgfri buffer mellem kunder,
- regner i dansk tid (Europe/Copenhagen) og gemmer starttidspunktet i UTC, så sommer- og vintertid er korrekt,
- begrænser booking til et redigerbart vindue (mindste varsel og højst X dage frem),
- understøtter aflysning og flytning, og "første ledige barber" fordeler kunderne på de ledige barberer.

Tests: `npx vitest run --root stylebybrothers` (fra repoets rod), 15 tests inkl. sommertidsskift.
Gennemklik i browser: start `npm start` her i mappen og kør `node scripts/e2e.mjs http://localhost:8787/ <mappe-til-skærmbilleder>`.

## Hosting

Siden ligger på **https://sbb.veyro.dk** som en statisk Cloudflare Worker (`stylebybrothers`, se `wrangler.toml`). Workflowet *Deploy StyleByBrothers* tester bookingmotoren og publicerer `site/` ved hvert push til `main`, der ændrer `stylebybrothers/`, og kan også køres manuelt fra fanen Actions. `site/_headers` sætter `noindex`, så søgemaskiner ikke viser demoen.

## Skal bekræftes af ejeren før lancering

- Varigheder på behandlingerne (priser og åbningstider er fra salonen; varighederne er et skøn).
- Medarbejdere: navne, billeder, arbejdstider og hvem der laver hvad (demoen bruger "Frisør 1–3").
- Pauser og fridage pr. frisør. Åbningstiderne (man–ons 11–18, tor–fre 10–18, lør 9–15, søn lukket) er fra salonen og regnes ud fra frisørernes arbejdstider, så alle tre frisører står til hele åbningstiden.
- Logo og farver. Accentfarven (`#7A5A34`) bruges kun til fokusmarkering og skal tilpasses salonens logo.
- Billeder: siden bruger seks af salonens egne billeder fra Facebook (i `site/img/`). Ejeren skal godkende brugen. Der er ingen stock- eller AI-billeder, og facadebilledet mangler stadig.
- Om salonen allerede bruger et bookingsystem. Ved research (okt. 2026) fandt vi intet offentligt bookinglink på nettet; Facebook og Instagram kunne ikke læses direkte. Bruger salonen fx Planway, Booksy eller Fresha, sættes linket under *Admin → Tider & regler → Eksisterende bookingsystem*, så alle "Book tid"-knapper går dertil i stedet for at oprette et konkurrerende system.

## Fra demo til drift

Demoen er statiske filer. Før rigtige bookinger kan tages imod, skal der laves:

1. **Server og database**: en Cloudflare Worker med D1 (som repoets øvrige systemer), hvor bookingmotoren kører på serveren. Dobbeltbookinger forhindres i databasen (ledighedstjek og indsættelse i én transaktion pr. barber og dag).
2. **Login til admin** for ejer og barberer (e-mail-link som i lagerstyringen), så adminpanelet ikke er åbent.
3. **E-mail-bekræftelse** via Resend fra salonens domæne, og **SMS-påmindelser** via en SMS-udbyder (fx GatewayAPI), når salonen har valgt en. Teksterne findes allerede under *Udsendelser*.
4. **Billeder** gemt i R2 i stedet for i browseren.
5. **Domæne, HTTPS, privatlivspolitik og cookiebanner** (demoen bruger ingen cookies, kun browserens lokale lager).

## Tekniske noter

- Ingen build-trin og ingen eksterne afhængigheder i siden. Én skrifttype, Schibsted Grotesk (SIL Open Font License), ligger i `site/assets/fonts/`.
- Ingen animationer ud over et kort fade på beskeder.
- Siden har `noindex`, så demoen ikke dukker op i Google.
