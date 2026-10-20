# Varebestilling – skabelon

En færdig skabelon til et bestillingssystem, som kan sættes op for en ny kunde i en hvilken som helst branche, når vi har fået kundens vareliste. Den har intet med Veyros egen hjemmeside eller kundepanel at gøre: hver kunde får sin egen kopi, sin egen database og sit eget domæne (fx `bestil.kundensdomæne.dk`), og navn, farve og tekster er kundens egne.

Udseendet følger designsystemet på veyro.dk (Inter Tight, varm off-white og én signalfarve, som kunden selv kan vælge), og administrationspanelet er bygget som eksemplet på hjemmesiden: ordreoversigt med kilde, lagerstatus med lager, reserveret og disponibel, advarsler og seneste ændringer.

**Webshop (for kundens kunder)**

- Bestillingsark: alle varer i én tabel ligesom et regneark. Kunden skriver antal ud for hver vare, ser beløb pr. linje og i alt med det samme og bestiller det hele med én knap. Enter og piletaster flytter mellem felterne, og søgningen filtrerer listen uden at miste det indtastede
- Varer vist pr. kategori med pris pr. enhed og lagerstatus (På lager / Få på lager / Udsolgt)
- Kurv og kasse med afhentning og/eller levering, leveringsgebyr, gratis levering over et beløb og mindste ordre
- Man kan aldrig bestille mere, end der er på lager
- Kvittering på skærmen og på e-mail, og en side hvor kunden kan følge sin bestilling
- "Bestil det samme igen" fra kvitteringen
- **App på telefonen:** kan lægges på hjemmeskærmen (iPhone og Android) og åbner som en app med butikkens ikon og farve. Vejledning på `/app`. Der skal ikke noget i App Store eller Google Play
- Virker uden JavaScript og på mobil

**Admin (`/admin`, kræver login)**

- Oversigt: ordreoversigt pr. status med kilde, lagerstatus (lager, reserveret, disponibel), advarsler og genbestilling, seneste ændringer og omsætning
- **Ny ordre:** medarbejdere opretter ordrer fra telefon, e-mail eller direkte salg i samme bestillingsark. De lander i samme oversigt og lager og kan bekræftes med det samme
- Ordrer med filter på status og søgning; ordredetaljer med kunde, kilde, varer, historik og intern note
- Status: Ny → Bekræftet → Klar / afsendt → Afsluttet (eller Annulleret). Kunden får e-mail ved bekræftelse, når ordren er klar, og ved annullering
- Varer: opret, ret, skjul og slet; varenummer (SKU), kategori, pris, enhed, beskrivelse, billede
- Lager: automatisk lagertræk ved bekræftelse (præcis én gang pr. ordre), varer lægges tilbage ved annullering, manuel regulering (læg til / sæt til efter optælling) med årsag
- **Genbestilling ud fra salgsdata:** sikkerhedslager og genbestillingspunkt beregnes automatisk pr. vare ud fra salget og leverandørens leveringstid. Systemet viser, hvornår hver vare senest skal bestilles hjem, og hvor mange, og varsler på e-mail i god tid (se [Genbestilling](#genbestilling))
- Advarsel i admin og på e-mail, når en vare krydser genbestillingspunktet
- Administrationspanelet kan også lægges på telefonens hjemmeskærm (`/admin/app`) med genveje til Ny ordre og Genbestilling
- Fuld lagerhistorik: hvem ændrede hvad, hvornår og hvorfor
- Import af vareliste fra CSV (Excel, Google Sheets, kassesystem) med forhåndsvisning, og eksport til CSV
- Indstillinger for butikkens navn, farve, kontaktoplysninger, levering, automatisk bekræftelse og links til betingelser

Teknik: Cloudflare Workers + D1 (database), Hono og Resend til e-mail – samme opbygning som Veyros kundepanel. Der er ingen onlinebetaling; kunden betaler ved afhentning, levering eller på faktura. (Stripe kan bygges på senere, hvis en kunde har brug for det.)

Skærmbilleder: kør `npm run screenshots` (se [Udvikling](#udvikling-og-tests)).

---

## Sådan fungerer lageret

| Hvad sker der | Lagertal | Kan bestilles |
|---|---|---|
| Kunden bestiller (ordren er **Ny**) | Uændret | Varerne er **reserveret**, så andre ikke kan bestille dem |
| Ordren **bekræftes** (eller springer direkte til Klar/Afsluttet) | Trækkes | – |
| Ordren skifter mellem Bekræftet, Klar og Afsluttet | Uændret (trækkes aldrig to gange) | – |
| En bekræftet ordre **annulleres** | Lægges tilbage | – |
| En ny ordre annulleres | Uændret | Reservationen frigives |

- Lageret kan aldrig blive negativt. Er der ikke nok på lager, når en ordre bekræftes, afvises det, og intet ændres. Admin får at vide, hvilke varer der mangler.
- Med **Bekræft ordrer automatisk** (Indstillinger) trækkes lageret, i samme øjeblik kunden bestiller. Bliver en vare udsolgt, mens kunden står i kassen, oprettes ordren ikke, og kunden bliver bedt om at rette kurven.
- Varer uden **lagerstyring** (fx ydelser) kan altid bestilles.
- Afsluttede ordrer er låst. Annullerede ordrer kan genåbnes som nye.

## Genbestilling

For hver vare med lagerstyring tælles det solgte antal pr. dag (alle ordrer, der ikke er annulleret, uanset kilde) over de seneste 90 dage (kan ændres). Dage uden salg tæller med som 0.

| Tal | Beregning |
|---|---|
| Salg pr. dag | Gennemsnit over perioden (nye varer: kun dagene siden de blev oprettet) |
| Sikkerhedslager | z × standardafvigelsen på dagligt salg × √leveringstid. z = 1,65 ved 95 % sikkerhed mod udsolgt (90 / 95 / 98 / 99 % kan vælges) |
| Genbestillingspunkt | Salg pr. dag × leveringstid + sikkerhedslager |
| Bestil senest | Den dag det disponible lager (lager minus reserveret) forventes at nå genbestillingspunktet |
| Foreslået antal | Dækker leveringstiden og 30 dages salg oven i sikkerhedslageret |

- Leveringstiden er en standard under Indstillinger og kan ændres pr. vare.
- Skriver man et fast tal i varens felt *Genbestillingspunkt*, bruges det i stedet. Varer med under 14 dages historik eller uden salg bruger standardgrænsen.
- Tallene genberegnes hver nat (cron) og, når de er mere end 6 timer gamle, ved visning af oversigten, varer og genbestilling.
- Hver nat sendes én samlet e-mail med de varer, der er kommet inden for varslingsperioden (standard 7 dage før genbestillingspunktet), eller som allerede er under det. En vare varsles kun én gang, til lageret igen er i god tid. Knappen *Beregn igen og send varsel* på `/admin/genbestilling` gør det samme med det samme.

---

## Opsætning for en ny kunde

Du skal bruge adgang til **Cloudflare** (den konto, hvor kundens domæne ligger, eller Veyros egen), **GitHub** og **Resend**. Regn med ca. en halv time.

### 1. Kopiér skabelonen

Lav et nyt **privat** GitHub-repository til kunden (fx `veyro/bageriet-bestilling`) og kopiér indholdet af denne mappe (`varebestilling/`) ind i roden af det. Skabelonen selv i Veyros repository skal ikke ændres.

### 2. Database (D1)

**Dashboard:** Workers & Pages → **D1 SQL Database → Create** → navn fx `bageriet-bestilling` → **Create**. Kopiér **Database ID**.

**Eller kommandolinje:**

```bash
npm install
npx wrangler login
npx wrangler d1 create bageriet-bestilling
```

### 3. Ret `wrangler.toml`

Alle steder markeret med `UDFYLD`:

| Felt | Eksempel |
|---|---|
| `name` | `bageriet-bestilling` (små bogstaver og bindestreger) |
| `database_name` / `database_id` | Fra trin 2 |
| `APP_URL` | `https://bestil.bageriet.dk` (uden / til sidst) |
| `ADMIN_EMAILS` | De medarbejdere, der må logge ind, kommasepareret: `ejer@bageriet.dk,butik@bageriet.dk` |
| `EMAIL_FROM` | `Bageriet <ordre@bageriet.dk>` (domænet skal være verificeret i Resend, trin 5) |
| `routes` | Fjern `#` og indsæt kundens domæne, når det er klar (trin 6) |

Opret tabellerne i databasen:

```bash
npm run migrate
```

(Eller i dashboardet: åbn databasen → **Console**, og kør indholdet af `migrations/0001_initial.sql`.)

### 4. Udgiv via GitHub (Workers Builds)

1. Cloudflare: **Workers & Pages → Create → Workers → Import a repository**, og vælg kundens repository.
2. **Project name:** samme som `name` i `wrangler.toml`. **Build command:** tom. **Deploy command:** `npx wrangler deploy`. **Root directory:** `/`.
3. Klik **Deploy**. Hver gang der pushes til hovedgrenen, udgives en ny version automatisk.

### 5. E-mail (Resend)

1. I [Resend](https://resend.com): **Domains → Add domain** → kundens domæne, og læg DNS-posterne ind (i Cloudflare kan det gøres automatisk).
2. **API Keys → Create** (adgang: *Sending access*, kun det domæne).
3. Sæt nøglen som hemmelighed i Cloudflare: Workers & Pages → projektet → **Settings → Variables and Secrets → Add** → Type **Secret**, navn `RESEND_API_KEY`. Eller: `npx wrangler secret put RESEND_API_KEY`.

Uden nøgle virker systemet, men der sendes ingen e-mails (heller ikke login-links).

### 6. Eget domæne

Ligger kundens domæne i Cloudflare: fjern `#` ved `routes` i `wrangler.toml` med fx `bestil.bageriet.dk`, og push. Ellers: Workers & Pages → projektet → **Settings → Domains & Routes → Add → Custom domain**, og følg vejledningen (kunden skal evt. oprette en CNAME hos deres DNS-udbyder).

### 7. Indstillinger og varer

1. Gå til `https://bestil.<domæne>/admin`, skriv en e-mail fra `ADMIN_EMAILS`, og klik på linket i e-mailen.
2. **Indstillinger:** butikkens navn, overskrift og tekst, farve, kontaktoplysninger, afhentning/levering, gebyrer og links til handelsbetingelser og privatlivspolitik. Udfyld e-mail, så butikken får besked om nye ordrer.
3. **Import:** upload kundens vareliste (se nedenfor). Tjek forhåndsvisningen, og klik **Importér**.
4. Læg en testordre i webshoppen, bekræft den i admin, og tjek at lageret og e-mails passer. Annullér den bagefter.
5. Link til `https://bestil.<domæne>` fra kundens hjemmeside, fx en knap "Bestil online".

### 8. Afprøvning før lancering

- [ ] Login-link kommer frem på e-mail
- [ ] Ordrebekræftelse til kunden og besked til butikken kommer frem (tjek spam)
- [ ] Bekræft ordre → lager falder; annullér → lager stiger igen
- [ ] Prøv at bestille mere, end der er på lager → det kan ikke lade sig gøre
- [ ] Siderne ser rigtige ud på mobil
- [ ] Links til handelsbetingelser og privatlivspolitik virker

---

## Vareliste (CSV)

Første række er kolonnenavne. Kun **Varenummer** er påkrævet; nye varer skal også have **Navn** og **Pris**. Kolonner, der ikke er med i filen, bliver ikke ændret på eksisterende varer – så en fil med kun `Varenummer;Lager` opdaterer kun lagertallene.

| Kolonne | Indhold | Andre navne der virker |
|---|---|---|
| Varenummer | Unikt nummer (SKU), bogstaver, tal og `- _ . / +` | SKU, Varenr, Artikelnummer, Produktnummer |
| Navn | Varens navn | Varenavn, Produkt, Produktnavn, Titel |
| Kategori | Gruppering i webshoppen | Varegruppe, Gruppe |
| Pris | Inkl. moms: `149,95`, `1.299,00` eller `149.95` | Salgspris, Enhedspris, Pris inkl. moms |
| Lager | Antal på lager (sætter lagertallet, logges som "Import") | Antal, Beholdning, Lagerantal |
| Enhed | stk., kg, kasse, time … | |
| Beskrivelse | Tekst til kunden | Tekst |
| Billede | Link (https://) til et billede | Billede URL, Billedlink |
| Minimum | Advar ved lavt lager (tom = butikkens standard) | Minimumslager, Genbestillingspunkt |
| Aktiv | ja/nej: vis i webshoppen | Synlig, Vis |
| Lagerstyring | ja/nej: følg lager | |
| Sortering | Rækkefølge i kategorien (lavest først) | Rækkefølge |

- Separator (`;`, `,` eller tabulator) og tegnsæt (UTF-8 eller ældre Excel/Windows-1252) findes automatisk.
- I Excel: **Filer → Gem som → CSV UTF-8**. I Google Sheets: **Filer → Download → CSV**.
- Linjer med fejl springes over og vises i forhåndsvisningen med linjenummer og årsag.
- Højst 5.000 varer og 2 MB pr. import.
- `eksempel/vareliste-eksempel.csv` er et eksempel, og admin har en skabelon under **Import → Hent skabelon**. **Varer og lager → Eksportér CSV** giver en fil i samme format, som kan rettes og importeres igen.

Billeder skal ligge et sted på nettet (kundens hjemmeside, Shopify, Google Drive med offentligt link osv.). Uden billede vises varen blot uden.

---

## Indstillinger (`wrangler.toml` og hemmeligheder)

| Navn | Type | Beskrivelse |
|---|---|---|
| `APP_URL` | var | Fuld adresse, bruges i links i e-mails |
| `ADMIN_EMAILS` | var | Medarbejdere med adgang til `/admin`. Fjernes en e-mail, mister personen adgang med det samme |
| `EMAIL_FROM` | var | Afsender på e-mails |
| `DEV_MODE` | var | `1` viser login-linket på skærmen, når der ikke er en Resend-nøgle. Kun til udvikling |
| `RESEND_API_KEY` | secret | Nøgle til Resend |

Alt andet (navn, farve, levering, lager) redigeres i **/admin/indstillinger** og gemmes i databasen.

## Sikkerhed og GDPR

- Medarbejdere logger ind med engangslink på e-mail (ingen adgangskoder). Linket virker i 15 minutter og én gang; sessionen varer 90 dage.
- Alle formularer er beskyttet mod CSRF, og login og bestillinger er begrænset pr. IP-adresse mod misbrug. IP-adresser gemmes kun som hash.
- Priser og lager slås altid op på serveren; kurven indeholder kun varenumre og antal.
- Kundens kvitteringsside har en hemmelig, tilfældig adresse.
- Systemet sætter kun nødvendige cookies (kurv, sikkerhed og login) og bruger ingen sporing eller tredjeparts-scripts, så der kræves ikke cookie-samtykke.
- Der gemmes navn, e-mail, telefon, evt. firma og adresse på ordrer. Kunden (butikken) er dataansvarlig og skal nævne det i sin privatlivspolitik. Ordrer kan slettes i databasen (D1 → Console) efter bogføringslovens opbevaringsperiode.

---

## Udvikling og tests

```bash
npm install
cp .dev.vars.example .dev.vars   # ret ADMIN_EMAILS til din egen e-mail
npm run migrate:local
npm run dev                      # http://localhost:8787 og /admin
```

Uden `RESEND_API_KEY` og med `DEV_MODE=1` vises login-linket direkte på skærmen.

```bash
npm run typecheck
npm test            # unit-tests af CSV/beløb + integrationstests mod en lokal D1 og en mock af Resend
npm run screenshots # skærmbilleder (desktop og mobil) med demodata i screenshots/
```

Demodata (en fiktiv byggevarehandel med 120 dages salg, som på veyro.dk) til en demo-database. **Sletter alle varer og ordrer i databasen først:**

```bash
node scripts/demo-data.mjs demo.sql
npx wrangler d1 execute <database> --remote --file demo.sql
```

Kode:

| Fil | Indhold |
|---|---|
| `src/lib/orders.ts` | Ordreoprettelse, statusskift, lagertræk og -tilbageførsel (én transaktion pr. handling) |
| `src/lib/products.ts` | Varer, manuel regulering, lagerhistorik, import |
| `src/lib/csv.ts` | CSV-læsning, kolonnegenkendelse, validering og eksport |
| `src/lib/settings.ts` | Butikkens indstillinger (gemt i D1) |
| `src/lib/forecast.ts` | Sikkerhedslager, genbestillingspunkt og varsler ud fra salget |
| `src/views/pwa.ts`, `src/lib/icon.ts` | App på hjemmeskærmen: manifest, service worker og ikoner |
| `src/routes/shop.ts` | Webshop, kurv, kasse og kvittering |
| `src/routes/admin.ts` | Login og admin |
| `migrations/` | Databaseskema |
