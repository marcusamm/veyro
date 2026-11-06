# Logistikværktøjer med Veyro-konto

Den selvstændige danske hjemmeside bruger `https://logistikværktøjer.dk/` som hovedadresse (DNS/URL-form: `https://xn--logistikvrktjer-5lb32a.dk`). `logistikvaerktojer.dk` og begge www-adresser sender videre med sti og forespørgselsparametre bevaret. Domænerne er custom domains på den eksisterende Worker `veyro`.

Gæster kan bruge alle beregnere direkte. Login, kontooprettelse, gemte beregninger og midlertidige login-kladder virker på samme domæne. Kun `/logistik/api/*`, `/logistik/login`, `/logistik/verify` og `/logistik/logout` sendes til det eksisterende kontosystem; administrative ruter og betalingsruter findes ikke på det nye domæne. Den oprindelige adresse `kunde.veyro.dk/logistik/` virker fortsat.

Begge indgange bruger samme Veyro-kunder, mailbekræftelse og database. Sessionscookies er fortsat bundet til hvert domæne, så en bruger kan skulle bekræfte login på det nye domæne, men skal ikke oprette en ny konto og ser de samme gemte beregninger. Login-mailens URL vælges ud fra den præcist godkendte host; kundeportalens globale `APP_URL` ændres ikke. Der oprettes ingen abonnementer eller Stripe-kunder ved gratis tilmelding.

Løsningen erstatter den tidligere indgang “Gratis værktøjer”. Kundepanelet har én indgang, “Logistikberegner”, til sin eksisterende editor. Salgshjemmesidens footer og `/tools`, `/en/tools`, `/sv/tools` peger på det nye hoveddomæne. Konti med tidligere gemte `tool_projects` får desuden linket “Tidligere gemte planer” til `/tools/legacy?lang=da`; deres data og direkte projektlinks bevares uden automatisk konvertering mellem forskellige beregningsmodeller.

Gæsteberegninger og CSV-import sker i browseren. Kontoens API kontaktes for loginstatus; beregningsinput sendes først ved et eksplicit Gem. En valgfri login-kladde opbevares i sessionStorage i den oprindelige fane, højst to timer, og slettes ved genoptagelse eller logout. Login-siden genkender også login, der bekræftes i en anden fane.

Migration `0016_logistics_calculations.sql` tilføjer en separat tabel. Alle operationer filtrerer på den verificerede konto. Der er versionskontrol ved ændringer og atomiske grænser på 50 aktive/200 samlede beregninger. En kopi af brugerens eksplicit indsendte input kan redde en versionskonflikt; kopiering fra listen kræver den viste version. Arkiv kan gendannes. Eksisterende `/tools`-data er uændrede.

Frontendens kildeprojekt er `logistikvaerktoejer`. Opdater ikke de genererede filer i `public/logistik` direkte. Eksportér fra kildeprojektet med:

```sh
node scripts/export-veyro.mjs /absolute/path/to/veyro-checkout
```

Eksporten kopierer frontendens beregningsmodeller og validering til backend og bygger to varianter: `public/logistik` med `/logistik` som basissti og `public/logistics-site` med roden som basissti. Begge aktiverer konto på samme origin via et eksplicit build-flag. De offentlige canonical- og sitemap-URL'er bruger hoveddomænet. Login, Mine beregninger samt saved/resume-visninger er noindex/no-store. `tests/logistics-input.test.mjs` kontrollerer modelidentitet mellem frontend og backend, og `tests/logistics.test.mjs` afprøver auth, ejerskab, CSRF, validering, konflikter, kvoter, arkiv og de offentlige filer med lokal D1 og mock-mail.

Udgiv via Deploy kundepanel, som tager et D1 Time Travel-bogmærke, kører migrationerne og publicerer Worker og assets. Ingen nye hemmeligheder eller eksterne services kræves. Den tidligere Sites-adresse viderestiller først efter verificeret udgivelse på kundedomænet. Excel-downloads bevares på den tidligere adresse.
