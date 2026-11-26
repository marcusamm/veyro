# Veyro Mail på mailcow

Installér på VPS’en med en kørende mailcow 2026-11b, Docker Compose og Python 3. Kopiér mapperne `webmail/overlay` og `webmail/assets` med samme indbyrdes placering. Kør fra mappen over `webmail`.

```sh
sudo bash webmail/overlay/install.sh /opt/mailcow-dockerized
```

Installationen kopierer logo, font, licens og typografier til `data/web/veyro-mail/`. Den indsætter Veyro-afsnit i `data/web/css/build/0081-custom-mailcow.css` og `data/web/js/build/0081-veyro-mail-login.js`. Mailcow samler selv filerne til login-sidens CSS og JavaScript ved næste besøg. [Mailcows designvejledning](https://docs.mailcow.email/manual-guides/mailcow-UI/u_e-mailcow_ui-design/) · [Mailcows bundling i 2026-11b](https://github.com/mailcow/mailcow-dockerized/blob/2026-11b/data/web/inc/prerequisites.inc.php)

SOGo indlæser den registrerede `js/theme.js` fra `SOGoUIAdditionalJSFiles`. Installationen bevarer det eksisterende tema i `data/conf/sogo/custom-theme.js` og tilføjer et afgrænset afsnit, der henter `/veyro-mail/inbox.css` og `/veyro-mail/inbox.js` i SOGos brugerflade. Installationen opdaterer filen i SOGos delte webvolumen, som Nginx allerede bruger. Ved en senere start synkroniserer mailcow selv filerne fra værten. [Mailcow-monteringer](https://github.com/mailcow/mailcow-dockerized/blob/2026-11b/docker-compose.yml) · [SOGos indlæsning af ekstra scripts](https://github.com/Alinto/sogo/blob/SOGo-5.12.13/UI/Common/UIxPageFrame.m)

## Adgang og kontrol

På den offentlige vært `post.veyro.dk` skal GET og HEAD nå filerne `/veyro-mail/inbox.css`, `inbox.js`, `login.css`, `logo.svg`, `mark.svg`, `manrope.woff2` og `Manrope-OFL.txt` under samme præfiks. Bevar mailcows eksisterende adgang til `/cache/` og SOGos `WebServerResources/js/theme.js`. Lad browseren genvalidere sidstnævnte fil og brandingfilerne ved nye besøg.

Åbn brugerlogin i et privat vindue. Kontrollér indbakke og skrivning med en testpostkasse. Genindlæs en allerede åben fane efter opdatering. Ændres de lokale designfiler, køres samme kommando igen.

## Tilbageførsel

Ændrede eksisterende filer kopieres til den udskrevne mappe under `.veyro-mail-overlay/before-…` uden for webroden. For at fjerne designet kan Veyro-afsnittet mellem `/* BEGIN Veyro Mail overlay */` og `/* END Veyro Mail overlay */` fjernes fra de tre CSS/JS-filer. Bevar øvrige lokale ændringer. Genindlæs SOGos temafil med nedenstående kommando fra mailcow-mappen.

```sh
docker compose exec -T sogo-mailcow sh -ec 'src=/etc/sogo/custom-theme.js; dst=/sogo_web/WebServerResources/js/theme.js; cp "$src" "$dst.veyro-restore" && chmod 0644 "$dst.veyro-restore" && mv "$dst.veyro-restore" "$dst"'
```
