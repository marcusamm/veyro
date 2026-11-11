# Veyro SEO

## Synlighed i Google og AI-søgning, 11. november 2026

Målet er, at kunder kan finde Veyro via Google, ChatGPT-søgning og Claude, når de leder efter dansk webhosting, hjemmesider og vedligeholdelse. Forsiden beholder Veyro først i søgetitlen og beskriver webhosting med dansk support. Den eksisterende hostingside er fortsat den fælles destination for hostingrelaterede søgninger.

- Hosting gør den danske virksomhed og kontakt i Slagelse tydelig. Et synligt FAQ-svar skelner mellem dansk support og serverplacering. Eksisterende hjemmesiders hosting/vedligeholdelse er efter tilbud, mens hosting indgår i hjemmesidepakkerne.
- Forsidens nye hosting-FAQ linker til hostingsiden og forklarer pakkerne. Nye tekster og metadata er oversat til engelsk og svensk. Priser og aftaler bevares.
- `ChatGPT-User` og `Claude-User` bevarer nu den efterspurgte sides sprog, også når hentningen kommer fra USA/Sverige uden Cloudflares verified-bot-metadata. Søgecrawlere som `OAI-SearchBot`, `Claude-SearchBot`, Googlebot og Bingbot var allerede undtaget fra geolokation. Et eksplicit sprogvalg virker fortsat. Undtagelsen giver ingen ekstra rettigheder eller adgang til private data.
- Begge offentlige domæners aktuelle `robots.txt` tillader offentligt indhold via wildcard og annoncerer eget sitemap. Der er ingen specifik blokering af de nævnte søgecrawlere. Privat kundeindhold og previews får ingen nye tilladelser. Træningscrawlere er ikke nødvendige for søgesynlighed, og deres eksisterende indstillinger ændres ikke.
- Indholdet leveres i serverrenderet HTML med eksisterende virksomhedsidentitet, Service-data, lokale canonical-adresser og hreflang. Ingen nye billeder, scripts, afhængigheder eller særlige AI-filer.

### Verifikation og begrænsning

Site-build, TypeScript og 156 tests i SEO, sprogvalg, svensk gengivelse/domæner og valuta bestået. De nye regressionstests dækker AI-søgning/hentning fra USA og Sverige, GET/HEAD, eksplicit sprogvalg samt uændret behandling af kontostier og POST.

Før ændringen bestod alle 60 offentlige sitemap-adresser HTTP-kontrollen: status 200, egen canonical, ét H1, beskrivelse og gyldige strukturerede data. Requests fra vores netværk med Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot, ChatGPT-User og Claude-User som User-Agent fik 200 uden challenge. Det dokumenterer ikke adgang fra udbydernes faktiske IP-adresser; Cloudflare-regler på kontoniveau og crawlerlogfiler kunne ikke inspiceres med den tilgængelige CLI-adgang.

Google angiver, at almindelig SEO også gælder for AI Overviews og AI Mode; der kræves ikke særlige AI-filer eller et særligt schema. OpenAI bruger OAI-SearchBot til søgning og ChatGPT-User til visse brugerbestilte hentninger. Anthropic skelner tilsvarende mellem Claude-SearchBot, Claude-User og træningscrawleren ClaudeBot. Indeksering og omtale/anbefaling i et AI-svar er ikke garanteret.

Kilder: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [OpenAI Crawlers](https://developers.openai.com/api/docs/bots), [Anthropic crawlers](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler).

Efter nyt crawl: mål Danmark i Search Console på Veyro, dansk webhosting, hosting med dansk support og hjemmeside med hosting, plus de relevante landingssider. Sammenlign klik, eksponeringer, CTR og gennemsnitlig placering over sammenlignelige 28-dagesperioder. AI-svar bør stikprøves med samme neutrale spørgsmål, land/sprog og dato; et enkelt svar er ikke en stabil placering. Der er endnu ingen aflæst ny målebaseline eller dokumenteret placeringseffekt. Næste indholdsarbejde bør bygge på rigtige kundeprojekter og verificerbare erfaringer samt korrekte eksterne virksomhedsprofiler.

## Svensk domæne, 6. november 2026

Den svenske version har nu `https://veyro.se` som kanonisk origin uden `/sv`-præfiks. Gamle `veyro.dk/sv/...`-adresser får 301 til samme side på `.se`, inklusive søgeparametre. Hvert domænes sitemap indeholder kun dets egne kanoniske sider; alle sprog har gensidige `hreflang`-henvisninger. HTML-canonical, Open Graph, service- og produktadresser samt brødkrummer følger sprogets domæne. Veyros danske virksomhedsidentitet og adresse bevares; der oprettes ingen svensk virksomhed i strukturerede data.

Prøveværten forbliver `noindex`. Den svenske forside og kontaktformular er svenske uanset IP-land eller gamle sprogpræferencer, og formularens valgte niveau/pris beregnes fra de eksisterende SEK-priser. Automatisk landebaseret viderestilling gælder kun de relevante offentlige `.dk`-sider og er fortsat undtaget for crawlers.

Næste eksterne trin: tilføj/verificér `veyro.se` i Search Console og indsend `https://veyro.se/sitemap.xml`. Dette er ikke udført som en del af domæneændringen. Det danske sitemap forbliver på samme adresse.

## Implementeret 5. november 2026

- `/pages/hosting` forklarer hosting og vedligeholdelse, aftalt omfang og næste skridt. Danske, engelske og svenske versioner følger eksisterende sprogstruktur og sitemap.
- Særlige søgetitler (`seo_title`) på kommercielle sider; de synlige titler bevares. Feltet kan redigeres under Admin → Hjemmeside → den enkelte side. Tomt felt bruger sidens titel.
- Forsidens titel og beskrivelse ligger under temaindstillinger → SEO og deling.
- `WebSite` og virksomhedsdata bruger stabile identifikatorer på tværs af sprogene. Brødkrummernes strukturerede data følger sidens sprog.
- Afsluttende skråstreg på offentlige sideadresser sender GET/HEAD til den normale adresse med 301. Kurven kan crawles og sender `noindex, follow`.

## Måling og næste arbejde

Den offentlige side og sitemap svarede 200 ved kontrollen. Search Console-ejendommen `https://veyro.dk/` er bekræftet på virksomhedskontoen `marcus@veyro.dk`. Et skærmbillede fra 5. november viser, at `/sitemap.xml` blev behandlet korrekt og senest læst samme dag. Dette bekræfter modtagelse af sitemap, ikke at alle sider er indekseret. Effektivitetsrapporten viste endnu, at data blev behandlet. En almindelig websøgning er ikke en pålidelig måling af en bestemt dansk Google-placering.

1. Brug den eksisterende Search Console-ejendom på virksomhedskontoen. Sitemap er allerede indsendt og behandlet; gentagne indsendelser er ikke nødvendige.
2. Kontrollér forsiden, `/pages/hjemmeside`, `/pages/hosting` og `/pages/om-os` med URL-inspektion. Notér indekseringsstatus, seneste crawl og Googles valgte kanoniske URL; anmod om indeksering, hvis det er relevant. Dette er endnu ikke udført: browserforbindelsen eksponerede kun den private profil, og arbejdet må ikke tage skærmfokus.
3. Gem et udgangspunkt for Danmark: klik, eksponeringer, CTR og gennemsnitlig placering for `veyro`, hostingrelaterede søgninger og de konkrete ydelser. Sammenlign efter Google har crawlet ændringerne, og derefter over sammenlignelige 28-dagesperioder.
4. Prioritér indhold ud fra reelle søgninger og henvendelser. Mulige emner er hjemmeside med hosting, vedligeholdelse af hjemmeside og hjemmeside til mindre virksomheder. Der er ikke foretaget søgevolumenanalyse.
5. Udbyg med godkendte kundecases og relevante omtaler/links. Undgå opdigtede anmeldelser, købte rankinglinks og mange næsten identiske bysider.

Placeringer bestemmes af søgemaskinen og kan ikke garanteres. Ændringer skal crawles og vurderes over tid.

## Anden forbedring: brand og søgeintention

- Forsiden nævner Veyro, Slagelse og virksomhedens arbejde i Danmark direkte, med et kontekstuelt link til hosting.
- Hjemmeside-, hosting- og om os-siderne får beskrivende overskrifter og indhold, som hjælper besøgende med at vælge løsning. Hosting-siden skelner mellem webhotel, domæne, mail og vedligeholdelse. Alle tilføjelser findes på dansk, engelsk og svensk.
- Virksomhedsdata genbruges på offentlige informationssider. Adressefelter opdeles fra den eksisterende redigerbare adresse; CVR angives som CVR-identifikator uden at udlede momsregistrering. Eksisterende Instagram- og Trustpilot-links forbinder virksomhedsidentiteten.
- De seks faktiske ydelsessider forbindes til Veyro med `Service`-data og deres egne kanoniske adresser. Der tilføjes ingen opdigtede anmeldelser eller priser, og strukturerede data er ikke et løfte om højere placeringer.
- Googles officielle inspektionsbrugeragent skal bevare den URL og det sprog, som undersøges, på samme måde som øvrige crawlers.

| Prioritet | Søgeintention | Primær side |
| --- | --- | --- |
| 1 | Veyro, Veyro.dk | `/` |
| 1 | Hjemmeside til mindre virksomheder, hjemmeside med hosting | `/pages/hjemmeside` |
| 1 | Website hosting, hosting og vedligeholdelse af hjemmeside | `/pages/hosting` |
| 2 | Webbureau Slagelse, hvem er Veyro | `/pages/om-os` |
| 2 | Hjemmeside pris, hjemmeside abonnement | `/pages/priser` |

Dette er en fordeling af relevante emner, ikke en dokumenteret søgevolumenanalyse. `Veryo` er ikke virksomhedens publicerede navn og tilføjes ikke som en opdigtet alternativ identitet. Følg eventuelle stavevarianter i Search Console, når der foreligger data.

Næste indsats uden for hjemmesiden er ensartede virksomhedsoplysninger og links på de eksisterende virksomhedsprofiler samt ægte kundecases med tilladelse. En Google Business Profile bør kun oprettes, hvis virksomheden opfylder Googles krav til personlig kundekontakt; der er ikke oprettet en profil eller sendt henvendelser i denne opgave.

## Ved næste udgivelse

Kør `npm run build:site`, `npm run typecheck` og de relevante site-tests. Kontrollér efter deploy de faktiske HTML-titler, interne links og sitemap. D1-indhold kan overskrive standardmenuer og sektioner; gamle gemte sider arver kun det nye `seo_title`, medmindre feltet er gemt eksplicit. Skift ikke eksisterende kundetekster eller menuer ukritisk for at gennemtvinge standardindhold.

Referencer: [Googles SEO-guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide), [webstedsnavn i Google](https://developers.google.com/search/docs/appearance/site-names), [virksomhedsdata](https://developers.google.com/search/docs/appearance/structured-data/organization), [anmodning om nyt crawl](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl), [Google-InspectionTool](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers#google-inspectiontool), [Business Profile-krav](https://support.google.com/business/answer/3038177).

## Gennemgang 6. november 2026

Robins [SEO-tjek](https://teamrobin.com/da/test-dit-firma/seotjek) beskriver scanning af titler, indhold, teknik, trafik og lokal synlighed efterfulgt af rådgivning. En rapportscore ændrer ikke hjemmesiden og er ikke en Google-placering. Veyros gennemgang tager derfor udgangspunkt i konkrete HTTP-svar, indhold og målinger.

### Fund og rettelser

- Kundedomænets rod-`robots.txt` blokerede hele domænet, inklusive 13 offentlige logistikværktøjssider. Den tillader nu de præcise offentlige sider og nødvendige ressourcer og annoncerer `/logistik/sitemap.xml`. En robots-fil i en undermappe kan ikke ophæve reglerne i roden. Login, API'er, kontosider og gemte visninger er fortsat uden for den offentlige crawlerliste. Private visninger får også `X-Robots-Tag: noindex, nofollow`; adgangskontrol er fortsat den egentlige beskyttelse af brugerdata. Preview-værter forbliver lukkede.
- Om os-sidens søgetitel nævnte Veyro to gange. Den beskriver nu webbureauet i Slagelse, med ét afsluttende brandnavn, på dansk, engelsk og svensk.
- Optimeringssiden linker kontekstuelt til hosting og vedligeholdelse i alle tre sprog.
- Eksempelbilleder har responsive WebP-varianter og JPEG-fallback. De tre galleribilleder fylder samlet 170.502 bytes mod 230.106 bytes ved samme bredde på 960 px (26 % mindre). Ny 768 px-størrelse fylder 121.598 bytes. Billedudsnit, design og animation bevares. Filnavne indeholder indholdshash og kan derfor caches længe uden at fastholde gamle billeder. Effektive eksisterende mobile JPEG'er bevares, hvor WebP ville fylde mere.
- Galleriets navngivne gruppe har korrekt semantik, og demolinks bruger deres synlige tekst som tilgængeligt navn.

### Udgangspunkt før rettelserne

Live HTTP-gennemgang: 60 sitemap-URL'er svarede 200 med korrekt sprog, selvrefererende canonical, én H1 og beskrivelse. 122 yderligere interne links virkede. Sprog-alternativer, JSON-LD, ægte 404, viderestilling fra www og noindex på fiktive demoer/prøveværten fungerede allerede.

Lighthouse 13.6.0, simuleret mobil, enkeltmålinger fra 6. november:

| Side | Performance | Tilgængelighed | Best practices | SEO | LCP | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Forside | 96 | 94 | 100 | 100 | 1,6 s | 100 ms | 0 |
| Hjemmeside | 99 | 96 | 100 | 100 | 2,1 s | 0 ms | 0,001 |

Laboratoriemålinger kan variere og er ikke faktiske brugerdata/Core Web Vitals eller et bevis på høj placering. Lighthouse SEO dækker et begrænset sæt tekniske kontroller.

Search Console blev åbnet i Chrome-profilen med `marcus@veyro.dk`. Sitemaprapporten viste "Dit sitemap blev behandlet", senest læst 5. november med 57 registrerede sider; det aktuelle sitemap indeholder 60. Dette beviser modtagelse, ikke indeksering. Der er endnu ikke dokumenteret et søgetrafik- eller placeringsudgangspunkt i denne gennemgang.

### Fortsat arbejde

1. Brug URL-inspektion på forsiden og de vigtigste ydelsessider; registrér Googles canonical og faktiske indekseringsstatus. Undgå gentagne indsendelser af samme sitemap/URL uden grund.
2. Registrér klik, eksponeringer, CTR og placering efter land og søgeforespørgsel, og sammenlign tilsvarende 28-dagesperioder. Prioritér nyttigt indhold ud fra disse data frem for at tilføje flere søgeord til allerede dækkende sider.
3. Udgiv godkendte, ægte kundecases med konkrete leverancer og dokumenterede resultater. De nuværende fiktive demoer skal fortsat være tydeligt mærket.
4. Hold virksomhedens officielle profiler og kontaktoplysninger konsistente. Google Business Profile kræver, at virksomheden er berettiget efter Googles regler; der er ikke oprettet en profil eller købt omtale/links.

Drift: Efter nye previewbilleder køres `python3 scripts/optimize-demo-previews.py` (Pillow er kun et forfatterværktøj), derefter `npm run build:site`. De genererede WebP-filer, manifest og Liquid-kilde gemmes sammen. Tilføjes en offentlig logistikside, skal rodens allowliste også opdateres; testen sammenholder listen med sitemap.

Validering: Typecheck, genereret tema og 298 relevante tests bestået. Desktop- og mobilgalleri kontrolleret i browser; 390 px-visningen bruger de nye 480 px-billeder uden vandret overflydning. En separat gennemgang fandt ingen ændring af login, adgangskontrol, database eller betalingsflow.
