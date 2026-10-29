# Lagerstyring – skabelon

Seneste videreudvikling: [logistik, kontrol og OCR-kontrakt, 29. oktober 2026](../docs/LOGISTIK-2026-10-29.md).

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
- Genbestillingspunkt kan sættes manuelt og bruges da direkte uden at lægge sikkerhedslager til igen. Ellers foreslås dagligt forbrug × leveringstid + sikkerhedslager. Leveringstiden kan sættes på varen eller arves fra leverandøren. Alle tider er kalenderdage.
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

- **Hvor priserne kommer fra:** importerede prisfiler og manuelt indtastede priser, med kilde og dato. Ingen liveleverandørintegration er automatisk bekræftet fra skabelonen. Den gamle skabelongodkendelse fjernes af migration 0055; virksomhedens egne bekræftelser og importerede filer bevares. Produktsider eller et officielt feed kan først bruges som automatisk kilde efter konkret opsætning og kontrol. Uden en brugbar kilde vises "Pris mangler".
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

## Produktkatalog

Et fælles katalog for begge portaler (Lager → Produktkatalog og Job → Produktkatalog). Kataloget er produktdata, ikke lager: en import opretter aldrig lagerbeholdning, ændrer ikke mængder, registrerer ikke indkøb eller modtagelser og gør ikke en leverandørs lager til virksomhedens eget.

**Import.** Ejer og indkøber vælger en datakilde (producent, forhandler eller demo), uploader en CSV- eller Excel-fil (.xlsx), vælger faneblad og overskriftsrække og kobler kolonner til felterne. Filen læses i browseren og sendes i bidder; serveren viser en forhåndsvisning med nye, opdaterede, uændrede og fejlrækker samt varer, der mangler i filen. Intet ændres før godkendelse, og en import kan kun godkendes én gang. Kolonneopsætningen gemmes pr. kilde. Varer genkendes på producent + producentnummer og på EAN; samme varenummer med en anden EAN, pakning eller variant sammenlægges ikke. Varer, der mangler i en senere fil, markeres til gennemgang og slettes aldrig. EAN gemmes som tekst (indledende nul bevares), tomme felter vises som "Ukendt", og en manglende pris bliver aldrig 0 kr.

**Felter.** Producent og kilde, producentens varenummer (adskilt fra forhandlerens varenummer og Veyros ID `VK-000123`), EAN/GTIN, navn, beskrivelse, kategori, variant, mål, materiale, enhed og pakning, link, pris med valuta, momsgrundlag og pristype, filens dato og tidspunktet for seneste import. Priser ligger i en separat tabel pr. kilde, forhandler og pristype, så en vare kan få priser fra flere forhandlere. En producents listepris kaldes aldrig en forhandlers pris eller virksomhedens indkøbspris.

**Materialer på et job.** "Tilføj materiale" er en søgning ("Søg efter varenavn, varenummer eller EAN") med forslag, mens der skrives, filter på producent og kategori og sideinddeling på serveren. Præcist EAN og varenummer kommer først; flere ord og mindre stavefejl virker. Ved valg udfyldes varens data; brugeren angiver antal, kontrollerer enheden og vælger reservation, forbrug nu eller kun forventet (det manglende kommer på indkøbslisten). Findes varen ikke i varekartoteket, oprettes en reference med beholdning 0. Katalogets pris kan sættes som manuel pris på linjen, men kun når ejer eller indkøber vælger det; ellers bruges det eksisterende prisopslag. En senere katalogopdatering ændrer ikke linjer, overslag eller fakturaer. Manuel oprettelse af varer uden for kataloget findes stadig.

**Demo.** Demoen har et katalog med 25 fiktive varer ("Nordlys Demo" og "Demo VVS", varenumre `DEMO-…`, EAN med præfiks 20) og version 2 af filen som CSV og Excel til at prøve genimport. Kilden KEMPER er oprettet uden varer; der er ikke hentet eller opfundet KEMPER-data. Demovarer kan kun importeres i en demokilde. En belastningstest lægger 10.000 syntetiske varer (`DEMO-LT-00001` …) i en separat kilde og kan fjernes igen. Tilladelse til at bruge en producents data i produktion afklares før officiel lancering.

## Bilag, betalinger, returer og eksport

- **Bilag** (Lager → Bilag og Job → Bilag): upload af kvitteringer, leverandørfakturaer og kreditnotaer (PDF, JPG, PNG, HEIC; flere filer eller kamera). Originalen gemmes uændret i databasen. PDF'er med tekst aflæses af en indbygget PDF-læser; usikre værdier markeres. Fotos og indskannede PDF'er bruger kun OCR, hvis virksomhedens særskilte `RECEIPT_OCR`-forbindelse er sat op. Ellers registreres de manuelt. OCR-forslag skal bekræftes mod originalen før godkendelse eller lagerhandling.
- **Digital visning af originalbilag** vises ved siden af originalen og kan hentes som PDF. Interne oplysninger (betaling, fordeling, godkendelse) står for sig.
- **Fordeling** på job, lageropfyldning eller drift. En ny varemodtagelse eller et direkte køb til et job registreres kun ved et bevidst tryk og kun én gang; et eksisterende køb knyttes uden at tælle igen. Upload og godkendelse ændrer aldrig lageret, salgspriser, overslag eller udstedte fakturaer.
- **Dubletter** markeres (samme fil eller samme leverandør, nummer og beløb) og slås aldrig sammen. **Udlæg** fra medarbejdere følges til de er refunderet.
- **Betalinger** registreres manuelt på udstedte fakturaer (ingen bankafstemning). Status beregnes ud fra faktura, kreditnotaer og betalinger. Påmindelser er kun udkast som PDF uden gebyrer eller renter.
- **Returer** (Varemodtagelse → Returer): brugbare varer fra job kommer på lager, beskadigede gør ikke. Retur til leverandør trækker fra lageret og afventer kreditnotaen.
- **Eksport til bogholder** (Bilag → Eksport): ZIP med originaler, digitale visninger, fakturaer og CSV (UTF-8, semikolon, komma som decimaltegn). Ingen integration til regnskabsprogram, og intet markeres som bogført. En eksport kan markeres som fejlet og laves igen.
- **Opsætningsguide**: Indstillinger → Opsætningsguide.
- **Demo**: `/lager/demo/bilag` kører et 14-trins bilagsforløb.

### Samtale om et bilag

**Spørg til bilaget** giver plads til frie spørgsmål og opfølgende spørgsmål ved siden af originalen. Aflæsning og samtale er to særskilte funktioner: [Veyros PaddleOCR-container](../ocr-service/README.md) aflæser dokumentet; Cloudflare Workers AI med modellen `@cf/meta/llama-3.3-70b-instruct-fp8-fast` besvarer spørgsmål til den aflæste tekst. Chatmodellen ser **ikke originalens billedpunkter** og kan derfor ikke kontrollere, om OCR har læst et tal korrekt på billedet.

Kildetekst fra en vellykket aflæsning gemmes i virksomhedens egen D1, adskilt fra de felter, brugeren kan rette: højst 100.000 tegn med bevarede sider og linjer. Kilden har fil-ID, aflæsningstidspunkt, udbyder og kildeversion; senere manuelle rettelser ændrer ikke kildeteksten. Et udskiftet originalbilag får aldrig kilde fra den tidligere fil. Store tekst-PDF'er markeres udtrykkeligt som delvist medtaget. Migration `0057_bilag_ocr_evidence.sql` opretter lageret. På gamle bilag henter det første spørgsmål selv kildeteksten fra originalen uden genindlæsning, ændringer i gemte felter eller afhængighed af den normale OCR-kø. Det gælder også godkendte bilag. Skrivefeltet er tilgængeligt under forberedelsen; første svar kan tage op til tre minutter inklusive modelsvar.

Modellen modtager højst 28.000 tegn fra kildeteksten, de aktuelle gemte felter, brugerens spørgsmål og højst seks tidligere samtalebeskeder. Kildetekst, gemte felter og brugerrettelser holdes adskilt i forespørgslen. Svar ledsages af kildeuddrag: serveren kontrollerer side- og linjehenvisningerne og henter selve uddraget fra den gemte tekst. Det validerer henvisningen, **ikke korrektheden af OCR eller modellens fortolkning**. Manglende dokumentation eller afkortet tekst skal fremgå af svaret. Chatten må ikke opfinde værdier eller beregne erstatningsbeløb uden et udtrykkeligt spørgsmål om det.

Veyro gemmer ikke spørgsmål og svar i D1; samtalen holdes i hukommelsen på den åbne side og nulstilles ved genindlæsning. Den nødvendige samtalekontekst sendes til Cloudflare ved hvert spørgsmål. Kun forbrugstællere med bruger og tidspunkt gemmes på serveren (`0058_bilag_chat_usage.sql`): højst 30 forsøg pr. virksomhed pr. UTC-døgn og fire pr. bruger inden for 60 sekunder. Tællere ældre end syv døgn ryddes ved efterfølgende brug.

Chatten ændrer ingen felter, varelinjer, godkendelser, omkostninger eller lagerantal. Brugeren kontrollerer og retter oplysningerne i den eksisterende formular og gemmer/godkender gennem det normale bilagsforløb. Originalen forbliver uændret. Et spørgsmål, som blev startet før en bilagsændring eller ny aflæsning, må ikke vise et gammelt svar som aktuelt.

**Aktivering:** `systemer.lagerstyring.receipt_chat: true` kræver en udtrykkelig `ocr_service` i kundefilen. `scripts/deploy-kunder.mjs` kører migrationerne og tilføjer kun da `[ai] binding = "RECEIPT_CHAT"`; der bruges Cloudflare-kontoens Workers AI-adgang uden en ny API-nøgle. Fravær eller `false` giver ingen AI-binding. Kun `ek-enterprise`-demoen har tilvalgt chatten; rigtige kunder er ikke tilsluttet. Workers AI-forbrug hører til Cloudflare-kontoen. Der gives ingen garanti for EU-placering af AI-behandlingen eller OCR-containerens beregning; databehandling og regionalt behov skal afklares, før rigtige kundebilag bruges. AI-svar er forslag til gennemgang og kan være forkerte.

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

En installation med `"demo": true` i `kunder/<slug>.json` kører med `DEMO_MODE=1`: login med ét klik som ejer eller medarbejder, fiktive varer og job (Nordlys Byg ApS) i alle statusser med materialer, timer, prisoverslag, en udstedt faktura, en kreditnota og en fakturakladde (alt markeret Demodata), et **Demoforløb** (`/lager/demo`), der kører eksemplerne fra kravene igennem lagermotoren og viser tallene, og nulstilling under Indstillinger. E-mails er simulerede.

Veyros demo er EK Enterprise (`kunder/ek-enterprise.json`, ek-enterprise.veyro.dk), som opdateres med "Deploy kunder" ligesom de andre installationer.

## Udvikling og tests

```
npm install
npm run typecheck
npm test              # starter wrangler dev med en lokal database og kører alle forløb
npm run screenshots   # skærmbilleder af de vigtigste sider (kræver Chromium)
```
