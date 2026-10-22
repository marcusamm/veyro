# Kundeopsætning og publicering af hjemmesider

Admin › **Kunder** (`kunde.veyro.dk/admin/virksomheder`) er stedet, hvor en ny kunde oprettes, får sin hjemmeside og sine
tjenester, og hvor siden forhåndsvises, godkendes og publiceres. Rutinearbejde kræver ingen kodeændringer, ingen
kopierede databaserækker og ingen nye miljøvariabler pr. kunde.

Indhold:

1. [Arkitektur](#1-arkitektur)
2. [Sådan tilføjer jeg næste kunde](#2-sådan-tilføjer-jeg-næste-kunde)
3. [Daglig drift](#3-daglig-drift)
4. [Engangsopsætning](#4-engangsopsætning)
5. [Hvad er engangsarbejde, hvad er pr. kunde, og hvad er specialarbejde](#5-engangsarbejde-arbejde-pr-kunde-og-specialarbejde)
6. [Sikkerhed og adskillelse](#6-sikkerhed-og-adskillelse)
7. [Tests](#7-tests)
8. [Begrænsninger](#8-begrænsninger)

---

## 1. Arkitektur

Alt bygger på det, der allerede findes: Cloudflare Workers, D1, magic-link-login, Resend og workflowet "Deploy kunder".

| Del | Hvor | Hvad |
|---|---|---|
| Virksomheder og projekter | `veyro`-Workeren, D1 `veyro-kundepanel`, migration `0009_kundeopsaetning.sql` (kun nye tabeller) | En virksomhed (`v_…`) kan have flere projekter (`p_…`). Interne oplysninger (CVR, kontaktperson, intern note) holdes adskilt fra de oplysninger, hjemmesiden viser. |
| Hjemmesider fra et startpunkt | Samme Worker (`src/kunder/`) | Hjemmesiden er en kladde (JSON). "Godkend denne version" låser kladden som en uforanderlig version med en hash. "Publicér" skifter den aktive version i én databaseoperation. Siderne gengives som ren HTML uden JavaScript. |
| Adresser | Samme Worker | `kunde.veyro.dk/s/<adresse>/` (publiceret, ikke indekseret), `kunde.veyro.dk/vis/<token>/` (forhåndsvisning, udløber), `<adresse>.veyro.dk` og kundens eget domæne (når de er verificeret). |
| Domæner | Cloudflare API | Domæner i Veyros Cloudflare-konto (fx `<adresse>.veyro.dk`) bindes som Workers Custom Domain. Domæner med DNS andre steder sættes op med Cloudflare for SaaS, og kunden får de DNS-poster, Cloudflare returnerer. |
| Tilsluttede specialbyggede sider | Kundens egen udrulning | Veyro bygger eller ændrer dem ikke. De får en offentlig nøgle (`pk_…`), en formular-adresse og en offentlig konfiguration (`/api/kundeside/<nøgle>/…`). |
| Kontaktformular | Samme Worker, tabel `project_leads` | Henvendelser gemmes pr. projekt og sendes til kundens modtagere med Resend. Fra forhåndsvisningen gemmes de som test og sendes ikke. |
| Kundebestilling med lager, intern lagerstyring | Én Worker og én D1-database pr. kunde (`varebestilling/`, `lagerstyring/`) | Udrulles som hidtil af "Deploy kunder". Workflowet henter nu også kunder fra admin (`/api/provisionering`) og melder status tilbage. |
| Kundepanel | `kunde.veyro.dk/konto/hjemmeside` | Kundens brugere (inviteret med engangslink) ser deres egne hjemmesider, tjenester og henvendelser. |
| Betaling | Tilbud/Stripe (uændret) | Helt adskilt. At slå en tjeneste til opretter aldrig et abonnement eller ændrer en pris. |

### Publiceringsforløbet

1. **Tjek og bygning** (ændrer intet): oplysninger, sider, Google-beskrivelser, `[[pladsholdere]]`, eksempeltekst, links, bygning af alle sider, billeder, kontaktformular, bestilling, tjenester, hemmeligheder og interne noter.
2. **Version aktiveret**: den godkendte version bliver den aktive i én databaseoperation.
3. **Kontrol af den publicerede side**: siden hentes gennem samme kode, som besøgende rammer. Svarer den forkert, bliver den tidligere version automatisk aktiv igen.
4. **Domæner** sættes op eller kontrolleres. Det blokerer ikke publiceringen.

En lås i databasen gør, at to klik på "Publicér" kun giver én publicering. Fejler et trin, står den tidligere version urørt.

### Publiceringsstatus (som vist i oversigten)

| Status | Betyder |
|---|---|
| Forhåndsvisning tilgængelig | Kladden kan ses på et `/vis/`-link. Intet er publiceret. |
| Udrullet (kunde.veyro.dk/s/…) | Publiceret og kontrolleret på den faste adresse. Intet domæne er verificeret endnu. |
| Live på veyro.dk-underdomæne | `<adresse>.veyro.dk` er bekræftet af Cloudflare, DNS svarer, og HTTPS viser netop dette projekt. |
| Udrullet · eget domæne afventer opsætning / Live på veyro.dk · eget domæne afventer | Kundens domæne er tilføjet, men ikke verificeret. |
| Live på verificeret eget domæne | Kundens eget domæne er verificeret på samme måde. |

Et domæne markeres **aldrig** som live, før alle tre kontroller er bestået. Statussen "Kræver engangsopsætning" betyder, at Cloudflare-nøglen ikke er sat (afsnit 4).

---

## 2. Sådan tilføjer jeg næste kunde

Log ind på `kunde.veyro.dk/admin` og vælg **Kunder** i menuen. Alt gemmes undervejs; oversigten viser i kolonnen
"Næste skridt", hvor du slap (fx "Fortsæt opsætningen: Udseende og indhold").

**A. Virksomhed.** Klik **Opret kunde**. Udfyld navn (og CVR, hvis det findes). Kontaktperson, e-mail, telefon og
adresse er interne; den interne note vises aldrig på hjemmesiden. Findes virksomheden allerede (samme CVR, navn eller
e-mail), vises den med knappen **Brug denne virksomhed**. Samme CVR kan ikke oprettes to gange.

**B. Projekttype.** Vælg én:
- *Ny hjemmeside ud fra et startpunkt.* Vælg startpunktet "Håndværk og service", "Butik med bestilling" eller
  "Rådgivning og kontor". Teknisk adresse (fx `bageriet`) bliver `bageriet.veyro.dk` og navnet på kundens systemer.
- *Tilslut en færdig, specialbygget hjemmeside.* Angiv sidens https-adresse. Veyro bygger, kopierer eller
  overskriver aldrig siden; den forbindes kun til formular og tjenester.
- *Kun interne systemer, ingen offentlig hjemmeside.*

**C. Udseende og indhold** (kun startpunkt). Vælg layout, farver og skrift, upload logo og billeder, og udfyld
"Oplysninger på hjemmesiden" (det eneste, der vises offentligt). Ret hver side under **Sider**: tekster, sektioner,
knapper og Google-titel/-beskrivelse. Al tekst i `[[dobbelte klammer]]` skal erstattes af kundens egen tekst; siden
kan ikke publiceres, så længe der står pladsholdere, eksempeltekst eller manglende billeder. Klik **Gem og fortsæt**.

**D. Tjenester.** Sæt kryds ved de tjenester, kunden skal have. Kun tjenester, der findes i dag, kan vælges; afhængigheder
står under hver tjeneste. "Onlinebetaling i bestillingen" og "Bogføringsintegration" står under *Ikke tilgængelige
endnu*. Klik **Gem og fortsæt**.

**E. Opsætning af tjenester.** Kun de valgte tjenester vises.
- *Kontakt- og tilbudsformular:* hvem henvendelser sendes til.
- *Kundebestilling med lager:* ejerens e-mail (første login), afhentning/levering, leveringsgebyr, hvem der får besked
  om ordrer. Upload evt. et startkatalog: hent **eksempel-vareliste.csv**, udfyld den, og klik **Vis forhåndsvisning**.
  Forhåndsvisningen viser hver vare (opret/opdater) og fejl med linjenummer; intet gemmes, før du klikker
  **Gem startkatalog**. Erstatter du et gemt katalog, skal du sætte kryds for at bekræfte.
- *Intern lagerstyring:* ejerens e-mail.
- *Kundepanel:* e-mails hos kunden, der skal kunne logge ind. De får et engangslink (ingen adgangskoder).
- Klik **Udrul tjenester** for bestilling og lager. Det starter "Deploy kunder" for netop denne kunde. Status skifter fra
  "Afventer udrulning" til "Forbundet" (med adresse), eller til "Blokeret" med fejlen. Klik igen for at prøve igen;
  udrulningen opretter aldrig dubletter.

**F. Gennemgang.** Opsummering, tjek med "Ret"-link til det rette trin, og hvad publicering gør.
1. Klik **Forhåndsvisning** og se siden. Vil kunden se den, så klik **Opret kundelink** og send linket (gælder 14
   dage og kan tilbagekaldes med **Tilbagekald**).
2. Klik **Godkend denne version**. Godkendelsen gælder præcis dette indhold; senere ændringer forbliver kladde.
3. Klik **Publicér version N**. Siden er derefter på `kunde.veyro.dk/s/<adresse>/`.
4. Under **Domæner**: klik **Tilføj <adresse>.veyro.dk** og/eller skriv kundens domæne og klik **Tilføj eget domæne**.
   Ved eget domæne vises de nøjagtige DNS-poster, kunden (eller deres DNS-udbyder) skal oprette. Klik **Tjek igen**,
   når de er oprettet. Mail-poster og navneservere røres aldrig.
5. Under virksomheden: **Send invitation** til kundens brugere, hvis det ikke skete i trin E.

Til en tilsluttet side: kopiér formular-koden under "Integration" ind i kundens egen side og udrul den dér. Gennemgangen
viser, om siden svarer, og om den bruger formular-adressen.

---

## 3. Daglig drift

- **Ret indhold:** ret kladden, klik **Forhåndsvisning**, **Godkend denne version** og **Publicér version N**. Den
  publicerede side ændres først ved publicering.
- **Rul tilbage:** under "Versioner og publiceringer" › **Rul tilbage hertil**. Kun indholdet rulles tilbage; henvendelser,
  ordrer og lager ændres ikke.
- **Seneste aktivitet:** på virksomhedens side (hvem, hvad og hvornår).
- **Åbn siden:** "Åbn publiceret side" og "Åbn <domæne>" på projektet. Bestilling og lager åbnes fra deres adresser under
  Tjenester.
- **Tag siden offline:** viser "midlertidigt utilgængelig", intet slettes. **Sæt online igen** gendanner den.
- **Slå en tjeneste fra:** fjern krydset under Tjenester. Opsætning og data bevares.
- **Brug som startpunkt:** opretter et nyt projekt hos en anden virksomhed med samme layout, farver og sidestruktur.
  Tekster, billeder, logo, kontaktoplysninger, henvendelser, domæner og brugere kopieres ikke.
- **Fjern domæne:** fjerner kun Veyros binding hos Cloudflare.
- Opsigelse, betaling og fakturaer håndteres som før under Tilbud og Abonnementer. Sletning af en kunde er bevidst ikke en
  knap i denne del af admin.

---

## 4. Engangsopsætning

Uden disse trin virker oprettelse, indhold, forhåndsvisning, godkendelse og publicering på `kunde.veyro.dk/s/…`.
Domæner står som "Kræver engangsopsætning", og "Udrul tjenester" viser det manuelle trin.

1. **Database:** migration `0009_kundeopsaetning.sql` køres af workflowet "Deploy kundepanel" (Actions › Deploy
   kundepanel › Run workflow) før eller sammen med udrulningen. Den opretter kun nye tabeller.
   Varebestillingens `0004_order_key.sql` køres automatisk af "Deploy kunder" for hver kunde.
2. **Domæner (`CF_API_TOKEN`):** opret en API-token i Cloudflare (My Profile › API Tokens) med
   *Account › Workers Scripts: Edit*, *Zone › Workers Routes: Edit*, *Zone › Zone: Read* og, hvis Cloudflare for SaaS
   bruges, *Zone › SSL and Certificates: Edit* på zonen `veyro.dk`. Sæt den som secret:
   `npx wrangler secret put CF_API_TOKEN` (Worker `veyro`).
3. **Kundernes egne domæner med DNS uden for Veyros konto (valgfrit):** slå Cloudflare for SaaS til på zonen
   `veyro.dk`, opret et fallback-origin (fx `kunder.veyro.dk`, proxied), og tilføj en Worker-route `*/*` til
   `veyro` på zonen. Sæt derefter `KUNDESIDE_SAAS_CNAME = "kunder.veyro.dk"` under `[vars]` i `wrangler.toml`.
   Uden dette kan kundedomæner kun bruges, hvis domænets DNS flyttes til Veyros Cloudflare-konto.
4. **Udrulning fra admin:**
   - Lav en lang tilfældig nøgle (mindst 32 tegn), og sæt den både som secret `PROVISIONERING_TOKEN` på Workeren
     `veyro` og som GitHub-secret `VEYRO_PROVISIONERING_TOKEN`.
   - Sæt GitHub-variablen `VEYRO_PROVISIONERING_URL = https://kunde.veyro.dk`.
   - Opret en fine-grained GitHub-token med adgang til `marcusamm/veyro` og *Actions: Read and write*, og sæt den som
     secret `GITHUB_DISPATCH_TOKEN` på Workeren. Uden den virker alt, men "Deploy kunder" skal startes manuelt med
     kundens adresse.

Øvrige indstillinger har fornuftige standarder: `KUNDESIDE_DOMAENE` (`veyro.dk`), `CF_WORKER_NAME` (`veyro`),
`GITHUB_REPO` (`marcusamm/veyro`). `CF_API_BASE`, `GITHUB_API_BASE`, `DOH_URL` og `DOMAIN_CHECK_ORIGIN` bruges kun i
tests og må ikke sættes i produktion.

---

## 5. Engangsarbejde, arbejde pr. kunde og specialarbejde

| Engangsarbejde (én gang) | Pr. kunde (i admin, ingen kode) | Specialarbejde (udvikling) |
|---|---|---|
| Migration 0009 og udrulning af denne ændring | Opret kunde, vælg projekttype og startpunkt | Nye startpunkter, sektionstyper eller layouts |
| `CF_API_TOKEN` | Udseende, tekster, billeder, sider, Google-tekster | En specialbygget hjemmeside (bygges og udrulles for sig og tilsluttes bagefter) |
| Cloudflare for SaaS + `KUNDESIDE_SAAS_CNAME` (kun til eksterne domæner) | Vælg og sæt tjenester op, startkatalog | Nye tjenester (fx onlinebetaling, bogføring) |
| `PROVISIONERING_TOKEN`, `VEYRO_PROVISIONERING_*`, `GITHUB_DISPATCH_TOKEN` | Forhåndsvisning, kundelink, godkendelse, publicering | Import af en eksisterende side ind i Veyro (findes ikke) |
| | Domæner (kunden opretter selv DNS-posterne hos sin udbyder) | |
| | Invitation af kundens brugere | |
| | Aftale om pris via Tilbud | |

---

## 6. Sikkerhed og adskillelse

- Alle admin-adresser indeholder både virksomhedens og projektets id, og begge tjekkes mod databasen. Versioner,
  billeder, domæner og links slås altid op sammen med projektets id.
- Kundens brugere får adgang via `company_members` på serveren. Et id i adressen giver ikke adgang i sig selv.
- Hjemmesiden får kun offentlige oplysninger. Ingen nøgler ligger i hjemmesidens kode; formularer fra tilsluttede sider
  accepteres kun fra sidens egen adresse, og nøglen (`pk_…`) giver kun lov til at aflevere en henvendelse.
- Forhåndsvisningen kan ikke bestille (knappen er slået fra), og formularer gemmes som test uden e-mail.
- Udrulningens API kræver `PROVISIONERING_TOKEN` (sammenlignet i konstant tid) og udleverer kun kunder, hvor udrulning er
  bestilt. Kopi af en anden kundes varer, ordrer, lager, brugere eller domæner sker aldrig.
- Kundelinks og login-links gemmes kun som hash. Loggen indeholder handling, aktør og tidspunkt, men ingen nøgler; e-mails
  maskeres.
- `<adresse>.veyro.dk` er hjemmesidens adresse. Kunder oprettet i admin får derfor lagerstyringen på
  `<adresse>-lager.veyro.dk` og bestillingen på `<adresse>-bestilling.veyro.dk`. Kunderne i `kunder/*.json` (fx Einar
  Kornerup på `ek.veyro.dk`) er uændrede, og deres adresser er reserveret.

---

## 7. Tests

Kør `npm test` i roden (og i `varebestilling/` og `lagerstyring/`). Alle tests bruger syntetiske kunder og en lokal
`wrangler dev` med en midlertidig database. Cloudflare, DNS, HTTPS-kontrol, GitHub, Stripe og Resend er simuleret i
`tests/mock-server.mjs`.

- `tests/kunder.test.mjs`: scenarie A (kun hjemmeside), B (hjemmeside med bestilling og lager) og C (tilsluttet
  specialbygget side), samt dubletter, genoptagelse, manglende opsætning, fejlet publicering med bevaret version og
  genforsøg, dobbeltklik, kladde efter publicering, tilbagerulning, domæner (veyro.dk og eget), fejlet udrulning og
  genforsøg, adgang på tværs af kunder, kundepanel, "Brug som startpunkt" og log uden nøgler.
- `tests/kunder-uden-opsaetning.test.mjs`: uden engangsopsætning (domæner blokeret, manuelt udrulningstrin) og regler.
- `varebestilling/tests/opsaetning.test.mjs`: startkatalog og bestillingsregler fra admin, gen-udrulning overskriver ikke
  kundens egne ændringer, og samme bestilling sendt flere gange giver én ordre og ét lagertræk.

Det, der **ikke** er testet mod de rigtige tjenester: Cloudflares API, rigtig DNS og certifikater samt selve
`wrangler deploy` af kundesystemer. De er testet mod simulationer, der følger Cloudflares og GitHubs svarformat.

---

## 8. Begrænsninger

- Kundens eget domæne kræver enten DNS i Veyros Cloudflare-konto eller Cloudflare for SaaS (afsnit 4, trin 3).
- Startkataloget lægges kun ind ved første udrulning. Senere vareændringer laves i bestillingssystemets egen import.
- Onlinebetaling i bestillingen og bogføringsintegration findes ikke.
- En eksisterende side kan ikke importeres; den kan kun tilsluttes.
