# Lagerstyring – skabelon

Et internt system til lagerstyring, vareforbrug på job og indkøbsplanlægning for håndværks- og servicevirksomheder. Kunderne bestiller ikke selv; systemet bruges af virksomhedens egne folk. Hver virksomhed får sin egen kopi, database og adresse (fx `lager.kundensdomæne.dk`), og udseendet følger designsystemet fra veyro.dk og varebestillingsdemoen.

Systemet har to portaler med de samme data:

**Lagerportalen** (`/lager`, ejer og indkøber)

- Oversigt med advarsler, job der afventer materialer, afvigelser og seneste bevægelser
- Varer: varenr., navn, enhed, fysisk, reserveret, disponibel, bestilt med forventet dato, dagligt forbrug, leverandør og leveringstid, sikkerhedslager, genbestillingspunkt og status
- Opret varer, ret indstillinger og registrér varemodtagelse, brugbare returvarer, optælling, svind og returnering til leverandør
- Indkøbslister pr. job og en fælles liste til lageropfyldning; linjer med og uden varenummer, grupperet efter leverandør
- Bestilling hos leverandør og varemodtagelse (også delvis). Varer lægges først på lager, når de modtages
- Indstillinger: firma og fakturaoplysninger, moms, brugere og roller, medarbejdertyper og timesatser, foretrukket byggemarked, e-mail-modtagere, leverandører og e-mail-log

**Job- og forbrugsportalen** (`/job`, alle medarbejdere, virker på mobil, tablet og computer)

- Jobliste med jobnr., slutkunde, ansvarlige, periode, status, prisoverslag, forbrug, timer og fakturastatus
- Jobstatus: Kladde, Planlagt, I gang, Afventer materialer, Afsluttet og Annulleret. "I gang" og "Afventer materialer" sættes automatisk ud fra forbrug, timer og manglende varer
- Hvert job har faner for Overblik, Materialer, Timer og løn, Prisoverslag, Indkøbslister, Faktura og Historik
- Medarbejdere registrerer forbrug og egne timer og ser ingen priser. Ejer og indkøber ser og ændrer priser, overslag og fakturaer

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

- **Hvor priserne kommer fra:** en officiel prisfil fra forhandleren (CSV, indlæses eller hentes fra et feed på serveren højst hver 6. time), butikkens offentlige produktsider eller en manuelt indtastet pris med link til produktsiden. Ved undersøgelsen i oktober 2026 blev der ikke fundet en offentlig API eller et offentligt produktfeed hos nogen af forhandlerne. STARK, BAUHAUS, Silvan, Davidsen og jem & fix læser offentlige produktsider (afprøvet; robots.txt og vilkår tillader det) og står som **Aktiv**. XL-BYG (vilkårene kræver en aftale) og Bygma (ingen pris i produktdataene) står som **Kommer senere** og bruger produktlink og manuel pris.
- **Læsning af produktsider:** på varens side knyttes et link til varen hos hver butik. Prisen læses automatisk kun hos butikker, hvor nogen har tjekket vilkårene og slået "Læser offentlige produktsider" til (hvem og hvornår gemmes). Butikkens robots.txt følges, siderne hentes én ad gangen på serveren højst hver 6. time (og ved "Opdatér priser"), og prisen tages kun fra sidens strukturerede produktdata (schema.org/JSON-LD eller Open Graph) i kroner. Login, CAPTCHA, 401/403/429 og adgangsbegrænsninger omgås aldrig; så vises fejlen ved linket, og der er ingen pris. En side med flere forskellige priser giver heller ingen pris. En butik læses kun, når den står som Aktiv.
- **Match:** 1) samme EAN/GTIN, 2) producentens varenummer + mærke + variant, 3) navn og mål. Kun 1) og 2) er **Præcist match**; et navnematch er **Alternativ – kræver godkendelse** og erstatter aldrig varen på listen. Forhandlernes egne varenumre sammenlignes aldrig på tværs.
- **Mængde:** den manglende mængde omregnes til forhandlerens salgsenhed med hele pakker og mindstekøb (12 stk. i pakker á 10 til 100 kr. = 2 pakker, 20 stk., 200 kr.). Tilbud bruges kun, når betingelserne er opfyldt, og de vises.
- **Visning:** forhandler, fundet vare med link, match, pakning og foreslået køb, offentlig pris med moms, linjeestimat, kilde (Prisfil, Læst fra produktsiden, Manuelt indtastet, Demodata) og tidspunkt for pristjek. Summen er i ét momsgrundlag (valgfrit inkl. eller ekskl. moms). Den laveste sammenlignelige materialepris blandt de fundne fremhæves og bruges; fragt tælles aldrig med og står som "Fragt og eventuelle gebyrer er ikke medregnet".
- **Manglende og gamle priser:** "Pris mangler" med antal varer uden pris og summen af de kendte. Priser ældre end det valgte antal dage vises som "Tidligere pris – ikke bekræftet". En manuel pris overskrives aldrig uden accept.
- **Foretrukket byggemarked:** er der valgt et byggemarked (Indstillinger, pr. job eller pr. linje), bruges kun dets pris, og mangler den, står der "Pris mangler". Der skiftes aldrig byggemarked i stilhed. Uden et valgt byggemarked bruges den billigste sammenlignelige pris (præcist match eller godkendt alternativ).
- **E-mail:** indkøbslisten til ejer og indkøber får estimatet (evt. opdelt efter forhandler), varer uden pris, prisdatoer og teksten "Vejledende prisestimat baseret på offentlige priser. Endelig pris, tilgængelighed, fragt og eventuelle rabatter bekræftes hos leverandøren."
- Prisopslag og afsendelse bestiller aldrig noget og ændrer ikke status. Estimaterne gemmes for sig selv med historik og blandes ikke med forventet pris, faktisk indkøbspris eller salgspris. En fejl hos en forhandler stopper aldrig registrering af forbrug eller lister.

Prisfilens kolonner står på siden Forhandlere og prisfiler. Demoen bruger to fiktive forhandlere med opdigtede priser, markeret **Demodata** og uden produktlinks.

## Job: materialer, timer, prisoverslag og faktura

Beløb til slutkunden er ekskl. moms, med moms og total inkl. moms ved siden af. Moms (25 %) bruges kun, når virksomheden er sat som momsregistreret under Indstillinger.

**Materialer.** Hver linje er enten en vare fra lageret eller en vare, der købes i byggemarkedet. Prisopslaget går til jobbets byggemarked (standard: det foretrukne) og finder varen efter EAN/GTIN, derefter producentnr. + mærke + variant og til sidst navn og mål; et navnematch er et alternativ, der skal godkendes. Linjen viser vare og byggemarked, match, link, pris og enhed, pakning, momsgrundlag og tidspunkt for opslaget. Et link, brugeren selv indsætter, læses direkte. Forventet forbrug, købsmængde i hele pakker og fakturerbar mængde holdes adskilt: 12 stk. i pakker á 10 købes som 2 pakker, og de 8 i overskud faktureres ikke. En linje uden pris står som "Pris mangler", kan få en manuel pris, gør overslaget ufuldstændigt og tæller aldrig som 0 kr. Kostprisen (estimat eller faktisk indkøbspris) og salgsprisen holdes adskilt; salgsprisen er den offentlige pris, kostpris + påslag eller en manuel pris. "Reservér og sæt på indkøbsliste" reserverer lagervarer og sætter det manglende på jobbets indkøbsliste; varer fra byggemarkedet leveres til arbejdsstedet og kommer ikke på hovedlageret.

**Timer og løn.** Forventede timer pr. medarbejdertype og faktiske timer pr. medarbejder med dato, beskrivelse, timer, intern omkostning og timepris. Intern omkostning = faktiske timer × intern sats (en samlet sats pr. medarbejdertype; ikke et lønsystem). Overslag = forventede timer × timepris. Faktura = godkendte fakturerbare timer × aftalt timepris. Medarbejderens egne timer afventer godkendelse. Interne omkostninger vises aldrig for slutkunden.

**Prisoverslag.** Materialernes salgsbeløb + arbejdsløn + andre fakturerbare omkostninger = ekskl. moms, plus moms og total. Hver gemt version bevares uændret, og PDF'en er markeret "Prisoverslag" med virksomhed, slutkunde og forudsætningerne. Første download markerer versionen som sendt; en version kan markeres som accepteret. Et overslag bliver aldrig automatisk en fast pris, og en senere ændret indkøbspris ændrer ikke et delt eller accepteret overslag.

**Faktura.** Grundlaget er faktisk forbrug minus returvarer, godkendte timer, aftalte priser og andre omkostninger. Afregning: medgået, fast pris eller fast pris for arbejdet + materialer efter forbrug; forskellen til overslaget vises. Flow: kladde → gennemse og ret → udsted. Ved udstedelse får fakturaen det næste fortløbende nummer, oplysningerne låses, og den kan ikke ændres eller slettes; rettelser sker med en kreditnota. Det, der er faktureret (minus kreditnotaer), trækkes fra, så intet faktureres to gange. Fakturaen har fakturadato, fortløbende nummer, virksomhedens navn, adresse og CVR, slutkundens navn og adresse (og CVR for erhverv), leveringsdato, mængde og art, pris ekskl. moms, momssats og momsbeløb, betalingsfrist og betalingsoplysninger. **Krav til fakturaer og moms (B2B, B2C, omvendt betalingspligt) skal bekræftes med revisor eller Skattestyrelsen, før systemet bruges til rigtige fakturaer.** PDF kan hentes; afsendelse på e-mail kommer senere.

Fakturagrundlag fra før denne version kan stadig ses og eksporteres under Lager → `/lager/faktura`; nye fakturaer laves under Job → Faktura.

## Roller

| Rolle | Kan |
|---|---|
| Ejer og indkøber | Alt: varer, indstillinger, indkøb, priser, prisoverslag, fakturaer og kreditnotaer |
| Medarbejder | Jobportalen: job, materialer og forbrug, egne timer, lagerstatus og indkøbslister uden priser |

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

`wrangler.demo.toml` kører med `DEMO_MODE=1`: login med ét klik som ejer eller medarbejder, fiktive varer og job (Nordlys Byg ApS) i alle statusser med materialer, timer, prisoverslag, en udstedt faktura, en kreditnota og en fakturakladde (alt markeret Demodata), et **Demoforløb** (`/lager/demo`), der kører eksemplerne fra kravene igennem lagermotoren og viser tallene, og nulstilling under Indstillinger. E-mails er simulerede.

Workers Builds: rodmappe `/lagerstyring`, deploy-kommando `npx wrangler deploy --config wrangler.demo.toml`.

## Udvikling og tests

```
npm install
npm run typecheck
npm test              # starter wrangler dev med en lokal database og kører alle forløb
npm run screenshots   # skærmbilleder af de vigtigste sider (kræver Chromium)
```
