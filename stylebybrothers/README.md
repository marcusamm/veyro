# StyleByBrothers — hjemmesidekoncept (uofficiel demo)

Hjemmeside til **StyleByBrothers**, herrefrisør og barbershop, Sct. Mikkelsgade 26A, 4200 Slagelse (CVR 45956989).

> **Status: præsentationsdemo.** Ingen rigtige bookinger accepteres. Alt, hvad en besøgende gør (bookinger, ændringer i admin, uploadede billeder), gemmes kun i den besøgendes egen browser. Der reserveres ingen tider hos salonen, og der sendes ingen e-mails eller SMS'er.

## Indhold

| Del | Hvor | Hvad |
|---|---|---|
| Forside | `#/` | Kort introduktion med "åbent i dag", prisliste, fire billeder af salonens klipninger, salonen og holdet, find os med åbningstider |
| Booking | `#/booking` | Én side med fire trin: behandling, frisør (bestemt eller første ledige), dato og tid, kundeoplysninger. Derefter bekræftelse med bookingnummer, Google Kalender og kalenderfil (.ics). `#/booking?behandling=skin-fade` forudvælger behandlingen, `?frisoer=b1` frisøren |
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

## Skal bekræftes af ejeren før lancering

- Prisliste, varigheder og behandlinger (alt er markeret som foreløbigt).
- Medarbejdere: navne, billeder, arbejdstider og hvem der laver hvad (demoen bruger "Frisør 1–3").
- Åbningstider. De regnes ud fra frisørernes arbejdstider; demoen bruger Instagram-profilens tider (man–fre 11:30–17:30, lør 11:30–14:30, søn lukket).
- Logo og farver. Accentfarven (`#7A5A34`) bruges kun til fokusmarkering og skal tilpasses salonens logo.
- Billeder: siden har ingen stock- eller AI-billeder. Alle billedpladser er tomme og markeret "Billede kommer" med en note om, hvad der skal ind. Salonens egne billeder uploades under *Admin → Billeder*.
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
