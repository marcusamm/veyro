# Veyro kundepanel (kunde.veyro.dk)

Selvbetjening til Veyros abonnementskunder. Kunderne kan:

- logge ind uden adgangskode (engangslink på e-mail)
- se deres plan, status, næste betaling og startdato
- skifte plan (op- eller nedgradere) med forholdsmæssig afregning
- opsige til udgangen af perioden og fortryde en opsigelse (med valgfri bindingsperiode)
- se og downloade fakturaer og skifte betalingskort
- sende ændringsønsker, fejlmeldinger og spørgsmål og følge status

Der er også en lille admin-del (`/admin`), hvor Veyro kan se kunder og henvendelser og ændre status.

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
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
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

Afsender er `Veyro <kontakt@veyro.dk>` (kan ændres med `EMAIL_FROM`). Nye ordrer (gennemført checkout) og nye henvendelser sendes til `NOTIFY_EMAIL` (standard `salg@veyro.dk`) med kundens e-mail som "svar til".

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
| `NOTIFY_EMAIL` | `salg@veyro.dk` | Modtager af notifikationer om nye ordrer og henvendelser. |
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

**Tests** (`tests/`): Starter en lokal mock af Stripe og Resend (`tests/mock-server.mjs`), kører migrations på en midlertidig lokal D1 og starter `wrangler dev --local` med `STRIPE_API_BASE`/`RESEND_API_BASE` peget mod mocken. Testene dækker bl.a. login med engangslink, dashboard, planskift, opsigelse/genoptagelse inkl. bindingsperiode, fakturaer og kortskift, henvendelser, admin-adgang, CSRF-afvisning og webhook-signaturer (gyldig, ugyldig og for gammel).

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
