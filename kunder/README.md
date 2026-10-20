# Kunder

Hver fil her er én kunde. Når en ændring her (eller i `lagerstyring/` / `varebestilling/`) lander på `main`, deployer GitHub Actions automatisk alle kunder til Cloudflare med `scripts/deploy-kunder.mjs`: databasen oprettes, hvis den mangler, migrationer køres, og workeren deployes med den nyeste kode.

## Ny kunde

Opret `kunder/<kundenavn>.json` (små bogstaver og bindestreger, fx `nordlys.json`):

```json
{
  "navn": "Nordlys Byg ApS",
  "systemer": {
    "lagerstyring": {
      "domaene": "lager.nordlys.dk",
      "admins": ["ejer@nordlys.dk"],
      "afsender": "Nordlys Lager <login@veyro.dk>"
    }
  },
  "udseende": {
    "farve": "#FF5A1F",
    "logo": "nordlys-logo.svg"
  }
}
```

- `systemer`: `lagerstyring` og/eller `varebestilling`.
- `adresse`: valgfri, kort navn til kundens adresse, fx `"ek"`. Kunder uden eget domæne får lagerstyringen på `<adresse>.veyro.dk` og varebestillingen på `<adresse>-bestilling.veyro.dk`. Uden `adresse` bruges filnavnet.
- `domaene`: valgfri. Domænet skal ligge i Veyros Cloudflare-konto. Uden domæne kører systemet på `<adresse>.veyro.dk` (se `KUNDE_DOMAENE`), eller på `<kundenavn>-lager.<WORKERS_SUBDOMAIN>.workers.dev`.
- `admins`: e-mails, der kan logge ind som ejer første gang og oprette resten under Indstillinger.
- `afsender`: valgfri. Uden den bruges repo-variablen `EMAIL_FROM_STANDARD`. Afsenderdomænet skal være verificeret i Resend.
- `udseende`: valgfri. `farve` er kundens farve som `#RRGGBB`, og `logo` er en billedfil (PNG, JPG, WebP eller SVG, højst 200 KB), der ligger her i `kunder/`.

Worker og database får navnet `<kundenavn>-lager` eller `<kundenavn>-bestilling`. I lagerstyringen lægges firmanavnet (`navn`), farven og logoet ind ved deploy, så systemet er klar ved første login. Det sker kun, når de ændres i kundefilen, så det, kunden selv retter under Indstillinger, bliver stående. Varebestillingen sættes stadig op under Indstillinger.

## Kundelogin på veyro.dk

"Kundelogin" på hjemmesiden går til `kunde.veyro.dk/login`. Når man skriver sin e-mail dér, slås den op i KV-navnerummet `veyro-kundekatalog`, og man sendes videre til sin virksomheds lagerstyring (fx `ek.veyro.dk`) med e-mailen udfyldt. Har e-mailen adgang flere steder, eller også et abonnement hos Veyro, vælger man selv. Kendes e-mailen ikke, fortsætter det almindelige login til kundepanelet.

Hver kundes lagerstyring holder selv kataloget opdateret: kort efter deploy, hver time og når en bruger oprettes eller ændres under Indstillinger. E-mails gemmes kun som SHA-256-hash. Navnerummets ID står i `wrangler.toml` i roden og i `scripts/deploy-kunder.mjs` (kan overskrives med repo-variablen `KUNDEKATALOG_ID`). Direkte videresendelse virker for adresser på `*.veyro.dk`; kunder med eget domæne vises som et valg i stedet.

Databaser oprettes i EU (`--jurisdiction eu`), så data bliver i EU og ligger tæt på kunderne. En databases placering kan ikke ændres bagefter; den skal slettes og oprettes igen.

Fjernes en fil, bliver kundens worker og database **ikke** slettet; det gøres manuelt i Cloudflare.

## Engangsopsætning i GitHub

Under *Settings → Secrets and variables → Actions*:

- Secrets: `CLOUDFLARE_API_TOKEN` (skabelonen "Edit Cloudflare Workers" plus D1-redigering), `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY`.
- Variables (valgfrie): `EMAIL_FROM_STANDARD` (standard `Veyro <login@veyro.dk>`) og `WORKERS_SUBDOMAIN` (standard `marcus-ammitzboell`) overskriver standardværdierne i workflowet. `KUNDE_DOMAENE` (standard `veyro.dk`) giver alle kunder uden eget domæne en adresse på det domæne; domænet skal ligge i samme Cloudflare-konto.

Deploy af én kunde manuelt: fanen *Actions → Deploy kunder → Run workflow* med kundens filnavn.

## Kontrol efter aflevering eller opdatering

Fanen *Actions → Produktionstest → Run workflow* med kundens filnavn kontrollerer den publicerede lagerstyring fra start til slut: login-siden, hovedsiderne på desktop og mobil, oprettelse af et job og registrering af forbrug. Testen logger ind med en midlertidig session for en eksisterende ejer (repo-variablen `PRODUKTIONSTEST_EMAIL`, ellers den sidste admin i kundefilen), så der ikke sendes mails eller oprettes testkonti, og den fjerner sit kontroljob og sætter beholdningen tilbage bagefter. Skærmbillederne gemmes som artefakt på kørslen.

## Gendannelse

- Kode: *Cloudflare → Workers → `<kundenavn>-lager` → Deployments* kan rulle tilbage til en tidligere version.
- Data: D1 Time Travel gendanner databasen til et tidspunkt inden for de seneste 30 dage, fx `npx wrangler d1 time-travel restore <kundenavn>-lager --timestamp=2026-10-20T03:25:00Z`.
