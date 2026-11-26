# Veyro Mail

`mail.veyro.dk` er medarbejdernes indgang til webmail. Når tjenesten er aktiv, sender den browseren direkte til `https://post.veyro.dk/`, hvor mailcow håndterer brugerlogin, totrinsgodkendelse og udlogning. Med direkte viderestilling til SOGo åbner en medarbejder med en aktiv mailcow-session sin indbakke med det samme. Workflowet `Udgiv Veyro Mail` udgiver indgangen og forhåndsvisningen på Cloudflare.

## Tilslut den første mailserver

1. Klargør mailcow på en understøttet Linux-vært med `MAILCOW_HOSTNAME=post.veyro.dk`. Brug en DNS only-post til mailserverens IP. Tjek SMTP-port 25 og få VPS-udbyderen til at sætte PTR. [Mailcows krav til systemet](https://docs.mailcow.email/getstarted/prerequisite-system/) · [DNS](https://docs.mailcow.email/getstarted/prerequisite-dns/)
2. Kontrollér fra en ekstern browser, at `https://post.veyro.dk/` har et gyldigt TLS-certifikat og viser mailcows brugerlogin. Mailcow 2026-11b anvender sin egen session til at åbne SOGo. [Brugerlogin i 2026-11b](https://github.com/mailcow/mailcow-dockerized/blob/2026-11b/data/web/index.php#L9-L18)
3. Beskyt mailcow-administrationen, opret domænet `veyro.dk` og de separate postkasser `marcus@veyro.dk` og `efe@veyro.dk`. Aktivér **Direct forwarding to SOGo** på begge postkasser. Udlever hver brugers adgang separat. Kontrollér login, eventuel totrinsgodkendelse, indbakke, intern levering og udlogning på `post.veyro.dk`.
4. Sæt `WEBMAIL_ENABLED = "1"` i `webmail/wrangler.toml`, udgiv, og gentag kontrollen fra `https://mail.veyro.dk/`. Indtil aktivering viser startsiden indbakkens layout med lokal eksempelpost.

## Flyt indgående post

MX gælder hele `@veyro.dk`. Inden et særskilt, aftalt skift skal alle eksisterende postkasser, grupper og aliaser være kortlagt. Kopiér eksisterende mail, test backup og gendannelse og kontrollér ekstern levering samt SPF, DKIM og DMARC. Bevar DNS-posterne til Resend, som bruges til Veyros login-, booking- og fakturamails. Deploy af webinterfacet ændrer ingen MX-poster.
