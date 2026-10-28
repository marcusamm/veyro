# StyleByBrothers

Hjemmeside med onlinebooking for StyleByBrothers, herrefrisør på Sct. Mikkelsgade 26A, 4200 Slagelse (CVR 45956989).
Live på **https://sbb.veyro.dk**.

## Indhold

| Side | Adresse | Hvad |
| --- | --- | --- |
| Forside | `#/` | Introduktion med "åbent nu", prisliste (inkl. moms), synlig booking-intro, behandlingsliste, galleri med salonens klipninger, salonen og åbningstider |
| Booking | `#/booking` | Behandling, tidspunkt og kundeoplysninger. `?behandling=herreklip` forudvælger behandlingen. Bekræftelse med bookingnummer og kalenderlink |
| Flyt eller aflys | `#/min-booking` | Kunden finder sin tid med bookingnummer og telefonnummer |
| Privatliv og cookies | `#/privatliv` | Privatlivspolitik (GDPR) og cookieinformation |
| Admin | `#/admin` | Login med engangslink på e-mail. Dagskalender til frisøren (opdateres hvert minut), ny booking for kunder der ringer, flyt og aflys, priser, stole og arbejdstider, lukkedage, hvem der får besked, og log over sendte e-mails |

Billederne ligger i `site/img/` og ændres i koden (`PHOTOS` og `SERVICE_PHOTOS` i `site/assets/data.js`, galleriet `LOOKS` i `site/assets/app.js`), ikke i admin.

## Design og frontend

- `site/assets/studio.css`: grafit, varm elfenben og messing; forside, navigation, billedgalleri og footer.
- `site/assets/booking-polish.css`: booking, flytning/aflysning, bekræftelse og privatliv. Admin har sit eksisterende layout.
- `site/assets/styles.css`: fælles fundament og admin.
- Inter og Oswald serveres lokalt. Oswalds OFL-licens følger med i `site/assets/fonts/`.
- Galleriet kan bladres med pile, touch eller mus; billeder åbnes i en dialog med tastaturnavigation og Escape. Bevægelse kan sættes på pause, og systemets indstilling for reduceret bevægelse respekteres.
- Priser, behandlinger og åbningstider vises fra serverens aktuelle opsætning. Designændringer erstatter ikke salonens bookinger eller indstillinger.

## Sådan virker bookingen

- `site/assets/booking-engine.js` er bookingmotoren (rene funktioner): arbejdstider, pauser, fravær, lukkedage, bookingvindue, varsel og dansk tid med sommertid. Browseren bruger den til at vise ledige tider, serveren til at tjekke dem.
- `worker/core.js` er serveren. Al data ligger i én Durable Object (`Salon`), som behandler én forespørgsel ad gangen, så samme tid ikke kan bookes to gange.
- Hver "stol" (frisør) er en kalender. Med to stole kan to kunder bookes samtidig. Kunden vælger ikke frisør, medmindre det slås til under *Regler og lukkedage*.
- E-mails sendes via Resend fra `booking@veyro.dk`: bekræftelse til kunden, påmindelse dagen før (cron kl. 16 UTC) og besked til salonen ved ny, flyttet og aflyst booking. Salonens adresse sættes i admin; indtil da går beskeden til første adresse i `ADMIN_EMAILS`.
- Persondata: bookinger arkiveres efter 60 dage og slettes 12 måneder efter besøget. Ingen sporing eller tredjepartscookies; kun en nødvendig login-cookie til admin.
- Simpel beskyttelse mod misbrug: grænser pr. IP for bookinger, opslag og login.

## Drift

- `wrangler.toml`: worker `stylebybrothers` med eget domæne `sbb.veyro.dk`, statiske filer fra `site/`, `/api/*` til serveren.
- Workflowet *Deploy StyleByBrothers* tester, deployer og sætter `RESEND_API_KEY` ved hvert push til `main`, der ændrer `stylebybrothers/`.
- Adminadgang styres af `ADMIN_EMAILS` i `wrangler.toml`.

## Udvikling

```sh
cd stylebybrothers
printf 'DEV_LOGIN=1\n' > .dev.vars        # login-linket vises direkte i stedet for at blive sendt
npx wrangler dev --port 8788 --local
node scripts/e2e.mjs http://localhost:8788/ /tmp/skaermbilleder
npx vitest run --root stylebybrothers      # fra roden af repoet
```

`scripts/e2e.mjs` kan også køres mod live-siden. Den bruger Resends testadresse `delivered@resend.dev` som kundens e-mail og aflyser sine testbookinger igen. Admin-login springes over live, fordi linket sendes på e-mail.

## Skal bekræftes af salonen

- Varigheder på behandlingerne (skøn: herreklip 30, skæg 20, hårvask 10, bryllupsklip 90 min). Rettes i admin under *Priser*.
- Antal stole og eventuelle frisørnavne (nu "Stol 1" og "Stol 2" med hele åbningstiden). Rettes i admin.
- Salonens e-mail til beskeder om bookinger og som kontaktadresse på siden.
- Ejerens godkendelse af billederne fra Facebook.
