# Logistikværktøjer med Veyro-konto

Den selvstændige danske frontend findes under `/logistik/` på samme host som kundepanelet. Den bruger de eksisterende Veyro-kunder, mailbekræftelse og sessionscookies. Der oprettes ingen abonnementer eller Stripe-kunder ved gratis tilmelding.

Løsningen erstatter den tidligere indgang “Gratis værktøjer”. Kundepanelet har én indgang, “Logistikberegner”, og hjemmesidens footer linker samme sted. `/tools` (og `/en/tools`, `/sv/tools` på salgshjemmesiden) viderestiller til `/logistik/`. Konti med tidligere gemte `tool_projects` får desuden linket “Tidligere gemte planer” til `/tools/legacy?lang=da`; deres data og direkte projektlinks bevares uden automatisk konvertering mellem forskellige beregningsmodeller.

Gæsteberegninger og CSV-import sker i browseren. Kontoens API kontaktes for loginstatus; beregningsinput sendes først ved et eksplicit Gem. En valgfri login-kladde opbevares i sessionStorage i den oprindelige fane, højst to timer, og slettes ved genoptagelse eller logout. Login-siden genkender også login, der bekræftes i en anden fane.

Migration `0016_logistics_calculations.sql` tilføjer en separat tabel. Alle operationer filtrerer på den verificerede konto. Der er versionskontrol ved ændringer og atomiske grænser på 50 aktive/200 samlede beregninger. En kopi af brugerens eksplicit indsendte input kan redde en versionskonflikt; kopiering fra listen kræver den viste version. Arkiv kan gendannes. Eksisterende `/tools`-data er uændrede.

Frontendens kildeprojekt er `logistikvaerktoejer`. Opdater ikke de genererede filer i `public/logistik` direkte. Eksportér fra kildeprojektet med:

```sh
node scripts/export-veyro.mjs /absolute/path/to/veyro-checkout
```

Eksporten kopierer frontendens beregningsmodeller og validering til backend og bygger den offentlige frontend med `/logistik` som basissti. `tests/logistics-input.test.mjs` kontrollerer modelidentitet mellem frontend og backend, og `tests/logistics.test.mjs` afprøver auth, ejerskab, CSRF, validering, konflikter, kvoter, arkiv og de offentlige filer med lokal D1 og mock-mail.

Udgiv via Deploy kundepanel, som tager et D1 Time Travel-bogmærke, kører migrationerne og publicerer Worker og assets. Ingen nye hemmeligheder eller eksterne services kræves. Den tidligere Sites-adresse viderestiller først efter verificeret udgivelse på kundedomænet. Excel-downloads bevares på den tidligere adresse.
