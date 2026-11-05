# Veyro SEO

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
