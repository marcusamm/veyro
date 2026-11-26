# Veyro Mail

På `mail.veyro.dk` udgiver Cloudflare Veyros brugerflade og formidler kald til postkassen. Browseren indlæser HTML, CSS og JavaScript fra samme domæne. Mailcow på VPS’en opbevarer mailen og håndterer IMAP og SMTP.

## Udgiv webmailen

1. Installér filerne fra `backend/` i den administratorbeskyttede mappe `/etc/veyro-webmail-api` på mailserveren. Kør `sh stage.sh` dér. API'et lytter på `127.0.0.1:18082`.
2. Forbind API'et med Cloudflare Workerens hemmelighed `VEYRO_MAIL_ORIGIN_TOKEN`. GitHub-opgaven *Klargør forbindelsen til webmailens API* opretter Workerens nøgle ved første kørsel. Jobbet forsegler en kopi med VPS’ens offentlige RSA-nøgle. På gæsten dekrypteres kopien til filen `secrets/origin-token` med rettigheder `0440` og ejer `root:65532`. Opbevar den private RSA-nøgle i serverens beskyttede backup.
3. Kør `sh origin/publish.sh` på gæsten. Caddy sender `/webmail-api/api/` på `post.veyro.dk` til den lokale API. API'et kontrollerer Workerens nøgle og brugerens session.
4. GitHub-opgaven *Udgiv Veyro Mail* tester og udgiver Worker og aktiver. `WEBMAIL_ENABLED` styrer vedligeholdelsessiden. Prøv login, åbn en mail, og send en besked til samme testpostkasse. Kontrollér også Sendt og udlogning.

Kunder og medarbejdere bruger login til deres egen aktive Veyro Mail-postkasse. Browserens sessionscookie er markeret HttpOnly og Secure. Ændringer kræver den korrekte oprindelse og et CSRF-token efter login. Eksterne billeder og scripts i modtagne mails indlæses ikke. Hentede vedhæftninger leveres som downloads.

For at skifte adgangskode skal medarbejderen vælge sin mailadresse øverst til højre og derefter **Skift adgangskode**. Mailcow kontrollerer den nuværende kode og kravene til den nye. Når skiftet er gennemført, skal medarbejderen logge ind igen på alle enheder i Veyros webmail.

Under **Gendannelsesmail** i samme menu kan medarbejderen tilknytte en ekstern adresse. Indtast postkassens nuværende adgangskode og bekræft koden fra den eksterne indbakke. Brug en adresse, som du også kan åbne, hvis du mister adgangen til din Veyro-postkasse.

Vælg **Glemt adgangskode?** på loginsiden, og indtast din Veyro-mailadresse. Mailcow sender et tidsbegrænset nulstillingslink til den tilknyttede gendannelsesmail. Følg linket til `post.veyro.dk`, vælg en ny adgangskode, og log ind på `mail.veyro.dk`. Hvis du er låst ude uden adgang til en tilknyttet gendannelsesmail, skal Veyros mailadministrator hjælpe dig.

## Maillevering

MX gælder hele `@veyro.dk`. Før et aftalt skift skal virksomhedens postkasser, grupper og aliaser være klar til at modtage mail. Webmailen kan læse mail, der allerede ligger i Mailcow, og levere interne beskeder mellem postkasserne.

## Administration af virksomheder

Log ind på `mail.veyro.dk` som `marcus@veyro.dk` med postkassens egen adgangskode. Åbn kontomenuen og vælg **Mailadministration**. Hver organisation har ét maildomæne. Vælg virksomheden for at se og filtrere dens aktive og inaktive postkasser. Når du opretter eller ændrer en postkasse, godkender du handlingen med din egen adgangskode. Deaktivering bevarer beskederne, så postkassen senere kan aktiveres igen.

1. Vælg **Tilføj organisation**, og indtast virksomhedens navn og eget maildomæne.
2. Bed kunden tilføje den viste TXT-post hos sin DNS-udbyder. Vælg **Kontrollér DNS** i panelet, når posten er publiceret.
3. Opret kundens postkasser. Under **DNS til maillevering** kan du hente domænets MX-post og offentlige DKIM-nøgle. Planlæg skift af MX med kunden, og afstem SPF og DMARC med de tjenester, kunden bruger til at sende mail.
