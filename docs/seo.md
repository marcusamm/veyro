# Veyro SEO

## Implementeret 5. november 2026

- `/pages/hosting` forklarer hosting og vedligeholdelse, aftalt omfang og næste skridt. Danske, engelske og svenske versioner følger eksisterende sprogstruktur og sitemap.
- Særlige søgetitler (`seo_title`) på kommercielle sider; de synlige titler bevares. Feltet kan redigeres under Admin → Hjemmeside → den enkelte side. Tomt felt bruger sidens titel.
- Forsidens titel og beskrivelse ligger under temaindstillinger → SEO og deling.
- `WebSite` og virksomhedsdata bruger stabile identifikatorer på tværs af sprogene. Brødkrummernes strukturerede data følger sidens sprog.
- Afsluttende skråstreg på offentlige sideadresser sender GET/HEAD til den normale adresse med 301. Kurven kan crawles og sender `noindex, follow`.

## Måling og næste arbejde

Den offentlige side og sitemap svarede 200 ved kontrollen. Search Console viste ingen ejendomme på den åbne Google-konto; indekseringsstatus, søgevolumen og placeringer er derfor endnu ikke verificeret. En almindelig websøgning er ikke en pålidelig måling af en bestemt dansk Google-placering.

1. Bekræft den ønskede ejerkonto og registrér/bekræft `veyro.dk` i Google Search Console. Bevar den eksisterende domæneopsætning.
2. Indsend `https://veyro.dk/sitemap.xml`, kontrollér forsiden og hosting-siden med URL-inspektion, og anmod om indeksering, hvis Google tilbyder det.
3. Gem et udgangspunkt for Danmark: klik, eksponeringer, CTR og gennemsnitlig placering for `veyro`, hostingrelaterede søgninger og de konkrete ydelser. Sammenlign efter Google har crawlet ændringerne, og derefter over sammenlignelige 28-dagesperioder.
4. Prioritér indhold ud fra reelle søgninger og henvendelser. Mulige emner er hjemmeside med hosting, vedligeholdelse af hjemmeside og hjemmeside til mindre virksomheder. Der er ikke foretaget søgevolumenanalyse.
5. Udbyg med godkendte kundecases og relevante omtaler/links. Undgå opdigtede anmeldelser, købte rankinglinks og mange næsten identiske bysider.

Placeringer bestemmes af søgemaskinen og kan ikke garanteres. Ændringer skal crawles og vurderes over tid.

## Ved næste udgivelse

Kør `npm run build:site`, `npm run typecheck` og de relevante site-tests. Kontrollér efter deploy de faktiske HTML-titler, interne links og sitemap. D1-indhold kan overskrive standardmenuer og sektioner; gamle gemte sider arver kun det nye `seo_title`, medmindre feltet er gemt eksplicit. Skift ikke eksisterende kundetekster eller menuer ukritisk for at gennemtvinge standardindhold.

Referencer: [Googles SEO-guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide), [webstedsnavn i Google](https://developers.google.com/search/docs/appearance/site-names).
