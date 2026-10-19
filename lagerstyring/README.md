# Lagerstyring – skabelon

Et internt system til lagerstyring, vareforbrug på job og indkøbsplanlægning for håndværks- og servicevirksomheder. Kunderne bestiller ikke selv; systemet bruges af virksomhedens egne folk. Hver virksomhed får sin egen kopi, database og adresse (fx `lager.kundensdomæne.dk`), og udseendet følger designsystemet fra veyro.dk og varebestillingsdemoen.

Systemet har to portaler med de samme data:

**Lagerportalen** (`/lager`, ejer og indkøber)

- Oversigt med advarsler, job der afventer materialer, afvigelser og seneste bevægelser
- Varer: varenr., navn, enhed, fysisk, reserveret, disponibel, bestilt med forventet dato, dagligt forbrug, leverandør og leveringstid, sikkerhedslager, genbestillingspunkt og status
- Opret varer, ret indstillinger og registrér varemodtagelse, optælling, svind og returnering til leverandør
- Indkøbslister pr. job og en fælles liste til lageropfyldning; linjer med og uden varenummer, grupperet efter leverandør
- Bestilling hos leverandør og varemodtagelse (også delvis). Varer lægges først på lager, når de modtages
- Fakturagrundlag pr. job: ret, godkend og eksportér til CSV eller PDF (udskriv)
- Indstillinger: firma, brugere og roller, e-mail-modtagere, leverandører og e-mail-log

**Forbrugsportalen** (`/job`, alle medarbejdere, virker på mobil og tablet)

- Vælg et job og registrér forbrug eller planlæg materialer i ét ark
- Se, hvad der er disponibelt, reserveret og mangler, og følg jobbets indkøbslister (uden priser)

Teknik: Cloudflare Workers + D1, Hono og Resend til e-mail. Kan lægges på hjemmeskærmen som en app.

---

## Sådan fungerer lageret

| Handling | Fysisk | Reserveret | Disponibel |
|---|---|---|---|
| Direkte forbrug | Falder | – | Falder |
| Planlagt forbrug (det, der er disponibelt) | – | Stiger | Falder |
| Planlagt forbrug ud over lageret | – | – | Resten kommer på jobbets indkøbsliste, og jobbet afventer materialer |
| Udlevering af reserverede varer | Falder | Falder | Uændret |
| Annulleret reservation | – | Falder | Stiger |
| Retur til lager | Stiger | – | Stiger (trækkes fra jobbets forbrug) |
| Modtagelse af varer købt til et job | Stiger | Stiger (reserveret til jobbet) | Uændret |
| Levering direkte til arbejdssted | – | – | Hovedlageret røres ikke; varerne tæller som forbrug, når de registreres som brugt |

- **Aldrig negativt lager:** databasen afviser lager under 0 og reservationer over det fysiske lager. Forbrug ud over det disponible afvises med en klar besked.
- **Ingen dobbelte træk:** hver formular har en engangsnøgle, og hele registreringen gemmes i én databasebatch. Dobbeltklik, genindlæsning og tilbage-knappen registrerer aldrig noget to gange.
- **Ingen samtidig dobbeltdisponering:** to medarbejdere, der tager de sidste varer samtidig, kan ikke begge få dem; den sidste får besked om, at lageret er ændret.
- **Indkøbsbehov uden dubletter:** det, der mangler på et job, står på én automatisk linje pr. vare, som opdateres, når behovet ændres. Bestilte mængder ændres aldrig automatisk; bliver behovet mindre end det bestilte, får indkøberen en afvigelse.
- Alle bevægelser gemmes med tidspunkt, medarbejder, mængde, årsag og job (Historik, kan eksporteres til CSV).

## Sikkerhedslager og genbestillingspunkt

- Sikkerhedslager pr. vare: enten et fast antal eller dagligt forbrug × bufferdage. Det vises, hvilken metode der bruges, og der rundes op for varer i hele enheder.
- Genbestillingspunkt = dagligt forbrug × leveringstid + sikkerhedslager. Leveringstiden kan sættes på varen eller arves fra leverandøren. Alle tider er kalenderdage.
- Mangler et tal, vises "Mangler opsætning" i stedet for 0.
- Genbestillingspunktet siger hvornår, ikke hvor meget. Indkøberen godkender mængden; forslaget fylder op til maksimumbeholdningen, hvis den er sat.

| Status | Når |
|---|---|
| Normal | disponibel > genbestillingspunkt |
| Genbestilling nødvendig | disponibel ≤ genbestillingspunkt og > sikkerhedslager |
| Kritisk | disponibel ≤ sikkerhedslager og > 0 |
| Ingen disponible varer | disponibel = 0 |

Advarsler vises i lagerportalen og sendes på e-mail til de valgte modtagere. Samme behov giver ikke en ny e-mail, men en forværring gør. Advarslen bliver stående med "Genbestilling oprettet", indtil varerne er modtaget. Der sendes aldrig noget til leverandører.

## E-mail

- "Send indkøbsliste" sender listen til en valgt intern modtager. Priser kommer kun med til ejer og indkøber. Tidspunkt, modtager og listeversion gemmes, og listen viser, om den er ændret siden.
- Valgfri samlet e-mail med nye indkøbsbehov hver time, hver 4. time eller dagligt (Indstillinger).
- Afsendelse sætter aldrig noget til "Bestilt".
- Uden `RESEND_API_KEY` sendes intet: e-mails gemmes som **Simuleret, ikke sendt** i e-mail-loggen, og systemet skriver aldrig, at en e-mail er sendt, hvis den ikke er.

## Prisestimat på indkøbslister

Indkøbslisterne viser et vejledende estimat ud fra offentlige priser hos byggemarkeder og trælaster (STARK, BAUHAUS, Silvan, XL-BYG, Bygma, Davidsen og jem & fix). Der bruges aldrig kundens egne aftaler, rabatter eller priser bag login.

- **Hvor priserne kommer fra:** en officiel prisfil fra forhandleren (CSV, indlæses eller hentes fra et feed på serveren højst hver 6. time), butikkens offentlige produktsider eller en manuelt indtastet pris med link til produktsiden. Ved undersøgelsen i oktober 2026 blev der ikke fundet en offentlig API eller et offentligt produktfeed hos nogen af forhandlerne, så de starter alle som "Produktlink og manuel pris" (se Indstillinger → Forhandlere og prisfiler).
- **Læsning af produktsider:** på varens side knyttes et link til varen hos hver butik. Prisen læses automatisk kun hos butikker, hvor nogen har tjekket vilkårene og slået "Læser offentlige produktsider" til (hvem og hvornår gemmes). Butikkens robots.txt følges, siderne hentes én ad gangen på serveren højst hver 6. time (og ved "Opdatér priser"), og prisen tages kun fra sidens strukturerede produktdata (schema.org/JSON-LD eller Open Graph) i kroner. Login, CAPTCHA, 401/403/429 og adgangsbegrænsninger omgås aldrig; så vises fejlen ved linket, og der er ingen pris. En side med flere forskellige priser giver heller ingen pris. Ingen butik er afprøvet live endnu, så hver butik skal slås til, når dens vilkår er læst.
- **Match:** 1) samme EAN/GTIN, 2) producentens varenummer + mærke + variant, 3) navn og mål. Kun 1) og 2) er **Præcist match**; et navnematch er **Alternativ – kræver godkendelse** og erstatter aldrig varen på listen. Forhandlernes egne varenumre sammenlignes aldrig på tværs.
- **Mængde:** den manglende mængde omregnes til forhandlerens salgsenhed med hele pakker og mindstekøb (12 stk. i pakker á 10 til 100 kr. = 2 pakker, 20 stk., 200 kr.). Tilbud bruges kun, når betingelserne er opfyldt, og de vises.
- **Visning:** forhandler, fundet vare med link, match, pakning og foreslået køb, offentlig pris med moms, linjeestimat, kilde (Prisfil, Læst fra produktsiden, Manuelt indtastet, Demodata) og tidspunkt for pristjek. Summen er i ét momsgrundlag (valgfrit inkl. eller ekskl. moms). Den laveste sammenlignelige materialepris blandt de fundne fremhæves og bruges; fragt tælles aldrig med og står som "Fragt og eventuelle gebyrer er ikke medregnet".
- **Manglende og gamle priser:** "Pris mangler" med antal varer uden pris og summen af de kendte. Priser ældre end det valgte antal dage vises som "Tidligere pris – ikke bekræftet". En manuel pris overskrives aldrig uden accept.
- **Altid den billigste:** priserne fra alle forhandlerne sammenlignes, og den billigste sammenlignelige pris (præcist match eller godkendt alternativ) bruges altid i estimatet.
- **E-mail:** indkøbslisten til ejer og indkøber får estimatet (evt. opdelt efter forhandler), varer uden pris, prisdatoer og teksten "Vejledende prisestimat baseret på offentlige priser. Endelig pris, tilgængelighed, fragt og eventuelle rabatter bekræftes hos leverandøren."
- Prisopslag og afsendelse bestiller aldrig noget og ændrer ikke status. Estimaterne gemmes for sig selv med historik og blandes ikke med forventet pris, faktisk indkøbspris eller salgspris. En fejl hos en forhandler stopper aldrig registrering af forbrug eller lister.

Prisfilens kolonner står på siden Forhandlere og prisfiler. Demoen bruger to fiktive forhandlere med opdigtede priser, markeret **Demodata** og uden produktlinks.

## Fakturagrundlag

Grundlaget bygger på jobbets faktiske forbrug: udleveret fra lager minus returneret, brugt fra arbejdsstedet og varer uden varenummer købt til jobbet. Det, der allerede er på et godkendt grundlag, trækkes fra, så intet faktureres to gange, og en indkøbsliste bliver aldrig automatisk til en faktura. Kladden kan rettes (mængde, kostpris, salgspris, med eller ej); ved godkendelse låses mængder og priser. Salgsprisen er varens salgspris eller kostpris plus jobbets aftalte avance.

## Roller

| Rolle | Kan |
|---|---|
| Ejer og indkøber | Alt: varer, indstillinger, indkøb, priser, e-mail-modtagere, fakturagrundlag |
| Medarbejder | Forbrugsportalen: job, registrering, lagerstatus og indkøbslister uden priser |

Login sker med et engangslink på e-mail. Adresser i `ADMIN_EMAILS` bliver automatisk ejere.

---

## Opsætning for en ny virksomhed

1. Kopiér `wrangler.toml` og udfyld felterne markeret med UDFYLD.
2. `npx wrangler d1 create UDFYLD-kundenavn-lager` og indsæt ID'et i `wrangler.toml`.
3. `npm run migrate`
4. `npx wrangler secret put RESEND_API_KEY` (domænet i `EMAIL_FROM` skal være verificeret i Resend).
5. `npx wrangler deploy`
6. Log ind med en adresse fra `ADMIN_EMAILS`, og opret firma, brugere, leverandører og varer under Indstillinger og Varer.

## Demo

`wrangler.demo.toml` kører med `DEMO_MODE=1`: login med ét klik som ejer eller medarbejder, fiktive varer og job (Nordlys Byg ApS), et **Demoforløb** (`/lager/demo`), der kører eksemplerne fra kravene igennem lagermotoren og viser tallene, og nulstilling under Indstillinger. E-mails er simulerede.

Workers Builds: rodmappe `/lagerstyring`, deploy-kommando `npx wrangler deploy --config wrangler.demo.toml`.

## Udvikling og tests

```
npm install
npm run typecheck
npm test              # starter wrangler dev med en lokal database og kører alle forløb
npm run screenshots   # skærmbilleder af de vigtigste sider (kræver Chromium)
```
