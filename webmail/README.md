# Veyro Mail

På `mail.veyro.dk` udgiver Cloudflare Veyros brugerflade og formidler kald til postkassen. Browseren indlæser HTML, CSS og JavaScript fra samme domæne. Mailcow på VPS’en opbevarer mailen og håndterer IMAP og SMTP.

## Udgiv webmailen

1. Installér filerne fra `backend/` i den administratorbeskyttede mappe `/etc/veyro-webmail-api` på mailserveren. Kør `sh stage.sh` dér. API'et lytter på `127.0.0.1:18082`.
2. Forbind API'et med Cloudflare Workerens hemmelighed `VEYRO_MAIL_ORIGIN_TOKEN`. GitHub-opgaven *Klargør forbindelsen til webmailens API* opretter Workerens nøgle ved første kørsel. Jobbet forsegler en kopi med VPS’ens offentlige RSA-nøgle. På gæsten dekrypteres kopien til filen `secrets/origin-token` med rettigheder `0440` og ejer `root:65532`. Opbevar den private RSA-nøgle i serverens beskyttede backup.
3. Kør `sh origin/publish.sh` på gæsten. Caddy sender `/webmail-api/api/` på `post.veyro.dk` til den lokale API. API'et kontrollerer Workerens nøgle og brugerens session.
4. GitHub-opgaven *Udgiv Veyro Mail* tester og udgiver Worker og aktiver. `WEBMAIL_ENABLED` styrer vedligeholdelsessiden. Prøv login, åbn en mail, og send en besked til samme testpostkasse. Kontrollér også Sendt og udlogning.

Medarbejdere bruger deres egen postkasseadgang. Browserens sessionscookie er markeret HttpOnly og Secure. Ændringer kræver den korrekte oprindelse og et CSRF-token efter login. Eksterne billeder og scripts i modtagne mails indlæses ikke. Hentede vedhæftninger leveres som downloads.

## Maillevering

MX gælder hele `@veyro.dk`. Før et aftalt skift skal virksomhedens postkasser, grupper og aliaser være klar til at modtage mail. Webmailen kan læse mail, der allerede ligger i Mailcow, og levere interne beskeder mellem postkasserne.
