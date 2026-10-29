# Veyros egen OCR på Cloudflare

CPU-baseret PaddleOCR i en privat Cloudflare Container. Hjemmesiden og kundeportalerne bliver på deres eksisterende Workers/D1. Der kaldes ingen ekstern OCR-API.

## Adgang og drift

- Worker `veyro-receipt-ocr` har ingen offentlig adresse, preview-adresse eller routes. Kun en eksplicit `RECEIPT_OCR`-servicebinding giver adgang.
- Kontoen kræver `durable_object`-planlægning. En fast Durable Object-identitet starter én `standard-2`-container (1 vCPU / 6 GiB) ad gangen, med internetadgang deaktiveret og dvale efter to minutters inaktivitet. Identiteten kan ikke vælges fra en upload.
- Den styrende Durable Object og dens tæller placeres i EU. Cloudflare understøtter på denne kontotype ikke en placeringsbegrænsning for selve containerens beregning. EU-placering af OCR kan derfor **ikke garanteres**. Den første aktivering er kun i demoen med TESTDATA; regionalt krav skal afklares før behandling af rigtige kundebilag.
- En vedvarende tæller tillader indledningsvis højst **30 forsøg pr. UTC-dag på tværs af kunder**. Fejlede afkodninger tæller også. Grænsen er ikke et løfte om en bestemt kronepris; Workers Paid og containerforbrug afregnes efter Cloudflares vilkår.
- Ingen originalsider eller OCR-resultater gemmes i OCR-workerens Durable Object. Originaler og kontrollerede oplysninger forbliver i den enkelte kundes eksisterende database. HTTP-adgangslogning er deaktiveret. Containerens barnproces bruger filens bytes i hukommelsen.
- Modeller og afhængigheder bygges ind i image; modelarkiver kontrolleres med SHA-256. Der downloades ingen modeller ved aflæsning. Image kører som bruger10001.

## Kontrakt og grænser

`POST https://receipt-ocr.internal/v1/extract` via servicebinding, originalens bytes som body og kontrolleret `Content-Type`. PDF, JPG, PNG og HEIC; højst15MiB/10sider. Resultat:

```json
{"pages":["Vare  Antal  Enhed  Pris  Beløb\nTESTDATA skrue  2  pk.  125,00  250,00"],"provider":"Veyro PaddleOCR"}
```

Koordinater bruges til at genskabe læserækkefølge og kolonner; der opfindes ingen manglende tal. Højst100.000 teksttegn/500KB JSON. Barnprocessen stoppes efter75sekunder; gatewayen har110sekunders totalgrænse, inklusive start og hele svarbody. Fejl giver manuel kontrol. En sundhedsforespørgsel på gatewayen vækker ikke en container og dokumenterer derfor ikke i sig selv, at inferens virker.

Kundeappens baggrundskø gemmer kun bilagshenvisning og kontrolmetadata i kundens egen D1. Brugeren kan fortsætte efter upload. OCR ændrer ikke lager eller omkostninger; alle forslag skal godkendes mod originalen. Bilagsændringer eller bogføring under en igangværende aflæsning må ikke overskrives af et sent OCR-svar.

## Test og deploy

Fra denne mappe: `npm ci`, `npm run typecheck`, `npm test`.

Fra `engine/`: `python -m unittest discover -s tests` i et isoleret Python3.12-miljø med `requirements.lock`. `python smoke.py` bruger faktiske modelvægte på tydeligt fiktive TESTDATA. Det er en regressionstest, ikke en måling af nøjagtighed på virkelige bilag.

Workflow `.github/workflows/deploy-ocr.yml` bygger Docker-image, kører ægte HTTP-inferens med `--network none`, CPU/hukommelsesgrænser og skrivebeskyttet filesystem. Kun et bestået main-build deployer den private service med repositoryets eksisterende Cloudflare-credentials. Den lokale maskine behøver dermed ikke Docker eller nye API-nøgler.

Efter vellykket deploy vælges tjenesten for en kunde ved at sætte `systemer.lagerstyring.ocr_service` til `veyro-receipt-ocr` i kundens JSON. Deployer-scriptet tilføjer både servicebinding og kundens private OCR-kø. Start i demoen og verificér et faktisk upload → kø → OCR → manuel kontrol-forløb før aktivering for en rigtig kunde.

Brug repræsentative danske fotos til efterfølgende kvalitetskontrol, især foldede bonner, rabatter, moms, pakninger og enheder. Originalen har altid forrang.

## Kilder

- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) – open source, Apache2.0. Se også modelmanifest og afhængigheders egne licenser.
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
- [EU-placering](https://developers.cloudflare.com/containers/concepts/placement/)
- [Containerpriser](https://developers.cloudflare.com/containers/platform/pricing/)
