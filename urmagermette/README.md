# UrmagerMette – hjemmeside med tidsbestilling (uofficiel demo)

Hjemmeside til urmageren UrmagerMette, Holbækvej 54, 4200 Slagelse, med online tidsbestilling og et adgangsbeskyttet administrationspanel.

**Status: uofficiel demo.** Virksomheden er i nogle offentlige registre angivet som ophørt. Løsningen må ikke lanceres, sende e-mails til kunder eller erstatte urmagermette.dk, før ejeren har bekræftet, at virksomheden er aktiv, og har godkendt løsningen.

- Demo: https://urmagermette.veyro.dk (søgemaskiner bedes ikke indeksere den)
- Administration: https://urmagermette.veyro.dk/admin

## Hvad demoen kan

**Hjemmeside:** forside, ydelser, sådan foregår en reparation, om værkstedet, spørgsmål og svar, kontakt (klikbart telefonnummer og e-mail, kort fra Google Maps, der først indlæses efter klik, rutevejledning og kontaktformular), privatlivspolitik (udkast) og billedkilder. Fast "Bestil tid"-knap på mobil.

**Tidsbestilling (4 trin):** service → dato og tid (kun ledige tider, dansk tid med sommertid) → kundeoplysninger med valgfrit billede → oversigt og samtykke. Kunden får en kvittering med reference og et personligt link, hvor status kan følges, og tiden kan afbestilles. En ny bestilling er en *anmodning*, indtil værkstedet godkender den.

**Administration:** oversigt, kalender (dag/uge/måned), bookingliste med søgning, godkend/afvis, flyt, aflys, gennemført/udeblevet, interne noter, historik, kundens billede, ny aftale (fx telefonbestilling), beskeder fra kontaktformularen, åbningstider, ferie og lukkedage, blokerede tider, servicetyper med varighed og buffertid, bookingregler (interval, kapacitet, varsel, hvor langt frem), CSV-eksport, udbakke, sletning af en kundes oplysninger og skift af adgangskode. Fungerer på mobil.

## Teknik

- React 19, TypeScript, Tailwind CSS 4, Vite. De offentlige sider forudrenderes til statisk HTML (hurtigt og godt for SEO) og bliver interaktive i browseren.
- Cloudflare Worker (Hono) med én **Durable Object med SQLite** til alle data. Hver booking kontrolleres og gemmes i én transaktion, så dobbeltbooking er umulig – også hvis to kunder trykker samtidig.
- Projektets D1-kvote bruges ikke.

### Sikkerhed og GDPR

- Login med adgangskode (PBKDF2), sessionscookie (HttpOnly, Secure, SameSite=Strict), begrænsning af loginforsøg, CSRF-beskyttelse.
- Serverside-validering, honeypot-felt, tidskontrol og begrænsning pr. IP mod spam. Cloudflare Turnstile kan slås til med `TURNSTILE_SITE_KEY` og `TURNSTILE_SECRET`.
- Billeder gøres mindre i browseren (fjerner også GPS-data), filtypen kontrolleres på serveren (JPG/PNG/WebP, maks. 2 MB), og de kan kun ses af værkstedet.
- Samtykke ved bestilling, automatisk sletning efter en periode, som ejeren fastsætter, sletning af en enkelt kundes data og eksport. I demoen slettes oplysninger, som besøgende taster ind, efter 14 dage.
- Strenge sikkerhedsheaders (CSP m.m.), ingen sporings-cookies.

### Demotilstand (`DEMO_MODE = "1"`)

- Demobanner på alle sider, `noindex`, testdata markeret "Demo" (nulstilles under Indstillinger).
- **Der sendes ingen e-mails.** Mails, som systemet ville sende (kvittering, bekræftelse med dato, tid, adresse og afbestillingslink, afvisning, flytning, aflysning), gemmes i udbakken i admin med status "Ikke sendt (demo)".
- Åbningstider og priser er eksempler. Der står "Pris efter vurdering" overalt.

## Udvikling

```bash
cd urmagermette
npm install
npm run build        # bygger og forudrenderer til dist/
npx wrangler dev     # http://localhost:8787 (lokal database)
npm test             # tests af ledige tider, dansk tid og validering
npm run typecheck
BASE=http://127.0.0.1:8787 ADMIN_PASSWORD=... node scripts/screenshots.mjs   # browsertest og skærmbilleder
```

Lokalt oprettes administratoren ud fra `ADMIN_EMAIL` og `ADMIN_PASSWORD_HASH` i `wrangler.toml`. Lav en ny hash med:

```bash
node -e "const c=require('crypto'),pw=process.argv[1],s=c.randomBytes(16);console.log('pbkdf2\$100000\$'+s.toString('base64')+'\$'+c.pbkdf2Sync(pw,s,100000,32,'sha256').toString('base64'))" 'den-nye-adgangskode'
```

Hashen bruges kun, når der endnu ingen brugere er. Derefter skiftes adgangskoden i admin.

## Udrulning

Workflowet **UrmagerMette: deploy demo** bygger, tester og publicerer ved ændringer i `urmagermette/`. Data i Durable Object-lageret bevares ved nye udrulninger. Tilbagerulning af koden: `npx wrangler rollback` eller "Deployments" i Cloudflare.

## Før lancering (efter ejerens godkendelse)

1. Ejeren bekræfter, at virksomheden er aktiv, og godkender tekster, privatlivspolitik og FAQ.
2. Rigtige åbningstider (Indstillinger og `aabningstiderBekraeftet` i `src/shared/virksomhed.ts`), servicetyper, varigheder og opbevaringsperiode.
3. Billede af Mette og værkstedet (pladsen er klar på Om-siden) og gerne egne billeder af ure.
4. Domæne: flyt `urmagermette.dk` til Cloudflare, skift `routes` og `APP_URL` i `wrangler.toml` og `SITE_URL` i workflowet.
5. E-mail: Resend-konto med afsenderdomæne, `npx wrangler secret put RESEND_API_KEY`, sæt `EMAIL_FROM` og `NOTIFY_EMAIL`.
6. Spamkontrol: Turnstile-nøgler.
7. Sæt `DEMO_MODE = "0"`, byg med `VITE_DEMO=0`, nulstil data, og opret Mettes egen adgangskode.

## Billeder

Fotos er frit licenserede fra Wikimedia Commons (CC0, Public Domain, CC BY og CC BY-SA) og krediteres på `/billedkilder`. De forestiller ikke Mette eller hendes værksted. Skriptene i `scripts/hent-*.mjs` blev brugt til at finde og hente dem.
