# Veyro kundepanel (kunde.veyro.dk)

Selvbetjening til Veyros abonnementskunder. Kunderne kan:

- logge ind uden adgangskode (engangslink på e-mail)
- se deres plan, status, næste betaling og startdato
- skifte plan (op- eller nedgradere) med forholdsmæssig afregning
- opsige til udgangen af perioden og fortryde en opsigelse (med valgfri bindingsperiode)
- se og downloade fakturaer og skifte betalingskort
- sende ændringsønsker, fejlmeldinger og spørgsmål og følge status

Der er også en admin-del (`/admin`), hvor Veyro kan se kunder og henvendelser, ændre status og oprette abonnementer med individuel pris ud fra et tilbud, som kunden tilmelder sig via et personligt Stripe-betalingslink (se [afsnit 14](#14-tilbud-med-individuel-pris-og-betalingslink)).

Teknik: Cloudflare Workers + D1 (database), Hono, Stripe Billing (via Stripes REST API) og Resend til e-mail.

---

## Indhold

1. [Overblik over det, du skal sætte op](#1-overblik)
2. [Stripe: produkter og priser](#2-stripe-produkter-og-priser)
3. [Stripe: kundeportal (til kortskift)](#3-stripe-kundeportal-til-kortskift)
4. [Cloudflare: database (D1)](#4-cloudflare-database-d1)
5. [GitHub og Cloudflare Workers Builds](#5-github-og-cloudflare-workers-builds)
6. [Hemmeligheder (secrets)](#6-hemmeligheder-secrets)
7. [Eget domæne: kunde.veyro.dk](#7-eget-domæne-kundeveyrodk)
8. [Stripe: webhook](#8-stripe-webhook)
9. [Resend: e-mail fra kontakt@veyro.dk](#9-resend-e-mail-fra-kontaktveyrodk)
10. [Afprøvning før lancering](#10-afprøvning-før-lancering)
11. [Indstillinger (alle variabler)](#11-indstillinger-alle-variabler)
12. [Cookies og GDPR](#12-cookies-og-gdpr)
13. [Udvikling og tests (for udviklere)](#13-udvikling-og-tests-for-udviklere)
14. [Tilbud med individuel pris og betalingslink](#14-tilbud-med-individuel-pris-og-betalingslink)
15. [Hjemmesiden veyro.dk uden Shopify](#15-hjemmesiden-veyrodk-uden-shopify)
16. [Digitale fuldmagter](#16-digitale-fuldmagter)
17. [Kunder: opsætning og publicering af hjemmesider](#17-kunder-opsætning-og-publicering-af-hjemmesider)

---

## 1. Overblik

Du skal bruge adgang til:

- **Cloudflare** – den konto, hvor domænet `veyro.dk` ligger
- **GitHub** – et (privat) repository med denne kode
- **Stripe** – Veyros Stripe-konto
- **Resend** – en konto til at sende e-mails

Tip: Lav hele opsætningen i Stripes **testtilstand** først (kontakten "Testtilstand"/"Test mode" i Stripe Dashboard). Når alt virker, gentager du trin 2, 3, 6 og 8 i live-tilstand og skifter nøglerne ud.

---

## 2. Stripe: produkter og priser

1. Log ind på [dashboard.stripe.com](https://dashboard.stripe.com).
2. Gå til **Produktkatalog** → **Tilføj produkt**.
3. Opret tre produkter:

   | Produktnavn | Pris | Valuta | Fakturering |
   |---|---|---|---|
   | Starter | 299,00 | DKK | Tilbagevendende, månedlig |
   | Business | 599,00 | DKK | Tilbagevendende, månedlig |
   | Premium | 1.099,00 | DKK | Tilbagevendende, månedlig |

   Priserne i kundepanelet er vist **inkl. 25 % moms**, så beløbet skal være det, kunden betaler i alt.
4. Åbn hver pris, og kopiér **pris-ID'et** (starter med `price_...`). Du skal bruge de tre ID'er i trin 5 (`PRICE_STARTER`, `PRICE_BUSINESS`, `PRICE_PREMIUM`).

**Moms på fakturaen (valgfrit, anbefales):** Hvis fakturaerne skal vise momsbeløbet, kan du oprette en momssats i Stripe (**Produktkatalog → Skattesatser / Tax rates**: navn "Moms", 25 %, Danmark, markeret som **inkluderet i prisen / inclusive**). Kopiér ID'et (`txr_...`) og sæt det som `STRIPE_TAX_RATE_ID` i `wrangler.toml`. Så sættes satsen automatisk på nye abonnementer. Spørg jeres revisor, hvis I er i tvivl om fakturakravene.

**Kvitteringer:** Under **Indstillinger → Kundemails** (Settings → Customer emails) kan du slå e-mails om gennemførte betalinger og fejlede betalinger til, så Stripe sender dem automatisk.

---

## 3. Stripe: kundeportal (til kortskift)

Knappen "Skift betalingskort" sender kunden til Stripes egen, sikre side, hvor kun betalingskortet kan ændres. Det kræver, at Stripes kundeportal er gemt én gang:

1. Gå til **Indstillinger → Billing → Kundeportal** (Settings → Billing → Customer portal).
2. Sørg for, at **"Kunder kan opdatere betalingsmetoder"** er slået til.
3. Udfyld evt. links til vilkår og privatlivspolitik, og klik **Gem**.

(Gør det både i test- og live-tilstand.)

---

## 4. Cloudflare: database (D1)

**Via Cloudflare Dashboard (ingen kommandolinje):**

1. Gå til [dash.cloudflare.com](https://dash.cloudflare.com) → **Storage & Databases → D1 SQL Database → Create**.
2. Navn: `veyro-kundepanel`. Opret.
3. Kopiér **Database ID** og indsæt det i `wrangler.toml` i linjen `database_id = "..."` (erstat nullerne). Commit ændringen til GitHub.
4. Åbn databasen → fanen **Console**. Åbn filen `migrations/0001_initial.sql` fra repository'et, kopiér hele indholdet ind i konsollen, og klik **Execute**. Nu er tabellerne oprettet.

**Alternativt med kommandolinjen** (kræver Node.js 20+):

```bash
npm install
npx wrangler login
npx wrangler d1 create veyro-kundepanel     # kopiér database_id ind i wrangler.toml
npm run migrate                              # opretter tabellerne i den rigtige database
```

> Kommer der senere nye filer i `migrations/`, skal de køres på samme måde (konsol eller `npm run migrate`). Brug ikke begge metoder til samme fil.

---

## 5. GitHub og Cloudflare Workers Builds

1. Læg koden i et **privat** GitHub-repository (fx `veyro/kundepanel`).
2. Ret værdierne under `[vars]` i `wrangler.toml` (de er ikke hemmelige):
   - `PRICE_STARTER`, `PRICE_BUSINESS`, `PRICE_PREMIUM` – pris-ID'erne fra trin 2
   - `ADMIN_EMAILS` – e-mails med admin-adgang, kommasepareret (fx `kontakt@veyro.dk,navn@veyro.dk`)
   - `MIN_MONTHS` – bindingsperiode i måneder (`0` = ingen binding)
   - de øvrige kan normalt blive stående (se [afsnit 11](#11-indstillinger-alle-variabler))
3. I Cloudflare: **Workers & Pages → Create → Workers → Import a repository**.
4. Forbind din GitHub-konto, og vælg repository'et.
5. Indstillinger for build:
   - **Project name:** `veyro-kundepanel` (skal matche `name` i `wrangler.toml`)
   - **Build command:** lad stå tom
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/` (eller mappen, hvis koden ligger i en undermappe)
6. Klik **Deploy**. Hver gang der pushes til hovedgrenen, bygges og udgives en ny version automatisk.

> Bemærk: Værdier i `wrangler.toml` under `[vars]` overskriver variabler, der er sat i dashboardet, ved hver udgivelse. Ret dem derfor i filen. Hemmeligheder (næste trin) påvirkes ikke.

---

## 6. Hemmeligheder (secrets)

Hemmeligheder må **aldrig** stå i koden eller i `wrangler.toml`. Sæt dem i Cloudflare:

**Dashboard:** Workers & Pages → `veyro-kundepanel` → **Settings → Variables and Secrets → Add** → Type: **Secret**.

**Eller kommandolinje:**

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
```

| Navn | Hvor finder jeg den? |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Udviklere → API-nøgler → **Hemmelig nøgle** (`sk_live_...` / `sk_test_...`). Du kan med fordel oprette en **begrænset nøgle** (`rk_...`) med skriveadgang til: Checkout Sessions, Customers, Subscriptions, Invoices, Customer portal. |
| `STRIPE_WEBHOOK_SECRET` | Oprettes i trin 8 (`whsec_...`). |
| `RESEND_API_KEY` | Resend → API Keys → Create (adgang: *Sending access*), trin 9. |

> **Vigtigt:** Uden `RESEND_API_KEY` sendes ingen e-mails, og login-links skrives i stedet i Workerens log. Det er kun beregnet til udvikling – sæt altid nøglen i produktion.

---

## 7. Eget domæne: kunde.veyro.dk

1. Workers & Pages → `veyro-kundepanel` → **Settings → Domains & Routes → Add → Custom domain**.
2. Skriv `kunde.veyro.dk`, og bekræft. Cloudflare opretter selv DNS-posten og SSL-certifikatet (det kan tage nogle minutter).

(Alternativt kan du fjerne `#` foran `routes`-linjerne i `wrangler.toml`.)

Sørg for, at `APP_URL` i `wrangler.toml` er `https://kunde.veyro.dk` – den bruges i login-links og i links tilbage fra Stripe.

---

## 8. Stripe: webhook

Webhooken holder databasen opdateret, når der sker noget i Stripe (nyt køb, betaling, fejlet betaling, opsigelse).

1. Stripe → **Udviklere → Webhooks → Tilføj endpoint** (Add destination).
2. **Endpoint-URL:** `https://kunde.veyro.dk/stripe/webhook`
3. Vælg disse hændelser:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.finalized`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice.voided`
4. Gem, og kopiér **Signing secret** (`whsec_...`). Sæt den som `STRIPE_WEBHOOK_SECRET` (trin 6).

Kunden oprettes i kundepanelet, når betalingen er gennemført. Derefter kan kunden logge ind med den e-mail, der blev brugt i Stripe Checkout.

**Eksisterende Stripe-kunder:** Har I allerede kunder med abonnement i Stripe, kan de komme ind i kundepanelet, når der sker en hændelse på deres abonnement. Vil du have dem ind med det samme, kan du i Stripe åbne webhooken og "gensende" (Resend) en tidligere `customer.subscription.*`-hændelse for kunden – eller lave en lille ændring på abonnementet (fx tilføje metadata), så der sendes en `customer.subscription.updated`. Bemærk, at abonnementets pris skal være én af de tre pris-ID'er, ellers vises planen som "Abonnement".

---

## 9. Resend: e-mail fra kontakt@veyro.dk

1. Opret en konto på [resend.com](https://resend.com).
2. **Domains → Add Domain** → `veyro.dk`. Vælg en region (fx EU).
3. Resend viser nu nogle DNS-poster (typisk en **MX**- og en **TXT**-post til SPF på et underdomæne som `send`, og en **TXT**-post til DKIM med navnet `resend._domainkey`).
4. I Cloudflare: vælg domænet `veyro.dk` → **DNS → Records → Add record**, og opret **præcis** de poster, Resend viser (type, navn og værdi kopieres 1:1).
   - Sæt **Proxy status** til **DNS only** (grå sky).
   - Rør ikke ved jeres eksisterende MX-poster for `veyro.dk` – Resends poster ligger på et underdomæne og påvirker ikke jeres almindelige indbakke.
   - Har I ikke allerede en DMARC-post (`_dmarc`), anbefaler Resend at oprette en; følg Resends vejledning.
5. Tilbage i Resend: klik **Verify DNS Records**. Det kan tage fra få minutter til et par timer.
6. **API Keys → Create API Key** (Sending access, evt. kun for `veyro.dk`) → sæt som `RESEND_API_KEY` (trin 6).

Afsender er `Veyro <kontakt@veyro.dk>` (kan ændres med `EMAIL_FROM`). Nye henvendelser sendes til `NOTIFY_EMAIL` (standard `kontakt@veyro.dk`) med kundens e-mail som "svar til".

---

## 10. Afprøvning før lancering

I Stripes testtilstand (med `sk_test_...`, test-pris-ID'er og en test-webhook):

1. Åbn `https://kunde.veyro.dk/bestil`, vælg en plan, og betal med testkortet `4242 4242 4242 4242` (vilkårlig fremtidig udløbsdato og CVC).
2. Gå til `https://kunde.veyro.dk/login`, skriv samme e-mail, og log ind via linket i mailen.
3. Prøv: skift plan, opsig/fortsæt, se fakturaer, skift betalingskort, opret en henvendelse.
4. Log ind med en admin-e-mail, og gå til `/admin`.
5. I Stripe → Webhooks kan du se, at hændelserne er leveret med status 200.

Skift derefter til live-nøgler, live-pris-ID'er og en live-webhook.

---

## 11. Indstillinger (alle variabler)

**Offentlige indstillinger** (i `wrangler.toml` under `[vars]`):

| Navn | Standard | Beskrivelse |
|---|---|---|
| `APP_URL` | `https://kunde.veyro.dk` | Panelets adresse (bruges i links i e-mails og fra Stripe). |
| `PRICE_STARTER` | – | Stripe pris-ID for Starter. **Skal udfyldes.** |
| `PRICE_BUSINESS` | – | Stripe pris-ID for Business. **Skal udfyldes.** |
| `PRICE_PREMIUM` | – | Stripe pris-ID for Premium. **Skal udfyldes.** |
| `MIN_MONTHS` | `0` | Bindingsperiode i måneder fra abonnementets start. `0` = ingen binding. Er den fx `6`, kan kunden først opsige 6 måneder efter start, og panelet viser datoen. |
| `ADMIN_EMAILS` | `kontakt@veyro.dk` | Kommaseparerede e-mails med adgang til `/admin`. |
| `NOTIFY_EMAIL` | `kontakt@veyro.dk` | Modtager af notifikationer om nye henvendelser. |
| `EMAIL_FROM` | `Veyro <kontakt@veyro.dk>` | Afsender på e-mails (domænet skal være verificeret i Resend). |
| `DEV_MODE` | `0` | Kun til udvikling: `1` viser login-linket på skærmen, når der ikke er en Resend-nøgle. **Skal være `0` i produktion.** |
| `STRIPE_TAX_RATE_ID` | (tom) | Valgfri momssats (`txr_...`) der sættes på nye abonnementer. |

**Hemmeligheder** (se trin 6): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`.

**Kun til tests:** `STRIPE_API_BASE` og `RESEND_API_BASE` kan pege API-kald mod en lokal mock. Sæt dem ikke i produktion.

---

## 12. Cookies og GDPR

**Cookies:** Kundepanelet bruger kun strengt nødvendige cookies:

| Cookie | Formål | Levetid |
|---|---|---|
| `__Host-vk_session` | Holder dig logget ind. | 30 dage (eller til du logger ud) |
| `__Host-vk_csrf` | Sikkerhed: beskytter formularer (fx login) mod forfalskede anmodninger, før du er logget ind. | 2 timer |

Begge er `HttpOnly`, `Secure` og `SameSite=Lax`. Der er ingen statistik-, marketing- eller tredjepartscookies, ingen eksterne skrifttyper og ingen sporing. Da der kun bruges strengt nødvendige cookies, vises der **ikke** et cookie-banner. Det er en god idé at nævne de to cookies i cookiepolitikken på veyro.dk. (Når kunden betaler eller skifter kort, er det Stripes egne sider på stripe.com, og de følger Stripes egne cookie-regler.)

**Data, der gemmes i D1:**

- Kunde: e-mail, navn (fra Stripe Checkout), Stripe-kunde-ID
- Abonnement: Stripe-ID, status, plan, beløb, datoer
- Henvendelser: type, titel, beskrivelse, status
- Login-links og sessioner: kun **hashede** værdier (selve linket/cookien kan ikke genskabes fra databasen) og e-mail
- Rate-limiting: kun **hashede** nøgler (IP-adresser gemmes ikke i klartekst); slettes automatisk
- Webhook-hændelses-ID'er (for at undgå dobbeltbehandling); slettes efter 60 dage

Kortoplysninger, adresser og CVR-numre håndteres af Stripe og gemmes ikke i kundepanelet. Udløbne login-links, sessioner og rate-limit-data ryddes op automatisk hver nat (cron-trigger i `wrangler.toml`).

Panelet bruger følgende tjenester til at behandle data: Cloudflare (hosting og database), Stripe (betaling) og Resend (e-mail). Overvej at nævne dem i privatlivspolitikken, og få evt. en jurist til at gennemgå den.

**Handelsbetingelser, databehandleraftale og SLA.** Teksterne er sider på veyro.dk (`handelsbetingelser`, `databehandleraftale`, `sla` i `site/content.json`) og linkes fra sidefoden. Kunderne accepterer betingelserne og databehandleraftalen ved tilmelding på et tilbudslink, ved bestilling under `/bestil` og i overblikket i kundepanelet (eksisterende kunder). Hver accept gemmes i `agreement_acceptances` med e-mail, tidspunkt, version, sted og en hash af IP-adressen, og vises på kunden i admin. Ændres teksterne væsentligt, skal `LEGAL_VERSION` i `src/lib/legal.ts` ændres; så bliver kunderne bedt om at acceptere igen. Teksterne er udkast og bør gennemgås af en advokat.

---

## 13. Udvikling og tests (for udviklere)

Kræver Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars       # udfyld med testværdier
npm run migrate:local                # opretter tabeller i lokal D1
npm run dev                          # http://localhost:8787
```

Uden `RESEND_API_KEY` og med `DEV_MODE=1` vises login-linket direkte på skærmen og i konsollen. Lokale webhooks kan videresendes med Stripe CLI: `stripe listen --forward-to localhost:8787/stripe/webhook`.

**Scripts:**

| Kommando | Gør |
|---|---|
| `npm run dev` | Lokal udviklingsserver |
| `npm run deploy` | Udgiver Workeren (`wrangler deploy`) |
| `npm run migrate` | Kører migrations på den rigtige (remote) D1 |
| `npm run migrate:local` | Kører migrations på lokal D1 |
| `npm run typecheck` | TypeScript-tjek (`tsc --noEmit`) |
| `npm test` | Automatiske tests (se nedenfor) |
| `npm run screenshots` | Skærmbilleder med Playwright (kræver Chromium) |

**Tests** (`tests/`): Starter en lokal mock af Stripe og Resend (`tests/mock-server.mjs`), kører migrations på en midlertidig lokal D1 og starter `wrangler dev --local` med `STRIPE_API_BASE`/`RESEND_API_BASE` peget mod mocken. Mocken simulerer også Checkout, fornyelser, mislykkede betalinger og abonnementsskemaer, så `tests/offers.test.mjs` kan køre hele tilbudsforløbet uden at ramme Stripe. Testene dækker bl.a. login med engangslink, dashboard, planskift, opsigelse/genoptagelse inkl. bindingsperiode, fakturaer og kortskift, henvendelser, admin-adgang, CSRF-afvisning og webhook-signaturer (gyldig, ugyldig og for gammel).

**Projektstruktur:**

```
src/
  index.ts            Indgang: sikkerheds-headers, routes, cron-oprydning
  env.ts              Typer for bindings og databaserækker
  render.ts           Fælles side-rendering
  lib/                crypto, session/CSRF, Stripe-klient, e-mail, D1-forespørgsler, planer, formatering
  routes/             auth (login), public (bestil), account (/konto), admin, webhook
  views/              HTML-skabeloner, CSS og lidt JavaScript
migrations/           SQL til D1
tests/                Mock-server, test-harness og tests
scripts/              Skærmbillede-script
```

**Sikkerhed i korte træk:** engangslinks (15 min., gemt som SHA-256-hash, forbruges atomisk, login kræver et klik på en knap så e-mail-scannere ikke bruger linket), sessions-cookie `HttpOnly`/`Secure`/`SameSite=Lax` med `__Host-`-præfiks, CSRF-token + Origin-tjek på alle formularer, rate-limiting pr. e-mail (3/15 min.) og pr. IP (10/15 min.), samme svar uanset om e-mailen findes, parametriserede D1-forespørgsler, streng Content-Security-Policy, webhook-signatur verificeret med Web Crypto (HMAC-SHA256, 5 minutters tolerance) og idempotent hændelsesbehandling.

---

## 14. Tilbud med individuel pris og betalingslink

Bruges, når Veyro aftaler ydelse, pris og interval med en kunde og sender et tilbud.

**Forløb**

1. Admin opretter tilbuddet under **/admin/tilbud**: kunde (navn, firma, e-mail, CVR, adresse), ydelse, pris ekskl. moms, månedlig eller årlig betaling, evt. et engangsbeløb (oprettelse/udvikling) og hvor længe linket gælder.
2. Kunden og en fast pris oprettes med det samme i Stripe. Hvert tilbud får sin egen Stripe-pris, så en kundes pris aldrig påvirker andre.
3. Admin sender linket (`https://kunde.veyro.dk/tilbud/<kode>`) på mail fra admin-siden eller kopierer det ind i tilbuddet.
4. Kunden ser ydelse, pris, moms, interval, engangsbeløb, opsigelsesvilkår og gyldighed, sætter kryds og sendes til Stripe Checkout (Stripe-hostet side) for netop den kunde og pris. Beløbet kan ikke ændres via linket.
5. Når en **verificeret webhook** fra Stripe bekræfter tilmelding og første betaling, bliver tilbuddet og kunden aktive, og kunden får en velkomstmail med adgang til kundepanelet. Takkesiden efter betaling er ikke nok i sig selv.
6. Abonnementet fornyes automatisk, til kunden opsiger. Stripe sender kvittering/faktura ved hver betaling.

**Shopify og Stripe er to adskilte systemer.** Shopify (veyro.dk) modtager kun forespørgsler fra kurven og opkræver intet. Shopify Payments og Stripe Billing synkroniserer ikke, og der oprettes ingen betalingsforpligtelse i Shopify. Stripe Billing i kundepanelet er det eneste sted, abonnementet opkræves. Kunden kobles på e-mail: tilbud, Stripe-kunde og kundepanel bruger samme e-mail. Der er derfor hverken brug for en Shopify-app eller en ekstra backend.

**Tilbud, betalingsanmodning og faktura**

- *Tilbud* er rækken i kundepanelet (`offers`) og siden `/tilbud/<kode>`. Det opkræver intet.
- *Betalingsanmodning* er Stripe Checkout-sessionen, som linket åbner. Der findes højst én åben session pr. tilbud. Den udløber efter 23 timer, og linket laver så automatisk en ny.
- *Faktura* laver Stripe ved hver opkrævning (første betaling og hver fornyelse).

**Undgå dobbelt opkrævning**

- Har kunden allerede fået en faktura for engangsbeløbet, så markér det under «Allerede faktureret». Så opkræves det ikke via linket.
- Har kunden allerede betalt første periode, så angiv datoen for første opkrævning. Stripe trækker først den dag (mindst 3 dage frem).
- Feltet «Hvilken faktura dækker det?» er påkrævet i begge tilfælde, så det kan ses bagefter.
- Har kunden i forvejen et abonnement, en faktura fra de sidste 90 dage eller et åbent tilbud, skal admin bekræfte, før et nyt tilbud oprettes.
- Gentagne eller samtidige klik på linket giver samme Checkout-session. Et tilbud kan kun få ét abonnement. Opstår der alligevel et ekstra, stoppes det straks, og Veyro får en mail om at tjekke for refusion.

**Administration (/admin/kunder → kunden)**

Her vises navn, firma, e-mail, CVR og faktureringsadresse, ydelse, pris og interval, status, næste betaling og opsigelsesdato, samt betalingshistorik med fakturaer og mislykkede betalinger.

- **Prisændring** gælder kun den ene kunde. Standard er fra næste betalingsperiode uden forholdsmæssig afregning. Der kan også vælges en senere fornyelsesdato. Kunden får en mail med den nye pris og datoen.
- **Opsigelse** stopper fornyelsen ved udgangen af den betalte periode, og opsigelsen kan fortrydes.
- **Mislykket betaling:** status «Betaling fejlet» vises for admin og kunde, og Veyro får en mail. Stripe prøver automatisk igen efter indstillingerne i Stripe.

Kunden kan selv skifte kort, hente fakturaer og opsige i kundepanelet, og via Stripes kundeportal.

**Før det sættes i drift**

1. Kør migrationen `migrations/0004_offers.sql` på den rigtige database (`npm run migrate`, eller indsæt filen i D1-konsollen) **før** den nye kode udgives. Migrationen tilføjer kun kolonner og tabeller, så eksisterende data bevares.
2. Tilføj de nye hændelser til webhooken (se [afsnit 8](#8-stripe-webhook)).
3. Stripe → **Indstillinger → Billing → Kundeportal**: slå «Kunder kan opsige abonnementer» til med «Ved periodens udløb» og uden forholdsmæssig afregning. Lad fakturahistorik og opdatering af betalingsmetoder være slået til.
4. Stripe → **Indstillinger → Kundemails**: slå mails om gennemførte og mislykkede betalinger til. Under **Billing → Revenue recovery** kan automatiske genforsøg (Smart Retries) indstilles.
5. Afprøv hele forløbet i Stripes testtilstand med testkort `4242 4242 4242 4242` (godkendt) og `4000 0000 0000 0341` (afvises ved senere betalinger). Fornyelser kan afprøves uden at vente med Stripes *test clocks*.

**Rul tilbage:** Udgiv den forrige version i Cloudflare (**Workers → veyro → Deployments → Rollback**). De nye tabeller og kolonner kan blive stående. Den gamle kode bruger dem ikke.

## 15. Hjemmesiden veyro.dk uden Shopify

Salgshjemmesiden kører nu i samme Worker som kundepanelet. Domænet afgør, hvad der vises: `kunde.veyro.dk` er kundepanelet, og domænerne i `SITE_HOSTS` (`veyro.dk`, `www.veyro.dk`, `ny.veyro.dk`) er hjemmesiden. `www` sendes videre til `veyro.dk`.

**Indhold.** Temaet er det samme som i Shopify (flyttet til `site/theme`) og gengives med Liquid i Workeren. Standardindholdet (sider, menuer, abonnementer, juridiske tekster) ligger i `site/content.json`. Alt, der rettes i admin, gemmes i D1 (`site_content`), og den tidligere version lægges i `site_content_history`, så alt kan gendannes. Efter ændringer i `site/` køres `npm run build:site`, som pakker temaet ind i `src/site/theme.generated.ts` (testene fejler, hvis den er glemt).

**Admin** (`kunde.veyro.dk/admin`):

| Side | Hvad |
| --- | --- |
| Hjemmeside | Overblik med besøg (uden cookies), forespørgsler, sider og seneste ændringer |
| Sektioner | Alle tekster og elementer på hver side, sidehoved, sidefod, kurv, abonnements- og fejlside. Skjul, flyt, slet og tilføj sektioner og elementer |
| Sider | Ret titel, Google-beskrivelse, tekst og synlighed; opret nye tekst- eller sektionssider; slet |
| Menuer | Hovedmenu, sidefod og juridiske links |
| Abonnementer og priser | Det, der kan lægges i kurven (pris, interval, synlighed, beskrivelse) |
| Temaindstillinger | Firmaoplysninger, farver, skrift, cookiebanner, Trustpilot, SEO |
| Billeder | Upload PNG/JPG/WebP/GIF (højst 1,5 MB) til logo og sektioner |
| Historik | Alle ændringer; „Gendan" ruller tilbage |
| Forespørgsler | Alt fra kontaktformularen, gratis vurdering og kurven. Status, note, slet, og „Opret tilbud med betalingslink", der udfylder tilbuddet ud fra kurven |

**Kurv og formularer.** Kurven gemmes i en nødvendig cookie (`veyro_cart`) og sendes som en forespørgsel; der betales aldrig på hjemmesiden. Formularer beskyttes af en Origin-kontrol, en skjult honningkrukke og en grænse på 8 pr. time pr. IP. Hver forespørgsel gemmes i `leads` og sendes som mail til `NOTIFY_EMAIL` med kundens adresse som svar-til. Forespørgsler, der ikke førte til tilbud eller kunde, slettes automatisk efter 12 måneder (privatlivspolitikken).

**Sikkerhed og hastighed.** Hjemmesiden har sin egen CSP med nonce på alle scripts; Trustpilots widget indlæses kun efter samtykke. Færdige sider gemmes pr. indholdsversion (i hukommelsen og i `site_cache`), så de kun gengives igen efter en ændring.

### Statistik og Excel

**Admin › Statistik** (`/admin/statistik`) viser sidevisninger, forespørgsler, konvertering, betalt omsætning, sendte tilbud, nye kunder, aktive abonnementer og fast månedlig omsætning for en periode (7/30/90 dage, 12 måneder eller en kalendermåned), med ændringen i forhold til perioden før og grafer pr. dag. Omsætningen hentes direkte fra Stripe (betalte fakturaer efter betalingsdato); svarer Stripe ikke, bruges kundepanelets egne betalinger. **Download Excel** giver en .xlsx-fil for perioden med arkene Oversigt, Pr. dag, Sider, Forespørgsler, Tilbud, Betalinger og Nye kunder (`src/lib/stats.ts`, `src/lib/xlsx.ts`).

### Flytning fra Shopify (rækkefølge)

1. Flet pull requesten, og kør derefter **Actions › Deploy kundepanel › Run workflow** på GitHub. Den opretter migrationsloggen, hvis den mangler (produktionsdatabasen blev oprettet uden, så `npm run migrate` stopper ved 0001), kører de manglende migrationer (0004 og 0005, kun nye kolonner og tabeller), udruller koden og tjekker siderne. Loggen viser et D1 Time Travel-bogmærke fra før migrationerne til en eventuel tilbagerulning.
2. `ny.veyro.dk` oprettes ved udrulningen som prøveadresse (den er skjult for søgemaskiner). Shopify kører videre uændret på `veyro.dk`.
3. Gennemgå siden på `https://ny.veyro.dk`, send en test-forespørgsel, og ret indhold i admin.
4. **Domæneskiftet (kræver jeres godkendelse):** Kør **Actions › Skift domæne** med `skift`. Workflowet viser og gemmer først alle DNS-poster (som fil på kørslen), sletter derefter kun A/AAAA/CNAME-posterne for `veyro.dk` og `www`, der peger på Shopify, og udruller, så Workeren overtager begge adresser (de står i `routes` i `wrangler.toml`). **MX-, SPF-, DKIM- og andre mailposter røres ikke.** Til sidst tjekkes, at veyro.dk svarer fra den nye side, og at www sendes videre. `vis` viser kun posterne. **Tilbagerulning:** kør workflowet med `tilbage` (fjerner Workerens veyro.dk/www og genskaber Shopifys poster A `23.227.38.65` og CNAME `shops.myshopify.com`), og fjern de to adresser fra `routes`. Vent med at opsige Shopify, til veyro.dk har kørt stabilt.
5. Tjek `https://veyro.dk`, en formular og kurven. Indsend `https://veyro.dk/sitemap.xml` i Google Search Console.
6. Først når alt virker: fjern domænet i Shopify og opsig Shopify-abonnementet. Gem gerne en eksport af temaet først (det ligger også i `shopify-theme/`).

**Rul tilbage:** Indhold rulles tilbage under Admin › Hjemmeside › Historik. Selve domæneskiftet rulles tilbage ved at fjerne `veyro.dk`/`www.veyro.dk` fra routes og genskabe Shopifys to DNS-poster; så viser Shopify-temaet siden igen, så længe Shopify-abonnementet ikke er opsagt.

## 16. Digitale fuldmagter

Kunder kan give Veyro fuldmagt under **Aftaler og dokumenter** i kundepanelet, og Veyro administrerer dem i admin under **Fuldmagter**.
Opsætning, forløb, sikkerhed og opbevaringspolitik er beskrevet i [docs/FULDMAGTER.md](docs/FULDMAGTER.md).
Funktionen er et udkast: den er kun åben for pilotkunder, indtil teksten, godkendelsesmetoden og politikken er godkendt i admin.

## 17. Kunder: opsætning og publicering af hjemmesider

Nye kunder oprettes i admin under **Kunder**: virksomhed, projekttype, udseende og indhold, tjenester, opsætning og
gennemgang, derefter forhåndsvisning, godkendelse og publicering. Arkitektur, vejledningen "Sådan tilføjer jeg næste
kunde", engangsopsætning (Cloudflare-nøgle, udrulning fra admin) og tests står i
[docs/KUNDEOPSAETNING.md](docs/KUNDEOPSAETNING.md).
