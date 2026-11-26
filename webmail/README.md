# Veyro Mail

`mail.veyro.dk` er medarbejdernes indgang til webmail. Cloudflare Workeren viser Veyros danske startside og formidler SOGo-sessionen over HTTPS. Mailcow på Linux håndterer postkasser, mapper, søgning og afsendelse. Workeren har ingen database. Den særskilte workflow `Udgiv Veyro Mail` deployer kun denne Worker.

## Tilslut den første mailserver

1. Klargør mailcow på en understøttet Linux-vært med `MAILCOW_HOSTNAME=post.veyro.dk`. Brug en DNS only-post til mailserverens IP. Tjek SMTP-port 25 og få VPS-udbyderen til at sætte PTR. [Mailcows krav til systemet](https://docs.mailcow.email/getstarted/prerequisite-system/) · [DNS](https://docs.mailcow.email/getstarted/prerequisite-dns/)
2. Konfigurér et gyldigt TLS-certifikat for origin og `ADDITIONAL_SERVER_NAMES=mail.veyro.dk` i mailcow. Fra Workeren skal en HTTPS-forespørgsel til `post.veyro.dk` med den offentlige webmails værtsnavn give SOGos login og ressourcer. Kontrollér, at links og omdirigeringer bruger `mail.veyro.dk`. [Mailcows reverse proxy](https://docs.mailcow.email/post_installation/reverse-proxy/r_p/)
3. Beskyt mailcow-administrationen, opret domænet `veyro.dk` og de separate postkasser `marcus@veyro.dk` og `efe@veyro.dk`. Udlever hver brugers adgang separat. Prøv login og udlogning i SOGo, mapper og intern levering mellem de to postkasser.
4. Sæt `WEBMAIL_ENABLED = "1"` i `webmail/wrangler.toml`, udgiv, og gentag kontrollen fra `https://mail.veyro.dk/`. Indtil aktivering viser startsiden indbakkens layout med lokal eksempelpost.

## Flyt indgående post

MX gælder hele `@veyro.dk`. Inden et særskilt, aftalt skift skal alle eksisterende postkasser, grupper og aliaser være kortlagt. Kopiér eksisterende mail, test backup og gendannelse og kontrollér ekstern levering samt SPF, DKIM og DMARC. Bevar DNS-posterne til Resend, som bruges til Veyros login-, booking- og fakturamails. Deploy af webinterfacet ændrer ingen MX-poster.
