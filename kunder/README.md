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
- `domaene`: valgfri. Domænet skal ligge i Veyros Cloudflare-konto. Uden domæne kører systemet på `<kundenavn>-lager.<WORKERS_SUBDOMAIN>.workers.dev`.
- `admins`: e-mails, der kan logge ind som ejer første gang og oprette resten under Indstillinger.
- `afsender`: valgfri. Uden den bruges repo-variablen `EMAIL_FROM_STANDARD`. Afsenderdomænet skal være verificeret i Resend.
- `udseende`: valgfri. `farve` er kundens farve som `#RRGGBB`, og `logo` er en billedfil (PNG, JPG, WebP eller SVG, højst 200 KB), der ligger her i `kunder/`.

Worker og database får navnet `<kundenavn>-lager` eller `<kundenavn>-bestilling`. I lagerstyringen lægges firmanavnet (`navn`), farven og logoet ind ved deploy, så systemet er klar ved første login. Det sker kun, når de ændres i kundefilen, så det, kunden selv retter under Indstillinger, bliver stående. Varebestillingen sættes stadig op under Indstillinger.

Databaser oprettes i EU (`--jurisdiction eu`), så data bliver i EU og ligger tæt på kunderne. En databases placering kan ikke ændres bagefter; den skal slettes og oprettes igen.

Fjernes en fil, bliver kundens worker og database **ikke** slettet; det gøres manuelt i Cloudflare.

## Engangsopsætning i GitHub

Under *Settings → Secrets and variables → Actions*:

- Secrets: `CLOUDFLARE_API_TOKEN` (skabelonen "Edit Cloudflare Workers" plus D1-redigering), `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY`.
- Variables (valgfrie): `EMAIL_FROM_STANDARD` (standard `Veyro <login@veyro.dk>`) og `WORKERS_SUBDOMAIN` (standard `marcus-ammitzboell`) overskriver standardværdierne i workflowet.

Deploy af én kunde manuelt: fanen *Actions → Deploy kunder → Run workflow* med kundens filnavn.
