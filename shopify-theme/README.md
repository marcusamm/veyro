# Veyro – Shopify-tema (veyro.dk)

Temaet til salgshjemmesiden veyro.dk. Mappen `theme/` er en kopi af temaet i butikken og er kilden til ændringer, så de kan gennemgås og rulles tilbage.

## Udgivelse

Ændringer lægges i en **ikke-udgivet kopi** af det aktive tema i Shopify (Online butik › Temaer) og udgives derfra med *Udgiv*. Det tidligere tema bliver liggende i biblioteket, så man kan rulle tilbage ved at udgive det igen.

## Kontrol før udgivelse (`qa/`)

```sh
cd shopify-theme/qa
npm i liquidjs @shopify/theme-check-node playwright@1
node tc.mjs "$(pwd)/../theme"            # Shopify Theme Check, skal give 0
node render.mjs ../theme out             # gengiver siderne lokalt med liquidjs
node serve.mjs out 8811 &                # lokal server
node audit.mjs http://localhost:8811 shots   # døde links, ankre, vandret scroll, pladsholdere, konsolfejl + skærmbilleder
```

Den lokale gengivelse efterligner Shopify, men er ikke Shopify. Menuerne i `qa/menus.json` skal svare til butikkens menuer.
