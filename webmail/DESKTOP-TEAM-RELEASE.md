# Veyro Mail — desktop og virksomhedsområde

Denne ændring udvider den eksisterende Veyro Mail. Desktopklienten bruger samme
Veyro-login og postkasse som browseren og kan derudover forbinde direkte til
andre udbyderes IMAP/SMTP-servere. Virksomhedschat og intranet kræver en aktiv
Veyro-konto; en ekstern mailkonto giver ikke adgang til en virksomheds data.

## Det kan prøves

- **Log ind med Google** opretter automatisk en lokal Veyro Mail-profil med den
  eksisterende Gmail-adresse og navnet fra Google. Ingen tekniske felter.
  Afbrudt login efterlader ingen tom profil; gentaget login genbruger kontoen.
- Separate Veyro- og eksterne mailkonti, kontoskift og fjernelse fra computeren.
  Andre udbydere har en enkel opsætning med særskilte avancerede indstillinger.
- Den eksisterende Veyro-webmail med mapper, søgning, organisering, links,
  original mailopsætning, vedhæftninger og den valgte loginperiode.
- Eksterne konti med TLS, mapper, søgning, læsning, svar/svar alle,
  videresendelse, To/Cc/Bcc, kladder, vedhæftninger, læst/ulæst,
  stjerner, arkivering og papirkurv. Se desktop-README for udbydernes loginvilkår.
- Virksomhedskanaler, direkte samtaler med en eller flere kollegaer,
  beskedsøgning, historik, ulæst-status og sporesikker sletning.
- Intranetopslag med fastgørelse, redigering med versionskontrol og
  tilknyttede dokumenter, et søgbart dokumentbibliotek samt kollegaoversigt.
- Adgang følger aktuelle, aktive Veyro-postkasser i samme domæne.
  Platformadministratorer får ingen særadgang til andres private samtaler.

Dette er en første testudgave. “Alle mailservices” betyder understøttelse på
tværs af udbydere med de protokoller og loginmetoder, de stiller til rådighed;
det er ikke et løfte om adgang til lukkede udbydere, alle virksomheds-politikker
eller alle funktioner fra samtlige konkurrerende mailprodukter. Kalender,
kontaktsynkronisering, tale/video og fuld offline-mailarkivering indgår ikke i
denne version. Ingen test har sendt rigtig mail eller beskeder til kollegaer.

Gmail er registreret som en Google Desktop-app i External/Testing. Kun navngivne
testbrugere kan forbinde, og Google kræver normalt nyt samtykke efter syv dage i
denne tilstand. Offentlig Google-verifikation er ikke gennemført. Outlook/Microsoft
er fortsat deaktiveret, indtil Veyro har en Microsoft-appregistrering. Se
`desktop/GOOGLE-RELEASE.md` og desktop-README for den konkrete udgivelsesstatus.

## Lokale installationsfiler

Fra `webmail/desktop`:

```sh
npm ci
npm test
npm run test:smoke
npm run build:mac
npm run build:win
npm run checksums
```

Byg på én platform ad gangen, hvis disken har begrænset plads. CI-workflowet
`.github/workflows/mail-desktop.yml` bygger på native Windows/macOS runners og
gemmer testinstallationsfiler som Actions-artifacts; det offentliggør dem ikke.
CI bruger den tomme OAuth-skabelon. De lokalt konfigurerede beta-installationsfiler
bygges med desktop-README'ens særskilte konfigurerede buildkommando; de faktiske
Google-registreringsværdier ligger i en ignoreret lokal fil og gemmes ikke i Git.
Filnavne i `webmail/desktop/dist`:

- `Veyro-Mail-0.1.0-beta.1-mac-arm64.dmg` (Apple Silicon)
- `Veyro-Mail-0.1.0-beta.1-mac-x64.dmg` (Intel)
- `Veyro-Mail-0.1.0-beta.1-win-x64.exe` (Windows 64-bit)
- `SHA256SUMS.txt`

macOS-bygningen bruger lokal ad hoc-signering, ikke et Apple Developer ID eller
notarisering. Windows-bygningen har ikke et udgivercertifikat. Før en almindelig
offentlig udgivelse skal Veyros udgiveridentitet, signering/notarisering og en
HTTPS-downloadplacering være på plads. Automatiske opdateringer er ikke aktiveret;
der hentes eller installeres ikke ukontrollerede opdateringer.

## Serverudrulning

1. Brug et testmiljø med to fiktive virksomheder og mindst tre aktive postkasser.
   Tag en privat backup af den eksisterende `organizer`-volume. Ingen migrering
   af postkasser, mail eller eksisterende loginoplysninger er nødvendig.
2. Byg backend fra denne revisions `webmail/backend` og opdatér både `api` og
   `org-broker`. `team.py` skal med i samme image som den opdaterede broker.
   Genstart begge tjenester; kontrollér healthchecks og eksisterende maillogin.
3. Udgiv `webmail/origin/mail-api.caddy` med det eksisterende
   `webmail/origin/publish.sh`. Scriptet validerer Caddy-konfigurationen og
   gendanner den gamle ved fejl. Kun dokumentupload får 7 MiB JSON-grænse;
   øvrige API-kald beholder 256 KiB.
4. Udgiv Worker og assets fra `webmail` efter backend. `/team#chat`,
   `/team#intranet`, `/team#files` og `/team#people` bruger de samme sikre
   browsercookies som mailen. Kontomenuen i webmailen linker til teamområdet.
5. Først derefter testes desktopappens Chat/Intranet-knapper mod miljøet.
   Installationsfiler alene installerer ikke serverfunktionerne.

Teamdatabasen oprettes automatisk ved første autoriserede kald:
`/var/lib/veyro-webmail/team/team.sqlite3` i den eksisterende private volume.
Der er ingen manuel SQL-migration for denne første, additive version.
Beskeder, opslag, dokumenter og revisionsspor ligger samlet i databasen.
Brug SQLite-backup eller stop tjenesten, når der tages filbackup.
Se [backend/TEAM.md](backend/TEAM.md) for schema, grænser og API.

Rollback: udgiv de tidligere Worker-assets, derefter de tidligere backendimages
og Caddy-konfiguration. Bevar den nye SQLite-fil; en rollback skal ikke slette
medarbejdernes indhold. Den gamle app ignorerer den nye database.

## Prøv med fiktive data

```sh
node webmail/preview.mjs
```

Åbn `http://127.0.0.1:58901/team`. Det er en lokal fixture, ikke en forbindelse
til Veyros rigtige postkasser. Fixture-data forsvinder ved genstart.

1. Send en besked, opret en kanal og åbn en direkte samtale under Kollegaer.
2. Upload en lille TXT/PDF under Dokumenter. Opret et opslag, tilknyt filen,
   fastgør opslaget og redigér det igen.
3. Brug to testkonti fra samme firma til at kontrollere fælles indhold. Brug en
   konto fra et andet domæne til at kontrollere, at historik og filer er adskilt.
4. Deaktivér en testkollega i den eksisterende mailadministration. Nye API-kald
   fra kontoen skal afvises; en anden kollega kan fortsat læse sin DM-historik.
5. Afbryd forbindelsen efter et beskedsend. Gentag samme afsendelse; den må
   optræde præcis én gang. Gentagne klik og tabte svar må ikke lave dubletter.
6. Åbn samme opslag i to browsere. Gem ændringen i den ene; den anden skal
   få en versionskonflikt, så den ikke overskriver kollegaens ændring.

## Kontroller

```sh
npx tsc -p webmail/tsconfig.json
npx vitest run --config webmail/vitest.config.mjs
python -m unittest discover -s webmail/backend -p 'test_*.py'
node --test webmail/context-menu.browser.mjs webmail/rich-layout.browser.mjs webmail/administration.browser.mjs webmail/mobile-login.browser.mjs webmail/team.browser.mjs
CADDY_BIN=/path/to/caddy python3 webmail/origin/test_body_limits.py
```

Backendtest bruger midlertidige databaser og fiktive broker-/loginoplysninger.
Browsertest omfatter Chromium og WebKit, desktop/mobil, scripts som tekst,
gentaget afsendelse efter tabt svar, historik under polling, opslag med filer,
dokumentupload og rydning af privat indhold ved sessionsudløb. Caddy-testen
kontrollerer faktiske HTTP-kald, også chunked payloads over grænsen.
De fem Caddy-tests køres på både produktionsversionen 2.6.2 og version 2.10.2.

Den lokale native Electron-smoketest verificerer blandt andet konto- og
cookieisolering, IPC-afsenderkontrol, blokering af uønsket navigation,
download-dialog og oprydning ved kontofjernelse. Rigtige udbyderkonti,
Windows-installation på en fysisk maskine og offentlig udgiver-signering
kræver separat slutkontrol; mockede protokoltests erstatter ikke disse.
CI har desuden installeret og startet Windows-EXE'en på en Windows-runner og
bygget samt kontrolleret ad hoc-signaturen på både Intel- og Apple Silicon-Mac.
