# Excel-reference til transportberegnerne

Modtaget 6. november 2026: `Skabeloner_til_distributionseksamen (1).xlsx`.
Originalen bevares uændret i `docs/references/distributionseksamen.xlsx`. Filens SHA-256,
kildeinput, formler og gemte kontrolresultater findes i
`tests/fixtures/distribution-reference.json`. Originalen bruges som reference og
bliver ikke automatisk lagt ud som en ny beregnerside.

De nedenstående `src/`- og `scripts/`-stier henviser til frontendkildeprojektet
`logistikvaerktoejer`. Workerens publicerede kopier ligger i `public/logistik/`;
backendkontrollen ligger i `tests/transport-reference.test.mjs`.

## Integration

De fem eksisterende transportmodeller følger allerede den rettede references
beregningsregler. Deres formler, kontosystem og gemte beregninger er uændrede.
`src/transport-reference.mjs` indeholder de afstemte eksempler, som den eksisterende
knap **Prøv et eksempel** nu indlæser. De fem Excel-downloads starter med de samme
input og har fortsat redigerbare formler. Nye browserberegninger og Nulstil starter
uden priser og gebyrer som hidtil. Referencefilens gebyrer bliver ikke aktiveret.

| Beregner | Kilde | Resultat uden tilvalgte gebyrer |
| --- | --- | --- |
| Ladmeter | Ladmeter!D3:D8 | 2,5 ladmeter |
| Luftfragt | Lufttransport!B2:B12, D3:E12, C17:C23 | 108,8541667 kg fragtvægt, 22 DKK/kg, 2.394,79 kr. |
| Palletransport | Paller!B4:B11, C15:F28 | 7.600 / 8.200 / 6.556 / 5.587,50 kr.; D billigst inden for fristen |
| Containertransport | Container!B4:B9, C14:D29 | 32.106,03 / 29.701,33 kr. inkl. kapital |
| Biltransport | Bil!B5:B12, B18:B29, C34:C41 | 2.147.209 kr./år; 38,68 kr./km; 1.353,85 kr./time |

Paller bruger de oprindelige eksempeldatoer 13.–16. oktober 2026. En kalenderdag
er 24 timer i samme lokale tidszone. Containerarkets rente på 0,12 er overført
som **12 procent**, ikke 0,12 procent. Beløb afrundes til øre efter de eksisterende
regler; referencens uafrundede kontrolværdier sammenlignes efter samme afrunding.

Bilarkets 12 måneders timer summeres til 1.586 og ganges med 35 km/time, som giver
55.510 km/år. De 330.000 kr. inkluderer løn og sociale omkostninger. De 2.000 kr.
pr. måned inkluderer forsikring og afgifter. Beløbene medtages én gang; de ekstra
sociale omkostninger og afgifter er derfor nul. Det fremgår i både browseren og
Excel-downloaden. B13:B14 har ingen defineret rolle og medtages ikke.

Den tomme Søfragt-fane giver ingen ny side. Originalens forklaringsceller
Bil!D5:D15 har gamle delte formelreferencer med gemt forklaringstekst; disse
referencer kopieres ikke ind i beregningsmodellerne. Originalen ændres ikke.

## Kontrol

- `tests/transport-reference.test.mjs`: afstemning mod kildeceller, forventede
  resultater, datoer, enheder, valutakurser, rente, samlede biludgifter og
  normalisering til kontolagring.
- Samme test anvender alle fem input i de egentlige Excel-formler via
  `createTransportWorkbook().apply()` og sammenligner med browsermodellerne.
- `tests/transport-ui.test.mjs`: eksempelknap, ændring af input, genberegning,
  kildenoter, nulstilling og uændrede originaleksempler.
- Eksporten genberegner, kontrollerer formelfejl, renderer og genindlæser filerne.
  Der er ikke foretaget kontrol i den åbne Microsoft Excel-app.

Kør `npm test`. Excel-modellernes tests kræver det separate artifact-runtime via
`scripts/node_modules`; det er ikke en afhængighed på hjemmesiden. Byg downloads
med `node scripts/build-transport-workbooks.mjs`, og eksportér frontend til
Veyro med `node scripts/export-veyro.mjs /absolute/path/to/veyro-checkout`.
