# Veyro Tools

Gratis beregningsværktøjer til logistik og indkøb. Brugeren opretter eller åbner en Veyro-konto med et engangslink på e-mail og gemmer sine egne planer online. Der kræves ikke abonnement eller betalingskort.

## Adresser og sprog

- Løsningen er erstattet af [Logistikberegner](https://kunde.veyro.dk/logistik/). `/tools` på kontodomænet og `/tools`, `/en/tools`, `/sv/tools` på salgshjemmesiden viderestiller dertil.
- `https://kunde.veyro.dk/tools/legacy?lang=da|en|sv` bevarer adgangen til tidligere planer. Kun konti med gamle planer ser linket “Tidligere gemte planer” i kundepanelet.
- `/tools/projects/:id?lang=…` åbner én privat plan. Sprogskift ændrer teksterne, ikke de gemte tal.

Arbejdsrummet bruger `APP_URL` som kontoens adresse og til links i login-mails. I produktion er værdien `https://kunde.veyro.dk`. Login-cookien er bundet til det enkelte domæne; salgssiden sender derfor brugeren til kontodomænet. Uden et udtrykkeligt `lang` vælges dansk for Danmark, svensk for Sverige og ellers engelsk ud fra Cloudflares landekode.

## Skabeloner

| Skabelon | Beregning og afgrænsning |
| --- | --- |
| Lager og genbestilling (`stock`) | Disponibelt lager er fysisk lager minus reservationer. Lagerpositionen inkluderer bestilte varer. Genbestillingspunktet er dagligt forbrug × leveringstid + sikkerhedslager. Sikkerhedslageret tælles én gang. Bestillingsforslaget fylder op til mållageret i hele pakker. En særskilt advarsel sammenligner fysisk lager med sikkerhedslageret. |
| Leverandørsammenligning (`suppliers`) | Sammenligner samme vare og grundenhed hos flere leverandører. Ordreantal dækker behov og minimumsordre, rundet op til hele pakker. Rabat, fragt og øvrige omkostninger indgår i den samlede leverede pris. Rangeringen bruger totalprisen, ikke kun stykprisen. |
| Økonomisk ordrestørrelse (`eoq`) | EOQ beregnes ud fra årligt forbrug, omkostning pr. ordre og årlig lageromkostning pr. enhed. Forslaget rundes op til hele pakker; bestillings- og lageromkostninger beregnes derefter med dette antal. Manglende positiv lageromkostning giver ikke et falsk nulresultat. Modellen forudsætter stabilt forbrug og stabile omkostninger. |
| Indkøbsbudget (`budget`) | Summerer antal × stykpris efter rabat samt fragt og sammenholder totalen med budgettet. Indtastet fragt tælles én gang pr. linje, også ved antal nul. Delbeløb afrundes til valutaens to decimaler. |

Nye planer indeholder tydeligt mærkede eksempeltal. Brugeren skal erstatte dem med egne oplysninger. Alle beløb i en plan anvender én valgt valuta: DKK, EUR eller SEK, ekskl. moms. Valutaskift ændrer kun betegnelsen; der foretages ingen automatisk valutaomregning. Pakningsstørrelse angives i grundenheder. For lagerplanlægning skal dagligt forbrug og leveringstid bruge samme daggrundlag, og bestilte varer skal forventes brugbare inden for den angivne leveringstid.

Beregningsplanerne ændrer **ikke** faktisk lager, reservationer, ordrer, betalinger, fakturaer eller abonnementer. De opretter heller ikke kundeemner eller markedsføringstilmeldinger.

## Konto og gemte planer

`/tools/sign-in` sender et login-link. `/tools/verify` viser først en bekræftelsesknap, så mail-scannere ikke forbruger linket. Bekræftelse med POST bruger linket én gang og opretter først derefter en eventuel ny kundekonto. Linket gælder i 15 minutter. Eksisterende kunders profil og abonnementer bevares. Manglende eller fejlet mailafsendelse vises som en fejl, ikke som en sendt mail.

Planer gemmes i `tool_projects` med `customer_id`. Alle læsninger og ændringer afgrænses til den indloggede ejer. Kendskab til et plan-id giver ikke adgang. Der er ingen offentlig deling eller særlige administratorrettigheder til andres planer i dette værktøj.

Brugeren kan oprette, gemme, kopiere, arkivere og gendanne planer. Arkivering er ikke sletning. Der kan højst være 50 aktive planer og 200 gemte planer inklusive arkivet, med op til 50 rækker pr. plan. Datafeltet må højst fylde 50.000 byte. Kvoter kontrolleres i databaseændringen, så samtidige forespørgsler ikke omgår dem.

Gemning bruger et versionsnummer. En ældre fane kan ikke overskrive en nyere version; konflikten vises, og de indsendte ændringer bevares i formularen. Beregningsforhåndsvisning via `/tools/preview` gemmer ikke planen. Numeriske input valideres på serveren, og brugertekst afvikles aldrig som formler eller kode. POST-handlinger bruger eksisterende CSRF- og sessionsbeskyttelse. Login, ændringer og forhåndsvisning har særskilte hastighedsgrænser. Private sider sendes med `no-store` og `noindex`.

## Drift og udrulning

1. Kontrollér `APP_URL` og den eksisterende Resend-konfiguration (`RESEND_API_KEY`, `EMAIL_FROM`). Produktion må ikke bruge `DEV_MODE=1`. Den lokale testfunktion kan vise et login-link uden mailafsendelse, men kun i udvikling.
2. Kør migrationen `migrations/0015_free_tools.sql` på den relevante D1-database **før den nye kode tages i brug**. Den tilføjer `tool_projects` og et ejerindeks. Preview og produktion har hver sin database.
3. Brug det eksisterende GitHub Actions-workflow **Deploy kundepanel** (`.github/workflows/deploy-kundepanel.yml`). Det udskriver et D1 Time Travel-bogmærke, anvender manglende migrationer og udruller derefter Workeren. Automatiske Workers Builds alene installerer ikke den nye migration.
4. Kontrollér offentlige links og et testforløb: login → opret plan → ændr tal → gem → genåbn → kopiér → arkivér → gendan. Brug særskilte testkonti, og kontrollér at den anden konto ikke kan åbne planen.

Implementeringen ligger i `src/routes/tools.ts`, `src/lib/tools-store.ts` og `src/lib/planning.ts`. Visning, browseradfærd og sprog ligger i `src/views/tools.ts`, `tools-assets.ts` og `tools-copy.ts`.

Relevante automatiske tests:

```sh
npx vitest run tests/planning.test.mjs tests/tools.test.mjs
npm run typecheck
npm run build:site -- --check
```

Beregningsprøverne dækker blandt andet sikkerhedslager én gang, reservationer, indgående varer, pakningsafrunding, minimumsordrer, rabatter, nulværdier og budgetafstemning. Kontoprøverne dækker e-mailbekræftelse, sprog, gemning, versionskonflikter, kontoadskillelse, CSRF, kvoter og at gratis værktøjer ikke opretter betalinger eller abonnementer.
